# 代码百科选图规则

先用一张图展示决定本章答案的关系，再根据问题选图型。章节较短时，可以只画有源码依据的关键判断、调用或交接。有多个不同关系需要图示时，按正文讲解顺序分别画。

| 读者要看清什么 | 适合的图 |
| --- | --- |
| 系统由谁使用，和哪些外部系统交互 | [系统上下文图](https://c4model.com/diagrams/system-context) |
| 模块各管什么，静态依赖指向哪里 | [组件图](https://c4model.com/diagrams/component)或依赖图 |
| 一次操作中谁先调用谁，哪里等待、返回或回调 | [时序图](https://mermaid.js.org/syntax/sequenceDiagram.html) |
| 数据在哪里转换、保存，变成什么后交给谁 | [数据流图](https://support.microsoft.com/en-gb/visio/create-a-data-flow-diagram-in-visio) |
| 遇到不同条件走哪条路径，在哪里退出或重试 | [流程图](https://mermaid.js.org/syntax/flowchart.html) |
| 一个任务或对象有哪些状态，什么事件触发迁移 | [状态图](https://mermaid.js.org/syntax/stateDiagram.html) |
| 保存了哪些实体，它们如何关联 | [实体关系图](https://mermaid.js.org/syntax/entityRelationshipDiagram.html) |
| 服务、进程和存储分别运行在哪里 | [部署图](https://c4model.com/diagrams/deployment) |

图只画回答本章 RQ 所需的对象和关系，名称沿用正文。每条连线标明含义和方向，并引用本次读过的源码位置。相邻章节可以用同类图，各自解释不同的交接。

## 图形数据

每张图填写 `kind` 和 `title`，再按图型填写对应的结构。名称要简短。每个对象有唯一的 `id`，以 ASCII 字母开头，后续字符使用 ASCII 字母、数字、下划线或连字符。每条关系有 `from`、`to`、`label` 和源码引用 `source`。用本次 `wiki_read` 返回的标识和行号填入字符串，例如 `"r1:9"`，由脚本统一转换为读者可见的编号。

| 图型 | `kind` | 数据及含义 |
| --- | --- | --- |
| 系统上下文图 | `context` | `nodes: [{id,label,role}]`、`edges`。角色为 `actor`（使用者）、`system`（唯一目标系统）、`external`（外部系统）。边写清交互目的。 |
| 组件图或依赖图 | `component` 或 `dependency` | `nodes`、`edges`。组件图角色为 `component`、`interface`、`external`，可用 `groups: [{id,label,nodes:[节点 ID]}]` 标出实际模块边界。依赖图角色为 `module`、`package`、`interface`、`external`。 |
| 时序图 | `sequence` | `participants: [{id,label}]`、`messages: [{from,to,label,source,type}]`。消息按发生顺序排列，`type` 用 `call`（同步调用）、`return`（返回）、`async`（异步消息）。 |
| 数据流图 | `data` | `nodes`、`edges`。节点角色为 `producer`、`process`、`store`、`consumer`。关系写明传输或转换的数据。 |
| 流程图 | `flow` | `nodes`、`edges`。节点角色为 `start`、`action`、`decision`、`end`。判断节点的各条边标明条件。 |
| 状态图 | `state` | `nodes`、`edges`。节点角色为 `start`、`state`、`end`。边写出触发事件或守卫条件。 |
| 实体关系图 | `er` | `entities: [{id,label,fields:[{name,type,key}]}]`、`relations: [{from,to,label,source,fromCardinality,toCardinality}]`。字段只列相关项，`key` 用 `PK`、`FK`、`UK` 或空字符串。基数可用 `0..1`、`1`、`0..*`、`1..*`，证据不足时用 `?`。 |
| 部署图 | `deployment` | `nodes`、`edges`、`groups: [{id,label,nodes:[节点 ID]}]`。每个应用、进程或存储分别用 `app`、`process`、`store` 表示，并归入一个有证据的运行位置。 |

每张图保留 2 至 8 个相连的对象，关系最多 12 条，时序消息最多 16 条。实体的字段数组最多 8 项，图只讲关联时可以留空。关系名称和证据以所读源码及配置为准。
