# DSH 代码百科

在 DeepSeek Harness Web 侧栏打开「代码百科」，选择 GitHub 地址或本地仓库文件夹。提交后可浏览六个示例章节。

## 本地安装

使用 Node.js 22 或更高版本，在仓库目录运行下面的命令。安装包需保留在指定路径，供 DSH profile 加载。

```sh
npm run check
npm pack --pack-destination ~/.dsh/plugin-packages
dsh plugin --profile web add ~/.dsh/plugin-packages/dsh-code-wiki-0.21.0.tgz
```

重启 DSH Web 后，在侧栏打开插件。示例章节定义在 `src/mock-chapters.js`。
