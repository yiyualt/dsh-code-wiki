import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { apply } from '../index.js'
import { withChapterDiagramPlan, withChapterDiagrams, withWikiModuleCases,
  wikiDraftFixture, wikiPlanFixture } from '../fixtures/wiki-editorial.js'
import { createWikiCheckpoints } from '../src/wiki-checkpoint.js'

const exec = promisify(execFile)
const apiRoot = '/api/dsh-code-wiki/'
const skillInstruction = '先验证关键条件对结果的影响。'
const guideInstruction = '图旁标注实际调用方与实现。'
const skillText = `---\nname: repo-design-wiki\ndescription: Read a repository.\n---\n${skillInstruction}\n`
const fixtureSource = 'export const value = run()'
const startTitle = '执行入口如何把任务交给核心'
const implementationTitle = '核心结果由谁决定'
const flow = '```mermaid\nflowchart LR\n  A["入口"] -->|run| B["核心"]\n```'
const interruptedProvider = { kind: 'error', error: { code: 'TIMEOUT' } }

async function initRepository(directory) {
  await mkdir(directory)
  await Promise.all([
    writeFile(join(directory, 'main.js'), `import { run } from "./core.js"\n${fixtureSource}\n`),
    writeFile(join(directory, 'core.js'), 'export const run = () => 42\n'),
    writeFile(join(directory, 'README.md'), 'A small command runner.\n'),
  ])
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)))
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
  const git = args => exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, env })
  await git(['init', '-q'])
  await git(['add', 'main.js', 'core.js', 'README.md'])
  await git(['-c', 'user.name=Wiki Test', '-c', 'user.email=wiki-test@example.com',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Test fixture'])
  return (await git(['rev-parse', 'HEAD'])).stdout.trim()
}

async function skillFixture(t, runAuthor, { skillEntry = skillText } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'wiki-skill-api-'))
  const repositoryPath = join(workspace, 'repository')
  const home = join(workspace, 'home')
  const profileDirectory = join(workspace, 'profile')
  const skill = join(home, 'skills', 'repo-design-wiki')
  const routes = new Map()
  let dispose, authorError, authorRounds = 0, authorJobs = 0, reviewCalls = 0
  t.after(async () => { dispose?.(); await rm(workspace, { recursive: true, force: true }) })
  await mkdir(join(skill, 'references'), { recursive: true })
  await Promise.all([
    writeFile(join(skill, 'SKILL.md'), skillEntry),
    writeFile(join(skill, 'references', 'diagrams.md'), guideInstruction),
  ])
  const commit = await initRepository(repositoryPath)
  const checkpoints = createWikiCheckpoints(join(profileDirectory, 'dsh-code-wiki-checkpoints'))

  apply({
    profileContext: { dir: profileDirectory, home },
    effect(install) { dispose = install() },
    connection: { fetch: { register(route) { routes.set(route.path, route) } } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'dsh-test', model: 'dsh-wiki-model' }) },
    llm: { async *stream() {
      reviewCalls++
      yield { type: 'text-delta', text: JSON.stringify({ approved: true, issues: [] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
    agents: { async create({ setup, signal }) {
      const tools = new Map(), events = []
      const job = ++authorJobs
      setup({ tools: { restrict: scope => assert.deepEqual(scope, { allow: [] }), register: tool => tools.set(tool.name, tool) } })
      assert.deepEqual([...tools.keys()].sort(), ['wiki_find', 'wiki_list', 'wiki_read', 'wiki_read_batch', 'wiki_read_saved'])
      let round, turn = 0
      return { agent: { session: { snapshotEvents: () => events.slice() }, followup(message) {
        authorRounds++
        const eventTurn = ++turn
        events.push({ type: 'turn/start', data: { turn: eventTurn } })
        round = runAuthor({
          prompt: message.content[0].text, tools, signal, events, job, turn: eventTurn,
          async checkpoint() {
            const latest = await checkpoints.latest()
            return latest && checkpoints.get(latest.id)
          },
          finish(text, reason = { kind: 'completed' }) {
            const previous = events.findLast(event => event.type === 'assistant/message' && event.data.turn === eventTurn)
            if (text !== undefined) events.push({ type: 'assistant/message', data: {
              turn: eventTurn, step: (previous?.data.step ?? 0) + 1,
              message: { role: 'assistant', content: [{ type: 'text', text }] },
            } })
            events.push({ type: 'turn/end', data: { turn: eventTurn, reason } })
          },
        }).catch(error => { authorError = error; throw error })
      }, whenIdle: () => round, cancel() {} }, async dispose() {} }
    } },
  })

  function request(path, options) {
    const req = new Request('http://localhost' + apiRoot + path, options)
    const route = routes.get(new URL(req.url).pathname)
    assert.ok(route?.methods.includes(req.method))
    return route.fetch(req)
  }
  return {
    commit, repositoryPath, checkpoints, request,
    authorRounds: () => authorRounds, reviewCalls: () => reviewCalls,
    reportAuthorError() { if (authorError) throw authorError },
    post(path, params = {}) {
      return request(path, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repositoryPath, ...params }) })
    },
  }
}

