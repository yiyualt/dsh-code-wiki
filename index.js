import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateChapter } from './skills/repo-design-wiki/scripts/generate-chapter.mjs'
import { generateOutline } from './skills/repo-design-wiki/scripts/generate-outline.mjs'
import { openRepository } from './skills/repo-design-wiki/scripts/read-repository.mjs'
import { singleLine } from './skills/repo-design-wiki/scripts/wiki-generation.mjs'
import { openWikiAuthor } from './src/wiki-author.js'

export const name = 'dsh-code-wiki'
export const inject = ['connection', 'skills', 'agents', 'agentDefaultModel']

const skillName = 'repo-design-wiki'
const skillPath = fileURLToPath(new URL('./skills/repo-design-wiki/SKILL.md', import.meta.url))
const skillDirectory = dirname(skillPath).split(sep).join('/')
const responseHeaders = { 'cache-control': 'no-store' }
const sourceErrors = new Map([
  ['invalid-repository-source', 400], ['invalid-repository-url', 400], ['invalid-local-path', 400],
  ['invalid-repository-commit', 400], ['invalid-chapter-request', 400],
  ['repository-unavailable', 404], ['repository-no-evidence', 422],
  ['github-rate-limited', 429], ['github-request-failed', 502],
])

function generationFailure(error, route, label) {
  const sourceStatus = sourceErrors.get(error?.code)
  if (sourceStatus) return { status: sourceStatus, message: error.message }
  if (error?.code === 'wiki-skill-unavailable') return { status: 500, message: '无法读取代码百科 Skill。' }
  if (error?.code === 'wiki-model-unavailable') return { status: 502, message: '暂时无法使用 DSH 当前模型。' }
  if (route === 'chapter' && error?.code === 'wiki-chapter-invalid') return { status: 502, message: error.message }
  if (error?.code === `wiki-${route}-invalid` || error?.code === 'wiki-author-invalid') {
    return { status: 502, message: `模型未能生成有效的${label}，请重试。` }
  }
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
    throw Object.assign(new Error('章节因缺少目录、版本或源码位置，无法生成。请重新生成目录。'), {
      code: 'invalid-chapter-request',
    })
  }
  return {
    source, commit, mainline, next,
    chapter: { title: chapter.title, sources: chapter.sources.map(({ path, line }) => ({ path, line })) },
    previous: previous && { title: previous.title, handoff: previous.handoff },
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
      const requestId = route === 'chapter' ? randomUUID() : null
      const headers = requestId
        ? { ...responseHeaders, 'x-dsh-wiki-request-id': requestId, vary: 'Accept' }
        : responseHeaders
      // Generation diagnostics are supplied by the Skill and contain status details only.
      const diagnostic = requestId
        ? record => console.info('[dsh-code-wiki]', JSON.stringify({ requestId, ...record }))
        : undefined
      const fail = error => {
        const failure = generationFailure(error, route, label)
        const code = typeof error?.code === 'string' && /^[a-z][a-z\d_-]*$/i.test(error.code) ? error.code : 'internal'
        diagnostic?.({ phase: 'request', status: 'failed', code, httpStatus: failure.status })
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
      if (requestId && request.headers.get('accept')?.includes('application/x-ndjson')) {
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

  registerGeneration(ctx, 'outline', '目录', async (input, options) => {
    const repository = await openRepository(input, options.signal)
    return generateOutline({ repository, ...options })
  })

  registerGeneration(ctx, 'chapter', '章节正文和图', async (input, options) => {
    const { source, commit, ...context } = chapterRequest(input)
    const repository = await openRepository(source, options.signal, commit)
    return generateChapter({ repository, ...context, ...options })
  })
}
