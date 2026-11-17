const frameWidth = 1280
const frameHeight = 720
const ink = '#261e38'
const muted = '#655b77'
const accent = '#6942b7'
const stroke = '#d7cee9'
const serif = '"Instrument Serif", "New York", Georgia, serif'
const sans = 'Geist, "Helvetica Neue", "PingFang SC", Arial, sans-serif'
const mono = '"Geist Mono", Menlo, monospace'
const captionCache = new WeakMap()
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
const clamp = value => Math.max(0, Math.min(1, value))

function text(ctx, value, x, y, size, { color = ink, weight = 500, family = sans } = {}) {
  ctx.font = `${weight} ${size}px ${family}`
  ctx.fillStyle = color
  ctx.fillText(value, x, y)
}

function lines(ctx, value, size, weight, family, maxWidth, maxLines) {
  ctx.font = `${weight} ${size}px ${family}`
  const rows = []
  let row = ''
  for (const { segment } of segmenter.segment(value)) {
    if (!row || ctx.measureText(row + segment.trimEnd()).width <= maxWidth) row += segment
    else {
      rows.push(row.trimEnd())
      row = segment.trimStart()
    }
  }
  if (row.trim()) rows.push(row.trim())
  const visible = rows.slice(0, maxLines)
  for (const [i, line] of visible.entries()) {
    if (ctx.measureText(line).width <= maxWidth && (i !== maxLines - 1 || rows.length === maxLines)) continue
    const chars = Array.from(line)
    while (chars.length && ctx.measureText(chars.join('') + '…').width > maxWidth) chars.pop()
    visible[i] = chars.join('').trimEnd() + '…'
  }
  return visible
}

function paragraph(ctx, value, x, y, { size, maxWidth, maxLines = 2, leading = size * 1.14, color = ink, weight = 500, family = sans }) {
  const rows = lines(ctx, value, size, weight, family, maxWidth, maxLines)
  rows.forEach((row, i) => text(ctx, row, x, y + i * leading, size, { color, weight, family }))
  return rows.length
}

function roundRect(ctx, x, y, w, h, r, fill, border) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  ctx.fillStyle = fill
  ctx.fill()
  if (border) {
    ctx.strokeStyle = border
    ctx.lineWidth = 2
    ctx.stroke()
  }
}

function captionsFor(scene) {
  const cached = captionCache.get(scene)
  if (cached) return cached
  const captions = []
  const narration = scene.narration
  const segments = [...segmenter.segment(narration)]
  let start = 0
  const limit = /[\u3400-\u9fff]/u.test(narration) ? 30 : 65
  for (const { segment, index } of segments) {
    if (index - start + segment.trimEnd().length > limit && index > start) {
      captions.push({ value: narration.slice(start, index).trim(), start })
      start = index
    }
    const end = index + segment.length
    if (end - start >= limit * 0.45 && /[.!?。！？；;]$/u.test(segment)) {
      captions.push({ value: narration.slice(start, end).trim(), start })
      start = end
    }
  }
  if (narration.slice(start).trim()) captions.push({ value: narration.slice(start).trim(), start })
  captionCache.set(scene, captions)
  return captions
}

function drawCaption(ctx, scene, progress) {
  const spoken = progress * scene.narration.length
  const caption = captionsFor(scene).findLast(item => item.start <= spoken)?.value
  if (!caption) return
  const rows = lines(ctx, caption, 30, 570, sans, 1010, 2)
  const width = Math.max(...rows.map(row => ctx.measureText(row).width)) + 38
  const height = rows.length * 36 + 14
  const y = frameHeight - 30 - height
  roundRect(ctx, (frameWidth - width) / 2, y, width, height, 9, '#252033')
  ctx.textAlign = 'center'
  rows.forEach((row, i) => text(ctx, row, frameWidth / 2, y + 33 + i * 36, 30, { color: '#fff', weight: 570 }))
  ctx.textAlign = 'left'
}

