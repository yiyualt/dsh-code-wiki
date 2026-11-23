import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadWikiSkill, registerWikiSkill } from '../src/wiki-skill.js'

const bundled = new URL('../skills/repo-design-wiki/', import.meta.url)
const entry = body => `---\nname: repo-design-wiki\ndescription: Test wiki authoring skill\n---\n\n${body}\n`

async function temporaryHome(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wiki-skill-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'home', 'skills')
  await mkdir(root, { recursive: true })
  return { directory, home: join(directory, 'home'), installed: join(root, 'repo-design-wiki') }
}

test('falls back to the packaged skill and its diagram guide when no local skill exists', async t => {
  const { home } = await temporaryHome(t)
  const [instructions, guide] = await Promise.all([
    readFile(new URL('SKILL.md', bundled), 'utf8'),
    readFile(new URL('references/diagrams.md', bundled), 'utf8'),
  ])
  const skill = await loadWikiSkill(home)
  assert.equal(skill.name, 'repo-design-wiki')
  assert.equal(skill.source, 'bundled')
  assert.equal(skill.content, instructions.split('\n---\n', 2)[1].trim())
  assert.equal(skill.guide, guide.trim())
  assert.deepEqual(await loadWikiSkill(), skill)
})

test('registers the packaged skill with a resource directory and precedence below the user directory', async () => {
  let provider
  const dispose = () => { provider = undefined }
  assert.equal(registerWikiSkill({ registerProvider(create) { provider = create(); return dispose } }), dispose)
  const [candidate] = await provider.list({})
  const definition = await provider.get(candidate, {})
  assert.equal(candidate.name, 'repo-design-wiki')
  assert.equal(candidate.path, fileURLToPath(new URL('SKILL.md', bundled)))
  assert.equal(candidate.rank, 600)
  assert.equal(definition.provider, provider.name)
  assert.deepEqual(definition.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(definition.content, (await loadWikiSkill()).content)
  const guide = await readFile(join(definition.resourceBase.path, 'references', 'diagrams.md'), 'utf8')
  assert.equal(guide.trim(), (await loadWikiSkill()).guide)
  dispose()
  assert.equal(provider, undefined)
  assert.equal(registerWikiSkill(undefined), undefined)
})

test('loads the exact installed skill including its relative guide and follows authorized directory symlinks', async t => {
  const { directory, home, installed } = await temporaryHome(t)
  const target = join(directory, 'shared-skill')
  await mkdir(join(target, 'references'), { recursive: true })
  await writeFile(join(target, 'SKILL.md'), Buffer.from(entry('# Version one').replace(/\n/g, '\r\n')))
  await writeFile(join(target, 'references', 'diagrams.md'), '# Local diagram guide\n')
  await symlink(target, installed, process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual(await loadWikiSkill(home), {
    name: 'repo-design-wiki', content: '# Version one', guide: '# Local diagram guide', source: 'installed',
  })
  await writeFile(join(target, 'SKILL.md'), entry('# Version two').replace('name: repo-design-wiki', 'name: "repo-design-wiki"'))
  assert.equal((await loadWikiSkill(home)).content, '# Version two')
})

test('reports malformed installed skills and missing resources so an edit cannot silently fall back', async t => {
  const { home, installed } = await temporaryHome(t)
  await mkdir(installed)
  const path = join(installed, 'SKILL.md')
  await writeFile(path, entry('# A different skill').replace('name: repo-design-wiki', 'name: another-skill'))
  await assert.rejects(loadWikiSkill(home), { code: 'wiki-skill-invalid', message: /SKILL\.md 需要匹配/ })
  await writeFile(path, entry('# Installed'))
  await assert.rejects(loadWikiSkill(home), { code: 'wiki-skill-invalid', message: /无法读取 references\/diagrams\.md/ })
  await writeFile(path, 'x'.repeat(32 * 1024 + 1))
  await assert.rejects(loadWikiSkill(home), { code: 'wiki-skill-invalid', message: /32 KiB/ })
  await assert.rejects(loadWikiSkill('relative-home'), { code: 'wiki-skill-invalid' })
})

test('does not load skill files once the generation signal has been aborted', async () => {
  const reason = new Error('Generation cancelled')
  await assert.rejects(loadWikiSkill(undefined, AbortSignal.abort(reason)), error => error === reason)
})
