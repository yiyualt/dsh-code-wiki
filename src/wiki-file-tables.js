const fileHeader = /^ {0,3}\|\s*(?:关键文件|主要文件|相关文件|源码文件|配置文件|文件路径|文件名|文件|files?|file (?:names?|paths?))\s*\|/i
const tableRule = /^ {0,3}\|(?:[ \t]*:?-{3,}:?[ \t]*\|){2,}[ \t]*\r?$/
const tableRow = /^( {0,3}\|)([^|]*)(\|[^\n]*)$/
const escapedLink = /\\\[([^|\]\r\n]+)\\\]\\\((?:\\<([^|<>\r\n]+)\\>|([^|<>)\r\n]+))\\\)/g
const relativePath = /^(?:\.\/)?([\p{L}\p{M}\p{N}._@+-]+(?:\/[\p{L}\p{M}\p{N}._@+-]+)*)(?:#L\d+(?:-L\d+)?)?$/u

function cleanFileCell(cell) {
  return cell.replace(escapedLink, (original, label, angleTarget, bareTarget) => {
    const name = label.replace(/\\_/g, '_')
    const path = relativePath.exec((angleTarget ?? bareTarget).replace(/\\([_#])/g, '$1'))?.[1]
    if (!path) return original
    const parts = path.split('/')
    if (parts.some(part => part === '.' || part === '..')) return original
    if (name !== parts.at(-1) && name.replace(/^\.\//, '') !== path) return original
    return '\x60' + name + '\x60'
  })
}

// Older drafts serialized relative links as escaped prose. Display the intended file name
// while keeping the separate, validated source citations as the navigation targets.
export function formatWikiFileTables(markdown) {
  if (!markdown.includes('\\]\\(')) return markdown
  let fence, inFiles = false
  const lines = markdown.split('\n')
  return lines.map((line, index) => {
    const marker = /^ {0,3}(\x60{3,}|~{3,})([^\n]*)$/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
      return line
    }
    if (marker) { fence = marker[1]; inFiles = false; return line }
    if (fileHeader.test(line) && tableRule.test(lines[index + 1] ?? '')) {
      inFiles = true
      return line
    }
    const row = inFiles && tableRow.exec(line)
    if (!row) { inFiles = false; return line }
    return row[1] + cleanFileCell(row[2]) + row[3]
  }).join('\n')
}
