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
import { wikiDraftFixture, wikiModuleCaseFixture, wikiPlanFixture, withWikiModuleCases,
  withChapterDiagramPlan, withChapterDiagrams } from '../fixtures/wiki-editorial.js'
import { createWikiStorage } from '../src/wiki-storage.js'
import { createWikiCheckpoints } from '../src/wiki-checkpoint.js'

const git = promisify(execFile)
const apiRoot = '/api/dsh-code-wiki/'

const approvedReviews = {
  async *stream() {
    yield { type: 'text-delta', text: JSON.stringify({ approved: true, issues: [] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

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
    llm: approvedReviews,
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
    shutdown() { for (const dispose of cleanup) dispose() },
    post: (path, data) => request(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    }),
    storage: createWikiStorage(join(profileDirectory, 'dsh-code-wiki', 'documents')),
  }
}

function virtualWikiClock(t) {
  let now = Date.now()
  const intervals = new Map(), deadlines = [], logs = []
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setInterval', (callback, milliseconds) => {
    const handle = { unref() {} }
    intervals.set(handle, { callback, milliseconds })
    return handle
  })
  t.mock.method(globalThis, 'clearInterval', handle => intervals.delete(handle))
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController()
    deadlines.push({ at: now + milliseconds, controller })
    return controller.signal
  })
  t.mock.method(console, 'info', line => {
    if (line.startsWith('[dsh-code-wiki:wiki] ')) logs.push(JSON.parse(line.slice('[dsh-code-wiki:wiki] '.length)))
  })
  return { intervals, logs, advance(milliseconds) {
    now += milliseconds
    for (const { at, controller } of deadlines) {
      if (at <= now && !controller.signal.aborted) controller.abort(new DOMException('Virtual timeout', 'TimeoutError'))
    }
    for (const { callback } of intervals.values()) callback()
  } }
}

function heldWikiReview() {
  const started = Promise.withResolvers(), signals = []
  return { started, signals, llm: { async *stream({ signal }) {
    signals.push(signal)
    if (signals.length === 2) started.resolve()
    await new Promise((_resolve, reject) => {
      signal.throwIfAborted()
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    assert.fail('held reviews must end through explicit cancellation')
  } } }
}

async function settledJob(api, id) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const { job } = await (await api.request('generation?id=' + id)).json()
    if (job.phase === 'completed' || job.phase === 'failed') return job
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Wiki did not settle after explicit cancellation')
}

test('background Wiki remains active beyond an hour and retains its checkpoint when the service shuts down', async t => {
  const clock = virtualWikiClock(t)
  const acceptedDraft = Promise.withResolvers(), finishWriter = Promise.withResolvers()
  t.after(() => finishWriter.resolve())
  let writerSignal
  const api = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    agents: { async create(options) {
      writerSignal = options.signal
      const handle = await publishingAgent({ ...options, setup(context) {
        options.setup({ tools: { ...context.tools, register(tool) {
          if (tool.name !== 'wiki_publish') return context.tools.register(tool)
          context.tools.register({ ...tool, async execute(args) {
            const result = await tool.execute(args)
            if (args.kind === 'draft' && result.status.includes('草稿已收到')) {
              acceptedDraft.resolve()
              await finishWriter.promise
            }
            return result
          } })
        } } })
      } })
      return { ...handle, agent: { ...handle.agent, cancel: () => finishWriter.resolve() } }
    } },
  })
  const repositoryPath = join(api.profileDirectory, 'sample')
  await initRepository(repositoryPath)
  const connection = new AbortController()
  const accepted = await api.request('generation', { method: 'POST', signal: connection.signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repositoryPath }) })
  assert.equal(accepted.status, 202)
  const { job: initial } = await accepted.json()
  connection.abort()
  await acceptedDraft.promise
  assert.equal(writerSignal.aborted, false, 'the background task outlives its initiating HTTP connection')
  assert.equal(clock.intervals.size, 1)
  assert.equal([...clock.intervals.values()][0].milliseconds, 30_000)
  for (const minutes of [31, 62]) {
    clock.advance(31 * 60_000)
    assert.equal(writerSignal.aborted, false, 'advancing the old total deadline must not cancel the Wiki')
    const { job } = await (await api.request('generation?id=' + initial.id)).json()
    assert.equal(job.phase, 'writing')
    assert.equal(job.step, 'agent-finishing')
    assert.equal(job.elapsedMs, minutes * 60_000)
    assert.equal(job.phaseElapsedMs, minutes * 60_000)
    assert.equal(job.stepElapsedMs, minutes * 60_000)
    assert.equal(job.canResume, true)
    assert.equal(clock.logs.at(-1).event, 'heartbeat')
    assert.equal(clock.logs.at(-1).elapsedMs, minutes * 60_000)
    assert.equal(clock.logs.at(-1).timeoutMs, null)
    assert.equal(clock.intervals.size, 1)
  }
  api.shutdown()
  const cancelled = await settledJob(api, initial.id)
  assert.equal(cancelled.phase, 'failed')
  assert.equal(cancelled.error, '生成已取消。')
  assert(writerSignal.aborted)
  assert.equal(clock.intervals.size, 0)
  assert.equal(clock.logs.at(-1).event, 'finish')
  assert.equal(clock.logs.at(-1).reason, 'cancelled')
  assert(clock.logs.every(log => log.timeoutMs === null), 'diagnostics must not advertise a Wiki total deadline')
  assert.deepEqual(await (await api.request('generation')).json(), { job: null })
  const checkpoint = await createWikiCheckpoints(join(api.profileDirectory, 'dsh-code-wiki-checkpoints')).get(initial.id)
  assert(checkpoint.plan && checkpoint.draft)
  assert.equal(checkpoint.evidence.length, 3)
  assert.deepEqual(await api.storage.list(), [])
  const count = clock.logs.length
  clock.advance(31 * 60_000)
  assert.equal(clock.logs.length, count, 'shutdown releases the heartbeat rather than leaving a stale live job')
})

