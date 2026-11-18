import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { registerVideoApi } from '../src/video-api.js'
import { editorialDocumentText, motionModelResponse } from '../fixtures/video-motion.js'

function observe(t) {
  let now = 1_000_000, unrefs = 0
  const intervals = new Map(), deadlines = [], logs = [], periods = []
  t.mock.method(Date, 'now', () => now)
  t.mock.method(console, 'info', line => {
    assert(line.startsWith('[dsh-code-wiki:video] '))
    logs.push(JSON.parse(line.slice('[dsh-code-wiki:video] '.length)))
  })
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController()
    deadlines.push({ at: now + milliseconds, milliseconds, controller })
    return controller.signal
  })
  t.mock.method(globalThis, 'setInterval', (callback, milliseconds) => {
    const handle = { unref() { unrefs++ } }
    intervals.set(handle, { callback, milliseconds, next: now + milliseconds })
    periods.push(milliseconds)
    return handle
  })
  t.mock.method(globalThis, 'clearInterval', handle => intervals.delete(handle))
  return { logs, intervals, deadlines, periods, unrefs: () => unrefs,
    advance(milliseconds) {
      const end = now + milliseconds
      for (;;) {
        const next = Math.min(...[...intervals.values()].map(timer => timer.next),
          ...deadlines.filter(timer => !timer.controller.signal.aborted).map(timer => timer.at))
        if (next > end) break
        now = next
        for (const timer of intervals.values()) if (timer.next === now) { timer.next += timer.milliseconds; timer.callback() }
        for (const timer of deadlines) if (timer.at === now && !timer.controller.signal.aborted) {
          timer.controller.abort(new DOMException('Fixture deadline', 'TimeoutError'))
        }
      }
      now = end
    } }
}

async function fixture(t, llm) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-video-progress-'))
  const lifetime = new AbortController(), routes = new Map()
  t.after(async () => { lifetime.abort(); await rm(directory, { recursive: true, force: true }) })
  const document = { id: randomUUID(), source: 'local', repositoryPath: '/example/repo', repoName: 'repo',
    commit: 'a'.repeat(40), files: [], markdown: editorialDocumentText + '\nLOG_PRIVATE_SOURCE_SENTINEL',
    architecture: { layers: [
      { title: 'Entry', nodes: [{ id: 'entry', title: 'Entry', summary: 'Read configuration.', refs: [] }] },
      { title: 'Trainer', nodes: [{ id: 'trainer', title: 'Trainer', summary: 'Run experiment.', refs: [] }] },
    ], edges: [{ from: 'entry', to: 'trainer', label: 'Starts', refs: [] }] } }
  registerVideoApi({ profileContext: { dir: directory }, connection: { fetch: { register(route) { routes.set(route.path, route) } } } },
    {}, { get: async id => id === document.id ? document : null },
    async () => ({ llm, selection: { provider: 'fixture', model: 'LOG_PRIVATE_MODEL_SENTINEL' } }), lifetime)
  const request = async (path, body) => {
    const url = new URL('http://localhost/api/dsh-code-wiki/video' + path)
    const response = await routes.get(url.pathname).fetch(new Request(url, body ? {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    } : undefined))
    return { status: response.status, ...await response.json() }
  }
  const start = () => request('', { documentId: document.id, voice: 'none' })
  const saved = () => request('?documentId=' + document.id)
  async function terminal(id) {
    for (let i = 0; i < 200; i++) {
      const { job } = await request('/job?id=' + id)
      if (['completed', 'failed', 'cancelled'].includes(job.phase)) return job
      await delay(1)
    }
    assert.fail('Fixture video did not settle')
  }
  return { document, lifetime, request, start, saved, terminal }
}

function pendingModel() {
  const entered = Promise.withResolvers()
  return { entered: entered.promise, llm: { async *stream({ signal }) {
    entered.resolve()
    await new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  } } }
}

