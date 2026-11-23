import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWikiStorage } from '../src/wiki-storage.js'

const sources = [{ path: 'src/entry.js', line: 2 }]
const outline = {
  source: 'github',
  title: 'example/wiki',
  location: 'https://github.com/example/wiki',
  commit: 'a'.repeat(40),
  mainline: '入口读取配置后交给执行模块。',
  chapters: [{ title: '入口怎样读取配置？', sources }],
}
const overview = {
  markdown: '入口载入配置【1】。图 1 展示模块的交接关系。\n\n[[figure:1]]',
  sources,
  diagrams: [{
    kind: 'component',
    label: '组件图',
    title: '入口和执行模块',
    width: 200,
    height: 100,
    svg: '<svg viewBox="0 0 200 100"><text>入口</text></svg>',
    slot: 1,
  }],
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wiki-storage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return createWikiStorage(directory)
}

test('saved overview survives chapter writes and archive while counts only track RQ chapters', async t => {
  const storage = await fixture(t)
  const { id } = await storage.create({ ...outline, overview })
  const before = await storage.get(id)
  assert.deepEqual(before.document.overview, overview)
  assert.deepEqual(before.chapterWork, [null])
  assert.equal((await storage.list())[0].chapterCount, 1)
  assert.equal((await storage.list())[0].generatedCount, 0)

  await storage.updateChapter(id, 0, () => ({
    content: {
      markdown: '入口载入配置【1】。',
      handoff: '入口把配置值交给执行模块。',
      sources,
      diagrams: [],
    },
  }))
  await storage.setArchived(id, true)
  const after = await storage.get(id)
  assert.equal(after.archived, true)
  assert.deepEqual(after.document.overview, overview)
  const [summary] = await storage.list()
  assert.equal(summary.hasOverview, true)
  assert.equal(summary.chapterCount, 1)
  assert.equal(summary.generatedCount, 1)
})

test('previous Wiki records with no overview still load', async t => {
  const storage = await fixture(t)
  const { id } = await storage.create(outline)
  const existing = await storage.get(id)
  assert.equal(Object.hasOwn(existing.document, 'overview'), false)
  assert.equal(Object.hasOwn((await storage.list())[0], 'hasOverview'), false)
  assert.deepEqual(existing.chapterWork, [null])
})

test('storage rejects incomplete overview figures and overviews without a module diagram', async t => {
  const storage = await fixture(t)
  for (const invalid of [
    { ...overview, markdown: '入口载入配置【1】。' },
    { ...overview, markdown: overview.markdown + '\n\n[[figure:2]]' },
    { ...overview, diagrams: [{ ...overview.diagrams[0], kind: 'flow' }] },
  ]) {
    await assert.rejects(storage.create({ ...outline, overview: invalid }), { code: 'wiki-storage-invalid' })
  }
  assert.deepEqual(await storage.list(), [])
})
