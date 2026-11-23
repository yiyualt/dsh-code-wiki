import dagre from '@dagrejs/dagre'
import { diagramColors as colors, escapeSvg, renderCitation, svgFigure, svgText, textWidth, wrapText } from './diagram-svg.mjs'

const padding = 24
const headerFont = 14
const fieldFont = 12
const lineHeight = 16

function measureEntity(entity) {
  const keyWidth = entity.fields.some(field => field.key) ? 42 : 12
  const nameWidth = Math.ceil(Math.min(150, Math.max(77, ...entity.fields.map(field => textWidth(field.name, fieldFont)))))
  const typeWidth = Math.ceil(Math.min(135, Math.max(74, ...entity.fields.map(field => textWidth(field.type, fieldFont)))))
  const width = Math.max(204, keyWidth + nameWidth + typeWidth + 24)
  const title = wrapText(entity.label, width - 24, headerFont)
  const headerHeight = 20 + title.length * 19
  let height = headerHeight
  const fields = entity.fields.map(field => {
    const name = wrapText(field.name, nameWidth, fieldFont)
    const type = wrapText(field.type, typeWidth, fieldFont)
    const rowHeight = Math.max(name.length, type.length) * lineHeight + 10
    const row = { ...field, center: height + rowHeight / 2, top: height, name, type }
    height += rowHeight
    return row
  })
  return { ...entity, width, height, headerHeight, title, fields, keyWidth, nameWidth }
}

function measureRelation(relation) {
  const lines = wrapText(relation.label, 172, 12)
  const textWidthMax = Math.max(...lines.map(line => textWidth(line, 12)))
  return { ...relation, lines, width: Math.ceil(textWidthMax + 50), height: 16 * lines.length + 10 }
}

function selfRelationPoints(entity, edge, direction, index) {
  const [depth, span] = direction === 'LR' ? ['y', 'x'] : ['x', 'y']
  const [depthSize, spanSize] = direction === 'LR' ? ['height', 'width'] : ['width', 'height']
  const boundary = entity[depth] + entity[depthSize] / 2
  const farthest = Math.max(boundary + 53, edge[depth] + edge[depthSize] / 2 + 14)
  const center = entity[span]
  const inset = Math.min(entity[spanSize] / 2 - 5, 12 + index * 6)
  const reach = Math.max(inset + 10, edge[spanSize] / 2 + 10) + index * 5
  return [
    [boundary, center - inset],
    [boundary + 20, center - inset],
    [boundary + 28, center - reach],
    [farthest - 6, center - reach],
    [farthest, center - reach + 6],
    [farthest, center + reach - 6],
    [farthest - 6, center + reach],
    [boundary + 28, center + reach],
    [boundary + 20, center + inset],
    [boundary, center + inset],
  ].map(([outward, across]) => ({ [depth]: outward, [span]: across }))
}

function layout(entities, relations, direction) {
  const graph = new dagre.graphlib.Graph({ multigraph: true })
  graph.setGraph({ rankdir: direction, ranksep: direction === 'LR' ? 108 : 90, nodesep: 34, edgesep: 34, acyclicer: 'greedy' })
  const keys = new Map(entities.map((entity, index) => [entity.id, `table-${index}`]))
  for (const entity of entities) graph.setNode(keys.get(entity.id), { width: entity.width, height: entity.height })
  const edgeKeys = relations.map((relation, index) => ({ v: keys.get(relation.from), w: keys.get(relation.to), name: `relation-${index}` }))
  for (const [index, { width, height }] of relations.entries()) graph.setEdge(edgeKeys[index], { width, height, labelpos: 'c' })
  dagre.layout(graph)
  const positions = entities.map(entity => ({ ...entity, ...graph.node(keys.get(entity.id)) }))
  const selfIndexes = new Map()
  const connections = relations.map((relation, index) => {
    const edge = graph.edge(edgeKeys[index])
    let { points } = edge
    if (relation.from === relation.to) {
      const number = selfIndexes.get(relation.from) ?? 0
      selfIndexes.set(relation.from, number + 1)
      points = selfRelationPoints(graph.node(keys.get(relation.from)), edge, direction, number)
    }
    return {
      ...relation,
      ...edge,
      points,
      startBadge: measureCardinality(relation.fromCardinality, points, relation.from === relation.to ? 33 : 24),
      endBadge: measureCardinality(relation.toCardinality, points.toReversed(), relation.from === relation.to ? 33 : 24),
    }
  })
  // Include loop paths and the endpoint badges in the viewport.
  const boxes = [...positions, ...connections, ...connections.flatMap(({ startBadge, endBadge }) => [startBadge, endBadge])]
  const points = connections.flatMap(connection => connection.points)
  const left = Math.min(...boxes.map(box => box.x - box.width / 2), ...points.map(point => point.x))
  const top = Math.min(...boxes.map(box => box.y - box.height / 2), ...points.map(point => point.y))
  const right = Math.max(...boxes.map(box => box.x + box.width / 2), ...points.map(point => point.x))
  const bottom = Math.max(...boxes.map(box => box.y + box.height / 2), ...points.map(point => point.y))
  return { positions, connections, left, top, width: right - left, height: bottom - top }
}

