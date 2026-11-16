# DSH 代码百科

DeepSeek Harness Web 插件。在侧栏打开「代码百科」，阅读内置的 Markdown 示例。

## 打包和安装

```sh
npm pack
dsh plugin --profile web add ./dsh-code-wiki-0.1.0.tgz
```

也可以在 DSH 的「插件 → 添加插件」输入安装包的绝对路径，安装后启用。若 DSH 提示需要重启，请按原命令重启 Web 服务。

## 修改示例

编辑 [src/example.md](src/example.md)，然后运行 `npm pack`。打包时会把 Markdown 编入浏览器入口，由 DSH 的 Markdown 组件渲染。
