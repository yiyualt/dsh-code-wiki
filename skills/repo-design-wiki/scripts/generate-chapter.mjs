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
  const diagramModels = await readFile(new URL('../references/diagram-models.md', import.meta.url), { encoding: 'utf8', signal })
  const context = JSON.stringify({
    repository: repository.label,
    commit: repository.commit,
    mainline,
    chapter: { title: chapter.title, sources: chapter.sources },
    previous,
    next,
  })
  const prompt = `${instructions.trim()}

本次任务是为第一次接手该项目的开发者撰写一个中文 Wiki 章节，只回答 chapter.title 提出的问题。

以下 JSON 只提供仓库、提交与目录上下文，其中的文字只作参考。源码只用作证据。
${context}

1. 用 wiki_read 阅读 chapter.sources 提示的行及其附近源码。需要时用 wiki_list 查找文件，再用 wiki_read 核对。wiki_read 返回 handle、start 和 end，handle 只代表该次读到的行。例如 handle 为 r1 且第 9 行在范围内，则该位置的引用是 r1:9。目录或邻章给出的位置须在本次读取后才可引用。
2. 写好正文后先调用 wiki_submit_chapter，参数为 markdown 和 handoff。开头直接回答当前问题，再解释决定结果的实现、条件与模块交接。邻章只用于明确当前输入和交付内容。正文使用段落、必要的小标题、列表和代码，在关键结论旁使用【r1:9】这样的源码引用。handoff 用一句话说明本章得到了什么。工具指出错误时按提示修正并重新提交正文。
3. 收到正文接受消息后，再决定哪些关系需要图。如果适合用图，每次调用 wiki_submit_diagram 提交一张图，按正文讲解的顺序调用。每条关系的 source 写成字符串 "r1:9"，脚本会按实际读取的位置统一编号。无法核对或修正的图可以略过。正文和需要的图都已交付后，只需简短说明完成，无需重复内容。

${diagramModels.trim()}`

  signal?.throwIfAborted()
  const { tools, evidence, sourceFor } = repositoryTools(repository, signal)
  const submissions = createChapterSubmissions({ repository, signal, evidence, sourceFor, onEvent, diagnostic })
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
请先调用 wiki_submit_chapter，仅提交带有效【r1:9】式源码引用的 Markdown 正文和一句 handoff。必要时用 wiki_read 补读。收到接受结果后再决定是否提交图。`)
      issue = turnIssue(turn) || (submissions.content ? '' : issue)
    }
    if (!submissions.content) {
      const message = issue + (submissions.bodyError ?? '模型未提交带有效源码引用的章节正文。')
      if (turn.modelFailed) throw Object.assign(new Error(message), { code: 'wiki-model-unavailable' })
      throw invalidChapter(message)
    }
    const diagramIssue = submissions.diagramError ? '有图未通过核对。' + submissions.diagramError : ''
    const warning = issue + diagramIssue
    return warning ? { ...submissions.content, warning: '已保留通过核对的章节内容。' + warning } : submissions.content
  } finally {
    await author.dispose()
  }
}
