import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateChapter } from './skills/repo-design-wiki/scripts/generate-chapter.mjs'
import { generateOutline } from './skills/repo-design-wiki/scripts/generate-outline.mjs'
import { openRepository } from './skills/repo-design-wiki/scripts/read-repository.mjs'
import { singleLine } from './skills/repo-design-wiki/scripts/wiki-generation.mjs'
import { openWikiAuthor } from './src/wiki-author.js'
import { createWikiStorage, readChapterConnection } from './src/wiki-storage.js'

export const name = 'dsh-code-wiki'
export const inject = ['connection', 'skills', 'agents', 'agentDefaultModel', 'profileContext']

const skillName = 'repo-design-wiki'
const skillPath = fileURLToPath(new URL('./skills/repo-design-wiki/SKILL.md', import.meta.url))
const skillDirectory = dirname(skillPath).split(sep).join('/')
const responseHeaders = { 'cache-control': 'no-store' }
const sourceErrors = new Map([
  ['invalid-repository-source', 400], ['invalid-repository-url', 400], ['invalid-local-path', 400],
  ['invalid-repository-commit', 400], ['invalid-chapter-request', 400],
  ['repository-unavailable', 404], ['repository-no-evidence', 422],
  ['local-directory-unavailable', 404], ['local-not-git-repository', 422],
  ['local-git-unavailable', 503], ['local-git-forbidden', 403],
  ['local-git-unborn-head', 422], ['local-git-invalid-head', 422],
  ['local-git-commit-unavailable', 404], ['local-git-tree-unavailable', 422],
  ['github-rate-limited', 429], ['github-request-failed', 502],
  ['wiki-document-not-found', 404], ['wiki-chapter-not-found', 404],
  ['wiki-document-read-only', 409], ['wiki-chapter-busy', 409], ['wiki-document-busy', 409],
  ['wiki-storage-invalid', 500],
])

function wikiProblem(code, message) {
  return Object.assign(new Error(message), { code })
}

function generationFailure(error, route, label) {
  const sourceStatus = sourceErrors.get(error?.code)
  if (sourceStatus) return { status: sourceStatus, message: error.message }
  if (error?.code === 'wiki-skill-unavailable') return { status: 500, message: '无法读取代码百科 Skill。' }
  if (error?.code === 'wiki-model-unavailable') return { status: 502, message: '暂时无法使用 DSH 当前模型。' }
  if (error?.code === `wiki-${route}-invalid`) return { status: 502, message: error.message }
  return { status: 500, message: `无法生成代码百科${label}，请重试。` }
}

function streamChapter(requestSignal, headers, execute, fail) {
  const canceled = new AbortController()
  const signal = AbortSignal.any([requestSignal, canceled.signal])
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      const emit = event => {
        if (!signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
      }
      void (async () => {
        try {
          const result = await execute(signal, emit)
          emit({ type: 'done', warning: result.warning })
        } catch (error) {
          if (!signal.aborted) emit({ type: 'error', error: fail(error).message })
        } finally {
          if (!canceled.signal.aborted) controller.close()
        }
      })()
    },
    cancel(reason) {
      canceled.abort(reason)
    },
  })
  return new Response(stream, {
    headers: {
      ...headers,
      'cache-control': 'no-store, no-transform',
      'content-type': 'application/x-ndjson; charset=utf-8',
    },
  })
}

async function readSkill(signal) {
  const markdown = (await readFile(skillPath, { encoding: 'utf8', signal })).replace(/\r\n?/g, '\n')
  const manifest = /^---\n([\s\S]+?)\n---\n([\s\S]+)$/.exec(markdown)
  const description = manifest?.[1].match(/^description:[ \t]*(.+)$/m)?.[1].trim()
  const content = manifest?.[2].trim()
  if (!description || !content) throw new Error('The bundled Wiki Skill is missing its description or instructions.')
  return { description, content }
}

function chapterRequest(input) {
  const { commit, mainline, chapter, previous, next, ...source } = input ?? {}
  if (typeof commit !== 'string' || !singleLine(mainline, 4_000) || !singleLine(chapter?.title, 500)
    || !Array.isArray(chapter.sources) || !chapter.sources.length || chapter.sources.length > 16
    || chapter.sources.some(ref => typeof ref?.path !== 'string' || !ref.path || ref.path.length > 512
      || !Number.isSafeInteger(ref.line) || ref.line < 1)
    || (previous !== null && (!singleLine(previous?.title, 500)
      || typeof previous.handoff !== 'string' || previous.handoff.length > 1200))
    || (next !== null && !singleLine(next, 500))) {
    throw wikiProblem('invalid-chapter-request', '章节因缺少目录、版本或源码位置，无法生成。请重新生成目录。')
  }
  const connection = chapter.connection === undefined ? undefined : readChapterConnection(chapter.connection)
  if (connection === null) throw wikiProblem('invalid-chapter-request', '章节的模块交接信息格式有误。')
  return {
    source, commit, mainline, next,
    chapter: {
      title: chapter.title, sources: chapter.sources.map(({ path, line }) => ({ path, line })),
      ...(connection && { connection }),
    },
    previous: previous && { title: previous.title, handoff: previous.handoff },
  }
}

