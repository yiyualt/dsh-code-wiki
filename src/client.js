window.__ModuleLoader__.load({
  id: 'dsh-code-wiki',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createElement: h, useEffect, useId, useRef, useState, useSyncExternalStore } = React
    const {
      Button, IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronLeftOutlineRegular, IconCodeOutlineRegular,
      IconPlusOutlineRegular, Input, MarkdownText,
    } = primitives
    const FolderBrowser = createCodeWikiFolderBrowser(React, primitives)
    const panelId = 'dsh-code-wiki'
    const panelTitle = '代码百科'
    const generationError = '生成失败，请稍后重试。'
    const historyLoadError = '无法读取文档历史，请重试。'
    const documentLoadError = '无法打开这篇文档，请重试。'
    const generationStages = [
      { phase: 'reading', label: '读取仓库', status: '正在读取仓库', detail: '正在定位当前提交并读取生成文档所需的源码。' },
      { phase: 'writing', label: '生成文档', status: '正在生成文档', detail: '正在根据源码组织章节和引用。这一步通常耗时最长。' },
      { phase: 'saving', label: '保存文档', status: '正在保存文档', detail: '正在把文档写入已保存文档列表。' },
    ]
    const terminalPhases = new Set(['completed', 'failed'])
    const generationPhases = new Set([...generationStages.map(stage => stage.phase), ...terminalPhases])
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

    function readArchitecture(graph, metadata) {
      if (!Array.isArray(graph?.layers) || !Array.isArray(graph.edges)) return null
      function citations(refs) {
        if (!Array.isArray(refs)) return []
        return refs.slice(0, 4).flatMap(ref => {
          if (typeof ref?.label !== 'string' || typeof ref.url !== 'string') return []
          const url = URL.parse(ref.url)
          if (!url) return []
          if (metadata.source === 'github') {
            if (!url.href.startsWith(metadata.repoUrl + '/blob/' + metadata.commit + '/') || !/^#L\d+(?:-L\d+)?$/.test(url.hash)) return []
            return [{ label: ref.label, href: url.href }]
          }
          if (url.origin !== 'https://dsh-code-wiki.invalid' || url.pathname !== '/source'
            || !new RegExp('^\\?key=' + metadata.id + '&file=\\d+&start=\\d+&end=\\d+$').test(url.search)) return []
          const local = new URL('api/dsh-code-wiki/source', document.baseURI)
          local.search = url.search
          return [{ label: ref.label, href: local.href }]
        })
      }
      const ids = new Set()
      const layers = graph.layers.slice(0, 4).flatMap(layer => {
        if (typeof layer?.title !== 'string' || !Array.isArray(layer.nodes)) return []
        const nodes = layer.nodes.slice(0, 3).flatMap(node => {
          if (typeof node?.id !== 'string' || ids.has(node.id) || typeof node.title !== 'string' || typeof node.summary !== 'string') return []
          const refs = citations(node.refs)
          if (!refs.length) return []
          ids.add(node.id)
          return [{ ...node, refs }]
        })
        return nodes.length ? [{ title: layer.title, nodes }] : []
      })
      const edges = graph.edges.slice(0, 16).flatMap(edge => {
        if (!ids.has(edge?.from) || !ids.has(edge?.to) || typeof edge.label !== 'string') return []
        const refs = citations(edge.refs)
        return refs.length ? [{ ...edge, refs }] : []
      })
      return layers.length > 1 && edges.length ? { layers, edges } : null
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
        durationMs: Number.isSafeInteger(data.durationMs) && data.durationMs >= 0 ? data.durationMs : undefined,
        architecture: readArchitecture(data.architecture, metadata),
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

    function validGeneration(job) {
      return typeof job?.id === 'string' && generationPhases.has(job.phase)
        && typeof job.repository === 'string' && Number.isSafeInteger(job.elapsedMs) && job.elapsedMs >= 0
    }

    async function readGeneration(signal, id) {
      const url = new URL('api/dsh-code-wiki/generation', document.baseURI)
      if (id) url.searchParams.set('id', id)
      const response = await fetch(url, {
        credentials: 'same-origin', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      })
      if (!response.ok) throw new Error(generationError)
      const { job } = await response.json()
      if (job === null || (validGeneration(job) && (!id || job.id === id))) return job
      throw new Error(generationError)
    }

    function createWikiStore(workspace, pickDirectory) {
      let snapshot = {
        source: 'github',
        repositoryUrl: '',
        repositoryPath: '',
        formOpen: false,
        result: null,
        returnDocumentId: null,
        chapterIndex: 0,
        error: '',
        loading: false,
        generation: null,
        progressOffline: false,
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
          if (revision === readerRevision && !controller.signal.aborted) update({
            result, chapterIndex: 0,
            ...(snapshot.generation?.id === id && snapshot.generation.phase === 'completed' && { generation: null }),
          })
        } catch {
          if (revision === readerRevision && !controller.signal.aborted) update({ historyError: documentLoadError })
        } finally {
          if (openRequest === controller) {
            openRequest = undefined
            update({ openingId: null })
          }
        }
      }

      function returnToHistory() {
        if (disposed || !snapshot.result) return
        readerRevision++
        openRequest?.abort()
        openRequest = undefined
        update({
          result: null,
          returnDocumentId: snapshot.result.id,
          chapterIndex: 0,
          formOpen: false,
          ...(snapshot.generation?.phase === 'completed' && snapshot.generation.id === snapshot.result.id && { generation: null }),
          historyError: '',
          openingId: null,
        })
      }

      function saveGenerationResult(data, revision, finished) {
        const result = readDocument(data)
        if (!result || result.id !== finished.id) throw new Error(generationError)
        const showResult = revision === readerRevision
        update({
          documents: mergeDocuments(snapshot.documents, [documentMetadata(result)]),
          generation: finished,
          formOpen: false,
          ...(showResult && { result, chapterIndex: 0 }),
        })
      }

      async function followGeneration(job, signal, revision) {
        while (job && !signal.aborted) {
          const { result, ...status } = job
          if (job.phase === 'completed') {
            saveGenerationResult(result, revision, status)
            return
          }
          if (job.phase === 'failed') throw new Error(job.error || generationError)
          update({ loading: true, generation: { ...status, receivedAt: performance.now() }, progressOffline: false })

          while (!signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 1600))
            if (signal.aborted) return
            try {
              job = await readGeneration(signal, job.id)
              break
            } catch {
              if (!signal.aborted && !snapshot.progressOffline) update({ progressOffline: true })
            }
          }
        }
        if (!signal.aborted) {
          void loadHistory()
          throw new Error('生成任务已结束或 DSH 已重启，请查看已保存文档。')
        }
      }

      async function submitGeneration(request, signal) {
        let response
        let data
        try {
          response = await fetch(new URL('api/dsh-code-wiki/generation', document.baseURI), {
            method: 'POST', credentials: 'same-origin', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
          })
          data = await response.json().catch(() => null)
        } catch {
          const job = !signal.aborted && await readGeneration(signal).catch(() => null)
          if (job) return job
          throw new Error(generationError)
        }
        if ((response.status === 202 || response.status === 409) && validGeneration(data?.job)) return data.job
        if (response.status === 404 || response.status === 405 || response.ok) {
          throw new Error('生成进度服务尚未就绪。请重启 DSH 服务并刷新页面后重试。')
        }
        throw new Error(typeof data?.error === 'string' && data.error ? data.error : generationError)
      }

      async function trackGeneration(request, repository) {
        if (disposed || snapshot.loading || (!request && activeRequest)) return
        activeRequest?.abort()
        const controller = new AbortController()
        activeRequest = controller
        const revision = request ? ++readerRevision : readerRevision
        if (request) {
          openRequest?.abort()
          update({
            error: '', historyError: '', loading: true, progressOffline: false,
            generation: { phase: 'starting', elapsedMs: 0, receivedAt: performance.now(), repository },
          })
        }
        try {
          const job = request
            ? await submitGeneration(request, controller.signal)
            : await readGeneration(controller.signal).catch(() => null)
          if (controller.signal.aborted) return
          if (job) await followGeneration(job, controller.signal, revision)
        } catch (error) {
          if (!controller.signal.aborted) update({
            generation: null, error: error.message || generationError, formOpen: Boolean(snapshot.result),
          })
        } finally {
          if (activeRequest === controller) {
            activeRequest = undefined
            if (snapshot.loading) update({ loading: false, progressOffline: false })
          }
        }
      }

      function generate() {
        if (snapshot.picking || snapshot.browserOpen) return
        const local = snapshot.source === 'local'
        const location = local ? snapshot.repositoryPath : snapshot.repositoryUrl.trim()
        if (!location) return
        const request = local ? { repositoryPath: location } : { repositoryUrl: location }
        const repository = local ? location.split(/[\\/]/).filter(Boolean).at(-1) || '本地仓库'
          : location.replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '')
        return trackGeneration(request, repository)
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
        returnToHistory,
        generate,
        resumeGeneration: () => trackGeneration(),
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

    function DocumentHistory({ wiki, documents, historyStatus, historyError, openingId, activeId, returnDocumentId }) {
      const titleId = useId()
      const returnedItem = useRef(null)
      const groups = groupDocuments(documents)
      const selectedId = activeId ?? returnDocumentId
      const selectedGroup = groups.find(group => group.entries.some(item => item.id === selectedId)) ?? groups[0]
      useEffect(() => {
        returnedItem.current?.focus()
      }, [activeId, returnDocumentId])

      const content = h('div', null,
        (historyStatus === 'idle' || historyStatus === 'loading') && !documents.length
          ? h('p', { role: 'status' }, '正在读取历史…') : null,
        historyStatus === 'ready' && !documents.length && h('p', null, '暂无已保存文档。'),
        historyStatus === 'error' && h('div', { role: 'alert' },
          h('p', null, historyLoadError),
          h(Button, { type: 'button', size: 'sm', onClick: () => void wiki.loadHistory() }, '重试')),
        groups.map(({ key, label, path, entries }) => h('details', {
          key, open: key === selectedGroup?.key || undefined, className: 'dsh-code-wiki-history-group',
        },
        h('summary', { title: path }, label),
        path && path !== label && h('p', { className: 'dsh-code-wiki-history-path' }, path),
        h('ul', { className: 'dsh-code-wiki-history-list' },
          entries.map(item => h('li', { key: item.id },
            h('button', {
              ref: !activeId && returnDocumentId === item.id ? returnedItem : undefined,
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
      picking && h('p', { role: 'status', className: 'dsh-code-wiki-feedback' }, '正在打开文件夹选择器…'),
      error && h('p', { role: 'alert', className: 'dsh-code-wiki-feedback', 'data-error': 'true' }, error))
    }

    function durationLabel(milliseconds) {
      const seconds = Math.floor(milliseconds / 1000)
      const minutes = Math.floor(seconds / 60)
      return (minutes ? `${minutes} 分 ` : '') + `${seconds % 60} 秒`
    }

    function GenerationClock({ elapsedMs, receivedAt }) {
      const [now, setNow] = useState(() => performance.now())
      useEffect(() => {
        const timer = setInterval(() => setNow(performance.now()), 250)
        return () => clearInterval(timer)
      }, [])
      const seconds = Math.floor((elapsedMs + Math.max(0, now - receivedAt)) / 1000)
      const minutes = String(Math.floor(seconds / 60)).padStart(2, '0')
      return h('div', { className: 'dsh-code-wiki-clock' },
        h('span', null, '已耗时'),
        h('time', { role: 'timer', 'aria-label': '生成耗时', dateTime: `PT${seconds}S` },
          minutes + ':' + String(seconds % 60).padStart(2, '0')),
      )
    }

    function GenerationProgress({ generation, progressOffline, openDocument, showingResult }) {
      const titleId = useId()
      const index = generationStages.findIndex(stage => stage.phase === generation.phase)
      const stage = generationStages[index]
      if (generation.phase === 'completed') {
        return h('div', { className: 'dsh-code-wiki-generation-done' },
          h('p', { role: 'status' }, h(IconCheckOutlineRegular, { size: 16, 'aria-hidden': true }),
            'Wiki 已保存', h('span', null, generation.repository + ' · 用时 ' + durationLabel(generation.elapsedMs))),
          !showingResult && h(Button, { size: 'sm', variant: 'outline', onClick: () => void openDocument(generation.id) }, '打开文档'),
        )
      }

      return h('section', { className: 'dsh-code-wiki-generation', 'aria-labelledby': titleId },
        h('div', { className: 'dsh-code-wiki-generation-header' },
          h('div', null,
            h('p', { className: 'dsh-code-wiki-generation-repo' }, generation.repository),
            h('h2', { id: titleId, role: 'status' }, stage?.status ?? '正在提交任务'),
          ),
          h(GenerationClock, { elapsedMs: generation.elapsedMs, receivedAt: generation.receivedAt }),
        ),
        h('div', { className: 'dsh-code-wiki-progressbar', role: 'progressbar', 'aria-labelledby': titleId }),
        h('ol', { className: 'dsh-code-wiki-generation-stages', 'aria-label': '生成阶段' },
          generationStages.map(({ phase, label }, i) => h('li', {
            key: phase, 'data-state': i < index ? 'done' : i === index ? 'active' : 'waiting',
            'aria-current': i === index ? 'step' : undefined,
          },
          h('span', { className: 'dsh-code-wiki-stage-marker', 'aria-hidden': true },
            i < index && h(IconCheckOutlineRegular, { size: 13 })),
          label,
          )),
        ),
        h('p', { className: 'dsh-code-wiki-generation-detail' },
          progressOffline ? '正在重新连接，稍后会同步进度。' : stage?.detail ?? '任务开始后会显示当前阶段。'),
        generation.filesRead > 0 && h('p', { className: 'dsh-code-wiki-generation-source' },
          '已读取 ' + generation.filesRead + ' 个文件', h('code', null, generation.currentFile)),
        h('p', { className: 'dsh-code-wiki-generation-background' }, '可切换面板或关闭页面，生成会继续。'),
      )
    }

    function ArchitectureGraph({ graph }) {
      const titleId = useId()
      const markerId = useId()
      const { layers, edges } = graph
      const nodeHeight = 92
      const laneWidth = 250
      const width = laneWidth * layers.length
      const height = 57 + 120 * Math.max(...layers.map(layer => layer.nodes.length))
      const nodes = new Map()
      for (const [column, layer] of layers.entries()) {
        const offset = (height - 57 - 120 * layer.nodes.length) / 2
        for (const [row, node] of layer.nodes.entries()) {
          nodes.set(node.id, { ...node, column, x: column * laneWidth + 21, y: 53 + offset + row * 120 })
        }
      }
      const nodeWidth = laneWidth - 56
      const percent = value => (100 * value / width) + '%'
      const sourceLink = (ref, props, ...children) => h('a', {
        href: ref.href, target: '_blank', rel: 'noopener noreferrer', ...props,
      }, ...children)

      function edgePath(edge) {
        const from = nodes.get(edge.from)
        const to = nodes.get(edge.to)
        const fromY = from.y + nodeHeight / 2
        const toY = to.y + nodeHeight / 2
        if (from.column === to.column) {
          const x = from.x + nodeWidth
          return `M${x},${fromY} C${x + 38},${fromY} ${x + 38},${toY} ${x + 2},${toY}`
        }
        const forward = from.column < to.column
        const x = forward ? from.x + nodeWidth : from.x
        const end = forward ? to.x - 2 : to.x + nodeWidth + 2
        const middle = x + (end - x) / 2
        return `M${x},${fromY} C${middle},${fromY} ${middle},${toY} ${end},${toY}`
      }

      return h('section', { className: 'dsh-code-wiki-architecture', 'aria-labelledby': titleId },
        h('h2', { id: titleId }, '架构图'),
        h('div', { className: 'dsh-code-wiki-diagram-scroll', tabIndex: 0, role: 'region', 'aria-label': '可横向滚动的架构图' },
          h('div', { className: 'dsh-code-wiki-diagram', style: { height, minWidth: layers.length * 190 } },
            layers.map((layer, index) => h('div', {
              className: 'dsh-code-wiki-diagram-lane', key: index,
              style: { left: percent(index * laneWidth + 8), width: percent(laneWidth - 16) },
            }, h('span', null, layer.title))),
            h('svg', { className: 'dsh-code-wiki-diagram-edges', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none',
              'aria-label': '模块连接' },
              h('defs', null, h('marker', {
                id: markerId, viewBox: '0 0 10 10', markerWidth: 7, markerHeight: 7, refX: 9, refY: 5, orient: 'auto-start-reverse',
              }, h('path', { d: 'M0,0 L10,5 L0,10 Z', fill: 'currentColor' }))),
              edges.map((edge, index) => {
                const d = edgePath(edge)
                return sourceLink(edge.refs[0], { key: index, tabIndex: -1, className: 'dsh-code-wiki-diagram-edge' },
                  h('title', null, edge.label + ' · ' + edge.refs[0].label),
                  h('path', { d, fill: 'none', stroke: 'transparent', strokeWidth: 14 }),
                  h('path', { d, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, markerEnd: `url(#${markerId})` }),
                )
              }),
            ),
            [...nodes.values()].map(node => sourceLink(node.refs[0], {
              key: node.id, className: 'dsh-code-wiki-diagram-node',
              style: { left: percent(node.x), width: percent(nodeWidth), top: node.y, height: nodeHeight },
              title: node.title + ' · ' + node.refs[0].label,
            }, h('strong', null, node.title), h('span', null, node.summary))),
          ),
        ),
        h('details', { className: 'dsh-code-wiki-diagram-relations' },
          h('summary', null, '模块关系与源码'),
          h('ul', null, edges.map((edge, index) => h('li', { key: index },
            h('strong', null, nodes.get(edge.from).title + ' → ' + nodes.get(edge.to).title),
            h('span', null, edge.label),
            edge.refs.map((ref, i) => sourceLink(ref, { key: i }, ref.label)),
          ))),
        ),
      )
    }

    function WikiArticle({ result, chapterIndex }) {
      const chapter = result.chapters[chapterIndex]
      const repository = repositoryLabel(result)
      const title = result.documentTitle
      const isDocumentTitle = title && title !== chapter.title
        && ![repository + ' Wiki', repository + ' 架构 Wiki'].includes(title)
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
            result.durationMs !== undefined && h('span', null, '生成用时 ' + durationLabel(result.durationMs)),
          ),
          result.note && h('p', { className: 'dsh-code-wiki-note' }, result.note),
        ),
        chapterIndex === 0 && result.architecture && h(ArchitectureGraph, { graph: result.architecture }),
        chapter.markdown.trim() && h('div', { className: 'dsh-code-wiki-prose' },
          h(MarkdownText, { text: chapter.markdown, labels, omitHtml: true })),
      )
    }

    function CodeWikiPage({ wiki }) {
      const snapshot = useSyncExternalStore(wiki.subscribe, wiki.getSnapshot)
      const { result, chapterIndex, formOpen, loading, picking, browserOpen,
        documents, historyStatus, historyError, openingId, returnDocumentId, generation, progressOffline } = snapshot
      const formId = useId()
      const page = useRef(null)
      const documentId = result?.id
      const showForm = picking || browserOpen || (!loading && (!result || formOpen))

      useEffect(() => {
        void wiki.loadHistory()
        void wiki.resumeGeneration()
      }, [wiki])
      useEffect(() => {
        if (documentId && page.current) page.current.scrollTop = 0
      }, [documentId, chapterIndex])

      return h('section', {
        'aria-label': panelTitle, className: 'dsh-code-wiki-page', 'data-reading': result ? '' : undefined, ref: page,
      },
        h('style', null, codeWikiStyles),
        h('div', { className: 'dsh-code-wiki-shell' },
          h('header', { className: 'dsh-code-wiki-bar' },
            result ? h(Button, {
              className: 'dsh-code-wiki-back',
              type: 'button',
              icon: h(IconChevronLeftOutlineRegular, { size: 16 }),
              onClick: wiki.returnToHistory,
            }, '返回文档列表') : h('div', { className: 'dsh-code-wiki-brand' },
              h('span', { className: 'dsh-code-wiki-brand-icon', 'aria-hidden': true }, h(CodeWikiIcon, { size: 18 })),
              h('span', null, panelTitle),
            ),
            result && !loading && h('div', { className: 'dsh-code-wiki-actions' },
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
              h(DocumentHistory, { wiki, documents, historyStatus, historyError, openingId, activeId: documentId, returnDocumentId }),
            ),
            h('div', { className: 'dsh-code-wiki-main' },
              generation && h(GenerationProgress, {
                generation, progressOffline, openDocument: wiki.openDocument, showingResult: documentId === generation.id,
              }),
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
