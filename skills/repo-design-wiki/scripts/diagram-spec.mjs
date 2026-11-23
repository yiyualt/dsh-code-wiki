import { singleLine } from './wiki-generation.mjs'

const objectLimit = 8
const relationLimit = 12
const messageLimit = 16
const roleNames = new Map([
  ['context', ['external', 'actor', 'system']],
  ['component', ['component', 'interface', 'external']],
  ['dependency', ['module', 'package', 'interface', 'external']],
  ['flow', ['action', 'start', 'decision', 'end']],
  ['data', ['process', 'producer', 'store', 'consumer']],
  ['state', ['state', 'start', 'end']],
  ['deployment', ['app', 'process', 'store']],
])
const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
const textCharacter = /[\p{L}\p{N}]/u
const messageTypes = new Set(['call', 'return', 'async'])
const cardinalities = new Set(['0..1', '1', '0..*', '1..*', '?'])
const fieldKeys = new Set(['', 'PK', 'FK', 'UK'])

function readText(value, length, label, invalid) {
  const text = singleLine(value, length)
  if (!textCharacter.test(text)) throw invalid(label + '须为简短的单行文字。')
  return text
}

function readNamed(items, min, max, name, invalid) {
  if (!Array.isArray(items) || items.length < min || items.length > max) {
    throw invalid(name + '数量须在 ' + min + ' 至 ' + max + ' 之间。')
  }
  const ids = new Set()
  return items.map(item => {
    const id = item?.id
    if (typeof id !== 'string' || !identifier.test(id) || ids.has(id)) {
      throw invalid(name + '需要互不重复的 ASCII 标识。')
    }
    ids.add(id)
    return { id, label: readText(item.label, 80, name, invalid) }
  })
}

function readLinks(items, members, limit, sourceCount, invalid) {
  if (!Array.isArray(items) || !items.length || items.length > limit) {
    throw invalid('图至少需要一条关系，最多 ' + limit + ' 条。')
  }
  const neighbors = new Map(members.map(({ id }) => [id, new Set()]))
  const links = items.map(item => {
    const { from, to, source } = item ?? {}
    if (!neighbors.has(from) || !neighbors.has(to) || !Number.isSafeInteger(source) || source < 1 || source > sourceCount) {
      throw invalid('图中每条关系须连接已有对象，并引用本次读过的源码位置。')
    }
    neighbors.get(from).add(to)
    neighbors.get(to).add(from)
    return { from, to, source, label: readText(item.label, 80, '关系标签', invalid) }
  })
  const reachable = new Set([members[0].id])
  for (const id of reachable) {
    for (const neighbor of neighbors.get(id)) reachable.add(neighbor)
  }
  if (reachable.size !== members.length) throw invalid('图中的关系须把所有对象连通。')
  return links
}

function readGroups(items, nodes, kind, invalid) {
  const groups = readNamed(items ?? [], kind === 'deployment' ? 1 : 0, objectLimit, '分组', invalid)
  const remaining = new Set(nodes.map(node => node.id))
  const parsed = groups.map((group, index) => {
    const members = items[index].nodes
    if (!Array.isArray(members) || !members.length || members.some(id => !remaining.delete(id))) {
      throw invalid('每个分组须包含有效的节点，每个节点最多归入一组。')
    }
    return { ...group, nodes: members }
  })
  if (kind === 'deployment' && remaining.size) throw invalid('部署图的每个节点须归入一个运行位置。')
  if (parsed.length && kind !== 'component' && kind !== 'deployment') {
    throw invalid('只有组件图和部署图支持分组。')
  }
  return parsed
}

function readGraph(spec, sourceCount, invalid) {
  const { kind, title } = spec
  const allowedRoles = roleNames.get(kind)
  const nodes = readNamed(spec.nodes, 2, objectLimit, '节点', invalid).map((node, index) => {
    const role = spec.nodes[index].role ?? allowedRoles[0]
    if (!allowedRoles.includes(role)) throw invalid('节点角色须为 ' + allowedRoles.join('、') + ' 之一。')
    return { ...node, role }
  })
  if (kind === 'context' && nodes.filter(node => node.role === 'system').length !== 1) {
    throw invalid('系统上下文图须标出一个 system 作为目标系统。')
  }
  return {
    kind, title, nodes,
    groups: readGroups(spec.groups, nodes, kind, invalid),
    edges: readLinks(spec.edges, nodes, relationLimit, sourceCount, invalid),
  }
}

function readSequence(spec, sourceCount, invalid) {
  const participants = readNamed(spec.participants, 2, objectLimit, '时序参与者', invalid)
  const messages = readLinks(spec.messages, participants, messageLimit, sourceCount, invalid).map((message, index) => {
    const type = spec.messages[index].type
    if (!messageTypes.has(type)) throw invalid('时序消息的 type 须为 call、return 或 async。')
    return { ...message, type }
  })
  return { kind: spec.kind, title: spec.title, participants, messages }
}

function readEntities(spec, sourceCount, invalid) {
  const entities = readNamed(spec.entities, 2, objectLimit, '实体', invalid).map((entity, index) => {
    const rawFields = spec.entities[index].fields
    if (!Array.isArray(rawFields) || rawFields.length > 8) throw invalid('每个实体的 fields 需要一个最多 8 项的数组。')
    const fields = rawFields.map(field => {
      const name = readText(field?.name, 60, '字段名', invalid)
      const type = field.type === undefined || field.type === '' ? '' : readText(field.type, 60, '字段类型', invalid)
      const key = field.key ?? ''
      if (!fieldKeys.has(key)) throw invalid('实体字段的 key 须为 PK、FK、UK 或空字符串。')
      return { name, type, key }
    })
    return { ...entity, fields }
  })
  const relations = readLinks(spec.relations, entities, relationLimit, sourceCount, invalid).map((relation, index) => {
    const { fromCardinality, toCardinality } = spec.relations[index]
    if (!cardinalities.has(fromCardinality) || !cardinalities.has(toCardinality)) {
      throw invalid('关系两端的基数须为 0..1、1、0..*、1..* 或 ?。')
    }
    return { ...relation, fromCardinality, toCardinality }
  })
  return { kind: spec.kind, title: spec.title, entities, relations }
}

export function readDiagram(spec, sourceCount, invalid) {
  const kind = spec?.kind
  if (!roleNames.has(kind) && kind !== 'sequence' && kind !== 'er') {
    throw invalid('请按图型说明使用 context、component、dependency、sequence、data、flow、state、er 或 deployment。')
  }
  const diagram = { ...spec, title: readText(spec.title, 100, '图标题', invalid) }
  if (kind === 'sequence') return readSequence(diagram, sourceCount, invalid)
  if (kind === 'er') return readEntities(diagram, sourceCount, invalid)
  return readGraph(diagram, sourceCount, invalid)
}
