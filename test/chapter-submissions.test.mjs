import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChapterSubmissions } from '../skills/repo-design-wiki/scripts/chapter-submissions.mjs'
import { repositoryTools } from '../skills/repo-design-wiki/scripts/wiki-generation.mjs'

async function chapterFixture() {
  const path = 'config.py'
  const repository = { paths: [path], read: async () => 'defaults = {}\nuser = load()\nconfig = defaults | user\nreturn config' }
  const reads = repositoryTools(repository)
  const events = []
  const submissions = createChapterSubmissions({
    repository, ...reads, onEvent: event => events.push(event), diagnostic: () => {},
  })
  const tools = [...reads.tools, ...submissions.tools]
  const call = async (name, args) => JSON.parse((await tools.find(tool => tool.name === name).execute(args)).data)
  assert.equal((await call('wiki_read', { path, start: 1, count: 2 })).handle, 'r1')
  assert.equal((await call('wiki_read', { path, start: 3, count: 2 })).handle, 'r2')
  return { call, events, submissions, path }
}

const handoff = '将合并后的配置交给训练入口。'

test('citation checks and probes never publish a chapter', async () => {
  const { call, events, submissions, path } = await chapterFixture()
  const draft = '程序加载用户配置【r1:2】，将其与默认配置合并【r1:3】，然后交出结果【r7:1】。'
  const check = await call('wiki_check_chapter', { markdown: draft, handoff })
  assert.equal(check.valid, false)
  assert.deepEqual(check.citationErrors.map(({ reference, suggestedReference }) => [reference, suggestedReference]),
    [['r1:3', 'r2:3'], ['r7:1', undefined]])
  assert.match(check.citationErrors[0].reason, new RegExp(path + '.*1–2'))
  assert.equal(submissions.bodyError, undefined)
  for (const markdown of [
    '探针：这一行只引用一个非 configurator 文件的位置【r1:2】。',
    '本章已生成。\n\n测试引用【r1:1】。\n\n测试引用【r1:2】。',
    '本章已生成。测试引用【r1:1】。测试引用【r1:2】。',
    '加载用户配置。\n\n<!-- 【r1:2】 -->',
  ]) {
    assert.equal((await call('wiki_submit_chapter', { markdown, handoff })).accepted, false)
  }
  const markdown = '程序把用户配置合入默认值，再交出最终配置【r2:3】。'
  assert.equal((await call('wiki_check_chapter', { markdown, handoff })).valid, true)
  assert.equal(submissions.content, undefined)
  assert.deepEqual(events, [])
})

test('corrected body replaces the saved draft and keeps diagrams on an identical retry', async () => {
  const { call, events, submissions, path } = await chapterFixture()
  const markdown = [
    '程序会先加载默认配置和用户配置【r1:1】。图 1 展示配置交接。',
    '[[figure:1]]',
    '具体来说，用户配置覆盖同名默认值【r2:3】。',
  ].join('\n\n')
  const initial = { markdown, handoff }
  assert.equal((await call('wiki_submit_chapter', initial)).accepted, true)
  const result = await call('wiki_submit_diagram', { diagram: {
    slot: 1, kind: 'flow', title: '配置交接',
    nodes: [{ id: 'input', label: '用户配置' }, { id: 'output', label: '最终配置' }],
    edges: [{ from: 'input', to: 'output', label: '合并', source: 'r2:4' }],
  } })
  assert.equal(result.accepted, true)
  assert.equal((await call('wiki_submit_chapter', initial)).accepted, true)
  assert.equal(submissions.content.diagrams.length, 1)
  assert.equal(submissions.content.sources.length, 3)
  const revised = {
    markdown: '程序用用户配置覆盖同名默认值【r2:3】。' + '接着，训练入口读取合并后的配置。'.repeat(800),
    handoff: '交给训练入口的结果包括' + '校验后的配置项、'.repeat(55) + '最终参数。',
  }
  assert(revised.markdown.length > 10_000 && revised.handoff.length > 400)
  assert.equal((await call('wiki_submit_chapter', revised)).accepted, true)
  assert.deepEqual(events.map(({ type }) => type), ['body', 'diagram', 'body'])
  assert.deepEqual(submissions.content.diagrams, [])
  assert.deepEqual(submissions.content.sources, [{ path, line: 3 }])
  assert.equal(submissions.content.handoff, revised.handoff)
  assert.match(submissions.content.markdown, /覆盖同名默认值【1】/)
})
