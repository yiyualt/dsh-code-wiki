import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { readConfiguredModel } from '../src/configured-model.js'

const frame = choice => 'data: ' + JSON.stringify({ choices: [{ index: 0, ...choice }] }) + '\n\n'
const partial = frame({ delta: { content: 'PRIVATE_PARTIAL_RESPONSE' } })
const finished = text => frame({ delta: { content: text } }) + frame({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n'
const tools = [{ name: 'wiki_read', parameters: { type: 'object' } }]
async function consume(adapter, options = {}) {
  const chunks = []
  for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE_PROMPT_SENTINEL' }] }],
    tools, maxTokens: 32, signal: new AbortController().signal, ...options })) chunks.push(chunk)
  return chunks
}
async function fixture(t, respond, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-model-progress-'))
  const events = [], bodies = []
  let requests = 0
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      bodies.push(body)
      await respond(response, ++requests, body)
    } catch { if (!response.destroyed) response.destroy() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  const config = join(directory, 'config.json')
  await writeFile(config, JSON.stringify({ judge: { url: `http://127.0.0.1:${server.address().port}/chat/completions`,
    model: 'PRIVATE_MODEL_SENTINEL', api_key: 'PRIVATE_KEY_SENTINEL' } }))
  const adapter = await readConfiguredModel(config, new AbortController().signal,
    { streamResponses: true, transportRetries: 1, onProgress: event => events.push(event), ...options })
  return { adapter, events, bodies, requests: () => requests }
}
function assertSafe(events) {
  const fields = new Set(['event', 'requestId', 'attempt', 'attemptLimit', 'requestElapsedMs', 'attemptElapsedMs',
    'retryCode', 'retryInMs', 'providerStatus'])
  for (const event of events) {
    assert(Object.keys(event).every(key => fields.has(key)))
    assert(Object.isFrozen(event))
    assert(Number.isSafeInteger(event.requestId) && event.requestId > 0)
    assert(Number.isSafeInteger(event.attempt) && event.attempt >= 1 && event.attempt <= event.attemptLimit)
    assert(Number.isSafeInteger(event.requestElapsedMs) && event.requestElapsedMs >= event.attemptElapsedMs)
    assert(Number.isSafeInteger(event.attemptElapsedMs) && event.attemptElapsedMs >= 0)
  }
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|http:|127\.0\.0\.1|authorization|api_key|messages|content|stack/)
}

test('a truncated real HTTP SSE response reports its retry before a successful second physical attempt', async t => {
  const f = await fixture(t, (response, request) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(request === 1 ? partial : finished('ready'))
  }, { toolCallLimit: 1 })
  const chunks = await consume(f.adapter)
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['ready'])
  assert.equal(f.requests(), 2)
  assert.deepEqual(f.events.map(event => [event.event, event.attempt]), [
    ['request-start', 1], ['request-receiving', 1], ['request-retry', 1],
    ['request-start', 2], ['request-receiving', 2], ['request-completed', 2],
  ])
  assert(f.events.every(event => event.requestId === 1 && event.attemptLimit === 2))
  const retry = f.events.find(event => event.event === 'request-retry')
  assert.equal(retry.retryCode, 'STREAM_CLOSED')
  assert.equal(retry.retryInMs, 100)
  assert.equal(retry.providerStatus, 200)
  assert.equal(f.events.at(-1).providerStatus, 200)
  assertSafe(f.events)
  await assert.rejects(consume(f.adapter), error => error.code === 'INVALID_REQUEST')
  assert.equal(f.requests(), 2, 'physical retries must not spend another tool-bearing request')
})

test('exhausted SSE retries emit one final failure and never expose partial output', async t => {
  const f = await fixture(t, response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(partial)
  }, { transportRetries: 2 })
  await assert.rejects(consume(f.adapter), error => error.code === 'STREAM_CLOSED')
  assert.equal(f.requests(), 3)
  assert.equal(f.events.filter(event => event.event === 'request-retry').length, 2)
  assert.equal(f.events.filter(event => event.event === 'request-failed').length, 1)
  assert.equal(f.events.at(-1).attempt, 3)
  assert.equal(f.events.at(-1).retryCode, 'STREAM_CLOSED')
  assert(!f.events.some(event => event.event === 'request-completed'))
  assertSafe(f.events)
})

