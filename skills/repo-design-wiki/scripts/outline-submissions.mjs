import { isDeepStrictEqual } from 'node:util'
import { chapterFigureSlots } from './chapter-figures.mjs'
import { readDiagram } from './diagram-spec.mjs'
import { renderArchitectureDiagram } from './render-architecture-diagram.mjs'
import { renderWikiDiagram } from './render-wiki-diagram.mjs'
import { readSources, singleLine, tool } from './wiki-generation.mjs'
import { normalizeWikiCitations, readWikiMarkdown, rewriteWikiCitations } from './wiki-markdown.mjs'

const internalRoles = new Set(['component', 'module', 'package'])
const sections = {
  overview: { label: '总览正文', tool: 'wiki_submit_overview' },
  architecture: { label: '逻辑架构图', tool: 'wiki_submit_architecture' },
  moduleMap: { label: '模块交接图', tool: 'wiki_submit_module_map' },
  outline: { label: 'RQ 目录', tool: 'wiki_submit_outline' },
}

export function invalidOutline(message) {
  return Object.assign(new Error(message), { code: 'wiki-outline-invalid' })
}

function readPinnedSources(input, evidence, field, maxSources) {
  const sources = readSources(input, evidence, maxSources)
  if (sources) return sources
  if (!Array.isArray(input) || !input.length) throw invalidOutline(`${field} 须列出本次 wiki_read 已读的文件与行号。`)
  if (input.length > maxSources) throw invalidOutline(`${field} 须保留 1 至 ${maxSources} 个已读位置。`)
  const index = input.findIndex(source => !readSources([source], evidence))
  const { path, line } = input[index] ?? {}
  if (typeof path !== 'string' || !Number.isSafeInteger(line) || line < 1) {
    throw invalidOutline(`${field} 第 ${index + 1} 项须提供文件 path 和正整数 line。`)
  }
  const ranges = evidence.get(path)
  const details = ranges?.length
    ? `该文件已返回的行范围为 ${ranges.map(({ start, end }) => `${start}–${end}`).join('、')}。`
    : '本次 wiki_read 未返回该文件的内容。'
  throw invalidOutline(`${field} 第 ${index + 1} 项 ${path}:${line} 未读。${details}`)
}

function readOverview(input, evidence) {
  const mainline = singleLine(input?.mainline, 4_000)
  if (!mainline || !mainline.isWellFormed()) throw invalidOutline('mainline 需要一句有效的单行主线。')
  const { markdown, tree } = readWikiMarkdown(input?.markdown, invalidOutline, {
    label: '总览正文',
    proseError: '总览正文须说明项目用途、核心模块和它们怎样协作。',
    diagramError: '请分别提交两张图的数据，并在总览 Markdown 中放置图位。',
  })
  const figures = chapterFigureSlots(markdown, tree)
  if (figures.length !== 2 || figures[0].slot !== 1 || figures[1].slot !== 2) {
    throw invalidOutline('总览正文依次需要 [[figure:1]]（逻辑架构图）和 [[figure:2]]（模块交接图）。每个图位独占一行，前后留空行。')
  }
  const sources = readPinnedSources(input.sources, evidence, 'overview.sources', Infinity)
  let cited = false
  const marked = rewriteWikiCitations(markdown, tree, reference => {
    if (!/^[1-9]\d*$/u.test(reference) || !sources[Number(reference) - 1]) {
      throw invalidOutline(`总览正文的引用【${reference}】须使用 overview.sources 中对应的序号（1–${sources.length}）。`)
    }
    cited = true
    return `【${reference}】`
  })
  if (!cited) throw invalidOutline('总览正文需要源码引用，例如【1】，对应 overview.sources 中列出的实际位置。')
  return { mainline, markdown: normalizeWikiCitations(marked), sources }
}

