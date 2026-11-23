import { fromMarkdown } from 'mdast-util-from-markdown'

const figureMarker = /^( {0,3})\[\[figure:(-?\d+)\]\][ \t]*$/
const blank = /^[ \t]*$/

export function isFigureSlot(value) {
  return Number.isSafeInteger(value) && value > 0
}

export function chapterFigureSlots(markdown, tree) {
  if (!markdown.includes('[[figure:')) return []
  const lines = markdown.split(/\r\n|[\r\n]/)
  const figures = []
  for (const { type, position } of (tree ?? fromMarkdown(markdown)).children) {
    if (type !== 'paragraph' || position.start.line !== position.end.line) continue
    const index = position.start.line - 1
    const line = lines[index]
    const match = figureMarker.exec(line)
    if (!match || !blank.test(lines[index - 1] ?? '') || !blank.test(lines[index + 1] ?? '')) continue
    const start = position.start.offset - match[1].length
    figures.push({ slot: Number(match[2]), start, end: start + line.length })
  }
  return figures
}

export function replaceChapterText(markdown, replace, tree) {
  const parts = []
  let offset = 0
  function visit(node) {
    if (node.type === 'link' || node.type === 'linkReference') return
    if (node.type !== 'text') {
      node.children?.forEach(visit)
      return
    }
    const { start, end } = node.position
    const original = markdown.slice(start.offset, end.offset)
    const updated = replace(original)
    if (updated !== original) {
      parts.push(markdown.slice(offset, start.offset), updated)
      offset = end.offset
    }
  }
  visit(tree)
  return parts.join('') + markdown.slice(offset)
}
