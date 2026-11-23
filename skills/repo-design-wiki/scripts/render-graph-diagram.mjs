import dagre from '@dagrejs/dagre'
import { diagramColors as colors, escapeSvg, renderCitation, svgFigure, svgText, textWidth, wrapText } from './diagram-svg.mjs'

const padding = 16
const nodeFont = 13
const edgeFont = 12
const groupFont = 12
const nodeLine = 17
const labelLine = 16
const arrowId = 'wiki-graph-arrow'
const maxFigureSize = 4096

const rolesByKind = {
  context: {
    actor: ['参与者', 'actor'], system: ['目标系统', 'box', 'primary'], external: ['外部系统', 'box', 'external'],
  },
  component: {
    component: ['组件', 'component', 'primary'], interface: ['接口', 'pill'], external: ['外部依赖', 'box', 'external'],
  },
  dependency: {
    module: ['模块', 'box'], package: ['包', 'folder'], interface: ['接口', 'pill'], external: ['外部依赖', 'box', 'external'],
  },
  flow: {
    start: ['开始', 'pill', 'primary'], action: ['步骤', 'box'], decision: ['判断', 'diamond', 'primary'], end: ['结束', 'pill'],
  },
  data: {
    producer: ['数据来源', 'box', 'primary'], process: ['处理', 'box'], store: ['存储', 'store'], consumer: ['接收方', 'box'],
  },
  state: {
    start: ['初始', 'initial', 'primary'], state: ['状态', 'pill'], end: ['终止', 'final'],
  },
  deployment: {
    app: ['应用', 'component', 'primary'], process: ['进程', 'box'], store: ['存储', 'store'],
  },
}

function labelWidth(lines, fontSize) {
  return Math.ceil(Math.max(0, ...lines.map(line => textWidth(line, fontSize))))
}

function sizeNode(kind, node) {
  const [roleLabel, shape, tone] = rolesByKind[kind][node.role]
  const lines = wrapText(node.label, shape === 'diamond' ? 118 : 138, nodeFont)
  const contentWidth = labelWidth(lines, nodeFont)
  const labelHeight = lines.length * nodeLine
  let width = Math.max(112, contentWidth + 30)
  let height = labelHeight + 41
  if (shape === 'diamond') {
    height = (labelHeight + 24) * 1.65 + 18
    // Fit each line at its own vertical position in the tapered shape.
    width = Math.max(146, ...lines.map((line, index) => {
      const offset = 11 + (index - (lines.length - 1) / 2) * nodeLine
      const fraction = 1 - (Math.abs(offset) + nodeFont / 2) / (height / 2)
      return (textWidth(line, nodeFont) + 14) / fraction
    }))
  }
  if (shape === 'actor' || shape === 'initial' || shape === 'final') width += 20
  if (shape === 'store') height += 14
  return { roleLabel, shape, tone, lines, width: Math.ceil(width), height: Math.ceil(height) }
}

function sizeEdge(edge) {
  const lines = wrapText(edge.label, 125, edgeFont)
  return { lines, width: Math.max(72, labelWidth(lines, edgeFont) + 53), height: lines.length * labelLine + 10 }
}

