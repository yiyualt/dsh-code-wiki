import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWikiProgress } from '../src/wiki-progress.js'

function fixture(t) {
  let now = 1000, unrefs = 0
  const logs = [], timers = new Map()
  t.mock.method(Date, 'now', () => now)
  t.mock.method(console, 'info', line => {
    assert(line.startsWith('[dsh-code-wiki:wiki] '))
    logs.push(JSON.parse(line.slice('[dsh-code-wiki:wiki] '.length)))
  })
  t.mock.method(globalThis, 'setInterval', (callback, milliseconds) => {
    const handle = { unref() { unrefs++ } }
    timers.set(handle, { callback, milliseconds })
    return handle
  })
  t.mock.method(globalThis, 'clearInterval', handle => timers.delete(handle))
  const job = { id: '12345678-1234-4234-8234-123456789abc', phase: 'reading', startedAt: now,
    repositoryPath: '/PRIVATE_REPOSITORY', currentFile: 'PRIVATE_SOURCE_FILE', filesRead: 18 }
  const progress = createWikiProgress(job)
  t.after(() => progress.finish('failed', 'cancelled'))
  return { job, progress, logs, timers, unrefs: () => unrefs, advance(ms) { now += ms } }
}

test('Wiki diagnostics retain safe retry metadata and keep content out of logs', t => {
  const { progress, logs } = fixture(t)
  progress.phase('writing', { step: 'submission-retry', repair: 1, attempt: 2, attemptLimit: 3, rejections: 4,
    reasonCategory: 'validation', retryMessage: 'PRIVATE_REJECTION\nCheck the citation.',
    plan: { text: 'PRIVATE_PLAN' }, draft: { text: 'PRIVATE_DRAFT' }, authorization: 'PRIVATE_CREDENTIAL' })
  assert.equal(progress.status().step, 'submission-retry')
  assert.equal(progress.status().rejections, 4)
  assert.equal(progress.status().retryMessage, 'PRIVATE_REJECTION Check the citation.')
  progress.activity('checkpoint', { evidenceCount: 47, hasDraft: true, raw: 'PRIVATE_SOURCE' })
  progress.model({ event: 'request-retry', requestId: 1, attempt: 1, attemptLimit: 3, requestElapsedMs: 50,
    attemptElapsedMs: 50, retryCode: 'SERVER', providerStatus: 503, retryInMs: 100, url: 'PRIVATE_URL', body: 'PRIVATE_BODY' })
  assert.equal(progress.status().transport.retryCode, 'SERVER')
  assert.equal(logs.at(-1).transport.providerStatus, 503)
  assert.equal(logs.at(-2).evidenceCount, 47)
  assert.equal(logs.at(-2).hasDraft, true)
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|authorization|retryMessage|repositoryPath/)
  assert.equal('plan' in progress.status(), false)
  for (const log of logs) assert.match(log.timestamp, /^\d{4}-\d{2}-\d{2}T/)
  progress.model({ event: 'request-retry', requestId: 1, retryCode: 'PRIVATE_CODE', providerStatus: 999, raw: 'PRIVATE_DATA' })
  assert.equal(progress.status().transport.retryCode, undefined)
  assert.equal(progress.status().transport.providerStatus, undefined)
})

test('Wiki step time resets independently from phase time and stale validation feedback is cleared', t => {
  const { progress, advance } = fixture(t)
  progress.phase('writing', { step: 'submission-retry', rejections: 1, retryMessage: 'Fix a citation.', reasonCategory: 'validation' })
  advance(2000)
  assert.equal(progress.status().phaseElapsedMs, 2000)
  progress.phase('writing', { step: 'revising', repair: 1 })
  assert.equal(progress.status().phaseElapsedMs, 2000)
  assert.equal(progress.status().stepElapsedMs, 0)
  assert.equal(progress.status().retryMessage, undefined)
  assert.equal(progress.status().reasonCategory, undefined)
  assert.equal(progress.status().rejections, 1)
  advance(1000)
  progress.phase('reviewing', { step: 'reviewing', repair: 1 })
  assert.equal(progress.status().phaseElapsedMs, 0)
  assert.equal(progress.status().activityElapsedMs, 0)
})