function drawBackdrop(ctx, film) {
  const paper = ctx.createLinearGradient(0, frameHeight, frameWidth, 0)
  paper.addColorStop(0, '#fcfaff')
  paper.addColorStop(1, '#ece4fc')
  ctx.fillStyle = paper
  ctx.fillRect(0, 0, frameWidth, frameHeight)
  ctx.fillStyle = '#d6cce9'
  for (let x = 16; x < frameWidth; x += 24) {
    for (let y = 16; y < frameHeight; y += 24) ctx.fillRect(x, y, 1.35, 1.35)
  }
  paragraph(ctx, film.repository, 68, 54, { size: 19, family: mono, maxWidth: 550, maxLines: 1, color: muted })
}

function horizontal(nodes, { y = 308, maxWidth = 1120, gap = 106, maxCard = 456, h = 152 } = {}) {
  const w = Math.min(maxCard, (maxWidth - (nodes.length - 1) * gap) / nodes.length)
  const left = (frameWidth - (nodes.length * w + (nodes.length - 1) * gap)) / 2
  return nodes.map((node, i) => ({ node, x: left + i * (w + gap), y, w, h }))
}

function overviewLayout(nodes, layout) {
  if (layout === 'hub' && nodes.length === 3) {
    return [
      { node: nodes[0], x: 166, y: 332, w: 357, h: 126 },
      { node: nodes[1], x: 754, y: 251, w: 357, h: 126 },
      { node: nodes[2], x: 754, y: 413, w: 357, h: 126 },
    ]
  }
  if (layout === 'column' && nodes.length <= 3) {
    return nodes.map((node, i) => ({ node, x: 356, y: 234 + i * 122, w: 568, h: 92 }))
  }
  return horizontal(nodes, { y: 300 })
}

function drawCard(ctx, card, focus, opacity, showAction = true, compact = false) {
  const { node, x, y, w, h } = card
  ctx.save()
  ctx.globalAlpha = opacity
  roundRect(ctx, x, y, w, h, 13, focus ? '#f0e6ff' : '#fff', focus ? accent : stroke)
  const action = showAction && node.action
  const titleSize = w < 230 ? 23 : 30
  const titleRows = paragraph(ctx, node.label || node.title, x + 22, y + (action ? 44 : h / 2 + 8), {
    size: titleSize, weight: 650, maxWidth: w - 44, maxLines: compact || (action && h < 110) ? 1 : 2,
  })
  if (action) paragraph(ctx, action, x + 22, y + 48 + titleRows * 31, { size: 21, color: muted, maxWidth: w - 44, maxLines: 1 })
  ctx.restore()
}

function drawConnection(ctx, first, last, edge, focus, opacity, index) {
  const dx = last.x - first.x
  const verticallyAligned = Math.abs(dx) < 1
  const direction = dx > 0 ? 1 : -1
  const y1 = first.y + first.h / 2
  const y2 = last.y + last.h / 2
  const x1 = direction > 0 ? first.x + first.w : first.x
  const x2 = direction > 0 ? last.x : last.x + last.w
  const hub = !verticallyAligned && y1 !== y2
  const adjacent = !verticallyAligned && Math.abs(x2 - x1) < 220
  const active = focus === edge.from || focus === edge.to
  const color = active ? accent : '#85759e'
  let points
  if (verticallyAligned) {
    const down = y2 > y1
    points = [[first.x + first.w / 2, down ? first.y + first.h : first.y], [last.x + last.w / 2, down ? last.y - 2 : last.y + last.h + 2]]
  } else if (hub) {
    const bend = (x1 + x2) / 2
    points = [[x1, y1], [bend, y1], [bend, y2], [x2 - direction * 2, y2]]
  } else if (adjacent) {
    points = [[x1, y1], [x2 - direction * 2, y2]]
  } else {
    const lane = first.y - 38 - 23 * index
    const start = x1 + direction * 25
    const end = x2 - direction * 25
    points = [[x1, y1], [start, y1], [start, lane], [end, lane], [end, y2], [x2 - direction * 2, y2]]
  }
  ctx.save()
  ctx.globalAlpha = opacity
  ctx.strokeStyle = color
  ctx.lineWidth = active ? 3.6 : 2.7
  ctx.lineJoin = 'round'
  ctx.beginPath()
  points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))
  ctx.stroke()
  const [x, y] = points.at(-1)
  const [px, py] = points.at(-2)
  const angle = Math.atan2(y - py, x - px)
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - 11 * Math.cos(angle - 0.52), y - 11 * Math.sin(angle - 0.52))
  ctx.lineTo(x - 11 * Math.cos(angle + 0.52), y - 11 * Math.sin(angle + 0.52))
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  if (edge.label && adjacent && !hub) {
    ctx.textAlign = 'center'
    paragraph(ctx, edge.label, (x1 + x2) / 2, y1 - 17, { size: 16, color, maxLines: 1, maxWidth: Math.abs(x2 - x1) - 10 })
    ctx.textAlign = 'left'
  }
  ctx.restore()
}

