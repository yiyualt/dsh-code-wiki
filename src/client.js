window.__ModuleLoader__.load({
  id: 'dsh-code-wiki',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createElement: h, useEffect, useId, useSyncExternalStore } = React
    const { Button, IconCodeOutlineRegular, Input, MarkdownText } = primitives
    const FolderBrowser = createCodeWikiFolderBrowser(React, primitives)
    const panelId = 'dsh-code-wiki'
    const panelTitle = '代码百科'
    const generationError = '生成失败，请稍后重试。'
    const historyLoadError = '无法读取文档历史，请重试。'
    const documentLoadError = '无法打开这篇文档，请重试。'
    const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' })
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

    function documentMetadata(data) {
      if (typeof data?.id !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(data.id)
        || typeof data.commit !== 'string' || !/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(data.commit)
        || !['string', 'number'].includes(typeof data.createdAt)) return null
      const date = new Date(data.createdAt)
      if (!Number.isFinite(date.getTime())) return null
      const common = { id: data.id, source: data.source, commit: data.commit, createdAt: date.toISOString() }
      if (data.source === 'github' && typeof data.repoUrl === 'string' && /^https:\/\/github\.com\/[a-z\d-]+\/[\w.-]+$/i.test(data.repoUrl)) {
        return { ...common, repoUrl: data.repoUrl }
      }
      if (data.source === 'local' && typeof data.repositoryPath === 'string' && data.repositoryPath) {
        const repoName = typeof data.repoName === 'string' && data.repoName ? data.repoName : data.repositoryPath
        return { ...common, repositoryPath: data.repositoryPath, repoName }
      }
      return null
    }

    function readDocument(data) {
      const metadata = documentMetadata(data)
      if (!metadata || typeof data.markdown !== 'string' || !data.markdown.trim()) return null
      return {
        ...metadata,
        markdown: metadata.source === 'local' ? resolveLocalReferences(data.markdown) : data.markdown,
        model: typeof data.model === 'string' ? data.model : undefined,
        note: typeof data.note === 'string' ? data.note : undefined,
      }
    }

    function mergeDocuments(existing, incoming) {
      const byId = new Map(existing.map(item => [item.id, item]))
      for (const item of incoming) byId.set(item.id, item)
      return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    }

    function repositoryLabel(item) {
      return item.source === 'local' ? item.repoName : item.repoUrl.slice('https://github.com/'.length)
    }

    function groupDocuments(documents) {
      const groups = new Map()
      for (const item of documents) {
        const key = item.source === 'local' ? 'local:' + item.repositoryPath : 'github:' + item.repoUrl.toLowerCase()
        if (!groups.has(key)) groups.set(key, {
          key,
          label: repositoryLabel(item),
          path: item.repositoryPath,
          entries: [],
        })
        groups.get(key).entries.push(item)
      }
      return [...groups.values()]
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
        documents: [],
        historyStatus: 'idle',
        historyError: '',
        openingId: null,
      }
      let activeRequest
      let listRequest
      let openRequest
      let readerRevision = 0
      let disposed = false
      const listeners = new Set()

      function update(patch) {
        if (disposed) return
        snapshot = { ...snapshot, ...patch }
        for (const listener of listeners) listener()
      }

      function selectFolder(path) {
        update({ repositoryPath: path, browserOpen: false, error: '' })
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

      async function loadHistory() {
        if (disposed || listRequest) return
        const controller = new AbortController()
        listRequest = controller
        const existingIds = new Set(snapshot.documents.map(item => item.id))
        update({ historyStatus: 'loading' })
        try {
          const response = await fetch(new URL('api/dsh-code-wiki/documents', document.baseURI), {
            credentials: 'same-origin', signal: controller.signal,
          })
          const data = await response.json()
          if (!response.ok || !Array.isArray(data?.documents)) throw new Error(historyLoadError)
          const incoming = data.documents.map(documentMetadata).filter(Boolean)
          const recent = snapshot.documents.filter(item => !existingIds.has(item.id))
          update({ documents: mergeDocuments(incoming, recent), historyStatus: 'ready' })
        } catch {
          if (!controller.signal.aborted) update({ historyStatus: 'error' })
        } finally {
          listRequest = undefined
        }
      }

      async function openDocument(id) {
        if (disposed || snapshot.openingId === id) return
        openRequest?.abort()
        const revision = ++readerRevision
        if (snapshot.result?.id === id) {
          openRequest = undefined
          update({ openingId: null, historyError: '' })
          return
        }
        const controller = new AbortController()
        openRequest = controller
        update({ openingId: id, historyError: '' })
        try {
          const url = new URL('api/dsh-code-wiki/documents', document.baseURI)
          url.searchParams.set('id', id)
          const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal })
          const data = await response.json()
          const result = response.ok && readDocument(data)
          if (!result || result.id !== id) throw new Error(documentLoadError)
          if (revision === readerRevision && !controller.signal.aborted) update({ result })
        } catch {
          if (revision === readerRevision && !controller.signal.aborted) update({ historyError: documentLoadError })
        } finally {
          if (openRequest === controller) {
            openRequest = undefined
            update({ openingId: null })
          }
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
        const revision = ++readerRevision
        openRequest?.abort()
        update({ error: '', historyError: '', loading: true })
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
          const result = readDocument(data)
          if (!result || result.source !== (local ? 'local' : 'github')) {
            update({ error: generationError })
            return
          }
          update({
            documents: mergeDocuments(snapshot.documents, [documentMetadata(result)]),
            ...(revision === readerRevision && { result }),
          })
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
          if (!snapshot.loading && !snapshot.picking && !snapshot.browserOpen) update({ source, error: '' })
        },
        setRepositoryUrl: repositoryUrl => update({ repositoryUrl }),
        chooseFolder,
        selectFolder,
        closeBrowser: () => update({ browserOpen: false }),
        listDirectory: (path, signal) => workspace.listDirectory(path, signal),
        loadHistory,
        openDocument,
        generate,
        dispose() {
          disposed = true
          activeRequest?.abort()
          listRequest?.abort()
          openRequest?.abort()
          listeners.clear()
        },
      }
    }

    function DocumentHistory({ wiki, documents, historyStatus, historyError, openingId, activeId }) {
      const titleId = useId()
      const groups = groupDocuments(documents)
      return h('aside', {
        'aria-labelledby': titleId,
        style: { flex: '1 1 225px', minWidth: 0, overflowWrap: 'anywhere' },
      },
      h('h2', { id: titleId, style: { marginBlock: '0 10px', fontSize: '1rem' } }, '已保存文档'),
      (historyStatus === 'idle' || historyStatus === 'loading') && !documents.length
        ? h('p', { role: 'status' }, '正在读取历史…') : null,
      historyStatus === 'ready' && !documents.length && h('p', null, '暂无已保存文档。'),
      historyStatus === 'error' && h('div', { role: 'alert' },
        h('p', null, historyLoadError),
        h(Button, { type: 'button', size: 'sm', onClick: () => void wiki.loadHistory() }, '重试')),
      historyError && h('p', { role: 'alert' }, historyError),
      openingId && h('p', { role: 'status' }, '正在打开文档…'),
      ...groups.map(({ key, label, path, entries }, index) =>
        h('details', {
          key, open: index === 0 ? true : undefined, style: { marginBlock: '0 12px' },
        },
        h('summary', { title: path, style: { cursor: 'pointer', fontWeight: 600 } }, label),
        path && path !== label && h('p', {
          style: { marginBlock: '4px', fontSize: '0.75rem', color: 'var(--dsw-alias-label-secondary)' },
        }, path),
        h('ul', { style: { margin: '4px 0 0', padding: 0, listStyle: 'none' } },
          ...entries.map(item => h('li', { key: item.id },
            h(Button, {
              type: 'button', size: 'sm', disabled: openingId === item.id,
              'aria-current': activeId === item.id ? 'true' : undefined,
              onClick: () => void wiki.openDocument(item.id),
            },
            h('time', { dateTime: item.createdAt }, dateFormat.format(new Date(item.createdAt))),
            ' · ', h('code', { title: item.commit }, item.commit.slice(0, 8))),
          )),
        )),
      ))
    }

    function CodeWikiPage({ wiki }) {
      const { source, repositoryUrl, repositoryPath, result, error, loading, picking, browserOpen,
        documents, historyStatus, historyError, openingId } =
        useSyncExternalStore(wiki.subscribe, wiki.getSnapshot)
      const sourceId = useId()
      const local = source === 'local'
      const ready = local ? Boolean(repositoryPath) : Boolean(repositoryUrl.trim())
      useEffect(() => { void wiki.loadHistory() }, [wiki])

      return h('section', {
        'aria-label': panelTitle,
        style: { flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' },
      }, h('div', {
        style: {
          boxSizing: 'border-box',
          marginInline: 'auto',
          maxWidth: 1120,
          padding: 'clamp(20px, 5vw, 56px)',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '20px clamp(18px, 4vw, 40px)',
        },
      },
      h(DocumentHistory, { wiki, documents, historyStatus, historyError, openingId, activeId: result?.id }),
      h('article', { style: { flex: '3 1 420px', minWidth: 0 } },
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
        result?.source === 'local' && h('span', { title: result.repositoryPath },
          repositoryLabel(result),
          ' · 固定提交 ', h('code', { title: result.commit }, result.commit.slice(0, 12))),
        result?.source === 'github' && h('a', {
          href: `${result.repoUrl}/commit/${result.commit}`,
          target: '_blank',
          rel: 'noreferrer',
          title: result.commit,
        }, repositoryLabel(result), ' · 固定提交 ', h('code', null, result.commit.slice(0, 12))),
        !loading && typeof result?.model === 'string' && ' · ' + result.model,
        !loading && typeof result?.note === 'string' && h('p', { style: { marginBlock: '8px 0' } }, result.note),
      ),
      error && h('p', {
        role: 'alert',
        style: { color: 'var(--dsw-alias-label-error)', marginBlockEnd: 16 },
      }, error),
      result && h(MarkdownText, { text: result.markdown, labels, omitHtml: true }))))
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
