import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wikiPlanFixture, wikiDraftFixture, wikiDiagramFixture } from '../fixtures/wiki-editorial.js'
import { normalizeWikiPlan, normalizeWikiDraft, renderWikiDocument, wikiReviewMaterial } from '../src/wiki-document.js'

function fixture() {
  const source = { owner: 'example', repo: 'project', commit: 'a'.repeat(40),
    tree: ['README.md', 'main.js', 'core.js'].map(path => ({ path, type: 'blob', mode: '100644' })) }
  const evidence = source.tree.map((file, index) => ({ path: file.path, start: index === 2 ? 1 : 100,
    end: index === 2 ? 95 : 194, primary: index > 0, kind: index ? 'source' : 'documentation',
    text: Array.from({ length: 95 }, (_, line) => `original line ${line + (index === 2 ? 1 : 100)}`).join('\n') }))
  const spans = { docs: { evidence: 1, start: 128, end: 130 }, entry: { evidence: 2, start: 128, end: 130 },
    core: { evidence: 3, start: 25, end: 27 } }
  const plan = normalizeWikiPlan(wikiPlanFixture(), source)
  return { source, evidence, spans, plan, raw: wikiDraftFixture(spans) }
}

const ranges = refs => refs.map(({ evidence, start, end }) => ({ evidence, start, end }))
const lines = refs => refs.flatMap(ref => Array.from({ length: ref.end - ref.start + 1 }, (_, index) => ref.start + index))

test('28-line paragraph, coverage and graph citations split losslessly before review and public rendering', () => {
  const f = fixture()
  const paragraph = f.raw.chapters[1].blocks[0]
  paragraph.refs = [{ evidence: 2, start: 128, end: 155 }]
  f.raw.coverage[0].refs = [{ evidence: 1, start: 128, end: 155 }]
  f.raw.graph.layers[1].nodes[0].refs = [{ evidence: 3, start: 25, end: 52 }]
  f.raw.graph.edges[0].refs = [{ evidence: 2, start: 128, end: 155 }]
  const original = structuredClone(f.raw)
  const draft = normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan)
  assert.deepEqual(ranges(draft.chapters[1].blocks[0].refs), [
    { evidence: 2, start: 128, end: 152 }, { evidence: 2, start: 153, end: 155 },
  ])
  assert.deepEqual(ranges(draft.coverage[0].refs), [
    { evidence: 1, start: 128, end: 152 }, { evidence: 1, start: 153, end: 155 },
  ])
  assert.deepEqual(ranges(draft.graph.layers[1].nodes[0].refs), [
    { evidence: 3, start: 25, end: 49 }, { evidence: 3, start: 50, end: 52 },
  ])
  assert.deepEqual(lines(draft.graph.layers[1].nodes[0].refs), Array.from({ length: 28 }, (_, index) => index + 25))
  const review = wikiReviewMaterial(draft, f.plan, f.evidence)
  assert(review.excerpts.some(ref => ref.id === 3 && ref.start === 50 && ref.end === 52 && ref.text === 'original line 50\noriginal line 51\noriginal line 52'))
  const rendered = renderWikiDocument(draft, f.source)
  for (const node of rendered.architecture.layers.flatMap(layer => layer.nodes)) for (const ref of node.refs) {
    assert.deepEqual(Object.keys(ref), ['label', 'url'])
  }
  const urls = [...JSON.stringify(rendered).matchAll(/#L(\d+)(?:-L(\d+))?/g)]
  assert(urls.length > 0)
  assert(urls.every(([, start, end = start]) => Number(end) - Number(start) < 25))
  assert.deepEqual(f.raw, original, 'normalization does not replace or mutate raw model evidence')
})

test('citation expansion preserves order and every line at the four-reference budget', () => {
  const f = fixture(), target = f.raw.chapters[1].blocks[0]
  target.refs = [{ evidence: 2, start: 100, end: 174 }, { evidence: 3, start: 25, end: 25 }]
  const draft = normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan)
  assert.deepEqual(ranges(draft.chapters[1].blocks[0].refs), [
    { evidence: 2, start: 100, end: 124 }, { evidence: 2, start: 125, end: 149 },
    { evidence: 2, start: 150, end: 174 }, { evidence: 3, start: 25, end: 25 },
  ])
  assert.deepEqual(lines(draft.chapters[1].blocks[0].refs.slice(0, 3)), Array.from({ length: 75 }, (_, index) => index + 100))
})

