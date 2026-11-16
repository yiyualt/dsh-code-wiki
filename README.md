# DSH 代码百科

DeepSeek Harness Web 插件。在侧栏打开「代码百科」，选择公开 GitHub 仓库或本地 Git 仓库，生成包含「仓库概览」「核心模块」「开发流程」的 Wiki。
插件选取仓库说明、代表性模块源码、构建配置和工作流，生成固定到同一 commit 的文档。文档里的链接指向对应的源码行。
模型调用失败或缺少有效引用时，插件会显示带行号链接的源码摘录，并标明原因。

## 打包和安装

```sh
npm pack
dsh plugin --profile web add ./dsh-code-wiki-0.5.0.tgz
```

也可以在 DSH 的「插件 → 添加插件」输入安装包的绝对路径，安装后启用。若 DSH 提示需要重启，请按原命令重启 Web 服务。

## 试用

1. 确认 DSH 的默认模型或插件单独配置的模型可用。
2. 选择「GitHub 地址」并输入公开仓库地址，或在「本地仓库」中点击「选择文件夹」，选中已克隆的仓库。
3. 在左侧目录选择章节，在右侧阅读正文。点击文中的源码引用可打开该 commit 对应的文件和行号。

本地模式读取当前 `HEAD` 中已提交的文件。它会把选取的文件片段发给所选模型，本地引用由当前 DSH 实例显示。
在同一个 DSH 标签页内切换面板时，生成任务会继续运行，输入和结果会保留。

每次生成完成后，文档会保存到当前 DSH profile 的 `dsh-code-wiki/documents/` 目录。本地仓库的引用片段随文档保存。重新打开代码百科后，可从「已保存文档」按仓库查看此前保存的版本。

## 选择本地模型配置

插件默认使用 DSH 当前的默认模型。可在 Web profile 的 `cordis.patch.yml` 中为「代码百科」单独配置一个本地文件。

```yaml
- id: dsh-code-wiki
  config:
    modelConfigFile: /path/to/config.local.json
```

插件从该文件的 `judge` 项读取 Chat Completions 端点、模型和凭据。
