import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openRepository } from '../skills/repo-design-wiki/scripts/read-repository.mjs'

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'code-wiki-folder-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('reads current source from a folder without Git and applies file filters', async t => {
  const directory = await workspace(t)
  const root = join(directory, 'project')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, '.ssh'))
  await writeFile(join(root, 'README.md'), '# Project\r\n')
  await writeFile(join(root, 'src', '入口.js'), 'export const name = "project"\n')
  await writeFile(join(root, '.env.local'), 'VALUE=private')
  await writeFile(join(root, '.ssh', 'notes.md'), 'Private notes')
  await writeFile(join(root, 'private-key.js'), 'Private configuration')
  await writeFile(join(root, 'asset.png'), Buffer.from([0, 1]))

  const repository = await openRepository({ repositoryPath: root })
  assert.equal(repository.label, 'project')
  assert.equal(repository.commit, null)
  assert.equal(repository.treeComplete, true)
  assert.deepEqual(repository.paths, ['README.md', 'src/入口.js'])
  assert.equal(await repository.read('README.md'), '# Project\n')
  assert.equal(await repository.read('src/入口.js'), 'export const name = "project"\n')
  await assert.rejects(async () => repository.read('.ssh/notes.md'), { code: 'invalid-repository-file' })
  await assert.rejects(async () => repository.read('../other.js'), { code: 'invalid-repository-file' })
})

test('opens a Git child folder live and retains commit reads for existing documents', async t => {
  const root = await workspace(t)
  const directory = join(root, 'src')
  await mkdir(directory)
  await writeFile(join(root, 'other.js'), 'export const outside = true\n')
  await writeFile(join(directory, 'tracked.js'), 'export const revision = "committed"\n')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env }).trim()
  git('init', '--quiet', '--template=')
  git('add', 'src/tracked.js', 'other.js')
  git('-c', 'user.name=Wiki Test', '-c', 'user.email=wiki@example.invalid', 'commit', '-qm', 'Snapshot')
  const commit = git('rev-parse', 'HEAD')
  await writeFile(join(directory, 'tracked.js'), 'export const revision = "working tree"\n')
  await writeFile(join(directory, 'untracked.js'), 'export const added = true\n')

  const live = await openRepository({ repositoryPath: directory }, undefined, null)
  assert.equal(live.commit, null)
  assert.deepEqual(live.paths, ['tracked.js', 'untracked.js'])
  assert.equal(await live.read('tracked.js'), 'export const revision = "working tree"\n')
  assert.equal(await live.read('untracked.js'), 'export const added = true\n')

  const saved = await openRepository({ repositoryPath: directory }, undefined, commit)
  assert.equal(saved.commit, commit)
  assert.deepEqual(saved.paths, ['other.js', 'src/tracked.js'])
  assert.equal(await saved.read('src/tracked.js'), 'export const revision = "committed"\n')
})

test('skips symlink files and directories and rejects a path replaced after listing', async t => {
  const directory = await workspace(t)
  const root = join(directory, 'project')
  const outside = join(directory, 'separate')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(outside, 'entry.js'), 'export const outside = true\n')
  await writeFile(join(root, 'src', 'entry.js'), 'export const inside = true\n')
  try {
    await symlink(join(outside, 'entry.js'), join(root, 'linked.js'), 'file')
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('File symlinks require Windows privileges')
    throw error
  }
  await symlink(outside, join(root, 'linked-dir'), 'junction')

  const repository = await openRepository({ repositoryPath: root })
  assert.deepEqual(repository.paths, ['src/entry.js'])
  await rename(join(root, 'src'), join(root, 'previous-src'))
  await symlink(outside, join(root, 'src'), 'junction')
  await assert.rejects(repository.read('src/entry.js'), { code: 'repository-file-unavailable' })
})

test('reports unavailable or empty folders and bounds text reads', async t => {
  const directory = await workspace(t)
  const source = { repositoryPath: directory }
  await assert.rejects(openRepository(source), { code: 'repository-no-evidence', message: /所选目录/ })
  await assert.rejects(openRepository({ repositoryPath: join(directory, 'missing') }), { code: 'local-directory-unavailable' })
  await assert.rejects(openRepository({ repositoryPath: '.' }), { code: 'invalid-local-path' })
  await assert.rejects(openRepository({ repositoryUrl: 'https://github.com/example/repo' }, undefined, null),
    { code: 'invalid-repository-commit' })

  await writeFile(join(directory, 'large.js'), '// first line\n' + 'x'.repeat(128 * 1024))
  await writeFile(join(directory, 'broken.js'), Buffer.from([0xff]))
  const repository = await openRepository(source)
  assert.equal(await repository.read('large.js'), '// first line\n')
  await assert.rejects(repository.read('broken.js'), { code: 'repository-file-unavailable' })

  const canceled = new Error('canceled')
  const signal = AbortSignal.abort(canceled)
  await assert.rejects(openRepository(source, signal), error => error === canceled)
  await assert.rejects(repository.read('large.js', signal), error => error === canceled)
})
