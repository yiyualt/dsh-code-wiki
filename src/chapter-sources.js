const citationRun = /【[1-9]\d*】(?:[ \t]*【[1-9]\d*】)*/gu
const citationMarker = /([ \t]*)【([1-9]\d*)】/gu

// Match the citation group emitted by the diagram renderer, leaving other SVG labels and links intact.
const diagramCitation = /(<(?:a|g) [^<>]*?aria-label="源码)【([1-9]\d*)】( [^<>]*"><title>源码)【\2】( [^<>]*<\/title><text [^<>]*><tspan [^<>]*>)【\2】(?=<\/tspan>)/gu

export function chapterSources({ markdown, sources, diagrams }) {
  const filesByPath = new Map()
  const fileNumbers = sources.map(({ path, line }) => {
    if (!filesByPath.has(path)) {
      filesByPath.set(path, { path, number: filesByPath.size + 1, lines: new Set() })
    }
    const file = filesByPath.get(path)
    file.lines.add(line)
    return file.number
  })
  const files = Array.from(filesByPath.values(), ({ path, lines }) => ({
    path, lines: [...lines].sort((a, b) => a - b),
  }))
  if (!files.length) return { markdown, diagrams, files }

  const fileNumber = sourceNumber => fileNumbers[Number(sourceNumber) - 1]
  const numberedMarkdown = markdown.replace(citationRun, run => {
    const seen = new Set()
    return run.replace(citationMarker, (reference, space, sourceNumber) => {
      const number = fileNumber(sourceNumber)
      if (!number) return reference
      if (seen.has(number)) return ''
      seen.add(number)
      return `${space}【${number}】`
    })
  })
  if (files.length === sources.length) return { markdown: numberedMarkdown, diagrams, files }

  const numberedDiagrams = diagrams.map(diagram => {
    const svg = diagram.svg.replace(diagramCitation, (citation, label, sourceNumber, title, text) => {
      const number = fileNumber(sourceNumber)
      if (!number || number === Number(sourceNumber)) return citation
      const marker = `【${number}】`
      return `${label}${marker}${title}${marker}${text}${marker}`
    })
    return svg === diagram.svg ? diagram : { ...diagram, svg }
  })
  return { markdown: numberedMarkdown, diagrams: numberedDiagrams, files }
}
