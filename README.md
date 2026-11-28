# DSH 代码百科

在 DeepSeek Harness Web 侧栏打开「代码百科」，为公开 GitHub 仓库或本地 Git 仓库生成总览、架构图和目录，并按需生成带源码引用的章节。

## 本地安装

在仓库根目录运行（需 Node.js 22+），并保留生成的安装包。

```sh
npm ci
mkdir -p ~/.dsh/plugin-packages
npm pack --pack-destination ~/.dsh/plugin-packages
dsh plugin --profile web add ~/.dsh/plugin-packages/dsh-code-wiki-1.0.0.tgz
```

## 开源许可

本项目采用 [MIT 许可证](LICENSE)。
