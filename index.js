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

function wikiError(message, status) {
  return Response.json({ error: message }, { status, headers: responseHeaders })
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
      const deadline = AbortSignal.timeout(180_000)
      const signal = AbortSignal.any([request.signal, deadline])
      try {
        const skill = await ctx.skills.get(skillName, { signal })
        if (!skill?.content) return wikiError('无法读取代码百科 Skill。', 500)
        const result = await run(input, {
          instructions: skill.content, signal,
          openAuthor: options => openWikiAuthor(ctx, options),
        })
        return Response.json(result, { headers: responseHeaders })
      } catch (error) {
        if (request.signal.aborted) throw error
        if (deadline.aborted) return wikiError(`生成${label}超时，请重试。`, 504)
        const sourceStatus = sourceErrors.get(error?.code)
        if (sourceStatus) return wikiError(error.message, sourceStatus)
        if (error?.code === 'wiki-model-unavailable') return wikiError('暂时无法使用 DSH 当前模型。', 502)
        if (error?.code === `wiki-${route}-invalid` || error?.code === 'wiki-author-invalid') {
          return wikiError(`模型未能生成有效的${label}，请重试。`, 502)
        }
        return wikiError(`无法生成代码百科${label}，请重试。`, 500)
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