async function gatherEvidence(tools, signal) {
  const response = await tools.get('wiki_read_batch').execute({ ranges: [
    { path: 'README.md' }, { path: 'main.js' }, { path: 'core.js' },
  ] }, { signal })
  const { results: [docs, entry, core] } = JSON.parse(response.data)
  return { docs, entry, core }
}

function opening(entry) {
  return `# 示例执行器\n\n## ${startTitle}\n\n入口把工作交给核心，再公开返回值。[E${entry.evidence}:1-2]\n\n${flow}`
}

function implementation(core) {
  return `## ${implementationTitle}\n\n当前实现返回 42，可在本函数调整。[E${core.evidence}:1]`
}

async function verifyDocument(api, document) {
  assert.equal(document.commit, api.commit)
  assert.equal(document.repositoryPath, await realpath(api.repositoryPath))
  assert.equal(document.model, 'dsh-wiki-model')
  const reopened = await api.request('documents?id=' + document.id)
  assert.equal(reopened.status, 200)
  const saved = await reopened.json()
  assert.deepEqual(saved, document)
  assert.equal('files' in saved, false)
  const citations = [...saved.markdown.matchAll(/\((https:\/\/dsh-code-wiki\.invalid\/source\?[^)]+)\)/g)]
    .map(match => new URL(match[1]))
  const citation = citations.find(url => url.searchParams.get('start') === '1' && url.searchParams.get('end') === '2')
  assert.ok(citation)
  assert.equal(citation.searchParams.get('key'), document.id)
  const source = await api.request('source' + citation.search)
  assert.equal(source.status, 200)
  assert.match(await source.text(), /2 \| export const value = run\(\)/)
}

async function synchronousDocument(api, params) {
  const response = await api.post('generate', params)
  api.reportAuthorError()
  const document = await response.json()
  assert.equal(response.status, 200, document.error)
  await verifyDocument(api, document)
  return document
}