test('disconnecting a synchronous Wiki request still cancels generation and releases its heartbeat', async t => {
  const clock = virtualWikiClock(t), held = heldWikiReview()
  const api = await fixture(t, {
    llm: held.llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    agents: { create: options => publishingAgent(options) },
  })
  const repositoryPath = join(api.profileDirectory, 'sample')
  await initRepository(repositoryPath)
  const connection = new AbortController()
  const pending = api.request('generate', { method: 'POST', signal: connection.signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repositoryPath }) })
  await held.started.promise
  const { job } = await (await api.request('generation')).json()
  assert.equal(job.phase, 'reviewing')
  connection.abort()
  const cancelled = await pending
  assert.equal(cancelled.status, 503)
  assert.equal((await cancelled.json()).error, '生成已取消。')
  assert(held.signals.every(signal => signal.aborted))
  assert.equal(clock.intervals.size, 0)
  assert.equal(clock.logs.at(-1).reason, 'cancelled')
  assert(clock.logs.every(log => log.timeoutMs === null))
  const checkpoint = await createWikiCheckpoints(join(api.profileDirectory, 'dsh-code-wiki-checkpoints')).get(job.id)
  assert(checkpoint.plan && checkpoint.draft)
  const retry = (await (await api.request('generation')).json()).job
  assert.equal(retry.id, job.id)
  assert.equal(retry.phase, 'failed')
  assert.equal(retry.canResume, true)
  assert.deepEqual(await api.storage.list(), [])
})

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

test('a pinned revision requires a full GitHub commit and is rejected before any generation starts', async t => {
  const { post, request } = await fixture(t, {
    agents: { create() { assert.fail('Invalid pinned requests must not start research') } },
  })
  for (const body of [
    { repositoryUrl: 'https://github.com/example/repo', commit: 'main' },
    { repositoryUrl: 'https://github.com/example/repo', commit: 'a'.repeat(39) },
    { repositoryPath: tmpdir(), commit: 'a'.repeat(40) },
  ]) assert.equal((await post('generation', body)).status, 400)
  assert.equal((await post('generate', { repositoryUrl: 'https://github.com/example/repo', commit: 'main' })).status, 400)
  assert.deepEqual(await (await request('generation')).json(), { job: null })
})

