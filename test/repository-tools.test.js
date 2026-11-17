import assert from 'node:assert/strict'
import { test } from 'node:test'

import { repositoryTools } from '../src/repository-tools.js'

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
