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

async function initRepository(directory) {
  await mkdir(directory)
  await Promise.all([
    writeFile(join(directory, 'main.js'), 'import { run } from "./core.js"\nexport const value = run()\n'),
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

async function skillFixture(t, runAuthor, { skillEntry = skillText } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'wiki-skill-api-'))
  const repositoryPath = join(workspace, 'repository'), home = join(workspace, 'home'), profileDirectory = join(workspace, 'profile')
  const skill = join(home, 'skills', 'repo-design-wiki')
  const routes = new Map()
  let dispose, authorError, authorRounds = 0, authorJobs = 0
  t.after(async () => { dispose?.(); await rm(workspace, { recursive: true, force: true }) })
  await mkdir(join(skill, 'references'), { recursive: true })
  await Promise.all([
    writeFile(join(skill, 'SKILL.md'), skillEntry),
    writeFile(join(skill, 'references', 'diagrams.md'), guideInstruction),
  ])
  const commit = await initRepository(repositoryPath)

  apply({
    profileContext: { dir: profileDirectory, home },
    effect(install) { dispose = install() },
    connection: { fetch: { register(route) { routes.set(route.path, route) } } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'dsh-test', model: 'dsh-wiki-model' }) },
    llm: { async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ approved: true, issues: [] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
    agents: { async create({ setup, signal }) {
      const tools = new Map(), events = []
      const job = ++authorJobs
      setup({ tools: { restrict: scope => assert.deepEqual(scope, { allow: [] }), register: tool => tools.set(tool.name, tool) } })
      assert.deepEqual([...tools.keys()].sort(), ['wiki_find', 'wiki_finish', 'wiki_list', 'wiki_read', 'wiki_read_batch',
        'wiki_submit_chapter', 'wiki_submit_plan'])
      let turn
      return { agent: { session: { snapshotEvents: () => events }, followup(message) {
        authorRounds++
        turn = runAuthor({ prompt: message.content[0].text, tools, signal, events, job })
          .catch(error => { authorError = error; throw error })
      }, whenIdle: () => turn, cancel() {} }, async dispose() {} }
    } },
  })

  function request(path, options) {
    const req = new Request('http://localhost' + apiRoot + path, options)
    const route = routes.get(new URL(req.url).pathname)
    assert.ok(route?.methods.includes(req.method))
    return route.fetch(req)
  }
  return {
    commit, repositoryPath, profileDirectory, request, authorRounds: () => authorRounds, reportAuthorError() { if (authorError) throw authorError },
    post(path, params = {}) { return request(path, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repositoryPath, ...params }) }) },
  }
}

async function gatherEvidence(tools, signal) {
  const response = await tools.get('wiki_read_batch').execute({ ranges: [
    { path: 'README.md' }, { path: 'main.js' }, { path: 'core.js' },
  ] }, { signal })
  const { results: [docs, entry, core] } = JSON.parse(response.data)
  return { docs, entry, core }
}

function planForDraft() {
  return withChapterDiagramPlan({ ...wikiPlanFixture(),
    walkthrough: { title: '执行示例', question: '一次调用如何得到结果？' } })
}

async function submitPlan(tools) {
  assert.match((await tools.get('wiki_submit_plan').execute(planForDraft())).status, /研究计划已接受/)
}

function draftFor(spans) {
  return withChapterDiagrams(withWikiModuleCases(wikiDraftFixture(spans), spans), spans)
}

async function submitChapters(tools, chapters) {
  for (const chapter of chapters) assert.match((await tools.get('wiki_submit_chapter').execute(chapter)).status, /章节已接受/)
}

async function verifyDocument(api, document) {
  assert.equal(document.commit, api.commit)
  assert.equal(document.repositoryPath, await realpath(api.repositoryPath))
  assert.equal(document.model, 'dsh-wiki-model')
  const reopened = await api.request('documents?id=' + document.id)
  assert.equal(reopened.status, 200)
  const saved = await reopened.json()
  assert.deepEqual(saved, document)
  assert.equal(saved.views.length, 4)
  assert.equal('files' in saved, false)
  const citation = new URL(saved.walkthrough.steps[0].refs[0].url)
  assert.equal(citation.searchParams.get('key'), document.id)
  const source = await api.request('source' + citation.search)
  assert.equal(source.status, 200)
  assert.match(await source.text(), /2 \| export const value = run\(\)/)
}

