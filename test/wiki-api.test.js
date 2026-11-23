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
import { createWikiCheckpoints } from '../src/wiki-checkpoint.js'

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
    llm: { async *stream() { assert.fail('Wiki generation uses the author agent') } },
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

function holdAfterChapter(t) {
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  let writerSignal
  return { started: started.promise, release: release.resolve, signal: () => writerSignal, create(options) {
    writerSignal = options.signal
    let spans
    const handle = markdownAgent(options, async context => {
      if (context.turn === 1) {
        spans = await readSpans(context)
        return openingMarkdown(spans) + '\n<!-- wiki:continue -->'
      }
      started.resolve()
      await release.promise
      context.signal.throwIfAborted()
      return closingMarkdown(spans) + '\n<!-- wiki:complete -->'
    })
    return { ...handle, agent: { ...handle.agent, cancel: release.resolve } }
  } }
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
  const clock = virtualWikiClock(t), held = holdAfterChapter(t)
  const api = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    agents: { create: held.create },
  })
  const repositoryPath = join(api.profileDirectory, 'sample')
  await initRepository(repositoryPath)
  const connection = new AbortController()
  const accepted = await api.request('generation', { method: 'POST', signal: connection.signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repositoryPath }) })
  assert.equal(accepted.status, 202)
  const { job: initial } = await accepted.json()
  connection.abort()
  await held.started
  const writerSignal = held.signal()
  assert.equal(writerSignal.aborted, false, 'the background task outlives its initiating HTTP connection')
  assert.equal(clock.intervals.size, 1)
  assert.equal([...clock.intervals.values()][0].milliseconds, 30_000)
  for (const minutes of [31, 62]) {
    clock.advance(31 * 60_000)
    assert.equal(writerSignal.aborted, false, 'advancing the old total deadline must not cancel the Wiki')
    const { job } = await (await api.request('generation?id=' + initial.id)).json()
    assert.equal(job.phase, 'writing')
    assert.equal(job.step, 'drafting')
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
  assert.equal(checkpoint.textDraft.complete, false)
  assert.match(checkpoint.textDraft.markdown, /## Entry/)
  assert.equal(checkpoint.evidence.length, 3)
  assert.deepEqual(await api.storage.list(), [])
  const count = clock.logs.length
  clock.advance(31 * 60_000)
  assert.equal(clock.logs.length, count, 'shutdown releases the heartbeat rather than leaving a stale live job')
})

test('disconnecting a synchronous Wiki request still cancels generation and releases its heartbeat', async t => {
  const clock = virtualWikiClock(t), held = holdAfterChapter(t)
  const api = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    agents: { create: held.create },
  })
  const repositoryPath = join(api.profileDirectory, 'sample')
  await initRepository(repositoryPath)
  const connection = new AbortController()
  const pending = api.request('generate', { method: 'POST', signal: connection.signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repositoryPath }) })
  await held.started
  const { job } = await (await api.request('generation')).json()
  assert.equal(job.phase, 'writing')
  assert.equal(job.step, 'drafting')
  connection.abort()
  const cancelled = await pending
  assert.equal(cancelled.status, 503)
  assert.equal((await cancelled.json()).error, '生成已取消。')
  assert(held.signal().aborted)
  assert.equal(clock.intervals.size, 0)
  assert.equal(clock.logs.at(-1).reason, 'cancelled')
  assert(clock.logs.every(log => log.timeoutMs === null))
  const checkpoint = await createWikiCheckpoints(join(api.profileDirectory, 'dsh-code-wiki-checkpoints')).get(job.id)
  assert.equal(checkpoint.textDraft.complete, false)
  assert.match(checkpoint.textDraft.markdown, /## Entry/)
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

async function readSpans({ tools, signal }) {
  const batch = await tools.get('wiki_read_batch').execute({ ranges: [
    { path: 'main.js', start: 2 }, { path: 'core.js' }, { path: 'README.md' },
  ] }, { signal })
  const { results: [entry, core, readme] } = JSON.parse(batch.data)
  return { entry, core, readme }
}

const citation = span => `[E${span.evidence}:${span.start}-${span.end}]`

function openingMarkdown({ entry, readme }) {
  return [
    '# Fixture Wiki',
    'A small command runner. ' + citation(readme),
    '## Entry',
    'Uses committed source to call run. ' + citation(entry),
    '```mermaid\nflowchart LR\nA[Entry] --> B[Core]\n```',
  ].join('\n\n')
}

function closingMarkdown({ core }) {
  return [
    '## Core',
    'Returns the value 42. ' + citation(core),
    '```javascript\nexport const run = () => 42\n```',
  ].join('\n\n')
}

async function writeMarkdown(context) {
  const spans = await readSpans(context)
  return openingMarkdown(spans) + '\n\n' + closingMarkdown(spans) + '\n<!-- wiki:complete -->'
}

function markdownAgent({ setup, signal }, author = writeMarkdown, restrictions = []) {
  const tools = new Map(), events = []
  setup({ tools: {
    restrict: restriction => restrictions.push(restriction),
    register: tool => tools.set(tool.name, tool),
  } })
  let run, turn = 0
  const agent = {
    session: { snapshotEvents: () => events.slice() },
    followup(message) {
      turn++
      run = (async () => {
        signal.throwIfAborted()
        const text = await author({ tools, signal, turn, prompt: message.content[0].text })
        events.push(
          { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } },
          { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
        )
      })()
    },
    whenIdle: () => run,
    cancel() {},
  }
  return { agent, dispose() {} }
}

function sourceLink(document, start, end) {
  return [...document.markdown.matchAll(/\((https:\/\/dsh-code-wiki\.invalid\/source\?[^)]+)\)/g)]
    .map(match => new URL(match[1]))
    .find(url => url.searchParams.get('start') === String(start) && url.searchParams.get('end') === String(end))
}

