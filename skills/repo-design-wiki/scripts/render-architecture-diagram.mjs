import {
  diagramColors as colors, diagramSourceAt, escapeSvg, renderCitation, svgFigure, svgText, wrapText,
} from './diagram-svg.mjs'
import { singleLine } from './wiki-generation.mjs'

const canvasPadding = 16
const areaPadding = 16
const areaGap = 12
const cardPadding = 12
const cardGap = 10
const preferredCardWidth = 224
const headingLine = 20
const labelLine = 18
const dutyLine = 16
const citationWidth = 40

function readText(value, name, invalid) {
  const text = singleLine(value)
  if (!text.isWellFormed() || !/[\p{L}\p{N}]/u.test(text)) throw invalid(name + '须为有效的单行文字。')
  return text
}

function readAreas(areas, sourceCount, invalid) {
  if (!Array.isArray(areas) || !areas.length) throw invalid('逻辑架构图至少需要一个职责区域。')
  return areas.map(area => {
    const label = readText(area?.label, '职责区域名称', invalid)
    if (!Array.isArray(area.components) || !area.components.length) {
      throw invalid('每个职责区域至少需要一个组件。')
    }
    const components = area.components.map(component => {
      const { source } = component ?? {}
      if (!Number.isSafeInteger(source) || source < 1 || source > sourceCount) {
        throw invalid('每个架构组件须用 source 引用 overview.sources 中的源码序号。')
      }
      return {
        source,
        label: readText(component.label, '组件名称', invalid),
        responsibility: readText(component.responsibility, '组件职责', invalid),
      }
    })
    return { label, components }
  })
}

function sizeCard(component, width) {
  const textWidth = width - 2 * cardPadding
  const labelLines = wrapText(component.label, textWidth - citationWidth, 14)
  const duty = wrapText(component.responsibility, textWidth, 13)
  return { label: component.label, source: component.source, labelLines, duty,
    height: 2 * cardPadding + labelLines.length * labelLine + 4 + duty.length * dutyLine }
}

function renderCard(card, x, y, width, height, sourceAt) {
  const textX = x + cardPadding
  const labelTop = y + cardPadding
  const dutyTop = labelTop + card.labelLines.length * labelLine + 4
  const label = svgText(card.labelLines, {
    x: textX, y: labelTop + card.labelLines.length * labelLine / 2, fontSize: 14, lineHeight: labelLine,
    anchor: 'start', weight: 650,
  })
  const duty = svgText(card.duty, {
    x: textX, y: dutyTop + card.duty.length * dutyLine / 2, fontSize: 13, lineHeight: dutyLine,
    anchor: 'start', fill: colors.muted,
  })
  return `<g role="group" aria-label="${escapeSvg(card.label)}">`
    + `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="7" fill="${colors.paper}" stroke="${colors.border}"/>`
    + label + duty + renderCitation(card.source, x + width - cardPadding - citationWidth / 2, labelTop + labelLine / 2, sourceAt)
    + '</g>'
}

function renderArea(area, y, width, columns, sourceAt) {
  const contentWidth = width - 2 * areaPadding
  const areaColumns = Math.min(columns, area.components.length)
  const cardWidth = Math.floor((contentWidth - cardGap * (areaColumns - 1)) / areaColumns)
  const heading = wrapText(area.label, contentWidth, 15)
  const headingHeight = heading.length * headingLine
  const x = canvasPadding + areaPadding
  let cardTop = y + areaPadding + headingHeight + 8
  const cards = []
  for (let start = 0; start < area.components.length; start += areaColumns) {
    const row = area.components.slice(start, start + areaColumns).map(component => sizeCard(component, cardWidth))
    const height = Math.max(...row.map(card => card.height))
    row.forEach((card, column) => cards.push(renderCard(card, x + column * (cardWidth + cardGap), cardTop, cardWidth, height, sourceAt)))
    cardTop += height + cardGap
  }
  const height = cardTop - cardGap - y + areaPadding
  const body = `<g role="group" aria-label="${escapeSvg(area.label)}">`
    + `<rect x="${canvasPadding}" y="${y}" width="${width}" height="${height}" rx="11" fill="${colors.accentSurface}" stroke="${colors.border}"/>`
    + svgText(heading, { x, y: y + areaPadding + headingHeight / 2, fontSize: 15, lineHeight: headingLine, anchor: 'start', weight: 700 })
    + cards.join('') + '</g>'
  return { body, height }
}

export function renderArchitectureDiagram(input, sources, repository, invalid) {
  const title = readText(input?.title, '逻辑架构图标题', invalid)
  const areas = readAreas(input.areas, sources.length, invalid)
  const columns = areas.reduce((count, { components }) => Math.min(3, Math.max(count, components.length)), 1)
  const areaWidth = 2 * areaPadding + columns * preferredCardWidth + (columns - 1) * cardGap
  const sourceAt = diagramSourceAt(sources, repository)
  let areaTop = canvasPadding
  const regions = []
  for (const area of areas) {
    const { body, height } = renderArea(area, areaTop, areaWidth, columns, sourceAt)
    regions.push(body)
    areaTop += height + areaGap
  }
  try {
    return svgFigure({ kind: 'architecture', title }, areaWidth + 2 * canvasPadding,
      areaTop - areaGap + canvasPadding, regions.join(''))
  } catch {
    throw invalid('无法绘制逻辑架构图。请缩短标签和职责描述，保留核心职责区域与组件。')
  }
}
