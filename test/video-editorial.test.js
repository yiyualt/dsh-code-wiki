import assert from 'node:assert/strict'
import { test } from 'node:test'
import { editorialSources, normalizeEditorialBrief, normalizeMotionScript } from '../src/video-director.js'
import { editorialBriefFixture, editorialDocumentText, promotionalScriptFixture } from '../fixtures/video-motion.js'

const document = { markdown: editorialDocumentText,
  architecture: { layers: [{ nodes: [{ id: 'entry' }, { id: 'trainer' }] }] } }
const motivation = 'We built ExampleLab to compare models under one shared experiment procedure.'
const material = {
  readme: `# ExampleLab\n\n${motivation}\n\n${editorialDocumentText}`,
  readmePath: 'README.md',
  documents: [{ path: 'docs/overview.md', text: 'This project supports researchers comparing recommendation experiments.' }],
  references: [{ id: 2, url: 'https://example.test/trainer.py#L10-L11' }],
  excerpts: [{ id: 2, path: 'trainer.py', lines: ['model.fit(data)', 'return model.evaluate()'] }],
}

test('editorial sources preserve README, project document, fetched code and generated Wiki provenance', () => {
  const sources = editorialSources(document, material)
  assert.deepEqual(sources.map(source => [source.id, source.kind]), [
    ['readme', 'readme'], ['document-1', 'document'], ['code-2', 'code'], ['wiki', 'generated-wiki'],
  ])
  assert.equal(sources[0].path, 'README.md')
  assert.equal(sources[1].text, material.documents[0].text)
  assert.equal(sources[2].url, material.references[0].url)
  assert.equal(sources[2].text, material.excerpts[0].lines.join('\n'))
})

test('the editorial brief selects supported features and architecture without inventing author motivation', () => {
  const brief = editorialBriefFixture()
  brief.facts[0].source = 'readme'
  brief.facts[0].quote = brief.facts[0].quote.replaceAll(' ', '\n  ')
  const result = normalizeEditorialBrief(brief, document, editorialSources(document, material))
  assert.equal(result.facts[0].sourcePath, 'README.md')
  assert.deepEqual(result.selectedFeatures, ['fact_trainer'])
  assert.deepEqual(result.architecture, ['entry', 'trainer'])
  assert.equal(result.motivationFact, null)
  assert.equal(result.omissions[0], 'The original author motivation is undocumented.')

  const invented = editorialBriefFixture(); invented.facts[1].quote = 'The benchmark was twice as fast for every model.'
  assert.throws(() => normalizeEditorialBrief(invented, document, editorialSources(document, material)), /原文/)
  const unknown = editorialBriefFixture(); unknown.facts[1].source = 'document-99'
  assert.throws(() => normalizeEditorialBrief(unknown, document, editorialSources(document, material)), /原文/)
})

test('fact citations identify the matched original lines in README, linked documents and source excerpts', () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  for (const kind of ['local', 'github']) {
    const url = (file, first, path) => kind === 'local'
      ? `https://dsh-code-wiki.invalid/source?key=${id}&file=${file}&start=${first}&end=${first}`
      : `https://github.com/example/repo/blob/${'a'.repeat(40)}/${path}#L${first}`
    const brief = editorialBriefFixture()
    const [purpose, feature, architecture] = brief.facts.map(fact => fact.quote)
    const sources = editorialSources(document, {
      readme: '# ExampleLab\r\n\r\n' + purpose.replace('ExampleLab', 'ＥxampleLab').replace('using shared', 'using\r\n  shared'),
      readmePath: 'README.md', readmeUrl: url(1, 100, 'README.md'),
      documents: [{ path: 'docs/overview.md', text: '# Capabilities\n' + feature, url: url(2, 200, 'docs/overview.md') }],
      references: [{ id: 2, url: url(3, 300, 'entry.py') }],
      excerpts: [{ id: 2, path: 'entry.py', startLine: 300, lines: ['# Entry', '# ' + architecture] }],
    })
    brief.facts[0].source = 'readme'
    brief.facts[0].quote = purpose.replaceAll(' ', '\n  ')
    brief.facts[1].source = 'document-1'
    brief.facts[2].source = 'code-2'
    const normalized = normalizeEditorialBrief(brief, document, sources)
    const expected = [[102, 103], [201, 201], [301, 301]]
    normalized.facts.forEach((fact, index) => {
      const citation = new URL(fact.sourceUrl)
      const [start, end] = expected[index]
      if (kind === 'local') {
        assert.equal(Number(citation.searchParams.get('start')), start)
        assert.equal(Number(citation.searchParams.get('end')), end)
      } else assert.equal(citation.hash, `#L${start}${end === start ? '' : `-L${end}`}`)
    })
  }
})