test('HTTP authentication failure reports only its safe code and status without retrying', async t => {
  const f = await fixture(t, response => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'PRIVATE_PROVIDER_ERROR_SENTINEL' }))
  }, { transportRetries: 2 })
  await assert.rejects(consume(f.adapter), error => error.code === 'AUTH')
  assert.equal(f.requests(), 1)
  assert.deepEqual(f.events.map(event => event.event), ['request-start', 'request-failed'])
  assert.equal(f.events.at(-1).retryCode, 'AUTH')
  assert.equal(f.events.at(-1).providerStatus, 401)
  assertSafe(f.events)
})

test('aborting an active HTTP body reports terminal failure without another attempt', async t => {
  const controller = new AbortController(), reason = new Error('PRIVATE_ABORT_REASON_SENTINEL'), events = []
  const f = await fixture(t, response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(partial)
  }, { transportRetries: 2, onProgress(event) {
    events.push(event)
    if (event.event === 'request-receiving') setTimeout(() => controller.abort(reason), 5)
  } })
  await assert.rejects(consume(f.adapter, { signal: controller.signal }), error => error === reason)
  assert.equal(f.requests(), 1)
  assert.equal(events.at(-1).event, 'request-failed')
  assert.equal(events.at(-1).attempt, 1)
  assert(!events.some(event => event.event === 'request-retry'))
  assertSafe(events)
})

test('aborting inside a retry notification prevents the scheduled physical attempt', async t => {
  const controller = new AbortController(), reason = new Error('PRIVATE_ABORT_BACKOFF_SENTINEL'), events = []
  const f = await fixture(t, response => {
    response.writeHead(503)
    response.end('PRIVATE_ERROR_BODY')
  }, { transportRetries: 2, onProgress(event) {
    events.push(event)
    if (event.event === 'request-retry') controller.abort(reason)
  } })
  await assert.rejects(consume(f.adapter, { signal: controller.signal }), error => error === reason)
  assert.equal(f.requests(), 1)
  assert.deepEqual(events.map(event => event.event), ['request-start', 'request-retry', 'request-failed'])
  assert.equal(events[1].retryCode, 'SERVER')
  assertSafe(events)
})

test('parallel tool and reviewer requests receive distinct monotonic IDs even when they finish in reverse order', async t => {
  const f = await fixture(t, async (response, _request, body) => {
    if (body.tools?.length) await delay(30)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(finished('ready'))
  })
  await Promise.all([consume(f.adapter), consume(f.adapter, { tools: [] })])
  assert.deepEqual(f.events.filter(event => event.event === 'request-start').map(event => event.requestId), [1, 2])
  assert.deepEqual(f.events.filter(event => event.event === 'request-completed').map(event => event.requestId), [2, 1])
  assertSafe(f.events)
})

test('synchronous and asynchronous observer failures cannot change transport retries or model output', async t => {
  for (const asynchronous of [false, true]) {
    const events = []
    const observe = event => { events.push(event); throw new Error('PRIVATE_OBSERVER_ERROR_SENTINEL') }
    const f = await fixture(t, (response, request) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(request === 1 ? partial : finished('ready'))
    }, { onProgress: asynchronous ? async event => observe(event) : observe })
    assert.equal((await consume(f.adapter)).find(chunk => chunk.type === 'text-delta').text, 'ready')
    assert.equal(f.requests(), 2)
    assert.equal(events.at(-1).event, 'request-completed')
    assertSafe(events)
    await delay(1)
  }
})

test('invalid observers fail configuration validation before reading a file', async () => {
  for (const onProgress of [null, false, 1, 'callback', {}]) {
    await assert.rejects(readConfiguredModel('not-read.json', new AbortController().signal, { onProgress }),
      error => error.code === 'MODEL_CONFIG')
  }
})
