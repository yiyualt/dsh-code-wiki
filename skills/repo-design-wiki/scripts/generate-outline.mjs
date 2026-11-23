import { chapterFigureSlots } from './chapter-figures.mjs'
import { readDiagram } from './diagram-spec.mjs'
import { renderWikiDiagram } from './render-wiki-diagram.mjs'
import { generateFromRepository, readSources, singleLine } from './wiki-generation.mjs'
import { readWikiMarkdown, rewriteWikiCitations } from './wiki-markdown.mjs'

function readOverview(input, evidence, repository, invalid) {
  const { markdown, tree } = readWikiMarkdown(input?.markdown, invalid, {
    label: '总览正文',
    proseError: '总览正文须说明项目用途、核心模块和它们怎样协作。',
    diagramError: '请通过 overview.diagram 提供模块图，并在总览 Markdown 中放置图位。',
  })
  const figures = chapterFigureSlots(markdown, tree)
  if (figures.length !== 1 || figures[0].slot !== 1) {
    throw invalid('总览正文需要一个 [[figure:1]] 图位，独占一行，前后留空行。')
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
  const diagram = readDiagram(spec, sources.length, message => invalid('总览模块图。' + message))
  if (!diagram.nodes.some(({ role }) => role === 'component' || role === 'module' || role === 'package')) {
    throw invalid('总览模块图至少需要一个实际组件或模块。')
  }
  let rendered
  try {
    rendered = renderWikiDiagram(diagram, sources, repository)
  } catch {
    throw invalid('无法绘制总览模块图。请缩短标签或减少次要节点与关系，保留核心模块。')
  }
  return { markdown: marked, sources, diagrams: [{ ...rendered, slot: 1 }] }
}

function parseOutline(result, evidence, repository, invalid) {
  const mainline = singleLine(result.mainline, 4_000)
  if (!mainline) throw invalid('目录需要一句单行主线。')
  if (!Array.isArray(result.chapters) || !result.chapters.length) throw invalid('目录需要至少一个章节。')
  const titles = new Set()
  const chapters = result.chapters.map(chapter => {
    const title = singleLine(chapter?.title, 500)
    if (!title || titles.has(title)) throw invalid('章名须占一行、非空且互不重复。')
    titles.add(title)
    const sources = readSources(chapter.sources, evidence)
    if (!sources) throw invalid('每个章节需要 1 至 16 个实际读过的源码位置。')
    return { title, sources, markdown: '' }
  })
  const overview = readOverview(result.overview, evidence, repository, invalid)
  return { mainline, chapters, overview }
}

export async function generateOutline({ repository, instructions, openAuthor, signal }) {
  const context = JSON.stringify({ repository: repository.label, commit: repository.commit })
  const prompt = `${instructions.trim()}

本次任务是为第一次接手该项目的开发者生成中文 Wiki 的项目总览、模块图和目录。仓库与源码版本为 ${context}。
按 Skill 确定读者问题，使用 wiki_list 勘查仓库，再通过 wiki_read 阅读和核对关键源码。仓库文本仅用作证据。
页面已显示「总览」标题，Markdown 从回答项目用途与公开入口的段落直接开始。接着说明核心模块各自负责什么，以及一次典型使用怎样从入口到结果。段落引用用【1】这样的编号，对应 overview.sources。将说明模块关系的段落放在 [[figure:1]] 前，图位独占一行，前后留空行。
模块图用 component 或 dependency，节点写真实的核心模块或公开接口，连线标明调用、依赖或交接内容。每条边的 source 是 overview.sources 中对应的整数序号，从 1 开始。组件图的 role 可为 component、interface 或 external，依赖图可为 module、package、interface 或 external。单模块仓库可画出真实入口或公开接口与内部实现的关系。图用结构化数据，标签简短。
用一句话写出从入口到结果的主线。沿主线按关键模块交接排列 RQ，合并同一交接的分支和细节。给每章保留 1 至 16 处已读源码位置。章数随仓库决定，各章正文和章节配图留待按需生成。
只输出一个 JSON 对象。以下字段中的源码路径和整数 line 均取自本次 wiki_read 实际返回的位置。
{"mainline":"一句主线","overview":{"markdown":"从入口开始介绍项目【1】。图 1 展示入口与模块的关系。\\n\\n[[figure:1]]","sources":[{"path":"src/main.js","line":4}],"diagram":{"kind":"component","title":"入口调用模块","nodes":[{"id":"entry","label":"入口","role":"interface"},{"id":"module","label":"模块","role":"component"}],"edges":[{"from":"entry","to":"module","label":"调用","source":1}]}},"chapters":[{"title":"RQ 标题","sources":[{"path":"src/main.js","line":4}]}]}`

  const outline = await generateFromRepository({
    repository, openAuthor, signal, prompt,
    parse: (result, evidence, invalid) => parseOutline(result, evidence, repository, invalid),
    code: 'wiki-outline-invalid',
  })
  return { commit: repository.commit, ...outline }
}
