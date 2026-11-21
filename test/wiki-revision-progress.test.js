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
  const blocks = new Map(checkpoint.draft.chapters.flatMap(chapter => chapter.blocks.map(block => [block.id, { chapter: chapter.id, block }])))
  const revisions = { blocks: ['purpose_text', 'usage_steps', 'execution_text', 'roles'].map(id => {
    const { chapter, block: before } = blocks.get(id), block = structuredClone(before)
    if (block.type === 'paragraph') block.text += '这里保留定向修订后的说明。'
    else if (block.type === 'steps') block.items[0].text += '同时核对使用目的。'
    else block.rows[0][1] = '由入口调用核心实现。'
    return { chapter, action: 'replace', target: id, block }
  }) }
  return { source, checkpoint, revisions }
}

function repairContext(f, submit) {
  const tools = new Map(), reviews = [], checkpoints = [], events = []
  let semantic = 0, run
  const ctx = { llm: { async *stream(options) {
    const facts = options.system.includes('事实审核员')
    if (facts) semantic++
    reviews.push(JSON.parse(options.messages[0].content[0].text))
    const result = facts && semantic === 1 ? { approved: false, issues: [{ target: 'execution_text',
      reason: '补充已读实现说明。', reads: [{ path: 'core.js', start: 2, count: 1 }] }] } : approvedWikiReview()
    yield { type: 'text-delta', text: JSON.stringify(result) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }, agents: { async create({ setup, signal }) {
    setup({ tools: { restrict() {}, register(tool) { tools.set(tool.name, tool) } } })
    return { agent: { followup(message) { run = submit(tools, signal, message) }, whenIdle: () => run, cancel() {} }, dispose() {} }
  } } }
  const pending = exploreArchitecture(ctx, f.source, { provider: 'fixture' }, null, new AbortController().signal,
    undefined, (phase, details) => events.push({ phase, ...details }),
    { checkpoint: f.checkpoint, onCheckpoint(value) { checkpoints.push(structuredClone(value)) } })
  return { pending, reviews, checkpoints, events }
}

test('four targeted changes accept two-chapter placeholder or nonempty unrelated payloads without replacing accepted research', async () => {
  for (const placeholder of [true, false]) {
    const f = fixture(), before = structuredClone(f.checkpoint)
    const plan = wikiPlanFixture(), draft = structuredClone(f.checkpoint.draft)
    plan.goal = placeholder ? '' : 'unrelated_payload_marker'
    if (placeholder) draft.chapters = ['unused_one', 'unused_two'].map(id => ({ id, title: '', blocks: [
      { id: id + '_text', type: 'paragraph', claimType: 'purpose', text: '', refs: [{ evidence: 1, start: 1, end: 1 }] },
    ] }))
    else draft.chapters[0].blocks[0].text = 'unrelated_payload_marker'
    assert.equal(draft.chapters.length, placeholder ? 2 : 4)
    const fRun = repairContext(f, async tools => {
      const result = await tools.get('wiki_publish').execute({ kind: 'revise', plan, draft, revisions: f.revisions })
      assert.match(result.status, /草稿已收到/)
    })
    const result = await fRun.pending
    assert.equal(fRun.reviews.length, 4, 'both independent reviews run again on the merged revision')
    const saved = fRun.checkpoints.at(-1)
    assert.deepEqual(saved.plan, normalizeWikiPlan(before.plan, f.source))
    assert.deepEqual(f.checkpoint, before)
    assert.deepEqual(saved.evidence.slice(0, 3), before.evidence)
    assert.equal(saved.evidence.length, 4)
    for (const change of f.revisions.blocks) {
      assert.deepEqual(saved.draft.chapters.find(chapter => chapter.id === change.chapter).blocks.find(block => block.id === change.target), change.block)
    }
    assert.deepEqual(saved.draft.graph, before.draft.graph)
    assert.deepEqual(saved.draft.coverage, before.draft.coverage)
    assert.doesNotMatch(result.markdown, /unrelated_payload_marker|unused_one/)
    assert(fRun.events.some(event => event.step === 'review-reading' && event.repair === 1))
    assert(fRun.events.some(event => event.step === 'revising' && event.reasonCategory === 'review' && event.repair === 1))
  }
})

test('invalid merged revisions stay rejected and visible until acceptance, then agent finishing precedes independent review', async () => {
  const f = fixture(), accepted = Promise.withResolvers(), finish = Promise.withResolvers()
  let fRun
  fRun = repairContext(f, async (tools, signal) => {
    const broken = structuredClone(f.revisions)
    broken.blocks[2].block.refs[0].end = 999
    const rejected = await tools.get('wiki_publish').execute({ kind: 'revise', plan: {}, draft: {}, revisions: broken })
    assert.match(rejected.status, /提交未通过/)
    const retry = fRun.events.at(-1)
    assert.equal(retry.step, 'submission-retry')
    assert.equal(retry.reasonCategory, 'validation')
    assert.equal(retry.rejections, 1)
    assert.equal(retry.repair, 1)
    assert.match(retry.retryMessage, /引用/)
    await tools.get('wiki_list').execute({}, { signal })
    assert.equal(fRun.events.at(-1).retryMessage, retry.retryMessage, 'actual supplemental work retains the preceding rejection explanation')
    assert.equal(fRun.events.at(-1).rejections, 1)
    assert.match((await tools.get('wiki_publish').execute({ kind: 'revise', revisions: f.revisions })).status, /草稿已收到/)
    accepted.resolve()
    await finish.promise
  })
  try {
    await accepted.promise
    assert.equal(fRun.events.at(-1).step, 'agent-finishing')
    assert.equal(fRun.events.at(-1).retryMessage, undefined)
    assert.equal(fRun.events.at(-1).rejections, 1)
    assert.equal(fRun.reviews.length, 2, 'the agent must finish before the next pair of reviews starts')
    finish.resolve()
    await fRun.pending
    assert.equal(fRun.reviews.length, 4)
    assert(fRun.events.some(event => event.step === 'validating' && event.retryMessage))
    assert.equal(fRun.events.at(-1).step, 'reviewing')
    assert.equal(fRun.events.at(-1).repair, 1)
  } finally { finish.resolve(); await Promise.allSettled([fRun.pending]) }
})

test('missing publication reports bounded continuation attempts without clearing the retry explanation', async () => {
  const f = fixture(), events = []
  let run, rounds = 0
  const ctx = { llm: { stream() { assert.fail('missing drafts cannot reach reviewers') } }, agents: { async create() {
    return { agent: { followup() { rounds++; run = Promise.resolve() }, whenIdle: () => run, cancel() {} }, dispose() {} }
  } } }
  await assert.rejects(exploreArchitecture(ctx, f.source, { provider: 'fixture' }, null, new AbortController().signal,
    undefined, (phase, details) => events.push({ phase, ...details }),
    { checkpoint: { plan: f.checkpoint.plan, evidence: f.checkpoint.evidence } }), /三次尝试/)
  assert.equal(rounds, 3)
  const retries = events.filter(event => event.step === 'submission-retry')
  assert.deepEqual([...new Set(retries.map(event => event.attempt))], [1, 2, 3])
  assert(retries.every(event => event.attemptLimit === 3 && event.reasonCategory === 'missing-publication' && event.retryMessage && event.rejections === 0))
  const first = events.findIndex(event => event.step === 'submission-retry')
  assert(events.slice(first).every(event => event.step === 'submission-retry'), 'continuation callbacks do not immediately replace the retry with generic writing')
})

test('a rejected revision continues with targeted changes and retains the rejection on the next bounded attempt', async () => {
  const f = fixture()
  let rounds = 0
  const fRun = repairContext(f, async (tools, _signal, message) => {
    if (rounds++ === 0) {
      const broken = structuredClone(f.revisions)
      broken.blocks[2].block.refs[0].end = 999
      assert.match((await tools.get('wiki_publish').execute({ kind: 'revise', revisions: broken })).status, /提交未通过/)
      return
    }
    assert.match(message.content[0].text, /wiki_publish\(kind=revise\)/)
    assert.match(message.content[0].text, /仅提交 revisions/)
    assert.match((await tools.get('wiki_publish').execute({ kind: 'revise', revisions: f.revisions })).status, /草稿已收到/)
  })
  await fRun.pending
  assert.equal(rounds, 2)
  assert.equal(fRun.reviews.length, 4)
  const retry = fRun.events.find(event => event.step === 'submission-retry' && event.attempt === 2)
  assert.equal(retry.attemptLimit, 3)
  assert.equal(retry.repair, 1)
  assert.equal(retry.rejections, 1)
  assert.equal(retry.reasonCategory, 'validation')
  assert.match(retry.retryMessage, /引用/)
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