test('local fact quotations fit the 25-line source route limit, including intervening blank lines', () => {
  const brief = editorialBriefFixture()
  brief.facts[0].source = 'readme'
  const words = Array.from({ length: 26 }, (_, index) => `word${index}`)
  const sources = editorialSources(document, material)
  const source = sources.find(item => item.id === 'readme')
  source.url = 'https://dsh-code-wiki.invalid/source?key=12345678-1234-1234-1234-123456789abc&file=1&start=40&end=40'
  source.text = words.slice(0, 25).join('\n')
  brief.facts[0].quote = words.slice(0, 25).join(' ')
  const accepted = normalizeEditorialBrief(brief, document, sources)
  assert.match(accepted.facts[0].sourceUrl, /&start=40&end=64$/)
  source.text = words.join('\n')
  brief.facts[0].quote = words.join(' ')
  assert.throws(() => normalizeEditorialBrief(brief, document, sources), /25 行/)
  source.text = 'Evidence\n' + '\n'.repeat(24) + 'supports this feature.'
  brief.facts[0].quote = 'Evidence supports this feature.'
  assert.throws(() => normalizeEditorialBrief(brief, document, sources), /25 行/)
})

test('selected feature and architecture references must identify the right existing entities', () => {
  const sources = editorialSources(document, material)
  const wrongKind = editorialBriefFixture(); wrongKind.selectedFeatures = ['fact_purpose']
  assert.throws(() => normalizeEditorialBrief(wrongKind, document, sources), /主要特性/)
  const duplicate = editorialBriefFixture(); duplicate.selectedFeatures.push('fact_trainer')
  assert.throws(() => normalizeEditorialBrief(duplicate, document, sources), /主要特性/)
  const unknownNode = editorialBriefFixture(); unknownNode.architecture = ['imaginary_service']
  assert.throws(() => normalizeEditorialBrief(unknownNode, document, sources), /已有组件/)
})

test('author motivation requires an exact quote from the primary README or project documents', () => {
  const sources = editorialSources(document, material)
  const brief = editorialBriefFixture()
  brief.facts.push({ id: 'fact_motivation', kind: 'motivation', claim: 'The authors built ExampleLab to make model comparisons consistent.',
    source: 'readme', quote: motivation })
  brief.motivationFact = 'fact_motivation'
  assert.equal(normalizeEditorialBrief(brief, document, sources).motivationFact, 'fact_motivation')

  brief.facts[3].source = 'wiki'
  const withWikiClaim = { ...document, markdown: editorialDocumentText + '\n' + motivation }
  assert.throws(() => normalizeEditorialBrief(brief, withWikiClaim, editorialSources(withWikiClaim, material)), /作者动机/)
  brief.facts[3].source = 'code-2'; brief.facts[3].quote = 'model.fit(data)'
  assert.throws(() => normalizeEditorialBrief(brief, document, sources), /作者动机/)
})

test('the repository introduction can explain problem, main features and architecture without a forced tutorial scene', () => {
  const result = normalizeMotionScript(promotionalScriptFixture())
  const kinds = result.scenes.map(scene => scene.kind)
  assert(kinds.includes('problem'))
  assert(kinds.includes('feature'))
  assert(kinds.includes('architecture'))
  assert.equal(kinds.includes('flow'), false)
  assert.equal(kinds.includes('detail'), false)
  assert(result.scenes[1].narration.includes('ExampleLab'))
})
