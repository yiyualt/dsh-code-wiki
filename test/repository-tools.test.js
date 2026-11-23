import assert from 'node:assert/strict'
import { test } from 'node:test'

import { repositoryTools } from '../skills/repo-design-wiki/scripts/repository-tools.mjs'

function fixture(t) {
  const source = {
    owner: 'example',
    tree: [
      { path: 'README.md', mode: '100644' },
      { path: 'src/main.js', mode: '100755' },
      { path: 'src/linked.js', mode: '120000' },
      { path: 'src/secrets.json', mode: '100644' },
      { path: 'vendor/dependency.js', mode: '100644' },
    ].map(entry => ({ ...entry, type: 'blob' })),
    read: t.mock.fn(async path => Buffer.from(path === 'README.md'
      ? '# Obsolete design\n'
      : '// setup\r\nimport { run } from "./core.js"\r\nrun()\r\n')),
  }
  const signal = new AbortController().signal
  const { definitions, evidence } = repositoryTools(source, signal)
  return {
    source, evidence,
    async call(name, args) {
      const result = await definitions.find(tool => tool.name === name).execute(args, { signal })
      return JSON.parse(result.data)
    },
  }
}

test('tool reads are confined to eligible paths from the commit tree', async t => {
  const { call, source } = fixture(t)
  assert.deepEqual((await call('wiki_list', {})).entries, ['README.md', 'src/'])
  assert.deepEqual((await call('wiki_list', { directory: 'src' })).entries, ['src/main.js'])
  for (const path of ['src/linked.js', 'src/secrets.json', 'vendor/dependency.js', '../outside.js']) {
    assert.ok((await call('wiki_read', { path })).error)
  }
  assert.equal(source.read.mock.callCount(), 0)
})

test('batch reads and literal search preserve original line numbers and mark documentation as guidance', async t => {
  const { call, evidence, source } = fixture(t)
  const { results: [code, docs] } = await call('wiki_read_batch', {
    ranges: [{ path: 'src/main.js', start: 2, count: 2 }, { path: 'README.md' }],
  })
  assert.equal(code.lines, '2 | import { run } from "./core.js"\n3 | run()')
  assert.equal(code.primary, true)
  assert.equal(docs.primary, false)
  const replay = await call('wiki_read', { path: 'src/main.js', start: 2, count: 2 })
  assert.equal(replay.evidence, code.evidence)
  const search = await call('wiki_find', { query: 'run()', paths: ['src/main.js', 'src/linked.js'] })
  assert.deepEqual(search.searched, ['src/main.js'])
  assert.match(search.found[0].lines, /3 \| run\(\)/)
  assert.equal(evidence[code.evidence - 1].start, 2)
  assert.equal(source.read.mock.callCount(), 2)
})

function customTools(source) {
  const signal = new AbortController().signal
  const tools = repositoryTools(source, signal)
  return { ...tools, call: async (name, args) => JSON.parse((await tools.definitions.find(tool => tool.name === name)
    .execute(args, { signal })).data) }
}
const entry = path => ({ path, mode: '100644', type: 'blob' })

test('directory pagination reaches later files and reports evidence kinds without reading blobs', async t => {
  const source = { owner: 'example', tree: [
    ...Array.from({ length: 105 }, (_, i) => entry('src/file-' + String(i).padStart(3, '0') + '.js')),
    entry('README'), entry('README_CN.md'), entry('package.json'), entry('config/runtime.yaml'),
  ], treeComplete: false, unvisitedDirectories: ['packages/not-yet-read'], read: t.mock.fn(() => assert.fail('Listing must not read content')) }
  const { call } = customTools(source)
  const first = await call('wiki_list', { directory: 'src', limit: 80 })
  assert.equal(first.entries.length, 80)
  assert.equal(first.total, 105)
  assert.equal(first.nextCursor, '80')
  assert.equal(first.budget.files.used, 0)
  assert.equal(first.discovery.treeComplete, false)
  const last = await call('wiki_list', { directory: './src/', cursor: first.nextCursor, limit: 80 })
  assert.equal(last.entries[24], 'src/file-104.js')
  assert.equal(last.nextCursor, null)
  assert.equal(last.kinds.source, 105)
  const root = await call('wiki_list', {})
  assert.deepEqual(root.kinds, { source: 105, documentation: 2, config: 2 })
  for (const args of [{ directory: '../src' }, { directory: '/src' }, { offset: -1 }, { cursor: 'bad' }, { cursor: '80', offset: 0 }]) {
    assert((await call('wiki_list', args)).error)
  }
})