function layoutGraph(diagram, nodeSizes, edgeSizes, direction) {
  const graph = new dagre.graphlib.Graph({ compound: true, multigraph: true })
  // Isolate model-assigned IDs from Graphlib's generated layout keys.
  const nodeKeys = new Map(diagram.nodes.map((node, index) => [node.id, `wiki-node-${index}`]))
  const groups = diagram.groups.map((group, index) => ({
    ...group, key: `wiki-group-${index}`, lines: wrapText(group.label, 130, groupFont),
  }))
  const headerSpace = Math.max(0, ...groups.map(group => group.lines.length * labelLine + 12))
  graph.setGraph({
    rankdir: direction, acyclicer: 'greedy', edgesep: 18,
    nodesep: direction === 'LR' ? Math.max(36, 2 * headerSpace) : 36,
    ranksep: direction === 'TB' ? Math.max(44, 2 * headerSpace) : 54,
  })
  diagram.nodes.forEach((node, index) => {
    const { width, height } = nodeSizes[index]
    graph.setNode(nodeKeys.get(node.id), { width, height })
  })
  for (const group of groups) {
    graph.setNode(group.key, {})
    for (const node of group.nodes) graph.setParent(nodeKeys.get(node), group.key)
  }
  const loopCounts = new Map()
  diagram.edges.forEach((edge, index) => {
    const { width, height } = edgeSizes[index]
    graph.setEdge(nodeKeys.get(edge.from), nodeKeys.get(edge.to), {
      width: width + 10, height: height + 8, labelpos: 'c',
    }, String(index))
    if (edge.from === edge.to) loopCounts.set(edge.from, (loopCounts.get(edge.from) ?? 0) + 1)
  })
  dagre.layout(graph)

  const nodes = diagram.nodes.map((node, index) => ({ ...node, ...nodeSizes[index], ...graph.node(nodeKeys.get(node.id)) }))
  const arrangedNodes = new Map(nodes.map(node => [node.id, node]))
  const loopIndexes = new Map()
  const edges = diagram.edges.map((edge, index) => {
    const from = arrangedNodes.get(edge.from)
    const to = arrangedNodes.get(edge.to)
    const route = graph.edge(nodeKeys.get(edge.from), nodeKeys.get(edge.to), String(index))
    const label = { x: route.x, y: route.y, ...edgeSizes[index] }
    let points = route.points
    if (edge.from === edge.to) {
      const loopIndex = (loopIndexes.get(edge.from) ?? 0) + 1
      loopIndexes.set(edge.from, loopIndex)
      points = loopPoints(from, label, direction, loopIndex / (loopCounts.get(edge.from) + 1))
    }
    points = [nodePort(from, points[1]), ...points.slice(1, -1), nodePort(to, points.at(-2))]
    return { ...edge, ...label, points, description: `${from.label} → ${to.label}` }
  })
  const arrangedGroups = groups.map(group => ({ ...group, ...graph.node(group.key) }))
  return { nodes, edges, groups: arrangedGroups, ...viewBounds(nodes, edges, arrangedGroups) }
}

function loopPoints(node, label, direction, fraction) {
  // Reserve separate routes around the label for repeated self-edges.
  const [out, across] = direction === 'LR' ? ['y', 'x'] : ['x', 'y']
  const [depth, span] = direction === 'LR' ? ['height', 'width'] : ['width', 'height']
  const boundary = node[out] + node[depth] / 2
  const farthest = Math.max(boundary + 22, label[out] + label[depth] / 2 + 8)
  const inset = node[span] * (0.08 + 0.4 * fraction)
  const reach = Math.max(label[span] / 2 + 7, inset + 8) + 16 * fraction
  const corner = Math.min(9, (farthest - boundary) / 3)
  const center = node[across]
  return [
    [boundary, center - inset], [boundary + corner, center - reach],
    [farthest - corner, center - reach], [farthest, center - reach + corner],
    [farthest, center + reach - corner], [farthest - corner, center + reach],
    [boundary + corner, center + reach], [boundary, center + inset],
  ].map(([distance, offset]) => ({ [out]: distance, [across]: offset }))
}

function nodePort(node, toward) {
  const dx = toward.x - node.x
  const dy = toward.y - node.y
  if (!dx && !dy) return { x: node.x, y: node.y + node.height / 2 }
  const halfWidth = node.width / 2
  const halfHeight = node.height / 2
  const horizontal = Math.abs(dx) / halfWidth
  const vertical = Math.abs(dy) / halfHeight
  if (node.shape === 'diamond') {
    return { x: node.x + dx / (horizontal + vertical), y: node.y + dy / (horizontal + vertical) }
  }
  const scale = Math.max(horizontal, vertical)
  const radius = cornerRadius(node)
  const cornerX = halfWidth - radius
  const cornerY = halfHeight - radius
  if (Math.abs(dx / scale) > cornerX && Math.abs(dy / scale) > cornerY) {
    const length = Math.hypot(dx, dy)
    const projection = (Math.abs(dx) * cornerX + Math.abs(dy) * cornerY) / length
    const perpendicular = cornerX ** 2 + cornerY ** 2 - projection ** 2
    const distance = projection + Math.sqrt(Math.max(0, radius ** 2 - perpendicular))
    return { x: node.x + dx * distance / length, y: node.y + dy * distance / length }
  }
  return { x: node.x + dx / scale, y: node.y + dy / scale }
}