async function initRepository(directory) {
  await mkdir(directory)
  await writeFile(join(directory, 'main.js'), '// entry point\nimport { run } from "./core.js"\nexport const value = run()\n')
  await writeFile(join(directory, 'core.js'), 'export const run = () => 42\n')
  await writeFile(join(directory, 'README.md'), 'A small command runner.\n')
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
        const planned = await tools.get('wiki_publish').execute({ kind: 'plan', plan: withChapterDiagramPlan({
          audience: 'Developers inspecting this runner', goal: 'Understand the committed entry and returned value',
          walkthrough: { title: 'Load the runner', question: 'How does importing main.js produce value?' },
          views: [], viewOmission: 'The existing overall component diagram fully explains this small example.',
          modules: [{ id: 'entry', name: 'Entry', responsibility: 'Passes the call to core.', entry: 'main.js', paths: ['main.js'] },
            { id: 'core', name: 'Core', responsibility: 'Returns a value.', entry: 'core.js', paths: ['core.js'] }],
          chapters: [{ id: 'overview', title: 'Overview', role: 'overview', question: 'What does the project do?' },
            { id: 'architecture', title: 'Architecture', role: 'architecture', question: 'How is the code split?' },
            { id: 'entry', title: 'Entry', role: 'module', module: 'entry', question: 'What runs?' },
            { id: 'core', title: 'Core', role: 'module', module: 'core', question: 'What is returned?' }],
          research: [{ id: 'purpose', question: 'What does the project claim to do?', evidenceType: 'documentation', paths: ['README.md'] },
            { id: 'behavior', question: 'How does the entry invoke the implementation?', evidenceType: 'implementation', paths: ['main.js', 'core.js'] }],
        }) })
        assert.match(planned.status, /研究计划已接受/)
        const paragraph = (id, text, span, claimType = 'implementation') => ({ id, type: 'paragraph', claimType, text, refs: cite(span) })
        const table = (id, span, claimType = 'implementation') => ({ id, type: 'table', claimType, columns: ['Symbol', 'Role'],
          rows: [['run', 'Returns a value']], refs: cite(span) })
        const node = (id, kind, span) => ({ id, title: id, kind, summary: id, technology: 'JavaScript', boundary: '进程内模块', refs: cite(span) })
        const published = await tools.get('wiki_publish').execute({ kind: 'draft', draft: withChapterDiagrams({
          chapters: [
            { id: 'overview', title: 'Overview', blocks: [paragraph('purpose', 'A small command runner.', readme, 'purpose'), table('layout', readme, 'usage')] },
            { id: 'architecture', title: 'Architecture', blocks: [paragraph('architecture', 'The entry hands the call to core.', entry)] },
            { id: 'entry', title: 'Entry', blocks: [paragraph('entry-call', 'Uses committed source to call run.', entry), table('entry-table', entry),
              wikiModuleCaseFixture('entry', entry, core)] },
            { id: 'core', title: 'Core', blocks: [paragraph('core-return', 'Returns a value.', core), table('core-table', core),
              { id: 'core-code', type: 'code', claimType: 'implementation', caption: 'The committed implementation.', refs: cite(core) },
              wikiModuleCaseFixture('core', entry, core)] },
          ],
          coverage: [{ area: 'purpose', refs: cite(readme) }, { area: 'behavior', refs: [...cite(entry), ...cite(core)] }],
          graph: {
            layers: [{ title: 'Entry', nodes: [node('entry', 'entry', entry)] },
              { title: 'Core', nodes: [node('core', 'core', core), node('value', 'data', core)] }],
            edges: [{ from: 'entry', to: 'core', kind: 'call', label: 'Calls', refs: cite(entry) },
              { from: 'core', to: 'value', kind: 'data', label: 'Returns', refs: cite(core) }],
          },
          walkthrough: {
            title: 'Load the runner',
            objective: 'Follow main.js from import to the exported value.',
            modules: [
              { node: 'entry', chapter: 'entry', entry: 'main.js', change: 'Edit how value is exported.', refs: cite(entry) },
              { node: 'core', chapter: 'core', entry: 'core.js', change: 'Edit what run returns.', refs: cite(core) },
            ],
            steps: [
              { id: 'load', module: 'entry', title: 'Import the entry', action: 'Load main.js.', outcome: 'The entry imports run.',
                refs: cite(entry), data: { title: 'Module request', columns: ['File', 'Import'], rows: [['main.js', 'run']], refs: cite(entry) } },
              { id: 'call', module: 'core', title: 'Run the implementation', action: 'Call run.', outcome: 'It returns 42.',
                refs: cite(core), data: { title: 'Return', columns: ['Function', 'Number'], rows: [['run', '42']], refs: cite(core) } },
              { id: 'export', module: 'entry', title: 'Export value', action: 'Assign the return value to value.', outcome: 'The import can read value.',
                refs: cite(entry), data: { title: 'Export', columns: ['Name', 'Number'], rows: [['value', '42']], refs: cite(entry) } },
            ],
            tasks: [
              { kind: 'feature', title: 'Change the returned value', summary: 'Update run and assert the exported number.', steps: ['call', 'export'], refs: cite(core) },
              { kind: 'debug', title: 'Trace an unexpected export', summary: 'Compare the return from run with the assigned value.', steps: ['export', 'call'], refs: cite(entry) },
            ],
          },
        }, { docs: readme, entry, core }) })
        assert.match(published.status, /草稿已收到/)

      })()
    },
    whenIdle: () => run,
    cancel: () => release?.resolve(),
  }
  return { agent, dispose: () => run }
}

