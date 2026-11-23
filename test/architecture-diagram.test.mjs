import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderArchitectureDiagram } from '../skills/repo-design-wiki/scripts/render-architecture-diagram.mjs'

const repository = { webUrl: 'https://github.com/example/service', commit: '2'.repeat(40) }
const sources = Array.from({ length: 125 }, (_, index) => ({
  path: index === 124 ? 'src/defaults.js' : 'src/main.js', line: index + 1,
}))

function architecture() {
  return {
    title: '配置执行架构',
    layers: [
      { id: 'entry', label: '入口层', groups: [{ label: '请求解析', source: 1 }] },
      {
        id: 'process', label: '处理层',
        groups: [
          { label: '配置处理', source: 104, components: [
            { label: '读取覆盖项', source: 124 },
            { label: '合并默认值', source: 125 },
          ] },
          { label: '执行任务', source: 105 },
        ],
      },
      { id: 'output', label: '结果层', groups: [{ label: '结果输出', source: 2 }] },
    ],
    relations: [
      { from: 'entry', to: 'process', label: '提交配置', source: 102 },
      { from: 'output', to: 'process', label: '反馈状态', source: 103 },
    ],
  }
}

function render(input) {
  return renderArchitectureDiagram(input, sources, repository, message => new Error(message))
}

test('renders ordered logical bands and source-backed layer relations', () => {
  const { kind, svg } = render(architecture())
  assert.equal(kind, 'architecture')
  const bands = ['入口层', '处理层', '结果层'].map(label => svg.indexOf(`aria-label="${label}"`))
  assert.ok(bands[0] >= 0 && bands[0] < bands[1] && bands[1] < bands[2])
  assert.match(svg, /aria-label="配置处理"/u)
  assert.match(svg, /aria-label="合并默认值"/u)
  assert.match(svg, /aria-label="入口层 → 处理层：提交配置"/u)
  assert.match(svg, /aria-label="结果层 → 处理层：反馈状态"/u)
  for (const line of [1, 2, 102, 103, 104, 105]) {
    assert.ok(svg.includes(`href="${repository.webUrl}/blob/${repository.commit}/src/main.js#L${line}"`))
  }
  assert.match(svg, /aria-label="读取覆盖项"/u)
  assert.ok(!svg.includes('/src/main.js#L124'))
  assert.ok(svg.includes(`href="${repository.webUrl}/blob/${repository.commit}/src/defaults.js#L125"`))
  assert.match(svg, />【125】<\/tspan>/u)
})

test('renders a single logical band with a group and optional components omitted', () => {
  const { svg } = render({
    title: '请求解析架构',
    layers: [{ id: 'entry', label: '入口层', groups: [{ label: '请求解析', source: 1 }] }],
  })
  assert.match(svg, /aria-label="入口层"/u)
  assert.match(svg, /aria-label="请求解析"/u)
  assert.match(svg, /源码【1】 src\/main\.js:1/u)
})

test('rejects duplicate layers, invalid relation endpoints and invalid evidence', () => {
  const duplicate = architecture()
  duplicate.layers[1].id = duplicate.layers[0].id
  assert.throws(() => render(duplicate), /须使用不同的 ID/u)

  const skipped = architecture()
  skipped.relations[0].to = 'output'
  assert.throws(() => render(skipped), /相邻/u)

  const unknown = architecture()
  unknown.relations[0].from = 'missing'
  assert.throws(() => render(unknown), /相邻/u)

  const invalidSource = architecture()
  invalidSource.relations[0].source = sources.length + 1
  assert.throws(() => render(invalidSource), /(?:source|源码)/u)
})
