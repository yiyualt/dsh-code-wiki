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

function codePositions(node) {
  if (node.type === 'code' || node.type === 'inlineCode') return [node.position]
  return node.children?.flatMap(codePositions) ?? []
}

export function replaceOutsideCode(markdown, replace, tree = fromMarkdown(markdown)) {
  let result = ''
  let previousEnd = 0
  for (const { start, end } of codePositions(tree)) {
    result += replace(markdown.slice(previousEnd, start.offset)) + markdown.slice(start.offset, end.offset)
    previousEnd = end.offset
  }
  return result + replace(markdown.slice(previousEnd))
}