test('a model review error saves a valid Wiki with an unavailable review status', async t => {
  const api = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    agents: { create: options => publishingAgent(options) },
    llm: { async *stream() { throw Object.assign(new Error('private fixture error'), { code: 'AUTH' }) } },
  })
  const repositoryPath = join(api.profileDirectory, 'sample')
  await initRepository(repositoryPath)
  const response = await api.post('generate', { repositoryPath })
  assert.equal(response.status, 200)
  const document = await response.json()
  assert.deepEqual(document.review, { status: 'unavailable' })
  assert.equal((await api.storage.get(document.id)).review.status, 'unavailable')
  assert.equal((await (await api.request('generation?id=' + document.id)).json()).job.phase, 'completed')
})

test('resuming a matching valid draft saves review findings without another writing turn', async t => {
  const reason = '请核对这一段的项目用途。'
  let reviews = 0
  const api = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    llm: { async *stream({ system }) {
      reviews++
      const result = system.includes('事实审核员')
        ? { approved: false, issues: [{ target: 'purpose_text', reason, reads: [] }] }
        : { approved: true, issues: [] }
      yield { type: 'text-delta', text: JSON.stringify(result) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
    agents: { async create() { assert.fail('A validated saved draft can proceed without a writing agent') } },
  })
  const repositoryPath = join(api.profileDirectory, 'sample')
  await initRepository(repositoryPath)
  const commit = (await git('git', ['rev-parse', 'HEAD'], { cwd: repositoryPath })).stdout.trim()
  const evidence = [
    { path: 'README.md', text: 'A small command runner.', primary: false, kind: 'documentation', start: 1, end: 1 },
    { path: 'main.js', text: 'import { run } from "./core.js"\nexport const value = run()', primary: true, kind: 'source', start: 2, end: 3 },
    { path: 'core.js', text: 'export const run = () => 42', primary: true, kind: 'source', start: 1, end: 1 },
  ]
  const [docs, entry, core] = evidence.map((file, index) => ({ evidence: index + 1, start: file.start, end: file.end }))
  const checkpoints = createWikiCheckpoints(join(api.profileDirectory, 'dsh-code-wiki-checkpoints'))
  const resumeFrom = randomUUID()
  await checkpoints.save(resumeFrom, { version: 1, repositoryPath, commit,
    plan: wikiPlanFixture(), draft: wikiDraftFixture({ docs, entry, core }), evidence })
  assert.equal((await api.post('generate', { repositoryPath: repositoryPath + '-other', resumeFrom })).status, 400)
  assert.equal((await api.post('generate', { repositoryPath, resumeFrom: '../bad' })).status, 400)
  const response = await api.post('generate', { repositoryPath, resumeFrom })
  assert.equal(response.status, 200)
  const document = await response.json()
  assert.deepEqual(document.review, { status: 'findings', issues: [{ reviewer: 'semantic', reason }] })
  assert.deepEqual((await api.storage.get(document.id)).review, document.review)
  assert.deepEqual((await (await api.request('documents?id=' + document.id)).json()).review, document.review)
  assert.equal((await (await api.request('generation?id=' + document.id)).json()).job.canResume, false)
  assert.equal(reviews, 2)
  assert.notEqual(document.id, resumeFrom)
  assert(document.markdown.includes('key=' + document.id))
  assert.equal(await checkpoints.get(resumeFrom), null)
  assert.equal(await checkpoints.get(document.id), null)
  assert.equal((await api.storage.list()).length, 1)
})

test('a GitHub checkpoint survives restart and can replan with the same numbered source evidence', async t => {
  const resumeFrom = randomUUID(), commit = 'a'.repeat(40), tree = 'b'.repeat(40)
  const repositoryUrl = 'https://github.com/example/repo'
  const evidence = [
    { path: 'README.md', text: 'A command runner.', primary: false, kind: 'documentation' },
    { path: 'main.js', text: 'export { run } from "./core.js"', primary: true, kind: 'source' },
    { path: 'core.js', text: 'export const run = () => 42', primary: true, kind: 'source' },
  ].map(file => ({ ...file, start: 1, end: 1 }))
  const spans = evidence.map((_file, index) => ({ evidence: index + 1, start: 1, end: 1 }))
  const plan = wikiPlanFixture(), draft = wikiDraftFixture({ docs: spans[0], entry: spans[1], core: spans[2] })
  const oldPlan = structuredClone(plan)
  delete oldPlan.modules
  for (const chapter of oldPlan.chapters) {
    delete chapter.role
    delete chapter.module
  }
  const { post, request, profileDirectory } = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    agents: { async create(options) {
      const tools = new Map()
      options.setup({ tools: { restrict() {}, register(tool) { tools.set(tool.name, tool) } } })
      let draftTurn
      return { agent: { followup(message) {
        draftTurn = (async () => {
          const prompt = message.content[0].text
          const restored = JSON.parse(prompt.split('\n').at(-1))
          assert.deepEqual(restored.evidence.map(({ id, path }) => [id, path]), [[1, 'README.md'], [2, 'main.js'], [3, 'core.js']])
          const submit = tools.get('wiki_publish')
          assert.match((await submit.execute({ kind: 'plan', plan })).status, /研究计划已接受/)
          assert.match((await submit.execute({ kind: 'draft', draft: withWikiModuleCases(draft, { entry: spans[1], core: spans[2] }) })).status, /草稿已收到/)
        })()
      }, whenIdle: () => draftTurn, cancel() {} }, dispose() {} }
    } },
  })
  const checkpoints = createWikiCheckpoints(join(profileDirectory, 'dsh-code-wiki-checkpoints'))
  await checkpoints.save(resumeFrom, { version: 1, repositoryUrl, commit, plan: oldPlan, draft, evidence })
  for (const query of ['', '?id=' + resumeFrom]) {
    const { job } = await (await request('generation' + query)).json()
    assert.equal(job.id, resumeFrom)
    assert.equal(job.phase, 'failed')
    assert.equal(job.repositoryUrl, repositoryUrl)
    assert.equal(job.canResume, true)
    assert.deepEqual(Object.keys(job).sort(), ['canResume', 'commit', 'elapsedMs', 'error', 'id', 'phase', 'repository', 'repositoryUrl'])
  }

  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url).pathname.toLowerCase()
    if (path === '/repos/example/repo/commits/' + commit) return Response.json({ sha: commit, commit: { tree: { sha: tree } } })
    assert.equal(path, '/repos/example/repo/git/trees/' + tree, 'only the pinned commit tree should be read')
    return Response.json({ truncated: false, tree: evidence.map(file => ({ path: file.path, type: 'blob', mode: '100644' })) })
  })
  assert.equal((await post('generate', { repositoryUrl: 'https://github.com/example/other', resumeFrom })).status, 400)
  assert.equal((await post('generate', { repositoryUrl, resumeFrom, commit: 'c'.repeat(40) })).status, 400)
  assert.equal(fetch.mock.callCount(), 0)
  const response = await post('generate', { repositoryUrl: 'https://github.com/EXAMPLE/Repo.git/', resumeFrom })
  const published = await response.json()
  assert.equal(response.status, 200, published.error)
  assert.equal(published.commit, commit)
  assert.equal(fetch.mock.callCount(), 2)
  assert.equal(await checkpoints.get(resumeFrom), null)
  assert.deepEqual(await (await request('generation')).json(), { job: null })
})