function repositoryInput({ source, location }) {
  return source === 'github' ? { repositoryUrl: location } : { repositoryPath: location }
}

function registerDocuments(ctx, storage, active) {
  ctx.connection.fetch.register({
    path: '/api/dsh-code-wiki/documents',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method === 'POST') {
        const { id, action } = await request.json().catch(() => null) ?? {}
        if (typeof id !== 'string' || !id || !['archive', 'restore', 'delete'].includes(action)) {
          return Response.json({ error: '请选择有效的代码百科和操作。' }, { status: 400, headers: responseHeaders })
        }
        if (active.chapters.has(id) || active.documents.has(id)) {
          return Response.json({ error: '这篇代码百科正在生成或更新，请完成后重试。' }, { status: 409, headers: responseHeaders })
        }
        active.documents.add(id)
        try {
          const result = action === 'delete' ? await storage.delete(id) : await storage.setArchived(id, action === 'archive')
          return Response.json(result, { headers: responseHeaders })
        } catch (error) {
          if (error?.code === 'wiki-document-not-found') {
            return Response.json({ error: error.message }, { status: 404, headers: responseHeaders })
          }
          return Response.json({ error: '无法更新这篇代码百科。请重试。' }, { status: 500, headers: responseHeaders })
        } finally {
          active.documents.delete(id)
        }
      }

      const id = new URL(request.url).searchParams.get('id')
      try {
        if (id === null) return Response.json({ documents: await storage.list() }, { headers: responseHeaders })
        const record = await storage.get(id)
        if (record) return Response.json(record, { headers: responseHeaders })
        return Response.json({ error: '找不到这篇文档。' }, { status: 404, headers: responseHeaders })
      } catch {
        return Response.json({ error: '无法读取已保存的文档。请重试。' }, { status: 500, headers: responseHeaders })
      }
    },
  })
}

function savedChapterResult({ content, warning }, onEvent) {
  if (onEvent) {
    const { diagrams, sources } = content
    onEvent({ type: 'body', content: { ...content, diagrams: [] } })
    for (const diagram of diagrams) onEvent({ type: 'diagram', diagram, sources })
  }
  return { ...content, ...(warning && { warning }) }
}

async function generateSavedChapter({ documentId, chapterIndex }, storage, active, options) {
  if (typeof documentId !== 'string' || !Number.isSafeInteger(chapterIndex) || chapterIndex < 0) {
    throw wikiProblem('invalid-chapter-request', '请打开文档并选择要生成的章节。')
  }
  if (active.documents.has(documentId)) throw wikiProblem('wiki-document-busy', '这篇代码百科正在更新，请稍后重试。')
  const running = active.chapters.get(documentId) ?? new Set()
  if (running.has(chapterIndex)) throw wikiProblem('wiki-chapter-busy', '本章正在另一个请求中生成，请稍后重新打开。')
  active.chapters.set(documentId, running)
  running.add(chapterIndex)
  try {
    const record = await storage.get(documentId)
    if (!record) throw wikiProblem('wiki-document-not-found', '找不到这篇文档。')
    if (record.legacy) throw wikiProblem('wiki-document-read-only', '这篇归档文档可在文档库中阅读。')
    const { document, chapterWork } = record
    const { mainline, commit, chapters } = document
    const chapter = chapters[chapterIndex]
    if (!chapter) throw wikiProblem('wiki-chapter-not-found', '找不到这个章节。')

    const saved = chapterWork[chapterIndex]
    if (saved?.content.diagrams.length) return savedChapterResult(saved, options.onEvent)

    const repository = await openRepository(repositoryInput(document), options.signal, commit)
    const previousChapter = chapters[chapterIndex - 1]
    const previous = previousChapter ? {
      title: previousChapter.title,
      handoff: chapterWork[chapterIndex - 1]?.content?.handoff ?? '',
    } : null
    const next = chapters[chapterIndex + 1]?.title ?? null
    let retained = saved
    let stagedBody
    let writes = Promise.resolve()
    const onEvent = event => {
      if (saved && event.type === 'body') {
        // Keep the saved text until a replacement has a verified diagram.
        stagedBody = event
        return
      }
      const replacement = stagedBody
      stagedBody = undefined
      writes = writes.then(async () => {
        const updated = await storage.updateChapter(documentId, chapterIndex, current => {
          if (event.type === 'body') return { content: event.content }
          const body = replacement?.content ?? current.content
          return { content: { ...body, sources: event.sources, diagrams: [...body.diagrams, event.diagram] } }
        })
        retained = updated.chapterWork[chapterIndex]
        if (replacement) options.onEvent?.(replacement)
        options.onEvent?.(event)
      })
      // Keep accepted output queued for storage even if the browser disconnects.
      void writes.catch(() => {})
    }

    let result
    try {
      result = await generateChapter({ repository, mainline, chapter, previous, next, ...options, onEvent })
    } finally {
      await writes
    }
    const replay = retained === saved
    if (result.warning) {
      const updated = await storage.updateChapter(documentId, chapterIndex, current => ({
        ...current, warning: result.warning,
      }))
      retained = updated.chapterWork[chapterIndex]
    }
    return savedChapterResult(retained, replay ? options.onEvent : undefined)
  } finally {
    running.delete(chapterIndex)
    if (!running.size) active.chapters.delete(documentId)
  }
}

