import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeMotionDesign, normalizeMotionScript } from '../src/video-director.js'
import { drawMotionScene } from '../src/video-motion.js'
import { motionDesignFixture, motionScriptFixture } from '../fixtures/video-motion.js'

const ref = { id: 1, path: 'trainer.py', start: 8, end: 13, url: 'https://example.test/source' }
const excerpt = { id: 1, path: 'trainer.py', startLine: 9,
  lines: ['def train(config):', '    model = load_model(config)', '    model.fit()', '    return model.evaluate()'] }
const evidence = 'The small split contains 20 rows and the full split contains 50 rows.'
const material = { readme: `Quick start\n\n${evidence}`, excerpts: [excerpt], references: [ref],
  commands: [{ id: 1, command: 'python train.py', ref }], images: [] }
const document = { markdown: 'The entry point passes configuration to the trainer.',
  architecture: { layers: [{ nodes: [{ id: 'entry', refs: [] }, { id: 'trainer', refs: [ref] }] }],
  edges: [{ from: 'entry', to: 'trainer' }] } }

test('motion scenes retain narration order and beat word positions', () => {
  const script = normalizeMotionScript(motionScriptFixture())
  assert.equal(script.language, 'en')
  assert.equal(script.motionVersion, 1)
  assert.equal(script.scenes.length, 7)
  assert.equal(script.scenes[0].id, 'scene-1')
  assert.equal(script.scenes[0].narration, script.scenes[0].beats.map(beat => beat.narration).join(' '))
  assert.deepEqual(script.scenes[0].beats.map(beat => beat.wordIndex), [0, 11, 23])

  const missing = motionScriptFixture(); missing.scenes[1].beats.pop(); missing.scenes.pop()
  assert.throws(() => normalizeMotionScript(missing), /7 至 10/)
  const mark = motionScriptFixture(); mark.scenes[0].beats[1].narration = '<say>invalid stage direction</say>'
  assert.throws(() => normalizeMotionScript(mark), /拍点 2/)
})

test('motion timing binds each change to an exact phrase within its own beat', () => {
  const scene = normalizeMotionScript(motionScriptFixture()).scenes[0]
  const raw = motionDesignFixture(scene)
  raw.elements[1].at = 'its own settings'
  raw.actions[0].at = 'shows what changed'
  const design = normalizeMotionDesign(raw, scene, document, material).motion
  assert.equal(design.elements[0].at, 0)
  assert.equal(design.elements[1].wordIndex, 14)
  assert.equal(design.elements[1].at, 14 / 32)
  assert.equal(design.actions[0].wordIndex, 25)

  const unknown = motionDesignFixture(scene); unknown.elements[1].at = 'report shows'
  assert.throws(() => normalizeMotionDesign(unknown, scene, document, material), /不在对应拍点/)
  const id = motionDesignFixture(scene); id.elements[1].id = 'theme'
  assert.throws(() => normalizeMotionDesign(id, scene, document, material), /类型或编号/)
  const missing = motionDesignFixture(scene); missing.actions.length = 0
  assert.throws(() => normalizeMotionDesign(missing, scene, document, material), /第 3 拍没有画面变化/)
})

test('the first subject is visible at the scene boundary while same-beat actions retain their cues', () => {
  const scene = normalizeMotionScript(motionScriptFixture()).scenes[0]
  const raw = motionDesignFixture(scene)
  raw.elements[0].at = 'model'
  raw.actions.unshift({ do: 'highlight', target: 'theme', beat: 1, at: 'dataset' },
    { do: 'restore', target: 'theme', beat: 1, at: 'compare' })
  const design = normalizeMotionDesign(raw, scene, document, material).motion
  assert.equal(design.elements[0].at, 0)
  assert.equal(design.elements[0].wordIndex, 0)
  assert.equal(design.elements[0].beat, 1)
  assert.deepEqual(design.actions.map(({ at, wordIndex }) => [at, wordIndex]).slice(0, 2), [[5 / 32, 5], [10 / 32, 10]])
})

