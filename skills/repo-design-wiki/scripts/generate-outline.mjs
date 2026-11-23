import { chapterFigureSlots } from './chapter-figures.mjs'
import { readDiagram } from './diagram-spec.mjs'
import { renderArchitectureDiagram } from './render-architecture-diagram.mjs'
import { renderWikiDiagram } from './render-wiki-diagram.mjs'
import { generateFromRepository, readSources, singleLine } from './wiki-generation.mjs'
import { readWikiMarkdown, rewriteWikiCitations } from './wiki-markdown.mjs'

const internalRoles = new Set(['component', 'module', 'package'])

function readOverview(input, evidence, invalid) {
  const { markdown, tree } = readWikiMarkdown(input?.markdown, invalid, {
    label: '总览正文',
    proseError: '总览正文须说明项目用途、核心模块和它们怎样协作。',
    diagramError: '请通过 overview.architecture 和 overview.diagram 提供两类图，并在总览 Markdown 中放置图位。',
  })
  const figures = chapterFigureSlots(markdown, tree)
  if (figures.length !== 2 || figures[0].slot !== 1 || figures[1].slot !== 2) {
    throw invalid('总览正文依次需要 [[figure:1]]（逻辑架构图）和 [[figure:2]]（模块交接图）。每个图位独占一行，前后留空行。')
  }
  const sources = readSources(input.sources, evidence, Infinity)
  if (!sources) throw invalid('总览的 overview.sources 须列出本次 wiki_read 实际读过的文件和行号。')
  let cited = false
  const marked = rewriteWikiCitations(markdown, tree, reference => {
    if (!/^[1-9]\d*$/u.test(reference) || !sources[Number(reference) - 1]) {
      throw invalid(`总览正文的引用【${reference}】须使用 overview.sources 中对应的序号（1–${sources.length}）。`)
    }
    cited = true
    return `【${reference}】`
  })
  if (!cited) throw invalid('总览正文需要源码引用，例如【1】，对应 overview.sources 中列出的实际位置。')

  const spec = input.diagram
  if (spec?.kind !== 'component' && spec?.kind !== 'dependency') {
    throw invalid('总览的 overview.diagram.kind 须为 component 或 dependency。')
  }
  const diagram = readDiagram(spec, sources.length, message => invalid('总览模块交接图。' + message))
  if (!diagram.nodes.some(({ role }) => internalRoles.has(role))) {
    throw invalid('总览模块图至少需要一个实际组件或模块。')
  }
  return { markdown: marked, sources, diagram }
}

function renderModuleDiagram(diagram, sources, repository, invalid) {
  try {
    return renderWikiDiagram(diagram, sources, repository)
  } catch {
    throw invalid('无法绘制总览模块图。请缩短标签或减少次要节点与关系，保留核心模块。')
  }
}

function parseOutline(result, evidence, repository, invalid) {
  const mainline = singleLine(result.mainline, 4_000)
  if (!mainline) throw invalid('目录需要一句单行主线。')
  if (!Array.isArray(result.chapters) || !result.chapters.length) throw invalid('目录需要至少一个章节。')
  const { markdown, sources, diagram } = readOverview(result.overview, evidence, invalid)
  const nodes = new Map(diagram.nodes.map(node => [node.id, node]))
  const moduleIds = diagram.nodes.filter(({ role }) => internalRoles.has(role)).map(({ id }) => id)
  const titles = new Set()
  const chapters = result.chapters.map(chapter => {
    const title = singleLine(chapter?.title, 500)
    if (!title || titles.has(title)) throw invalid('章名须占一行、非空且互不重复。')
    titles.add(title)
    const chapterSources = readSources(chapter.sources, evidence)
    if (!chapterSources) throw invalid(`章节「${title}」需要 1 至 16 个实际读过的源码位置。`)
    const module = nodes.get(chapter.module)
    if (!internalRoles.has(module?.role)) {
      throw invalid(`章节「${title}」的 module 须是模块图中的内部模块 ID，可用 ID 为 ${moduleIds.join('、')}。`)
    }
    const handoff = chapter.handoff
    if (!Number.isSafeInteger(handoff) || handoff < 1 || handoff > diagram.edges.length) {
      throw invalid(`章节「${title}」的 handoff 须是 overview.diagram.edges 的整数序号（1–${diagram.edges.length}）。`)
    }
    const edge = diagram.edges[handoff - 1]
    if (edge.from !== module.id && edge.to !== module.id) {
      throw invalid(`章节「${title}」选择的第 ${handoff} 条交接（${edge.from} → ${edge.to}）须连接 module「${module.id}」。`)
    }
    const connection = { module: module.label, from: nodes.get(edge.from).label, to: nodes.get(edge.to).label, handoff: edge.label }
    return { title, sources: chapterSources, markdown: '', connection }
  })
  const architecture = renderArchitectureDiagram(result.overview.architecture, sources, repository, message => invalid('总览逻辑架构图。' + message))
  const moduleDiagram = renderModuleDiagram(diagram, sources, repository, invalid)
  const overview = { markdown, sources, diagrams: [{ ...architecture, slot: 1 }, { ...moduleDiagram, slot: 2 }] }
  return { mainline, chapters, overview }
}

