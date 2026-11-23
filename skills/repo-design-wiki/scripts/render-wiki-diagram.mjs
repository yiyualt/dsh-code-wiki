import { renderEntityDiagram } from './render-entity-diagram.mjs'
import { renderGraphDiagram } from './render-graph-diagram.mjs'
import { renderSequenceDiagram } from './render-sequence-diagram.mjs'

export function renderWikiDiagram(diagram, sources, repository) {
  function sourceAt(number) {
    const { path, line } = sources[number - 1]
    const position = path + ':' + line
    if (!repository.webUrl) return { position }
    const filePath = path.split('/').map(encodeURIComponent).join('/')
    const url = repository.webUrl + '/blob/' + repository.commit + '/' + filePath + '#L' + line
    return { position, url }
  }
  if (diagram.kind === 'sequence') return renderSequenceDiagram(diagram, sourceAt)
  if (diagram.kind === 'er') return renderEntityDiagram(diagram, sourceAt)
  return renderGraphDiagram(diagram, sourceAt)
}