function verifyMarkdown(document) {
  assert.equal(document.format, 'skill-markdown')
  assert.ok(document.markdown.includes('## ' + startTitle))
  assert.ok(document.markdown.includes('入口把工作交给核心，再公开返回值。'))
  assert.ok(document.markdown.includes('## ' + implementationTitle))
  assert.ok(document.markdown.includes('当前实现返回 42，可在本函数调整。'))
  assert.ok(document.markdown.includes(flow), 'the archive preserves the Skill’s original Mermaid')
  assert.doesNotMatch(document.markdown, /\[E\d+:\d|wiki:(?:continue|complete)/)
}

test('the generation route archives ordinary Skill Markdown with resolved source links', async t => {
  let spans
  const api = await skillFixture(t, async ({ prompt, tools, signal, events, turn, finish }) => {
    if (turn === 1) {
      assert.match(prompt, /repo-design-wiki/)
      assert.match(prompt, /代码百科 Markdown 存档模式/)
      assert.ok(prompt.includes(skillInstruction))
      assert.ok(prompt.includes(guideInstruction))
      spans = await gatherEvidence(tools, signal)
      events.push({ type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [
        { type: 'text', text: '工具调用前的进度说明。' },
        { type: 'tool-call', id: 'read', name: 'wiki_read_batch', arguments: '{}' },
      ] } } })
      finish(opening(spans.entry) + '\n<!-- wiki:continue -->')
    } else {
      assert.equal(turn, 2)
      assert.ok(prompt.includes(startTitle))
      finish(implementation(spans.core) + '\n<!-- wiki:complete -->')
    }
  })
  const accepted = await api.post('generation')
  assert.equal(accepted.status, 202)
  const { job: { id } } = await accepted.json()
  let result
  for (let attempt = 0; attempt < 200; attempt++) {
    const { job } = await (await api.request('generation?id=' + id)).json()
    api.reportAuthorError()
    if (job.phase === 'completed' || job.phase === 'failed') { result = job; break }
    await delay(10)
  }
  assert.equal(result?.phase, 'completed', result?.error)
  assert.equal(api.authorRounds(), 2)
  assert.equal(api.reviewCalls(), 0)
  await verifyDocument(api, result.result)
  verifyMarkdown(result.result)
  assert.doesNotMatch(result.result.markdown, /工具调用前的进度说明/)
})

test('a capped provider turn cannot save its partial Markdown or prematurely finish the document', async t => {
  const partial = '本段缺少下半部分。'
  let spans
  const api = await skillFixture(t, async ({ prompt, tools, signal, turn, checkpoint, finish }) => {
    if (turn === 1) {
      spans = await gatherEvidence(tools, signal)
      finish(opening(spans.entry) + '\n<!-- wiki:continue -->')
    } else if (turn === 2) {
      finish(`## 丢弃这段\n\n${partial}\n<!-- wiki:complete -->`, { kind: 'max-tokens' })
    } else {
      assert.equal(turn, 3)
      const saved = await checkpoint()
      assert.ok(saved.textDraft.markdown.includes(startTitle))
      assert.equal(saved.textDraft.complete, false)
      assert.ok(!saved.textDraft.markdown.includes(partial))
      assert.ok(prompt.includes(startTitle))
      finish(implementation(spans.core) + '\n<!-- wiki:complete -->')
    }
  })
  const document = await synchronousDocument(api)
  verifyMarkdown(document)
  assert.ok(!document.markdown.includes(partial))
  assert.equal(api.authorRounds(), 3)
})

test('invalid provider replies have bounded retries and authentication errors stay terminal', async t => {
  for (const [failure, attempts, expected] of [
    [{ code: 'MALFORMED_RESPONSE' }, 3, /工具参数/],
    [{ code: 'AUTH', status: 401 }, 1, /无法使用当前模型配置/],
  ]) {
    const api = await skillFixture(t, async ({ job, finish }) => {
      assert.equal(job, 1)
      finish(undefined, { kind: 'error', error: failure })
    })
    const response = await api.post('generate')
    api.reportAuthorError()
    assert.equal(response.status, 502)
    assert.match((await response.json()).error, expected)
    assert.equal(api.authorRounds(), attempts)
  }
})

