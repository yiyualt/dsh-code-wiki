import { diagramColors as colors, escapeSvg, renderCitation, svgFigure, svgText, textWidth, wrapText } from './diagram-svg.mjs'

const padding = 24
const messageFont = 13
const messageLineHeight = 18
const messageStyles = {
  call: { label: '同步调用', color: colors.edge, filled: true },
  return: { label: '返回', color: colors.muted, dash: '5 4' },
  async: { label: '异步消息', color: colors.accent },
}

function arrowhead(x, y, direction, style) {
  const back = x - direction * 8
  const points = `M${back},${y - 4} L${x},${y} L${back},${y + 4}`
  return `<path d="${points}${style.filled ? ' Z' : ''}" fill="${style.filled ? style.color : 'none'}" stroke="${style.color}" stroke-width="1.5" stroke-linejoin="round"/>`
}

function arrow(path, x, y, direction, style) {
  const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : ''
  const line = `<path d="${path}" fill="none" stroke="${style.color}" stroke-width="1.5" stroke-linejoin="round"${dash}/>`
  return line + arrowhead(x, y, direction, style)
}

export function renderSequenceDiagram(diagram, sourceAt) {
  const participants = diagram.participants.map(participant => {
    const lines = wrapText(participant.label, 158, 14)
    const width = Math.ceil(Math.max(118, ...lines.map(line => textWidth(line, 14) + 24)))
    return { ...participant, lines, width }
  })
  const headerHeight = Math.max(...participants.map(participant => 20 + participant.lines.length * 19))
  let right = padding
  for (const participant of participants) {
    participant.x = right + participant.width / 2
    right += participant.width + 70
  }
  right -= 70
  const byId = new Map(participants.map(participant => [participant.id, participant]))

  let nextY = padding + headerHeight + 22
  const messages = diagram.messages.map(message => {
    const from = byId.get(message.from).x
    const to = byId.get(message.to).x
    const self = from === to
    const cap = self ? 133 : Math.min(280, Math.abs(from - to) - 66)
    const lines = wrapText(message.label, cap, messageFont)
    const labelWidth = Math.max(...lines.map(line => textWidth(line, messageFont)))
    const labelHeight = lines.length * messageLineHeight
    const labelX = self ? from + 11 : (from + to - labelWidth - 33) / 2
    const labelY = nextY + labelHeight / 2
    const y = nextY + labelHeight + 8
    const endY = self ? y + 24 : y
    const path = self ? `M${from},${y} h58 v24 H${to}` : `M${from},${y} H${to}`

    right = Math.max(right, labelX + labelWidth + 37)
    nextY = endY + 22
    return { ...message, fromX: from, toX: to, endY, path, lines, labelX, labelY, labelWidth }
  })

  const width = Math.max(right + padding, 360)
  const height = nextY + 36
  const actors = participants.map(participant => {
    const left = participant.x - participant.width / 2
    const fill = colors.accentSurface
    return `<g data-participant-id="${escapeSvg(participant.id)}"><path d="M${participant.x},${padding + headerHeight} V${nextY - 4}" fill="none" stroke="${colors.line}" stroke-width="1.3" stroke-dasharray="5 5"/><rect x="${left}" y="${padding}" width="${participant.width}" height="${headerHeight}" rx="7" fill="${fill}" stroke="${colors.border}"/>${svgText(participant.lines, { x: participant.x, y: padding + headerHeight / 2, fontSize: 14, lineHeight: 19, fill: colors.ink, weight: 650 })}</g>`
  }).join('')

  const exchanges = messages.map((message, index) => {
    const { from, to, fromX, toX, endY, path, lines, labelX, labelY, labelWidth } = message
    const style = messageStyles[message.type]
    const label = svgText(lines, { x: labelX, y: labelY, fontSize: messageFont, lineHeight: messageLineHeight, anchor: 'start', fill: colors.ink })
    const citation = renderCitation(message.source, labelX + labelWidth + 19, labelY, sourceAt)
    return `<g data-message-index="${index}" data-message-type="${message.type}" data-message-from="${escapeSvg(from)}" data-message-to="${escapeSvg(to)}">${arrow(path, toX, endY, toX > fromX ? 1 : -1, style)}${label}${citation}</g>`
  }).join('')

  const usedTypes = new Set(messages.map(message => message.type))
  let legendX = padding
  const legendY = nextY + 12
  const legend = Object.entries(messageStyles).filter(([type]) => usedTypes.has(type)).map(([, style]) => {
    const x = legendX
    legendX += 104
    return arrow(`M${x},${legendY} h23`, x + 23, legendY, 1, style) +
      svgText([style.label], { x: x + 31, y: legendY, fontSize: 11, anchor: 'start', fill: colors.muted })
  }).join('')

  return svgFigure(diagram, width, height, actors + exchanges + legend)
}
