import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createWikiStorage } from '../src/wiki-storage.js'

const path = 'src/config.js'
const handoff = '入口读取配置值。'
const source = line => [{ path, line }]

async function fixture(t) {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-wiki-local-route-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const repository = join(profile, 'project')
  await mkdir(join(repository, 'src'), { recursive: true })
  await writeFile(join(repository, 'index.js'), "import { mode } from './src/config.js'\nconsole.log(mode)\n")
  return { profile, repository, config: join(repository, path) }
}

function routesFor(profile, author) {
  const routes = new Map()
  let authorFailure
  apply({
    connection: { fetch: { register: route => routes.set(route.path, route.fetch) } },
    profileContext: { dir: profile },
    skills: { registerProvider() {}, get: async () => ({ content: '按要求提交代码百科。' }) },
    agentDefaultModel: { currentSelection() {} },
    agents: { async create({ setup }) {
      const tools = new Map()
      setup({ tools: { restrict() {}, register: tool => tools.set(tool.name, tool) } })
      const call = async (name, args) => JSON.parse((await tools.get(name).execute(args)).data)
      const events = []
      return {
        agent: {
          session: { snapshotEvents: () => events },
          followup() {},
          cancel() {},
          async whenIdle() {
            try {
              await author(call, tools.has('wiki_submit_outline'))
            } catch (error) {
              authorFailure = error
              throw error
            }
            events.push({ type: 'turn/end', data: { turn: events.length, reason: { kind: 'completed' } } })
          },
        },
        async dispose() {},
      }
    } },
  })
  return async (endpoint, body, expectedStatus = 200) => {
    const url = new URL(endpoint, 'https://wiki.test/api/dsh-code-wiki/')
    const response = await routes.get(url.pathname)(new Request(url, body && {
      method: 'POST', body: JSON.stringify(body),
    }))
    if (authorFailure) throw authorFailure
    const result = await response.json()
    assert.equal(response.status, expectedStatus, result.error)
    return result
  }
}

async function submit(call, part, input) {
  const result = await call('wiki_submit_' + part, input)
  assert.equal(result.accepted, true, result.error)
}

async function submitOutline(call) {
  assert.deepEqual((await call('wiki_list', {})).paths, ['index.js', 'src/'])
  assert.deepEqual((await call('wiki_list', { directory: 'src' })).paths, [path])
  assert.equal((await call('wiki_read', { path })).lines, "1 | export const mode = 'initial'")
  await submit(call, 'overview', {
    mainline: handoff, sources: source(1),
    markdown: '入口从配置模块读取运行模式【1】。\n\n[[figure:1]]\n\n配置模块将模式交给入口。\n\n[[figure:2]]',
  })
  await submit(call, 'architecture', {
    title: '配置读取分层', layers: [{ id: 'api', label: '入口', groups: [{ label: '读取配置', source: 1 }] }],
  })
  await submit(call, 'module_map', {
    kind: 'component', title: '入口读取配置',
    nodes: [{ id: 'entry', label: '入口', role: 'interface' }, { id: 'config', label: '配置', role: 'component' }],
    edges: [{ from: 'config', to: 'entry', label: '提供运行模式', source: 1 }],
  })
  await submit(call, 'outline', {
    chapters: ['模式怎样定义？', '入口怎样取得模式？'].map(title => ({
      title, module: 'config', handoff: 1, sources: source(1),
    })),
  })
}

async function submitChapter(call, line, value) {
  const read = await call('wiki_read', { path, start: line, count: 1 })
  assert.equal(read.lines, `${line} | export const mode = '${value}'`)
  const reference = `${read.handle}:${line}`
  await submit(call, 'chapter', { markdown: `入口读取模式 ${value}【${reference}】。\n\n[[figure:1]]`, handoff })
  await submit(call, 'diagram', { diagram: {
    slot: 1, kind: 'flow', title: '配置交接',
    nodes: [{ id: 'config', label: '配置模块' }, { id: 'entry', label: '入口' }],
    edges: [{ from: 'config', to: 'entry', label: '传递运行模式', source: reference }],
  } })
}