function readModuleMap(spec, sources, repository) {
  if (spec?.kind !== 'component' && spec?.kind !== 'dependency') {
    throw invalidOutline('模块交接图的 kind 须为 component 或 dependency。')
  }
  const graph = readDiagram(spec, sources.length, message => invalidOutline('总览模块交接图。' + message))
  if (!graph.nodes.some(({ role }) => internalRoles.has(role))) {
    throw invalidOutline('总览模块图至少需要一个实际组件或模块。')
  }
  try {
    return { graph, diagram: renderWikiDiagram(graph, sources, repository) }
  } catch {
    throw invalidOutline('无法绘制总览模块图。请缩短标签或减少次要节点与关系，保留核心模块。')
  }
}

function readOutline(input, graph, evidence) {
  if (!Array.isArray(input?.chapters) || !input.chapters.length) throw invalidOutline('目录需要至少一个章节。')
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const moduleIds = graph.nodes.filter(({ role }) => internalRoles.has(role)).map(({ id }) => id)
  const titles = new Set()
  return input.chapters.map(chapter => {
    const title = singleLine(chapter?.title, 500)
    if (!title || !title.isWellFormed() || titles.has(title)) throw invalidOutline('章名须占一行、非空且互不重复。')
    titles.add(title)
    const sources = readPinnedSources(chapter.sources, evidence, `章节「${title}」的 sources`, 16)
    const module = nodes.get(chapter.module)
    if (!internalRoles.has(module?.role)) {
      throw invalidOutline(`章节「${title}」的 module 须是模块图中的内部模块 ID，可用 ID 为 ${moduleIds.join('、')}。`)
    }
    const handoff = chapter.handoff
    if (!Number.isSafeInteger(handoff) || handoff < 1 || handoff > graph.edges.length) {
      throw invalidOutline(`章节「${title}」的 handoff 须是模块图 edges 的整数序号（1–${graph.edges.length}）。`)
    }
    const edge = graph.edges[handoff - 1]
    if (edge.from !== module.id && edge.to !== module.id) {
      throw invalidOutline(`章节「${title}」选择的第 ${handoff} 条交接（${edge.from} → ${edge.to}）须连接 module「${module.id}」。`)
    }
    const connection = { module: module.label, from: nodes.get(edge.from).label, to: nodes.get(edge.to).label, handoff: edge.label }
    return { title, sources, markdown: '', connection }
  })
}

const string = { type: 'string' }
const integer = { type: 'integer' }
const strings = { type: 'array', items: string }

function rows(properties, required = Object.keys(properties)) {
  return { type: 'array', items: { type: 'object', properties, required, additionalProperties: false } }
}

const sourceRows = rows({ path: string, line: integer })
const componentRows = rows({ label: string, source: integer })
const capabilityRows = rows({ label: string, source: integer, components: componentRows }, ['label', 'source'])
const layerRows = rows({ id: string, label: string, groups: capabilityRows })
const sharedGroupRows = rows({
  label: string, source: integer, layers: { ...strings, minItems: 2, uniqueItems: true }, components: componentRows,
}, ['label', 'source', 'layers'])
const nodeRows = rows({ id: string, label: string, role: string }, ['id', 'label'])
const edgeRows = rows({ from: string, to: string, label: string, source: integer })
const groupRows = rows({ id: string, label: string, nodes: strings })
const chapterRows = rows({ title: string, module: string, handoff: integer, sources: sourceRows })

