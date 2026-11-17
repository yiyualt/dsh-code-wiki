window.__ModuleLoader__.load({
  id: 'dsh-code-wiki',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createElement: h, useEffect, useId, useRef, useSyncExternalStore } = React
    const { Button, IconBranchOutlineRegular, IconCodeOutlineRegular, IconPlusOutlineRegular, Input, MarkdownText } = primitives
    const FolderBrowser = createCodeWikiFolderBrowser(React, primitives)
    const panelId = 'dsh-code-wiki'
    const panelTitle = '代码百科'
    const generationError = '生成失败，请稍后重试。'
    const historyLoadError = '无法读取文档历史，请重试。'
    const documentLoadError = '无法打开这篇文档，请重试。'
    const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' })
    const historyDateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
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

    function splitChapters(markdown) {
      const lines = markdown.split(/\r?\n/)
      const firstLine = lines.findIndex(line => line.trim())
      const headingText = value => value?.replace(/[ \t]+#+[ \t]*$/, '').trim().replace(/\\([^\w\s])/g, '$1')
      const documentTitle = headingText(/^ {0,3}#[ \t]+(.+)$/.exec(lines[firstLine] ?? '')?.[1])
      const headings = []
      let fence = null
      for (const [index, line] of lines.entries()) {
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
        if (fence) {
          if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null
          continue
        }
        if (marker) {
          fence = marker[1]
          continue
        }
        const title = headingText(/^ {0,3}##[ \t]+(.+)$/.exec(line)?.[1])
        if (title) headings.push({ title, index })
        else if (headings.length) lines[index] = line.replace(/^( {0,3})#(?=#{2,5}[ \t])/, '$1')
      }
      const start = documentTitle ? firstLine + 1 : 0
      if (!headings.length) {
        return { documentTitle, chapters: [{ title: documentTitle || '正文', markdown: lines.slice(start).join('\n') }] }
      }

      const preamble = lines.slice(start, headings[0].index).join('\n').trimEnd()
      const chapters = headings.map(({ title, index }, i) => {
        const chapter = lines.slice(index + 1, headings[i + 1]?.index).join('\n')
        return { title, markdown: preamble ? preamble + '\n\n' + chapter : chapter }
      })
      return { documentTitle, chapters }
    }

    function readDocument(data) {
      const metadata = documentMetadata(data)
      if (!metadata || typeof data.markdown !== 'string' || !data.markdown.trim()) return null
      const markdown = metadata.source === 'local' ? resolveLocalReferences(data.markdown) : data.markdown
      return {
        ...metadata,
        ...splitChapters(markdown),
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
        formOpen: false,
        result: null,
        chapterIndex: 0,
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
          if (revision === readerRevision && !controller.signal.aborted) update({ result, chapterIndex: 0 })
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
            formOpen: false,
            ...(revision === readerRevision && { result, chapterIndex: 0 }),
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
        toggleForm() {
          update({ formOpen: !snapshot.formOpen })
        },
        chooseFolder,
        selectFolder,
        closeBrowser: () => update({ browserOpen: false }),
        listDirectory: (path, signal) => workspace.listDirectory(path, signal),
        loadHistory,
        openDocument,
        generate,
        selectChapter(chapterIndex) {
          if (snapshot.result?.chapters[chapterIndex] && chapterIndex !== snapshot.chapterIndex) update({ chapterIndex })
        },
        dispose() {
          disposed = true
          activeRequest?.abort()
          listRequest?.abort()
          openRequest?.abort()
          listeners.clear()
        },
      }
    }

    function ChapterDirectory({ chapters, chapterIndex, selectChapter }) {
      const titleId = useId()
      return h('nav', { 'aria-labelledby': titleId, className: 'dsh-code-wiki-rail-section' },
        h('h2', { id: titleId, className: 'dsh-code-wiki-rail-label' }, '章节目录'),
        h('ul', { className: 'dsh-code-wiki-chapter-list' },
          chapters.map(({ title }, index) => h('li', { key: index },
            h('button', {
              type: 'button',
              className: 'dsh-code-wiki-chapter-button',
              'aria-current': index === chapterIndex ? 'true' : undefined,
              onClick: () => selectChapter(index),
            }, title),
          )),
        ),
      )
    }

    function DocumentHistory({ wiki, documents, historyStatus, historyError, openingId, activeId }) {
      const titleId = useId()
      const groups = groupDocuments(documents)
      const content = h('div', null,
        (historyStatus === 'idle' || historyStatus === 'loading') && !documents.length
          ? h('p', { role: 'status' }, '正在读取历史…') : null,
        historyStatus === 'ready' && !documents.length && h('p', null, '暂无已保存文档。'),
        historyStatus === 'error' && h('div', { role: 'alert' },
          h('p', null, historyLoadError),
          h(Button, { type: 'button', size: 'sm', onClick: () => void wiki.loadHistory() }, '重试')),
        groups.map(({ key, label, path, entries }, index) => h('details', {
          key, open: index === 0 || undefined, className: 'dsh-code-wiki-history-group',
        },
        h('summary', { title: path }, label),
        path && path !== label && h('p', { className: 'dsh-code-wiki-history-path' }, path),
        h('ul', { className: 'dsh-code-wiki-history-list' },
          entries.map(item => h('li', { key: item.id },
            h('button', {
              type: 'button',
              className: 'dsh-code-wiki-history-item',
              disabled: openingId === item.id,
              'aria-current': activeId === item.id ? 'true' : undefined,
              onClick: () => void wiki.openDocument(item.id),
            },
            h('time', { dateTime: item.createdAt, title: dateFormat.format(new Date(item.createdAt)) },
              historyDateFormat.format(new Date(item.createdAt))),
            h('code', { title: item.commit }, item.commit.slice(0, 8))),
          )),
        ))),
      )
      const status = historyError ? h('p', { role: 'alert' }, historyError)
        : openingId && h('p', { role: 'status' }, '正在打开文档…')
      if (activeId) {
        return h('div', { className: 'dsh-code-wiki-history dsh-code-wiki-rail-divider' },
          h('details', null, h('summary', null, '已保存文档'), content),
          status,
        )
      }
      return h('section', { 'aria-labelledby': titleId, className: 'dsh-code-wiki-history' },
        h('h2', { id: titleId, className: 'dsh-code-wiki-rail-label' }, '已保存文档'),
        content,
        status,
      )
    }

    function GenerationForm({ wiki, formId, source, repositoryUrl, repositoryPath, loading, picking, browserOpen, error }) {
      const sourceId = useId()
      const titleId = useId()
      const local = source === 'local'
      const busy = loading || picking || browserOpen
      const ready = local ? Boolean(repositoryPath) : Boolean(repositoryUrl.trim())

      return h('section', {
        id: formId, className: 'dsh-code-wiki-form-card', 'aria-labelledby': titleId,
      },
      h('h2', { id: titleId, className: 'dsh-code-wiki-form-title' }, '生成仓库 Wiki'),
      h('form', {
        className: 'dsh-code-wiki-form',
        onSubmit: event => {
          event.preventDefault()
          void wiki.generate()
        },
      },
      h('fieldset', { disabled: busy },
        h('legend', null, '仓库来源'),
        h('div', { className: 'dsh-code-wiki-source-options' },
          [['github', 'GitHub 地址'], ['local', '本地仓库']].map(([value, label]) =>
            h('label', { key: value },
              h('input', {
                type: 'radio', name: sourceId, value, checked: source === value,
                onChange: () => wiki.changeSource(value),
              }),
              h('span', null, label),
            ),
          ),
        ),
      ),
      local ? h('div', { className: 'dsh-code-wiki-field' },
        h('span', null, '本地 Git 仓库'),
        h('div', { className: 'dsh-code-wiki-folder-field' },
          h(Button, {
            type: 'button', variant: 'outline', disabled: busy,
            onClick: () => void wiki.chooseFolder(),
          }, repositoryPath ? '更换文件夹' : '选择文件夹'),
          repositoryPath && h('span', { title: repositoryPath }, repositoryPath),
        ),
      ) : h('label', { className: 'dsh-code-wiki-field' },
        h('span', null, '公开 GitHub 仓库地址'),
        h(Input, {
          type: 'url',
          name: 'repositoryUrl',
          value: repositoryUrl,
          onChange: event => wiki.setRepositoryUrl(event.target.value),
          required: true,
          disabled: busy,
          autoComplete: 'off',
          spellCheck: false,
        }),
      ),
      h(Button, {
        type: 'submit', variant: 'primary', disabled: !ready || busy,
      }, '生成文档'),
      local && h('p', { className: 'dsh-code-wiki-hint' },
        '只读取当前 HEAD 提交中的 Git 跟踪文件。选中的源码片段会发送给已配置的模型。')),
      local && browserOpen && h(FolderBrowser, {
        listDirectory: wiki.listDirectory,
        onPick: wiki.selectFolder,
        onClose: wiki.closeBrowser,
      }),
      (loading || picking) && h('p', { role: 'status', className: 'dsh-code-wiki-feedback' },
        picking ? '正在打开文件夹选择器…' : '正在读取仓库并生成文档…'),
      error && h('p', { role: 'alert', className: 'dsh-code-wiki-feedback', 'data-error': 'true' }, error))
    }

    function WikiArticle({ result, chapterIndex }) {
      const chapter = result.chapters[chapterIndex]
      const repository = repositoryLabel(result)
      const title = result.documentTitle
      const isDocumentTitle = title && title !== chapter.title && title !== repository.replace(/\s+/g, ' ') + ' Wiki'
      const shortCommit = result.commit.slice(0, 12)
      const revision = h(React.Fragment, null,
        h('span', { 'aria-hidden': true }, h(IconBranchOutlineRegular, { size: 14 })),
        h('code', null, shortCommit),
      )

      return h('article', { className: 'dsh-code-wiki-article', 'aria-label': '文档正文' },
        h('header', { className: 'dsh-code-wiki-article-header' },
          h('p', { className: 'dsh-code-wiki-eyebrow', title: result.repositoryPath },
            result.source === 'github' ? h('a', { href: result.repoUrl, target: '_blank', rel: 'noreferrer' }, repository) : repository,
            isDocumentTitle && ' · ' + title),
          h('h1', { className: 'dsh-code-wiki-article-title' }, chapter.title),
          h('div', { className: 'dsh-code-wiki-meta' },
            result.source === 'github' ? h('a', {
              className: 'dsh-code-wiki-revision',
              href: result.repoUrl + '/commit/' + result.commit,
              target: '_blank', rel: 'noreferrer',
              'aria-label': '查看固定提交 ' + shortCommit,
              title: result.commit,
            }, revision) : h('span', {
              className: 'dsh-code-wiki-revision', title: '固定提交 ' + result.commit,
            }, revision),
            h('time', { dateTime: result.createdAt, title: '生成时间' }, dateFormat.format(new Date(result.createdAt))),
            result.model && h('span', { title: '生成模型' }, result.model),
          ),
          result.note && h('p', { className: 'dsh-code-wiki-note' }, result.note),
        ),
        chapter.markdown.trim() && h('div', { className: 'dsh-code-wiki-prose' },
          h(MarkdownText, { text: chapter.markdown, labels, omitHtml: true })),
      )
    }

    function CodeWikiPage({ wiki }) {
      const snapshot = useSyncExternalStore(wiki.subscribe, wiki.getSnapshot)
      const { result, chapterIndex, formOpen, loading, picking, browserOpen,
        documents, historyStatus, historyError, openingId } = snapshot
      const formId = useId()
      const page = useRef(null)
      const documentId = result?.id
      const showForm = !result || formOpen || loading || picking || browserOpen

      useEffect(() => { void wiki.loadHistory() }, [wiki])
      useEffect(() => {
        if (documentId && page.current) page.current.scrollTop = 0
      }, [documentId, chapterIndex])

      return h('section', { 'aria-label': panelTitle, className: 'dsh-code-wiki-page', ref: page },
        h('style', null, codeWikiStyles),
        h('div', { className: 'dsh-code-wiki-shell' },
          h('header', { className: 'dsh-code-wiki-bar' },
            h('div', { className: 'dsh-code-wiki-brand' },
              h('span', { className: 'dsh-code-wiki-brand-icon', 'aria-hidden': true }, h(CodeWikiIcon, { size: 18 })),
              h('span', null, panelTitle),
            ),
            result && h('div', { className: 'dsh-code-wiki-actions' },
              h(Button, {
                type: 'button', variant: 'outline', size: 'sm',
                icon: showForm ? undefined : h(IconPlusOutlineRegular, { size: 16 }),
                disabled: loading || picking || browserOpen,
                'aria-expanded': showForm,
                'aria-controls': showForm ? formId : undefined,
                onClick: wiki.toggleForm,
              }, showForm ? '收起生成表单' : '新建 Wiki'),
            ),
          ),
          h('div', { className: 'dsh-code-wiki-columns' },
            h('aside', { className: 'dsh-code-wiki-sidebar' },
              result && h(ChapterDirectory, { chapters: result.chapters, chapterIndex, selectChapter: wiki.selectChapter }),
              h(DocumentHistory, { wiki, documents, historyStatus, historyError, openingId, activeId: documentId }),
            ),
            h('div', { className: 'dsh-code-wiki-main' },
              showForm && h(GenerationForm, { wiki, formId, ...snapshot }),
              result && h(WikiArticle, { result, chapterIndex }),
            ),
          ),
        ),
      )
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
