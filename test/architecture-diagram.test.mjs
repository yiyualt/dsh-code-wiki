import assert from 'node:assert/strict'
import { test } from 'node:test'
import { textWidth } from '../skills/repo-design-wiki/scripts/diagram-svg.mjs'
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

function svgGroup(svg, label) {
  const start = svg.indexOf(`<g role="group" aria-label="${label}"`)
  assert.notEqual(start, -1, 'Missing SVG group ' + label)
  const end = svg.indexOf('>', start)
  return { attributes: svg.slice(start, end), content: svg.slice(end + 1) }
}

function rectangle({ content }) {
  const match = content.match(/^<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/u)
  assert.ok(match, 'Missing SVG group rectangle')
  const [x, y, width, height] = match.slice(1).map(Number)
  return { x, y, width, height }
}

function assertLabelFits(svg, label) {
  const group = svgGroup(svg, label)
  const box = rectangle(group)
  const heading = group.content.match(/<text\b([^>]*)>(.*?)<\/text>/u)
  assert.ok(heading, 'Missing SVG heading for ' + label)
  const fontSize = Number(heading[1].match(/font-size="([\d.]+)"/u)?.[1])
  const spans = [...heading[2].matchAll(/<tspan x="([\d.]+)" y="([\d.]+)">([^<]+)<\/tspan>/gu)]
  assert.ok(spans.length, 'Missing visible text for ' + label)
  for (const [, spanX, spanY, text] of spans) {
    const x = Number(spanX)
    const y = Number(spanY)
    assert.ok(x >= box.x && x + textWidth(text, fontSize) <= box.x + box.width, 'Horizontal bounds for ' + text)
    assert.ok(y - fontSize / 2 >= box.y && y + fontSize / 2 <= box.y + box.height, 'Vertical bounds for ' + text)
  }
  const lines = spans.map(([, , , text]) => text)
  assert.equal(lines.join('').replace(/\s/gu, ''), label.replace(/\s/gu, ''))
  return { box, lines }
}

function assertPunctuationFollowsText(lines) {
  for (const line of lines) {
    assert.doesNotMatch(line, /^[，。！？；：、）】》」]/u)
    assert.doesNotMatch(line, /[（【《「]$/u)
  }
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
  assert.doesNotMatch(svg, /aria-label="跨层公共能力"/u)
})

test('gives long labels more space and preserves punctuation when wrapping', () => {
  const groupLabel = '初始化运行环境和工作区索引（加载并核对项目配置、插件路径、默认运行参数及用户覆盖项）'
  const componentLabel = 'WorkspaceConfigurationEnvironmentResolverFactoryDefaultOptionsMapper（启动时同步并验证项目与用户配置）'
  const { svg } = render({
    title: '配置启动分层',
    layers: [{
      id: 'entry', label: '入口层',
      groups: [
        { label: groupLabel, source: 104, components: [
          { label: componentLabel, source: 125 },
          { label: '加载', source: 124 },
        ] },
        { label: '启动', source: 1 },
      ],
    }],
  })
  const capability = assertLabelFits(svg, groupLabel)
  const component = assertLabelFits(svg, componentLabel)
  assert.ok(component.lines.length > 1)
  for (const [{ box: longBox, lines }, shortLabel] of [[capability, '启动'], [component, '加载']]) {
    const { box: shortBox } = assertLabelFits(svg, shortLabel)
    assert.ok(longBox.width > shortBox.width, 'Long peer gets more width for ' + shortLabel)
    assert.equal(longBox.y, shortBox.y, 'Peers share a row for ' + shortLabel)
    assertPunctuationFollowsText(lines)
  }
})

test('renders a separate shared column with the selected bands in diagram order', () => {
  const input = architecture()
  const label = '配置（加载项目数据、同步工作区）'
  input.sharedGroups = [{ label, source: 3, layers: ['output', 'entry'] }]
  const { width, svg } = render(input)
  const shared = svgGroup(svg, label)
  assert.match(shared.attributes, /aria-description="覆盖：入口层、结果层"/u)
  assert.match(shared.content, />覆盖：入口层、结果层<\/tspan>/u)
  const panel = rectangle(svgGroup(svg, '跨层公共能力'))
  const entry = rectangle(svgGroup(svg, '入口层'))
  const { box: card, lines } = assertLabelFits(svg, label)
  assert.ok(panel.x >= entry.x + entry.width && panel.x + panel.width <= width)
  assert.ok(card.x >= panel.x && card.x + card.width <= panel.x + panel.width)
  assert.ok(lines.length > 1)
  assertPunctuationFollowsText(lines)
  assert.ok(svg.includes(`href="${repository.webUrl}/blob/${repository.commit}/src/main.js#L3"`))
})

test('rejects shared groups with absent, repeated or unknown layer scope', () => {
  for (const layers of [
    undefined, [], ['entry'], ['entry', 'entry'], ['entry', 'output', 'entry'], ['entry', 'missing'],
  ]) {
    const input = architecture()
    input.sharedGroups = [{ label: '记录指标', source: 3, layers }]
    assert.throws(() => render(input), /(?:layers|两.*层|层.*ID)/u)
  }
  const invalidSource = architecture()
  invalidSource.sharedGroups = [{ label: '记录指标', source: sources.length + 1, layers: ['entry', 'output'] }]
  assert.throws(() => render(invalidSource), /(?:source|源码)/u)
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
