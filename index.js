import { readFile } from 'node:fs/promises'
import { dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateOutline } from './skills/repo-design-wiki/scripts/generate-outline.mjs'
import { openRepository } from './skills/repo-design-wiki/scripts/read-repository.mjs'
import { openWikiAuthor } from './src/wiki-author.js'

export const name = 'dsh-code-wiki'
export const inject = ['connection', 'skills', 'agents', 'agentDefaultModel']

const skillName = 'repo-design-wiki'
const skillPath = fileURLToPath(new URL('./skills/repo-design-wiki/SKILL.md', import.meta.url))
const skillDirectory = dirname(skillPath).split(sep).join('/')
const responseHeaders = { 'cache-control': 'no-store' }
const sourceErrors = new Map([
  ['invalid-repository-source', 400], ['invalid-repository-url', 400], ['invalid-local-path', 400],
  ['repository-unavailable', 404], ['repository-no-evidence', 422],
  ['github-rate-limited', 429], ['github-request-failed', 502],
])

function outlineError(message, status) {
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

  ctx.connection.fetch.register({
    path: '/api/dsh-code-wiki/outline',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const input = await request.json().catch(() => null)
      const deadline = AbortSignal.timeout(180_000)
      const signal = AbortSignal.any([request.signal, deadline])
      try {
        const skill = await ctx.skills.get(skillName, { signal })
        if (!skill?.content) return outlineError('无法读取代码百科 Skill。', 500)
        const repository = await openRepository(input, signal)
        const outline = await generateOutline({
          repository, instructions: skill.content, signal,
          openAuthor: options => openWikiAuthor(ctx, options),
        })
        return Response.json(outline, { headers: responseHeaders })
      } catch (error) {
        if (request.signal.aborted) throw error
        if (deadline.aborted) return outlineError('生成目录超时，请重试。', 504)
        const sourceStatus = sourceErrors.get(error?.code)
        if (sourceStatus) return outlineError(error.message, sourceStatus)
        if (error?.code === 'wiki-model-unavailable') return outlineError('暂时无法使用 DSH 当前模型。', 502)
        if (error?.code === 'wiki-outline-invalid') return outlineError('模型未能生成有效的目录，请重试。', 502)
        return outlineError('无法生成代码百科目录，请重试。', 500)
      }
    },
  })
}
