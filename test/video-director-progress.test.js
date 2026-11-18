import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateVideoPlan } from '../src/video-plan.js'
import { editorialDocumentText, motionModelResponse, motionPipelineCalls, promotionalScriptFixture } from '../fixtures/video-motion.js'

const deferred = () => Promise.withResolvers()
const selection = { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' }
const documentFixture = () => ({
  id: '12345678-1234-4234-8234-123456789abc', source: 'local', repositoryPath: '/example/repo', repoName: 'example',
  commit: 'a'.repeat(40), markdown: editorialDocumentText, files: [],
  architecture: { layers: [{ nodes: [{ id: 'entry', refs: [] }, { id: 'trainer', refs: [] }] }],
    edges: [{ from: 'entry', to: 'trainer', refs: [] }] },
})

function fakeLlm(calls, respond) {
  return { async *stream(options) {
    calls.push(options)
    const prompt = options.messages[0].content[0].text
    const raw = await respond(options, prompt)
    yield { type: 'text-delta', text: JSON.stringify(raw) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
}

test('video progress distinguishes each model stage, story rewrite and scene repair without adding calls', async () => {
  const calls = [], events = [], stages = []
  let storyReviews = 0
  const llm = fakeLlm(calls, (options, prompt) => {
    const progress = events.at(-1).details
    const system = options.system
    const stage = system.includes('REPOSITORY EDITOR') ? 'brief'
      : system.includes('You are the DIRECTOR') ? ('previous' in JSON.parse(prompt) ? 'story-rewrite' : 'script')
        : system.includes('STORY EDITOR') ? 'story-review'
          : system.includes('MOTION DESIGNER') ? ('previous' in JSON.parse(prompt) ? 'scene-repair' : 'scene-design')
            : 'film-review'
    assert.equal(progress.step, stage, 'progress identifies the next model request before it begins')
    stages.push(stage)
    if (stage === 'story-review' && ++storyReviews === 1) {
      return { approved: false, issues: [{ sceneId: 'scene-2', reason: 'Explain the supported capability more clearly.' }] }
    }
    if (stage === 'film-review') {
      return { repairs: [{ sceneId: 'scene-2', instruction: 'Use a clearer composition for the supported capability.' }] }
    }
    return motionModelResponse(system, prompt)
  })
  const result = await generateVideoPlan(llm, selection, documentFixture(), new AbortController().signal,
    (phase, details) => events.push({ phase, details }))
  const count = promotionalScriptFixture().scenes.length
  assert.deepEqual(stages, ['brief', 'script', 'story-review', 'story-rewrite', 'story-review',
    ...Array(count).fill('scene-design'), 'film-review', 'scene-repair'])
  assert.equal(calls.length, motionPipelineCalls() + 3, 'one rewrite, its review and one repair retain the existing call count')
  assert.deepEqual(events[0], { phase: 'reading', details: { step: 'material' } })
  assert.deepEqual(events.filter(event => event.details.step === 'story-review').map(event => event.details.attempt), [1, 2])
  assert.equal(events.find(event => event.details.step === 'story-rewrite').details.attempt, 2)
  assert(events.find(event => event.details.step === 'script').details.brief.facts.length)
  assert.equal(events.find(event => event.phase === 'designing').details.script.scenes.length, count)
  assert.equal(events.find(event => event.details.step === 'film-review').details.draft.scenes.length, count)
  const repair = events.find(event => event.details.step === 'scene-repair')
  assert.equal(repair.phase, 'reviewing')
  assert.deepEqual([repair.details.sceneIndex, repair.details.sceneCount, repair.details.completedScenes, repair.details.attempt], [2, count, count, 2])
  assert.equal(result.scenes.length, count)
  for (const options of calls) for (const [key, value] of Object.entries(selection)) assert.equal(options[key], value)
})

test('three parallel scene designers report completion order while retaining story order and batch boundaries', async () => {
  const calls = [], events = [], started = [], completions = []
  const count = promotionalScriptFixture().scenes.length
  const gates = Array.from({ length: count }, deferred)
  const entered = Array.from({ length: count }, deferred)
  const completed = Array.from({ length: count }, deferred)
  let active = 0, maximum = 0, previousCompleted = 0
  const llm = fakeLlm(calls, async (options, prompt) => {
    if (!options.system.includes('MOTION DESIGNER')) return motionModelResponse(options.system, prompt)
    const scene = JSON.parse(prompt).scene
    const index = Number(scene.id.slice('scene-'.length))
    started.push(index)
    active++
    maximum = Math.max(maximum, active)
    entered[index - 1].resolve()
    try { await gates[index - 1].promise }
    finally { active-- }
    return motionModelResponse(options.system, prompt)
  })
  const pending = generateVideoPlan(llm, selection, documentFixture(), new AbortController().signal, (phase, details) => {
    events.push({ phase, details })
    if (phase === 'designing' && details.completedScenes > previousCompleted) {
      assert.equal(details.completedScenes, previousCompleted + 1)
      previousCompleted = details.completedScenes
      completions.push(details.sceneIndex)
      completed[details.sceneIndex - 1].resolve()
    }
  })
  try {
    await entered[2].promise
    assert.deepEqual(started, [1, 2, 3])
    assert.equal(active, 3)
    assert.equal(previousCompleted, 0)
    gates[1].resolve(); await completed[1].promise
    assert.deepEqual(started, [1, 2, 3], 'a new batch does not start while the first still has unfinished scenes')
    gates[0].resolve(); await completed[0].promise
    gates[2].resolve(); await completed[2].promise
    await entered[5].promise
    assert.deepEqual(started, [1, 2, 3, 4, 5, 6])
    gates[4].resolve(); await completed[4].promise
    gates[5].resolve(); await completed[5].promise
    gates[3].resolve(); await completed[3].promise
    await entered[6].promise
    gates[6].resolve(); await completed[6].promise
    const result = await pending
    assert.equal(maximum, 3)
    assert.deepEqual(completions, [2, 1, 3, 5, 6, 4, 7])
    assert.deepEqual(result.scenes.map(scene => scene.id), Array.from({ length: count }, (_, index) => `scene-${index + 1}`))
    assert.equal(calls.length, motionPipelineCalls())
    const filmReview = events.find(event => event.details.step === 'film-review')
    assert.equal(filmReview.details.completedScenes, count)
    assert.equal(filmReview.details.sceneCount, count)
  } finally {
    for (const gate of gates) gate.resolve()
    await Promise.allSettled([pending])
  }
})
