import { createOutlineSubmissions, invalidOutline } from './outline-submissions.mjs'
import { repositoryTools } from './wiki-generation.mjs'

const knownTurnKinds = new Set(['completed', 'max-tokens', 'blocked', 'aborted', 'error'])

function turnIssue(turn) {
  if (turn.malformedResponse) return '模型有一次工具调用的参数格式无效。'
  if (turn.kind === 'max-tokens') return '模型用完了本轮输出额度。'
  if (turn.pendingTool) return '模型结束时还有工具调用未完成。'
  if (turn.kind === 'blocked') return 'DSH 停止了本次模型回合。'
  return turn.kind === 'completed' ? '' : '模型未完成本次回合。'
}

function modelUnavailable(turn) {
  return turn.modelFailed && !turn.malformedResponse
}

function repairPrompt(missing, turn) {
  const tasks = missing.map(({ tool, label, error }) => `- ${tool} 提交${label}。${error ?? ''}`)
  return `${turnIssue(turn)}已通过的部分已经保留。只需修正下面的部分。\n${tasks.join('\n')}\n需要时先用 wiki_read 补读。一次调用一个工具，看到接受结果后再提交下一项。`
}

export async function generateOutline({ repository, instructions, openAuthor, signal, diagnostic = () => {} }) {
  const context = JSON.stringify({ repository: repository.label, commit: repository.commit })
  const prompt = `${instructions.trim()}

本次任务是为第一次接手该项目的开发者生成中文 Wiki 的项目总览、逻辑架构图、模块交接图和 RQ 目录。仓库与源码版本为 ${context}。
按 Skill 确定读者问题，使用 wiki_list 勘查仓库，再用 wiki_read 核对关键源码。仓库文本仅用作证据。先规划正文、两张图和 RQ，确定所需源码位置，再按下方顺序逐项提交。一次调用一个提交工具，看到接受结果后再继续。工具拒绝时，根据反馈修正当前提交。

1. 用 wiki_submit_overview 提交 mainline、markdown 和 sources。页面已显示「总览」标题，Markdown 从项目用途与公开入口直接开始。介绍核心职责后放 [[figure:1]]，说明一次典型使用怎样在模块间交接后放 [[figure:2]]。图位各占一行，前后留空行。sources 收录正文和两张图所需的已读文件与行号。正文使用【1】等序号引用 sources。
2. 用 wiki_submit_architecture 提交逻辑架构图。
   - 根据实际职责划分并排列 layers。每层用唯一 id 和易懂的短名称，groups 表示该层横向并列的能力。提交前核对各层和共享栏，为每项能力及其内部功能只保留一处展示位置。主要由一个层承担的能力归到该层。简单项目可以只有一层。
   - 源码能证明一项独立服务确实由多个层复用时，把它放在 sharedGroups，主要显示能力短名称和实际使用它的层。每项的 layers 填至少两个不同的现有层 id，source 引用支撑共享关系的源码。components 只在需要区分组内不同职责时填写。共享栏根据仓库的实际情况选填。
   - relations 选填相邻层之间理解整体架构所必需的关系。from 和 to 使用相邻层的 id，label 用简短的动词短语标明动作，例如「写入事件」。调用条件、数据细节和处理原因在正文讲解。能力、组件和关系的 source 都使用总览 sources 中从 1 开始的整数序号。
   - 图中用准确、好读的能力名称。能帮助读者定位特定模块或接口时可使用简短的代码标识符，完整代码名称和职责说明写在总览正文与 RQ 中。
3. 用 wiki_submit_module_map 提交源码模块交接图，选 component 或 dependency。节点写真实的核心模块、接口或外部依赖，连线标明真实调用、依赖或交接，覆盖 RQ 要解释的关系。保留 2 至 8 个节点和 1 至 12 条关系，所有节点通过关系连通。组件图节点角色可用 component、interface 或 external，依赖图可用 module、package、interface 或 external。单模块仓库可画公开入口与内部实现之间的实际关系。每条边的 source 也使用总览 sources 中的整数序号。
4. 用 wiki_submit_outline 提交 RQ 目录。每章的 module 是交接图中角色为 component、module 或 package 的节点 ID，handoff 是与该节点相连的边序号。采用交接图工具返回的模块 ID 和序号。按主线组织问题，合并同一交接的分支和细节，每章保留 1 至 16 处已读源码位置。章数随仓库决定，各章正文和章节配图按需生成。

如果修改了已经接受的总览源码数组或模块交接关系，按工具提示重新提交受影响的部分。四项都已接受后结束即可。`

  signal?.throwIfAborted()
  const { tools, evidence } = repositoryTools(repository, signal)
  const submissions = createOutlineSubmissions({ repository, evidence, signal, diagnostic })
  const author = await openAuthor({ tools: [...tools, ...submissions.tools], signal })
  try {
    async function run(instruction) {
      const turn = await author.run(instruction)
      signal?.throwIfAborted()
      diagnostic({
        phase: 'turn', status: 'finished',
        kind: knownTurnKinds.has(turn.kind) ? turn.kind : 'other',
        modelFailed: turn.modelFailed === true, pendingTool: turn.pendingTool === true,
        malformedResponse: turn.malformedResponse === true,
      })
      return turn
    }

    let turn = await run(prompt)
    let missing = submissions.missing
    while (missing.length && !modelUnavailable(turn) && turn.kind !== 'blocked' && turn.kind !== 'aborted') {
      const previousCount = missing.length
      turn = await run(repairPrompt(missing, turn))
      missing = submissions.missing
      if (missing.length >= previousCount) break
    }
    const result = submissions.result
    if (result) return result
    if (modelUnavailable(turn)) {
      throw Object.assign(new Error('暂时无法使用 DSH 当前模型。'), { code: 'wiki-model-unavailable' })
    }
    const details = missing.map(({ label, error }) => error ? `${label}未通过校验。${error}` : `${label}尚未提交。`)
    throw invalidOutline(turnIssue(turn) + details.join(''))
  } finally {
    await author.dispose()
  }
}
