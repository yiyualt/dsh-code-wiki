import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeWikiPlan, normalizeWikiDraft, renderWikiDocument, reviseWikiDraft, wikiReviewMaterial } from '../src/wiki-document.js'
import { reviewWikiDraft, wikiPublicationSchema, wikiResearchInstructions } from '../src/wiki-editor.js'
import { wikiPlanFixture, wikiDraftFixture, wikiDiagramFixture, approvedWikiReview, withWikiModuleCases,
  withChapterDiagramPlan, withChapterDiagrams } from '../fixtures/wiki-editorial.js'

function fixture() {
  const contents = { 'README.md': '# 示例\n项目提供可重复调用的模块示例。',
    'main.js': 'import { run } from "./core.js"\nrun()\n',
    'core.js': 'export { helper } from "./helper.js"\nexport const run = () => 42\n' }
  const source = { owner: 'example', repo: 'project', commit: 'a'.repeat(40),
    tree: Object.keys(contents).map(path => ({ path, type: 'blob', mode: '100644' })),
    async read(path) { return Buffer.from(contents[path]) } }
  const evidence = Object.entries(contents).map(([path, text]) => ({ path, start: 1, end: text.trimEnd().split('\n').length,
    text: text.trimEnd(), primary: path !== 'README.md', kind: path === 'README.md' ? 'documentation' : 'source' }))
  const spans = { docs: { evidence: 1, start: 1, end: 2 }, entry: { evidence: 2, start: 1, end: 2 }, core: { evidence: 3, start: 2, end: 2 } }
  const plan = normalizeWikiPlan(wikiPlanFixture(), source)
  return { source, evidence, spans, plan, raw: wikiDraftFixture(spans) }
}