test('commands and highlighted source lines come from the supplied citations', () => {
  const scene = normalizeMotionScript(motionScriptFixture()).scenes[5]
  const raw = { layout: 'split', elements: [
    { id: 'run', kind: 'command', commandRef: 1, command: 'rm -rf /', beat: 1 },
    { id: 'source', kind: 'code', sourceRef: 1, focusLine: 9, beat: 2 },
  ], actions: [{ do: 'highlight', target: 'source', line: 11, lineEnd: 12, beat: 3 }] }
  const result = normalizeMotionDesign(raw, scene, document, material).motion
  assert.equal(result.elements[0].command, 'python train.py')
  assert.equal(result.elements[1].ref, ref)
  assert.equal(result.elements[1].startLine, excerpt.startLine)
  assert.deepEqual(result.elements[1].lines, excerpt.lines)
  assert.deepEqual(result.actions.map(({ line, lineEnd }) => [line, lineEnd]), [[11, 12]])
  assert.throws(() => normalizeMotionDesign(raw, scene, document, { ...material, commands: [] }), /真实命令/)
  assert.throws(() => normalizeMotionDesign(raw, scene, document, { ...material, references: [] }), /有效引用/)
  assert.throws(() => normalizeMotionDesign(raw, scene, document, { ...material, excerpts: [] }), /已读取/)
  raw.elements[1].focusLine = 8
  assert.throws(() => normalizeMotionDesign(raw, scene, document, material), /不在已读取的源码片段/)
  raw.elements[1].focusLine = 9
  raw.actions[0].line = 14
  assert.throws(() => normalizeMotionDesign(raw, scene, document, material), /真实行号/)

  const longer = { ...material, references: [{ ...ref, start: 8, end: 32 }],
    excerpts: [{ ...excerpt, startLine: 8, lines: Array.from({ length: 25 }, (_, i) => `line ${i + 8}`) }] }
  raw.elements[1].focusLine = 12
  Object.assign(raw.actions[0], { line: 16, lineEnd: 18 })
  assert.throws(() => normalizeMotionDesign(raw, scene, document, longer), /当前只显示 10 至 17 行/)
  raw.actions[0].lineEnd = 17
  assert.equal(normalizeMotionDesign(raw, scene, document, longer).motion.actions[0].lineEnd, 17)
})

test('motion rejects numbers without an exact evidence quote containing every displayed value', () => {
  const scene = normalizeMotionScript(motionScriptFixture()).scenes[3]
  const number = { id: 'rows', kind: 'number', label: 'Rows', value: 20, beat: 2 }
  const layout = { layout: 'row', elements: [{ id: 'theme', kind: 'heading', text: 'Split size', beat: 1 }, number],
    actions: [{ do: 'count', target: 'rows', value: 50, evidence, beat: 3 }] }
  assert.throws(() => normalizeMotionDesign(layout, scene, document, material), /evidence/)
  number.evidence = 'The small split contains 20 examples.'
  assert.throws(() => normalizeMotionDesign(layout, scene, document, material), /evidence/)
  number.evidence = evidence
  assert.equal(normalizeMotionDesign(layout, scene, document, material).motion.actions[0].value, 50)
  layout.actions[0].value = 60
  assert.throws(() => normalizeMotionDesign(layout, scene, document, material), /evidence/)
  layout.actions = [{ do: 'highlight', target: 'rows', beat: 3 }]
  layout.elements[1] = { id: 'rows', kind: 'table', columns: ['Split', 'Rows'], rows: [['Small', '20'], ['Full', '60']], evidence, beat: 2 }
  assert.throws(() => normalizeMotionDesign(layout, scene, document, material), /evidence/)

  const numericQuote = 'The release reports 94.5 points, 1,000 rows and −10 dollars.'
  const richer = { ...material, readme: numericQuote }
  Object.assign(layout.elements[1], { rows: [['Points', '94.5 points'], ['Full', '1,000 rows'], ['Cost', '−$10']], evidence: numericQuote })
  assert.equal(normalizeMotionDesign(layout, scene, document, richer).motion.elements[1].rows.length, 3)
  layout.elements[1].rows[0][1] = '94 points'
  assert.throws(() => normalizeMotionDesign(layout, scene, document, richer), /evidence/)
  layout.elements[1].rows = [['Points', '94 points']]
  layout.elements[1].evidence = '94'
  assert.throws(() => normalizeMotionDesign(layout, scene, document, richer), /evidence/)
  layout.elements[1].rows[0][1] = '94.5 points\u202e'
  assert.throws(() => normalizeMotionDesign(layout, scene, document, richer), /单行文字/)
})

