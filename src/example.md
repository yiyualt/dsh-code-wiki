# 仓库阅读示例

这篇文档演示如何从仓库概览定位到开发流程相关的源码。

## 先看哪些文件

1. 阅读 **README**，了解项目用途和启动方式。
2. 查看依赖清单，找到构建和测试命令。
3. 打开 `.github/workflows/`，核对持续集成的触发条件和执行步骤。

## 查看最近的提交

```sh
git log -5 --oneline
```

可以用 [OpenAI Codex 仓库](https://github.com/openai/codex) 练习这些步骤。
