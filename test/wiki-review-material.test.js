import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wikiDraftFixture, wikiPlanFixture } from '../fixtures/wiki-editorial.js'
import { normalizeWikiDraft, normalizeWikiPlan, renderWikiDocument, wikiReviewMaterial } from '../src/wiki-document.js'

function fixture() {
  const body = Array.from({ length: 50 }, (_, index) => index === 16 ? '' : `original ${index + 1}: 中文源码`)
  const evidence = [
    { path: 'README.md', start: 1, end: 2, text: '# Project\nDocumented purpose.', primary: false, kind: 'documentation' },
    { path: 'main.js', start: 1, end: 40, text: body.slice(0, 40).join('\n'), primary: true, kind: 'source' },
    { path: 'core.js', start: 1, end: 10, text: body.slice(0, 10).join('\n'), primary: true, kind: 'source' },
    { path: 'main.js', start: 11, end: 50, text: body.slice(10).join('\n'), primary: true, kind: 'source' },
  ]
  const source = { owner: 'example', repo: 'project', commit: 'a'.repeat(40),
    tree: ['README.md', 'main.js', 'core.js'].map(path => ({ path, type: 'blob', mode: '100644' })),
    read() { assert.fail('Review material must use the saved original evidence') } }
  const plan = normalizeWikiPlan(wikiPlanFixture(), source)
  const raw = wikiDraftFixture({ docs: { evidence: 1, start: 1, end: 2 },
    entry: { evidence: 2, start: 1, end: 2 }, core: { evidence: 3, start: 1, end: 2 } })
  return { body, evidence, source, plan, raw }
}

function selected(draft) {
  const refs = [...draft.coverage.flatMap(item => item.refs), ...draft.chapters.flatMap(chapter => chapter.blocks.flatMap(block =>
    [...block.refs, ...(block.items?.flatMap(item => item.refs) ?? []), ...(block.nodes?.flatMap(item => item.refs) ?? []),
      ...(block.edges?.flatMap(item => item.refs) ?? [])])), ...draft.graph.layers.flatMap(layer => layer.nodes.flatMap(node => node.refs)),
  ...draft.graph.edges.flatMap(edge => edge.refs)]
  return [...new Map(refs.map(ref => [`${ref.evidence}:${ref.start}:${ref.end}`, ref])).values()]
}

test('overlapping source excerpts preserve every exact evidence ID and quoted range without changing the public document', () => {
  const f = fixture()
  f.raw.coverage[1].refs[0] = { evidence: 2, start: 5, end: 20 }
  f.raw.chapters[2].blocks[0].refs = [{ evidence: 4, start: 15, end: 30 }]
  f.raw.graph.layers[0].nodes[0].refs = [{ evidence: 2, start: 10, end: 25 }]
  const draft = normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan)
  const before = structuredClone(draft), rendered = renderWikiDocument(draft, f.source)
  const material = wikiReviewMaterial(draft, f.plan, f.evidence)
  const merged = material.excerpts.find(item => item.path === 'main.js' && item.start === 5)
  assert.equal(merged.end, 30)
  assert.equal(merged.text, f.body.slice(4, 30).join('\n'))
  assert.deepEqual(merged.citations, [
    { id: 2, start: 5, end: 20 }, { id: 4, start: 15, end: 30 }, { id: 2, start: 10, end: 25 },
  ])
  const aliases = material.excerpts.flatMap(excerpt => (excerpt.citations ?? [excerpt]).map(ref => ({ excerpt, ref })))
  const signature = ref => `${ref.id ?? ref.evidence}:${ref.start}:${ref.end}`
  assert.deepEqual(aliases.map(({ ref }) => signature(ref)).sort(), selected(draft).map(signature).sort())
  for (const { excerpt, ref } of aliases) {
    const original = f.evidence[ref.id - 1]
    assert.equal(excerpt.path, original.path)
    assert.equal(excerpt.text.split('\n').slice(ref.start - excerpt.start, ref.end - excerpt.start + 1).join('\n'),
      original.text.split('\n').slice(ref.start - original.start, ref.end - original.start + 1).join('\n'))
  }
  assert.match(material.citationInstructions, /各编号只能支持其原始引用范围/)
  assert.deepEqual(draft, before)
  assert.deepEqual(renderWikiDocument(draft, f.source), rendered)
})