test('citation expansion rejects over-budget totals instead of clipping or dropping evidence', () => {
  for (const refs of [
    [{ evidence: 2, start: 100, end: 175 }, { evidence: 3, start: 25, end: 25 }],
    [{ evidence: 2, start: 100, end: 125 }, { evidence: 3, start: 1, end: 51 }],
  ]) {
    const f = fixture()
    f.raw.chapters[1].blocks[0].refs = refs
    assert.throws(() => normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan), error =>
      error.code === 'model-output-invalid' && /正文 execution_text.*需要 5 项.*最多允许 4 项.*不能丢弃或截断/.test(error.message))
    assert.deepEqual(f.raw.chapters[1].blocks[0].refs, refs)
  }
})

test('original citation types, integer ranges, read bounds and implementation evidence validate before splitting', () => {
  for (const invalid of [null, [], 'range', { evidence: '2', start: 128, end: 155 },
    { evidence: 2, start: 128.5, end: 155 }, { evidence: 2, start: 128, end: 155.5 },
    { evidence: 0, start: 128, end: 155 }, { evidence: 9, start: 128, end: 155 },
    { evidence: 2, start: 99, end: 126 }, { evidence: 2, start: 180, end: 207 },
    { evidence: 2, start: 155, end: 128 }, { evidence: 1, start: 128, end: 155 }]) {
    const f = fixture()
    // The first range alone would need four parts; the invalid second range must still be validated first.
    f.raw.chapters[1].blocks[0].refs = [{ evidence: 2, start: 100, end: 194 }, invalid]
    assert.throws(() => normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan), error =>
      error.code === 'model-output-invalid' && /正文 execution_text 的引用\[1\].*有效实现证据/.test(error.message))
  }
  const f = fixture()
  f.raw.coverage[1].refs = [{ evidence: 2, start: 180, end: 207 }]
  assert.throws(() => normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan), /研究覆盖 execution 的引用\[0\]/)
})

test('code examples keep the original single 1–20-line contract after citation expansion', () => {
  for (const count of [21, 26]) {
    const f = fixture()
    f.raw.chapters[1].blocks.find(block => block.type === 'code').refs = [{ evidence: 3, start: 25, end: 24 + count }]
    assert.throws(() => normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan), /源码示例 core_code 需要单个 1–20 行/)
  }
  const f = fixture()
  f.raw.chapters[1].blocks.find(block => block.type === 'code').refs = [{ evidence: 3, start: 25, end: 44 }]
  const code = normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan).chapters[1].blocks.find(block => block.type === 'code')
  assert.equal(code.refs.length, 1)
  assert.equal(code.lines.length, 20)
  assert.equal(code.lines.at(-1), 'original line 44')
})

test('specialized view citations retain the same compact public contract after lossless splitting', () => {
  const f = fixture(), plan = wikiPlanFixture()
  plan.views = [{ kind: 'sequence', question: 'How do modules collaborate?', why: 'Explain call order.' }]
  f.plan = normalizeWikiPlan(plan, f.source)
  const diagram = wikiDiagramFixture(f.spans)
  diagram.nodes[0].refs = [{ evidence: 2, start: 128, end: 155 }]
  diagram.edges[0].refs = [{ evidence: 2, start: 128, end: 155 }]
  f.raw.chapters[1].blocks.push(diagram)
  const rendered = renderWikiDocument(normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan), f.source)
  const view = rendered.views[0]
  assert.equal(view.nodes[0].refs.length, 2)
  assert.equal(view.edges[0].refs.length, 2)
  for (const ref of [...view.nodes[0].refs, ...view.edges[0].refs]) assert.deepEqual(Object.keys(ref), ['label', 'url'])
})