test('a reopened directory Wiki reads the current file and retains its saved overview and chapters', async t => {
  const { profile, repository, config } = await fixture(t)
  await writeFile(config, "export const mode = 'initial'\n")
  const initial = routesFor(profile, (call, outline) => outline ? submitOutline(call) : submitChapter(call, 1, 'initial'))
  const { id, commit, overview } = await initial('outline', { repositoryPath: repository })
  assert.equal(commit, null)
  await initial('chapter', { documentId: id, chapterIndex: 0 })
  const before = await initial('documents?id=' + id)
  assert.equal(before.document.source, 'local')
  assert.equal(before.document.location, repository)
  assert.equal(before.document.commit, null)
  assert.equal(before.chapterWork[1], null)

  await writeFile(config, "// The runtime mode changed.\nexport const mode = 'updated'\n")
  const reopened = routesFor(profile, call => submitChapter(call, 2, 'updated'))
  assert.deepEqual(await reopened('documents?id=' + id), before)
  const chapter = await reopened('chapter', { documentId: id, chapterIndex: 1 })
  assert.match(chapter.markdown, /updated【1】/u)
  assert.deepEqual(chapter.sources, source(2))
  const after = await reopened('documents?id=' + id)
  assert.deepEqual(after.document.overview, overview)
  assert.deepEqual(after.chapterWork[0], before.chapterWork[0])
  assert.deepEqual(after.chapterWork[1].content, chapter)

  const direct = await reopened('chapter', {
    repositoryPath: repository, commit: null, mainline: before.document.mainline,
    chapter: before.document.chapters[1], previous: null, next: null,
  })
  assert.deepEqual(direct.sources, source(2))
})

test('an existing local Git Wiki still reads its saved commit after a working-tree edit', async t => {
  const { profile, repository, config } = await fixture(t)
  await writeFile(config, "export const mode = 'committed'\n")
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', env }).trim()
  git('init', '-q', '--template=')
  git('add', 'index.js', path)
  git('-c', 'user.name=Code Wiki', '-c', 'user.email=wiki@example.test', 'commit', '-qm', 'Store the source Wiki was generated from')
  const commit = git('rev-parse', 'HEAD')
  const storage = createWikiStorage(join(profile, 'dsh-code-wiki', 'documents'))
  const { id } = await storage.create({
    source: 'local', title: '保存了提交的 Wiki', location: repository, commit, mainline: handoff,
    chapters: [{ title: '入口怎样取得模式？', sources: source(1) }],
  })
  await writeFile(config, "// A working-tree edit.\nexport const mode = 'working'\n")
  const request = routesFor(profile, call => submitChapter(call, 1, 'committed'))
  assert.equal((await request('documents?id=' + id)).document.commit, commit)
  const chapter = await request('chapter', { documentId: id, chapterIndex: 0 })
  assert.match(chapter.markdown, /committed【1】/u)
  assert.deepEqual(chapter.sources, source(1))
})

test('GitHub chapter requests and saved records require a real commit', async t => {
  const { profile } = await fixture(t)
  const repositoryUrl = 'https://github.com/example/wiki'
  const chapter = { title: '入口怎样取得模式？', sources: source(1) }
  const storage = createWikiStorage(join(profile, 'dsh-code-wiki', 'documents'))
  await assert.rejects(storage.create({
    source: 'github', title: 'example/wiki', location: repositoryUrl, commit: null,
    mainline: handoff, chapters: [chapter],
  }), { code: 'wiki-storage-invalid' })

  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('No GitHub request is needed for an invalid commit'))
  const request = routesFor(profile, () => assert.fail('No author is needed for an invalid commit'))
  await request('chapter', { repositoryUrl, commit: null, mainline: handoff, chapter, previous: null, next: null }, 400)
  assert.equal(fetch.mock.callCount(), 0)
})

test('a folder with unreadable source text reports that no usable source was read', async t => {
  const { profile, repository, config } = await fixture(t)
  await writeFile(join(repository, 'index.js'), '')
  await writeFile(config, Buffer.from([0xff]))
  const request = routesFor(profile, async call => {
    assert.match((await call('wiki_read', { path: 'index.js' })).error, /无法读取/u)
    assert.match((await call('wiki_read', { path })).error, /无法读取/u)
  })
  const result = await request('outline', { repositoryPath: repository }, 422)
  assert.match(result.error, /未能从所选目录读取可供解读的源码/u)
  assert.deepEqual(await request('documents'), { documents: [] })
})