test('file tables render generated relative link notation as file names with the verified citations below', () => {
  const { source, evidence, raw, plan } = fixture()
  const table = raw.chapters[2].blocks.find(block => block.type === 'table')
  table.columns = ['关键文件', '职责']
  table.rows = [['[core.js](<core.js#L2>)、[main.js](./main.js#L1-L2)', '入口与核心实现。']]
  const { markdown } = renderWikiDocument(normalizeWikiDraft(raw, source, evidence, plan), source)
  assert.match(markdown, /\| \x60core\.js\x60、\x60main\.js\x60 \| 入口与核心实现。 \|/)
  assert.match(markdown, /\/core\.js#L2\)/)
  assert.doesNotMatch(markdown, /\\\[core\.js\\\]/)
})

test('redesigned chapters require planned figures and source-backed interface contracts', () => {
  const { source, evidence, spans } = fixture()
  const input = withChapterDiagramPlan(wikiPlanFixture())
  const incomplete = structuredClone(input)
  delete incomplete.chapters[2].diagrams
  assert.throws(() => normalizeWikiPlan(incomplete, source), /章节 execution 的计划图示/)
  const plan = normalizeWikiPlan(input, source)
  const raw = withChapterDiagrams(withWikiModuleCases(wikiDraftFixture(spans), spans), spans)
  raw.chapters[2].blocks = raw.chapters[2].blocks.filter(block => block.type !== 'table' && block.type !== 'paragraph')
  const rendered = renderWikiDocument(normalizeWikiDraft(raw, source, evidence, plan), source)
  assert.deepEqual(rendered.views.map(view => [view.chapter, view.kind]), [[0, 'scenario'], [1, 'component'], [2, 'sequence'], [3, 'component']])
  assert.equal(rendered.markdown.match(/^### 设计细节$/gm).length, 4)
  assert.match(rendered.markdown, /边界在哪里？[\s\S]+```mermaid[\s\S]+输入：Import the named binding from core\.js\.[\s\S]+### 设计细节/)
  assert.doesNotMatch(rendered.markdown, /```dsh-architecture/)
  const diagram = raw.chapters[1].blocks.find(block => block.type === 'diagram')
  const first = diagram.edges[0], second = diagram.edges[1]
  const old = second.contract.entry
  second.contract.entry = first.contract.entry
  assert.throws(() => normalizeWikiDraft(raw, source, evidence, plan), /章节 architecture .* 2 个不同的接口/)
  second.contract.entry = old
  second.refs = [{ ...spans.docs }]
  assert.throws(() => normalizeWikiDraft(raw, source, evidence, plan), /图示关系引用.*有效实现证据/)
  second.refs = [{ ...spans.entry }]
  const scenario = raw.chapters[0].blocks.find(block => block.type === 'diagram').edges[0]
  scenario.contract = { entry: 'main.js', input: 'Load the demo.', output: 'The entry calls run.' }
  assert.throws(() => normalizeWikiDraft(raw, source, evidence, plan), /overview_diagram.+接口至少需要一项有效实现证据/)
  scenario.refs.push({ ...spans.entry })
  const withDocumentedUsage = normalizeWikiDraft(raw, source, evidence, plan)
  const accepted = withDocumentedUsage.chapters[0].blocks.find(block => block.type === 'diagram').edges[0]
  assert.equal(accepted.refs.length, 2)
  scenario.contract = { entry: '', input: '', output: '' }
  assert.equal(normalizeWikiDraft(raw, source, evidence, plan).chapters[0].blocks.find(block => block.type === 'diagram').edges[0].contract, undefined)
  const sequence = raw.chapters[2].blocks.find(block => block.type === 'diagram')
  sequence.edges.push({ from: 'core', to: 'core', label: 'Compute result', refs: [{ ...spans.core }] })
  assert.equal(normalizeWikiDraft(raw, source, evidence, plan).chapters[2].blocks.find(block => block.type === 'diagram').edges.length, 3)
  sequence.edges.at(-1).to = 'missing'
  assert.throws(() => normalizeWikiDraft(raw, source, evidence, plan), /execution_diagram.*core → missing.*未声明的节点/)
})

test('Wiki plans use the fixed skeleton with one chapter per module and reject imaginary research files', () => {
  const { source, plan } = fixture()
  assert.equal(plan.chapters.length, 4)
  assert.deepEqual(plan.chapters.map(chapter => chapter.role), ['overview', 'architecture', 'module', 'module'])
  assert.deepEqual(plan.modules.map(module => module.id), ['entry', 'core'])
  const bad = wikiPlanFixture(); bad.research[0].paths = ['missing.md']
  assert.throws(() => normalizeWikiPlan(bad, source), /实际存在/)
  const missingViewReason = wikiPlanFixture(); delete missingViewReason.viewOmission
  assert.throws(() => normalizeWikiPlan(missingViewReason, source), /额外视图的理由/)
})

test('Wiki publication schema exposes the normalizer array bounds before a draft is submitted', () => {
  const properties = wikiPublicationSchema.properties
  const plan = properties.plan.properties, draft = properties.draft.properties
  const block = draft.chapters.items.properties.blocks.items.properties
  const bounds = schema => [schema.minItems, schema.maxItems]
  for (const [schema, expected] of [
    [plan.chapters, [4, 8]], [plan.research, [2, 8]], [plan.research.items.properties.paths, [1, 6]], [plan.views, [0, 3]],
    [plan.modules, [2, 5]], [plan.modules.items.properties.paths, [1, 6]], [plan.chapters.items.properties.diagrams, [1, 2]],
    [draft.chapters, [4, 8]], [draft.chapters.items.properties.blocks, [1, 14]], [draft.coverage, [2, 8]],
    [block.items, [2, 7]], [block.columns, [2, 5]], [block.rows, [1, 8]], [block.rows.items, [2, 5]],
    [block.inlineCode, [0, 8]], [block.nodes, [2, 8]], [block.edges, [1, 16]], [block.rules, [2, 4]],
    [draft.graph.properties.layers, [2, 5]], [draft.graph.properties.layers.items.properties.nodes, [1, 8]],
    [draft.graph.properties.edges, [2, 24]],
  ]) assert.deepEqual(bounds(schema), expected)
  assert(block.type.enum.includes('module-case'))
  assert.deepEqual(block.boundary.required, ['condition', 'result', 'refs'])
  assert.deepEqual(block.change.required, ['goal', 'location', 'refs'])
  assert.deepEqual(block.verification.required, ['action', 'expected', 'refs'])
  let refLocations = 0
  const visit = schema => {
    if (schema.type === 'array') {
      assert.ok(Number.isInteger(schema.minItems) && Number.isInteger(schema.maxItems), 'all submitted collections have explicit bounds')
      visit(schema.items)
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (name === 'refs') { refLocations++; assert.deepEqual(bounds(child), [1, 6]) }
      visit(child)
    }
  }
  visit(wikiPublicationSchema)
  assert.equal(refLocations, 15)
  assert.match(wikiResearchInstructions, /超过 25 行会按 25 行拆分且拆分后总数仍不能超过 6 项/)
  const { raw, source, evidence, plan: acceptedPlan, spans } = fixture()
  raw.chapters[0].blocks[0].refs = Array(7).fill(spans.docs)
  assert.throws(() => normalizeWikiDraft(raw, source, evidence, acceptedPlan), /引用 需要 1–6 项/)
})

test('the author publication schema asks only for a plan and draft', () => {
  const schema = wikiPublicationSchema.properties
  assert.deepEqual(schema.kind.enum, ['plan', 'draft'])
  assert.equal(schema.revisions, undefined)
  assert.doesNotMatch(wikiResearchInstructions, /kind=revise/)
})

test('targeted Wiki revisions replace, insert and delete blocks without mutating the original or their supplied replacements', () => {
  const { source, evidence, plan, raw } = fixture()
  const original = structuredClone(raw)
  const replacement = { ...structuredClone(raw.chapters[2].blocks[0]), text: 'main.js 调用独立的核心实现。' }
  const inserted = { ...structuredClone(raw.chapters[0].blocks[0]), id: 'purpose_details', text: '项目说明支持这一用途。' }
  const revisions = { blocks: [
    { chapter: 'execution', action: 'replace', target: 'execution_text', block: replacement },
    { chapter: 'overview', action: 'insert_after', target: 'purpose_text', block: inserted },
    { chapter: 'overview', action: 'delete', target: 'usage_steps' },
  ], graph: structuredClone(raw.graph), coverage: structuredClone(raw.coverage) }
  const next = reviseWikiDraft(raw, revisions)
  normalizeWikiDraft(next, source, evidence, plan)
  assert.deepEqual(raw, original)
  assert.deepEqual(next.chapters[0].blocks.map(block => block.id), ['purpose_text', 'purpose_details', 'layout_table'])
  assert.equal(next.chapters[2].blocks[0].text, replacement.text)
  assert.deepEqual(next.chapters[2].blocks.slice(1), original.chapters[2].blocks.slice(1))
  next.chapters[2].blocks[0].text = '本地副本变更'
  next.graph.edges[0].label = '本地关系变更'
  next.coverage[0].refs[0].start = 99
  assert.equal(replacement.text, 'main.js 调用独立的核心实现。')
  assert.deepEqual(revisions.graph, original.graph)
  assert.deepEqual(revisions.coverage, original.coverage)
  assert.deepEqual(raw, original)
})

test('unknown revision targets and invalid evidence cannot change the accepted raw Wiki draft', () => {
  const { source, evidence, plan, raw } = fixture()
  const original = structuredClone(raw)
  const replacement = { ...structuredClone(raw.chapters[2].blocks[0]), text: 'main.js 的新解释。' }
  assert.throws(() => reviseWikiDraft(raw, { blocks: [
    { chapter: 'execution', action: 'replace', target: 'execution_text', block: replacement },
    { chapter: 'overview', action: 'delete', target: 'missing_block' },
  ] }), /已有章节和正文块：missing_block/)
  assert.deepEqual(raw, original)
  const bad = structuredClone(replacement); bad.refs[0].end = 99
  const candidate = reviseWikiDraft(raw, { blocks: [{ chapter: 'execution', action: 'replace', target: 'execution_text', block: bad }] })
  assert.throws(() => normalizeWikiDraft(candidate, source, evidence, plan), /不能丢弃/)
  assert.deepEqual(raw, original)
  const renamed = { ...replacement, id: 'renamed_block' }
  assert.throws(() => reviseWikiDraft(raw, { blocks: [{ chapter: 'execution', action: 'replace', target: 'execution_text', block: renamed }] }), /保留原来的 block.id/)
  assert.deepEqual(raw, original)
})

test('unchanged Wiki revision blocks, graph and coverage are rejected while an actual graph-only correction remains valid', () => {
  const { source, evidence, plan, raw } = fixture()
  const original = structuredClone(raw)
  for (const revisions of [
    { blocks: [] },
    { blocks: [], graph: structuredClone(raw.graph), coverage: structuredClone(raw.coverage) },
    { blocks: [{ chapter: 'execution', action: 'replace', target: 'execution_text', block: structuredClone(raw.chapters[2].blocks[0]) }] },
  ]) {
    assert.throws(() => reviseWikiDraft(raw, revisions), /实际改动|没有改变草稿/)
    assert.deepEqual(raw, original)
  }
  const graph = structuredClone(raw.graph); graph.edges[0].label = '导入核心函数并调用'
  const changed = reviseWikiDraft(raw, { blocks: [], graph })
  normalizeWikiDraft(changed, source, evidence, plan)
  assert.deepEqual(changed.chapters, original.chapters)
  assert.deepEqual(changed.coverage, original.coverage)
  assert.deepEqual(raw, original)
})

test('Wiki plan feedback lists every invalid candidate and distinguishes directories from absent files', () => {
  const { source } = fixture()
  source.tree.push({ path: 'tests', type: 'tree' }, { path: 'docs/guide.md', type: 'blob' })
  const plan = wikiPlanFixture()
  plan.research[0].paths = ['tests/', 'missing-a.md', 'README.md']
  plan.research[1].paths = ['docs/', 'missing-b.js', 'missing-a.md', 'main.js']
  assert.throws(() => normalizeWikiPlan(plan, source), error => {
    assert.match(error.message, /目录：tests\//)
    assert.match(error.message, /目录：docs\//)
    assert.match(error.message, /不存在文件：missing-a.md/)
    assert.match(error.message, /不存在文件：missing-b.js/)
    assert.equal((error.message.match(/missing-a.md/g) ?? []).length, 1)
    assert.doesNotMatch(error.message, /无效候选：[^。]*README.md/)
    assert.match(error.message, /wiki_list/)
    return error.code === 'model-output-invalid'
  })
})

function diagramFixture(kind = 'sequence') {
  const f = fixture()
  const rawPlan = wikiPlanFixture()
  rawPlan.views = [{ kind, question: '入口与核心如何协作？', why: '用特定的软件视图说明总览图没有表达的协作问题。' }]
  f.plan = normalizeWikiPlan(rawPlan, f.source)
  f.diagram = wikiDiagramFixture(f.spans, kind)
  f.raw.chapters[2].blocks.push(f.diagram)
  return f
}

test('multiple inserted paragraphs retain author order after the same anchor', () => {
  const { raw } = fixture()
  const before = structuredClone(raw)
  const names = ['experiment_entry', 'experiment_protocol', 'experiment_result']
  const blocks = names.map(id => ({ ...structuredClone(raw.chapters[0].blocks[0]), id, text: id }))
  const next = reviseWikiDraft(raw, { blocks: blocks.map(block => ({ chapter: 'overview', action: 'insert_after', target: 'purpose_text', block })) })
  assert.deepEqual(next.chapters[0].blocks.map(block => block.id), ['purpose_text', ...names, 'usage_steps', 'layout_table'])
  assert.deepEqual(raw, before)
})

test('controlled Wiki sequence views preserve message order, public evidence and exact Mermaid metadata', () => {
  const { source, evidence, plan, raw } = diagramFixture()
  const draft = normalizeWikiDraft(raw, source, evidence, plan)
  const result = renderWikiDocument(draft, source)
  assert.equal(result.views.length, 1)
  const view = result.views[0]
  assert.equal(view.kind, 'sequence')
  assert.deepEqual(view.edges.map(edge => [edge.from, edge.to, edge.label]), [['entry', 'core', '调用'], ['core', 'entry', '返回结果']])
  assert.match(view.mermaid, /^sequenceDiagram\n/)
  assert(view.mermaid.indexOf('n_entry->>n_core') < view.mermaid.indexOf('n_core->>n_entry'))
  assert(!view.mermaid.endsWith('\n'))
  assert(result.markdown.includes('```mermaid\n' + view.mermaid + '\n```'))
  assert.deepEqual(Object.keys(view.nodes[0].refs[0]), ['label', 'url'])
  assert.deepEqual(Object.keys(view.edges[0].refs[0]), ['label', 'url'])
  const again = renderWikiDocument(draft, source)
  assert.deepEqual(again.views, result.views)
})

test('a sequence can add return messages to a ten-message draft within its own message limit', () => {
  const sequence = diagramFixture()
  const { source, evidence, plan, raw, diagram } = sequence
  const [call, reply] = diagram.edges
  diagram.edges = [...Array.from({ length: 10 }, (_, index) => ({ ...call, label: `Call ${index + 1}` })),
    ...Array.from({ length: 3 }, (_, index) => ({ ...reply, label: `Return ${index + 1}` }))]
  const [view] = renderWikiDocument(normalizeWikiDraft(raw, source, evidence, plan), source).views
  assert.equal(view.edges.length, 13)
  assert.match(view.mermaid, /n_core->>n_entry: Return 1[\s\S]*n_core->>n_entry: Return 3$/)
  diagram.edges.push(...Array(4).fill(reply))
  assert.throws(() => normalizeWikiDraft(raw, source, evidence, plan), /图示关系 需要 1–16 项/)

  const flow = diagramFixture('flow')
  flow.diagram.edges = Array.from({ length: 11 }, (_, index) => ({ ...flow.diagram.edges[0], label: `Step ${index + 1}` }))
  assert.throws(() => normalizeWikiDraft(flow.raw, flow.source, flow.evidence, flow.plan), /图示关系 需要 1–10 项/)
})

test('derived Mermaid encodes punctuation in labels without adding executable diagram statements or fences', () => {
  const f = diagramFixture('flow')
  f.diagram.nodes[0].label = '入口"]; click x "javascript:alert(1)" ```'
  f.diagram.edges[0].label = '传递 | 下一步 -> 输出'
  const result = renderWikiDocument(normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan), f.source)
  const body = result.views[0].mermaid
  assert.match(body, /#34;/)
  assert.match(body, /#59;/)
  assert.match(body, /#124;/)
  assert.doesNotMatch(body, /```|^\s*click\s|^\s*%%\{/m)
  assert(result.markdown.includes('```mermaid\n' + body + '\n```'))
})

test('scenario views can use documented actors and goals while deployment and data diagrams require actual implementation refs', () => {
  const scenario = diagramFixture('scenario')
  const result = renderWikiDocument(normalizeWikiDraft(scenario.raw, scenario.source, scenario.evidence, scenario.plan), scenario.source)
  assert.equal(result.views[0].nodes[0].role, 'actor')
  for (const kind of ['deployment', 'dataflow', 'dependency', 'flow', 'sequence']) {
    const f = diagramFixture(kind)
    f.diagram.claimType = 'usage'
    f.diagram.nodes[0].refs = [f.spans.docs]
    assert.throws(() => normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan), /实现证据/)
  }
})

test('Wiki view planning rejects unplanned, missing and raw Mermaid diagrams without silently dropping them', () => {
  const f = diagramFixture('dataflow')
  const raw = structuredClone(f.raw)
  raw.chapters[2].blocks.pop()
  assert.throws(() => normalizeWikiDraft(raw, f.source, f.evidence, f.plan), /逐一回答/)
  f.diagram.kind = 'deployment'
  assert.throws(() => normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan), /研究计划/)
  f.diagram.kind = 'dataflow'; f.diagram.mermaid = 'flowchart LR\n arbitrary[unverified]'
  assert.throws(() => normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan), /程序生成/)
  delete f.diagram.mermaid
  f.diagram.edges[0].to = 'missing'
  assert.throws(() => normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan), /未声明的节点/)
})

test('every diagram node and message citation is included in independent reviewer evidence', async () => {
  const f = diagramFixture('sequence')
  f.diagram.edges[1].refs = [{ ...f.spans.core, start: 1, end: 1 }]
  const draft = normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan)
  let calls = 0
  const llm = { async *stream(options) {
    calls++
    const context = JSON.parse(options.messages[0].content[0].text)
    assert(context.excerpts.some(item => item.id === 3 && item.start === 1 && item.end === 1))
    assert.equal(context.draft.chapters[2].blocks.at(-1).edges[1].label, '返回结果')
    const response = options.system.includes('事实审核员')
      ? { approved: false, issues: [{ target: 'sequence_view', reason: '该导出不证明返回消息，需修正时序或补读。', reads: [] }] }
      : approvedWikiReview()
    yield { type: 'text-delta', text: JSON.stringify(response) }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const review = await reviewWikiDraft(llm, {}, draft, f.plan, f.evidence, f.source, new AbortController().signal)
  assert.equal(calls, 2)
  assert.equal(review.approved, false)
  assert.equal(review.issues[0].target, 'sequence_view')
})

test('Wiki purpose can cite project documents while behavior and diagram require implementation evidence', () => {
  const { source, evidence, plan, raw, spans } = fixture()
  const normalized = normalizeWikiDraft(raw, source, evidence, plan)
  assert.equal(normalized.chapters[0].blocks[0].refs[0].evidence, 1)
  const behavior = structuredClone(raw); behavior.chapters[2].blocks[0].refs = [spans.docs]
  assert.throws(() => normalizeWikiDraft(behavior, source, evidence, plan), /实现证据/)
  const diagram = structuredClone(raw); diagram.graph.layers[0].nodes[0].refs = [spans.docs]
  assert.throws(() => normalizeWikiDraft(diagram, source, evidence, plan), /实现证据/)
  const uncovered = structuredClone(raw); uncovered.coverage[1] = uncovered.coverage[0]
  assert.throws(() => normalizeWikiDraft(uncovered, source, evidence, plan), /每个研究领域/)
})

test('Wiki blocks retain paragraphs, steps, exact code, tables and compact pinned citations without filtering invalid claims', () => {
  const { source, evidence, plan, raw } = fixture()
  const draft = normalizeWikiDraft(raw, source, evidence, plan)
  const result = renderWikiDocument(draft, source)
  assert.match(result.markdown, /\n\n这个项目/)
  assert.match(result.markdown, /1\. 先阅读/)
  assert.match(result.markdown, /```javascript\nexport const run = \(\) => 42\n```/)
  assert.match(result.markdown, /`main.js`/)
  assert.match(result.markdown, /\| 组件 \| 职责 \|/)
  assert.match(result.markdown, /\[1\]\(https:\/\/github.com\/example\/project\/blob\/a{40}\/README.md#L1-L2\)/)
  assert.match(result.markdown, /### 本章引用/)
  assert.match(result.markdown, /\n## 系统组成\n\n[^\n]+[^\n]*\n\n```dsh-architecture\n```/,
    'the architecture chapter carries the placeholder the page turns into the interactive graph')
  assert.deepEqual(Object.keys(result.architecture.layers[0].nodes[0].refs[0]), ['label', 'url'])
  const bad = structuredClone(raw); bad.chapters[2].blocks[0].refs[0].end = 99
  assert.throws(() => normalizeWikiDraft(bad, source, evidence, plan), /不能丢弃/)
  const noPlan = () => normalizeWikiDraft(raw, source, evidence)
  assert.throws(noPlan, /先提交研究计划/)
})

test('optional inline-code hints ignore stale or unsafe terms while preserving every word and evidence requirement', () => {
  const { source, evidence, plan, raw } = fixture()
  const block = raw.chapters[2].blocks[0]
  block.text += ' 原文保留 `标记`、a|b 和多\n行文字。'
  block.inlineCode = ['Config', 'main.js', 'main.js', '`标记`', 'a|b', '多\n行文字', '', null, 'x'.repeat(81)]
  const normalized = normalizeWikiDraft(raw, source, evidence, plan)
  const clean = structuredClone(raw); delete clean.chapters[2].blocks[0].inlineCode
  const expected = normalizeWikiDraft(clean, source, evidence, plan)
  assert.equal(normalized.chapters[2].blocks[0].text, expected.chapters[2].blocks[0].text)
  assert.deepEqual(normalized.chapters[2].blocks[0].refs, expected.chapters[2].blocks[0].refs)
  assert.deepEqual(normalized.chapters[2].blocks[0].inlineCode, ['main.js'])
  assert.match(renderWikiDocument(normalized, source).markdown, /`main.js` 导入核心函数/)
  block.inlineCode = 'main.js'
  assert.deepEqual(normalizeWikiDraft(raw, source, evidence, plan).chapters[2].blocks[0].inlineCode, [])
  block.refs[0].end = 99
  assert.throws(() => normalizeWikiDraft(raw, source, evidence, plan), /不能丢弃/)
})

test('independent Wiki reviewers see each cited range including import-only evidence and validate further reads', async () => {
  const { source, evidence, plan, raw, spans } = fixture()
  raw.chapters[2].blocks[0].refs = [{ ...spans.core, start: 1, end: 1 }]
  const draft = normalizeWikiDraft(raw, source, evidence, plan)
  const context = wikiReviewMaterial(draft, plan, evidence)
  assert(context.excerpts.some(item => item.id === 3 && item.start === 1 && item.end === 1 && item.text.startsWith('export { helper }')))
  const roles = []
  const llm = { async *stream(options) {
    roles.push(options.system)
    const result = options.system.includes('事实审核员')
      ? { approved: false, issues: [{ target: 'execution_text', reason: '该导入未证明具体运行行为，需要读取实现。', reads: [{ path: 'core.js', start: 2, count: 1 }] }] }
      : approvedWikiReview()
    yield { type: 'text-delta', text: JSON.stringify(result) }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const review = await reviewWikiDraft(llm, {}, draft, plan, evidence, source, new AbortController().signal)
  assert.equal(roles.length, 2)
  assert.equal(review.approved, false)
  assert.equal(review.issues[0].reads[0].start, 2)
})

test('revision review retains unresolved targets while excluding unrelated accepted blocks', async () => {
  const { source, evidence, plan, raw } = fixture()
  const before = normalizeWikiDraft(raw, source, evidence, plan)
  const issue = { target: 'execution_text', reason: '需要查证入口调用。', reads: [] }
  const previous = { draft: before, review: { semantic: { approved: false, issues: [issue] },
    editorial: { approved: false, issues: [{ target: 'usage_steps', reason: '与模块说明重复。', reads: [] }] } } }
  const required = raw.chapters[0].blocks[0]
  required.text = '项目提供可重复调用的模块示例。'
  raw.chapters[0].blocks.splice(1, 1)
  const after = normalizeWikiDraft(raw, source, evidence, plan)
  const calls = []
  const llm = { async *stream(options) {
    const context = JSON.parse(options.messages[0].content[0].text)
    const isSemantic = options.system.includes('事实审核员')
    calls.push(isSemantic ? 'semantic' : 'editorial')
    assert.match(options.system, /定向复审/)
    assert.deepEqual(context.revision.changedTargets, ['purpose_text'])
    assert.deepEqual(context.revision.removedTargets, ['usage_steps'])
    assert.deepEqual(context.revision.pendingIssues, isSemantic ? [issue] : [])
    assert.deepEqual(context.targets, isSemantic ? ['purpose_text', 'execution_text'] : ['purpose_text'])
    const response = isSemantic ? { approved: false, issues: [issue] } : approvedWikiReview()
    yield { type: 'text-delta', text: JSON.stringify(response) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const result = await reviewWikiDraft(llm, {}, after, plan, evidence, source, new AbortController().signal, undefined, previous)
  assert.deepEqual(calls, ['semantic', 'editorial'])
  assert.equal(result.approved, false)
  assert.deepEqual(result.issues, [{ ...issue, reviewer: 'semantic' }])
})

test('a malformed reviewer range receives one precise format retry without discarding its factual issue or rerunning its sibling', async () => {
  const { source, evidence, plan, raw } = fixture()
  const draft = normalizeWikiDraft(raw, source, evidence, plan)
  const counts = { semantic: 0, editorial: 0 }
  const llm = { async *stream(options) {
    const kind = options.system.includes('事实审核员') ? 'semantic' : 'editorial'
    counts[kind]++
    assert.match(options.system, /每项意见最多3个范围/)
    assert.match(options.system, /count为1–95的整数/)
    let response = approvedWikiReview()
    if (kind === 'semantic') {
      if (counts.semantic === 2) {
        assert.equal(options.messages.length, 3)
        assert.match(options.messages[1].content[0].text, /"count":180/)
        assert.match(options.messages[2].content[0].text, /execution_text.reads\[0\]/)
        assert.match(options.messages[2].content[0].text, /不要因格式错误把不通过改成通过/)
      }
      response = { approved: false, issues: [{ target: 'execution_text', reason: '需要实现证明该段运行行为。',
        reads: counts.semantic === 1 ? [{ path: 'core.js', start: 1, count: 180 }]
          : [{ path: 'core.js', start: 1, count: 95 }, { path: 'core.js', start: 96, count: 85 }] }] }
    }
    yield { type: 'text-delta', text: JSON.stringify(response) }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const result = await reviewWikiDraft(llm, {}, draft, plan, evidence, source, new AbortController().signal)
  assert.deepEqual(counts, { semantic: 2, editorial: 1 })
  assert.equal(result.approved, false)
  assert.equal(result.issues[0].reason, '需要实现证明该段运行行为。')
  assert.deepEqual(result.issues[0].reads, [{ path: 'core.js', start: 1, count: 95 }, { path: 'core.js', start: 96, count: 85 }])
})

test('repeated malformed reviewer paths fail after one format repair and do not treat a directory as source evidence', async () => {
  const { source, evidence, plan, raw } = fixture()
  source.tree.push({ path: 'docs', type: 'tree' })
  const draft = normalizeWikiDraft(raw, source, evidence, plan)
  const counts = { semantic: 0, editorial: 0 }
  const llm = { async *stream(options) {
    const kind = options.system.includes('事实审核员') ? 'semantic' : 'editorial'
    counts[kind]++
    const response = kind === 'semantic' ? { approved: false, issues: [{ target: 'execution_text', reason: '补读实现。',
      reads: [{ path: 'docs', start: 1, count: 20 }] }] } : approvedWikiReview()
    yield { type: 'text-delta', text: JSON.stringify(response) }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  await assert.rejects(reviewWikiDraft(llm, {}, draft, plan, evidence, source, new AbortController().signal),
    error => error.code === 'model-output-invalid' && /execution_text.reads\[0\]/.test(error.message) && /不能是目录/.test(error.message))
  assert.deepEqual(counts, { semantic: 2, editorial: 1 })
})

test('a reviewer provider failure propagates without spending the format repair attempt', async () => {
  const { source, evidence, plan, raw } = fixture()
  const draft = normalizeWikiDraft(raw, source, evidence, plan)
  let semanticCalls = 0
  const llm = { async *stream(options) {
    if (options.system.includes('事实审核员')) {
      semanticCalls++
      yield { type: 'finish', reason: { kind: 'error', error: { code: 'AUTH', status: 401 } } }
    } else {
      yield { type: 'text-delta', text: JSON.stringify(approvedWikiReview()) }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
  } }
  await assert.rejects(reviewWikiDraft(llm, {}, draft, plan, evidence, source, new AbortController().signal),
    error => error.code === 'model-unavailable' && error.providerCode === 'AUTH' && error.providerStatus === 401)
  assert.equal(semanticCalls, 1)
})

test('Wiki review keeps exact citations and separately exposes unquoted README capabilities', () => {
  const { source, evidence, plan, raw } = fixture()
  evidence[0].text += '\n另一个重要能力是批处理，这一点尚未出现在草稿中。'
  evidence[0].end = 3
  const draft = normalizeWikiDraft(raw, source, evidence, plan)
  const context = wikiReviewMaterial(draft, plan, evidence)
  const citation = context.excerpts.find(item => item.id === 1)
  assert.equal(citation.role, 'citation')
  assert.equal(citation.start, 1)
  assert.equal(citation.end, 2)
  assert.doesNotMatch(citation.text, /批处理/)
  const overview = context.documentOverviews.find(item => item.id === 1)
  assert.equal(overview.role, 'documentation-overview')
  assert.match(overview.text, /批处理/)
  assert.deepEqual(overview.sourceRange, { start: 1, end: 3 })
  assert.deepEqual(overview.shownRange, { start: 1, end: 3 })
  assert.equal(overview.characterTruncated, false)
  assert.equal(overview.lastLineTruncated, false)
})

test('documentation overviews report partial lines and share the bounded review evidence budget', () => {
  const { source, evidence, plan, raw } = fixture()
  const draft = normalizeWikiDraft(raw, source, evidence, plan)
  for (let i = 0; i < 30; i++) evidence.push({ path: `docs/guide-${i}.md`, kind: 'documentation', primary: false,
    start: 10, end: 10, text: 'x'.repeat(8_000) })
  const context = wikiReviewMaterial(draft, plan, evidence)
  const overview = context.documentOverviews.find(item => item.path === 'docs/guide-0.md')
  assert.equal(overview.text.length, 4_000)
  assert.deepEqual(overview.sourceRange, { start: 10, end: 10 })
  assert.deepEqual(overview.shownRange, { start: 10, end: 10 })
  assert.deepEqual(overview.characters, { original: 8_000, included: 4_000 })
  assert.equal(overview.characterTruncated, true)
  assert.equal(overview.lastLineTruncated, true)
  const characters = [...context.excerpts, ...context.documentOverviews].reduce((sum, item) => sum + item.text.length, 0)
  assert.equal(context.evidenceBudget.characters, characters)
  assert(characters <= 65_000)
  assert(context.evidenceBudget.overviewRecordsOmitted > 0)
})

test('a terminal Wiki reviewer failure aborts and drains its concurrent sibling', async () => {
  const { source, evidence, plan, raw } = fixture()
  const draft = normalizeWikiDraft(raw, source, evidence, plan)
  let drained = false
  const llm = { async *stream(options) {
    if (options.system.includes('事实审核员')) throw new Error('transport failed')
    try {
      await new Promise((resolve, reject) => {
        if (options.signal.aborted) return reject(options.signal.reason)
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally { drained = true }
  } }
  await assert.rejects(reviewWikiDraft(llm, {}, draft, plan, evidence, source, new AbortController().signal),
    error => error.code === 'model-unavailable')
  assert.equal(drained, true)
})
