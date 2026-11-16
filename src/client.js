window.__ModuleLoader__.load({
  id: 'dsh-code-wiki',
  factory(require) {
    const { createElement: h, useEffect, useId, useRef, useState } = require('react')
    const { Button, IconCodeOutlineRegular, Input, MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')
    const panelId = 'dsh-code-wiki'
    const panelTitle = '代码百科'
    const example = '__EXAMPLE_MARKDOWN__'
    const exampleRepository = 'https://github.com/openai/codex'
    const generationError = '生成失败，请稍后重试。'
    const labels = {
      code: { copyLabel: '复制', copiedLabel: '已复制' },
      footnotes: '脚注',
    }

    function resolveLocalReferences(markdown) {
      const reference = /\]\(https:\/\/dsh-code-wiki\.invalid\/source(\?key=[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}&file=\d+&start=\d+&end=\d+)\)/gi
      return markdown.replace(reference, (_, search) => {
        const url = new URL('api/dsh-code-wiki/source', document.baseURI)
        url.search = search
        return '](' + url.href + ')'
      })
    }

    function CodeWikiIcon({ size }) {
      return h(IconCodeOutlineRegular, { size })
    }

    function CodeWikiPage() {
      const [source, setSource] = useState('github')
      const [repositoryUrl, setRepositoryUrl] = useState(exampleRepository)
      const [repositoryPath, setRepositoryPath] = useState('')
      const [result, setResult] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)
      const activeRequest = useRef(null)
      const sourceId = useId()
      const localNoteId = useId()
      const local = source === 'local'
      const input = local ? repositoryPath : repositoryUrl

      function changeSource(event) {
        setSource(event.target.value)
        setResult(null)
        setError('')
      }

      useEffect(() => () => {
        activeRequest.current?.abort()
        activeRequest.current = null
      }, [])

      async function generate(event) {
        event.preventDefault()
        const location = input.trim()
        if (!location || activeRequest.current) return
        const request = local ? { repositoryPath: location } : { repositoryUrl: location }

        const controller = new AbortController()
        activeRequest.current = controller
        setResult(null)
        setError('')
        setLoading(true)

        try {
          const response = await fetch(new URL('api/dsh-code-wiki/generate', document.baseURI), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
            signal: controller.signal,
          })
          const data = await response.json().catch(() => null)
          if (controller.signal.aborted) return

          if (!response.ok) {
            setError(typeof data?.error === 'string' && data.error ? data.error : generationError)
            return
          }
          const validSource = local
            ? typeof data?.repositoryPath === 'string' && Boolean(data.repositoryPath)
            : typeof data?.repoUrl === 'string' && /^https:\/\/github\.com\/[a-z\d-]+\/[\w.-]+$/i.test(data.repoUrl)
          if (!validSource || typeof data.markdown !== 'string' || !data.markdown.trim()
            || typeof data.commit !== 'string' || !/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(data.commit)) {
            setError(generationError)
            return
          }
          setResult({ ...data, markdown: local ? resolveLocalReferences(data.markdown) : data.markdown })
        } catch {
          if (!controller.signal.aborted) setError(generationError)
        } finally {
          if (activeRequest.current === controller) {
            activeRequest.current = null
            setLoading(false)
          }
        }
      }

      return h('section', {
        'aria-label': panelTitle,
        style: { flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' },
      }, h('article', {
        style: {
          boxSizing: 'border-box',
          marginInline: 'auto',
          maxWidth: 800,
          padding: 'clamp(20px, 5vw, 56px)',
        },
      },
      h('form', {
        onSubmit: generate,
        style: { display: 'flex', alignItems: 'end', flexWrap: 'wrap', gap: 8 },
      },
      h('fieldset', {
        disabled: loading,
        style: { border: 0, padding: 0, margin: '0 0 4px', flexBasis: '100%' },
      },
      h('legend', null, '仓库来源'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginBlockStart: 4 } },
        ...[['github', 'GitHub 地址'], ['local', '本地仓库']].map(([value, label]) =>
          h('label', { key: value, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('input', { type: 'radio', name: sourceId, value, checked: source === value, onChange: changeSource }),
            label,
          ),
        ),
      )),
      h('label', {
        style: { display: 'grid', gap: 6, flex: '1 1 240px', minWidth: 0 },
      },
      local ? '本地 Git 仓库绝对路径' : '公开 GitHub 仓库地址',
      h(Input, {
        type: local ? 'text' : 'url',
        name: local ? 'repositoryPath' : 'repositoryUrl',
        value: input,
        onChange: event => (local ? setRepositoryPath : setRepositoryUrl)(event.target.value),
        placeholder: local ? '/Users/yourname/projects/my-repo' : undefined,
        'aria-describedby': local ? localNoteId : undefined,
        required: true,
        disabled: loading,
        autoComplete: 'off',
        spellCheck: false,
      })),
      h(Button, { type: 'submit', variant: 'primary', disabled: loading }, '生成文档'),
      local && h('p', {
        id: localNoteId,
        style: { flexBasis: '100%', margin: 0, color: 'var(--dsw-alias-label-secondary)' },
      }, '只读取当前 HEAD 提交中的 Git 跟踪文件。选中的源码片段会发送给已配置的模型。')),
      h('div', { role: 'status', style: { marginBlock: '12px 24px' } },
        loading && '正在读取仓库并生成文档…',
        result && local && h('span', null,
          typeof result.repoName === 'string' && result.repoName ? result.repoName : result.repositoryPath,
          ' · 固定提交 ', h('code', { title: result.commit }, result.commit.slice(0, 12))),
        result && !local && h('a', {
          href: `${result.repoUrl}/commit/${result.commit}`,
          target: '_blank',
          rel: 'noreferrer',
          title: result.commit,
        }, result.repoUrl.slice('https://github.com/'.length), ' · 固定提交 ', h('code', null, result.commit.slice(0, 12))),
        !loading && typeof result?.model === 'string' && ' · ' + result.model,
        !loading && typeof result?.note === 'string' && h('p', { style: { marginBlock: '8px 0' } }, result.note),
      ),
      error && h('p', {
        role: 'alert',
        style: { color: 'var(--dsw-alias-label-error)', marginBlockEnd: 16 },
      }, error),
      !loading && !error && h(MarkdownText, { text: result?.markdown ?? example, labels, omitHtml: true })))
    }

    return {
      name: panelId,
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: panelId,
        }, CodeWikiPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: panelId,
          label: panelTitle,
          order: 10,
        }, CodeWikiIcon))
      },
    }
  },
})
