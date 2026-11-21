import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wikiDraftFixture, wikiPlanFixture } from '../fixtures/wiki-editorial.js'
import { normalizeWikiDraft, normalizeWikiPlan, renderWikiDocument, reviseWikiDraft, wikiReviewMaterial } from '../src/wiki-document.js'
import { reviewWikiDraft, wikiPublicationSchema } from '../src/wiki-editor.js'

function fixture() {
  const evidence = [
    { path: 'README.md', text: 'Run an operation.', primary: false, kind: 'documentation' },
    { path: 'main.js', text: 'export const run = input => core(input)', primary: true, kind: 'source' },
    { path: 'core.js', text: 'export const core = input => format(input + 1)', primary: true, kind: 'source' },
    { path: 'format.js', text: 'export const format = value => ({ value })', primary: true, kind: 'source' },
  ].map(file => ({ ...file, start: 1, end: 1 }))
  const source = { owner: 'example', repo: 'project', commit: 'a'.repeat(40),
    tree: evidence.map(file => ({ path: file.path, type: 'blob' })) }
  const [docs, entry, core, format] = evidence.map((_file, index) => ({ evidence: index + 1, start: 1, end: 1 }))
  const rawPlan = { ...wikiPlanFixture(), walkthrough: { title: '执行一次运算', question: '输入如何变成对象？' } }
  const plan = normalizeWikiPlan(rawPlan, source)
  const raw = wikiDraftFixture({ docs, entry, core })
  const data = (title, column, cell, ref) => ({ title, columns: ['字段', '值'], rows: [[column, cell]], refs: [ref] })
  raw.walkthrough = { title: '执行一次运算', objective: '跟踪数字输入如何变成结果对象。',
    modules: [
      { node: 'entry', chapter: 'execution', entry: 'main.js/run', change: '检查 run 的输入约定。', refs: [entry] },
      { node: 'core', chapter: 'core', entry: 'core.js/core', change: '调整 core 中的运算规则。', refs: [core] },
    ],
    steps: [
      { id: 'receive', module: 'entry', title: '接收输入', action: 'run 把 input 交给 core。', outcome: 'core 收到数值。', refs: [entry],
        data: data('输入值', 'input', '2', entry) },
      { id: 'increment', module: 'core', title: '计算新值', action: 'core 对 input 加一。', outcome: '加一后的值传给 format。', refs: [core],
        data: data('中间值', 'value', '3', core) },
      { id: 'format', module: 'core', title: '返回对象', action: 'format 将计算值放入对象。', outcome: '返回含 value 的对象。', refs: [core, format],
        data: data('返回对象', 'value', '3', format) },
    ],
    tasks: [
      { kind: 'feature', title: '改变步长', summary: '在 core 调整加数并检查输出中的 value。', steps: ['increment', 'format'], refs: [core] },
      { kind: 'debug', title: '检查输入', summary: '检查 run 收到的输入及传给 core 的参数。', steps: ['receive'], refs: [entry] },
    ],
  }
  return { source, evidence, rawPlan, plan, raw, docs }
}

test('planned walkthrough keeps source links, links modules to chapters and preserves existing Markdown', () => {
  const { source, evidence, rawPlan, plan, raw } = fixture()
  assert.deepEqual(plan.walkthrough, rawPlan.walkthrough)
  const { walkthrough, ...legacy } = raw
  const legacyPlan = normalizeWikiPlan(wikiPlanFixture(), source)
  assert.equal(legacyPlan.walkthrough, undefined)
  assert.throws(() => normalizeWikiDraft(legacy, source, evidence, plan), /草稿必须提交 walkthrough/)
  const original = renderWikiDocument(normalizeWikiDraft(legacy, source, evidence, legacyPlan), source)
  const rendered = renderWikiDocument(normalizeWikiDraft(raw, source, evidence, plan), source)
  assert.equal(original.walkthrough, undefined)
  assert.equal(rendered.markdown, original.markdown)
  assert.deepEqual(rendered.architecture, original.architecture)
  assert.deepEqual(rendered.walkthrough.modules.map(module => [module.node, module.chapter]), [['entry', 2], ['core', 3]])
  const refs = rendered.walkthrough.steps[2].data.refs
  assert.deepEqual(refs, [{ label: 'format.js:1', url: `https://github.com/example/project/blob/${source.commit}/format.js#L1` }])
  assert.equal(walkthrough.modules[0].chapter, 'execution')
  assert.equal(wikiPublicationSchema.properties.draft.properties.walkthrough.properties.steps.minItems, 3)
})

test('walkthrough validation rejects invalid module, step, example and task references', () => {
  const { source, evidence, plan, raw, docs } = fixture()
  const invalid = [
    [caseData => { caseData.modules[0].node = 'missing' }, /已有架构组件/],
    [caseData => { caseData.modules[0].chapter = 'missing' }, /已有章节/],
    [caseData => { caseData.steps[0].module = 'core' }, /每个案例模块/],
    [caseData => { caseData.steps[0].module = 'result' }, /案例模块的 node/],
    [caseData => { caseData.steps[0].id = caseData.steps[1].id }, /唯一的简短英文编号/],
    [caseData => { delete caseData.steps[1].data }, /至少一个中间步骤/],
    [caseData => { caseData.steps[0].data.rows = [['input']] }, /每行必须与列数一致/],
    [caseData => { caseData.steps[0].data.refs = [docs] }, /有效实现证据/],
    [caseData => { caseData.tasks[1].kind = 'feature' }, /一个 feature 任务和一个 debug 任务/],
    [caseData => { caseData.tasks[1].steps = ['missing'] }, /已有案例步骤/],
  ]
  for (const [replace, message] of invalid) {
    const candidate = structuredClone(raw)
    replace(candidate.walkthrough)
    assert.throws(() => normalizeWikiDraft(candidate, source, evidence, plan), message)
  }
})

test('independent reviewers receive case-only evidence and recheck changed case targets', async () => {
  const { source, evidence, plan, raw } = fixture()
  const draft = normalizeWikiDraft(raw, source, evidence, plan)
  const material = wikiReviewMaterial(draft, plan, evidence)
  assert.equal(material.excerpts.find(excerpt => excerpt.path === 'format.js').text, evidence[3].text)
  const revisions = { blocks: [], walkthrough: structuredClone(raw.walkthrough) }
  revisions.walkthrough.objective += '检查返回字段。'
  revisions.walkthrough.steps[1].data.title = '传入 format 的中间值'
  const revised = normalizeWikiDraft(reviseWikiDraft(raw, revisions), source, evidence, plan)
  const inputs = []
  const llm = { async *stream({ messages }) {
    inputs.push(JSON.parse(messages[0].content[0].text))
    yield { type: 'text-delta', text: JSON.stringify({ approved: false,
      issues: [{ target: 'walkthrough:step:increment', reason: '补充字段含义。', reads: [] }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const approved = { approved: true, issues: [] }
  const result = await reviewWikiDraft(llm, {}, revised, plan, evidence, source, new AbortController().signal, undefined,
    { draft, review: { semantic: approved, editorial: approved } })
  assert.equal(result.approved, false)
  assert.equal(result.issues.length, 2)
  assert.equal(inputs.length, 2)
  for (const input of inputs) assert.deepEqual(input.targets, ['walkthrough:summary', 'walkthrough:step:increment'])
})
