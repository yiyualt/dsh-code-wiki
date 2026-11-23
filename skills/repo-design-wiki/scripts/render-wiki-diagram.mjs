import { diagramSourceAt } from './diagram-svg.mjs'
import { renderEntityDiagram } from './render-entity-diagram.mjs'
import { renderGraphDiagram } from './render-graph-diagram.mjs'
import { renderSequenceDiagram } from './render-sequence-diagram.mjs'

export function renderWikiDiagram(diagram, sources, repository) {
  const sourceAt = diagramSourceAt(sources, repository)
  if (diagram.kind === 'sequence') return renderSequenceDiagram(diagram, sourceAt)
  if (diagram.kind === 'er') return renderEntityDiagram(diagram, sourceAt)
  return renderGraphDiagram(diagram, sourceAt)
}
