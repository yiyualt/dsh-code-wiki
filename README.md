# DSH 代码百科

DeepSeek Harness Web 插件。在侧栏打开「代码百科」，选择公开 GitHub 仓库或本地 Git 仓库，生成「项目基础设施与开发流程」。
插件选取仓库内的构建、测试与工作流文件片段，生成固定到同一 commit 的文档。文档里的链接指向对应的源码行。
模型调用失败或缺少有效引用时，插件会显示带行号链接的源码摘录，并标明原因。

## 打包和安装

```sh
npm pack
dsh plugin --profile web add ./dsh-code-wiki-0.3.0.tgz
```

也可以在 DSH 的「插件 → 添加插件」输入安装包的绝对路径，安装后启用。若 DSH 提示需要重启，请按原命令重启 Web 服务。

## 试用

1. 确认 DSH 的默认模型或插件单独配置的模型可用。
2. 选择「GitHub」，输入 `https://github.com/openai/codex`。也可以选「本地 Git 仓库」，输入你已克隆的仓库绝对路径。
3. 点击文中各条源码引用，查看该 commit 对应的文件和行号。

本地模式读取当前 `HEAD` 中已提交的文件。它会把选取的文件片段发给所选模型，本地引用由当前 DSH 实例显示。

## 选择本地模型配置

插件默认使用 DSH 当前的默认模型。可在 Web profile 的 `cordis.patch.yml` 中为「代码百科」单独配置一个本地文件。

```yaml
- id: dsh-code-wiki
  config:
    modelConfigFile: /path/to/config.local.json
```

插件从该文件的 `judge` 项读取 Chat Completions 端点、模型和凭据。

## 修改示例

编辑 [src/example.md](src/example.md)，然后运行 `npm pack`。打包时会把 Markdown 编入浏览器入口，由 DSH 的 Markdown 组件渲染。
