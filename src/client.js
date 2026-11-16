window.__ModuleLoader__.load({
  id: 'dsh-code-wiki',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createElement: h, useId, useSyncExternalStore } = React
    const { Button, IconCodeOutlineRegular, Input, MarkdownText } = primitives
    const FolderBrowser = createCodeWikiFolderBrowser(React, primitives)
    const panelId = 'dsh-code-wiki'
    const panelTitle = '代码百科'
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

    function createWikiStore(workspace, pickDirectory) {
      let snapshot = {
        source: 'github',
        repositoryUrl: '',
        repositoryPath: '',
        result: null,
        error: '',
        loading: false,
        picking: false,
        browserOpen: false,
      }
      let activeRequest
      let disposed = false
      const listeners = new Set()

      function update(patch) {
        if (disposed) return
        snapshot = { ...snapshot, ...patch }
        for (const listener of listeners) listener()
      }

      function selectFolder(path) {
        const changed = path !== snapshot.repositoryPath
        update({ repositoryPath: path, browserOpen: false, error: '', ...(changed && { result: null }) })
      }

      async function chooseFolder() {
        if (disposed || snapshot.loading || snapshot.picking || snapshot.browserOpen) return
        update({ picking: true, error: '' })
        try {
          const result = await pickDirectory()
          if (result.ok) {
            if (result.value) selectFolder(result.value)
          } else if (result.error.code === 'directory-picker/unavailable') {
            update({ browserOpen: true })
          } else {
            update({ error: '无法打开文件夹选择器，请重试。' })
          }
        } catch {
          update({ error: '无法打开文件夹选择器，请重试。' })
        } finally {
          update({ picking: false })
        }
      }

      async function generate() {
        if (disposed || activeRequest || snapshot.picking || snapshot.browserOpen) return
        const local = snapshot.source === 'local'
        const location = local ? snapshot.repositoryPath : snapshot.repositoryUrl.trim()
        if (!location) return
        const request = local ? { repositoryPath: location } : { repositoryUrl: location }
        const controller = new AbortController()
        activeRequest = controller
        update({ result: null, error: '', loading: true })
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
            update({ error: typeof data?.error === 'string' && data.error ? data.error : generationError })
            return
          }
          const validSource = local
            ? typeof data?.repositoryPath === 'string' && Boolean(data.repositoryPath)
            : typeof data?.repoUrl === 'string' && /^https:\/\/github\.com\/[a-z\d-]+\/[\w.-]+$/i.test(data.repoUrl)
          if (!validSource || typeof data.markdown !== 'string' || !data.markdown.trim()
            || typeof data.commit !== 'string' || !/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(data.commit)) {
            update({ error: generationError })
            return
          }
          update({ result: { ...data, markdown: local ? resolveLocalReferences(data.markdown) : data.markdown } })
        } catch {
          if (!controller.signal.aborted) update({ error: generationError })
        } finally {
          activeRequest = undefined
          update({ loading: false })
        }
      }

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        changeSource(source) {
          if (!snapshot.loading && !snapshot.picking && !snapshot.browserOpen) update({ source, result: null, error: '' })
        },
        setRepositoryUrl: repositoryUrl => update({ repositoryUrl }),
        chooseFolder,
        selectFolder,
        closeBrowser: () => update({ browserOpen: false }),
        listDirectory: (path, signal) => workspace.listDirectory(path, signal),
        generate,
        dispose() {
          disposed = true
          activeRequest?.abort()
          listeners.clear()
        },
      }
    }

    function CodeWikiPage({ wiki }) {
      const { source, repositoryUrl, repositoryPath, result, error, loading, picking, browserOpen } =
        useSyncExternalStore(wiki.subscribe, wiki.getSnapshot)
      const sourceId = useId()
      const local = source === 'local'
      const ready = local ? Boolean(repositoryPath) : Boolean(repositoryUrl.trim())

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
        onSubmit: event => {
          event.preventDefault()
          void wiki.generate()
        },
        style: { display: 'flex', alignItems: 'end', flexWrap: 'wrap', gap: 8 },
      },
      h('fieldset', {
        disabled: loading || picking || browserOpen,
        style: { border: 0, padding: 0, margin: '0 0 4px', flexBasis: '100%' },
      },
      h('legend', null, '仓库来源'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginBlockStart: 4 } },
        ...[['github', 'GitHub 地址'], ['local', '本地仓库']].map(([value, label]) =>
          h('label', { key: value, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('input', {
              type: 'radio', name: sourceId, value, checked: source === value,
              onChange: () => wiki.changeSource(value),
            }),
            label,
          ),
        ),
      )),
      local ? h('div', {
        style: { display: 'grid', gap: 6, flex: '1 1 240px', minWidth: 0 },
      },
      '本地 Git 仓库',
      h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
        h(Button, {
          type: 'button', disabled: loading || picking || browserOpen,
          onClick: () => void wiki.chooseFolder(),
        }, repositoryPath ? '更换文件夹' : '选择文件夹'),
        repositoryPath && h('span', { title: repositoryPath, style: { overflowWrap: 'anywhere' } }, repositoryPath),
      )) : h('label', {
        style: { display: 'grid', gap: 6, flex: '1 1 240px', minWidth: 0 },
      },
      '公开 GitHub 仓库地址',
      h(Input, {
        type: 'url',
        name: 'repositoryUrl',
        value: repositoryUrl,
        onChange: event => wiki.setRepositoryUrl(event.target.value),
        required: true,
        disabled: loading,
        autoComplete: 'off',
        spellCheck: false,
      })),
      h(Button, {
        type: 'submit', variant: 'primary',
        disabled: !ready || loading || picking || browserOpen,
      }, '生成文档'),
      local && h('p', {
        style: { flexBasis: '100%', margin: 0, color: 'var(--dsw-alias-label-secondary)' },
      }, '只读取当前 HEAD 提交中的 Git 跟踪文件。选中的源码片段会发送给已配置的模型。')),
      local && browserOpen && h(FolderBrowser, {
        listDirectory: wiki.listDirectory,
        onPick: wiki.selectFolder,
        onClose: wiki.closeBrowser,
      }),
      (loading || picking || result) && h('div', { role: 'status', style: { marginBlock: '12px 24px' } },
        loading && '正在读取仓库并生成文档…',
        picking && '正在打开文件夹选择器…',
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
      result && h(MarkdownText, { text: result.markdown, labels, omitHtml: true })))
    }

    return {
      name: panelId,
      inject: ['slots', 'uiWorkspace', 'remote', 'remote.directoryPicker'],
      apply(ctx) {
        const wiki = createWikiStore(ctx.uiWorkspace, () => ctx.remote.directoryPicker.pick())
        ctx.effect(() => () => wiki.dispose())
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: panelId,
          inject: () => ({ wiki }),
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