function viewBounds(nodes, edges, groups) {
  const points = edges.flatMap(edge => edge.points)
  for (const { x, y, width, height } of [...nodes, ...edges, ...groups]) {
    points.push({ x: x - width / 2, y: y - height / 2 }, { x: x + width / 2, y: y + height / 2 })
  }
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  const left = Math.floor(Math.min(...xs)) - padding
  const top = Math.floor(Math.min(...ys)) - padding
  return {
    left, top,
    width: Math.ceil(Math.max(...xs)) - left + padding,
    height: Math.ceil(Math.max(...ys)) - top + padding,
  }
}

function groupShape(group, kind) {
  const x = group.x - group.width / 2
  const y = group.y - group.height / 2
  const dash = kind === 'component' ? ' stroke-dasharray="6 4"' : ''
  return `<rect x="${x}" y="${y}" width="${group.width}" height="${group.height}" rx="12" fill="${colors.accentSurface}" fill-opacity=".4" stroke="${colors.border}" stroke-width="1.4"${dash}/>`
}

function groupTitle(group) {
  const x = group.x - group.width / 2 + 10
  const y = group.y - group.height / 2 + 8
  const height = group.lines.length * labelLine + 2
  const width = labelWidth(group.lines, groupFont) + 12
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="4" fill="${colors.surface}"/>`
    + svgText(group.lines, { x: x + 6, y: y + height / 2, fontSize: groupFont, lineHeight: labelLine, fill: colors.ink, weight: 650, anchor: 'start' })
}

function cornerRadius(node) {
  if (node.shape === 'pill') return Math.min(22, node.height / 2)
  return 8
}

function nodeShape(node, stroke, fill) {
  const { x, y, width, height, shape, tone } = node
  const left = x - width / 2
  const top = y - height / 2
  const bottom = top + height
  const right = left + width
  const dash = tone === 'external' ? ' stroke-dasharray="5 3"' : ''
  const paint = `fill="${fill}" stroke="${stroke}" stroke-width="1.5"${dash}`
  if (shape === 'diamond') {
    return `<path d="M${x},${top} L${right},${y} L${x},${bottom} L${left},${y} Z" ${paint}/>`
  }
  if (shape === 'store') {
    return `<path d="M${left},${top + 8} Q${x},${top - 8} ${right},${top + 8} V${bottom - 8} Q${x},${bottom + 8} ${left},${bottom - 8} Z" ${paint}/>`
      + `<path d="M${left},${top + 8} Q${x},${top + 24} ${right},${top + 8}" fill="none" stroke="${stroke}" stroke-width="1.3"/>`
  }
  const radius = cornerRadius(node)
  let body = `<rect x="${left}" y="${top}" width="${width}" height="${height}" rx="${radius}" ${paint}/>`
  if (shape === 'folder') {
    body += `<path d="M${left + 1},${top + 13} H${x - 8} l6,-7 H${right - 10}" fill="none" stroke="${stroke}" stroke-width="1.3"/>`
  }
  if (shape === 'component') {
    body += `<path d="M${left + 6},${top + 10} h11 v14 h-11 Z M${left + 4},${top + 14} h5 m-5,6 h5" fill="none" stroke="${stroke}" stroke-width="1.25"/>`
  }
  if (shape === 'actor') {
    const iconX = left + 15
    body += `<circle cx="${iconX}" cy="${y - 4}" r="3.4" fill="none" stroke="${stroke}" stroke-width="1.4"/>`
      + `<path d="M${iconX - 6},${y + 6} Q${iconX},${y - 1} ${iconX + 6},${y + 6}" fill="none" stroke="${stroke}" stroke-width="1.4"/>`
  }
  if (shape === 'initial' || shape === 'final') {
    const iconX = left + 14
    body += `<circle cx="${iconX}" cy="${y}" r="3.4" fill="${colors.ink}"/>`
    if (shape === 'final') body += `<circle cx="${iconX}" cy="${y}" r="6" fill="none" stroke="${colors.ink}" stroke-width="1.3"/>`
  }
  return body
}

function renderNode(node) {
  const stroke = node.tone === 'primary' ? colors.accent : colors.border
  const fill = node.tone === 'primary' ? colors.accentSurface : colors.paper
  const x = node.x + (['actor', 'initial', 'final'].includes(node.shape) ? 8 : 0)
  const shift = node.shape === 'store' ? 6 : 0
  const y = node.y - (node.lines.length * nodeLine) / 2 + shift
  return `<g data-node-id="${escapeSvg(node.id)}">${nodeShape(node, stroke, fill)}`
    + svgText([node.roleLabel], { x, y: y - 3, fontSize: 10, fill: colors.muted, weight: 550 })
    + svgText(node.lines, { x, y: node.y + 11 + shift, fontSize: nodeFont, lineHeight: nodeLine, fill: colors.ink, weight: 650 })
    + '</g>'
}

function routeEdge({ points }) {
  const path = points.map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  return `<path d="${path}" fill="none" stroke="${colors.edge}" stroke-width="1.55" stroke-linejoin="round" marker-end="url(#${arrowId})"/>`
}

function edgeLabel(edge, sourceAt) {
  const { x, y, width, height } = edge
  return `<g><title>${escapeSvg(edge.description)} · ${escapeSvg(edge.label)}</title>`
    + `<rect x="${x - width / 2}" y="${y - height / 2}" width="${width}" height="${height}" rx="6" fill="${colors.paper}" stroke="${colors.line}"/>`
    + svgText(edge.lines, { x: x - 18, y, fontSize: edgeFont, lineHeight: labelLine, fill: colors.ink })
    + renderCitation(edge.source, x + width / 2 - 20, y, sourceAt)
    + '</g>'
}

export function renderGraphDiagram(diagram, sourceAt) {
  const nodeSizes = diagram.nodes.map(node => sizeNode(diagram.kind, node))
  const edgeSizes = diagram.edges.map(sizeEdge)
  const primary = diagram.kind === 'flow' ? 'TB' : 'LR'
  let layout = layoutGraph(diagram, nodeSizes, edgeSizes, primary)
  const largestSide = ({ width, height }) => Math.max(width, height)
  if (layout.width > 780 || layout.height > maxFigureSize) {
    const alternative = layoutGraph(diagram, nodeSizes, edgeSizes, primary === 'LR' ? 'TB' : 'LR')
    if ((largestSide(layout) > maxFigureSize && largestSide(alternative) < largestSide(layout))
      || (largestSide(alternative) <= maxFigureSize && alternative.width < layout.width)) layout = alternative
  }
  const { width, height, left, top, nodes, edges, groups } = layout
  const scale = Math.min(1, maxFigureSize / largestSide(layout))
  const transform = `scale(${scale}) translate(${-left},${-top})`
  const marker = `<defs><marker id="${arrowId}" markerWidth="8" markerHeight="8" refX="7.5" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8,4 L0,8 Z" fill="${colors.edge}"/></marker></defs>`
  const body = marker + `<g transform="${transform}">`
    + groups.map(group => groupShape(group, diagram.kind)).join('')
    + edges.map(routeEdge).join('')
    + nodes.map(renderNode).join('')
    + groups.map(groupTitle).join('')
    + edges.map(edge => edgeLabel(edge, sourceAt)).join('')
    + '</g>'
  return svgFigure(diagram, Math.min(maxFigureSize, Math.ceil(width * scale)), Math.min(maxFigureSize, Math.ceil(height * scale)), body)
}
