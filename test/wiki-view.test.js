import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWikiViewRenderer, layoutWikiView } from '../src/wiki-view.js'

const refs = [{ label: 'src/main.js:1–10', href: 'https://example.test/source', url: 'https://example.test/source' }]
const node = (id, role = 'component') => ({ id, role, label: id, refs })
const edge = (from, to, label = 'Passes input') => ({ from, to, label, refs })
const fixture = kind => ({ id: 'view_' + kind, kind, title: 'Verified architecture', purpose: 'Explain the verified collaboration.',
  nodes: [node('user', 'actor'), node('gateway', 'process'), node('worker', 'process'), node('storage', 'store')],
  edges: [edge('user', 'gateway', 'Sends request'), edge('gateway', 'worker', 'Starts work'),
    edge('worker', 'storage', 'Saves result'), edge('worker', 'gateway', 'Returns result')] })

function crosses(a, b, node) {
  return a[0] === b[0]
    ? a[0] > node.x && a[0] < node.x + node.w && Math.max(a[1], b[1]) > node.y && Math.min(a[1], b[1]) < node.y + node.h
    : a[1] > node.y && a[1] < node.y + node.h && Math.max(a[0], b[0]) > node.x && Math.min(a[0], b[0]) < node.x + node.w
}

test('bounded architecture view layouts keep nodes apart and route arrows around other nodes', () => {
  for (const kind of ['flow', 'dataflow', 'dependency', 'scenario', 'deployment']) {
    const view = fixture(kind), result = layoutWikiView(view)
    for (const [i, box] of result.nodes.entries()) {
      assert(box.x >= 0 && box.y >= 0 && box.x + box.w <= result.width && box.y + box.h <= result.height)
      for (const other of result.nodes.slice(i + 1)) assert(!(box.x < other.x + other.w && box.x + box.w > other.x
        && box.y < other.y + other.h && box.y + box.h > other.y), kind + ': nodes overlap')
    }
    for (const path of result.edges) {
      assert.equal(typeof path.label, 'string')
      for (let i = 1; i < path.points.length; i++) {
        assert(path.points[i - 1][0] === path.points[i][0] || path.points[i - 1][1] === path.points[i][1])
        for (const box of result.nodes) assert(!crosses(path.points[i - 1], path.points[i], box), kind + ': arrow crosses a node')
      }
      if (path.labelBox) for (const box of result.nodes) assert(!(path.labelBox.x < box.x + box.w && path.labelBox.x + path.labelBox.w > box.x
        && path.labelBox.y < box.y + box.h && path.labelBox.y + path.labelBox.h > box.y), kind + ': label overlaps a node')
    }
    assert.deepEqual(layoutWikiView(view), result, 'layout must be deterministic')
  }
})

test('sequence views retain message order and direction with participants on distinct lifelines', () => {
  const view = fixture('sequence'), result = layoutWikiView(view)
  assert.equal(new Set(result.nodes.map(item => item.x)).size, view.nodes.length)
  assert.equal(new Set(result.nodes.map(item => item.y)).size, 1)
  for (const [i, message] of result.edges.entries()) {
    const from = result.nodes.find(item => item.id === message.from), to = result.nodes.find(item => item.id === message.to)
    assert.equal(message.points[0][0], from.x + from.w / 2)
    assert.equal(message.points.at(-1)[0], to.x + to.w / 2)
    if (i) assert(message.points[0][1] > result.edges[i - 1].points[0][1])
  }
})

test('SVG rendering preserves labels as React text and exposes source links without an HTML execution API', () => {
  let count = 0
  const React = { useId: () => 'view-' + count++, useRef: () => ({ current: null }), useLayoutEffect() {},
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) }
  const render = createWikiViewRenderer(React)
  const view = fixture('sequence')
  view.nodes[0].label = '<img src=x onerror=alert(1)>'
  const output = render({ view }), nodes = []
  function collect(value) { if (value && typeof value === 'object') { nodes.push(value); value.children?.forEach(collect) } }
  collect(output)
  assert(nodes.some(item => item.type === 'svg' && item.props.role === 'img'))
  assert.equal(nodes.filter(item => item.type === 'line' && item.props.className === 'dsh-wiki-view-lifeline').length, 4)
  assert(nodes.some(item => item.type === 'title' && item.children.some(value => typeof value === 'string' && value.includes('<img'))))
  assert(nodes.some(item => item.type === 'a' && item.props.href === refs[0].href))
  assert(nodes.every(item => !('dangerouslySetInnerHTML' in item.props)))
  assert.equal(nodes.some(item => ['script', 'iframe', 'foreignObject', 'img'].includes(item.type)), false)
})

