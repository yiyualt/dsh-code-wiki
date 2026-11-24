import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateChapter } from '../skills/repo-design-wiki/scripts/generate-chapter.mjs'

const path = 'index.js'
const repository = {
  label: 'normalize-title',
  commit: '1'.repeat(40),
  paths: [path],
  read: async () => 'export const normalize = title => title.trim()\n',
}
const chapter = { title: '标题怎样被清理？', sources: [{ path, line: 1 }] }
const body = {
  markdown: '`normalize` 调用 `trim` 去掉标题首尾空格【r1:1】。图 1 展示输入和结果。\n\n[[figure:1]]',
  handoff: '返回去掉首尾空格的标题。',
}
const diagram = {
  slot: 1, kind: 'flow', title: '标题清理',
  nodes: [{ id: 'input', label: '原始标题' }, { id: 'output', label: '清理后的标题' }],
  edges: [{ from: 'input', to: 'output', label: '调用 trim', source: 'r1:1' }],
}

function chapterRun(turns) {
  const prompts = []
  const events = []
  let disposed = false
  const result = generateChapter({
    repository, chapter, instructions: '', onEvent: event => events.push(event),
    async openAuthor({ tools }) {
      const toolsByName = new Map(tools.map(tool => [tool.name, tool]))
      async function call(name, input) {
        return JSON.parse((await toolsByName.get(name).execute(input)).data)
      }
      return {
        async run(prompt) {
          const turn = turns[prompts.length]
          assert.ok(turn, 'Unexpected model turn')
          if (!prompts.length) {
            assert.equal((await call('wiki_read', { path })).handle, 'r1')
          }
          prompts.push(prompt)
          return { kind: 'completed', text: '', ...await turn(call, prompt) }
        },
        async dispose() { disposed = true },
      }
    },
  })
  return { result, prompts, events, get disposed() { return disposed } }
}

async function acceptBody(call) {
  const result = await call('wiki_submit_chapter', body)
  assert.equal(result.accepted, true, result.error)
}

async function acceptDiagram(call) {
  const result = await call('wiki_submit_diagram', { diagram })
  assert.equal(result.accepted, true, result.error)
}

test('recovers a missing diagram after an interrupted tool call', async t => {
  for (const [name, interruption] of [
    ['unfinished call', { pendingTool: true }],
    ['malformed arguments', { kind: 'error', modelFailed: true, malformedResponse: true }],
  ]) {
    await t.test(name, async () => {
      const run = chapterRun([
        async call => {
          await acceptBody(call)
          return interruption
        },
        async (call, prompt) => {
          assert.match(prompt, /wiki_submit_diagram/)
          assert.doesNotMatch(prompt, /wiki_submit_chapter/)
          assert.deepEqual(run.events.map(({ type }) => type), ['body'])
          await acceptDiagram(call)
        },
      ])
      const result = await run.result
      assert.equal(run.prompts.length, 2)
      assert.equal(run.disposed, true)
      assert.deepEqual(run.events.map(({ type }) => type), ['body', 'diagram'])
      assert.equal(result.diagrams[0].slot, 1)
      assert.equal(result.warning, undefined)
    })
  }
})

test('keeps the accepted body and reports a missing diagram after the retry fails', async () => {
  const run = chapterRun([
    acceptBody,
    async call => {
      const invalid = { ...diagram, edges: [{ ...diagram.edges[0], source: 'r1:100' }] }
      const submission = await call('wiki_submit_diagram', { diagram: invalid })
      assert.equal(submission.accepted, false)
    },
  ])
  const result = await run.result
  assert.equal(run.prompts.length, 2)
  assert.equal(run.disposed, true)
  assert.deepEqual(run.events.map(({ type }) => type), ['body'])
  assert.equal(result.markdown, run.events[0].content.markdown)
  assert.deepEqual(result.diagrams, [])
  assert.match(result.warning, /尚未生成/)
})

test('recovers a missing diagram separately after correcting the body', async () => {
  const run = chapterRun([
    async call => {
      const invalid = await call('wiki_submit_chapter', { ...body, markdown: body.markdown.split('\n')[0] })
      assert.equal(invalid.accepted, false)
    },
    async (call, prompt) => {
      assert.match(prompt, /wiki_submit_chapter/)
      await acceptBody(call)
    },
    async (call, prompt) => {
      assert.match(prompt, /wiki_submit_diagram/)
      assert.doesNotMatch(prompt, /wiki_submit_chapter/)
      await acceptDiagram(call)
    },
  ])
  const result = await run.result
  assert.equal(run.prompts.length, 3)
  assert.deepEqual(run.events.map(({ type }) => type), ['body', 'diagram'])
  assert.equal(result.diagrams.length, 1)
  assert.equal(result.warning, undefined)
})
