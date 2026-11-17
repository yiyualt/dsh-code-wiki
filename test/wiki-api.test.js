import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { apply } from '../index.js'
import { createWikiStorage } from '../src/wiki-storage.js'

const git = promisify(execFile)
const apiRoot = '/api/dsh-code-wiki/'

async function fixture(t, services = {}) {
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
    ...services,
  })
  async function request(path, options) {
    const req = new Request('http://localhost' + apiRoot + path, options)
    const route = routes.get(new URL(req.url).pathname)
    assert.ok(route?.methods.includes(req.method), 'DSH registers this endpoint and method')
    return route.fetch(req)
  }
  return {
    profileDirectory, request,
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

async function initRepository(directory) {
  await mkdir(directory)
  await writeFile(join(directory, 'main.js'), '// entry point\nimport { run } from "./core.js"\nexport const value = run()\n')
  await writeFile(join(directory, 'core.js'), 'export const run = () => 42\n')
  await writeFile(join(directory, 'README.md'), 'Outdated behavior\n')
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)))
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull })
  const runGit = args => git('git', ['-c', `core.hooksPath=${devNull}`, ...args], { cwd: directory, env })
  await runGit(['init', '-q'])
  await runGit(['add', 'main.js', 'core.js', 'README.md'])
  await runGit([
    '-c', 'user.email=wiki-test@example.com', '-c', 'user.name=Wiki Test',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Test fixture',
  ])
}

test('running generation rejects deletion, then deleting its archive also removes completed-job data', async t => {
  const release = Promise.withResolvers()
  const restrictions = []
  const { post, request, profileDirectory } = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }) },
    agents: {
      async create({ setup, signal }) {
        const tools = new Map()
        setup({ tools: {
          restrict: restriction => restrictions.push(restriction),
          register: tool => tools.set(tool.name, tool),
        } })
        let run
        const agent = {
          followup() {
            run = (async () => {
              await release.promise
              signal.throwIfAborted()
              const batch = await tools.get('wiki_read_batch').execute({ ranges: [
                { path: 'main.js', start: 2 }, { path: 'core.js' }, { path: 'README.md' },
              ] }, { signal })
              const { results: [entry, core, readme] } = JSON.parse(batch.data)
              const cite = span => [{ evidence: span.evidence, start: span.start, end: span.end }]
              const point = (text, span) => ({ text, refs: cite(span) })
              const node = (id, span) => ({ id, title: id, summary: id, refs: cite(span) })
              const chapter = (title, points) => ({ title, sections: [{ title, points }] })
              const published = await tools.get('wiki_publish').execute({
                chapters: [
                  chapter('Entry', [point('Uses committed source', entry), point('Reject this obsolete claim', readme)]),
                  chapter('Core', [point('Returns a value', core)]),
                ],
                graph: {
                  layers: [{ title: 'Entry', nodes: [node('entry', entry)] },
                    { title: 'Core', nodes: [node('core', core), node('output', entry)] }],
                  edges: [{ from: 'entry', to: 'core', label: 'Calls', refs: cite(entry) },
                    { from: 'core', to: 'output', label: 'Returns', refs: cite(core) },
                    { from: 'output', to: 'entry', label: 'Obsolete relation', refs: cite(readme) }],
                },
              })
              assert.match(published.status, /已通过校验/)
            })()
          },
          whenIdle: () => run,
          cancel: () => release.resolve(),
        }
        return { agent, dispose: () => run }
      },
    },
  })
  t.after(() => release.resolve())
  const repositoryPath = join(profileDirectory, 'sample')
  await initRepository(repositoryPath)
  // A changed worktree must not become evidence for a Wiki pinned to HEAD.
  await writeFile(join(repositoryPath, 'main.js'), 'Uncommitted replacement\n')

  const accepted = await post('generation', { repositoryPath })
  assert.equal(accepted.status, 202)
  const { job } = await accepted.json()
  assert.equal((await post('documents/delete', { id: job.id })).status, 409)
  const duplicate = await post('generation', { repositoryPath })
  assert.equal(duplicate.status, 409)
  assert.equal((await duplicate.json()).job.id, job.id)

  release.resolve()
  let finished
  const generationPath = 'generation?id=' + job.id
  for (let attempt = 0; attempt < 250; attempt++) {
    finished = (await (await request(generationPath)).json()).job
    if (finished?.phase === 'completed' || finished?.phase === 'failed') break
    await delay(20)
  }
  assert.equal(finished?.phase, 'completed', finished?.error)
  assert.deepEqual(restrictions, [{ allow: [] }])
  assert.equal(finished.result.architecture.edges.length, 2)
  assert.doesNotMatch(finished.result.markdown, /Reject this obsolete claim/)
  const source = new URL(finished.result.architecture.layers[0].nodes[0].refs[0].url)
  const code = await (await request('source' + source.search)).text()
  assert.match(code, /2 \| import \{ run \}/)
  assert.doesNotMatch(code, /Uncommitted replacement/)

  assert.equal((await post('documents/delete', { id: job.id })).status, 204)
  assert.deepEqual(await (await request(generationPath)).json(), { job: null })
  assert.equal((await request('documents?id=' + job.id)).status, 404)
})