test('a GitHub checkpoint survives restart and reuses the same numbered source evidence', async t => {
  const resumeFrom = randomUUID(), commit = 'a'.repeat(40), tree = 'b'.repeat(40)
  const repositoryUrl = 'https://github.com/example/repo'
  const evidence = [
    { path: 'README.md', text: 'A command runner.', primary: false, kind: 'documentation' },
    { path: 'main.js', text: 'export { run } from "./core.js"', primary: true, kind: 'source' },
    { path: 'core.js', text: 'export const run = () => 42', primary: true, kind: 'source' },
  ].map(file => ({ ...file, start: 1, end: 1 }))
  const { post, request, profileDirectory } = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    agents: { create: options => markdownAgent(options, async ({ prompt, tools }) => {
      assert.match(prompt, /1 README\.md:1-1/)
      assert.match(prompt, /2 main\.js:1-1/)
      assert.match(prompt, /3 core\.js:1-1/)
      assert.doesNotMatch(prompt, /export const run/)
      const { results } = JSON.parse((await tools.get('wiki_read_saved').execute({ ids: [3] })).data)
      assert.equal(results[0].lines, '1 | export const run = () => 42')
      return '# Command runner\n\n## Core\n\nThe implementation returns 42. [E3:1]\n<!-- wiki:complete -->'
    }) },
  })
  const checkpoints = createWikiCheckpoints(join(profileDirectory, 'dsh-code-wiki-checkpoints'))
  // Old plans without chapter roles need fresh writing, but the pinned evidence still applies.
  const plan = { chapters: [{ id: 'overview', title: 'Overview' }] }
  await checkpoints.save(resumeFrom, { version: 1, repositoryUrl, commit, plan, evidence })
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
  assert.ok(published.markdown.includes('/blob/' + commit + '/core.js#L1'))
  assert.equal(fetch.mock.callCount(), 2)
  assert.equal(await checkpoints.get(resumeFrom), null)
  assert.deepEqual(await (await request('generation')).json(), { job: null })
})

