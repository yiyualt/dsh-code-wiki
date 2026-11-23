import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'
import { createWikiStorage } from '../src/wiki-storage.js'

const apiRoot = '/api/dsh-code-wiki/'

async function fixture(t) {
  const profileDirectory = await mkdtemp(join(tmpdir(), 'dsh-wiki-api-test-'))
  const routes = new Map()
  const cleanup = []
  t.after(async () => {
    for (const dispose of cleanup) dispose()
    await rm(profileDirectory, { recursive: true, force: true })
  })
  apply({
    profileContext: { dir: profileDirectory },
    connection: { fetch: { register(route) { routes.set(route.path, route) } } },
    effect(install) { cleanup.push(install()) },
  })
  async function request(path, options) {
    const req = new Request('http://localhost' + apiRoot + path, options)
    const route = routes.get(new URL(req.url).pathname)
    assert.ok(route?.methods.includes(req.method), 'DSH registers this endpoint and method')
    return route.fetch(req)
  }
  return {
    request,
    post: (path, data) => request(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    }),
    storage: createWikiStorage(join(profileDirectory, 'dsh-code-wiki', 'documents')),
  }
}

test('deleting a saved Wiki removes it from history, document reads and local source lookups', async t => {
  const { post, request, storage } = await fixture(t)
  const record = {
    id: randomUUID(), createdAt: '2026-01-01T00:00:00.000Z',
    source: 'local', repositoryPath: tmpdir(), repoName: 'fixture', commit: 'b'.repeat(40),
    markdown: '# Wiki\n\n## 入口',
    files: [{ path: 'src/main.js', text: 'export function main() {\n  return 42\n}', startLine: 24 }],
  }
  const keep = { ...record, id: randomUUID() }
  await storage.save(record)
  await storage.save(keep)
  const documentPath = 'documents?id=' + record.id
  const sourcePath = 'source?key=' + record.id + '&file=1&start=25&end=25'
  const existing = await (await request(documentPath)).json()
  assert.equal(existing.markdown, record.markdown)
  assert.equal('files' in existing, false)
  assert.match(await (await request(sourcePath)).text(), /25 \|   return 42/)
  assert.equal((await request(sourcePath.replace('start=25', 'start=1'))).status, 404)

  assert.equal((await post('documents/delete', { id: record.id })).status, 204)
  assert.equal((await request(documentPath)).status, 404)
  assert.equal((await request(sourcePath)).status, 404)
  assert.deepEqual((await (await request('documents')).json()).documents.map(doc => doc.id), [keep.id])
  assert.equal((await post('documents/delete', { id: record.id })).status, 204)
})

test('deletion rejects malformed IDs, bodies, and content types', async t => {
  const { post, request } = await fixture(t)
  assert.equal((await post('documents/delete', { id: '../other-archive' })).status, 400)
  assert.equal((await post('documents/delete', {})).status, 400)
  assert.equal((await request('documents/delete', { method: 'POST', body: 'plain text' })).status, 415)
  assert.equal((await request('documents/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
  })).status, 400)
})

test('Wiki generation is unavailable while the saved document API remains active', async t => {
  const { post, request } = await fixture(t)
  assert.deepEqual(await (await request('generation')).json(), { job: null })
  for (const route of ['generate', 'generation']) {
    const response = await post(route, { repositoryPath: tmpdir() })
    assert.equal(response.status, 410)
    assert.equal((await response.json()).error, 'Wiki 生成暂不可用。')
  }
})
