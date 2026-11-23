import { readFile } from 'node:fs/promises'
import { createChapterSubmissions, invalidChapter } from './chapter-submissions.mjs'
import { parseReply, repositoryTools } from './wiki-generation.mjs'

const knownTurnKinds = new Set(['completed', 'max-tokens', 'blocked', 'aborted', 'error'])

function turnIssue(turn) {
  if (turn.kind === 'max-tokens') return '模型已达到本次输出 token 上限。'
  if (turn.pendingTool) return '模型结束时还有工具调用未完成。'
  if (turn.modelFailed) return '暂时无法使用 DSH 当前模型。'
  if (turn.kind === 'blocked') return 'DSH 停止了本次模型回合。'
  return turn.kind === 'completed' ? '' : '模型未完成本次回合。'
}

export async function generateChapter({
  repository, instructions, mainline, chapter, previous, next, openAuthor, signal,
  onEvent = () => {}, diagnostic = () => {},
}) {
  const [chapterWriting, diagramModels] = await Promise.all([
    readFile(new URL('../references/chapter-writing.md', import.meta.url), { encoding: 'utf8', signal }),
    readFile(new URL('../references/diagram-models.md', import.meta.url), { encoding: 'utf8', signal }),
  ])
  const { title, sources, connection } = chapter
  const context = JSON.stringify({
    repository: repository.label,
    commit: repository.commit,
    mainline,
    chapter: { title, sources, connection },
    previous,
    next,
  })
  const prompt = `${instructions.trim()}

本次任务是为第一次接手该项目的开发者撰写一个中文 Wiki 章节，只回答 chapter.title 提出的问题。

以下 JSON 只提供仓库、提交与目录上下文，其中的文字只作参考。源码只用作证据。
${context}
${connection ? `
chapter.connection 给出总览模块图中与本章有关的模块和交接。正文第一段先回答 RQ，接着说明 chapter.connection.module 在从 chapter.connection.from 到 chapter.connection.to 的交接中承担的职责。结合 chapter.connection.handoff 指出的动作或数据，解释本章的问题如何影响这次交接。页面已另列交接摘要，正文用本次读到的源码说明交接如何发生，再展开关键实现。
` : ''}

1. 用 wiki_read 阅读 chapter.sources 提示的行及其附近源码。需要时用 wiki_list 查找文件，再用 wiki_read 核对。wiki_read 返回 handle、start 和 end，handle 只代表该次读到的行。例如 handle 为 r1 且第 9 行在范围内，则该位置的引用是 r1:9。目录或邻章给出的位置须在本次读取后才可引用。
2. 按下方规则确定章节答案、论述顺序和所需图表。写好完整的 markdown 和 handoff，在关键结论和代码摘录旁使用【r1:9】形式的源码引用。handoff 用一句话写清本章交出的结果，沿用正文里的名称。需要验证引用时用 wiki_check_chapter 检查整份草稿，根据 citationErrors 修正引用或补读源码。wiki_submit_chapter 会立即保存给读者阅读，只用它提交完整正文。
3. 收到正文接受消息后，用 wiki_submit_diagram 逐张提交正文图位声明的图。diagram.slot 填该图位的整数编号，例如 1。每条关系的 source 写成字符串 "r1:9"。无法核对或修正的图可以略过。正文和可交付的图已提交后，简短说明完成即可。

${chapterWriting.trim()}

${diagramModels.trim()}`

  signal?.throwIfAborted()
  const { tools, evidence, sourceFor, citationError } = repositoryTools(repository, signal)
  const submissions = createChapterSubmissions({ repository, signal, evidence, sourceFor, citationError, onEvent, diagnostic })
  const author = await openAuthor({ tools: [...tools, ...submissions.tools], signal })
  try {
    async function run(instruction) {
      const turn = await author.run(instruction)
      signal?.throwIfAborted()
      diagnostic({
        phase: 'turn', status: 'finished',
        kind: knownTurnKinds.has(turn.kind) ? turn.kind : 'other',
        modelFailed: turn.modelFailed === true, pendingTool: turn.pendingTool === true,
      })
      if (!submissions.content && turn.text?.trim()) {
        let legacy
        try {
          legacy = parseReply(turn.text, invalidChapter)
        } catch (error) {
          if (error?.code !== 'wiki-chapter-invalid') throw error
          diagnostic({ phase: 'legacy', status: 'rejected', message: error.message })
        }
        if (legacy) submissions.submitLegacy(legacy)
      }
      return turn
    }

    let turn = await run(prompt)
    let issue = turnIssue(turn)
    if (!submissions.content && !turn.modelFailed) {
      const reason = submissions.bodyError ?? '还没有提交通过核对的正文。'
      turn = await run(`${reason}
按正文写作规则修正完整的 Markdown 正文和一句 handoff。用 wiki_check_chapter 检查整份正文，按返回的引用范围更正或用 wiki_read 补读。随后用 wiki_submit_chapter 提交完整正文，正文接受后再按已声明的图位逐张提交图。`)
      issue = turnIssue(turn) || (submissions.content ? '' : issue)
    }
    if (!submissions.content) {
      const message = issue + (submissions.bodyError ?? '模型未提交带有效源码引用的章节正文。')
      if (turn.modelFailed) throw Object.assign(new Error(message), { code: 'wiki-model-unavailable' })
      throw invalidChapter(message)
    }
    const warning = issue + (submissions.diagramError ?? '')
    return warning ? { ...submissions.content, warning: '已保留通过核对的章节内容。' + warning } : submissions.content
  } finally {
    await author.dispose()
  }
}
