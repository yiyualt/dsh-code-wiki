import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { readConfiguredModel } from './src/configured-model.js'
import { exploreArchitecture } from './src/architecture.js'
import { collectGithubSource, openGithubRepository } from './src/github-source.js'
import { generateWiki, modelError, renderSourceWiki } from './src/generate-wiki.js'
import { collectLocalSource, openLocalRepository } from './src/local-source.js'
import { createWikiStorage } from './src/wiki-storage.js'
import { registerVideoApi } from './src/video-api.js'

export const name = 'dsh-code-wiki'
export const inject = ['connection', 'agents', 'llm', 'agentDefaultModel', 'profileContext']

const generateRoute = '/api/dsh-code-wiki/generate'
const generationRoute = '/api/dsh-code-wiki/generation'
const sourceRoute = '/api/dsh-code-wiki/source'
const documentsRoute = '/api/dsh-code-wiki/documents'
const deleteDocumentRoute = '/api/dsh-code-wiki/documents/delete'
const sourceErrors = new Map([
  ['invalid-repository-url', 400],
  ['repository-unavailable', 404],
  ['github-rate-limited', 429],
  ['github-request-failed', 502],
  ['repository-no-evidence', 422],
  ['invalid-local-path', 400],
  ['local-repository-unavailable', 404],
  ['local-read-failed', 422],
])

function plainText(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

async function localSourceResponse(request, storage) {
  const query = new URL(request.url).searchParams
  const [file, start, end] = ['file', 'start', 'end'].map(name => Number(query.get(name)))
  const missing = '找不到这条源码引用。'
  if (![file, start, end].every(Number.isInteger) || file < 1 || start < 1 || end < start || end - start > 24) {
    return plainText(missing, 404)
  }
  try {
    const document = await storage.get(query.get('key'))
    const evidence = document?.files?.[file - 1]
    const lines = evidence?.text.replace(/\r?\n$/, '').split('\n')
    const first = evidence?.startLine ?? 1
    if (!lines || start < first || end >= first + lines.length) return plainText(missing, 404)
    const excerpt = lines.slice(start - first, end - first + 1).map((line, i) => `${start + i} | ${line}`).join('\n')
    return plainText(`${evidence.path}\nCommit ${document.commit}\n\n${excerpt}\n`)
  } catch {
    return plainText('无法读取本地源码引用。', 500)
  }
}

function modelNote(error) {
  if (error.code === 'model-output-invalid') return '模型未返回有效引用，以下为源码摘录。'
  if (error.providerCode === 'MODEL_CONFIG') return '无法读取本地模型配置，以下为源码摘录。'
  const details = [error.providerCode, error.providerStatus && `HTTP ${error.providerStatus}`].filter(Boolean)
  const suffix = details.length ? `（${details.join(' · ')}）` : ''
  return `模型调用失败${suffix}，以下为源码摘录。`
}

async function selectModel(ctx, configFile, signal) {
  if (configFile === undefined) return { llm: ctx.llm, selection: ctx.agentDefaultModel.currentSelection() }
  try {
    const llm = await readConfiguredModel(configFile, signal)
    return { llm, selection: { model: llm.model } }
  } catch (error) {
    throw modelError(error)
  }
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } })
}

function withoutEvidence({ files, ...document }) {
  return document
}

async function documentsResponse(request, storage) {
  const id = new URL(request.url).searchParams.get('id')
  try {
    if (id === null) return json({ documents: await storage.list() })
    const document = await storage.get(id)
    return document ? json(withoutEvidence(document)) : json({ error: '找不到这篇文档。' }, 404)
  } catch {
    return json({ error: '无法读取已保存的文档。请重试。' }, 500)
  }
}

