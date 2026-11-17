import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { apply } from '../index.js'
import { createWikiStorage } from '../src/wiki-storage.js'
import { createVideoStorage } from '../src/video-storage.js'
import { generateVideoPlan, normalizeVideoScript, normalizeVideoDesign } from '../src/video-plan.js'
import { voiceVideo, waveSeconds } from '../src/video-speech.js'
import { codeWikiVideoFrame } from '../src/video-scene.js'

function documentFixture() {
  return { id: randomUUID(), createdAt: new Date().toISOString(), source: 'github', repoUrl: 'https://github.com/example/repo',
    commit: 'a'.repeat(40), markdown: '# 示例\n\n## 架构\n入口读取数据，训练器训练并返回评估结果。',
    architecture: { layers: [
      { title: '入口', nodes: [{ id: 'entry', title: '实验入口', summary: '读取配置并启动训练。', technology: 'Python', refs: [] }] },
      { title: '训练', nodes: [{ id: 'trainer', title: '训练器', summary: '训练模型并返回指标。', technology: 'PyTorch', refs: [] }] },
    ], edges: [{ from: 'entry', to: 'trainer', label: '启动训练', refs: [] }] } }
}
function scriptFixture() {
  return { title: 'One training experiment', scenes: [
    { kind: 'intro', title: 'Purpose', headline: 'Run a training experiment', nodes: [],
      narration: "This project runs training experiments. You choose settings for a run and get evaluation results that show how the trained model performed." },
    { kind: 'architecture', title: 'Main components', headline: 'Two parts run the experiment', nodes: ['entry', 'trainer'],
      narration: "The entry point reads the experiment configuration. The trainer uses those settings to run the model and returns the measurements you need to check the result." },
    { kind: 'flow', title: 'One run', headline: 'From configuration to results', nodes: ['entry', 'trainer'],
      narration: "When you start a run, the entry point reads the input data and passes the configuration to the trainer. Once training finishes, the trainer returns evaluation results." },
    { kind: 'detail', title: 'Training responsibility', headline: 'The trainer owns model execution', nodes: ['trainer'],
      narration: "The trainer handles model execution and evaluation in PyTorch. The entry point can prepare new settings for another run while keeping the same training procedure." },
  ] }
}
const nodeDesigns = {
  entry: { id: 'entry', label: 'Entry point', action: 'Reads configuration' },
  trainer: { id: 'trainer', label: 'Trainer', action: 'Runs the model' },
  metrics: { id: 'metrics', label: 'Metrics' },
}
const designFixture = script => ({ scenes: script.scenes.map((scene, i) => ({ id: `scene-${i + 1}`, layout: 'row',
  nodes: scene.nodes.map(id => nodeDesigns[id]), edges: scene.kind === 'flow' ? [{ ref: 1, label: 'Starts training' }] : [],
  cues: scene.nodes.map(node => ({ node, word: nodeDesigns[node].label })),
})) })
function fakeLlm(calls = [], wait) {
  return { async *stream(options) {
    calls.push(options)
    if (wait) await wait(options.signal)
    const raw = options.system.includes('You write the narration') ? scriptFixture() : designFixture(scriptFixture())
    yield { type: 'text-delta', text: JSON.stringify(raw) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
}
function wav(seconds = 1) {
  const data = Buffer.alloc(44 + 22050 * 2 * seconds)
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22)
  data.writeUInt32LE(22050, 24); data.writeUInt32LE(44100, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34)
  data.write('data', 36); data.writeUInt32LE(data.length - 44, 40)
  return data
}

test('the English storyboard keeps only selected source relationships and spoken cues', () => {
  const doc = documentFixture()
  const script = normalizeVideoScript(scriptFixture(), doc)
  const designed = normalizeVideoDesign(designFixture(script), script, doc)
  assert.equal(designed.language, 'en')
  assert.deepEqual(designed.scenes[0].nodes, [])
  assert.deepEqual(designed.scenes[1].edges, [])
  assert.deepEqual(designed.scenes[2].edges, [{ from: 'entry', to: 'trainer', label: 'Starts training', refs: [] }])
  assert.equal(designed.scenes[1].nodes[0].technology, 'Python')
  assert.equal(designed.scenes[1].nodes[0].label, 'Entry point')
  assert.ok(designed.scenes[1].cues[1].offset > 0)
  const unknown = scriptFixture(); unknown.scenes[2].nodes = ['made-up']
  assert.throws(() => normalizeVideoScript(unknown, doc), /组件/)
  const missing = scriptFixture(); missing.scenes[1].kind = 'detail'
  assert.throws(() => normalizeVideoScript(missing, doc), /architecture/)
  const long = scriptFixture(); long.scenes[0].narration = 'One '.repeat(100) + 'end.'
  assert.throws(() => normalizeVideoScript(long, doc), /旁白/)
  const cues = designFixture(script); cues.scenes[1].cues[0].word = 'tain'
  assert.deepEqual(normalizeVideoDesign(cues, script, doc).scenes[1].cues.map(cue => cue.node), ['trainer'])
  const relation = designFixture(script); relation.scenes[2].edges[0].ref = 2
  assert.deepEqual(normalizeVideoDesign(relation, script, doc).scenes[2].edges, [
    { from: 'entry', to: 'trainer', label: '', refs: [] },
  ])
  const ids = designFixture(script); ids.scenes[1].id = 'scene-1'
  assert.throws(() => normalizeVideoDesign(ids, script, doc), /编号/)
})

test('flow diagrams recover out-of-scene IDs and long labels using saved edges to cover every node', () => {
  const doc = documentFixture()
  doc.architecture.layers[0].nodes.push({ id: 'metrics', title: '指标', refs: [] }, { id: 'unrelated', title: '其他', refs: [] })
  const evidence = { label: 'trainer.py:12–21', url: 'https://github.com/example/repo/blob/' + doc.commit + '/trainer.py#L12-L21' }
  doc.architecture.edges.push(
    { from: 'trainer', to: 'entry', label: '状态回报', refs: [] },
    { from: 'trainer', to: 'unrelated', label: '发送日志', refs: [] },
    { from: 'trainer', to: 'metrics', label: '记录评估指标', refs: [evidence] },
  )
  const source = scriptFixture()
  source.scenes[2].nodes.push('metrics')
  const script = normalizeVideoScript(source, doc)
  const design = designFixture(script)
  design.scenes[2].edges = [
    { ref: 3, label: 'Writes logs' },
    { ref: 1, label: 'Runs the entire experiment from the chosen configuration' },
    { ref: 2, label: 'Reports status' },
  ]
  assert.deepEqual(normalizeVideoDesign(design, script, doc).scenes[2].edges, [
    { from: 'entry', to: 'trainer', label: '', refs: [] },
    { from: 'trainer', to: 'metrics', label: '', refs: [evidence] },
  ])
})

test('director and designer retain the selected provider/model/reasoning and repair an invalid script once', async () => {
  const calls = []
  let bad = true
  const valid = fakeLlm(calls)
  const llm = { async *stream(options) {
    if (bad) { bad = false; yield { type: 'text-delta', text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    yield* valid.stream(options)
  } }
  const selection = { provider: 'deepseek', model: 'selected-model', reasoningEffort: 'high' }
  const plan = await generateVideoPlan(llm, selection, documentFixture(), new AbortController().signal)
  assert.equal(plan.scenes.length, 4)
  assert.equal(calls.length, 2)
  for (const options of calls) for (const [key, value] of Object.entries(selection)) assert.equal(options[key], value)
  assert.match(calls[0].messages[0].content[0].text, /上次输出校验未通过/)
})

test('narration uses actual PCM durations, subtitle mode is explicit, and empty audio is rejected', async () => {
  const script = normalizeVideoScript(scriptFixture(), documentFixture())
  const plan = normalizeVideoDesign(designFixture(script), script, documentFixture())
  assert.equal(waveSeconds(wav(2)), 2)
  assert.throws(() => waveSeconds(wav(0)), /有效音频/)
  const signal = new AbortController().signal
  const voiced = await voiceVideo(plan, { available: true, kind: 'test', label: 'fixture', speak: async () => ({ bytes: wav(2), seconds: 2 }) }, signal)
  assert.equal(voiced.scenes[1].start, 2.8)
  assert.equal(voiced.clips.length, plan.scenes.length)
  const silent = await voiceVideo(plan, { available: false, kind: 'none', label: '字幕版' }, signal)
  assert.equal(silent.clips.length, 0)
  assert.equal(silent.speech.available, false)
  assert.ok(silent.duration > 20)
})

test('saved video and audio reopen together and cannot be read through invalid paths', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wiki-video-storage-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const storage = createVideoStorage(dir)
  const doc = documentFixture()
  const artifact = { version: 1, id: randomUUID(), documentId: doc.id, createdAt: new Date().toISOString(), scenes: [{}], speech: { available: true } }
  await storage.save(artifact, [wav()])
  assert.equal((await storage.latest(doc.id)).id, artifact.id)
  assert.deepEqual(await storage.audio(doc.id, artifact.id, 0), wav())
  assert.equal(await storage.audio(doc.id, artifact.id, -1), null)
  assert.equal(await storage.get('../outside', artifact.id), null)
  await storage.remove(doc.id)
  assert.equal(await storage.latest(doc.id), null)
})

async function apiFixture(t, services = {}, config) {
  const dir = await mkdtemp(join(tmpdir(), 'wiki-video-api-'))
  const routes = new Map()
  const dispose = []
  apply({ profileContext: { dir }, effect: effect => dispose.push(effect()),
    connection: { fetch: { register: route => routes.set(route.path, route) } },
    llm: fakeLlm(), agentDefaultModel: { currentSelection: () => ({ provider: 'dsh', model: 'dsh-model' }) }, ...services }, config)
  t.after(async () => { dispose.forEach(fn => fn()); await rm(dir, { recursive: true, force: true }) })
  const documents = createWikiStorage(join(dir, 'dsh-code-wiki', 'documents'))
  const doc = documentFixture()
  await documents.save(doc)
  const request = (path, body) => {
    const req = new Request('http://localhost/api/dsh-code-wiki/' + path, body ? {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    } : undefined)
    return routes.get(new URL(req.url).pathname).fetch(req)
  }
  return { request, doc, dir }
}
async function waitJob(request, id) {
  for (let i = 0; i < 100; i++) {
    const { job } = await (await request('video/job?id=' + id)).json()
    if (['completed', 'failed', 'cancelled'].includes(job.phase)) return job
    await delay(10)
  }
  throw new Error('Job did not finish')
}

test('opening and rereading a document or video never starts model generation', async t => {
  const calls = []
  const { request, doc } = await apiFixture(t, { llm: fakeLlm(calls) })
  for (let i = 0; i < 3; i++) {
    assert.equal((await request('documents?id=' + doc.id)).status, 200)
    const saved = await (await request('video?documentId=' + doc.id)).json()
    assert.equal(saved.artifact, null)
    assert.equal(saved.job, null)
  }
  assert.equal(calls.length, 0)
  const accepted = await request('video', { documentId: doc.id, narration: false })
  const generated = await waitJob(request, (await accepted.json()).job.id)
  assert.equal(generated.phase, 'completed')
  assert.equal(calls.length, 2)
  for (let i = 0; i < 3; i++) {
    const saved = await (await request('video?documentId=' + doc.id)).json()
    assert.equal(saved.artifact.id, generated.id)
    assert.equal(saved.job, null)
  }
  assert.equal(calls.length, 2, 'reopening an existing video must reuse it')
})

test('requesting Charon without credentials does not use another voice or start model generation', async t => {
  const previous = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  t.after(() => { if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous })
  const calls = []
  const { request, doc } = await apiFixture(t, { llm: fakeLlm(calls) })
  const { speech, alternative } = await (await request('video/capabilities')).json()
  assert.equal(speech.available, false)
  assert.equal(alternative, undefined)
  assert.match(speech.error, /OpenRouter/)
  for (const choice of [{ voice: 'charon' }, { narration: true }, {}]) {
    const response = await request('video', { documentId: doc.id, ...choice })
    assert.equal(response.status, 422)
    assert.match((await response.json()).error, /OpenRouter/)
  }
  assert.equal((await request('video', { documentId: doc.id, voice: 'system-default' })).status, 400)
  assert.equal(calls.length, 0)
  const accepted = await request('video', { documentId: doc.id, voice: 'none' })
  assert.equal(accepted.status, 202)
  const completed = await waitJob(request, (await accepted.json()).job.id)
  assert.equal(completed.artifact.speech.available, false)
})

test('reopening shows a regeneration failure while retaining the last saved video', async t => {
  let fail = false
  const llm = { async *stream(options) {
    if (!fail) yield* fakeLlm().stream(options)
    else {
      yield { type: 'text-delta', text: '{}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  } }
  const { request, doc } = await apiFixture(t, { llm })
  const generate = async () => {
    const response = await request('video', { documentId: doc.id, voice: 'none' })
    return waitJob(request, (await response.json()).job.id)
  }
  const completed = await generate()
  fail = true
  const failed = await generate()
  assert.equal(failed.phase, 'failed')
  const saved = await (await request('video?documentId=' + doc.id)).json()
  assert.equal(saved.artifact.id, completed.artifact.id)
  assert.equal(saved.lastFailure, failed.error)
})

test('video API generates with the DSH default, reopens, regenerates with the changed model and deletes its archive', async t => {
  let model = 'first-model'
  const calls = []
  const { request, doc } = await apiFixture(t, { llm: fakeLlm(calls), agentDefaultModel: { currentSelection: () => ({ provider: 'dsh', model }) } })
  assert.equal((await request('video', { documentId: '../outside', narration: false })).status, 400)
  const accepted = await request('video', { documentId: doc.id, narration: false })
  assert.equal(accepted.status, 202)
  const result = await waitJob(request, (await accepted.json()).job.id)
  assert.equal(result.phase, 'completed', result.error)
  assert.equal(result.artifact.model, 'first-model')
  assert.equal((await (await request('video?documentId=' + doc.id)).json()).artifact.id, result.id)
  model = 'second-model'
  const again = await request('video', { documentId: doc.id, narration: false })
  const second = await waitJob(request, (await again.json()).job.id)
  assert.equal(second.artifact.model, model)
  assert.equal(calls.length, 4)
  assert.equal((await request('documents/delete', { id: doc.id })).status, 204)
  assert.equal((await request('video?documentId=' + doc.id)).status, 404)
  assert.equal((await (await request('video/job?id=' + result.id)).json()).job, null)
})

test('concurrent video requests are serialized and cancellation terminates the model call', async t => {
  const calls = []
  const llm = fakeLlm(calls, signal => delay(60_000, undefined, { signal }))
  const { request, doc } = await apiFixture(t, { llm })
  const results = await Promise.all([request('video', { documentId: doc.id, narration: false }), request('video', { documentId: doc.id, narration: false })])
  assert.deepEqual(results.map(result => result.status).sort(), [202, 409])
  const job = (await results.find(result => result.status === 202).json()).job
  assert.equal((await request('documents/delete', { id: doc.id })).status, 409)
  await request('video/job', { id: job.id })
  const cancelled = await waitJob(request, job.id)
  assert.equal(cancelled.phase, 'cancelled')
  assert.ok(calls.length <= 1)
})

test('personal GPT configuration overrides DSH for both video roles', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wiki-video-model-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'model.json')
  await writeFile(path, JSON.stringify({ judge: { url: 'https://model.invalid/v1/chat/completions', model: 'personal-gpt', api_key: 'test-only' } }))
  const calls = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body)
    calls.push(body)
    const value = body.messages[0].content.includes('You write the narration') ? scriptFixture() : designFixture(scriptFixture())
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] })
  })
  const { request, doc } = await apiFixture(t, { agentDefaultModel: { currentSelection() { assert.fail('Must not use DSH for a personal override') } } }, { modelConfigFile: path })
  const accepted = await request('video', { documentId: doc.id, narration: false })
  const result = await waitJob(request, (await accepted.json()).job.id)
  assert.equal(result.phase, 'completed', result.error)
  assert.equal(result.artifact.model, 'personal-gpt')
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.model === 'personal-gpt'))
})