test('interrupted research resumes before writing and keeps its evidence private', async t => {
  const resumedAuthor = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  let agents = 0
  const { post, request, profileDirectory, storage } = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    agents: { create: options => markdownAgent(options, async context => {
      if (++agents === 1) {
        await readSpans(context)
        throw Object.assign(new Error('fixture connection failure'), { code: 'TRANSPORT' })
      }
      assert.doesNotMatch(context.prompt, /export const run/)
      assert.match(context.prompt, /main\.js:2-3/)
      assert.match(context.prompt, /core\.js:1-1/)
      assert.match(context.prompt, /README\.md:1-1/)
      const { results } = JSON.parse((await context.tools.get('wiki_read_saved').execute({ ids: [1, 2, 3] })).data)
      const [entry, core, readme] = ['main.js', 'core.js', 'README.md'].map(path => results.find(span => span.path === path))
      resumedAuthor.resolve()
      await release.promise
      const spans = { entry, core, readme }
      return openingMarkdown(spans) + '\n\n' + closingMarkdown(spans) + '\n<!-- wiki:complete -->'
    }) },
  })
  const repositoryPath = join(profileDirectory, 'sample')
  await initRepository(repositoryPath)
  assert.equal((await post('generate', { repositoryPath })).status, 502)
  const failed = (await (await request('generation')).json()).job
  assert.equal(failed.canResume, true)
  assert.equal(failed.failureCode, 'TRANSPORT')
  assert.deepEqual(await storage.list(), [])
  const checkpoints = createWikiCheckpoints(join(profileDirectory, 'dsh-code-wiki-checkpoints'))
  const research = await checkpoints.get(failed.id)
  assert.deepEqual(research.textDraft, { markdown: '', complete: false })
  assert.equal(research.evidence.length, 3)
  assert.equal((await post('generate', { repositoryPath: repositoryPath + '-other', resumeFrom: failed.id })).status, 400)
  assert.equal((await post('generate', { repositoryPath, resumeFrom: '../bad' })).status, 400)
  const resumed = post('generate', { repositoryPath, resumeFrom: failed.id })
  await resumedAuthor.promise
  assert.deepEqual(await storage.list(), [], 'resuming the source evidence alone does not publish a document')
  release.resolve()
  const completed = await resumed
  const document = await completed.json()
  assert.equal(completed.status, 200, document.error)
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
      create: options => markdownAgent(options, async context => {
        await release.promise
        return writeMarkdown(context)
      }, restrictions),
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
  assert.equal(finished.result.format, 'skill-markdown')
  assert.match(finished.result.markdown, /## Entry[\s\S]*## Core/)
  assert.match(finished.result.markdown, /```javascript\nexport const run = \(\) => 42/)
  assert.match(finished.result.markdown, /A small command runner/)
  const source = sourceLink(finished.result, 2, 3)
  assert.equal(source?.searchParams.get('key'), finished.result.id)
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

test('generation polling reports progress without exposing a saved chapter or evidence', async t => {
  const held = holdAfterChapter(t), logs = []
  t.mock.method(console, 'info', line => {
    if (line.startsWith('[dsh-code-wiki:wiki] ')) logs.push(JSON.parse(line.slice('[dsh-code-wiki:wiki] '.length)))
  })
  const api = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    agents: { create: held.create },
  })
  const repositoryPath = join(api.profileDirectory, 'sample')
  await initRepository(repositoryPath)
  const response = await api.post('generation', { repositoryPath })
  assert.equal(response.status, 202)
  const { job } = await response.json()
  await held.started
  const current = (await (await api.request('generation?id=' + job.id)).json()).job
  assert.equal(current.phase, 'writing')
  assert.equal(current.step, 'drafting')
  assert.equal(current.attempt, 1)
  assert.equal(current.attemptLimit, 3)
  assert.equal(current.canResume, true)
  assert(Number.isSafeInteger(current.phaseElapsedMs))
  for (const field of ['plan', 'draft', 'textDraft', 'markdown', 'evidence', 'startedAt', 'finishedAt']) assert.equal(field in current, false)
  held.release()
  let final
  for (let i = 0; i < 100; i++) {
    final = (await (await api.request('generation?id=' + job.id)).json()).job
    if (final.phase === 'completed' || final.phase === 'failed') break
    await delay(10)
  }
  assert.equal(final.phase, 'completed', final.error)
  assert(logs.some(entry => entry.event === 'checkpoint' && entry.hasDraft))
  assert(logs.some(entry => entry.event === 'progress' && entry.step === 'drafting'))
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

test('the synchronous generate endpoint saves Markdown with the same source and history behavior', async t => {
  const api = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    agents: { create: options => markdownAgent(options, context => {
      assert.match(context.prompt, /代码百科 Markdown 存档模式/)
      assert.match(context.prompt, /repo-design-wiki · references\/diagrams\.md/)
      return writeMarkdown(context)
    }) },
  })
  const repositoryPath = join(api.profileDirectory, 'sample')
  await initRepository(repositoryPath)
  const response = await api.post('generate', { repositoryPath })
  const document = await response.json()
  assert.equal(response.status, 200, document.error)
  assert.equal(document.format, 'skill-markdown')
  assert.match(document.markdown, /```javascript/)
  assert.match(document.markdown, /```mermaid/)
  const link = sourceLink(document, 2, 3)
  assert.equal(link?.searchParams.get('key'), document.id)
  const source = await api.request('source' + link.search)
  assert.equal(source.status, 200)
  assert.match(await source.text(), /export const value/)
  const reopened = await (await api.request('documents?id=' + document.id)).json()
  assert.deepEqual(reopened, document)
  const { documents } = await (await api.request('documents')).json()
  assert.equal(documents[0].id, document.id)
  assert.equal(documents[0].markdown, undefined, 'history contains summaries only')
})

test('a fresh installation follows the current DSH provider, model and reasoning setting on each generation', async t => {
  let selection = { provider: 'dsh-provider', model: 'dsh-model', reasoningEffort: 'medium' }
  const calls = []
  const api = await fixture(t, {
    agentDefaultModel: { currentSelection: () => ({ ...selection }) },
    llm: { registerAdapter() { assert.fail('A default installation must use the DSH adapter') } },
    agents: { create(options) {
      calls.push(options.agentOptions)
      return markdownAgent(options)
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
      return markdownAgent(options)
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
  assert.equal(failed.error, '无法使用当前模型配置，请检查后重试。')
  assert.equal(registrations, 1)
})
