import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeWikiPlan, normalizeWikiDraft, renderWikiDocument } from '../src/wiki-document.js'
import { videoReferences, loadVideoExcerpt } from '../src/video-evidence.js'
import { wikiPlanFixture, wikiDraftFixture } from '../fixtures/wiki-editorial.js'

test('new Wiki paragraphs and numbered citations preserve local and GitHub video evidence contracts', async t => {
  const commit = 'a'.repeat(40), id = '11111111-1111-4111-8111-111111111111'
  const evidence = [
    { path: 'README.md', start: 1, end: 2, text: '# Example\nA reusable example.', primary: false, kind: 'documentation' },
    { path: 'main.js', start: 1, end: 2, text: 'import { run } from "./core.js"\nrun()', primary: true, kind: 'source' },
    { path: 'core.js', start: 1, end: 1, text: 'export const run = () => 42', primary: true, kind: 'source' },
  ]
  const tree = evidence.map(file => ({ path: file.path, type: 'blob', mode: '100644' }))
  const spans = Object.fromEntries(['docs', 'entry', 'core'].map((name, index) => [name,
    { evidence: index + 1, start: evidence[index].start, end: evidence[index].end }]))
  const requests = []
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url))
    const prefix = `https://raw.githubusercontent.com/example/project/${commit}/`
    assert(String(url).startsWith(prefix), 'video excerpts remain pinned to the Wiki commit')
    const file = evidence.find(file => file.path === String(url).slice(prefix.length))
    return new Response(file?.text ?? '', { status: file ? 200 : 404 })
  })
  for (const local of [false, true]) {
    const source = { repo: 'project', commit, tree, ...(local ? { sourceKey: id } : { owner: 'example' }) }
    const plan = normalizeWikiPlan(wikiPlanFixture(), source)
    const result = renderWikiDocument(normalizeWikiDraft(wikiDraftFixture(spans), source, evidence, plan), source)
    const document = { ...result, id, commit, source: local ? 'local' : 'github',
      ...(local ? { repoName: 'project', files: evidence.map(file => ({ path: file.path, text: file.text, startLine: file.start })) }
        : { repoUrl: 'https://github.com/example/project' }) }
    const refs = videoReferences(document)
    assert.deepEqual([...new Set(refs.map(ref => ref.path))].sort(), ['README.md', 'core.js', 'main.js'])
    const before = requests.length
    const excerpt = await loadVideoExcerpt(document, refs.find(ref => ref.path === 'core.js'), new AbortController().signal)
    assert.deepEqual(excerpt.lines, ['export const run = () => 42'])
    if (local) assert.equal(requests.length, before, 'local video evidence never fetches outside its saved Wiki')
    assert.deepEqual(Object.keys(document.architecture.layers[0].nodes[0].refs[0]), ['label', 'url'])
  }
})
