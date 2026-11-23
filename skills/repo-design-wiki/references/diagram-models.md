# 代码百科选图规则

先看本章 RQ 要让读者看清什么，再选一张图。

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

## DSH 当前输出规则

当前格式用 `flow` 表示步骤和分支，用 `data` 表示数据传递和变化，用 `dependency` 表示静态关系，用 `state` 表示状态迁移。遇到生命线、实体关系基数或部署分组等专用结构时，正文交代关键信息，图呈现当前格式能准确表达的关系，标题和 `diagram.kind` 按实际画出的内容填写。