test('a later job resumes complete Skill chapters with evidence IDs without replaying source text into the prompt', async t => {
  let spans
  const api = await skillFixture(t, async ({ prompt, tools, signal, job, turn, finish }) => {
    if (job === 1 && turn === 1) {
      spans = await gatherEvidence(tools, signal)
      finish(opening(spans.entry) + '\n<!-- wiki:continue -->')
    } else if (job === 1) {
      assert.equal(turn, 2)
      finish(undefined, interruptedProvider)
    } else {
      assert.equal(job, 2)
      assert.equal(turn, 1)
      assert.ok(prompt.includes(startTitle))
      assert.ok(!prompt.includes(fixtureSource), 'saved source should not be in the resumed prompt')
      assert.doesNotMatch(prompt, /A small command runner\./)
      const response = await tools.get('wiki_read_saved').execute({ ids: [spans.entry.evidence] }, { signal })
      const { results: [restored] } = JSON.parse(response.data)
      assert.equal(restored.evidence, spans.entry.evidence)
      assert.match(restored.lines, /2 \| export const value = run\(\)/)
      finish(implementation(spans.core) + '\n<!-- wiki:complete -->')
    }
  })
  const interrupted = await api.post('generate')
  api.reportAuthorError()
  assert.equal(interrupted.status, 502)
  const { job: previous } = await (await api.request('generation')).json()
  assert.equal(previous.phase, 'failed')
  assert.equal(previous.canResume, true)
  assert.equal((await api.request('documents?id=' + previous.id)).status, 404)
  const cached = await api.checkpoints.get(previous.id)
  assert.equal(cached.textDraft.complete, false)
  assert.ok(cached.textDraft.markdown.includes(startTitle))
  assert.ok(cached.evidence.some(file => file.text.includes(fixtureSource)))

  const document = await synchronousDocument(api, { resumeFrom: previous.id })
  assert.notEqual(document.id, previous.id)
  verifyMarkdown(document)
  assert.equal(api.authorRounds(), 3)
  assert.equal(api.reviewCalls(), 0)
  assert.equal(await api.checkpoints.get(previous.id), null)
})

function walkthrough({ entry, core }) {
  const refs = ({ evidence, start, end }) => [{ evidence, start, end }]
  const step = (id, module, title, value, span) => ({ id, module, title, action: title,
    outcome: value, refs: refs(span), data: { title, columns: ['字段', '值'], rows: [['表达式', value]], refs: refs(span) } })
  return { title: '执行示例', objective: '核对一次调用返回的值。',
    modules: [{ node: 'entry', chapter: 'execution', entry: 'main.js', change: '核对调用参数。', refs: refs(entry) },
      { node: 'core', chapter: 'core', entry: 'run', change: '调整返回值。', refs: refs(core) }],
    steps: [step('start', 'entry', '触发入口', 'run()', entry), step('execute', 'core', '执行函数', '42', core),
      step('result', 'entry', '取得结果', 'value = 42', entry)],
    tasks: [{ kind: 'feature', title: '修改返回值', summary: '修改 run 后核对返回值。', steps: ['execute'], refs: refs(core) },
      { kind: 'debug', title: '定位错误结果', summary: '从入口核对 run 的实现。', steps: ['result'], refs: refs(entry) }],
  }
}

test('a complete legacy draft resumes and saves when the locally installed Skill is malformed', async t => {
  const api = await skillFixture(t, async () => assert.fail('An accepted complete draft does not need an author'),
    { skillEntry: 'Broken local skill frontmatter.' })
  const evidence = [
    { path: 'README.md', start: 1, end: 1, primary: false, kind: 'documentation', text: 'A small command runner.' },
    { path: 'main.js', start: 1, end: 2, primary: true, kind: 'source', text: `import { run } from "./core.js"\n${fixtureSource}` },
    { path: 'core.js', start: 1, end: 1, primary: true, kind: 'source', text: 'export const run = () => 42' },
  ]
  const [docs, entry, core] = evidence.map(({ start, end }, index) => ({ evidence: index + 1, start, end }))
  const spans = { docs, entry, core }
  const checkpointId = randomUUID()
  const plan = withChapterDiagramPlan({ ...wikiPlanFixture(), walkthrough: { title: '执行示例', question: '一次调用如何得到结果？' } })
  const fixture = withWikiModuleCases(wikiDraftFixture(spans), spans)
  const draft = { ...withChapterDiagrams(fixture, spans), walkthrough: walkthrough(spans) }
  await api.checkpoints.save(checkpointId, { version: 1, repositoryPath: api.repositoryPath, commit: api.commit, plan, draft, evidence })

  const document = await synchronousDocument(api, { resumeFrom: checkpointId })
  assert.equal(api.authorRounds(), 0)
  assert.notEqual(document.id, checkpointId)
  assert.equal(document.views.length, 4)
  assert.equal(await api.checkpoints.get(checkpointId), null)
})
