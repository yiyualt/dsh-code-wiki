import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWikiCheckpoints } from '../src/wiki-checkpoint.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-checkpoint-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'checkpoints')
  return { root, directory, store: createWikiCheckpoints(directory), id: randomUUID() }
}
const evidence = (path = 'src/main.js') => ({ path, start: 7, end: 8, text: 'const actual = true;\nrun(actual);', primary: true, kind: 'source' })
const payload = () => ({ version: 1, repositoryUrl: 'https://github.com/example/repo', commit: 'a'.repeat(40),
  plan: { title: 'Accepted research plan' }, draft: { title: 'Accepted draft' }, evidence: [evidence()] })

test('accepted checkpoints reopen, overwrite atomically and use private directory and file permissions', async t => {
  const { directory, store, id } = await fixture(t)
  await mkdir(directory, { mode: 0o755 })
  await chmod(directory, 0o755)
  const first = payload()
  await store.save(id, first)
  assert.deepEqual(await createWikiCheckpoints(directory).get(id), first)
  const updated = { ...first, draft: { title: 'Revised accepted draft' } }
  await store.save(id, updated)
  assert.deepEqual(await store.get(id), updated)
  assert.deepEqual(await readdir(directory), [id + '.json'])
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(join(directory, id + '.json'))).mode & 0o777, 0o600)
  }
  const local = { ...payload(), repositoryPath: directory, commit: 'b'.repeat(64) }
  delete local.repositoryUrl
  await store.save(id, local)
  assert.deepEqual(await store.get(id), local)
})

test('invalid IDs cannot save, read or remove anything outside the checkpoint directory', async t => {
  const { root, store, id } = await fixture(t)
  const outside = join(root, 'outside.json')
  await writeFile(outside, 'keep')
  for (const bad of [undefined, null, '', '../outside', id + '/../../outside', 'not-a-uuid']) {
    await assert.rejects(store.save(bad, payload()), /checkpoint ID/)
    assert.equal(await store.get(bad), null)
    assert.equal(await store.remove(bad), false)
  }
  assert.equal(await readFile(outside, 'utf8'), 'keep')
  assert.equal(await store.get(id), null)
  assert.equal(await store.remove(id), true)
  await store.save(id, payload())
  assert.equal(await store.remove(id), true)
  assert.equal(await store.get(id), null)
  assert.equal(await store.remove(id), true)
})

test('research-only checkpoints reopen without a draft and later retain the accepted raw draft', async t => {
  const { directory, store, id } = await fixture(t)
  const research = payload()
  delete research.draft
  await store.save(id, research)
  assert.deepEqual(await createWikiCheckpoints(directory).get(id), research)
  assert.equal(Object.hasOwn(await store.get(id), 'draft'), false)
  for (const draft of [null, [], '', 0, false]) {
    await assert.rejects(store.save(id, { ...research, draft }), /checkpoint payload/)
    assert.deepEqual(await store.get(id), research)
  }
  const accepted = { ...research, draft: { title: 'Structure-checked draft' } }
  await store.save(id, accepted)
  assert.deepEqual(await store.get(id), accepted)
})

test('payload validation enforces the bounded recovery contract without replacing a good checkpoint', async t => {
  const { directory, store, id } = await fixture(t)
  const good = payload()
  await store.save(id, good)
  const invalid = [
    { ...good, version: 2 }, { ...good, commit: 'HEAD' }, { ...good, plan: [] }, { ...good, draft: null },
    { ...good, evidence: 'not evidence' }, { ...good, repositoryPath: directory },
    { ...good, repositoryUrl: 'https://example.test/repo' }, { ...good, apiKey: 'must-not-persist' },
    { ...good, evidence: [{ ...evidence(), start: 0 }] },
    { ...good, evidence: [{ ...evidence(), primary: 'true' }] },
    { ...good, evidence: [{ ...evidence(), text: 1 }] },
    { ...good, evidence: [{ ...evidence(), path: '../outside.js' }] },
    { ...good, evidence: [{ ...evidence(), kind: 'invented' }] },
    { ...good, evidence: Array.from({ length: 241 }, () => evidence()) },
    { ...good, evidence: Array.from({ length: 91 }, (_, i) => evidence('src/file-' + i + '.js')) },
  ]
  const missing = { ...good }; delete missing.repositoryUrl; invalid.push(missing)
  for (const bad of invalid) {
    await assert.rejects(store.save(id, bad), /checkpoint payload/)
    assert.deepEqual(await store.get(id), good)
  }
  const maximum = { ...good, evidence: Array.from({ length: 240 }, (_, i) => evidence('src/file-' + (i % 90) + '.js')) }
  await store.save(id, maximum)
  assert.deepEqual(await store.get(id), maximum)
})

