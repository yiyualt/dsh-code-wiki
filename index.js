import { readFile } from 'node:fs/promises'
import { dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPreview } from './skills/repo-design-wiki/scripts/read-preview.mjs'

export const name = 'dsh-code-wiki'
export const inject = ['connection', 'skills']

const skillName = 'repo-design-wiki'
const skillPath = fileURLToPath(new URL('./skills/repo-design-wiki/SKILL.md', import.meta.url))
const skillDirectory = dirname(skillPath).split(sep).join('/')
const responseHeaders = { 'cache-control': 'no-store' }

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
    path: '/api/dsh-code-wiki/preview',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch({ signal }) {
      try {
        const skill = await ctx.skills.get(skillName, { signal })
        const resource = skill?.resourceBase
        if (resource?.kind !== 'directory') throw new Error('The Wiki Skill must have a local resource directory.')
        const chapters = await readPreview(resource.path, signal)
        return Response.json({ chapters }, { headers: responseHeaders })
      } catch (error) {
        if (signal.aborted) throw error
        return Response.json({ error: '无法读取 Skill 的示例章节。' }, { status: 500, headers: responseHeaders })
      }
    },
  })
}