test('video progress logs stage changes, an unreferenced 30-second heartbeat and completion without content', async t => {
  const clock = observe(t), entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  let first = true
  const f = await fixture(t, { async *stream(options) {
    if (first) { first = false; entered.resolve(); await release.promise }
    yield { type: 'text-delta', text: JSON.stringify(motionModelResponse(options.system, options.messages[0].content[0].text)) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } })
  const accepted = await f.start()
  assert.equal(accepted.status, 202)
  await entered.promise
  assert.equal(clock.deadlines[0].milliseconds, 30 * 60_000)
  assert.deepEqual(clock.periods, [30_000])
  assert.equal(clock.unrefs(), 1)
  clock.advance(29_999)
  assert.equal(clock.logs.filter(log => log.event === 'heartbeat').length, 0)
  clock.advance(1)
  const beat = clock.logs.find(log => log.event === 'heartbeat')
  assert.equal(beat.elapsedMs, 30_000)
  assert.equal(beat.phase, 'scripting')
  release.resolve()
  const completed = await f.terminal(accepted.job.id)
  assert.equal(completed.phase, 'completed')
  const progress = clock.logs.filter(log => log.event === 'progress')
  assert(progress.some(log => log.phase === 'designing'))
  assert(progress.some(log => log.phase === 'reviewing'))
  assert(progress.some(log => log.phase === 'voicing' && log.completedScenes > 0))
  assert(new Set(progress.filter(log => log.phase === 'scripting').map(log => log.step)).size >= 2,
    'different steps in the same phase must each be logged')
  const finish = clock.logs.at(-1)
  assert.equal(finish.event, 'finish')
  assert.equal(finish.outcome, 'completed')
  assert.equal(finish.phase, 'saving')
  assert.equal(clock.intervals.size, 0)
  for (const key of ['stop', 'startedAt', 'finishedAt', 'phaseStartedAt', 'stepStartedAt']) assert.equal(key in completed, false)
  const before = clock.logs.length
  clock.advance(30_000)
  assert.equal(clock.logs.length, before)
  const serialized = JSON.stringify(clock.logs)
  assert.doesNotMatch(serialized, /LOG_PRIVATE|"(?:narration|markdown|script|audio|authorization|api_key)"\s*:/)
  for (const log of clock.logs) {
    assert.match(log.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.equal(log.jobId, accepted.job.id)
    assert.equal(log.documentId, f.document.id)
    assert.equal(log.timeoutMs, 30 * 60_000)
    assert(Number.isSafeInteger(log.elapsedMs) && Number.isSafeInteger(log.phaseElapsedMs))
  }
})

test('the video deadline is thirty minutes and timeout remains a recoverable failure after reopening', async t => {
  const clock = observe(t), model = pendingModel(), f = await fixture(t, model.llm)
  const { job } = await f.start()
  await model.entered
  clock.advance(10 * 60_000)
  assert.notEqual((await f.request('/job?id=' + job.id)).job.phase, 'failed')
  assert.equal(clock.deadlines[0].controller.signal.aborted, false)
  clock.advance(20 * 60_000)
  const failed = await f.terminal(job.id)
  assert.equal(failed.phase, 'failed')
  assert.match(failed.error, /三十分钟/)
  const saved = await f.saved()
  assert.equal(saved.artifact, null)
  assert.equal(saved.job, null)
  assert.equal(saved.lastFailure, failed.error)
  const finish = clock.logs.at(-1)
  assert.equal(finish.outcome, 'failed')
  assert.equal(finish.reason, 'timeout')
  assert.equal(finish.failedPhase, 'scripting')
  assert.equal(finish.phase, finish.failedPhase)
  assert.equal(finish.failedStep, finish.step)
  assert.equal(finish.elapsedMs, 30 * 60_000)
  assert.equal(clock.intervals.size, 0)
})

for (const mode of ['user', 'service']) test(`${mode} cancellation stays cancelled and clears video heartbeat`, async t => {
  const clock = observe(t), model = pendingModel(), f = await fixture(t, model.llm)
  const { job } = await f.start()
  await model.entered
  if (mode === 'user') await f.request('/job', { id: job.id })
  else f.lifetime.abort()
  assert.equal((await f.terminal(job.id)).phase, 'cancelled')
  const finish = clock.logs.at(-1)
  assert.equal(finish.outcome, 'cancelled')
  assert.equal(finish.reason, mode === 'user' ? 'user-cancelled' : 'service-stopped')
  assert.equal(clock.intervals.size, 0)
  const before = clock.logs.length
  clock.advance(30_000)
  assert.equal(clock.logs.length, before)
})

test('failure logging preserves the execution stage and only emits whitelisted error codes', async t => {
  const clock = observe(t)
  let malicious = false
  const f = await fixture(t, { async *stream() {
    throw Object.assign(new Error('LOG_PRIVATE_ERROR_SENTINEL'), {
      code: malicious ? 'LOG_PRIVATE_CODE_SENTINEL' : 'AUTH',
      providerCode: malicious ? 'LOG_PRIVATE_PROVIDER_SENTINEL' : 'AUTH',
    })
  } })
  for (const unexpected of [false, true]) {
    malicious = unexpected
    const { job } = await f.start()
    assert.equal((await f.terminal(job.id)).phase, 'failed')
    const finish = clock.logs.at(-1)
    assert.equal(finish.phase, 'scripting')
    assert.equal(finish.failedPhase, 'scripting')
    assert.equal(finish.failedStep, finish.step)
    if (!unexpected) {
      assert.equal(finish.errorCode, 'model-unavailable')
      assert.equal(finish.providerCode, 'AUTH')
    }
    assert.equal(clock.intervals.size, 0)
  }
  assert.doesNotMatch(JSON.stringify(clock.logs), /LOG_PRIVATE|stack|message|prompt|authorization|api_key/)
})