test('failed research resumes from private evidence and submits a new draft for review', async t => {
  const reviewStarted = Promise.withResolvers(), allowReview = Promise.withResolvers()
  t.after(() => allowReview.resolve())
  let agents = 0, reviews = 0, candidate
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    llm: { async *stream() {
      reviews++
      if (reviews === 2) reviewStarted.resolve()
      await allowReview.promise
      yield* approvedReviews.stream()
    } },
    agents: { async create(options) {
      if (agents++ === 0) {
        const handle = await publishingAgent({ ...options, setup(context) {
        options.setup({ tools: { ...context.tools, register(tool) {
          if (tool.name !== 'wiki_publish') return context.tools.register(tool)
          context.tools.register({ ...tool, async execute(args) {
            if (args.kind === 'draft') {
              candidate = structuredClone(args.draft)
              throw Object.assign(new Error('fixture connection failure'), { code: 'TRANSPORT' })
            }
            return tool.execute(args)
          } })
        } } })
        } })
        return { ...handle, dispose() {} }
      }
      const tools = new Map()
      options.setup({ tools: { restrict() {}, register(tool) { tools.set(tool.name, tool) } } })
      let run
      return { agent: { followup(message) {
        run = (async () => {
          const prompt = message.content[0].text
          assert.match(prompt, /研究计划已被接受，尚无可用草稿/)
          const research = JSON.parse(prompt.split('\n').at(-1))
          assert.deepEqual(research.evidence.map(file => file.id), [1, 2, 3])
          assert.deepEqual(new Set(research.evidence.map(file => file.path)), new Set(['main.js', 'core.js', 'README.md']))
          assert.match((await tools.get('wiki_publish').execute({ kind: 'draft', draft: candidate })).status, /草稿已收到/)
        })()
      }, whenIdle: () => run, cancel() {} }, dispose() {} }
    } },
  }
  const { post, request, profileDirectory, storage } = await fixture(t, services)
  const repositoryPath = join(profileDirectory, 'sample')
  await initRepository(repositoryPath)
  assert.equal((await post('generate', { repositoryPath })).status, 502)
  const { readdir } = await import('node:fs/promises')
  const checkpointDirectory = join(profileDirectory, 'dsh-code-wiki-checkpoints')
  const [name] = await readdir(checkpointDirectory)
  const failed = (await (await request('generation?id=' + name.slice(0, -5))).json()).job
  assert.equal(failed.canResume, true)
  assert.equal(failed.failureCode, 'TRANSPORT')
  assert.deepEqual(await storage.list(), [])
  const checkpoints = createWikiCheckpoints(checkpointDirectory)
  const research = await checkpoints.get(failed.id)
  assert.equal(Object.hasOwn(research, 'draft'), false)
  assert.equal(research.evidence.length, 3)
  assert.equal(reviews, 0)
  const resumed = post('generate', { repositoryPath, resumeFrom: failed.id })
  await reviewStarted.promise
  assert.deepEqual(await storage.list(), [], 'neither research nor a draft awaiting reviews is a published document')
  allowReview.resolve()
  const completed = await resumed
  assert.equal(completed.status, 200)
  const document = await completed.json()
  assert.equal(reviews, 2)
  assert.equal((await storage.list()).length, 1)
  assert.equal(document.commit, research.commit)
  assert.equal(await checkpoints.get(failed.id), null)
  assert.equal(await checkpoints.get(document.id), null)
})

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
  assert.equal(job.canResume, false)
  assert.equal(job.repositoryPath, repositoryPath)
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
  assert.equal(finished.result.architecture.layers[1].nodes.length, 2)
  assert.equal(finished.result.architecture.edges[1].to, 'value')
  assert.equal(finished.result.architecture.layers[0].nodes[0].technology, 'JavaScript')
  assert.match(finished.result.markdown, /## Entry[\s\S]*## Core/)
  assert.match(finished.result.markdown, /```javascript\nexport const run = \(\) => 42/)
  assert.match(finished.result.markdown, /A small command runner/)
  assert.doesNotMatch(finished.result.markdown, /^- Uses committed source/m)
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

test('generation polling exposes safe detailed progress while an accepted draft awaits the agent', async t => {
  const accepted = Promise.withResolvers(), release = Promise.withResolvers(), logs = []
  t.after(() => release.resolve())
  t.mock.method(console, 'info', line => {
    if (line.startsWith('[dsh-code-wiki:wiki] ')) logs.push(JSON.parse(line.slice('[dsh-code-wiki:wiki] '.length)))
  })
  const api = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    agents: { async create(options) {
      const handle = await publishingAgent(options)
      const idle = handle.agent.whenIdle
      handle.agent.whenIdle = async () => { await idle(); accepted.resolve(); await release.promise }
      return handle
    } },
  })
  const repositoryPath = join(api.profileDirectory, 'sample')
  await initRepository(repositoryPath)
  const response = await api.post('generation', { repositoryPath })
  assert.equal(response.status, 202)
  const { job } = await response.json()
  await accepted.promise
  const current = (await (await api.request('generation?id=' + job.id)).json()).job
  assert.equal(current.phase, 'writing')
  assert.equal(current.step, 'agent-finishing')
  assert.equal(current.attempt, 1)
  assert.equal(current.attemptLimit, 3)
  assert.equal(current.canResume, true)
  assert(Number.isSafeInteger(current.phaseElapsedMs))
  for (const field of ['plan', 'draft', 'evidence', 'startedAt', 'finishedAt']) assert.equal(field in current, false)
  release.resolve()
  let final
  for (let i = 0; i < 100; i++) {
    final = (await (await api.request('generation?id=' + job.id)).json()).job
    if (final.phase === 'completed' || final.phase === 'failed') break
    await delay(10)
  }
  assert.equal(final.phase, 'completed', final.error)
  assert(logs.some(entry => entry.event === 'checkpoint' && entry.hasDraft))
  assert(logs.some(entry => entry.event === 'progress' && entry.step === 'agent-finishing'))
  assert.equal(logs.at(-1).event, 'finish')
  assert.equal(logs.at(-1).outcome, 'completed')
  assert(!JSON.stringify(logs).includes(repositoryPath), 'server logs exclude the private repository path')
})

test('a research connection failure without a draft offers a fresh retry without exposing provider internals', async t => {
  const api = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    agents: { async create() {
      return { agent: { followup() {}, cancel() {}, async whenIdle() {
        throw Object.assign(new Error('TRANSPORT'), { code: 'TRANSPORT' })
      } }, dispose() {} }
    } },
  })
  const repositoryPath = join(api.profileDirectory, 'sample')
  await initRepository(repositoryPath)
  const job = await generateDocument(api, repositoryPath)
  assert.equal(job.phase, 'failed')
  assert.equal(job.canResume, false)
  assert.equal(job.repositoryPath, repositoryPath)
  assert.match(job.commit, /^[a-f0-9]{40}$/)
  assert.equal(job.error, '与模型服务的连接中断。请重新尝试。')
  assert.equal(job.failureCode, 'TRANSPORT')
  assert.deepEqual(await api.storage.list(), [])
})

test('the synchronous generate endpoint uses the same reviewed Wiki pipeline', async t => {
  let reviews = 0
  const api = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    agents: { create: options => publishingAgent(options) },
    llm: { async *stream() { reviews++; yield* approvedReviews.stream() } },
  })
  const repositoryPath = join(api.profileDirectory, 'sample')
  await initRepository(repositoryPath)
  const response = await api.post('generate', { repositoryPath })
  assert.equal(response.status, 200)
  const document = await response.json()
  assert.equal(reviews, 2, 'facts and writing must both be reviewed before the old endpoint publishes')
  assert.match(document.markdown, /```javascript/)
  assert.equal(document.architecture.edges.length, 2)
  assert.equal(document.walkthrough.steps[2].outcome, 'The import can read value.')
  assert.equal(document.walkthrough.modules[1].chapter, 3)
  const link = new URL(document.walkthrough.steps[2].data.refs[0].url)
  assert.equal(link.searchParams.get('key'), document.id)
  const source = await api.request('source' + link.search)
  assert.equal(source.status, 200)
  assert.match(await source.text(), /export const value/)
  const reopened = await (await api.request('documents?id=' + document.id)).json()
  assert.deepEqual(reopened.walkthrough, document.walkthrough)
  const invalid = await api.storage.get(document.id)
  invalid.walkthrough.steps[2].data.refs[0].url = 'https://example.com/source'
  await assert.rejects(api.storage.save(invalid), /Invalid wiki document/)
  const { documents } = await (await api.request('documents')).json()
  assert.equal(documents[0].walkthrough, undefined, 'history contains summaries only')
})

