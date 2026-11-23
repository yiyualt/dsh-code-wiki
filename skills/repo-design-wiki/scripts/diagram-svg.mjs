export const diagramColors = {
  surface: '#ffffff',
  paper: '#ffffff',
  ink: '#162238',
  muted: '#55647a',
  accent: '#2856a3',
  line: '#95a6bf',
  edge: '#536a8a',
  accentSurface: '#edf3fc',
  border: '#cbd6e5',
}

const labels = new Map([
  ['architecture', '逻辑架构图'],
  ['context', '系统上下文图'],
  ['component', '组件图'],
  ['dependency', '依赖图'],
  ['sequence', '时序图'],
  ['data', '数据流图'],
  ['flow', '流程图'],
  ['state', '状态图'],
  ['er', '实体关系图'],
  ['deployment', '部署图'],
])
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const words = new Intl.Segmenter('zh', { granularity: 'word' })
const xmlEntities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

export function escapeSvg(value) {
  return String(value).toWellFormed()
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/[&<>"']/g, char => xmlEntities[char])
}

// Reserve room for common system fonts when composing the SVG outside the browser.
export function textWidth(text, fontSize) {
  let units = 0
  for (const { segment } of graphemes.segment(text)) {
    if (/^\s$/u.test(segment)) units += 0.36
    else if (/^[.,:;'|!ijlI\`]$/.test(segment)) units += 0.36
    else if (/^[MW@%&]$/.test(segment)) units += 0.92
    else if (/^[\x21-\x7e]$/.test(segment)) units += 0.67
    else units += 1.08
  }
  return Math.ceil(units * fontSize)
}

export function wrapText(text, maxWidth, fontSize) {
  const lines = []
  let current = ''

  function append(part) {
    const next = current + part
    if (current.trim() && textWidth(next.trim(), fontSize) > maxWidth) {
      lines.push(current.trim())
      current = part.trimStart()
    } else {
      current = next.trimStart()
    }
  }

  for (const { segment } of words.segment(text.trim())) {
    if (textWidth(segment, fontSize) <= maxWidth) append(segment)
    else for (const part of graphemes.segment(segment)) append(part.segment)
  }
  if (current.trim()) lines.push(current.trim())
  return lines.length ? lines : ['']
}

export function svgText(lines, {
  x, y, fontSize = 13, lineHeight = 18, fill = diagramColors.ink, anchor = 'middle', weight = 500,
}) {
  const spans = lines.map((line, index) => {
    const center = y + (index - (lines.length - 1) / 2) * lineHeight
    return '<tspan x="' + x + '" y="' + center + '">' + escapeSvg(line) + '</tspan>'
  })
  return '<text x="' + x + '" text-anchor="' + anchor + '" dominant-baseline="central"'
    + ' font-size="' + fontSize + '" font-weight="' + weight + '" fill="' + fill + '">' + spans.join('') + '</text>'
}

export function renderCitation(number, x, y, sourceAt) {
  const { position, url } = sourceAt(number)
  const description = escapeSvg('源码【' + number + '】 ' + position)
  const mark = svgText(['【' + number + '】'], { x, y, fontSize: 11, weight: 650, fill: diagramColors.accent })
  const metadata = '<title>' + description + '</title>'
  if (!url) return '<g aria-label="' + description + '">' + metadata + mark + '</g>'
  return '<a href="' + escapeSvg(url) + '" target="_blank" rel="noreferrer" aria-label="' + description
    + '">' + metadata + mark + '</a>'
}

export function diagramSourceAt(sources, { webUrl, commit }) {
  return number => {
    const { path, line } = sources[number - 1]
    const position = path + ':' + line
    if (!webUrl) return { position }
    const filePath = path.split('/').map(encodeURIComponent).join('/')
    return { position, url: webUrl + '/blob/' + commit + '/' + filePath + '#L' + line }
  }
}

export function svgFigure(diagram, width, height, body) {
  width = Math.ceil(width)
  height = Math.ceil(height)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1 || width > 4096 || height > 4096) {
    throw new Error('Diagram dimensions exceed the supported range.')
  }
  const label = labels.get(diagram.kind)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height
    + '" viewBox="0 0 ' + width + ' ' + height
    + '" role="group" aria-labelledby="wiki-diagram-title" font-family="system-ui, sans-serif">'
    + '<title id="wiki-diagram-title">' + escapeSvg(label + ' · ' + diagram.title) + '</title>'
    + '<rect width="100%" height="100%" fill="' + diagramColors.surface + '"/>'
    + body + '</svg>'
  if (svg.length > 160_000) throw new Error('Diagram SVG exceeds the supported size.')
  return { kind: diagram.kind, label, title: diagram.title, width, height, svg }
}
