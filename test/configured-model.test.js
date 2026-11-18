import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readConfiguredModel } from '../src/configured-model.js'

test('Wiki research can use a separate request budget while other callers retain the existing limit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wiki-model-budget-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'config.json')
  await writeFile(file, JSON.stringify({ judge: { url: 'https://model.invalid/chat/completions', model: 'fixture', api_key: 'test' } }))
  const bodies = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body))
    return Response.json({ choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }] })
  }
  t.after(() => { globalThis.fetch = original })
  const signal = new AbortController().signal
  const regular = await readConfiguredModel(file, signal)
  const wiki = await readConfiguredModel(file, signal, { toolCallLimit: 64 })
  const request = { messages: [], maxTokens: 20_000, signal,
    tools: [{ name: 'wiki_read', parameters: { type: 'object' } }] }
  const consume = async (adapter, options = request) => { for await (const _ of adapter.stream(options)) {} }
  for (let i = 0; i < 28; i++) await consume(regular)
  await assert.rejects(consume(regular), error => error.code === 'INVALID_REQUEST')
  // Independent reviewers do not spend the agent's tool-bearing request budget.
  await consume(regular, { ...request, tools: [] })
  for (let i = 0; i < 64; i++) await consume(wiki)
  await assert.rejects(consume(wiki), error => error.code === 'INVALID_REQUEST')
  assert.equal(bodies.length, 93)
  assert.equal(bodies[0].max_tokens, 20_000)
  await assert.rejects(readConfiguredModel(file, signal, { toolCallLimit: Infinity }), error => error.code === 'MODEL_CONFIG')
})
