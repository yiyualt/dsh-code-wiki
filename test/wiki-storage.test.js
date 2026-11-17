import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createWikiStorage } from '../src/wiki-storage.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-storage-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'archive')
  return { root, directory, storage: createWikiStorage(directory) }
}

function document(overrides = {}) {
  return {
    id: randomUUID(),
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'github',
    repoUrl: 'https://github.com/example/wiki',
    commit: 'a'.repeat(40),
    markdown: '# Wiki\n\n## Overview\n\nRepository notes.',
    ...overrides,
  }
}

test('archives reopen in date order and history contains only summary fields', async t => {
  const { directory, storage } = await fixture(t)
  assert.deepEqual(await storage.list(), [])
  const old = document()
  const recent = document({
    createdAt: '2026-02-01T00:00:00.000Z',
    source: 'local',
    repositoryPath: directory,
    repoName: 'demo',
    durationMs: 3100,
    architecture: { layers: [], edges: [] },
    files: [{ path: 'src/main.js', text: 'export const answer = 42', startLine: 18 }],
  })
  await storage.save(recent)
  await storage.save(old)

  const reopened = createWikiStorage(directory)
  assert.deepEqual(await reopened.get(old.id), old)
  const { repoUrl, ...localRecord } = recent
  assert.deepEqual(await reopened.get(recent.id), localRecord)
  assert.deepEqual(await reopened.list(), [
    { id: recent.id, createdAt: recent.createdAt, source: 'local', commit: recent.commit, repositoryPath: directory, repoName: 'demo' },
    { id: old.id, createdAt: old.createdAt, source: 'github', commit: old.commit, repoUrl },
  ])
})

test('concurrent saves for the same ID publish a single complete archive', async t => {
  const { directory, storage } = await fixture(t)
  const original = document()
  const replacement = { ...original, markdown: '# Replacement' }
  const saves = await Promise.allSettled([storage.save(original), storage.save(replacement)])
  assert.equal(saves.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(saves.find(result => result.status === 'rejected').reason.code, 'EEXIST')
  const winner = saves.find(result => result.status === 'fulfilled').value
  assert.deepEqual(await storage.get(original.id), winner)
  assert.deepEqual(await readdir(directory), [original.id + '.json'])
})

test('invalid IDs cannot remove files outside the archive and retries are safe', async t => {
  const { root, directory, storage } = await fixture(t)
  const keep = document()
  const remove = document()
  const outside = join(root, 'outside.json')
  await writeFile(outside, 'outside the archive')
  await storage.save(keep)
  await storage.save(remove)
  await writeFile(join(directory, randomUUID() + '.json'), '{ malformed')

  assert.equal(await storage.remove('../outside'), false)
  assert.equal(await readFile(outside, 'utf8'), 'outside the archive')
  assert.equal(await storage.remove(remove.id), true)
  assert.equal(await storage.remove(remove.id), true)
  assert.equal(await storage.get(remove.id), undefined)
  assert.deepEqual((await storage.list()).map(item => item.id), [keep.id])
})