test('motion connectors use verified direction and cannot appear before their subjects', () => {
  const scene = normalizeMotionScript(motionScriptFixture()).scenes[3]
  const raw = { layout: 'row', elements: [
    { id: 'entry', kind: 'node', node: 'entry', label: 'Entry', beat: 1 },
    { id: 'trainer', kind: 'node', node: 'trainer', label: 'Trainer', beat: 2, at: 'uses those settings' },
    { id: 'starts', kind: 'arrow', from: 'entry', to: 'trainer', beat: 1 },
  ], actions: [{ do: 'flow', target: 'starts', beat: 3 }] }
  const result = normalizeMotionDesign(raw, scene, document, material).motion
  for (const key of ['at', 'wordIndex', 'beat']) assert.equal(result.elements[2][key], result.elements[1][key])
  raw.elements[2].from = 'trainer'; raw.elements[2].to = 'entry'
  assert.throws(() => normalizeMotionDesign(raw, scene, document, material), /已验证方向/)
  raw.elements[2].to = 'missing'
  assert.throws(() => normalizeMotionDesign(raw, scene, document, material), /两个不同元素/)
})

test('motion connector paths avoid intervening cards and preserve arrow direction after seeking', () => {
  function recorder(scene) {
    let path
    let paths = [], heads = [], rectangles = []
    const states = []
    const ctx = new Proxy({
      globalAlpha: 1,
      save() { states.push({ globalAlpha: ctx.globalAlpha }) },
      restore() { Object.assign(ctx, states.pop()) },
      beginPath() { path = [] },
      moveTo(x, y) { path?.push([x, y]) },
      lineTo(x, y) { path?.push([x, y]) },
      roundRect(x, y, w, h) { path = null; if (w > 100 && h > 40) rectangles.push({ x, y, w, h }) },
      stroke() { if (path?.length > 1) paths.push(path) },
      fill() { if (path?.length > 1) heads.push(path) },
      measureText: value => ({ width: String(value).length * 10 }),
    }, { get: (target, key) => key in target ? target[key] : () => {} })
    return progress => {
      paths = []; heads = []; rectangles = []
      drawMotionScene(ctx, scene, progress, progress * scene.speechSeconds)
      return { paths, heads, cards: rectangles.filter((_, i) => i % 2 === 1) }
    }
  }
  for (const layout of ['column', 'split']) for (const reverse of [false, true]) {
    const scene = { speechSeconds: 10, motion: { layout, transition: 'cut', actions: [], elements: [
      { id: 'a', kind: 'node', text: 'Entry', at: 0 },
      { id: 'b', kind: 'node', text: 'Unrelated worker', at: 0 },
      { id: 'c', kind: layout === 'split' ? 'command' : 'node', text: 'Store', command: 'store', at: 0 },
      { id: 'ac', kind: 'arrow', from: reverse ? 'c' : 'a', to: reverse ? 'a' : 'c', at: 0 },
    ] } }
    const render = recorder(scene)
    const initial = render(1)
    assert.equal(initial.cards.length, 3)
    assert.equal(initial.paths.length, 1, `${layout} must retain the connection`)
    const points = initial.paths[0]
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1], [bx, by] = points[i]
      assert(ax === bx || ay === by, 'connections must stay orthogonal')
      for (const card of initial.cards) {
        const crosses = ax === bx
          ? ax > card.x && ax < card.x + card.w && Math.max(ay, by) > card.y && Math.min(ay, by) < card.y + card.h
          : ay > card.y && ay < card.y + card.h && Math.max(ax, bx) > card.x && Math.min(ax, bx) < card.x + card.w
        assert(!crosses, `${layout} ${reverse ? 'C→A' : 'A→C'} must not cross a card`)
      }
    }
    const source = initial.cards[reverse ? 2 : 0], destination = initial.cards[reverse ? 0 : 2]
    const axis = layout === 'column' ? 1 : 0
    const sign = reverse ? -1 : 1
    const port = (card, offset) => axis
      ? [card.x + card.w / 2, card.y + card.h / 2 + sign * (card.h / 2 + offset)]
      : [card.x + card.w / 2 + sign * (card.w / 2 + offset), card.y + card.h / 2]
    assert.deepEqual(points[0], port(source, 1))
    const expectedEnd = axis
      ? [destination.x + destination.w / 2, destination.y + destination.h / 2 - sign * (destination.h / 2 + 3)]
      : [destination.x + destination.w / 2 - sign * (destination.w / 2 + 3), destination.y + destination.h / 2]
    assert.deepEqual(points.at(-1), expectedEnd)
    const [tip, left, right] = initial.heads[0]
    assert.deepEqual(tip, expectedEnd)
    assert(sign * (tip[axis] - (left[axis] + right[axis]) / 2) > 0, 'arrowhead must point into its destination')
    render(.08); render(.73)
    const replay = render(1)
    assert.deepEqual(replay.paths, initial.paths, 'seeking must reproduce the same route')
    assert.deepEqual(replay.heads, initial.heads)
  }
})
