import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { generateWiki } from './skills/repo-design-wiki/scripts/generate.mjs'
import { readConfiguredModel } from './src/configured-model.js'
import { openGithubRepository, sameGithubRepository } from './src/github-source.js'
import { modelError } from './src/model-error.js'
import { openLocalRepository } from './src/local-source.js'
import { openWikiAuthor } from './src/wiki-author.js'
import { restoreLegacyWiki } from './src/wiki-document.js'
import { createWikiStorage } from './src/wiki-storage.js'
import { createWikiCheckpoints } from './src/wiki-checkpoint.js'
import { createWikiProgress } from './src/wiki-progress.js'
import { loadWikiSkill, registerWikiSkill } from './src/wiki-skill.js'
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
  ['invalid-repository-commit', 400],
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

function researchFailure(error, resumable) {
  const next = resumable ? '研究记录已保存，可以继续生成。' : '请重新尝试。'
  if (['TRANSPORT', 'TIMEOUT', 'STREAM_CLOSED'].includes(error.providerCode)) return '与模型服务的连接中断。' + next
  if (['SERVER', 'RATE_LIMIT'].includes(error.providerCode)) return '模型服务暂时不可用。' + next
  if (error.providerCode === 'MALFORMED_RESPONSE') return '模型返回的工具参数格式无效。' + next
  if (['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'MODEL_CONFIG'].includes(error.providerCode)) {
    return '无法使用当前模型配置，请检查后重试。'
  }
  return '模型未能完成这次研究。' + next
}

async function selectModel(ctx, configFile, signal, options) {
  if (configFile === undefined) return { llm: ctx.llm, selection: ctx.agentDefaultModel.currentSelection() }
  try {
    const llm = await readConfiguredModel(configFile, signal, options)
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

function checkpointProgress(id, checkpoint) {
  if (!checkpoint) return null
  const { commit, repositoryUrl, repositoryPath } = checkpoint
  const repository = repositoryUrl ? repositoryUrl.replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/i, '')
    : basename(repositoryPath)
  return { id, phase: 'failed', elapsedMs: 0, commit, repository, canResume: true,
    ...(repositoryUrl ? { repositoryUrl } : { repositoryPath }), error: '上次生成已中断，已保存研究进度。' }
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
  const checkpoints = createWikiCheckpoints(join(ctx.profileContext.dir, 'dsh-code-wiki-checkpoints'))
  const videos = registerVideoApi(ctx, config, storage, selectModel, lifetime)
  const jobs = new Map()
  const diagnostics = new WeakMap()
  let active

  function progress(job) {
    if (!job) return null
    const { startedAt, finishedAt, ...status } = job
    return { ...status, ...diagnostics.get(job)?.status(), elapsedMs: Math.max(0, (finishedAt ?? Date.now()) - startedAt) }
  }

  async function generationStatus(id) {
    if (id !== null) {
      if (jobs.has(id)) return progress(jobs.get(id))
      const checkpoint = await checkpoints.get(id)
      return checkpoint && !await storage.get(id) ? checkpointProgress(id, checkpoint) : null
    }
    if (active) return progress(active)
    if (jobs.size) {
      const latest = [...jobs.values()].at(-1)
      return latest.phase === 'failed' && latest.canResume && !lifetime.signal.aborted ? progress(latest) : null
    }
    let documents
    const checkpoint = await checkpoints.latest(async saved => {
      documents ??= await storage.list()
      return !documents.some(document => document.commit === saved.commit
        && new Date(document.createdAt).getTime() >= Math.floor(saved.updatedAt)
        && (saved.repositoryUrl ? sameGithubRepository(document.repoUrl, saved.repositoryUrl) : document.repositoryPath === saved.repositoryPath))
    })
    // A generation may have started while the disk records were being read.
    return active ? progress(active) : jobs.size ? null : checkpointProgress(checkpoint?.id, checkpoint)
  }

  async function runGeneration(job, body, github, requestSignal) {
    const tracking = createWikiProgress(job)
    diagnostics.set(job, tracking)
    const signal = AbortSignal.any([lifetime.signal, ...(requestSignal ? [requestSignal] : [])])
    function fail(error, status, reason = 'unexpected-error') {
      tracking.finish('failed', reason)
      Object.assign(job, { phase: 'failed', finishedAt: Date.now(), error })
      return json({ error }, status)
    }
    try {
      const checkpoint = body.resumeFrom ? await checkpoints.get(body.resumeFrom) : null
      if (body.resumeFrom && (!checkpoint
        || (github ? !sameGithubRepository(checkpoint.repositoryUrl, body.repositoryUrl) : checkpoint.repositoryPath !== body.repositoryPath.trim())
        || (body.commit !== undefined && checkpoint.commit !== body.commit))) {
        return fail('找不到这个仓库版本的研究记录，请重新生成。', 400)
      }
      const readRepository = github ? openGithubRepository : openLocalRepository
      const source = await readRepository(github ? body.repositoryUrl : body.repositoryPath,
        { signal, ...((body.commit || (github && checkpoint?.commit)) && { commit: body.commit || checkpoint.commit }) })
      if (checkpoint && checkpoint.commit !== source.commit) return fail('仓库版本已经变化，请重新生成。', 409)
      job.repository = github ? `${source.owner}/${source.repo}` : source.repo
      job.commit = source.commit
      tracking.phase('writing')
      if (!github) source.sourceKey = job.id
      let model
      let result
      try {
        const { llm, selection } = await selectModel(ctx, config?.modelConfigFile, signal,
          { toolCallLimit: 64, streamResponses: true, transportRetries: 2, onProgress: tracking.model })
        const adapter = config?.modelConfigFile === undefined ? null : llm
        result = await generateWiki({
          source, signal, checkpoint,
          loadSkill: () => loadWikiSkill(ctx.profileContext.home, signal),
          openAuthor: options => openWikiAuthor(ctx, selection, adapter, options),
          restoreLegacy: restoreLegacyWiki,
          onRead(count, path) {
            Object.assign(job, { filesRead: count, currentFile: path })
            tracking.activity('source-read')
          },
          onPhase: tracking.phase,
          async onCheckpoint(material) {
            await checkpoints.save(job.id, { version: 1,
              ...(github ? { repositoryUrl: body.repositoryUrl.trim() } : { repositoryPath: body.repositoryPath.trim() }),
              commit: source.commit, ...material })
            job.canResume = true
            tracking.activity('checkpoint', { evidenceCount: material.evidence.length, hasDraft: material.textDraft.complete })
          },
        })
        model = selection.model
      } catch (error) {
        if (!signal.aborted && error?.code === 'wiki-skill-invalid') {
          if (checkpoint) {
            await checkpoints.save(job.id, checkpoint)
            job.canResume = true
          }
          return fail(error.message, 422, 'model-error')
        }
        if (signal.aborted || !['model-unavailable', 'model-output-invalid'].includes(error?.code)) throw error
        if (error.providerCode) job.failureCode = error.providerCode
        return fail(error.code === 'model-output-invalid' ? '文档未能存档。' + error.message
          : researchFailure(error, job.canResume), 502, error.code === 'model-output-invalid' ? 'validation-error' : 'model-error')
      }
      signal.throwIfAborted()
      tracking.phase('saving')
      const { files: evidence, ...content } = result
      const document = {
        id: job.id,
        createdAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - job.startedAt),
        source: github ? 'github' : 'local',
        ...(github ? { repoUrl: `https://github.com/${source.owner}/${source.repo}` }
          : { repositoryPath: source.repositoryPath, repoName: source.repo,
            files: evidence.map(({ path, text, start }) => ({ path, text, startLine: start })) }),
        commit: source.commit,
        ...content,
        model,
      }
      try {
        const result = withoutEvidence(await storage.save(document))
        tracking.finish('completed', 'completed')
        Object.assign(job, { phase: 'completed', canResume: false, finishedAt: Date.now(), result })
        await Promise.allSettled([checkpoints.remove(job.id), ...(body.resumeFrom ? [checkpoints.remove(body.resumeFrom)] : [])])
        return json(result)
      } catch {
        return fail('文档已生成，但保存失败。请检查 DSH 数据目录是否可写。', 500, 'storage-error')
      }
    } catch (error) {
      if (signal.aborted) return fail('生成已取消。', 503, 'cancelled')
      const status = sourceErrors.get(error?.code)
      if (status !== undefined) return fail(error.message, status, 'source-error')
      return fail('生成失败，请重试。', 500)
    } finally {
      tracking.finish('failed')
      active = undefined
    }
  }

  async function startGeneration(request, background) {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return json({ error: '请求必须是 JSON。' }, 415)
    }

    const body = await request.json().catch(() => undefined)
    const github = typeof body?.repositoryUrl === 'string' && body.repositoryUrl.length <= 300
    const local = typeof body?.repositoryPath === 'string' && body.repositoryPath.length <= 4096
    if (local === github) {
      return json({ error: '请提供一个 GitHub 仓库地址或本地 Git 仓库路径。' }, 400)
    }
    if (body.commit !== undefined && (!github || typeof body.commit !== 'string'
      || !/^[a-f0-9]{40}$/.test(body.commit))) {
      return json({ error: '固定版本需要 GitHub 仓库和完整的 40 位提交编号。' }, 400)
    }
    if (body.resumeFrom !== undefined && (typeof body.resumeFrom !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(body.resumeFrom))) {
      return json({ error: '研究记录编号无效。' }, 400)
    }

    if (active) return json({ error: '已有文档正在生成。', job: progress(active) }, 409)
    const githubName = github && /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/?$/i.exec(body.repositoryUrl.trim())?.[1]
    const repository = github ? (githubName || 'GitHub 仓库') : (basename(body.repositoryPath) || '本地仓库')
    const job = { id: randomUUID(), phase: 'reading', startedAt: Date.now(), repository, canResume: false,
      ...(github ? { repositoryUrl: body.repositoryUrl.trim() } : { repositoryPath: body.repositoryPath.trim() }) }
    jobs.set(job.id, job)
    if (jobs.size > 8) jobs.delete(jobs.keys().next().value)
    active = job
    if (background) {
      void runGeneration(job, body, github)
      return json({ job: progress(job) }, 202)
    }
    return runGeneration(job, body, github, request.signal)
  }

  ctx.effect(() => () => lifetime.abort())
  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], scope => { registerWikiSkill(scope.skills) })
  } else {
    registerWikiSkill(ctx.skills)
  }
  ctx.connection.fetch.register({
    path: generationRoute,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method === 'POST') return startGeneration(request, true)
      const id = new URL(request.url).searchParams.get('id')
      try { return json({ job: await generationStatus(id) }) }
      catch { return json({ error: '无法读取生成进度，请重试。' }, 500) }
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
      const releaseRemoval = videos.reserveRemoval(id)
      if (!releaseRemoval) return json({ error: '文档正在删除或生成讲解视频，请等任务完成后再删除。' }, 409)
      try {
        if (!await storage.remove(id)) return json({ error: '文档编号无效。' }, 400)
        await videos.remove(id)
        jobs.delete(id)
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
      } catch {
        return json({ error: '无法删除文档，请重试。' }, 500)
      } finally { releaseRemoval() }
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
