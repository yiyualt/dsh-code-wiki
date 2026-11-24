import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createWikiStorage } from '../src/wiki-storage.js'

test('a chapter retry keeps saved text until a replacement has a verified diagram', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-wiki-route-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const storage = createWikiStorage(join(profile, 'dsh-code-wiki', 'documents'))
  const commit = 'a'.repeat(40)
  const tree = 'b'.repeat(40)
  const path = 'config.js'
  const sources = [{ path, line: 1 }]
  const handoff = '把配置交给入口。'
  const { id } = await storage.create({
    source: 'github', title: 'example/wiki', location: 'https://github.com/example/wiki', commit,
    mainline: handoff, chapters: [{ title: '入口怎样获得配置？', sources }],
  })
  const oldMarkdown = '入口读取配置【1】。\n\n[[figure:1]]'
  const oldContent = { markdown: oldMarkdown, handoff, sources, diagrams: [] }
  await storage.updateChapter(id, 0, () => ({ content: oldContent, warning: '图 1 尚未生成。' }))

  const responses = new Map([
    [`https://api.github.com/repos/example/wiki/git/commits/${commit}`, () => Response.json({ sha: commit, tree: { sha: tree } })],
    [`https://api.github.com/repos/example/wiki/git/trees/${tree}?recursive=1`, () => Response.json({
      tree: [{ path, type: 'blob', mode: '100644' }],
    })],
    [`https://raw.githubusercontent.com/example/wiki/${commit}/${path}`, () => new Response('const config = load()\nstart(config)')],
  ])
  t.mock.method(globalThis, 'fetch', async url => responses.get(url)())

  const prefix = '入口把加载得到的配置交给执行模块'
  const replacementMarkdown = `${prefix}【r1:2】。\n\n[[figure:1]]`
  const routes = new Map()
  let attempts = 0
  apply({
    connection: { fetch: { register: route => routes.set(route.path, route.fetch) } },
    profileContext: { dir: profile },
    skills: { registerProvider() {}, get: async () => ({ content: '按章节要求提交正文和配图。' }) },
    agentDefaultModel: { currentSelection() {} },
    agents: { async create({ setup }) {
      const attempt = ++attempts
      const tools = new Map()
      setup({ tools: { restrict() {}, register: tool => tools.set(tool.name, tool) } })
      const call = async (name, args) => JSON.parse((await tools.get(name).execute(args)).data)
      const events = []
      const agent = {
        session: { snapshotEvents: () => events },
        followup() {},
        cancel() {},
        async whenIdle() {
          if (!events.length) {
            assert.equal((await call('wiki_read', { path, start: 1, count: 2 })).handle, 'r1')
            assert.equal((await call('wiki_submit_chapter', { markdown: replacementMarkdown, handoff })).accepted, true)
            assert.deepEqual((await storage.get(id)).chapterWork[0].content, oldContent)
            if (attempt === 2) {
              const diagram = {
                slot: 1, kind: 'flow', title: '配置交接',
                nodes: [{ id: 'loader', label: '配置加载' }, { id: 'entry', label: '执行入口' }],
                edges: [{ from: 'loader', to: 'entry', label: '传递配置', source: 'r1:2' }],
              }
              assert.equal((await call('wiki_submit_diagram', { diagram })).accepted, true)
            }
          }
          events.push({ type: 'turn/end', data: { turn: events.length, reason: { kind: 'completed' } } })
        },
      }
      return { agent, async dispose() {} }
    } },
  })

  const route = '/api/dsh-code-wiki/chapter'
  const request = (accept = 'application/x-ndjson') => routes.get(route)(new Request('https://wiki.test' + route, {
    method: 'POST', headers: { accept }, body: JSON.stringify({ documentId: id, chapterIndex: 0 }),
  }))
  const readEvents = async () => (await (await request()).text()).trim().split('\n').map(line => JSON.parse(line))

  const failure = await readEvents()
  assert.deepEqual(failure.map(event => event.type), ['body', 'done'])
  assert.deepEqual(failure[0].content, oldContent)
  assert.match(failure[1].warning, /图 1/)
  assert.deepEqual((await storage.get(id)).chapterWork[0], { content: oldContent, warning: failure[1].warning })

  const success = await readEvents()
  assert.deepEqual(success.map(event => event.type), ['body', 'diagram', 'done'])
  assert.equal(success[0].content.markdown, `${prefix}【1】。\n\n[[figure:1]]`)
  assert.equal(success[1].diagram.slot, 1)
  assert.equal(success[2].warning, undefined)
  const expected = { ...success[0].content, diagrams: [success[1].diagram] }
  assert.deepEqual((await storage.get(id)).chapterWork[0], { content: expected })
  assert.deepEqual(await (await request('application/json')).json(), expected)
  assert.equal(attempts, 2)
})
