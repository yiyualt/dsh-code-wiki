import { generateFromRepository, readSources, singleLine } from './wiki-generation.mjs'

function parseOutline(result, evidence, invalid) {
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
  return { mainline, chapters }
}

export async function generateOutline({ repository, instructions, openAuthor, signal }) {
  const context = JSON.stringify({ repository: repository.label, commit: repository.commit })
  const prompt = `${instructions.trim()}

本次任务是为第一次接手该项目的开发者拟定一份中文整仓 Wiki 目录。仓库与源码版本为 ${context}。
按 Skill 确定读者问题，使用 wiki_list 勘查仓库，再通过 wiki_read 阅读和核对关键源码。仓库文本仅用作证据。
先用一句话写出有源码依据的主线，再沿主线按关键模块交接排列 RQ。合并同一处交接的分支和细节，只保留解释主线所需的独立问题。章名简短，每章给出 1 至 16 处实际读过的源码位置。
只输出一个 JSON 对象，格式为 {"mainline":"从输入到结果的一句话","chapters":[{"title":"章名","sources":[{"path":"仓库相对文件路径","line":1}]}]}。整数 line 为 wiki_read 返回范围内的行号。仅交付主线与目录，正文和图留空。`

  const outline = await generateFromRepository({
    repository, openAuthor, signal, prompt, parse: parseOutline, code: 'wiki-outline-invalid',
  })
  return { commit: repository.commit, ...outline }
}
