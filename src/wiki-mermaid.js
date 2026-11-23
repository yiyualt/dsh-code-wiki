// Interpret a bounded Mermaid subset as data for the native SVG renderer.
// Unknown statements fall back to source rather than displaying a partial diagram.
const wikiMermaid = (() => {
  const id = '[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*'
  const identifier = new RegExp('^' + id)
  const nodeLimit = 12
  const edgeLimit = 24
  const flowShapes = [
    ['([', '])', 'process'], ['[(', ')]', 'store'], ['(((', ')))', 'process'],
    ['((', '))', 'process'], ['[[', ']]', 'component'], ['[/', '/]', 'data'],
    ['[', ']', 'component'], ['(', ')', 'process'], ['{', '}', 'decision'],
  ]
  const flowArrows = new Map([['-.->', 'dashed'], ['-->', undefined], ['==>', undefined], ['---', 'association']])
  const sequenceArrows = new Map([['-->>', 'return'], ['->>', undefined], ['--)', 'async-dashed'],
    ['-)', 'async'], ['-->', 'dashed'], ['->', undefined]])
  const sequenceParticipant = new RegExp('^(participant|actor)[ \\t]+(' + id + ')(?:[ \\t]+as[ \\t]+(.+))?$')
  const sequenceMessage = new RegExp('^(' + id + ')\\s*(-->>|->>|--\\)|-\\)|-->|->)\\s*(' + id + ')\\s*:\\s*(.+)$')
  const endpoint = '(' + id + '|\\[\\*\\])'
  const stateTransition = new RegExp('^' + endpoint + '\\s*-->\\s*' + endpoint + '(?:\\s*:\\s*(.+))?$')
  const stateAlias = new RegExp('^state\\s+("[^"\\r\\n]+")\\s+as\\s+(' + id + ')$')
  const stateDeclaration = new RegExp('^state\\s+(' + id + ')(?:\\s+(<<choice>>))?$')

  function label(value) {
    let result = value.trim()
    if (result.startsWith('"') || result.endsWith('"')) {
      if (!(result.startsWith('"') && result.endsWith('"'))) return
      result = result.slice(1, -1).trim()
    }
    if (result && result.length <= 160) return result
  }

  function diagram(kind, direction) {
    const nodes = new Map()
    const edges = []
    function node(id, name, role = 'component') {
      if (!id || id.length > 60 || name === null || !nodes.has(id) && nodes.size >= nodeLimit) return false
      if (name !== undefined || !nodes.has(id)) nodes.set(id, { id, label: name ?? id, role })
      return true
    }
    function edge(from, to, name = '', relation) {
      if (edges.length >= edgeLimit || name === null || !node(from) || !node(to)) return false
      edges.push({ from, to, label: name, relation })
      return true
    }
    return { node, edge, result: () => edges.length && nodes.size >= 2 ? { kind, direction, nodes: [...nodes.values()], edges } : null }
  }

  function flowNode(source, graph) {
    const name = identifier.exec(source)?.[0]
    if (!name) return
    let rest = source.slice(name.length)
    let nodeLabel, role
    for (const [open, close, shape] of flowShapes) {
      if (!rest.startsWith(open)) continue
      const quoted = rest[open.length] === '"'
      const end = quoted ? rest.indexOf('"' + close, open.length + 1) : rest.indexOf(close, open.length)
      if (end < 0) return
      nodeLabel = label(rest.slice(open.length, end + Number(quoted))) ?? null
      role = shape
      rest = rest.slice(end + Number(quoted) + close.length)
      break
    }
    if (graph.node(name, nodeLabel, role)) return { id: name, rest: rest.trimStart() }
  }

  function flowEdge(text) {
    const arrow = [...flowArrows.keys()].find(operator => text.startsWith(operator))
    if (!arrow) {
      const labeled = /^--\s+(.+?)\s+-->\s*/.exec(text)
      if (!labeled) return
      const name = label(labeled[1])
      if (name) return { name, rest: text.slice(labeled[0].length) }
      return
    }
    let rest = text.slice(arrow.length).trimStart()
    let name
    if (rest.startsWith('|')) {
      const end = rest.startsWith('|"') ? rest.indexOf('"|', 2) + 1 : rest.indexOf('|', 1)
      if (end <= 1 || !(name = label(rest.slice(1, end)))) return
      rest = rest.slice(end + 1).trimStart()
    }
    return { name, relation: flowArrows.get(arrow), rest }
  }

  function flowchart(statements, direction) {
    const graph = diagram('flow', direction)
    for (const statement of statements) {
      let left = flowNode(statement, graph)
      if (!left) return null
      while (left.rest) {
        const connector = flowEdge(left.rest)
        if (!connector) return null
        const right = flowNode(connector.rest, graph)
        if (!right || !graph.edge(left.id, right.id, connector.name, connector.relation)) return null
        left = right
      }
    }
    return graph.result()
  }

  function sequence(statements) {
    const graph = diagram('sequence')
    let numbered = false
    for (const statement of statements) {
      if (statement === 'autonumber') { numbered = true; continue }
      const participant = sequenceParticipant.exec(statement)
      if (participant) {
        const [, kind, id, alias] = participant
        if (!graph.node(id, alias === undefined ? id : label(alias) ?? null, kind === 'actor' ? 'actor' : 'component')) return null
        continue
      }
      const message = sequenceMessage.exec(statement)
      if (!message) return null
      const [, from, arrow, to, text] = message
      if (!graph.edge(from, to, label(text) ?? null, sequenceArrows.get(arrow))) return null
    }
    const result = graph.result()
    if (result) return { ...result, numbered }
    return null
  }

  function stateDiagram(statements) {
    const direction = /^direction (LR|TD|TB)$/.exec(statements[0])?.[1]
    const graph = diagram('state', direction)
    for (const statement of direction ? statements.slice(1) : statements) {
      const alias = stateAlias.exec(statement)
      if (alias) {
        if (!graph.node(alias[2], label(alias[1]) ?? null)) return null
        continue
      }
      const declaration = stateDeclaration.exec(statement)
      if (declaration) {
        if (!graph.node(declaration[1], declaration[1], declaration[2] ? 'decision' : 'component')) return null
        continue
      }
      const transition = stateTransition.exec(statement)
      if (!transition) return null
      let [, from, to, text] = transition
      if (from === '[*]') {
        from = 'state:start'
        if (!graph.node(from, '开始', 'start')) return null
      }
      if (to === '[*]') {
        to = 'state:end'
        if (!graph.node(to, '结束', 'end')) return null
      }
      if (!graph.edge(from, to, text === undefined ? '' : label(text) ?? null)) return null
    }
    return graph.result()
  }

  function parse(source) {
    if (typeof source !== 'string' || source.length > 8_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) return null
    const statements = source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^%%(?!\{)/.test(line))
    if (statements.length < 2 || statements.length > 72 || statements.some(line => line.length > 450)) return null
    const [header, ...body] = statements
    const flow = /^(?:flowchart|graph)\s+(TD|TB|LR)$/.exec(header)
    if (flow) return flowchart(body, flow[1])
    if (header === 'sequenceDiagram') return sequence(body)
    if (header === 'stateDiagram-v2' || header === 'stateDiagram') return stateDiagram(body)
    return null
  }

  return { parse }
})()

export function parseWikiMermaid(source) { return wikiMermaid.parse(source) }
