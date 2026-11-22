import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wikiDraftFixture, wikiPlanFixture } from '../fixtures/wiki-editorial.js'
import { normalizeWikiDraft, normalizeWikiPlan, renderWikiDocument, restoreWikiDraft, wikiReviewMaterial, wikiTargetEntries } from '../src/wiki-document.js'

function fixture() {
  const evidence = [
    { path: 'README.md', text: 'Run the example.', primary: false, kind: 'documentation' },
    { path: 'main.js', text: 'export const run = input => core(input)', primary: true, kind: 'source' },
    { path: 'core.js', text: 'export const core = ({ count }) => count + 1', primary: true, kind: 'source' },
    { path: 'settings.yml', text: Array.from({ length: 26 }, (_, i) => `mode_${i}: count`).join('\n'), primary: false, kind: 'config' },
    { path: 'transform.js', text: 'export const step = count => count + 1', primary: true, kind: 'source' },
    { path: 'test/run.test.js', text: 'assert.equal(run({ count: 2 }), 3)', primary: true, kind: 'source' },
  ].map(file => ({ ...file, start: 1, end: file.text.split('\n').length }))
  const source = { owner: 'example', repo: 'project', commit: 'a'.repeat(40),
    tree: evidence.map(file => ({ path: file.path, type: 'blob' })) }
  const [docs, entry, core, settings, transform, verify] = evidence.map((file, i) => ({ evidence: i + 1, start: 1, end: file.end }))
  const plan = normalizeWikiPlan({ ...wikiPlanFixture(), moduleCases: true }, source)
  const raw = wikiDraftFixture({ docs, entry, core })
  const moduleCase = {
    id: 'entry_case', type: 'module-case', title: '从调用参数到计算结果',
    items: [
      { text: 'run 将包含 count 的 input 传给 core。', refs: [entry] },
      { text: 'core 解构 count 并返回 count 加一。', refs: [core] },
    ],
    boundary: { condition: '运行模式使用 count。', result: '计算接收带 count 字段的对象。', refs: [settings] },
    change: { goal: '调整增量。', location: '在 transform.js 的 step 修改加数。', refs: [transform] },
    verification: { action: '用 count=2 执行 run 的测试。', expected: '返回值等于 3。', refs: [verify] },
  }
  raw.chapters[2].blocks.push(moduleCase)
  raw.chapters[3].blocks.push({ ...structuredClone(moduleCase), id: 'core_case' })
  return { evidence, source, plan, raw, docs, moduleCase }
}

test('new plans require a case in every core module and keep that requirement after checkpoint recovery', () => {
  const f = fixture(), missing = structuredClone(f.raw)
  missing.chapters[3].blocks.pop()
  assert.equal(f.plan.moduleCases, true)
  assert.throws(() => normalizeWikiDraft(missing, f.source, f.evidence, f.plan), /核心模块章 core 缺少 module-case/)
  const checkpoint = restoreWikiDraft({ plan: f.plan, draft: missing }, f.source, f.evidence)
  assert.equal(checkpoint.plan.moduleCases, true)
  assert.equal(checkpoint.draft, undefined)

  missing.chapters[2].blocks.pop()
  const legacy = restoreWikiDraft({ plan: wikiPlanFixture(), draft: missing }, f.source, f.evidence)
  assert.equal(legacy.plan.moduleCases, undefined)
  assert.equal(legacy.draft.chapters.length, 4)
  const valid = restoreWikiDraft({ plan: f.plan, draft: f.raw }, f.source, f.evidence)
  assert.deepEqual(valid.raw, f.raw)
  assert.equal(valid.draft.chapters[2].blocks.at(-1).id, 'entry_case')
})

test('module cases require a real ordered implementation and individual evidence for the boundary, change and verification', () => {
  const f = fixture()
  const invalid = [
    [block => { block.items.pop() }, /模块实例步骤 需要 2–7 项/],
    [block => { block.items[0].refs = [f.docs] }, /步骤引用.*有效实现证据/],
    [block => { block.boundary.refs = [f.docs] }, /边界引用.*有效实现证据/],
    [block => { block.change.refs = [f.docs] }, /修改位置引用.*有效实现证据/],
    [block => { block.verification.refs = [f.docs] }, /验证引用.*有效实现证据/],
    [block => { block.verification.refs[0].end = 2 }, /验证引用.*已读取范围/],
    [block => { delete block.verification }, /模块实例验证操作/],
  ]
  for (const [modify, message] of invalid) {
    const raw = structuredClone(f.raw)
    modify(raw.chapters[2].blocks.at(-1))
    assert.throws(() => normalizeWikiDraft(raw, f.source, f.evidence, f.plan), message)
  }
  const misplaced = structuredClone(f.raw)
  misplaced.chapters[0].blocks.push(misplaced.chapters[2].blocks.pop())
  assert.throws(() => normalizeWikiDraft(misplaced, f.source, f.evidence, f.plan), /只能出现在核心模块章/)
  const duplicated = structuredClone(f.raw)
  duplicated.chapters[2].blocks.push({ ...structuredClone(f.moduleCase), id: 'other_case' })
  assert.throws(() => normalizeWikiDraft(duplicated, f.source, f.evidence, f.plan), /最多包含一个 module-case/)
})

test('module case renders ordered steps and includes every citation in the chapter and review', () => {
  const f = fixture(), draft = normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan)
  const block = draft.chapters[2].blocks.at(-1)
  const { markdown } = renderWikiDocument(draft, f.source)
  const chapter = markdown.split(/^## /m).find(value => value.startsWith('示例入口\n'))
  assert.match(chapter, /^### 从调用参数到计算结果$/m)
  assert.match(chapter, /^1\. run 将包含 count 的 input 传给 core。 [^\n]+\n2\. core 解构 count 并返回 count 加一。 /m)
  assert.match(chapter, /\| 边界 \| 运行模式使用 count。 \| 计算接收带 count 字段的对象。/)
  assert.match(chapter, /\| 修改 \| 调整增量。 \| 在 transform\.js 的 step 修改加数。/)
  assert.match(chapter, /\| 验证 \| 用 count=2 执行 run 的测试。 \| 返回值等于 3。/)
  const chapterSources = chapter.split('### 本章引用')[1]
  const material = wikiReviewMaterial(draft, f.plan, f.evidence)
  assert.deepEqual(block.boundary.refs.map(({ start, end }) => [start, end]), [[1, 25], [26, 26]])
  for (const { evidence, start, end, label, url } of [...block.items.flatMap(item => item.refs),
    ...block.boundary.refs, ...block.change.refs, ...block.verification.refs]) {
    assert(chapterSources.includes(url), label)
    assert(material.excerpts.flatMap(excerpt => excerpt.citations ?? [excerpt])
      .some(citation => citation.id === evidence && citation.start === start && citation.end === end), label)
  }
  assert.equal(wikiTargetEntries(draft).get('entry_case').value, block)
})
