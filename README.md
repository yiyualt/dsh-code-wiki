# DSH 代码百科

在 DeepSeek Harness Web 侧栏打开「代码百科」，选择公开 GitHub 仓库或本地 Git 仓库。点击「生成文档」后，`repo-design-wiki` Skill 使用 DSH 当前模型，根据所选仓库已提交的源码拟定一句主线，再按关键模块交接生成目录。打开一个 RQ，点击「生成本章」可生成正文和源码引用，并按内容需要生成图。章节使用拟定目录时的 Git 提交。

## 本地安装

使用 Node.js 22 或更高版本，在仓库目录运行下面的命令。安装包需保留在指定路径，供 DSH profile 加载。

```sh
npm ci
npm run check
npm pack --pack-destination ~/.dsh/plugin-packages
dsh plugin --profile web add ~/.dsh/plugin-packages/dsh-code-wiki-0.28.0.tgz
```

所选仓库的源码片段会交给当前模型用于拟定目录和撰写正文。Skill 根据本章内容选图，并把图形数据绘成附源码引用的 SVG。插件负责在阅读页显示。Skill 的组织原则见 `skills/repo-design-wiki/SKILL.md`。

章节正文和每张图通过校验后会依次显示。正文和已完成的图会保留，页面显示尚未交付的内容遇到的问题。DSH 服务日志中的 `[dsh-code-wiki]` 记录请求编号、阶段和校验结果，便于定位失败。

文档库保存在当前 DSH profile 的 `dsh-code-wiki/documents/`。目录完成时创建文档，正文和图通过核对后逐步保存。刷新页面或重启 DSH 后，可以从文档库继续阅读已有结果，并生成未完成的章节。旧版归档在同一目录下可供阅读。
