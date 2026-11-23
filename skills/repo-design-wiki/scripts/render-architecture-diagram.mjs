import {
  diagramColors, diagramSourceAt, escapeSvg, renderCitation, svgFigure, svgText, textWidth, wrapText,
} from './diagram-svg.mjs'
import { singleLine } from './wiki-generation.mjs'

const layerColors = [
  { band: '#eef5fd', rail: '#dceafd', border: '#a2bbdf', tile: '#eaf2fc', ink: '#213f65' },
  { band: '#f3f0fb', rail: '#e8dff7', border: '#b9a9d7', tile: '#f0ebf8', ink: '#4b3772' },
  { band: '#edf7f4', rail: '#d8eee6', border: '#9cbeaf', tile: '#e8f3ee', ink: '#254f44' },
  { band: '#fbf6ec', rail: '#f5e8cb', border: '#ccba92', tile: '#f9f2e3', ink: '#624e26' },
  { band: '#fbf1f4', rail: '#f3e1e8', border: '#cbb0be', tile: '#f8eef3', ink: '#624254' },
]

const width = 820
const canvasPadding = 12
const layerWidth = width - 2 * canvasPadding
const railWidth = 132
const layerPadding = 9
const groupsWidth = layerWidth - railWidth - 2 * layerPadding
const groupsX = canvasPadding + railWidth + layerPadding
const groupGap = 8
const tileGap = 5
const groupPadding = 8
const tilePadding = 6
const layerGap = 8

function readText(value, field, invalid) {
  const text = singleLine(value)
  if (!text.isWellFormed() || !/[\p{L}\p{N}]/u.test(text)) throw invalid(field + '须为有效的单行文字。')
  return text
}

function readSourcedLabel(input, field, sourceCount, invalid) {
  const label = readText(input?.label, field + '名称', invalid)
  const { source } = input
  if (!Number.isSafeInteger(source) || source < 1 || source > sourceCount) {
    throw invalid(field + '须用 source 引用本次读取的源码序号。')
  }
  return { label, source }
}

function readLayers(input, sources, invalid) {
  if (!Array.isArray(input) || !input.length) throw invalid('逻辑架构图至少需要一个层。')
  const indices = new Map()
  const layers = input.map((layer, index) => {
    const id = readText(layer?.id, '层 ID', invalid)
    if (indices.has(id)) throw invalid('每个层须使用不同的 ID。')
    indices.set(id, index)
    const label = readText(layer.label, '层名称', invalid)
    if (!Array.isArray(layer.groups) || !layer.groups.length) throw invalid('每个层需要至少一个能力分组。')
    const groups = layer.groups.map(group => {
      const heading = readSourcedLabel(group, '能力分组', sources.length, invalid)
      const { components = [] } = group
      if (!Array.isArray(components)) throw invalid('components 须为组件数组。')
      const groupPath = sources[heading.source - 1].path
      const entries = components.map(component => {
        const entry = readSourcedLabel(component, '组件', sources.length, invalid)
        const showCitation = sources[entry.source - 1].path !== groupPath
        return { ...entry, showCitation }
      })
      return { ...heading, components: entries }
    })
    return { label, groups }
  })
  return { layers, indices }
}

function readRelations(input, indices, sourceCount, invalid) {
  const byGap = new Map()
  if (!Array.isArray(input)) throw invalid('relations 须为跨层关系数组。')
  for (const relation of input) {
    const { label, source } = readSourcedLabel(relation, '跨层关系', sourceCount, invalid)
    const from = indices.get(relation.from)
    const to = indices.get(relation.to)
    if (from === undefined || to === undefined || Math.abs(from - to) !== 1) {
      throw invalid('跨层关系的 from 和 to 须引用两个相邻层的 ID。')
    }
    const gap = Math.min(from, to)
    if (!byGap.has(gap)) byGap.set(gap, [])
    byGap.get(gap).push({ label, source, from, to })
  }
  return byGap
}

function measureText(label, availableWidth, size, lineHeight) {
  const lines = wrapText(label, availableWidth, size)
  return { lines, size, lineHeight, height: lines.length * lineHeight }
}