function renderEntity({ id, fields, title, headerHeight, width, height, keyWidth, nameWidth, x, y }) {
  const left = x - width / 2
  const top = y - height / 2
  const shell = `<rect width="${width}" height="${height}" rx="7" fill="${fields.length ? colors.paper : colors.accentSurface}"/>`
  const header = fields.length ? `<path d="M7,0 H${width - 7} Q${width},0 ${width},7 V${headerHeight} H0 V7 Q0,0 7,0 Z" fill="${colors.accentSurface}"/>` : ''
  const heading = svgText(title, { x: 12, y: headerHeight / 2, fontSize: headerFont, lineHeight: 19, anchor: 'start', weight: 650, fill: colors.ink })
  const rows = fields.map(field => {
    const separator = `<path d="M0,${field.top} H${width}" stroke="${colors.line}"/>`
    const key = field.key ? `<rect x="9" y="${field.center - 8}" width="24" height="16" rx="4" fill="${colors.accentSurface}"/>${svgText([field.key], { x: 21, y: field.center, fontSize: 9, weight: 650, fill: colors.accent })}` : ''
    const name = svgText(field.name, { x: keyWidth, y: field.center, fontSize: fieldFont, lineHeight, anchor: 'start', fill: colors.ink })
    const type = svgText(field.type, { x: keyWidth + nameWidth + 12, y: field.center, fontSize: fieldFont, lineHeight, anchor: 'start', fill: colors.muted })
    return separator + key + name + type
  }).join('')
  const outline = `<rect width="${width}" height="${height}" rx="7" fill="none" stroke="${colors.border}"/>`
  return `<g data-entity-id="${escapeSvg(id)}" transform="translate(${left},${top})">${shell}${header}${heading}${rows}${outline}</g>`
}

function unitVector(start, end) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  return length ? { dx: dx / length, dy: dy / length, length } : { dx: 0, dy: 0, length }
}

function attachAt(points, distance) {
  let remaining = distance
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]
    const { dx, dy, length } = unitVector(start, points[index])
    if (!length) continue
    if (remaining <= length || index === points.length - 1) {
      const step = Math.min(remaining, length)
      return { x: start.x + dx * step, y: start.y + dy * step, dx, dy }
    }
    remaining -= length
  }
  return { ...points[0], dx: 1, dy: 0 }
}

function measureCardinality(cardinality, points, distance) {
  const { x, y, dx, dy } = attachAt(points, distance)
  // Keep endpoint labels beside the connector, with a consistent reading position.
  const width = textWidth(cardinality, 11) + 10
  const labelX = x + Math.abs(dy) * (width / 2 + 3)
  const labelY = y - Math.abs(dx) * 12
  return { cardinality, x: labelX, y: labelY, width, height: 16 }
}

function renderCardinality({ cardinality, x, y, width, height }, end) {
  return `<g data-relation-end="${end}"><rect x="${x - width / 2}" y="${y - height / 2}" width="${width}" height="${height}" rx="3" fill="${colors.paper}"/>${svgText([cardinality], { x, y, fontSize: 11, weight: 650, fill: colors.accent })}</g>`
}

function renderRelationLine({ points }, index) {
  const reversed = points.toReversed()
  const start = attachAt(reversed, 0)
  const back = { x: start.x + start.dx * 8, y: start.y + start.dy * 8 }
  const path = points.map(({ x, y }, index) => `${index ? 'L' : 'M'}${x},${y}`).join(' ')
  const tip = `${back.x + start.dy * 3.5},${back.y - start.dx * 3.5} ${start.x},${start.y} ${back.x - start.dy * 3.5},${back.y + start.dx * 3.5}`
  return `<g data-relation-line="${index}"><path d="${path}" fill="none" stroke="${colors.edge}" stroke-width="1.4" stroke-linejoin="round"/><polygon points="${tip}" fill="${colors.edge}"/></g>`
}

function renderRelationLabel({ from, to, x, y, width, height, lines, source, startBadge, endBadge }, index, sourceAt) {
  const left = x - width / 2
  const top = y - height / 2
  const label = `<rect width="${width}" height="${height}" rx="6" fill="${colors.paper}" stroke="${colors.border}"/>` +
    svgText(lines, { x: 9, y: height / 2, fontSize: 12, lineHeight, anchor: 'start', fill: colors.ink }) +
    renderCitation(source, width - 18, height / 2, sourceAt)
  return `<g data-relation-index="${index}" data-relation-from="${escapeSvg(from)}" data-relation-to="${escapeSvg(to)}">${renderCardinality(startBadge, 'from')}${renderCardinality(endBadge, 'to')}<g transform="translate(${left},${top})">${label}</g></g>`
}

export function renderEntityDiagram(diagram, sourceAt) {
  const entities = diagram.entities.map(measureEntity)
  const relations = diagram.relations.map(measureRelation)
  const horizontal = layout(entities, relations, 'LR')
  const vertical = layout(entities, relations, 'TB')
  const cost = ({ width, height }) => Math.max(width / 1.35, height)
  const { positions, connections, left, top, width, height } = cost(horizontal) <= cost(vertical) ? horizontal : vertical
  const lines = connections.map(renderRelationLine).join('')
  const tables = positions.map(renderEntity).join('')
  const labels = connections.map((relation, index) => renderRelationLabel(relation, index, sourceAt)).join('')
  return svgFigure(diagram, width + 2 * padding, height + 2 * padding, `<g transform="translate(${padding - left},${padding - top})">${lines}${tables}${labels}</g>`)
}