test('scoped literal search paginates files and returns later-file coverage despite many early matches', async t => {
  const source = { owner: 'example', tree: [
    ...Array.from({ length: 15 }, (_, i) => entry('src/file-' + String(i).padStart(2, '0') + '.js')),
    entry('other/unrelated.js'), entry('src/secrets.json'),
  ], read: t.mock.fn(async path => Buffer.from(path === 'src/file-00.js' ? 'needle\n'.repeat(40) : '// setup\nneedle\n')) }
  const { call } = customTools(source)
  const first = await call('wiki_find', { query: 'needle', directory: 'src', limit: 10 })
  assert.equal(first.searched.length, 10)
  assert.equal(first.found.length, 10)
  assert.equal(first.coverage[0].matchCount, 40)
  assert.equal(first.coverage[0].returned, 1)
  assert.equal(first.coverage[0].matchesTruncated, true)
  const second = await call('wiki_find', { query: 'needle', directory: 'src', cursor: first.nextCursor })
  assert.equal(second.found.length, 5)
  assert.equal(second.found.at(-1).path, 'src/file-14.js')
  assert.equal(second.found.at(-1).matchLine, 2)
  assert.equal(second.nextCursor, null)
  assert.equal(second.budget.files.used, 15)
  assert(source.read.mock.calls.every(call => call.arguments[0].startsWith('src/file-')))
})

test('an empty optional cursor behaves as omitted for list and find while offsets and bounds still apply', async t => {
  const source = { owner: 'example', tree: Array.from({ length: 12 }, (_, i) => entry('src/file-' + String(i).padStart(2, '0') + '.js')),
    read: t.mock.fn(async () => Buffer.from('needle\n')) }
  const { call } = customTools(source)
  for (const offset of [0, 5]) {
    const listArgs = { directory: 'src', offset, limit: 3 }
    const expectedList = await call('wiki_list', listArgs)
    const actualList = await call('wiki_list', { ...listArgs, cursor: '' })
    assert.deepEqual(actualList, expectedList)
    assert.equal(actualList.entries.length, 3)
    const findArgs = { query: 'needle', directory: 'src', offset, limit: 3 }
    await call('wiki_find', findArgs)
    const expectedFind = await call('wiki_find', findArgs)
    const actualFind = await call('wiki_find', { ...findArgs, cursor: '' })
    assert.deepEqual(actualFind, expectedFind)
    assert.equal(actualFind.found.length, 3)
    assert.equal(actualFind.offset, offset)
  }
  for (const cursor of [' ', 'bad', '-1', '1.5', '9007199254740992']) {
    assert((await call('wiki_list', { directory: 'src', cursor })).error)
    assert((await call('wiki_find', { query: 'needle', directory: 'src', cursor })).error)
  }
  assert((await call('wiki_list', { cursor: '', limit: 81 })).error)
  assert((await call('wiki_find', { query: 'needle', cursor: '', limit: 11 })).error)
})

test('typed evidence retains complete long source lines and distinguishes documentation from configuration', async t => {
  const long = 'const actual = "' + 'x'.repeat(800) + '";'
  const source = { owner: 'example', tree: ['src/main.js', 'README_CN.md', 'package.json', 'config/app.yaml', '.github/workflows/README.md', '.github/workflows/ci.yml'].map(entry),
    read: t.mock.fn(async path => Buffer.from(path === 'src/main.js' ? '// setup\r\n' + long + '\r\nrun();\r\n' : 'Supported content\n')) }
  const { call, evidence } = customTools(source)
  const code = await call('wiki_read', { path: 'src/main.js', start: 2, count: 1 })
  assert.equal(evidence[code.evidence - 1].text, long)
  assert.equal(code.lines, '2 | ' + long)
  assert.equal(code.kind, 'source')
  assert.equal(code.primary, true)
  const expected = [
    ['README_CN.md', 'documentation', false], ['package.json', 'config', true],
    ['config/app.yaml', 'config', false], ['.github/workflows/README.md', 'documentation', false],
    ['.github/workflows/ci.yml', 'config', true],
  ]
  for (const [path, kind, primary] of expected) {
    const result = await call('wiki_read', { path })
    assert.equal(result.kind, kind)
    assert.equal(result.primary, primary)
    assert.equal(evidence[result.evidence - 1].kind, kind)
  }
})

