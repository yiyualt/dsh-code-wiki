# DSH 代码百科

在 DeepSeek Harness Web 侧栏打开「代码百科」，选择公开 GitHub 仓库或本地 Git 仓库。点击「生成文档」后，`repo-design-wiki` Skill 使用 DSH 当前模型，根据所选仓库已提交的源码拟定一句主线，再按关键模块交接生成目录。本阶段展示主线和章名，正文和图留空。

## 本地安装

使用 Node.js 22 或更高版本，在仓库目录运行下面的命令。安装包需保留在指定路径，供 DSH profile 加载。

```sh
npm run check
npm pack --pack-destination ~/.dsh/plugin-packages
dsh plugin --profile web add ~/.dsh/plugin-packages/dsh-code-wiki-0.23.0.tgz
```

所选仓库的源码片段会交给当前模型用于拟定目录。Skill 的组织原则见 `skills/repo-design-wiki/SKILL.md`。