test('identical source ranges read under different evidence IDs retain both aliases but quote the source once', () => {
  const f = fixture()
  f.raw.coverage[1].refs[0] = { evidence: 2, start: 15, end: 20 }
  f.raw.chapters[2].blocks[0].refs = [{ evidence: 4, start: 15, end: 20 }]
  const material = wikiReviewMaterial(normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan), f.plan, f.evidence)
  const excerpts = material.excerpts.filter(item => item.path === 'main.js' && item.start === 15)
  assert.equal(excerpts.length, 1)
  assert.deepEqual(excerpts[0].citations, [{ id: 2, start: 15, end: 20 }, { id: 4, start: 15, end: 20 }])
})

test('source deduplication rejects inconsistent overlapping lines rather than selecting one copy', () => {
  const f = fixture(), lines = f.evidence[3].text.split('\n')
  lines[7] = 'conflicting source at original line 18'
  f.evidence[3].text = lines.join('\n')
  f.raw.coverage[1].refs[0] = { evidence: 2, start: 10, end: 20 }
  f.raw.chapters[2].blocks[0].refs = [{ evidence: 4, start: 15, end: 25 }]
  const draft = normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan)
  assert.throws(() => wikiReviewMaterial(draft, f.plan, f.evidence), error =>
    error.code === 'model-output-invalid' && /main\.js:18.*重叠原文冲突/.test(error.message))
})

test('disjoint cited intervals never acquire unquoted lines between them', () => {
  const f = fixture()
  f.raw.coverage[1].refs[0] = { evidence: 2, start: 1, end: 5 }
  f.raw.chapters[2].blocks[0].refs = [{ evidence: 4, start: 11, end: 15 }]
  const material = wikiReviewMaterial(normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan), f.plan, f.evidence)
  const main = material.excerpts.filter(item => item.path === 'main.js')
  assert.deepEqual(main.map(item => [item.start, item.end]), [[1, 5], [11, 15]])
  assert.equal(main[0].text, f.body.slice(0, 5).join('\n'))
  assert.equal(main[1].text, f.body.slice(10, 15).join('\n'))
})

test('distinct source content still obeys the existing 65000-character review budget', () => {
  const f = fixture()
  const large = Array.from({ length: 20 }, () => 'x'.repeat(1100)).join('\n')
  f.evidence[1] = { ...f.evidence[1], start: 1, end: 20, text: large }
  f.evidence[2] = { ...f.evidence[2], start: 1, end: 20, text: large }
  f.evidence[3] = { ...f.evidence[3], path: 'helper.js', start: 1, end: 20, text: large }
  f.source.tree.push({ path: 'helper.js', type: 'blob', mode: '100644' })
  f.raw.coverage[1].refs = [{ evidence: 2, start: 1, end: 20 }, { evidence: 3, start: 1, end: 20 }]
  f.raw.chapters[2].blocks[0].refs = [{ evidence: 4, start: 1, end: 20 }]
  const draft = normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan)
  assert.throws(() => wikiReviewMaterial(draft, f.plan, f.evidence), /审核材料超过预算/)
})

test('a citation whose original text lacks its declared lines is rejected before any merge', () => {
  const f = fixture()
  f.evidence[3].text = f.body.slice(10, 15).join('\n')
  f.raw.chapters[2].blocks[0].refs = [{ evidence: 4, start: 11, end: 20 }]
  const draft = normalizeWikiDraft(f.raw, f.source, f.evidence, f.plan)
  assert.throws(() => wikiReviewMaterial(draft, f.plan, f.evidence), /审核引用 4:11–20 超出实际证据原文/)
})