test('oversize excerpt lines are never cited as cropped code and bounded file reads expose truncation', async t => {
  const source = { owner: 'example', tree: [entry('src/main.js')],
    readWithMetadata: t.mock.fn(async () => ({ bytes: Buffer.from('x'.repeat(24_001) + '\nactual();\n'), truncated: true, totalBytes: 3_000_000 })),
    read() { assert.fail('Prefer provider metadata') } }
  const { call, evidence } = customTools(source)
  const rejected = await call('wiki_read', { path: 'src/main.js', count: 2 })
  assert.equal(rejected.reason, 'long-line')
  assert.equal(rejected.fileTruncated, true)
  assert.equal(rejected.nextLine, 2)
  assert.equal(evidence.length, 0)
  const exact = await call('wiki_read', { path: 'src/main.js', start: 2 })
  assert.equal(exact.start, 2)
  assert.equal(exact.end, 2)
  assert.equal(evidence[exact.evidence - 1].text, 'actual();')
  assert.equal(exact.fileTruncated, true)
  assert.equal(exact.availableLines, 2)
  assert.equal(exact.nextLine, null)
  assert.match(exact.note, /unavailable, not absent/)
  assert.equal(source.readWithMetadata.mock.callCount(), 1)
})

test('concurrent ranges share in-flight reads and respect the unique-file budget', async t => {
  let active = 0
  let peak = 0
  const source = { owner: 'example', tree: Array.from({ length: 92 }, (_, i) => entry('src/file-' + i + '.js')),
    read: t.mock.fn(async () => {
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active--
      return Buffer.from('actual();\n')
    }) }
  const { call } = customTools(source)
  const batch = await call('wiki_read_batch', { ranges: [
    { path: 'src/file-0.js' }, { path: 'src/file-0.js' }, { path: 'src/file-1.js' },
    { path: 'src/file-2.js' }, { path: 'src/file-3.js' }, { path: 'src/file-4.js' },
  ] })
  assert.equal(batch.results[0].evidence, batch.results[1].evidence)
  assert.equal(source.read.mock.callCount(), 5)
  assert(peak <= 3)
  const results = await Promise.all(Array.from({ length: 92 }, (_, i) => call('wiki_read', { path: 'src/file-' + i + '.js' })))
  assert.equal(source.read.mock.callCount(), 90)
  assert.equal(results.filter(result => result.reason === 'file-budget').length, 2)
  assert.equal(results.at(-1).budget.files.remaining, 0)
  assert.equal((await call('wiki_read', { path: 'src/file-0.js' })).evidence, batch.results[0].evidence)
})

test('evidence exhaustion is explicit and already published evidence remains reusable', async t => {
  const source = { owner: 'example', tree: [entry('src/main.js')],
    read: t.mock.fn(async () => Buffer.from(Array.from({ length: 241 }, (_, i) => 'line' + i).join('\n'))) }
  const { call } = customTools(source)
  for (let start = 1; start <= 240; start++) assert.equal((await call('wiki_read', { path: 'src/main.js', start, count: 1 })).evidence, start)
  const exhausted = await call('wiki_read', { path: 'src/main.js', start: 241, count: 1 })
  assert.equal(exhausted.reason, 'evidence-budget')
  assert.equal(exhausted.budget.evidence.remaining, 0)
  assert.equal((await call('wiki_read', { path: 'src/main.js', start: 1, count: 1 })).evidence, 1)
})