export function apply(ctx, config) {
  const lifetime = new AbortController()
  const storage = createWikiStorage(join(ctx.profileContext.dir, 'dsh-code-wiki', 'documents'))
  const videos = registerVideoApi(ctx, config, storage, selectModel, lifetime)
  const jobs = new Map()
  let active

  function progress(job) {
    if (!job) return null
    const { startedAt, finishedAt, ...status } = job
    return { ...status, elapsedMs: Math.max(0, (finishedAt ?? Date.now()) - startedAt) }
  }

  async function runGeneration(job, body, github, architecture, requestSignal) {
    const timeout = AbortSignal.timeout(15 * 60_000)
    const signal = AbortSignal.any([lifetime.signal, timeout, ...(requestSignal ? [requestSignal] : [])])
    function fail(error, status) {
      Object.assign(job, { phase: 'failed', finishedAt: Date.now(), error })
      return json({ error }, status)
    }
    try {
      const readRepository = github ? architecture ? openGithubRepository : collectGithubSource
        : architecture ? openLocalRepository : collectLocalSource
      const source = await readRepository(github ? body.repositoryUrl : body.repositoryPath, { signal })
      job.repository = github ? `${source.owner}/${source.repo}` : source.repo
      job.phase = 'writing'
      if (!github) source.sourceKey = job.id
      let markdown
      let graph
      let files = source.files
      let note
      let model
      try {
        const { llm, selection } = await selectModel(ctx, config?.modelConfigFile, signal)
        if (architecture) {
          const result = await exploreArchitecture(ctx, source, selection, config?.modelConfigFile === undefined ? null : llm,
            signal, (count, path) => { job.filesRead = count; job.currentFile = path })
          markdown = result.markdown
          graph = result.architecture
          files = result.files.map(file => ({ path: file.path, text: file.text, startLine: file.start }))
        } else {
          markdown = await generateWiki(llm, selection, source, signal)
        }
        model = selection.model
      } catch (error) {
        if (signal.aborted || !['model-unavailable', 'model-output-invalid'].includes(error?.code)) throw error
        if (architecture) {
          return fail(error.code === 'model-output-invalid' ? '架构说明校验未通过。' + error.message
            : '架构分析 ' + modelNote(error).replace('，以下为源码摘录。', '。请重试。'), 502)
        }
        markdown = renderSourceWiki(source)
        note = modelNote(error)
      }
      signal.throwIfAborted()
      job.phase = 'saving'
      const document = {
        id: job.id,
        createdAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - job.startedAt),
        source: github ? 'github' : 'local',
        ...(github ? { repoUrl: `https://github.com/${source.owner}/${source.repo}` }
          : { repositoryPath: source.repositoryPath, repoName: source.repo, files }),
        commit: source.commit,
        markdown,
        ...(graph && { architecture: graph }),
        model,
        note,
      }
      try {
        const result = withoutEvidence(await storage.save(document))
        Object.assign(job, { phase: 'completed', finishedAt: Date.now(), result })
        return json(result)
      } catch {
        return fail('文档已生成，但保存失败。请检查 DSH 数据目录是否可写。', 500)
      }
    } catch (error) {
      if (timeout.aborted) return fail('生成已达到 15 分钟上限，请重试。', 504)
      if (signal.aborted) return fail('生成已取消。', 503)
      const status = sourceErrors.get(error?.code)
      if (status !== undefined) return fail(error.message, status)
      return fail('生成失败，请重试。', 500)
    } finally {
      active = undefined
    }
  }

  async function startGeneration(request, background, architecture = false) {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return json({ error: '请求必须是 JSON。' }, 415)
    }

    const body = await request.json().catch(() => undefined)
    const github = typeof body?.repositoryUrl === 'string' && body.repositoryUrl.length <= 300
    const local = typeof body?.repositoryPath === 'string' && body.repositoryPath.length <= 4096
    if (local === github) {
      return json({ error: '请提供一个 GitHub 仓库地址或本地 Git 仓库路径。' }, 400)
    }

    if (active) return json({ error: '已有文档正在生成。', job: progress(active) }, 409)
    const githubName = github && /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/?$/i.exec(body.repositoryUrl.trim())?.[1]
    const repository = github ? (githubName || 'GitHub 仓库') : (basename(body.repositoryPath) || '本地仓库')
    const job = { id: randomUUID(), phase: 'reading', startedAt: Date.now(), repository }
    jobs.set(job.id, job)
    if (jobs.size > 8) jobs.delete(jobs.keys().next().value)
    active = job
    if (background) {
      void runGeneration(job, body, github, architecture)
      return json({ job: progress(job) }, 202)
    }
    return runGeneration(job, body, github, architecture, request.signal)
  }

  ctx.effect(() => () => lifetime.abort())
  ctx.connection.fetch.register({
    path: generationRoute,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch(request) {
      if (request.method === 'POST') return startGeneration(request, true, true)
      const id = new URL(request.url).searchParams.get('id')
      return json({ job: progress(id === null ? active : jobs.get(id)) })
    },
  })
  ctx.connection.fetch.register({
    path: documentsRoute,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => documentsResponse(request, storage),
  })
  ctx.connection.fetch.register({
    path: deleteDocumentRoute,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json({ error: '请求必须是 JSON。' }, 415)
      }
      const { id } = await request.json().catch(() => null) ?? {}
      if (active && active.id === id) return json({ error: '文档正在生成，请等保存完成后再删除。' }, 409)
      if (videos.busy(id)) return json({ error: '讲解视频正在生成，请先取消视频任务。' }, 409)
      try {
        if (!await storage.remove(id)) return json({ error: '文档编号无效。' }, 400)
        await videos.remove(id)
        jobs.delete(id)
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
      } catch {
        return json({ error: '无法删除文档，请重试。' }, 500)
      }
    },
  })
  ctx.connection.fetch.register({
    path: sourceRoute,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => localSourceResponse(request, storage),
  })
  ctx.connection.fetch.register({
    path: generateRoute,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => startGeneration(request, request.headers.get('prefer') === 'respond-async'),
  })
}