function measureLabel(item, availableWidth, size, lineHeight) {
  const citationWidth = textWidth('【' + item.source + '】', 11)
  return {
    ...measureText(item.label, availableWidth - citationWidth - 6, size, lineHeight),
    citationWidth, source: item.source,
  }
}

function paintLabel(label, x, y, availableWidth, weight, fill, sourceAt) {
  const text = svgText(label.lines, {
    x, y, fontSize: label.size, lineHeight: label.lineHeight, anchor: 'start', weight, fill,
  })
  if (label.source === undefined) return text
  return text + renderCitation(label.source, x + availableWidth - label.citationWidth / 2, y, sourceAt)
}

function measureGrid(items, availableWidth, minCellWidth, gap, measure) {
  if (!items.length) return { rows: [], height: 0 }
  const columns = Math.max(1, Math.floor((availableWidth + gap) / (minCellWidth + gap)))
  const rowLength = Math.ceil(items.length / Math.ceil(items.length / columns))
  const rows = []
  let height = 0
  for (let start = 0; start < items.length; start += rowLength) {
    const row = items.slice(start, start + rowLength)
    const cellWidth = Math.floor((availableWidth - (row.length - 1) * gap) / row.length)
    const cells = row.map((item, column) => ({
      ...measure(item, cellWidth), x: column * (cellWidth + gap), width: cellWidth,
    }))
    const rowHeight = Math.max(...cells.map(cell => cell.height))
    rows.push({ cells, y: height, height: rowHeight })
    height += rowHeight + gap
  }
  return { rows, height: height - gap }
}

function paintGrid(grid, x, y, paint) {
  return grid.rows.map(row => row.cells
    .map(cell => paint(cell, x + cell.x, y + row.y, row.height)).join('')).join('')
}

