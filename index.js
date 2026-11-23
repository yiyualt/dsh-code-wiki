import { join } from 'node:path'
import { readConfiguredModel } from './src/configured-model.js'
import { modelError } from './src/model-error.js'
import { createWikiStorage } from './src/wiki-storage.js'
import { registerVideoApi } from './src/video-api.js'

export const name = 'dsh-code-wiki'
export const inject = ['connection', 'llm', 'agentDefaultModel', 'profileContext']

const generateRoute = '/api/dsh-code-wiki/generate'
const generationRoute = '/api/dsh-code-wiki/generation'
const sourceRoute = '/api/dsh-code-wiki/source'
const documentsRoute = '/api/dsh-code-wiki/documents'
const deleteDocumentRoute = '/api/dsh-code-wiki/documents/delete'

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

function generationUnavailable() {
  return json({ error: 'Wiki 生成暂不可用。' }, 410)
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
  ctx.effect(() => () => lifetime.abort())

  ctx.connection.fetch.register({
    path: generationRoute,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: request => request.method === 'GET' ? json({ job: null }) : generationUnavailable(),
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
      const releaseRemoval = videos.reserveRemoval(id)
      if (!releaseRemoval) return json({ error: '文档正在删除或生成讲解视频，请等任务完成后再删除。' }, 409)
      try {
        if (!await storage.remove(id)) return json({ error: '文档编号无效。' }, 400)
        await videos.remove(id)
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
    fetch: generationUnavailable,
  })
}