test('oversize JSON is rejected on save and get, while malformed or unsupported files are not recovered', async t => {
  const { directory, store, id } = await fixture(t)
  const good = payload()
  await store.save(id, good)
  await assert.rejects(store.save(id, { ...good, draft: { text: 'x'.repeat(8 * 1024 * 1024) } }), /8 MiB/)
  assert.deepEqual(await store.get(id), good)
  assert.deepEqual(await readdir(directory), [id + '.json'])
  const path = join(directory, id + '.json')
  for (const value of ['{ malformed', JSON.stringify({ ...good, version: 2 }), Buffer.from([0xff, 0xfe])]) {
    await writeFile(path, value)
    assert.equal(await store.get(id), null)
  }
  await writeFile(path, ' '.repeat(8 * 1024 * 1024 + 1))
  assert.equal(await store.get(id), null)
})

test('symlinks and directories cannot be recovered, and saving replaces a symlink without changing its target', async t => {
  const { root, directory, store, id } = await fixture(t)
  await mkdir(directory)
  const directoryId = randomUUID()
  await mkdir(join(directory, directoryId + '.json'))
  assert.equal(await store.get(directoryId), null)
  const outside = join(root, 'outside.json')
  const original = JSON.stringify(payload())
  await writeFile(outside, original)
  try { await symlink(outside, join(directory, id + '.json'), 'file') }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.diagnostic('This Windows account cannot create symlinks; directory rejection was verified.')
      return
    }
    throw error
  }
  assert.equal(await store.get(id), null)
  await store.save(id, payload())
  assert.deepEqual(await store.get(id), payload())
  assert.equal(await readFile(outside, 'utf8'), original)
})

test('concurrent checkpoint replacements never publish partial JSON or leave temporary files', async t => {
  const { directory, store, id } = await fixture(t)
  const first = { ...payload(), draft: { revision: 'A', content: 'A'.repeat(32_000) } }
  const second = { ...payload(), draft: { revision: 'B', content: 'B'.repeat(32_000) } }
  await store.save(id, first)
  const observations = (async () => {
    for (let i = 0; i < 30; i++) {
      const value = JSON.parse(await readFile(join(directory, id + '.json'), 'utf8'))
      assert.equal(value.draft.content, value.draft.revision.repeat(32_000))
    }
  })()
  await Promise.all([observations, ...Array.from({ length: 12 }, (_, i) => store.save(id, i % 2 ? first : second))])
  const final = await store.get(id)
  assert.equal(final.draft.content, final.draft.revision.repeat(32_000))
  assert.deepEqual(await readdir(directory), [id + '.json'])
})

test('a failed atomic publication keeps the accepted checkpoint and cleans its temporary file', async t => {
  const { directory, store, id } = await fixture(t)
  const good = payload()
  await store.save(id, good)
  const rename = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('fixture write failure'), { code: 'EIO' }) })
  syncBuiltinESMExports()
  try { await assert.rejects(store.save(id, { ...good, draft: { title: 'New draft' } }), error => error.code === 'EIO') }
  finally { rename.mock.restore(); syncBuiltinESMExports() }
  assert.deepEqual(await store.get(id), good)
  assert.deepEqual(await readdir(directory), [id + '.json'])
})