function box(x, y, w, h, fill, stroke, radius = 5) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`
}

function group(label, body) {
  return `<g role="group" aria-label="${escapeSvg(label)}">${body}</g>`
}

function measureTile(component, cellWidth) {
  const availableWidth = cellWidth - 2 * tilePadding
  const heading = component.showCitation
    ? measureLabel(component, availableWidth, 13, 16)
    : measureText(component.label, availableWidth, 13, 16)
  return { label: component.label, heading, height: heading.height + 2 * tilePadding }
}

function measureGroup(capability, cellWidth) {
  const availableWidth = cellWidth - 2 * groupPadding
  const heading = measureLabel(capability, availableWidth, 14, 17)
  const tiles = measureGrid(capability.components, availableWidth, 104, tileGap, measureTile)
  const height = heading.height + 2 * groupPadding + (tiles.height ? tileGap + tiles.height : 0)
  return { label: capability.label, heading, tiles, height: Math.max(40, height) }
}

function paintCapability(capability, x, y, height, colors, sourceAt) {
  const { heading, tiles, width: groupWidth } = capability
  const contentX = x + groupPadding
  const headingY = tiles.height ? y + groupPadding + heading.height / 2 : y + height / 2
  const title = paintLabel(heading, contentX, headingY, groupWidth - 2 * groupPadding, 670, colors.ink, sourceAt)
  const tilesBody = paintGrid(tiles, contentX, y + groupPadding + heading.height + tileGap, (tile, tx, ty, th) =>
    group(tile.label, box(tx, ty, tile.width, th, colors.tile, colors.border, 3)
      + paintLabel(tile.heading, tx + tilePadding, ty + th / 2, tile.width - 2 * tilePadding, 540, diagramColors.ink, sourceAt)))
  return group(capability.label, box(x, y, groupWidth, height, diagramColors.paper, colors.border) + title + tilesBody)
}

function paintLayer(layer, y, colors, sourceAt) {
  const x = canvasPadding
  const radius = 7
  const heading = measureText(layer.label, railWidth - 28, 16, 20)
  const groups = measureGrid(layer.groups, groupsWidth, 150, groupGap, measureGroup)
  const height = Math.max(heading.height, groups.height) + 2 * layerPadding
  const bottom = y + height
  const railEnd = x + railWidth
  const rail = `<path d="M${railEnd} ${y}H${x + radius}Q${x} ${y} ${x} ${y + radius}V${bottom - radius}Q${x} ${bottom} ${x + radius} ${bottom}H${railEnd}Z" fill="${colors.rail}"/>`
    + `<path d="M${railEnd} ${y}V${bottom}" stroke="${colors.border}"/>`
  const title = svgText(heading.lines, {
    x: x + 14, y: y + height / 2, fontSize: heading.size, lineHeight: heading.lineHeight,
    anchor: 'start', weight: 720, fill: colors.ink,
  })
  const capabilities = paintGrid(groups, groupsX, y + (height - groups.height) / 2, (item, gx, gy, gh) =>
    paintCapability(item, gx, gy, gh, colors, sourceAt))
  return {
    height,
    body: group(layer.label, box(x, y, layerWidth, height, colors.band, 'none', radius) + rail + title
      + capabilities + box(x, y, layerWidth, height, 'none', colors.border, radius)),
  }
}

function paintRelationGap(relations, layers, y, sourceAt) {
  const directions = [true, false].map(down => ({
    down, items: relations.filter(({ from, to }) => (from < to) === down),
  })).filter(({ items }) => items.length)
  const laneWidth = Math.floor(groupsWidth / directions.length)
  const lanes = directions.map(lane => {
    const labels = lane.items.map(item => measureLabel(item, laneWidth - 44, 12, 16))
    const height = labels.reduce((total, label) => total + label.height, 0) + 4 * (labels.length - 1)
    const labelWidth = Math.max(...labels.map(({ lines, citationWidth }) =>
      Math.max(...lines.map(line => textWidth(line, 12))) + citationWidth + 8))
    return { ...lane, labels, height, labelWidth }
  })
  const height = Math.max(...lanes.map(lane => lane.height)) + 14
  const body = lanes.map(({ down, items, labels, height: labelHeight, labelWidth }, index) => {
    const x = Math.round(groupsX + laneWidth * (index + 0.5) - (labelWidth + 14) / 2)
    const start = y + 2
    const end = y + height - 2
    const tip = down ? end : start
    const shoulder = tip + (down ? -5 : 5)
    const arrow = `<path d="M${x} ${start}V${end}M${x - 4} ${shoulder}l4 ${tip - shoulder} 4 ${shoulder - tip}" fill="none" stroke="${diagramColors.edge}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`
    let top = y + (height - labelHeight) / 2
    const legend = labels.map((label, position) => {
      const { from, to, label: description } = items[position]
      const location = layers[from].label + ' → ' + layers[to].label + '：' + description
      const text = paintLabel(label, x + 12, top + label.height / 2, labelWidth, 570, diagramColors.muted, sourceAt)
      top += label.height + 4
      return group(location, text)
    }).join('')
    return arrow + legend
  }).join('')
  return { body, height }
}

export function renderArchitectureDiagram(input, sources, repository, invalid) {
  const title = readText(input?.title, '逻辑架构图标题', invalid)
  const { layers, indices } = readLayers(input.layers, sources, invalid)
  const { relations: authoredRelations = [] } = input
  const byGap = readRelations(authoredRelations, indices, sources.length, invalid)
  const sourceAt = diagramSourceAt(sources, repository)
  let y = canvasPadding
  const parts = []
  for (const [index, layer] of layers.entries()) {
    const band = paintLayer(layer, y, layerColors[index % layerColors.length], sourceAt)
    parts.push(band.body)
    y += band.height
    const relations = byGap.get(index)
    if (relations) {
      const gap = paintRelationGap(relations, layers, y, sourceAt)
      parts.push(gap.body)
      y += gap.height
    } else if (index < layers.length - 1) {
      y += layerGap
    }
  }
  const height = y + canvasPadding
  const frame = box(4, 4, width - 8, height - 8, '#f8fafc', diagramColors.border, 11)
  try {
    return svgFigure({ kind: 'architecture', title }, width, height, frame + parts.join(''))
  } catch {
    throw invalid('无法绘制逻辑架构图。请保留主要系统层、能力分组和必要的跨层关系。')
  }
}
