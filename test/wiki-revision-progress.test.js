import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exploreArchitecture } from '../src/architecture.js'
import { normalizeWikiDraft, normalizeWikiPlan } from '../src/wiki-document.js'
import { reviewWikiDraft } from '../src/wiki-editor.js'
import { wikiDraftFixture, wikiPlanFixture, approvedWikiReview } from '../fixtures/wiki-editorial.js'

function fixture() {
  const contents = { 'README.md': '# Example\nA useful example.', 'main.js': 'import { run } from "./core.js"\nrun()',
    'core.js': 'export const run = () => 42\nexport const extra = true' }
  const source = { owner: 'example', repo: 'project', commit: 'a'.repeat(40),
    tree: Object.keys(contents).map(path => ({ path, type: 'blob', mode: '100644' })),
    async read(path) { return Buffer.from(contents[path]) } }
  const evidence = Object.entries(contents).map(([path, text]) => ({ path, start: 1,
    end: path === 'core.js' ? 1 : 2, text: path === 'core.js' ? text.split('\n')[0] : text,
    primary: path !== 'README.md', kind: path === 'README.md' ? 'documentation' : 'source' }))
  const spans = { docs: { evidence: 1, start: 1, end: 2 }, entry: { evidence: 2, start: 1, end: 2 },
    core: { evidence: 3, start: 1, end: 1 } }
  const checkpoint = { plan: wikiPlanFixture(), draft: wikiDraftFixture(spans), evidence }
  return { source, checkpoint }
}

