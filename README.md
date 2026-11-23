# DSH 代码百科

在 DeepSeek Harness Web 侧栏打开「代码百科」，选择 GitHub 地址或本地仓库文件夹。提交后可浏览 `repo-design-wiki` Skill 提供的六个固定示例章节。

## 本地安装

使用 Node.js 22 或更高版本，在仓库目录运行下面的命令。安装包需保留在指定路径，供 DSH profile 加载。

```sh
npm run check
npm pack --pack-destination ~/.dsh/plugin-packages
dsh plugin --profile web add ~/.dsh/plugin-packages/dsh-code-wiki-0.22.0.tgz
```

插件启用后可在侧栏打开。示例 Markdown 位于 `skills/repo-design-wiki/references/preview.md`，插件在打开示例文档时从 DSH 已注册的 Skill 读取该文件。
