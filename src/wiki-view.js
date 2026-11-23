const wikiViews = (() => {
  const names = {
    flow: '流程图', sequence: '时序图', dataflow: '数据流图', dependency: '依赖图', scenario: '用例图', deployment: '部署图',
    component: '组件图', activity: '活动图', state: '状态图', entity: '实体关系图', class: '类图',
  }
  const overlap = (a, b, gap = 0) => a.x < b.x + b.w + gap && a.x + a.w + gap > b.x
    && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y
  const center = node => [node.x + node.w / 2, node.y + node.h / 2]

  const textWidth = (value, size) => Array.from(value).reduce((sum, char) => sum + (/[\u2e80-\uffff]/.test(char) ? size : size * .62), 0)

  function lines(value, width, size = 14) {
    const rows = ['']
    let used = 0
    const next = () => { rows[rows.length - 1] = rows.at(-1).trimEnd(); rows.push(''); used = 0 }
    const tokens = String(value).match(/[A-Za-z0-9_$]+(?:[./:-][A-Za-z0-9_$]+)*|\s+|[^\s]/gu) ?? []
    for (const token of tokens) {
      if (/^\s+$/.test(token)) {
        if (used && used + textWidth(' ', size) <= width) { rows[rows.length - 1] += ' '; used += textWidth(' ', size) }
        continue
      }
      const length = textWidth(token, size)
      if (length <= width) {
        if (used && used + length > width) next()
        rows[rows.length - 1] += token
        used += length
      } else for (const char of Array.from(token)) {
        const advance = textWidth(char, size)
        if (used && used + advance > width) next()
        rows[rows.length - 1] += char
        used += advance
      }
    }
    return rows.map(row => row.trimEnd())
  }

  function dimensions(node, kind) {
    const actor = node.role === 'actor' && kind !== 'sequence'
    const circle = kind === 'dataflow' && ['component', 'process'].includes(node.role)
    const compact = ['decision', 'start', 'end'].includes(node.role)
    const record = ['class', 'entity'].includes(kind) || kind === 'component' && node.members?.length
    const memberRows = record && node.members?.length ? node.members.flatMap(member => lines(member, 190, 12)) : []
    let w = 164
    if (kind === 'sequence') w = 140
    else if (actor) w = 126
    else if (kind === 'scenario') w = 252
    else if (record || node.detail && !compact && !circle) w = 218
    else if (kind === 'deployment' || compact) w = 178
    else if (circle) w = 132
    const labelRows = lines(node.label, w - (node.role === 'decision' ? 76 : 26))
    const detailRows = node.detail && !actor && !compact ? lines(node.detail, w - (circle ? 48 : 28), 12) : []
    const bodyHeight = labelRows.length * 18 + detailRows.length * 16 + (detailRows.length ? 7 : 0)
    const h = actor ? 80 + labelRows.length * 18 : Math.max(kind === 'sequence' ? 60 : 64,
      bodyHeight + 28 + (memberRows.length ? 14 + 16 * memberRows.length : 0), circle ? w : 0,
      node.role === 'decision' ? labelRows.length * 22 + 36 : 0)
    return { ...node, w, h, labelRows, detailRows, memberRows, bodyHeight }
  }

  function ranks(view) {
    const result = new Map()
    const incoming = new Set(view.edges.filter(edge => edge.from !== edge.to).map(edge => edge.to))
    const visit = seed => {
      if (result.has(seed)) return
      result.set(seed, 0)
      const queue = [seed]
      for (let i = 0; i < queue.length; i++) for (const edge of view.edges) {
        if (edge.from !== queue[i] || result.has(edge.to)) continue
        result.set(edge.to, result.get(edge.from) + 1)
        queue.push(edge.to)
      }
    }
    view.nodes.filter(node => !incoming.has(node.id)).forEach(node => visit(node.id))
    view.nodes.forEach(node => visit(node.id))
    return result
  }

  function positions(view, spacing = 1) {
    const nodes = view.nodes.map(node => dimensions(node, view.kind))
    if (view.kind === 'sequence') {
      const height = Math.max(...nodes.map(node => node.h))
      const contentWidth = nodes.length * 154 + 28
      const width = Math.max(440, contentWidth)
      return { width, height: 25 + height + 50,
        nodes: nodes.map((node, i) => ({ ...node, x: (width - contentWidth) / 2 + 20 + i * 154, y: 25, h: height })) }
    }
    if (view.kind === 'scenario') {
      const actors = nodes.filter(node => node.role === 'actor'), subjects = nodes.filter(node => node.role !== 'actor')
      const total = group => group.reduce((sum, node) => sum + node.h, 0) + Math.max(0, group.length - 1) * 56 * spacing
      const height = Math.max(320, Math.max(total(actors), total(subjects)) + 60)
      const column = (group, x) => {
        let y = (height - total(group)) / 2
        return group.map(node => { const item = { ...node, x, y }; y += node.h + 56 * spacing; return item })
      }
      return { width: 760 * spacing, height, nodes: [...column(actors, 52), ...column(subjects, 360 * spacing)] }
    }
    if (view.kind === 'deployment') {
      const columns = nodes.length > 4 ? 3 : 2, pitch = 244 * spacing
      let top = 40
      const placed = []
      for (let i = 0; i < nodes.length; i += columns) {
        const row = nodes.slice(i, i + columns), height = Math.max(...row.map(node => node.h))
        row.forEach((node, j) => placed.push({ ...node, x: 50 + j * pitch, y: top + (height - node.h) / 2 }))
        top += height + 88 * spacing
      }
      return { width: columns * pitch + 100, height: top, nodes: placed }
    }
    const levels = ranks(view), groups = []
    for (const node of nodes) (groups[levels.get(node.id)] ??= []).push(node)
    const horizontal = view.direction === 'LR' || (view.direction === undefined && isHorizontal(view.kind) && groups.length <= 3)
    const breadth = Math.max(...groups.map(group => group.length))
    const pitch = (horizontal ? Math.max(118, ...nodes.map(node => node.h + 38)) : Math.max(195, ...nodes.map(node => node.w + 32))) * spacing
    const width = horizontal ? groups.reduce((sum, group) => sum + Math.max(...group.map(node => node.w)), 62)
      + Math.max(0, groups.length - 1) * 72 * spacing : Math.max(400, breadth * pitch + 48)
    const height = horizontal ? Math.max(220, breadth * pitch + 42)
      : groups.reduce((sum, group) => sum + Math.max(...group.map(node => node.h)), 56)
        + Math.max(0, groups.length - 1) * 82 * spacing
    let depthStart = horizontal ? 31 : 28
    const placed = groups.flatMap(group => {
      const depthSize = Math.max(...group.map(node => horizontal ? node.w : node.h))
      const result = group.map((node, i) => ({ ...node,
        x: horizontal ? depthStart + (depthSize - node.w) / 2 : (width - group.length * pitch) / 2 + i * pitch + (pitch - node.w) / 2,
        y: horizontal ? (height - group.length * pitch) / 2 + i * pitch + (pitch - node.h) / 2 : depthStart + (depthSize - node.h) / 2,
      }))
      depthStart += depthSize + (horizontal ? 72 : 82) * spacing
      return result
    })
    return { width, height, nodes: placed }
  }

  function isHorizontal(kind) { return ['dependency', 'scenario', 'component', 'entity', 'class'].includes(kind) }

  function route(start, end, nodes, source, destination, horizontal) {
    const axis = horizontal ? 0 : 1, sign = Math.sign(end[axis] - start[axis])
    const boxes = nodes.map(node => {
      const padding = node === source || node === destination ? 0 : 9
      return { x: node.x - padding, y: node.y - padding, w: node.w + 2 * padding, h: node.h + 2 * padding }
    })
    const blocked = (a, b) => boxes.some(box => a[0] === b[0]
      ? a[0] > box.x && a[0] < box.x + box.w && Math.max(a[1], b[1]) > box.y && Math.min(a[1], b[1]) < box.y + box.h
      : a[1] > box.y && a[1] < box.y + box.h && Math.max(a[0], b[0]) > box.x && Math.min(a[0], b[0]) < box.x + box.w)
    const middle = (start[axis] + end[axis]) / 2
    const preferred = horizontal ? [start, [middle, start[1]], [middle, end[1]], end]
      : [start, [start[0], middle], [end[0], middle], end]
    if (preferred.slice(1).every((point, i) => !blocked(preferred[i], point))) return preferred
    const xs = [...new Set([start[0], end[0], ...boxes.flatMap(box => [box.x, box.x + box.w])])].sort((a, b) => a - b)
    const ys = [...new Set([start[1], end[1], ...boxes.flatMap(box => [box.y, box.y + box.h])])].sort((a, b) => a - b)
    const points = xs.flatMap(x => ys.map(y => [x, y]))
    const first = xs.indexOf(start[0]) * ys.length + ys.indexOf(start[1])
    const last = xs.indexOf(end[0]) * ys.length + ys.indexOf(end[1])
    const costs = Array(points.length * 2).fill(Infinity), previous = Array(costs.length).fill(-1), visited = new Set()
    costs[first * 2 + axis] = 0
    for (;;) {
      let current = -1
      for (let i = 0; i < costs.length; i++) if (!visited.has(i) && costs[i] < (current < 0 ? Infinity : costs[current])) current = i
      if (current < 0) return preferred
      const index = Math.floor(current / 2)
      if (index === last) {
        const path = []
        for (let state = current; state >= 0; state = previous[state]) path.push(points[Math.floor(state / 2)])
        path.reverse()
        return path.filter((point, i) => !i || i === path.length - 1
          || ![0, 1].some(axis => path[i - 1][axis] === point[axis] && point[axis] === path[i + 1][axis]))
      }
      visited.add(current)
      const x = Math.floor(index / ys.length), y = index % ys.length
      const adjacent = [x > 0 ? index - ys.length : -1, x + 1 < xs.length ? index + ys.length : -1,
        y > 0 ? index - 1 : -1, y + 1 < ys.length ? index + 1 : -1]
      for (const [direction, next] of adjacent.entries()) {
        if (next < 0 || next === first) continue
        const nextAxis = direction < 2 ? 0 : 1
        if ((index === first || next === last) && (nextAxis !== axis || Math.sign(points[next][axis] - points[index][axis]) !== sign)) continue
        if (blocked(points[index], points[next])) continue
        const state = next * 2 + nextAxis
        const cost = costs[current] + Math.abs(points[next][0] - points[index][0]) + Math.abs(points[next][1] - points[index][1])
          + (nextAxis === current % 2 ? 0 : 16)
        if (cost < costs[state]) { costs[state] = cost; previous[state] = current }
      }
    }
  }

  function labelOnPath(points, label, bounds, occupied) {
    const rows = lines(label, 172, 12)
    const w = Math.max(...rows.map(row => textWidth(row, 12))) + 12
    const h = rows.length * 16 + 6
    const segments = points.slice(1).map((point, i) => ({ a: points[i], b: point,
      length: Math.abs(point[0] - points[i][0]) + Math.abs(point[1] - points[i][1]) })).sort((a, b) => b.length - a.length)
    for (const { a, b } of segments) for (const ratio of [.5, .35, .65]) {
      const x = a[0] + (b[0] - a[0]) * ratio, y = a[1] + (b[1] - a[1]) * ratio
      const options = a[1] === b[1] ? [{ x: x - w / 2, y: y - h - 6, w, h }, { x: x - w / 2, y: y + 6, w, h }]
        : [{ x: x + 8, y: y - h / 2, w, h }, { x: x - w - 8, y: y - h / 2, w, h }]
      for (const box of options) if (box.x >= 4 && box.y >= 4 && box.x + w <= bounds.width - 4 && box.y + h <= bounds.height - 4
        && !occupied.some(other => overlap(box, other, 5))) {
        occupied.push(box)
        return { ...box, rows }
      }
    }
    return null
  }

  function layoutAtSpacing(view, spacing) {
    const result = positions(view, spacing), byId = new Map(result.nodes.map(node => [node.id, node]))
    const occupied = [...result.nodes]
    let messageTop = result.height - 16
    const edges = view.edges.map((edge, i) => {
      const from = byId.get(edge.from), to = byId.get(edge.to)
      let points
      if (view.kind === 'sequence') {
        const x = center(from)[0], target = center(to)[0]
        const message = view.numbered === false ? edge.label : (i + 1) + '. ' + edge.label
        const messageRows = lines(message, Math.max(120, Math.abs(x - target) - 20), 13)
        const messageY = messageTop, y = messageY + (messageRows.length - 1) * 17 + 22
        messageTop = y + (from === to ? 58 : 38)
        points = from === to ? [[x, y], [x + 48, y], [x + 48, y + 24], [x, y + 24]] : [[x, y], [target, y]]
        return { ...edge, id: 'edge-' + i, points, labelBox: null, messageRows, messageY }
      } else if (from === to) {
        const x = from.x + from.w + 3, y = from.y + from.h / 2
        points = [[x, y - 16], [x + 28, y - 16], [x + 28, y + 16], [x, y + 16]]
      } else {
        const [ax, ay] = center(from), [bx, by] = center(to)
        const horizontal = Math.abs(bx - ax) > (from.w + to.w) / 2 + 12
          && (view.direction === 'LR' || isHorizontal(view.kind) || Math.abs(bx - ax) > Math.abs(by - ay) * 1.3)
        const sign = Math.sign(horizontal ? bx - ax : by - ay)
        const outgoing = view.edges.filter(item => item.from === edge.from)
        const incoming = view.edges.filter(item => item.to === edge.to)
        const offset = (items, size) => (items.indexOf(edge) - (items.length - 1) / 2) * Math.min(14, (size - 28) / Math.max(1, items.length - 1))
        const start = horizontal ? [ax + sign * (from.w / 2 + 2), ay + offset(outgoing, from.h)]
          : [ax + offset(outgoing, from.w), ay + sign * (from.h / 2 + 2)]
        const end = horizontal ? [bx - sign * (to.w / 2 + 4), by + offset(incoming, to.h)]
          : [bx + offset(incoming, to.w), by - sign * (to.h / 2 + 4)]
        points = route(start, end, result.nodes, from, to, horizontal)
      }
      const labelBox = edge.label ? labelOnPath(points, edge.label, result, occupied) : null
      return { ...edge, id: 'edge-' + i, points, labelBox }
    })
    return { ...result, height: view.kind === 'sequence' ? messageTop + 12 : result.height, edges }
  }

  function layout(view) {
    let result = layoutAtSpacing(view, 1)
    if (view.kind === 'sequence') return result
    for (const spacing of [1.3, 1.65]) {
      if (result.edges.every(edge => !edge.label || edge.labelBox)) break
      const candidate = layoutAtSpacing(view, spacing)
      if (candidate.edges.filter(edge => edge.labelBox).length > result.edges.filter(edge => edge.labelBox).length) result = candidate
    }
    const occupied = [...result.nodes, ...result.edges.flatMap(edge => edge.labelBox ? [edge.labelBox] : [])]
    result.edges.forEach((edge, i) => {
      if (!edge.label || edge.labelBox) return
      edge.number = i + 1
      edge.numberBox = labelOnPath(edge.points, String(edge.number), result, occupied)
      if (!edge.numberBox) {
        const segments = edge.points.slice(1).map((point, j) => ({ a: edge.points[j], b: point, length: Math.abs(point[0] - edge.points[j][0]) + Math.abs(point[1] - edge.points[j][1]) })).sort((a, b) => b.length - a.length)
        const { a, b } = segments[0]
        edge.numberBox = { x: (a[0] + b[0]) / 2 - 10, y: (a[1] + b[1]) / 2 - 10, w: 20, h: 20, rows: [String(edge.number)] }
      }
    })
    return result
  }

  function createRenderer(React) {
    const h = React.createElement
    function textRows(rows, x, y, size = 14, className, anchor = 'middle') {
      return h('text', { x, y, textAnchor: anchor, className, fontSize: size },
        rows.map((row, i) => h('tspan', { key: i, x, dy: i ? size + 4 : 0 }, row)))
    }
    function shape(node, kind) {
      const { x, y, w, h: height } = node
      if (node.role === 'actor' && kind !== 'sequence') return h('g', { className: 'dsh-wiki-view-actor' },
        h('circle', { cx: x + w / 2, cy: y + 13, r: 10 }),
        h('path', { d: `M${x + w / 2} ${y + 23}v30m-22-18h44m-22 18-19 24m19-24 19 24` }))
      if (node.role === 'decision') return h('polygon', {
        points: `${x + w / 2},${y} ${x + w},${y + height / 2} ${x + w / 2},${y + height} ${x},${y + height / 2}`,
      })
      if (['start', 'end'].includes(node.role)) return h('g', null,
        h('rect', { x, y, width: w, height, rx: Math.min(27, height / 2) }),
        h('circle', { cx: x + 19, cy: y + height / 2, r: 5, className: 'dsh-wiki-view-terminal-dot' }),
        node.role === 'end' && h('circle', { cx: x + 19, cy: y + height / 2, r: 8, className: 'dsh-wiki-view-terminal-ring' }))
      if (node.role === 'store' && !['entity', 'class', 'sequence'].includes(kind)) return h('g', null,
        h('path', { d: `M${x} ${y + 12}v${height - 24}a${w / 2} 12 0 0 0 ${w} 0V${y + 12}` }),
        h('ellipse', { cx: x + w / 2, cy: y + 12, rx: w / 2, ry: 12 }))
      if (kind === 'scenario' && node.role === 'process' || kind === 'dataflow' && ['component', 'process'].includes(node.role)) {
        return h('ellipse', { cx: x + w / 2, cy: y + height / 2, rx: w / 2, ry: height / 2 })
      }
      if (node.role === 'data' && !['class', 'entity', 'sequence'].includes(kind)) return h('polygon', { points: `${x + 14},${y} ${x + w},${y} ${x + w - 14},${y + height} ${x},${y + height}` })
      if (kind === 'deployment') return h('g', null,
        h('path', { d: `M${x} ${y + 10}l12-10h${w - 12}v${height - 10}l-12 10H${x}zM${x} ${y + 10}h${w - 12}l12-10M${x + w - 12} ${y + 10}v${height - 10}` }))
      return h('g', null,
        h('rect', { x, y, width: w, height, rx: ['activity', 'flow', 'state'].includes(kind) ? 14 : 7 }),
        kind === 'component' && h('path', { className: 'dsh-wiki-view-node-icon',
          d: `M${x + w - 21} ${y + 10}h12v13h-12v-3m0-6v-4m-3 4h7v3h-7zm0 5h7v3h-7z` }))
    }

    function nodeText(node, kind) {
      const { x, y, w, h: height, labelRows, detailRows, memberRows, bodyHeight } = node
      const partition = memberRows.length ? 14 + 16 * memberRows.length : 0
      const top = (height - bodyHeight - partition) / 2
      const actor = node.role === 'actor' && kind !== 'sequence'
      const terminal = ['start', 'end'].includes(node.role)
      const labelX = x + w / 2 + (terminal ? 7 : 0)
      const labelY = actor ? y + 93 : y + top + 14
      const dividerY = y + top + bodyHeight + 8
      return h('g', null,
        textRows(labelRows, labelX, labelY, 14, 'dsh-wiki-view-node-label'),
        detailRows.length ? textRows(detailRows, x + w / 2, y + top + labelRows.length * 18 + 15, 12, 'dsh-wiki-view-node-detail') : null,
        partition ? h('g', null,
          h('line', { x1: x, x2: x + w, y1: dividerY, y2: dividerY, className: 'dsh-wiki-view-node-divider' }),
          textRows(memberRows, x + 14, dividerY + 17, 12, 'dsh-wiki-view-node-member', 'start')) : null)
    }

    function arrowheads(prefix) {
      const marker = (kind, path, filled, start = false) => h('marker', { key: kind, id: prefix + '-' + kind,
        markerWidth: 13, markerHeight: 12, refX: start ? 0 : 12, refY: 6, orient: 'auto', markerUnits: 'userSpaceOnUse' },
      h('path', { d: path, className: filled ? 'dsh-wiki-view-arrowhead' : 'dsh-wiki-view-open-arrowhead' }))
      return h('defs', null, marker('arrow', 'M2 1L12 6L2 11Z', true), marker('open', 'M2 1L12 6L2 11'),
        marker('triangle', 'M1 1L12 6L1 11Z'), marker('diamond', 'M0 6L6 1L12 6L6 11Z', true, true))
    }

    function relationArrows(prefix, relation) {
      if (relation === 'composition') return { markerStart: `url(#${prefix}-diamond)` }
      if (relation === 'association') return {}
      const head = relation === 'inheritance' ? 'triangle' : ['return', 'async', 'async-dashed'].includes(relation) ? 'open' : 'arrow'
      return { markerEnd: `url(#${prefix}-${head})` }
    }

    function interfaceContracts(edges, byId) {
      const contracts = edges.filter(edge => edge.contract)
      if (!contracts.length) return null
      return h('div', { className: 'dsh-code-wiki-view-contracts' },
        h('ul', { 'aria-label': '图中接口', className: 'dsh-code-wiki-view-contract-list' },
          contracts.map(edge => h('li', { key: edge.id },
            h('p', { className: 'dsh-code-wiki-view-contract-route' },
              byId.get(edge.from).label + ' → ' + byId.get(edge.to).label),
            h('a', { href: edge.refs[0].href, target: '_blank', rel: 'noreferrer',
              className: 'dsh-code-wiki-view-contract-entry' }, h('code', null, edge.contract.entry)),
            h('dl', null, h('dt', null, '输入'), h('dd', null, edge.contract.input),
              h('dt', null, '输出'), h('dd', null, edge.contract.output))))))
    }

    function sourceAttributes(href, label) {
      return href ? { href, target: '_blank', rel: 'noreferrer', 'aria-label': label + '，查看源码' } : {}
    }

    return function WikiView({ view }) {
      const prefix = 'wiki-view-' + React.useId().replace(/[^a-z\d_-]/gi, '')
      const viewport = React.useRef(null)
      const [fit, setFit] = React.useState(true)
      const [overflow, setOverflow] = React.useState(false)
      const geometry = layout(view)
      const readableWidth = Math.ceil(geometry.width * .9)
      React.useLayoutEffect(() => {
        const element = viewport.current
        if (!element) return
        function updateSize() {
          setOverflow(element.clientWidth + 1 < readableWidth)
          if (!fit && ['flow', 'dataflow', 'activity', 'state'].includes(view.kind)) {
            element.scrollLeft = Math.max(0, (element.scrollWidth - element.clientWidth) / 2)
          }
        }
        updateSize()
        if (typeof ResizeObserver !== 'function') return
        const observer = new ResizeObserver(updateSize)
        observer.observe(element)
        return () => observer.disconnect()
      }, [view.kind, readableWidth, fit])
      const title = view.title ?? names[view.kind]
      const byId = new Map(view.nodes.map(node => [node.id, node]))
      const edgeLabel = edge => byId.get(edge.from).label + ' → ' + byId.get(edge.to).label + (edge.label ? '：' + edge.label : '')
      const references = [...view.nodes.map(node => ({ label: node.label, detail: node.detail,
        members: node.members, refs: node.refs })),
        ...view.edges.map(edge => ({ label: edgeLabel(edge), refs: edge.refs }))].filter(item => item.refs?.length)
      return h('figure', { className: 'dsh-code-wiki-view', 'data-kind': view.kind, 'aria-label': title },
        h('figcaption', { className: 'dsh-code-wiki-view-header' },
          h('strong', { className: 'dsh-code-wiki-view-type' }, names[view.kind]),
          overflow && h('button', { type: 'button', 'aria-pressed': fit, 'aria-controls': prefix + '-viewport',
            onClick: () => setFit(previous => !previous) }, '适应宽度')),
        h('div', { id: prefix + '-viewport', className: 'dsh-code-wiki-view-scroll', ref: viewport,
          tabIndex: overflow && !fit ? 0 : undefined, role: 'region', 'aria-label': title + '图示' },
          h('svg', { className: 'dsh-code-wiki-view-svg', width: geometry.width, height: geometry.height,
            viewBox: `0 0 ${geometry.width} ${geometry.height}`, role: 'img', 'aria-labelledby': prefix + '-title',
            'aria-describedby': view.purpose ? prefix + '-description' : undefined,
            style: { minWidth: fit ? 0 : readableWidth, maxWidth: geometry.width } },
          h('title', { id: prefix + '-title' }, title), view.purpose && h('desc', { id: prefix + '-description' }, view.purpose),
          arrowheads(prefix),
          view.kind === 'sequence' && geometry.nodes.map((node, i) => h('g', { key: 'life-' + node.id },
            i % 2 === 0 && h('rect', { x: node.x - 7, y: node.y, width: node.w + 14, height: geometry.height - node.y - 14,
              rx: 7, className: 'dsh-wiki-view-lane' }),
            h('line', { x1: center(node)[0], x2: center(node)[0], y1: node.y + node.h, y2: geometry.height - 24, className: 'dsh-wiki-view-lifeline' }))),
          geometry.edges.map(edge => {
            const d = edge.points.map(([x, y], index) => (index ? 'L' : 'M') + x + ' ' + y).join(' ')
            const box = edge.labelBox ?? edge.numberBox
            const label = edgeLabel(edge)
            const href = edge.refs?.[0]?.href
            return h(href ? 'a' : 'g', { key: edge.id, ...sourceAttributes(href, label),
              className: 'dsh-wiki-view-edge-link', 'data-edge-id': edge.id, 'data-relation': edge.relation },
              h('title', null, label), href && h('path', { d, className: 'dsh-wiki-view-edge-region' }),
              h('path', { d, ...relationArrows(prefix, edge.relation), className: 'dsh-wiki-view-edge' }),
              view.kind === 'sequence' ? textRows(edge.messageRows,
                (edge.points[0][0] + edge.points.at(-1)[0]) / 2, edge.messageY, 13, 'dsh-wiki-view-message')
                : box && h('g', { className: 'dsh-wiki-view-edge-label', 'data-relation-number': edge.number },
                  h('rect', { x: box.x, y: box.y, width: box.w, height: box.h, rx: 4 }),
                  textRows(box.rows, box.x + box.w / 2, box.y + 15, 12)))
          }),
          geometry.nodes.map(node => {
            const href = node.refs?.[0]?.href
            return h(href ? 'a' : 'g', { key: node.id, ...sourceAttributes(href, node.label),
              className: 'dsh-wiki-view-node', 'data-node-id': node.id, 'data-node-role': node.role },
              h('title', null, [node.label, node.detail, ...(node.members ?? []), ...(node.refs ?? []).map(ref => ref.label)].filter(Boolean).join('\n')),
              shape(node, view.kind), nodeText(node, view.kind))
          }))),
        geometry.edges.some(edge => edge.number) && h('ol', { className: 'dsh-code-wiki-view-relations', 'aria-label': '图中编号关系' },
          geometry.edges.filter(edge => edge.number).map(edge => h('li', { key: edge.id, value: edge.number },
            h('strong', null, byId.get(edge.from).label + ' → ' + byId.get(edge.to).label), h('span', null, edge.label)))),
        interfaceContracts(geometry.edges, byId),
        references.length > 0 && h('details', { className: 'dsh-code-wiki-view-sources' }, h('summary', null, '视图源码依据'),
          h('ul', null, references.map((item, i) => h('li', { key: i }, h('span', null, item.label),
            item.detail && h('p', null, item.detail), item.members?.length && h('ul', null,
              item.members.map((member, index) => h('li', { key: index }, h('code', null, member)))),
            item.refs.map((ref, j) => h('a', { key: j, href: ref.href, target: '_blank', rel: 'noreferrer' }, ref.label)))))))
    }
  }
  return { layout, createRenderer }
})()

export function layoutWikiView(view) { return wikiViews.layout(view) }
export function createWikiViewRenderer(React) { return wikiViews.createRenderer(React) }