export function createOutlineSubmissions({ repository, evidence, signal, diagnostic }) {
  const draft = {}
  const errors = new Map()

  function invalidate(...parts) {
    for (const part of parts) {
      if (draft[part]) diagnostic({ phase: part, status: 'invalidated' })
      delete draft[part]
      errors.delete(part)
    }
  }

  function submit(part, write) {
    return (input, callSignal) => {
      signal?.throwIfAborted()
      callSignal?.throwIfAborted()
      try {
        const receipt = write(input)
        errors.delete(part)
        diagnostic({ phase: part, status: 'accepted' })
        return { accepted: true, ...receipt }
      } catch (error) {
        if (error?.code !== 'wiki-outline-invalid') throw error
        errors.set(part, error.message)
        diagnostic({ phase: part, status: 'rejected' })
        return { accepted: false, error: error.message }
      }
    }
  }

  function submitOverview(input) {
    const overview = readOverview(input, evidence)
    if (draft.overview && !isDeepStrictEqual(draft.overview.sources, overview.sources)) {
      invalidate('architecture', 'moduleMap', 'outline')
      draft.overview = overview
      return { sourceCount: overview.sources.length, message: '总览源码位置已经更新。请按当前序号重新提交两张图与 RQ 目录。' }
    }
    draft.overview = overview
    return { sourceCount: overview.sources.length }
  }

  function overviewSources() {
    if (!draft.overview) throw invalidOutline('请先调用 wiki_submit_overview 提交通过校验的总览和源码位置。')
    return draft.overview.sources
  }

  function submitArchitecture(input) {
    const sources = overviewSources()
    draft.architecture = renderArchitectureDiagram(input, sources, repository,
      message => invalidOutline('总览逻辑架构图。' + message))
  }

  function submitModuleMap(input) {
    const moduleMap = readModuleMap(input, overviewSources(), repository)
    const { graph } = moduleMap
    const previous = draft.moduleMap?.graph
    const revised = previous && (!isDeepStrictEqual(previous.nodes, graph.nodes) || !isDeepStrictEqual(previous.edges, graph.edges))
    if (revised) invalidate('outline')
    draft.moduleMap = moduleMap
    return {
      modules: graph.nodes.filter(({ role }) => internalRoles.has(role)).map(({ id, label }) => ({ id, label })),
      handoffs: graph.edges.map(({ from, to, label }, index) => ({ index: index + 1, from, to, label })),
      ...(revised && { message: '模块交接关系已经更新。请按当前模块 ID 和交接序号重新提交 RQ 目录。' }),
    }
  }

  function submitOutline(input) {
    if (!draft.moduleMap) throw invalidOutline('请先调用 wiki_submit_module_map 提交通过校验的模块交接图。')
    draft.outline = readOutline(input, draft.moduleMap.graph, evidence)
    return { chapterCount: draft.outline.length }
  }

  return {
    tools: [
      tool(sections.overview.tool,
        '提交中文总览正文、单行主线和本次已读源码。markdown 用【1】引用 sources 的第 1 项，并包含两张图的独立图位。',
        { mainline: string, markdown: string, sources: sourceRows }, ['mainline', 'markdown', 'sources'], submit('overview', submitOverview)),
      tool(sections.architecture.tool,
        '提交分层逻辑架构图。groups 写同层并列能力。sharedGroups 选填源码支持的跨层共享能力，每组列出至少两个使用它的层 ID。相邻层之间有需要说明的关系时填 relations。source 引用总览 sources 的整数序号。',
        { title: string, layers: layerRows, sharedGroups: sharedGroupRows, relations: edgeRows },
        ['title', 'layers'], submit('architecture', submitArchitecture)),
      tool(sections.moduleMap.tool,
        '提交源码模块交接图并取得可用于 RQ 的模块 ID 和交接序号。每条边的 source 为总览 sources 的整数序号。',
        { kind: { type: 'string', enum: ['component', 'dependency'] }, title: string, nodes: nodeRows, edges: edgeRows, groups: groupRows },
        ['kind', 'title', 'nodes', 'edges'], submit('moduleMap', submitModuleMap)),
      tool(sections.outline.tool,
        '提交 RQ 目录。每章关联已接受图中的一个内部模块和与其相连的交接序号，并保留已读源码位置。',
        { chapters: chapterRows }, ['chapters'], submit('outline', submitOutline)),
    ],
    get missing() {
      return Object.keys(sections).filter(part => !draft[part]).map(part => ({ ...sections[part], error: errors.get(part) }))
    },
    get result() {
      const { overview, architecture, moduleMap, outline } = draft
      if (!overview || !architecture || !moduleMap || !outline) return null
      const { mainline, markdown, sources } = overview
      const diagrams = [{ ...architecture, slot: 1 }, { ...moduleMap.diagram, slot: 2 }]
      return { commit: repository.commit, mainline, chapters: outline, overview: { markdown, sources, diagrams } }
    },
  }
}