export async function generateOutline({ repository, instructions, openAuthor, signal }) {
  const context = JSON.stringify({ repository: repository.label, commit: repository.commit })
  const prompt = `${instructions.trim()}

本次任务是为第一次接手该项目的开发者生成中文 Wiki 的项目总览、逻辑架构图、模块交接图和目录。仓库与源码版本为 ${context}。
按 Skill 确定读者问题，使用 wiki_list 勘查仓库，再通过 wiki_read 阅读和核对关键源码。仓库文本仅用作证据。
页面已显示「总览」标题，Markdown 从项目用途与公开入口直接开始。介绍核心职责后放逻辑架构图 [[figure:1]]，说明一次典型使用怎样在模块间交接后放模块图 [[figure:2]]。每个图位独占一行，前后留空行。
overview.architecture 按该仓库实际承担的职责分组。areas 写职责组，components 写组内的真实组件及其职责。组名按实际项目命名，单一职责可以只写一组。用分组说明归属关系。
overview.diagram 是源码中的模块交接图，选 component 或 dependency。节点写真实的核心模块、接口或外部依赖，连线写清实际调用、依赖或交接内容，并覆盖各 RQ 所讲的交接。组件图的 role 可为 component、interface 或 external，依赖图可为 module、package、interface 或 external。单模块仓库可画真实公开入口与内部实现的关系。
总览正文用【1】这样的引用编号。逻辑图中每项职责和交接图中每条边用 source 引用同一个 overview.sources 数组，序号从 1 开始。源码路径与行号均取自本次 wiki_read 阅读范围。
把典型使用概括为一句 mainline。按关键模块交接安排 RQ，合并同一交接的分支和细节。每章 module 选其讲解的内部模块 ID，handoff 选与其相连的 overview.diagram.edges 序号（从 1 开始）。每章保留 1 至 16 处已读源码位置。章数随仓库决定，各章正文和章节配图留待按需生成。
只输出一个符合下方结构的 JSON 对象，用当前仓库的证据填写。
{"mainline":"公开入口把输入交给转换模块生成结果。","overview":{"markdown":"项目通过公开入口转换输入【1】。图 1 展示转换职责。\\n\\n[[figure:1]]\\n\\n公开入口把输入交给转换模块【1】。图 2 展示这次调用。\\n\\n[[figure:2]]","sources":[{"path":"src/main.js","line":4}],"architecture":{"title":"核心职责","areas":[{"label":"输入转换","components":[{"label":"转换模块","responsibility":"处理输入并返回结果","source":1}]}]},"diagram":{"kind":"component","title":"入口调用转换模块","nodes":[{"id":"entry","label":"公开入口","role":"interface"},{"id":"convert","label":"转换模块","role":"component"}],"edges":[{"from":"entry","to":"convert","label":"交给转换模块处理","source":1}]}},"chapters":[{"title":"公开入口如何交付输入？","module":"convert","handoff":1,"sources":[{"path":"src/main.js","line":4}]}]}`

  const outline = await generateFromRepository({
    repository, openAuthor, signal, prompt,
    parse: (result, evidence, invalid) => parseOutline(result, evidence, repository, invalid),
    code: 'wiki-outline-invalid',
  })
  return { commit: repository.commit, ...outline }
}