test('vertical views start centered in their own viewport without recentering other view kinds', () => {
  for (const kind of ['flow', 'dataflow', 'sequence', 'scenario', 'dependency', 'deployment']) {
    const element = { scrollWidth: 640, clientWidth: 320, scrollLeft: 0 }
    const React = { useId: () => kind, useRef: () => ({ current: element }), useLayoutEffect: effect => effect(), createElement: () => null }
    createWikiViewRenderer(React)({ view: fixture(kind) })
    assert.equal(element.scrollLeft, ['flow', 'dataflow'].includes(kind) ? 160 : 0)
  }
})

test('dense dataflow relationships retain their complete labels or a visible numbered explanation', () => {
  const data = id => node(id, 'data')
  const view = { id: 'dense_dataflow', kind: 'dataflow', title: 'Dataset to evaluation', purpose: 'Track the real representations.',
    nodes: [data('input'), { ...data('mapped'), label: '重映射 ID 的 DataFrame' },
      { ...data('split'), label: '训练、验证、测试 Interaction' }, data('train'), data('evaluate'),
      data('loss'), data('scores'), data('resources')],
    edges: [edge('input', 'mapped', '解析字段、读取 DataFrame 并重映射 ID'),
      edge('mapped', 'split', '转换为 Interaction 并排序、划分'),
      edge('split', 'train', '训练切片经 transform 与 pairwise 采样'),
      edge('split', 'evaluate', '评测切片按用户组织历史与正例坐标'),
      edge('train', 'loss', '用户、正物品、负物品计算损失'),
      edge('evaluate', 'scores', '全物品评分，屏蔽零号与历史项'),
      edge('scores', 'resources', 'Collector 取 top-k 索引，与正例信息共同生成资源'),
      edge('evaluate', 'resources', '正例坐标传给 Collector，构造命中标记及正例数')] }
  const result = layoutWikiView(view)
  for (const [i, relation] of result.edges.entries()) {
    assert(relation.labelBox || relation.numberBox, 'Every relationship has a visible diagram label')
    if (relation.labelBox) assert.equal(relation.labelBox.rows.join('').replace(/\s/g, ''), view.edges[i].label.replace(/\s/g, ''), 'Labels must not be truncated')
    else assert.equal(relation.number, i + 1)
  }
  assert(result.nodes.find(item => item.id === 'mapped').labelRows.includes('DataFrame'))
  assert(result.nodes.find(item => item.id === 'split').labelRows.includes('Interaction'))
  const React = { useId: () => 'dense', useRef: () => ({ current: null }), useLayoutEffect() {},
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) }
  const output = createWikiViewRenderer(React)({ view }), elements = []
  function collect(value) { if (value && typeof value === 'object') { elements.push(value); value.children?.forEach(collect) } }
  collect(output)
  const explanations = elements.filter(item => item.type === 'li' && item.props.value)
  assert.equal(explanations.length, result.edges.filter(item => item.number).length)
  for (const relation of result.edges.filter(item => item.number)) {
    const item = explanations.find(item => item.props.value === relation.number)
    assert(item.children.some(child => child?.type === 'span' && child.children.includes(relation.label)), 'Numbered fallback remains visible without expanding sources')
  }
})

test('word-aware node and sequence labels stay complete and allocate enough message height', () => {
  const view = { id: 'complete_sequence', kind: 'sequence', title: 'Messages', purpose: 'Keep identifiers readable.',
    nodes: [{ ...node('entry'), label: 'run_recbole 实验入口' }, { ...node('evaluate'), label: 'Collector 与 Evaluator' }],
    edges: [edge('entry', 'evaluate', '评测路径通过 Collector 保存完整 Interaction 再交给 Evaluator 计算最终指标'),
      edge('evaluate', 'entry', '返回最终指标和 checkpoint 状态文件')] }
  const result = layoutWikiView(view)
  assert(result.nodes[0].labelRows.includes('run_recbole'))
  for (const [i, message] of result.edges.entries()) {
    assert.equal(message.messageRows.join('').replace(/\s/g, ''), (i + 1 + '. ' + view.edges[i].label).replace(/\s/g, ''))
    for (const token of ['Collector', 'Interaction', 'Evaluator', 'checkpoint'].filter(token => message.label.includes(token))) {
      assert(message.messageRows.some(row => row.includes(token)), token + ' must remain whole when it fits')
    }
    assert(message.points[0][1] > message.messageY + (message.messageRows.length - 1) * 17)
    if (i) assert(message.messageY > result.edges[i - 1].points[0][1])
  }
  assert.equal(new Set(result.nodes.map(item => item.h)).size, 1)
})