test('the frame renderer can seek all layouts deterministically, with no DOM or external assets', async () => {
  const script = normalizeVideoScript(scriptFixture(), documentFixture())
  const plan = normalizeVideoDesign(designFixture(script), script, documentFixture())
  const narrated = await voiceVideo(plan, { available: false, kind: 'none', label: '字幕版' }, new AbortController().signal)
  const film = { ...narrated, language: plan.language, repository: 'example/repo', commit: 'a'.repeat(40) }
  const drawn = []
  const context = new Proxy({
    fillText: value => drawn.push(String(value)), measureText: value => ({ width: String(value).length * 12 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => key in target ? target[key] : () => {} })
  const canvas = { width: 1280, height: 720, getContext: () => context }
  for (const scene of film.scenes) {
    for (const layout of ['row', 'column', 'hub']) {
      scene.layout = layout
      const result = codeWikiVideoFrame(canvas, film, scene.start + 2)
      assert.equal(result.scene.id, scene.id)
    }
  }
  assert.ok(drawn.includes('Trainer'))
  assert.ok(drawn.includes('Entry point'))
  assert.equal(codeWikiVideoFrame(canvas, film, 0).index, 0)
  const visible = []
  context.fillText = value => visible.push({ text: String(value), alpha: context.globalAlpha })
  codeWikiVideoFrame(canvas, film, film.scenes[1].start)
  assert.ok(visible.some(item => item.text === 'Entry point' && item.alpha > 0), 'scene-boundary seeks must show the cards')
  assert.ok(visible.some(item => item.text === film.scenes[1].headline && item.alpha > 0), 'scene-boundary seeks must show the heading')
  drawn.length = 0
  context.fillText = value => drawn.push(String(value))
  const graphTime = film.scenes[1].start + 2
  codeWikiVideoFrame(canvas, film, graphTime)
  const withCaptions = [...drawn]
  drawn.length = 0
  codeWikiVideoFrame(canvas, film, graphTime, { captions: false })
  assert.equal(withCaptions.length, drawn.length + 1, 'hiding subtitles removes only the caption')
  assert.ok(drawn.includes('Trainer'), 'architecture labels remain visible without subtitles')
  drawn.length = 0
  const flow = film.scenes[2]
  codeWikiVideoFrame(canvas, film, flow.start, { captions: false })
  assert.ok(drawn.includes('Entry point'))
  assert.ok(!drawn.includes('Trainer'), 'subsequent flow components enter when their cue is spoken')
  codeWikiVideoFrame(canvas, film, flow.start + flow.speechSeconds, { captions: false })
  assert.ok(drawn.includes('Trainer'))
})

test('saved Chinese scene labels and subtitles remain readable', () => {
  const drawn = []
  const context = new Proxy({
    fillText: value => drawn.push(value), measureText: value => ({ width: value.length * 20 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => key in target ? target[key] : () => {} })
  const canvas = { width: 1280, height: 720, getContext: () => context }
  const film = { repository: 'example/repo', scenes: [{ kind: 'architecture', title: '组件', narration: '训练器执行训练。',
    start: 0, speechSeconds: 5, layout: 'row', nodes: [{ id: 'trainer', title: '训练器' }], edges: [], cues: [] }] }
  codeWikiVideoFrame(canvas, film, 0)
  assert.ok(drawn.includes('训练器'))
  assert.ok(drawn.includes('训练器执行训练。'))
})