function registerGeneration(ctx, route, label, run) {
  ctx.connection.fetch.register({
    path: `/api/dsh-code-wiki/${route}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const input = await request.json().catch(() => null)
      const { signal } = request
      const requestId = randomUUID()
      const chapterRoute = route === 'chapter'
      const headers = { ...responseHeaders, 'x-dsh-wiki-request-id': requestId, ...(chapterRoute && { vary: 'Accept' }) }
      // Generation diagnostics are supplied by the Skill and contain status details only.
      const diagnostic = record => console.info('[dsh-code-wiki]', JSON.stringify({ requestId, route, ...record }))
      const fail = error => {
        const failure = generationFailure(error, route, label)
        const code = typeof error?.code === 'string' && /^[a-z][a-z\d_-]*$/i.test(error.code) ? error.code : 'internal'
        diagnostic({ phase: 'request', status: 'failed', code, httpStatus: failure.status })
        return failure
      }
      const execute = async (generationSignal, onEvent) => {
        generationSignal.throwIfAborted()
        const skill = await ctx.skills.get(skillName, { signal: generationSignal })
        if (!skill?.content) throw Object.assign(new Error('Wiki Skill unavailable.'), { code: 'wiki-skill-unavailable' })
        return run(input, {
          instructions: skill.content, signal: generationSignal, onEvent, diagnostic,
          openAuthor: options => openWikiAuthor(ctx, options),
        })
      }
      if (chapterRoute && request.headers.get('accept')?.includes('application/x-ndjson')) {
        return streamChapter(signal, headers, execute, fail)
      }
      try {
        return Response.json(await execute(signal), { headers })
      } catch (error) {
        if (signal.aborted) throw error
        const { status, message } = fail(error)
        return Response.json({ error: message }, { status, headers })
      }
    },
  })
}

export function apply(ctx) {
  const storage = createWikiStorage(join(ctx.profileContext.dir, 'dsh-code-wiki', 'documents'))
  const active = { chapters: new Map(), documents: new Set() }
  registerDocuments(ctx, storage, active)
  ctx.skills.registerProvider(() => ({
    name,
    async list({ signal }) {
      const { description } = await readSkill(signal)
      return [{
        name: skillName, description, provider: name, source: 'bundled', rank: 600, locator: skillPath,
        invocation: { modelInvocable: true, userInvocable: true },
        resourceBase: { kind: 'directory', path: skillDirectory }, path: skillPath,
      }]
    },
    async get({ rank, locator, ...summary }, { signal }) {
      const { content } = await readSkill(signal)
      return { ...summary, content }
    },
  }))

  registerGeneration(ctx, 'outline', '总览和目录', async (input, options) => {
    const repository = await openRepository(input, options.signal)
    const outline = await generateOutline({ repository, ...options })
    if (!outline.overview) throw wikiProblem('wiki-outline-invalid', '总览需要正文、逻辑架构图和模块关系图。')
    const origin = repository.webUrl
      ? { source: 'github', location: repository.webUrl }
      : { source: 'local', location: input.repositoryPath }
    const record = await storage.create({ ...origin, title: repository.label, ...outline })
    const { chapters, overview } = record.document
    return { id: record.id, ...outline, chapters, overview }
  })

  registerGeneration(ctx, 'chapter', '章节正文和图', async (input, options) => {
    if (input?.documentId !== undefined || input?.chapterIndex !== undefined) {
      return generateSavedChapter(input, storage, active, options)
    }
    const { source, commit, ...context } = chapterRequest(input)
    const repository = await openRepository(source, options.signal, commit)
    return generateChapter({ repository, ...context, ...options })
  })
}