function drawGraph(ctx, scene, focus, progress, isNew) {
  const sequence = isNew && scene.kind === 'flow'
  const cards = sequence ? horizontal(scene.nodes, { y: 320, h: 112, gap: 126, maxCard: 350 }) : overviewLayout(scene.nodes, scene.layout)
  const shown = new Map()
  let previousReveal = 0
  for (const [index, card] of cards.entries()) {
    const cue = scene.cues.find(item => item.node === card.node.id)?.offset
    if (sequence && index) previousReveal = Math.max(previousReveal + .06, Math.min(.66, cue ?? index * .18))
    const opacity = !sequence || !index ? 1 : clamp((progress - previousReveal) / .055)
    shown.set(card.node.id, { card, opacity })
  }
  for (const [index, edge] of scene.edges.slice(0, 2).entries()) {
    const start = shown.get(edge.from)
    const end = shown.get(edge.to)
    if (start?.opacity && end?.opacity) drawConnection(ctx, start.card, end.card, edge, focus, Math.min(start.opacity, end.opacity), index)
  }
  for (const { card, opacity } of shown.values()) if (opacity) drawCard(ctx, card, card.node.id === focus, opacity, !sequence)
}

function drawDetail(ctx, scene, focus, isNew) {
  const headline = scene.headline || scene.title
  paragraph(ctx, headline, 76, 260, { size: isNew ? 67 : 49, maxWidth: 505, maxLines: 3, family: serif })
  const count = Math.min(scene.nodes.length, 2)
  for (const [index, node] of scene.nodes.slice(0, count).entries()) {
    const y = count === 1 ? 242 : 194 + index * 165
    drawCard(ctx, { node, x: 645, y, w: 550, h: 135 }, node.id === focus, 1, true, true)
    const ref = node.refs?.[0]
    if (ref?.label) paragraph(ctx, ref.label, 667, y + 111, { size: 16, color: muted, maxWidth: 501, maxLines: 1, family: mono })
  }
}

// Playback, seeking, and export use identical frame coordinates and timing.
export function codeWikiVideoFrame(canvas, film, time, { captions: showCaptions = true } = {}) {
  const ctx = canvas.getContext('2d')
  ctx.save()
  ctx.scale(canvas.width / frameWidth, canvas.height / frameHeight)
  ctx.globalAlpha = 1
  ctx.textAlign = 'left'
  const index = Math.max(0, film.scenes.findLastIndex(scene => time >= scene.start))
  const scene = film.scenes[index]
  const local = Math.max(0, time - scene.start)
  const progress = clamp((local - (scene.audioOffset ?? .2)) / Math.max(.01, scene.speechSeconds))
  const focus = scene.cues.findLast(cue => cue.offset <= progress)?.node
  const isNew = film.language === 'en'
  const headline = scene.headline || scene.title
  drawBackdrop(ctx, film)
  if (scene.kind === 'intro' || scene.kind === 'outro') {
    const titleSize = isNew ? 90 : 65
    paragraph(ctx, headline, 76, 304, { size: titleSize, maxWidth: 1110, maxLines: 3, family: serif })
  } else if (scene.kind === 'detail') {
    drawDetail(ctx, scene, focus, isNew)
  } else {
    paragraph(ctx, headline, 76, 145, { size: isNew ? 59 : 51, maxWidth: 1120, family: serif })
    drawGraph(ctx, scene, focus, progress, isNew)
  }
  if (showCaptions) drawCaption(ctx, scene, progress)
  ctx.restore()
  return { scene, index }
}
