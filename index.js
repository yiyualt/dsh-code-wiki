import { randomUUID } from 'node:crypto'
import { readConfiguredModel } from './src/configured-model.js'
import { collectGithubSource } from './src/github-source.js'
import { generateWiki, modelError, renderSourceWiki } from './src/generate-wiki.js'
import { collectLocalSource } from './src/local-source.js'

export const name = 'dsh-code-wiki'
export const inject = ['connection', 'llm', 'agentDefaultModel']

const generateRoute = '/api/dsh-code-wiki/generate'
const sourceRoute = '/api/dsh-code-wiki/source'
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

function localSourceResponse(request, documents) {
  const query = new URL(request.url).searchParams
  const document = documents.get(query.get('key'))
  const [file, start, end] = ['file', 'start', 'end'].map(name => Number(query.get(name)))
  const evidence = document?.files[file - 1]
  const lines = evidence?.text.replace(/\r?\n$/, '').split('\n')
  if (!evidence || ![file, start, end].every(Number.isInteger) || start < 1 || end < start
    || end - start > 24 || end > lines.length) {
    return new Response('这条源码引用不可用。请在代码百科重新生成。', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
  const excerpt = lines.slice(start - 1, end).map((line, i) => `${start + i} | ${line}`).join('\n')
  return new Response(`${evidence.path}\nCommit ${document.commit}\n\n${excerpt}\n`, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
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

export function apply(ctx, config) {
  const lifetime = new AbortController()
  const localDocuments = new Map()
  let active = false

  ctx.effect(() => () => lifetime.abort())
  ctx.connection.fetch.register({
    path: sourceRoute,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => localSourceResponse(request, localDocuments),
  })
  ctx.connection.fetch.register({
    path: generateRoute,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json({ error: '请求必须是 JSON。' }, 415)
      }

      const body = await request.json().catch(() => undefined)
      const github = typeof body?.repositoryUrl === 'string' && body.repositoryUrl.length <= 300
      const local = typeof body?.repositoryPath === 'string' && body.repositoryPath.length <= 4096
      if (local === github) {
        return json({ error: '请提供一个 GitHub 仓库地址或本地 Git 仓库路径。' }, 400)
      }

      if (active) return json({ error: '已有文档正在生成，请稍后再试。' }, 409)
      active = true
      const timeout = AbortSignal.timeout(150_000)
      const signal = AbortSignal.any([request.signal, lifetime.signal, timeout])
      try {
        const source = github
          ? await collectGithubSource(body.repositoryUrl, { signal })
          : await collectLocalSource(body.repositoryPath, { signal })
        const sourceKey = local ? randomUUID() : undefined
        if (sourceKey) source.sourceKey = sourceKey
        let markdown
        let note
        let model
        try {
          const { llm, selection } = await selectModel(ctx, config?.modelConfigFile, signal)
          markdown = await generateWiki(llm, selection, source, signal)
          model = selection.model
        } catch (error) {
          if (signal.aborted || !['model-unavailable', 'model-output-invalid'].includes(error?.code)) throw error
          markdown = renderSourceWiki(source)
          note = modelNote(error)
        }
        if (sourceKey) {
          localDocuments.set(sourceKey, source)
          if (localDocuments.size > 8) localDocuments.delete(localDocuments.keys().next().value)
        }
        return json({
          ...(github ? { repoUrl: `https://github.com/${source.owner}/${source.repo}` }
            : { repositoryPath: source.repositoryPath, repoName: source.repo }),
          commit: source.commit,
          markdown,
          model,
          note,
        })
      } catch (error) {
        if (timeout.aborted) return json({ error: '生成超时，请重试。' }, 504)
        if (signal.aborted) return json({ error: '生成已取消。' }, 503)
        const sourceStatus = sourceErrors.get(error?.code)
        if (sourceStatus !== undefined) return json({ error: error.message }, sourceStatus)
        return json({ error: '生成失败，请重试。' }, 500)
      } finally {
        active = false
      }
    },
  })
}
