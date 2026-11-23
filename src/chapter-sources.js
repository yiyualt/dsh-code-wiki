import { replaceOutsideCode } from '../skills/repo-design-wiki/scripts/chapter-figures.mjs'

const citationRun = /【[1-9]\d*】(?:[ \t]*【[1-9]\d*】)*/gu
const citationMarker = /([ \t]*)【([1-9]\d*)】/gu

// Match only the citation markup emitted by the diagram renderer, with the same position in both labels.
const diagramCitation = /(<(?:a|g) [^<>]*?aria-label="源码)【([1-9]\d*)】 ([^<>"\n]+):([1-9]\d*)"><title>源码【\2】 \3:\4(<\/title><text [^<>]*><tspan [^<>]*>)【\2】(?=<\/tspan>)/gu

export function chapterSources({ markdown, sources, diagrams }) {
  const numbersByPath = new Map()
  const fileNumbers = sources.map(({ path }) => {
    if (!numbersByPath.has(path)) numbersByPath.set(path, numbersByPath.size + 1)
    return numbersByPath.get(path)
  })
  const files = [...numbersByPath.keys()]
  if (!files.length) return { markdown, diagrams, files }

  const fileNumber = sourceNumber => fileNumbers[Number(sourceNumber) - 1]
  const numberedMarkdown = replaceOutsideCode(markdown, text => text.replace(citationRun, run => {
    const seen = new Set()
    return run.replace(citationMarker, (reference, space, sourceNumber) => {
      const number = fileNumber(sourceNumber)
      if (!number) return reference
      if (seen.has(number)) return ''
      seen.add(number)
      return `${space}【${number}】`
    })
  }))
  const numberedDiagrams = diagrams.map(diagram => {
    const svg = diagram.svg.replace(diagramCitation, (citation, start, sourceNumber, path, _line, text) => {
      const number = fileNumber(sourceNumber)
      if (!number) return citation
      const marker = `【${number}】`
      const label = `${marker} ${path}`
      const fileLink = start.replace(/#L[1-9]\d*(?=" target="_blank")/u, '')
      return `${fileLink}${label}"><title>源码${label}${text}${marker}`
    })
    return svg === diagram.svg ? diagram : { ...diagram, svg }
  })
  return { markdown: numberedMarkdown, diagrams: numberedDiagrams, files }
}