test('the generation route uses the installed Skill and retains accepted chapters through an isolated rewrite', async t => {
  const api = await skillFixture(t, async ({ prompt, tools, signal }) => {
    assert.match(prompt, /repo-design-wiki/)
    assert.ok(prompt.includes(skillInstruction))
    assert.ok(prompt.includes(guideInstruction))
    const spans = await gatherEvidence(tools, signal)
    await submitPlan(tools)
    const { chapters, ...metadata } = draftFor(spans)
    await submitChapters(tools, chapters.slice(0, 1))
    const invalid = structuredClone(chapters[1])
    invalid.blocks[0].refs[0].end = 99
    assert.match((await tools.get('wiki_submit_chapter').execute(invalid)).status, /提交未通过/)
    await submitChapters(tools, chapters.slice(1))
    const finish = tools.get('wiki_finish')
    const final = { ...metadata, walkthrough: walkthrough(spans) }
    const rejected = await finish.execute({ ...final, coverage: final.coverage.slice(0, 1) })
    assert.match(rejected.status, /提交未通过.*coverage\.area.*purpose、execution/)
    assert.match((await finish.execute(final)).status, /草稿已收到/)
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
  assert.equal(api.authorRounds(), 1, 'correcting one chapter does not restart the author or re-submit earlier chapters')
  await verifyDocument(api, result.result)
})

test('a subsequent job resumes with only missing Skill chapters and saves citations under its own document ID', async t => {
  const acceptedText = '项目提供一个在上次生成中已经保存的示例入口。'
  const api = await skillFixture(t, async ({ prompt, tools, signal, events, job }) => {
    if (job === 1) {
      const spans = await gatherEvidence(tools, signal)
      await submitPlan(tools)
      const original = draftFor(spans).chapters[0]
      original.blocks[0].text = acceptedText
      await submitChapters(tools, [original])
      events.push({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'TIMEOUT' } } } })
      return
    }
    assert.equal(job, 2)
    assert.match(prompt, /待提交章节：architecture、execution、core/)
    const { evidence } = JSON.parse(prompt.slice(prompt.lastIndexOf('\n{') + 1))
    const restored = Object.fromEntries(evidence.map(({ id, path, start, end }) => [path, { evidence: id, start, end }]))
    const spans = { docs: restored['README.md'], entry: restored['main.js'], core: restored['core.js'] }
    const { chapters, ...metadata } = draftFor(spans)
    const finish = () => tools.get('wiki_finish').execute({ ...metadata, walkthrough: walkthrough(spans) })
    assert.match((await finish()).status, /还有章节待提交.*architecture、execution、core/)
    await submitChapters(tools, chapters.slice(1))
    assert.match((await finish()).status, /草稿已收到/)
  })
  const interrupted = await api.post('generate')
  api.reportAuthorError()
  assert.equal(interrupted.status, 502)
  const { job: previous } = await (await api.request('generation')).json()
  assert.equal(previous.phase, 'failed')
  assert.equal(previous.canResume, true)
  assert.equal((await api.request('documents?id=' + previous.id)).status, 404)

  const resumed = await api.post('generate', { resumeFrom: previous.id })
  api.reportAuthorError()
  assert.equal(resumed.status, 200)
  const document = await resumed.json()
  assert.notEqual(document.id, previous.id)
  assert.ok(document.markdown.includes(acceptedText))
  assert.equal(api.authorRounds(), 2)
  await verifyDocument(api, document)
})

test('a complete legacy draft resumes and saves when the locally installed Skill is malformed', async t => {
  const api = await skillFixture(t, async () => assert.fail('An accepted complete draft does not need an author'),
    { skillEntry: 'Broken local skill frontmatter.' })
  const evidence = [
    { path: 'README.md', start: 1, end: 1, primary: false, kind: 'documentation', text: 'A small command runner.' },
    { path: 'main.js', start: 1, end: 2, primary: true, kind: 'source', text: 'import { run } from "./core.js"\nexport const value = run()' },
    { path: 'core.js', start: 1, end: 1, primary: true, kind: 'source', text: 'export const run = () => 42' },
  ]
  const [docs, entry, core] = evidence.map(({ start, end }, index) => ({ evidence: index + 1, start, end }))
  const spans = { docs, entry, core }
  const checkpointId = randomUUID()
  const checkpoints = createWikiCheckpoints(join(api.profileDirectory, 'dsh-code-wiki-checkpoints'))
  await checkpoints.save(checkpointId, { version: 1, repositoryPath: api.repositoryPath, commit: api.commit,
    plan: planForDraft(), draft: { ...draftFor(spans), walkthrough: walkthrough(spans) }, evidence })

  const response = await api.post('generate', { resumeFrom: checkpointId })
  api.reportAuthorError()
  assert.equal(response.status, 200)
  assert.equal(api.authorRounds(), 0)
  const document = await response.json()
  assert.notEqual(document.id, checkpointId)
  await verifyDocument(api, document)
  assert.equal(await checkpoints.get(checkpointId), null)
})