function publicationContext(fixture, submit) {
  const { source, checkpoint } = fixture
  const tools = new Map(), reviews = [], events = []
  let run
  const ctx = { llm: { async *stream(options) {
    reviews.push(JSON.parse(options.messages[0].content[0].text))
    yield { type: 'text-delta', text: JSON.stringify(approvedWikiReview()) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }, agents: { async create({ setup, signal }) {
    setup({ tools: { restrict() {}, register(tool) { tools.set(tool.name, tool) } } })
    return { agent: { followup(message) { run = submit(tools, signal, message) }, whenIdle: () => run, cancel() {} }, dispose() {} }
  } } }
  const pending = exploreArchitecture(ctx, source, { provider: 'fixture' }, null, new AbortController().signal,
    undefined, (phase, details) => events.push({ phase, ...details }),
    { checkpoint: { plan: checkpoint.plan, evidence: checkpoint.evidence } })
  return { pending, reviews, events }
}

function invalidDraft(draft) {
  const invalid = structuredClone(draft)
  invalid.chapters[2].blocks[0].refs[0].end = 999
  return invalid
}

test('invalid citations remain visible until correction, then author finishing precedes advisory review', async () => {
  const f = fixture(), accepted = Promise.withResolvers(), finish = Promise.withResolvers()
  const run = publicationContext(f, async (tools, signal) => {
    const publish = tools.get('wiki_publish')
    const rejected = await publish.execute({ kind: 'draft', draft: invalidDraft(f.checkpoint.draft) })
    assert.match(rejected.status, /提交未通过/)
    const retry = run.events.at(-1)
    assert.equal(retry.step, 'submission-retry')
    assert.equal(retry.reasonCategory, 'validation')
    assert.equal(retry.rejections, 1)
    assert.match(retry.retryMessage, /引用/)
    await tools.get('wiki_list').execute({}, { signal })
    assert.equal(run.events.at(-1).retryMessage, retry.retryMessage)
    assert.match((await publish.execute({ kind: 'draft', draft: f.checkpoint.draft })).status, /草稿已收到/)
    accepted.resolve()
    await finish.promise
  })
  try {
    await Promise.race([accepted.promise, run.pending])
    assert.equal(run.events.at(-1).step, 'agent-finishing')
    assert.equal(run.events.at(-1).retryMessage, undefined)
    assert.equal(run.events.at(-1).rejections, 1)
    assert.equal(run.reviews.length, 0)
    finish.resolve()
    const result = await run.pending
    assert.deepEqual(result.review, { status: 'approved' })
    assert.equal(run.reviews.length, 2)
    assert(run.events.some(event => event.step === 'validating' && event.retryMessage))
    assert.equal(run.events.at(-1).step, 'reviewing')
  } finally { finish.resolve(); await Promise.allSettled([run.pending]) }
})

test('missing publication reports bounded continuation attempts without clearing the retry explanation', async () => {
  const f = fixture()
  let rounds = 0
  const run = publicationContext(f, async () => { rounds++ })
  await assert.rejects(run.pending, /三次尝试/)
  assert.equal(rounds, 3)
  assert.equal(run.reviews.length, 0)
  const retries = run.events.filter(event => event.step === 'submission-retry')
  assert.deepEqual([...new Set(retries.map(event => event.attempt))], [1, 2, 3])
  assert(retries.every(event => event.attemptLimit === 3 && event.reasonCategory === 'missing-publication' && event.retryMessage && event.rejections === 0))
  const first = run.events.findIndex(event => event.step === 'submission-retry')
  assert(run.events.slice(first).every(event => event.step === 'submission-retry'))
})

test('rejected structural submissions continue with the validation reason on the next bounded attempt', async () => {
  const f = fixture()
  let rounds = 0
  const run = publicationContext(f, async (tools, _signal, message) => {
    const publish = tools.get('wiki_publish')
    if (rounds++ === 0) {
      assert.match((await publish.execute({ kind: 'draft', draft: invalidDraft(f.checkpoint.draft) })).status, /提交未通过/)
      return
    }
    assert.match(message.content[0].text, /wiki_publish\(kind=draft\)/)
    assert.match(message.content[0].text, /最近校验反馈/)
    assert.match((await publish.execute({ kind: 'draft', draft: f.checkpoint.draft })).status, /草稿已收到/)
  })
  assert.deepEqual((await run.pending).review, { status: 'approved' })
  assert.equal(rounds, 2)
  assert.equal(run.reviews.length, 2)
  const retry = run.events.find(event => event.step === 'submission-retry' && event.attempt === 2)
  assert.equal(retry.attemptLimit, 3)
  assert.equal(retry.rejections, 1)
  assert.equal(retry.reasonCategory, 'validation')
  assert.match(retry.retryMessage, /引用/)
})

function heldReview() {
  const started = Promise.withResolvers(), release = Promise.withResolvers(), signals = []
  const ctx = { llm: { async *stream({ signal }) {
    signals.push(signal)
    if (signals.length === 2) started.resolve()
    await release.promise
    yield { type: 'text-delta', text: JSON.stringify(approvedWikiReview()) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }, agents: { create() { assert.fail('a validated checkpoint does not need an author') } } }
  return { ctx, started: started.promise, release: release.resolve, signals }
}

test('an advisory deadline publishes the Wiki even if the model does not honor cancellation', async t => {
  const f = fixture(), held = heldReview(), deadline = new AbortController()
  t.after(held.release)
  const timeout = t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 75_000)
    return deadline.signal
  })
  const pending = exploreArchitecture(held.ctx, f.source, { provider: 'fixture' }, null, new AbortController().signal,
    undefined, undefined, { checkpoint: f.checkpoint })
  await Promise.race([held.started, pending])
  assert.equal(timeout.mock.callCount(), 1)
  deadline.abort(new DOMException('Review deadline reached', 'TimeoutError'))
  const result = await pending
  assert(held.signals.every(signal => signal.aborted))
  assert.deepEqual(result.review, { status: 'unavailable' })
  assert.match(result.markdown, /export const run/)
})

test('external cancellation interrupts advisory review without publishing and retains the validated checkpoint', async t => {
  const f = fixture(), held = heldReview(), controller = new AbortController(), checkpoints = []
  t.after(held.release)
  const pending = exploreArchitecture(held.ctx, f.source, { provider: 'fixture' }, null, controller.signal,
    undefined, undefined, { checkpoint: f.checkpoint, onCheckpoint(value) { checkpoints.push(value) } })
  await Promise.race([held.started, pending])
  const reason = new DOMException('Generation cancelled', 'AbortError')
  controller.abort(reason)
  await assert.rejects(pending, error => error === reason)
  assert(held.signals.every(signal => signal.aborted))
  assert.deepEqual(checkpoints, [{ ...f.checkpoint, plan: normalizeWikiPlan(f.checkpoint.plan, f.source) }])
})

test('review feedback format repair reports its own bounded attempt without adding an independent review round', async () => {
  const f = fixture(), retries = []
  let semantic = 0, calls = 0
  const llm = { async *stream(options) {
    calls++
    const invalid = options.system.includes('事实审核员') && ++semantic === 1
    yield { type: 'text-delta', text: invalid ? 'not JSON' : JSON.stringify(approvedWikiReview()) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const plan = normalizeWikiPlan(f.checkpoint.plan, f.source)
  const draft = normalizeWikiDraft(f.checkpoint.draft, f.source, f.checkpoint.evidence, plan)
  const result = await reviewWikiDraft(llm, { provider: 'fixture' }, draft, plan, f.checkpoint.evidence, f.source,
    new AbortController().signal, retry => retries.push(retry))
  assert.equal(result.approved, true)
  assert.equal(calls, 3)
  assert.equal(retries.length, 1)
  assert.equal(retries[0].attempt, 2)
  assert.equal(retries[0].attemptLimit, 2)
  assert.match(retries[0].retryMessage, /合法 JSON/)
})
