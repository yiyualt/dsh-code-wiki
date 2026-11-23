import dagre from '@dagrejs/dagre'

const diagramPadding = 10

function selfLoopPoints(node, label, size, direction, separation) {
  // Dagre places the loop label to the right in TB and below the node in LR.
  const vertical = direction === 'LR'
  const [outward, across] = vertical ? ['y', 'x'] : ['x', 'y']
  const [depth, span] = vertical ? ['height', 'width'] : ['width', 'height']
  const boundary = node[outward] + node[depth] / 2
  const farthest = label[outward] + size[depth] / 2 + 3
  const inset = node[span] / 2 * (0.4 + 0.5 * separation)
  const reach = Math.max(size[span] / 2 + 3, inset + 6)
  const corner = Math.min(9, (farthest - boundary) / 3)
  const center = node[across]
  return [
    [boundary, center - inset],
    [boundary + corner, center - reach],
    [farthest - corner, center - reach],
    [farthest, center - reach + corner],
    [farthest, center + reach - corner],
    [farthest - corner, center + reach],
    [boundary + corner, center + reach],
    [boundary, center + inset],
  ].map(([distance, offset]) => ({ [outward]: distance, [across]: offset }))
}

function fitDiagram(direction, nodes, edges) {
  // The final bounds include measured HTML labels and custom loop paths.
  const points = edges.flatMap(edge => edge.points)
  for (const { x, y, width, height } of [...nodes, ...edges]) {
    points.push({ x: x - width / 2, y: y - height / 2 }, { x: x + width / 2, y: y + height / 2 })
  }
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  const left = Math.min(...xs) - diagramPadding
  const top = Math.min(...ys) - diagramPadding
  const position = ({ x, y }) => ({ x: x - left, y: y - top })

  return {
    direction,
    width: Math.ceil(Math.max(...xs) - left + diagramPadding),
    height: Math.ceil(Math.max(...ys) - top + diagramPadding),
    nodes: nodes.map(position),
    edges: edges.map(edge => ({
      ...position(edge),
      path: edge.points.map(position).map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' '),
    })),
  }
}

function layoutInDirection(diagram, nodeSizes, edgeSizes, direction) {
  const graph = new dagre.graphlib.Graph({ multigraph: true })
  // Dagre uses object properties internally. Keep repository IDs in a Map.
  const nodeKeys = new Map(diagram.nodes.map((node, index) => [node.id, `wiki-node-${index}`]))
  const loopCounts = new Map()
  graph.setGraph({
    rankdir: direction,
    acyclicer: 'greedy',
    nodesep: 26,
    edgesep: 16,
    ranksep: direction === 'LR' ? 44 : 38,
  })

  // Dagre mutates dimensions to add the layout positions.
  diagram.nodes.forEach((node, index) => {
    graph.setNode(nodeKeys.get(node.id), { ...nodeSizes[index] })
  })
  diagram.edges.forEach((edge, index) => {
    const { width, height } = edgeSizes[index]
    graph.setEdge(nodeKeys.get(edge.from), nodeKeys.get(edge.to), { width: width + 8, height: height + 6, labelpos: 'c' }, String(index))
    if (edge.from === edge.to) loopCounts.set(edge.from, (loopCounts.get(edge.from) ?? 0) + 1)
  })
  dagre.layout(graph)

  const loopIndexes = new Map()
  const nodes = diagram.nodes.map(node => graph.node(nodeKeys.get(node.id)))
  const edges = diagram.edges.map((edge, index) => {
    const from = nodeKeys.get(edge.from)
    const label = graph.edge(from, nodeKeys.get(edge.to), String(index))
    const { x, y } = label
    let { points } = label
    if (edge.from === edge.to) {
      const loop = (loopIndexes.get(edge.from) ?? 0) + 1
      loopIndexes.set(edge.from, loop)
      points = selfLoopPoints(graph.node(from), label, edgeSizes[index], direction, loop / (loopCounts.get(edge.from) + 1))
    }
    return { x, y, points, ...edgeSizes[index] }
  })
  return fitDiagram(direction, nodes, edges)
}

export function layoutDiagram(diagram, nodeSizes, edgeSizes, availableWidth) {
  const primary = availableWidth >= 520 ? 'LR' : 'TB'
  const preferred = layoutInDirection(diagram, nodeSizes, edgeSizes, primary)
  if (preferred.width <= availableWidth) return preferred

  // Choose the more compact direction when the preferred layout would scroll.
  const alternative = layoutInDirection(diagram, nodeSizes, edgeSizes, primary === 'LR' ? 'TB' : 'LR')
  return alternative.width < preferred.width ? alternative : preferred
}