test('a fresh installation follows the current DSH provider, model and reasoning setting on each generation', async t => {
  let selection = { provider: 'dsh-provider', model: 'dsh-model', reasoningEffort: 'medium' }
  const calls = []
  const api = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ ...selection }) },
    llm: { ...approvedReviews, registerAdapter() { assert.fail('A default installation must use the DSH adapter') } },
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
  assert.deepEqual(calls[0], { ...selection, maxTokens: 24_000 })

  selection = { provider: 'another-provider', model: 'another-model', reasoningEffort: 'high' }
  const second = await generateDocument(api, repositoryPath)
  assert.equal(second.phase, 'completed', second.error)
  assert.equal(second.result.model, selection.model)
  assert.deepEqual(calls[1], { ...selection, maxTokens: 24_000 })
})

test('a local model override takes precedence over DSH and reports configuration failures', async t => {
  const config = {}
  const adapters = new Map()
  let registrations = 0
  const api = await fixture(t, {
    agentDefaultModel: { currentSelection() { assert.fail('An explicit local override takes precedence') } },
    llm: { ...approvedReviews, registerAdapter([provider], adapter) {
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
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://example.invalid/v1/chat/completions')
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'personal-gpt')
    assert.equal(body.tools, undefined, 'only independent review calls reach this mock')
    return Response.json({ choices: [{ message: { content: JSON.stringify({ approved: true, issues: [] }) }, finish_reason: 'stop' }] })
  })
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
  assert.equal(failed.error, '无法使用当前模型配置，请检查后重试。')
  assert.equal(registrations, 1)
})
