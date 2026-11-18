import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { apply } from '../index.js'
import { createWikiStorage } from '../src/wiki-storage.js'

const git = promisify(execFile)
const apiRoot = '/api/dsh-code-wiki/'

async function fixture(t, services = {}, config) {
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
  }, config)
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
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
  const runGit = args => git('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, env })
  await runGit(['init', '-q'])
  await runGit(['add', 'main.js', 'core.js', 'README.md'])
  await runGit([
    '-c', 'user.email=wiki-test@example.com', '-c', 'user.name=Wiki Test',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Test fixture',
  ])
}

async function publishingAgent({ setup, signal }, release, restrictions = []) {
  const tools = new Map()
  setup({ tools: {
    restrict: restriction => restrictions.push(restriction),
    register: tool => tools.set(tool.name, tool),
  } })
  let run
  const agent = {
    followup() {
      run = (async () => {
        await release?.promise
        signal.throwIfAborted()
        const batch = await tools.get('wiki_read_batch').execute({ ranges: [
          { path: 'main.js', start: 2 }, { path: 'core.js' }, { path: 'README.md' },
        ] }, { signal })
        const { results: [entry, core, readme] } = JSON.parse(batch.data)
        const cite = span => [{ evidence: span.evidence, start: span.start, end: span.end }]
        const point = (text, span) => ({ text, refs: cite(span) })
        const node = (id, span) => ({ id, title: id, summary: id,
          ...(id === 'entry' && { technology: 'JavaScript', boundary: '进程内模块' }), refs: cite(span) })
        const chapter = (title, points) => ({ title, sections: [{ title, points }] })
        const published = await tools.get('wiki_publish').execute({
          chapters: [
            chapter('Entry', [point('Uses committed source', entry), point('Reject this obsolete claim', readme)]),
            chapter('Core', [point('Returns a value', core)]),
          ],
          graph: {
            layers: [{ title: 'Entry', nodes: [node('entry', entry)] },
              { title: 'Core', nodes: [node('core', core), node('output', entry), node('third', core),
                node('fourth', core), node('fifth', core)] }],
            edges: [{ from: 'entry', to: 'core', label: 'Calls', refs: cite(entry) },
              { from: 'core', to: 'fifth', label: 'Returns', refs: cite(core) },
              { from: 'output', to: 'entry', label: 'Obsolete relation', refs: cite(readme) }],
          },
        })
        assert.match(published.status, /已通过校验/)
      })()
    },
    whenIdle: () => run,
    cancel: () => release?.resolve(),
  }
  return { agent, dispose: () => run }
}

test('running generation rejects deletion, then deleting its archive also removes completed-job data', async t => {
  const release = Promise.withResolvers()
  const restrictions = []
  const { post, request, profileDirectory } = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }) },
    agents: {
      create: options => publishingAgent(options, release, restrictions),
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
  assert.equal(finished.result.architecture.layers[1].nodes.length, 5)
  assert.equal(finished.result.architecture.edges[1].to, 'fifth')
  assert.match(finished.result.markdown, /\| fifth \|/)
  assert.equal(finished.result.architecture.layers[0].nodes[0].technology, 'JavaScript')
  assert.match(finished.result.markdown, /## Entry[\s\S]*## 技术沙盘[\s\S]*## Core/)
  assert.match(finished.result.markdown, /\| entry \| entry \| JavaScript \| 进程内模块 \|/)
  assert.match(finished.result.markdown, /\| core \| core \| 未确认 \| 未确认 \|/)
  assert.doesNotMatch(finished.result.markdown, /Reject this obsolete claim/)
  const source = new URL(finished.result.architecture.layers[0].nodes[0].refs[0].url)
  const code = await (await request('source' + source.search)).text()
  assert.match(code, /2 \| import \{ run \}/)
  assert.doesNotMatch(code, /Uncommitted replacement/)

  assert.equal((await post('documents/delete', { id: job.id })).status, 204)
  assert.deepEqual(await (await request(generationPath)).json(), { job: null })
  assert.equal((await request('documents?id=' + job.id)).status, 404)
})

async function generateDocument(api, repositoryPath) {
  const accepted = await api.post('generation', { repositoryPath })
  assert.equal(accepted.status, 202)
  const { job } = await accepted.json()
  for (let attempt = 0; attempt < 250; attempt++) {
    const current = (await (await api.request('generation?id=' + job.id)).json()).job
    if (current.phase === 'completed' || current.phase === 'failed') return current
    await delay(20)
  }
  assert.fail('Generation did not finish')
}

test('a fresh installation follows the current DSH provider, model and reasoning setting on each generation', async t => {
  let selection = { provider: 'dsh-provider', model: 'dsh-model', reasoningEffort: 'medium' }
  const calls = []
  const api = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ ...selection }) },
    llm: { registerAdapter() { assert.fail('A default installation must use the DSH adapter') } },
    agents: { create(options) {
      calls.push(options.agentOptions)
      return publishingAgent(options)
    } },
  })
  const repositoryPath = join(api.profileDirectory, 'sample')
  await initRepository(repositoryPath)
  const first = await generateDocument(api, repositoryPath)
  assert.equal(first.phase, 'completed', first.error)
  assert.equal(first.result.model, selection.model)
  assert.deepEqual(calls[0], { ...selection, maxTokens: 9000 })

  selection = { provider: 'another-provider', model: 'another-model', reasoningEffort: 'high' }
  const second = await generateDocument(api, repositoryPath)
  assert.equal(second.phase, 'completed', second.error)
  assert.equal(second.result.model, selection.model)
  assert.deepEqual(calls[1], { ...selection, maxTokens: 9000 })
})

test('a local model override takes precedence over DSH and reports configuration failures', async t => {
  const config = {}
  const adapters = new Map()
  let registrations = 0
  const api = await fixture(t, {
    agentDefaultModel: { currentSelection() { assert.fail('An explicit local override takes precedence') } },
    llm: { registerAdapter([provider], adapter) {
      registrations++
      adapters.set(provider, adapter)
      return () => adapters.delete(provider)
    } },
    agents: { create(options) {
      const { provider, model } = options.agentOptions
      assert.match(provider, /^code-wiki-/)
      assert.equal(model, 'personal-gpt')
      assert.equal(adapters.get(provider)?.model, model)
      return publishingAgent(options)
    } },
  }, config)
  config.modelConfigFile = join(api.profileDirectory, 'personal-model.json')
  await writeFile(config.modelConfigFile, JSON.stringify({ judge: {
    url: 'https://example.invalid/v1/chat/completions', model: 'personal-gpt', api_key: 'test-only-key',
  } }))
  const repositoryPath = join(api.profileDirectory, 'sample')
  await initRepository(repositoryPath)
  const result = await generateDocument(api, repositoryPath)
  assert.equal(result.phase, 'completed', result.error)
  assert.equal(result.result.model, 'personal-gpt')
  assert.equal(registrations, 1)
  assert.equal(adapters.size, 0)

  await rm(config.modelConfigFile)
  const failed = await generateDocument(api, repositoryPath)
  assert.equal(failed.phase, 'failed')
  assert.match(failed.error, /无法读取本地模型配置/)
  assert.equal(registrations, 1)
})