test('parallel reviewer requests keep an active retry visible and log each event against its own request', t => {
  const { progress, advance, logs } = fixture(t)
  const request = (event, requestId, attempt = 1) => progress.model({ event, requestId, attempt,
    attemptLimit: 3, requestElapsedMs: 0, attemptElapsedMs: 0, ...(event === 'request-retry' && { retryCode: 'TIMEOUT' }) })
  request('request-start', 1)
  request('request-start', 2)
  request('request-retry', 1)
  request('request-completed', 2)
  assert.equal(logs.at(-1).transport.requestId, 2)
  assert.equal(logs.at(-1).transport.event, 'request-completed')
  assert.equal(progress.status().transport.requestId, 1)
  assert.equal(progress.status().transport.event, 'request-retry')
  advance(100)
  request('request-start', 1, 2)
  request('request-start', 3)
  request('request-receiving', 3)
  assert.equal(progress.status().transport.requestId, 1, 'the retry remains visible after its next attempt starts')
  advance(500)
  assert.equal(progress.status().transport.attempt, 2)
  assert.equal(progress.status().transport.requestElapsedMs, 500)
  request('request-completed', 1, 2)
  request('request-completed', 3)
  advance(1000)
  assert.equal(progress.status().transport.requestElapsedMs, 0, 'finished request timing no longer advances')
})

for (const [outcome, reason] of [['completed', 'completed'], ['failed', 'timeout'], ['failed', 'cancelled']]) {
  test(`Wiki ${reason} records the execution phase and releases its heartbeat`, t => {
    const { progress, job, advance, timers, logs, unrefs } = fixture(t)
    assert.equal(unrefs(), 1)
    assert.equal([...timers.values()][0].milliseconds, 30_000)
    progress.phase('writing', { step: 'revising', repair: 1 })
    advance(30_000)
    for (const timer of timers.values()) timer.callback()
    assert.equal(logs.at(-1).event, 'heartbeat')
    assert.equal(logs.at(-1).elapsedMs, 30_000)
    progress.finish(outcome, reason)
    job.phase = outcome
    assert.equal(logs.at(-1).phase, 'writing')
    assert.equal(logs.at(-1).step, 'revising')
    assert.equal(logs.at(-1).reason, reason)
    assert.equal(timers.size, 0)
    const count = logs.length, status = progress.status()
    advance(1000)
    progress.finish('failed')
    progress.phase('writing')
    progress.model({ event: 'request-start', requestId: 1 })
    progress.activity('checkpoint')
    assert.equal(logs.length, count)
    assert.deepEqual(progress.status(), status)
  })
}

test('a broken stdout observer cannot fail a Wiki job', t => {
  const { progress } = fixture(t)
  t.mock.method(console, 'info', () => { throw new Error('stdout fixture') })
  assert.doesNotThrow(() => {
    progress.phase('writing', { step: 'drafting' })
    progress.model({ event: 'request-start', requestId: 1 })
    progress.finish('failed', 'validation-error')
  })
})

test('Wiki heartbeat and reported transport durations continue beyond an hour without advertising a total deadline', t => {
  const { progress, logs, advance, timers } = fixture(t)
  progress.phase('writing', { step: 'revising', repair: 1 })
  progress.model({ event: 'request-start', requestId: 1, attempt: 1, attemptLimit: 3,
    requestElapsedMs: 0, attemptElapsedMs: 0 })
  for (const minutes of [31, 62]) {
    advance(31 * 60_000)
    progress.model({ event: 'request-receiving', requestId: 1, attempt: 1, attemptLimit: 3,
      requestElapsedMs: minutes * 60_000, attemptElapsedMs: minutes * 60_000 })
    for (const timer of timers.values()) timer.callback()
    const status = progress.status(), log = logs.at(-1)
    assert.equal(log.event, 'heartbeat')
    assert.equal(log.timeoutMs, null)
    assert.equal(log.elapsedMs, minutes * 60_000)
    assert.equal(status.phaseElapsedMs, minutes * 60_000)
    assert.equal(status.stepElapsedMs, minutes * 60_000)
    assert.equal(status.transport.requestElapsedMs, minutes * 60_000)
    assert.equal(status.transport.attemptElapsedMs, minutes * 60_000)
    assert.equal(log.transport.requestElapsedMs, minutes * 60_000)
    assert.equal(timers.size, 1)
  }
  progress.model({ event: 'request-completed', requestId: 1, requestElapsedMs: 62 * 60_000,
    attemptElapsedMs: 62 * 60_000 })
  progress.finish('completed', 'completed')
  assert.equal(timers.size, 0)
  assert(logs.every(log => log.timeoutMs === null))
})

test('Wiki transport timing retains safe long durations while rejecting unsafe numeric input', t => {
  const { progress } = fixture(t)
  progress.model({ event: 'request-receiving', requestId: 1,
    requestElapsedMs: Number.MAX_SAFE_INTEGER, attemptElapsedMs: Number.MAX_SAFE_INTEGER })
  assert.equal(progress.status().transport.requestElapsedMs, Number.MAX_SAFE_INTEGER)
  assert.equal(progress.status().transport.attemptElapsedMs, Number.MAX_SAFE_INTEGER)
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    progress.model({ event: 'request-receiving', requestId: 1,
      requestElapsedMs: value, attemptElapsedMs: value })
    assert.equal(progress.status().transport.requestElapsedMs, 0)
    assert.equal(progress.status().transport.attemptElapsedMs, 0)
  }
})
