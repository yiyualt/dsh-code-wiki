window.__ModuleLoader__.load({
  id: 'dsh-code-wiki',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createElement: h, useEffect, useId, useRef, useState, useSyncExternalStore } = React
    const {
      Button, IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular,
      IconChevronRightOutlineRegular, IconCodeOutlineRegular, IconFolderOpenOutlineRegular,
      IconPlusOutlineRegular, IconTrashOutlineRegular, Input, MarkdownText, Modal,
    } = primitives
    const FolderBrowser = createCodeWikiFolderBrowser(React, primitives)
    const VideoPanel = createCodeWikiVideo(React, primitives)
    const WikiView = createWikiViewRenderer(React)
    const WikiWalkthrough = createWikiWalkthroughRenderer(React)
    const panelId = 'dsh-code-wiki'
    const panelTitle = '代码百科'
    const generationError = '生成失败，请稍后重试。'
    const historyLoadError = '无法读取文档历史，请重试。'
    const documentLoadError = '无法打开这篇文档，请重试。'
    const generationStages = [
      { phases: ['reading'], label: '读取仓库' },
      { phases: ['researching', 'planning'], label: '读取源码' },
      { phases: ['writing', 'reviewing'], label: '生成文档' },
      { phases: ['saving'], label: '保存文档' },
    ]
    const terminalPhases = new Set(['completed', 'failed'])
    const generationPhases = new Set([...generationStages.flatMap(stage => stage.phases), ...terminalPhases])
    const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' })
    const historyDateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
    const labels = {
      code: { copyLabel: '复制', copiedLabel: '已复制' },
      footnotes: '脚注',
    }
    const initialWalkthroughSelection = { index: 0, task: null }

    function resolveLocalReferences(markdown) {
      const reference = /^https:\/\/dsh-code-wiki\.invalid\/source(\?key=[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}&file=\d+&start=\d+&end=\d+)$/i
      return sourceLinks(markdown, (match, label, href, title) => {
        const local = reference.exec(href)
        if (!local) return match
        const url = new URL('api/dsh-code-wiki/source', document.baseURI)
        url.search = local[1]
        return '[' + label + '](' + url.href + title + ')'
      })
    }

    function readArchitecture(graph, metadata) {
      if (!Array.isArray(graph?.layers) || !Array.isArray(graph.edges)) return null
      function citations(refs) {
        if (!Array.isArray(refs)) return []
        return refs.slice(0, 6).flatMap(ref => {
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
      const nodeKinds = new Set(['entry', 'core', 'data', 'external'])
      const edgeKinds = new Set(['call', 'data', 'dependency'])
      const layers = graph.layers.slice(0, 5).flatMap(layer => {
        if (typeof layer?.title !== 'string' || !Array.isArray(layer.nodes)) return []
        const nodes = layer.nodes.flatMap(node => {
          if (typeof node?.id !== 'string' || ids.has(node.id) || typeof node.title !== 'string' || typeof node.summary !== 'string') return []
          const refs = citations(node.refs)
          if (!refs.length) return []
          ids.add(node.id)
          return [{ ...node, kind: nodeKinds.has(node.kind) ? node.kind : 'core', refs }]
        })
        return nodes.length ? [{ title: layer.title, nodes }] : []
      })
      const edges = graph.edges.slice(0, 24).flatMap(edge => {
        if (!ids.has(edge?.from) || !ids.has(edge?.to) || typeof edge.label !== 'string') return []
        const refs = citations(edge.refs)
        return refs.length ? [{ ...edge, kind: edgeKinds.has(edge.kind) ? edge.kind : 'call', refs }] : []
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

    function sourceLink(url, metadata) {
      const parsed = URL.parse(url)
      if (!parsed) return false
      if (metadata.source === 'github') return parsed.href.startsWith(metadata.repoUrl + '/blob/' + metadata.commit + '/')
        && /^#L\d+(?:-L\d+)?$/.test(parsed.hash)
      return parsed.origin === 'https://dsh-code-wiki.invalid' && parsed.pathname === '/source'
        && new RegExp('^\\?key=' + metadata.id + '&file=\\d+&start=\\d+&end=\\d+$').test(parsed.search)
    }

    function readViews(views, metadata, chapterCount) {
      if (!Array.isArray(views)) return []
      const ids = new Set(), kinds = new Set(), chapterFigures = new Map()
      const viewKinds = new Set(['flow', 'sequence', 'dataflow', 'dependency', 'scenario', 'deployment',
        'component', 'activity', 'state', 'entity', 'class'])
      const roles = new Set(['actor', 'component', 'process', 'data', 'store', 'decision', 'start', 'end'])
      const relations = new Set(['return', 'async', 'composition', 'association', 'inheritance'])
      const validId = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,43}$/.test(value)
      const text = (value, maximum) => typeof value === 'string' && value.trim() && value.length <= maximum
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
      function references(refs) {
        if (!Array.isArray(refs) || !refs.length || refs.length > 6) return null
        const resolved = refs.map(ref => {
          if (!text(ref?.label, 600) || typeof ref.url !== 'string' || !sourceLink(ref.url, metadata)) return null
          const href = metadata.source === 'local' ? new URL('api/dsh-code-wiki/source' + new URL(ref.url).search, document.baseURI).href : ref.url
          return { label: ref.label, url: ref.url, href }
        })
        return resolved.every(Boolean) ? resolved : null
      }
      return views.slice(0, 12).flatMap(view => {
        if (!validId(view?.id) || !viewKinds.has(view.kind)
          || !text(view.title, 100) || !text(view.purpose, 450) || !text(view.mermaid, 16_000)
          || !Array.isArray(view.nodes) || view.nodes.length < 2 || view.nodes.length > 8
          || !Array.isArray(view.edges) || !view.edges.length || view.edges.length > (view.kind === 'sequence' ? 16 : 10)) return []
        const chapter = view.chapter
        if (chapter !== undefined && (!Number.isInteger(chapter) || chapter < 0 || chapter >= chapterCount)) return []
        const chapterKinds = chapterFigures.get(chapter) ?? new Set()
        if (ids.has(view.id) || (chapter === undefined
          ? kinds.has(view.kind) || kinds.size >= 3
          : chapterKinds.has(view.kind) || chapterKinds.size >= 2)) return []
        const nodeIds = new Set(), connected = new Set()
        const nodes = view.nodes.map(node => {
          const refs = references(node?.refs)
          if (!validId(node?.id) || nodeIds.has(node.id) || !text(node.label, 60)
            || !roles.has(node.role) || !refs || node.detail !== undefined && !text(node.detail, 120)
            || node.members !== undefined && (!Array.isArray(node.members) || node.members.length < 1 || node.members.length > 4
              || Array.from(node.members).some(member => !text(member, 100)))) return null
          nodeIds.add(node.id)
          return { id: node.id, label: node.label, role: node.role, refs,
            ...(node.detail !== undefined && { detail: node.detail }), ...(node.members !== undefined && { members: node.members }) }
        })
        if (!nodes.every(Boolean)) return []
        const edges = view.edges.map(edge => {
          const refs = references(edge?.refs)
          if (!nodeIds.has(edge?.from) || !nodeIds.has(edge?.to) || edge.from === edge.to && !['state', 'sequence'].includes(view.kind) || !text(edge.label, 60)
            || !refs || edge.relation !== undefined && !relations.has(edge.relation)) return null
          const contract = edge.contract
          if (contract !== undefined && (!text(contract?.entry, 120) || !text(contract.input, 220) || !text(contract.output, 220))) return null
          connected.add(edge.from); connected.add(edge.to)
          return { from: edge.from, to: edge.to, label: edge.label, refs,
            ...(edge.relation !== undefined && { relation: edge.relation }),
            ...(contract !== undefined && { contract: { entry: contract.entry, input: contract.input, output: contract.output } }) }
        })
        if (!edges.every(Boolean) || connected.size !== nodeIds.size || view.kind === 'scenario' && !nodes.some(node => node.role === 'actor')) return []
        ids.add(view.id)
        if (chapter === undefined) kinds.add(view.kind)
        else {
          chapterKinds.add(view.kind)
          chapterFigures.set(chapter, chapterKinds)
        }
        return [{ id: view.id, kind: view.kind, title: view.title, purpose: view.purpose, nodes, edges,
          ...(chapter !== undefined && { chapter }),
          mermaid: view.mermaid.replace(/\r\n?/g, '\n') }]
      })
    }

    function portableInterfaceEnd(lines, diagramEnd, view) {
      if (!view.edges.some(edge => edge.contract)) return diagramEnd
      let start = diagramEnd + 1
      while (start < lines.length && !lines[start].trim()) start++
      if (lines[start] !== `<!-- dsh-wiki-interfaces:${view.id} -->`) return diagramEnd
      const closing = `<!-- /dsh-wiki-interfaces:${view.id} -->`
      for (let i = start + 1; i < lines.length; i++) {
        if (lines[i] === closing) return i
        if (/^ {0,3}(?:<!--|#{1,6}[ \t])/.test(lines[i]) || markdownFence(lines[i])) break
      }
      return diagramEnd
    }

    function approvedViewBlocks(markdown, views, skillMarkdown) {
      const approved = new Map(views.map(view => [view.mermaid, view]))
      const lines = markdown.split(/\r?\n/), blocks = [], pending = []
      let inComment = false
      for (let i = 0; i < lines.length; i++) {
        if (skillMarkdown && (inComment || /^ {0,3}<!--/.test(lines[i]))) {
          pending.push(lines[i])
          inComment = !lines[i].includes('-->')
          continue
        }
        const marker = markdownFence(lines[i])
        if (!marker) { pending.push(lines[i]); continue }
        const standalone = Boolean(markdownFence(lines[i], false))
        let end = i + 1
        for (; end < lines.length; end++) {
          const close = markdownFence(lines[end], !skillMarkdown || !standalone)
          if (close && close[1][0] === marker[1][0] && close[1].length >= marker[1].length && !close[2].trim()) break
        }
        const mermaid = marker[2].trim().toLowerCase() === 'mermaid'
        if (!skillMarkdown && marker[2].trim().toLowerCase() === 'dsh-architecture') {
          if (pending.length) blocks.push({ markdown: pending.splice(0).join('\n') })
          blocks.push({ architecture: true })
          i = end
          continue
        }
        const source = mermaid && end < lines.length && standalone
          && lines.slice(i + 1, end).join('\n')
        const verified = source && approved.get(source)
        const view = verified || (source && skillMarkdown && parseWikiMermaid(source))
        if (view) {
          if (pending.length) blocks.push({ markdown: pending.splice(0).join('\n') })
          blocks.push({ view })
        } else {
          pending.push(mermaid ? lines[i].replace(/(`{3,}|~{3,})[ \t]*mermaid[ \t]*$/i, '$1text') : lines[i],
            ...lines.slice(i + 1, Math.min(end + 1, lines.length)))
        }
        i = verified ? portableInterfaceEnd(lines, end, verified) : end
      }
      if (pending.length) blocks.push({ markdown: pending.join('\n') })
      return blocks
    }

    function markdownFence(line, allowContainers = true) {
      while (allowContainers) {
        const container = /^ {0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+)/.exec(line)
        if (!container) break
        line = line.slice(container[0].length)
      }
      return /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    }

    function outsideCode(markdown, transform) {
      let fence = null
      return markdown.split(/\r?\n/).map((line, index) => {
        const marker = markdownFence(line)
        if (fence) {
          if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null
          return line
        }
        if (marker) { fence = marker[1]; return line }
        const content = line.replace(/^(?: {0,3}>[ \t]?)+/, '')
        return /^(?: {4}|\t)/.test(content) ? line : transform(line, index)
      }).join('\n')
    }

    function sourceLinks(markdown, transform) {
      return outsideCode(markdown, line => {
        const code = [...line.matchAll(/(`+).*?\1/g)].map(match => [match.index, match.index + match[0].length])
        return line.replace(/(?<!!)\[((?:\\.|[^\]\\])*)\]\((https:\/\/[^)\s]+)([ \t]+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))?[ \t]*\)/g,
          (match, label, url, title, index) => code.some(([start, end]) => index >= start && index < end)
            ? match : transform(match, label, url, title ?? ''))
      })
    }

    function compactSources(markdown, metadata) {
      const sources = new Map()
      const compact = sourceLinks(markdown, (match, label, url, title) => {
        const plain = label.replace(/\\([\\`*_{}\[\]()<>#!|:.@])/g, '$1')
        if (!sourceLink(url, metadata) || !/^.+:\d+(?:[–-]\d+)?$/.test(plain)) return match
        if (!sources.has(url)) sources.set(url, { label, url, number: sources.size + 1 })
        return '[' + sources.get(url).number + '](' + url + title + ')'
      })
      return { markdown: compact, sources }
    }

    function chapterSources(chapter, sources, metadata) {
      let lastHeading
      outsideCode(chapter.markdown, (line, index) => {
        const heading = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)
        if (heading) lastHeading = { title: heading[1], index }
        return line
      })
      const lines = chapter.markdown.split('\n')
      if (lastHeading?.title === '本章引用') {
        const references = lines.slice(lastHeading.index + 1).join('\n').trim()
        const urls = new Set()
        sourceLinks(references, (match, label, url) => {
          if (/^\d+$/.test(label) && sourceLink(url, metadata)) urls.add(url)
          return match
        })
        if (urls.size && references.split('\n').every(line => !line.trim() || /^[-*] \[\d+\]\(/.test(line))) {
          return { ...chapter, markdown: lines.slice(0, lastHeading.index).join('\n').trimEnd(),
            references, referenceCount: urls.size }
        }
      }
      const present = new Map()
      sourceLinks(chapter.markdown, (match, _label, url) => {
        if (sources.has(url)) present.set(url, sources.get(url))
        return match
      })
      return { ...chapter, references: [...present.values()].map(source =>
        '- [' + source.number + '](' + source.url + ') ' + source.label).join('\n'), referenceCount: present.size }
    }

    function introductionBeforeGraph(markdown) {
      const sections = []
      outsideCode(markdown, (line, index) => {
        if (/^ {0,3}##[ \t]+/.test(line)) sections.push(index)
        return line
      })
      const lines = markdown.split('\n')
      const boundary = sections[0] > 0 && lines.slice(0, sections[0]).some(line => line.trim())
        ? sections[0] : sections[1]
      return boundary === undefined ? { introduction: markdown, remaining: '' }
        : { introduction: lines.slice(0, boundary).join('\n'), remaining: lines.slice(boundary).join('\n') }
    }

    function splitChapters(markdown) {
      const lines = markdown.split(/\r?\n/)
      const firstLine = lines.findIndex(line => line.trim())
      const headingText = value => value?.replace(/[ \t]+#+[ \t]*$/, '').trim().replace(/\\([^\w\s])/g, '$1')
      const documentTitle = headingText(/^ {0,3}#[ \t]+(.+)$/.exec(lines[firstLine] ?? '')?.[1])
      const headings = []
      let fence = null
      for (const [index, line] of lines.entries()) {
        const marker = markdownFence(line)
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
        return { title, markdown: i === 0 && preamble ? preamble + '\n\n' + chapter : chapter }
      })
      return { documentTitle, chapters }
    }

    function readDocument(data) {
      const metadata = documentMetadata(data)
      if (!metadata || typeof data.markdown !== 'string' || !data.markdown.trim()) return null
      const compact = compactSources(data.markdown, metadata)
      const content = splitChapters(compact.markdown)
      const chapters = content.chapters.map(chapter => {
        const readable = chapterSources(chapter, compact.sources, metadata)
        return metadata.source === 'local' ? { ...readable,
          markdown: resolveLocalReferences(readable.markdown), references: resolveLocalReferences(readable.references) } : readable
      })
      const architecture = readArchitecture(data.architecture, metadata)
      const walkthrough = architecture && data.walkthrough && readWikiWalkthrough(data.walkthrough, {
        nodeIds: new Set(architecture.layers.flatMap(layer => layer.nodes.map(node => node.id))),
        chapterCount: chapters.length,
        readRefs(refs) {
          const trusted = refs.map(ref => {
            if (typeof ref?.label !== 'string' || !ref.label.trim() || ref.label.length > 600
              || typeof ref.url !== 'string' || !sourceLink(ref.url, metadata)) return null
            const url = metadata.source === 'local'
              ? new URL('api/dsh-code-wiki/source' + new URL(ref.url).search, document.baseURI).href : ref.url
            return { label: ref.label, url }
          })
          return trusted.every(Boolean) ? trusted : undefined
        },
      })
      return {
        ...metadata,
        ...content, chapters,
        format: data.format === 'skill-markdown' ? data.format : undefined,
        views: readViews(data.views, metadata, chapters.length),
        model: typeof data.model === 'string' ? data.model : undefined,
        note: typeof data.note === 'string' ? data.note : undefined,
        durationMs: Number.isSafeInteger(data.durationMs) && data.durationMs >= 0 ? data.durationMs : undefined,
        architecture,
        ...(walkthrough && { walkthrough }),
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

    function validGeneration(job) {
      return typeof job?.id === 'string' && generationPhases.has(job.phase)
        && typeof job.repository === 'string' && Number.isSafeInteger(job.elapsedMs) && job.elapsedMs >= 0
    }

    function retryTarget(job) {
      if (typeof job?.repositoryUrl === 'string' && !job.repositoryPath) return { source: 'github', repositoryUrl: job.repositoryUrl.trim() }
      if (typeof job?.repositoryPath === 'string' && !job.repositoryUrl) return { source: 'local', repositoryPath: job.repositoryPath.trim() }
      return null
    }

    function matchingRetry(job, source, repositoryUrl, repositoryPath) {
      const target = retryTarget(job)
      if (!target || job.phase !== 'failed' || target.source !== source) return null
      const githubKey = url => url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')
      const same = source === 'local' ? target.repositoryPath === repositoryPath.trim()
        : githubKey(target.repositoryUrl) === githubKey(repositoryUrl)
      if (!same) return null
      const canResume = job.canResume === true && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(job.id)
        && (source === 'local' || /^[a-f\d]{40}$/i.test(job.commit))
      return { ...target, id: job.id, commit: job.commit, canResume }
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
        retryJob: null,
        progressOffline: false,
        picking: false,
        browserOpen: false,
        documents: [],
        historyStatus: 'idle',
        historyError: '',
        openingId: null,
        deletion: null,
      }
      let activeRequest
      let listRequest
      let openRequest
      let deleteRequest
      let readerRevision = 0
      let disposed = false
      const listeners = new Set()
      const deletedIds = new Set()

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

      async function loadHistory(refresh = false) {
        if (disposed || listRequest && !refresh) return
        if (refresh) listRequest?.abort()
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
          if (controller.signal.aborted) return
          const incoming = data.documents.map(documentMetadata).filter(item => item && !deletedIds.has(item.id))
          const recent = snapshot.documents.filter(item => !existingIds.has(item.id))
          update({ documents: mergeDocuments(incoming, recent), historyStatus: 'ready' })
        } catch {
          if (!controller.signal.aborted) update({ historyStatus: 'error' })
        } finally {
          if (listRequest === controller) listRequest = undefined
        }
      }

      async function openDocument(id) {
        if (disposed || snapshot.openingId === id || deletedIds.has(id)) return
        openRequest?.abort()
        const revision = ++readerRevision
        if (snapshot.result?.id === id) {
          openRequest = undefined
          update({ openingId: null, historyError: '', retryJob: null })
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
            result, chapterIndex: 0, formOpen: false, retryJob: null,
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

      async function deleteDocument() {
        const deletion = snapshot.deletion
        if (disposed || !deletion || deleteRequest) return
        const { id } = deletion.item
        const controller = new AbortController()
        deleteRequest = controller
        update({ deletion: { ...deletion, pending: true, error: '' } })
        try {
          const response = await fetch(new URL('api/dsh-code-wiki/documents/delete', document.baseURI), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
            signal: controller.signal,
          })
          if (response.status !== 204) {
            const data = await response.json().catch(() => null)
            throw new Error(typeof data?.error === 'string' ? data.error : '无法删除文档，请重试。')
          }
          if (controller.signal.aborted) return
          deletedIds.add(id)
          const openingDeleted = snapshot.openingId === id
          if (openingDeleted) {
            openRequest?.abort()
            openRequest = undefined
          }
          update({
            deletion: null,
            documents: snapshot.documents.filter(item => item.id !== id),
            ...(openingDeleted && { openingId: null }),
            ...(snapshot.result?.id === id && { result: null, chapterIndex: 0, formOpen: false }),
            ...(snapshot.returnDocumentId === id && { returnDocumentId: null }),
            ...(snapshot.generation?.id === id && { generation: null }),
          })
        } catch (error) {
          if (!controller.signal.aborted) {
            update({ deletion: { ...deletion, pending: false,
              error: error instanceof TypeError ? '无法连接到 DSH，请重试。' : error.message || '无法删除文档，请重试。' } })
          }
        } finally {
          deleteRequest = undefined
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
        if (deletedIds.has(result.id)) {
          if (snapshot.generation?.id === result.id) update({ generation: null })
          return
        }
        const showResult = revision === readerRevision
        update({
          documents: mergeDocuments(snapshot.documents, [documentMetadata(result)]),
          generation: finished,
          retryJob: null,
          formOpen: false,
          ...(showResult && { result, chapterIndex: 0 }),
        })
      }

      function rememberFailure(job, request) {
        const target = retryTarget(job) ?? retryTarget(request)
        if (!target) return
        const retryJob = { ...target, id: job.id, phase: 'failed', commit: job.commit, canResume: job.canResume === true }
        const location = snapshot.source === 'local' ? snapshot.repositoryPath : snapshot.repositoryUrl.trim()
        const matches = matchingRetry(retryJob, snapshot.source, snapshot.repositoryUrl, snapshot.repositoryPath)
        update({ retryJob, ...(!location ? { ...target, formOpen: true } : matches ? { formOpen: true } : {}) })
      }

      async function followGeneration(job, signal, revision, request) {
        while (job && !signal.aborted) {
          const { result, ...status } = job
          if (job.phase === 'completed') {
            saveGenerationResult(result, revision, status)
            return
          }
          if (job.phase === 'failed') {
            rememberFailure(job, request)
            throw new Error(job.error || generationError)
          }
          update({ retryJob: null, loading: true, generation: { ...status, receivedAt: performance.now() }, progressOffline: false })

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
            error: '', historyError: '', retryJob: null, loading: true, progressOffline: false,
            generation: { phase: 'starting', elapsedMs: 0, receivedAt: performance.now(), repository },
          })
        }
        try {
          const job = request
            ? await submitGeneration(request, controller.signal)
            : await readGeneration(controller.signal).catch(() => null)
          if (controller.signal.aborted) return
          if (job) await followGeneration(job, controller.signal, revision, request)
        } catch (error) {
          if (!controller.signal.aborted) {
            if (!snapshot.retryJob && request) rememberFailure({ phase: 'failed', canResume: false }, request)
            update({ generation: null, error: error.message || generationError })
            void loadHistory(true)
          }
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
        const location = local ? snapshot.repositoryPath.trim() : snapshot.repositoryUrl.trim()
        if (!location) return
        const retry = matchingRetry(snapshot.retryJob, snapshot.source, snapshot.repositoryUrl, snapshot.repositoryPath)
        const request = local ? { repositoryPath: location } : { repositoryUrl: retry?.canResume ? retry.repositoryUrl : location }
        if (retry?.canResume) Object.assign(request, { resumeFrom: retry.id, ...(!local && { commit: retry.commit }) })
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
        setRepositoryUrl: repositoryUrl => update({ repositoryUrl, error: '' }),
        setFormOpen(formOpen) {
          update({ formOpen, error: '' })
        },
        chooseFolder,
        selectFolder,
        closeBrowser: () => update({ browserOpen: false }),
        listDirectory: (path, signal) => workspace.listDirectory(path, signal),
        loadHistory,
        openDocument,
        requestDelete(item) {
          if (!deleteRequest) update({ deletion: { item, pending: false, error: '' } })
        },
        cancelDelete() {
          if (!deleteRequest) update({ deletion: null })
        },
        deleteDocument,
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
          deleteRequest?.abort()
          listeners.clear()
        },
      }
    }

    function ChapterDirectory({ chapters, chapterIndex, selectChapter }) {
      const selectId = useId()
      return h('nav', { 'aria-label': '章节目录' },
        h('h2', { className: 'dsh-code-wiki-rail-label' }, '章节目录'),
        h('ul', { className: 'dsh-code-wiki-chapter-list' },
          chapters.map(({ title }, index) => h('li', { key: index },
            h('button', {
              type: 'button',
              className: 'dsh-code-wiki-chapter-button',
              'aria-current': index === chapterIndex ? 'page' : undefined,
              onClick: () => selectChapter(index),
            }, title),
          )),
        ),
        h('div', { className: 'dsh-code-wiki-chapter-picker' },
          h('label', { htmlFor: selectId }, '章节'),
          h('div', null,
            h('select', { id: selectId, value: chapterIndex, onChange: event => selectChapter(Number(event.target.value)) },
              chapters.map(({ title }, index) => h('option', { key: index, value: index }, title))),
            h(IconChevronDownOutlineRegular, { size: 15, 'aria-hidden': true }))),
      )
    }

    function DocumentHistory({ wiki, documents, historyStatus, historyError, openingId, returnDocumentId }) {
      const titleId = useId()
      const returnedItem = useRef(null)
      useEffect(() => {
        returnedItem.current?.focus()
      }, [returnDocumentId])

      return h('section', { 'aria-labelledby': titleId, className: 'dsh-code-wiki-history' },
        h('h2', { id: titleId }, '已保存文档'),
        (historyStatus === 'idle' || historyStatus === 'loading') && !documents.length &&
          h('p', { role: 'status', className: 'dsh-code-wiki-library-status' }, '正在读取文档…'),
        historyStatus === 'error' && h('div', { role: 'alert', className: 'dsh-code-wiki-library-status' },
          h('p', null, historyLoadError),
          h(Button, { type: 'button', size: 'sm', onClick: () => void wiki.loadHistory() }, '重试')),
        historyError && h('p', { role: 'alert', className: 'dsh-code-wiki-library-status' }, historyError),
        historyStatus === 'ready' && !documents.length && h('div', { className: 'dsh-code-wiki-library-empty' },
          h(IconCodeOutlineRegular, { size: 25, 'aria-hidden': true }),
          h('p', null, '还没有已保存的 Wiki')),
        documents.length > 0 && h('ul', { className: 'dsh-code-wiki-history-list' },
          documents.map(item => h('li', { key: item.id, className: 'dsh-code-wiki-history-row' },
            h('button', {
              ref: returnDocumentId === item.id ? returnedItem : undefined,
              type: 'button',
              className: 'dsh-code-wiki-history-item',
              'aria-busy': openingId === item.id || undefined,
              'aria-disabled': openingId === item.id || undefined,
              onClick: () => void wiki.openDocument(item.id),
            },
            h('span', { className: 'dsh-code-wiki-history-icon', 'aria-hidden': true },
              h(item.source === 'local' ? IconFolderOpenOutlineRegular : IconCodeOutlineRegular, { size: 19 })),
            h('span', { className: 'dsh-code-wiki-history-copy' },
              h('strong', { title: item.repositoryPath || item.repoUrl }, repositoryLabel(item)),
              h('span', { className: 'dsh-code-wiki-history-meta' },
                h('span', null, item.source === 'local' ? '本地仓库' : 'GitHub'),
                h('code', { title: item.commit }, item.commit.slice(0, 8)),
                h('time', { dateTime: item.createdAt, title: dateFormat.format(new Date(item.createdAt)) },
                  historyDateFormat.format(new Date(item.createdAt))))),
            openingId === item.id ? h('span', { className: 'dsh-code-wiki-history-opening', role: 'status' }, '正在打开…')
              : h(IconChevronRightOutlineRegular, { size: 16, 'aria-hidden': true })),
            h('button', {
              type: 'button', className: 'dsh-code-wiki-delete',
              'aria-label': '删除文档 ' + repositoryLabel(item) + ' ' + item.commit.slice(0, 8),
              title: '删除文档',
              onClick: () => wiki.requestDelete(item),
            }, h(IconTrashOutlineRegular, { size: 16, 'aria-hidden': true })),
          ))),
      )
    }

    function DeleteDocumentDialog({ deletion, wiki }) {
      const { item, pending, error } = deletion
      return h(Modal, {
        open: true,
        title: '删除文档？',
        closeLabel: '关闭',
        onClose: wiki.cancelDelete,
        description: '将永久删除这篇已保存的文档。',
        footer: h(React.Fragment, null,
          h(Button, { 'data-modal-autofocus': '', disabled: pending, onClick: wiki.cancelDelete }, '取消'),
          h(Button, {
            variant: 'primary', className: 'dsh-code-wiki-confirm-delete', disabled: pending,
            onClick: () => void wiki.deleteDocument(),
          }, pending ? '正在删除…' : '删除'),
        ),
      },
      h('p', { className: 'dsh-code-wiki-delete-summary' },
        h('strong', null, repositoryLabel(item)), ' · ',
        h('time', { dateTime: item.createdAt }, dateFormat.format(new Date(item.createdAt))), ' · ',
        h('code', null, item.commit.slice(0, 8))),
      error && h('p', { className: 'dsh-code-wiki-delete-error', role: 'alert' }, error),
      )
    }

    function GenerationForm({ wiki, formId, source, repositoryUrl, repositoryPath, loading, picking, browserOpen, retryJob, error }) {
      const sourceId = useId()
      const titleId = useId()
      const heading = useRef(null)
      const local = source === 'local'
      const busy = loading || picking || browserOpen
      const ready = local ? Boolean(repositoryPath.trim()) : Boolean(repositoryUrl.trim())
      const retry = matchingRetry(retryJob, source, repositoryUrl, repositoryPath)
      useEffect(() => { heading.current?.focus() }, [])

      return h('section', {
        id: formId, className: 'dsh-code-wiki-form-card', 'aria-labelledby': titleId,
      },
      h('h2', { id: titleId, ref: heading, tabIndex: -1, className: 'dsh-code-wiki-form-title' }, '新建 Wiki'),
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
      }, retry ? retry.canResume ? '继续生成' : '重新尝试' : '生成文档'),
      retry?.canResume && h('p', { className: 'dsh-code-wiki-hint' }, '已保存进度，可继续生成。'),
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

    function generationTransportRetry(transport) {
      if (!transport || !['request-retry', 'request-start', 'request-receiving'].includes(transport.event)) return ''
      const attempt = transport.attempt + (transport.event === 'request-retry' ? 1 : 0)
      if (!Number.isSafeInteger(transport.attempt) || !Number.isSafeInteger(transport.attemptLimit)
        || transport.attempt < 1 || attempt < 2 || attempt > transport.attemptLimit || transport.attemptLimit > 10) return ''
      const reasons = { TRANSPORT: '连接暂时中断', TIMEOUT: '单次请求等待超时', STREAM_CLOSED: '响应传输中断',
        RATE_LIMIT: '模型服务请求受限', SERVER: '模型服务暂时异常' }
      return (Object.hasOwn(reasons, transport.retryCode) ? reasons[transport.retryCode] + '，' : '')
        + (transport.event === 'request-retry' ? '即将重试模型请求' : '正在重试模型请求')
        + `（第 ${attempt} / ${transport.attemptLimit} 次尝试）。`
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
        h('span', null, '整次耗时'),
        h('time', { role: 'timer', 'aria-label': '生成耗时', dateTime: `PT${seconds}S` },
          minutes + ':' + String(seconds % 60).padStart(2, '0')),
      )
    }

    function GenerationProgress({ generation, progressOffline, openDocument }) {
      const titleId = useId()
      const index = generationStages.findIndex(stage => stage.phases.includes(generation.phase))
      const stage = generationStages[index]
      const status = stage ? '正在' + stage.label : '正在提交任务'
      const transportRetry = ['researching', 'writing'].includes(generation.phase) && generationTransportRetry(generation.transport)
      const responseRetry = generation.phase === 'writing' && generation.reasonCategory === 'model-response'
        && generation.step === 'submission-retry'
      const detail = progressOffline ? '连接中断，稍后会同步进度。'
        : transportRetry || (responseRetry && '正在重新请求模型回复。')
      if (generation.phase === 'completed') {
        return h('div', { className: 'dsh-code-wiki-generation-done' },
          h('p', { role: 'status' }, h(IconCheckOutlineRegular, { size: 16, 'aria-hidden': true }),
            'Wiki 已保存', h('span', null, generation.repository + ' · 用时 ' + durationLabel(generation.elapsedMs))),
          h(Button, { size: 'sm', variant: 'outline', onClick: () => void openDocument(generation.id) }, '打开文档'),
        )
      }

      return h('section', { className: 'dsh-code-wiki-generation', 'aria-labelledby': titleId },
        h('div', { className: 'dsh-code-wiki-generation-header' },
          h('div', null,
            h('p', { className: 'dsh-code-wiki-generation-repo' }, generation.repository),
            h('h2', { id: titleId, role: 'status' }, progressOffline ? '正在重新连接' : status),
          ),
          h(GenerationClock, { elapsedMs: generation.elapsedMs, receivedAt: generation.receivedAt }),
        ),
        h('div', { className: 'dsh-code-wiki-progressbar', role: 'progressbar', 'aria-labelledby': titleId }),
        h('ol', { className: 'dsh-code-wiki-generation-stages', 'aria-label': '生成阶段' },
          generationStages.map(({ label }, i) => h('li', {
            key: label, 'data-state': i < index ? 'done' : i === index ? 'active' : 'waiting',
            'aria-current': i === index ? 'step' : undefined,
          },
          h('span', { className: 'dsh-code-wiki-stage-marker', 'aria-hidden': true },
            i < index && h(IconCheckOutlineRegular, { size: 13 })),
          label,
          )),
        ),
        detail && h('p', { className: 'dsh-code-wiki-generation-detail' }, detail),
        generation.filesRead > 0 && h('p', { className: 'dsh-code-wiki-generation-source' },
          '已读取 ' + generation.filesRead + ' 个文件', generation.currentFile && ' · 最近读取：',
          generation.currentFile && h('code', null, generation.currentFile)),
        h('p', { className: 'dsh-code-wiki-generation-background' }, '可切换面板或关闭页面，生成会继续。'),
      )
    }

    function ArchitectureGraph({ graph }) {
      const titleId = useId()
      const markerId = useId()
      const activeMarkerId = useId()
      const hintId = useId()
      const detailsId = useId()
      const viewportRef = useRef(null)
      const detailsHeadingRef = useRef(null)
      const detailsTrigger = useRef(null)
      const drag = useRef(null)
      const [selectedId, setSelectedId] = useState(null)
      const [showDetails, setShowDetails] = useState(false)
      const [wheelZoom, setWheelZoom] = useState(false)
      const [dragging, setDragging] = useState(false)
      const [size, setSize] = useState({ width: 0, height: 0 })
      const [view, setView] = useState(null)
      const { layers, edges } = graph
      const nodeHeight = 76
      const nodeWidth = 154
      const columnWidth = 180
      const rowHeight = 141
      const columns = Math.min(4, Math.max(...layers.map(layer => layer.nodes.length)))
      const width = columns * columnWidth + 38
      let height = 0
      const groups = layers.map(layer => {
        const group = { ...layer, top: height, height: Math.ceil(layer.nodes.length / 4) * rowHeight }
        height += group.height
        return group
      })
      const nodes = new Map()
      for (const layer of groups) {
        for (const [index, node] of layer.nodes.entries()) {
          const row = Math.floor(index / 4)
          const count = Math.min(4, layer.nodes.length - row * 4)
          const offset = (width - count * columnWidth) / 2
          nodes.set(node.id, { ...node, row: layer.top / rowHeight + row,
            x: offset + (index % 4) * columnWidth + (columnWidth - nodeWidth) / 2, y: layer.top + row * rowHeight + 31 })
        }
      }
      const selected = nodes.get(selectedId)
      const relations = selected ? edges.filter(edge => edge.from === selected.id || edge.to === selected.id) : edges
      const relatedIds = new Set(relations.flatMap(edge => [edge.from, edge.to]))
      const fitScale = size.width && size.height
        ? Math.max(0.05, Math.min(1, (size.width - 24) / width, (size.height - 24) / height))
        : 1
      const fitted = { scale: fitScale, x: (size.width - width * fitScale) / 2, y: (size.height - height * fitScale) / 2 }
      const camera = view ?? fitted
      const minScale = Math.min(fitScale, 0.24)
      const maxScale = 2
      const sourceLink = (ref, props, ...children) => h('a', {
        href: ref.href, target: '_blank', rel: 'noopener noreferrer', ...props,
      }, ...children)

      useEffect(() => {
        const viewport = viewportRef.current
        const observer = new ResizeObserver(([entry]) => {
          setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
        })
        observer.observe(viewport)
        return () => observer.disconnect()
      }, [])

      function zoom(factor, x = size.width / 2, y = size.height / 2) {
        setView(previous => {
          const current = previous ?? fitted
          const scale = Math.min(maxScale, Math.max(minScale, current.scale * factor))
          const relative = scale / current.scale
          return { scale, x: x - (x - current.x) * relative, y: y - (y - current.y) * relative }
        })
      }

      useEffect(() => {
        if (!wheelZoom) return
        const viewport = viewportRef.current
        function onWheel(event) {
          if (!event.cancelable || !event.deltaY) return
          event.preventDefault()
          const bounds = viewport.getBoundingClientRect()
          const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1
          zoom(Math.exp(-event.deltaY * unit / 420), event.clientX - bounds.left, event.clientY - bounds.top)
        }
        viewport.addEventListener('wheel', onWheel, { passive: false })
        return () => viewport.removeEventListener('wheel', onWheel)
      }, [wheelZoom, size.width, size.height, width, height])

      function beginDrag(event) {
        if (event.button !== 0 || drag.current || event.target.closest('button, a')) return
        drag.current = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, ...camera }
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
      }

      function moveDrag(event) {
        const start = drag.current
        if (start?.id !== event.pointerId) return
        setView({ scale: start.scale, x: start.x + event.clientX - start.clientX, y: start.y + event.clientY - start.clientY })
      }

      function endDrag(event) {
        if (drag.current?.id !== event.pointerId) return
        drag.current = null
        setDragging(false)
      }

      function onViewportKey(event) {
        if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return
        const offset = { ArrowLeft: [48, 0], ArrowRight: [-48, 0], ArrowUp: [0, 48], ArrowDown: [0, -48] }[event.key]
        if (!offset && !['+', '=', '-', 'Home'].includes(event.key)) return
        event.preventDefault()
        if (offset) {
          setView(previous => {
            const current = previous ?? fitted
            return { ...current, x: current.x + offset[0], y: current.y + offset[1] }
          })
        } else if (event.key === 'Home') setView(null)
        else zoom(event.key === '-' ? 0.8 : 1.25)
      }

      function showNodeInViewport(event, node) {
        if (!event.currentTarget.matches(':focus-visible')) return
        const { x, y, scale } = camera
        const left = x + node.x * scale
        const top = y + node.y * scale
        const right = left + nodeWidth * scale
        const bottom = top + nodeHeight * scale
        const dx = Math.max(16 - left, 0) + Math.min(size.width - 16 - right, 0)
        const dy = Math.max(16 - top, 0) + Math.min(size.height - 16 - bottom, 0)
        if (dx || dy) setView({ x: x + dx, y: y + dy, scale })
      }

      function closeDetails(restoreFocus = false) {
        setSelectedId(null)
        setShowDetails(false)
        if (restoreFocus) detailsTrigger.current?.focus()
        detailsTrigger.current = null
      }

      function toggleDetails(event) {
        if (showDetails) { closeDetails(); return }
        detailsTrigger.current = event.currentTarget
        setShowDetails(true)
      }

      function selectNode(nodeId, trigger) {
        if (nodeId === selectedId) { closeDetails(); return }
        if (trigger) detailsTrigger.current = trigger
        setSelectedId(nodeId)
        setShowDetails(true)
      }

      function edgePath(edge, index) {
        const from = nodes.get(edge.from)
        const to = nodes.get(edge.to)
        const fromX = from.x + nodeWidth / 2
        const toX = to.x + nodeWidth / 2
        if (from.row === to.row) {
          const y = from.y + nodeHeight
          return `M${fromX},${y} C${fromX},${y + 32} ${toX},${y + 32} ${toX},${y + 2}`
        }
        const forward = from.row < to.row
        const y = forward ? from.y + nodeHeight : from.y
        const end = forward ? to.y - 2 : to.y + nodeHeight + 2
        if (Math.abs(from.row - to.row) > 1) {
          const outside = width - 8 - (index % 4) * 4
          const departure = y + (forward ? 24 : -18)
          const arrival = end + (forward ? -18 : 24)
          return `M${fromX},${y} L${fromX},${departure} L${outside},${departure} L${outside},${arrival} L${toX},${arrival} L${toX},${end}`
        }
        const middle = y + (end - y) / 2
        return `M${fromX},${y} C${fromX},${middle} ${toX},${middle} ${toX},${end}`
      }

      return h('section', { className: 'dsh-code-wiki-architecture', 'aria-labelledby': titleId, onKeyDown: event => {
        if (event.key === 'Escape' && showDetails) { event.stopPropagation(); closeDetails(true) }
      } },
        h('div', { className: 'dsh-code-wiki-diagram-frame' },
        h('div', { className: 'dsh-code-wiki-diagram-heading' },
          h('h2', { id: titleId }, '架构图'),
          h('p', { id: hintId }, '拖动空白处平移，点击组件查看源码。'),
          h('div', { className: 'dsh-code-wiki-diagram-legend', 'aria-label': '图例' },
            [['entry', '入口'], ['core', '核心逻辑'], ['data', '数据与存储'], ['external', '外部依赖']]
              .filter(([kind]) => [...nodes.values()].some(node => node.kind === kind))
              .map(([kind, label]) => h('span', { key: kind, className: 'dsh-code-wiki-legend-node', 'data-kind': kind },
                h('i', { 'aria-hidden': true }), label)),
            [['call', '调用'], ['data', '数据流'], ['dependency', '依赖']]
              .filter(([kind]) => edges.some(edge => edge.kind === kind))
              .map(([kind, label]) => h('span', { key: kind, className: 'dsh-code-wiki-legend-edge', 'data-kind': kind },
                h('i', { 'aria-hidden': true }), label)))),
        h('div', { className: 'dsh-code-wiki-diagram-tools', role: 'group', 'aria-label': '架构图控制' },
          h('div', { className: 'dsh-code-wiki-diagram-view-tools' },
            h('div', { className: 'dsh-code-wiki-diagram-zoom', role: 'group', 'aria-label': '缩放' },
              h('button', { type: 'button', onClick: () => zoom(0.8), disabled: camera.scale <= minScale,
                'aria-label': '缩小', title: '缩小' }, '−'),
              h('span', { className: 'dsh-code-wiki-diagram-scale' }, Math.round(camera.scale * 100) + '%'),
              h('button', { type: 'button', onClick: () => zoom(1.25), disabled: camera.scale >= maxScale,
                'aria-label': '放大', title: '放大' }, '+'),
            ),
            h('button', { type: 'button', onClick: () => setView(null) }, '查看全图'),
          ),
          h('button', { type: 'button', className: 'dsh-code-wiki-diagram-wheel', 'aria-pressed': wheelZoom,
            onClick: () => setWheelZoom(!wheelZoom) },
          h('span', { className: 'dsh-code-wiki-diagram-switch', 'aria-hidden': true }), '滚轮缩放'),
          h('button', { type: 'button', className: 'dsh-code-wiki-diagram-details-toggle',
            'aria-expanded': showDetails, 'aria-controls': detailsId, onClick: toggleDetails }, '组件与关系'),
        ),
        h('div', { className: 'dsh-code-wiki-diagram-workspace', 'data-inspecting': showDetails || undefined },
        h('div', { ref: viewportRef, className: 'dsh-code-wiki-diagram-viewport', tabIndex: 0,
          role: 'region', 'aria-label': '交互式架构图', 'aria-describedby': hintId,
          'data-dragging': dragging ? '' : undefined,
          onPointerDown: beginDrag, onPointerMove: moveDrag, onLostPointerCapture: endDrag, onKeyDown: onViewportKey,
        },
          h('div', { className: 'dsh-code-wiki-diagram', style: {
            width, height, visibility: size.width && size.height ? undefined : 'hidden',
            transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
          } },
            groups.map((layer, index) => h('div', {
              className: 'dsh-code-wiki-diagram-lane', key: index,
              style: { top: layer.top + 2, height: layer.height - 7 },
            }, h('span', null, layer.title))),
            h('svg', { className: 'dsh-code-wiki-diagram-edges', viewBox: `0 0 ${width} ${height}`,
              'aria-label': '模块连接' },
              h('defs', null, [[markerId, 'var(--wiki-diagram-wire)'], [activeMarkerId, 'var(--wiki-accent-ink)']].map(([id, fill]) => h('marker', {
                key: id, id, viewBox: '0 0 10 10', markerWidth: 6, markerHeight: 6, refX: 9, refY: 5, orient: 'auto',
              }, h('path', { d: 'M0,0 L10,5 L0,10 Z', fill })))),
              edges.map((edge, index) => {
                const d = edgePath(edge, index)
                const active = selected && (edge.from === selected.id || edge.to === selected.id)
                return sourceLink(edge.refs[0], { key: index, tabIndex: -1, className: 'dsh-code-wiki-diagram-edge',
                  'data-kind': edge.kind, 'data-active': active ? '' : undefined, 'data-muted': selected && !active ? '' : undefined },
                  h('title', null, nodes.get(edge.from).title + ' → ' + nodes.get(edge.to).title + ' · ' + edge.label),
                  h('path', { className: 'dsh-code-wiki-diagram-edge-target', d, strokeWidth: 14 }),
                  h('path', { d, fill: 'none', stroke: 'currentColor', strokeWidth: active ? 2 : 1.35,
                    markerEnd: `url(#${active ? activeMarkerId : markerId})` }),
                )
              }),
            ),
            [...nodes.values()].map(node => h('button', {
              type: 'button', key: node.id, className: 'dsh-code-wiki-diagram-node',
              'aria-pressed': selectedId === node.id,
              'aria-controls': detailsId,
              'aria-label': node.title,
              'data-kind': node.kind,
              'data-muted': selected && node.id !== selected.id && !relatedIds.has(node.id) ? '' : undefined,
              style: { left: node.x, width: nodeWidth, top: node.y, height: nodeHeight },
              onFocus: event => showNodeInViewport(event, node),
              onClick: event => selectNode(node.id, event.currentTarget),
            }, h('strong', null, node.title),
            typeof node.technology === 'string' && node.technology && h('small', null, node.technology))),
          ),
        ),
        h('section', { id: detailsId, className: 'dsh-code-wiki-diagram-relations', hidden: !showDetails,
          'aria-label': '组件与关系详情' },
          h('div', { className: 'dsh-code-wiki-diagram-selection' },
            h('div', null,
              selected && h('button', { type: 'button', className: 'dsh-code-wiki-diagram-show-components',
                onClick: () => { setSelectedId(null); detailsHeadingRef.current?.focus() } }, '全部组件'),
              h('h3', { ref: detailsHeadingRef, tabIndex: -1 }, selected ? selected.title : '组件与关系')),
            h('button', { type: 'button', className: 'dsh-code-wiki-diagram-close-details', 'aria-label': '关闭组件详情',
              title: '关闭组件详情', onClick: () => closeDetails(true) }, '×')),
          selected && h('div', { className: 'dsh-code-wiki-diagram-description', 'aria-live': 'polite' },
            h('p', null, selected.summary),
            typeof selected.technology === 'string' && selected.technology && h('p', null, '实现技术 · ' + selected.technology),
            typeof selected.boundary === 'string' && selected.boundary && h('p', null, '运行边界 · ' + selected.boundary),
            h('h4', null, '源码'),
            selected.refs.map((ref, i) => sourceLink(ref, { key: i }, ref.label))),
          !selected && groups.map(layer => h('div', { key: layer.top, className: 'dsh-code-wiki-diagram-components' },
            h('h4', null, layer.title),
            layer.nodes.map(node => h('button', { key: node.id, type: 'button', onClick: () => {
              selectNode(node.id)
              detailsHeadingRef.current?.focus()
            } }, node.title)))),
          Boolean(relations.length) && h('h4', null, '模块关系'),
          h('ul', null, relations.map((edge, index) => h('li', { key: index },
            h('strong', null, nodes.get(edge.from).title + ' → ' + nodes.get(edge.to).title),
            h('span', null, edge.label),
            edge.refs.map((ref, i) => sourceLink(ref, { key: i }, ref.label)),
          ))),
          selected && !relations.length && h('p', null, '当前文档未记录该组件的已验证连接。'),
        ),
        )))
    }

    function chapterSections(markdown) {
      const titles = []
      outsideCode(markdown, line => {
        // Chapters are demoted by one level while splitting, so a section arrives as a second-level heading.
        const heading = /^ {0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)
        if (heading) titles.push(heading[1].replace(/\\([^\w\s])/g, '$1').trim())
        return line
      })
      return [...new Set(titles.filter(Boolean))].slice(0, 10)
    }

    function WikiArticle({ result, chapterIndex, headingRef, walkthroughControls }) {
      const chapter = result.chapters[chapterIndex]
      const repository = repositoryLabel(result)
      const title = result.documentTitle
      const isDocumentTitle = title && title !== chapter.title
        && ![repository + ' Wiki', repository + ' 架构 Wiki'].includes(title)
      const shortCommit = result.commit.slice(0, 12)
      const placedInline = result.chapters.some(item => item.markdown.includes('```dsh-architecture'))
      const hasChapterDesign = result.views.some(view => view.chapter !== undefined)
      const overview = !hasChapterDesign && !placedInline && chapterIndex === 0 && result.architecture
        ? introductionBeforeGraph(chapter.markdown) : null
      const chapterViews = result.views.filter(view => view.chapter === undefined || view.chapter === chapterIndex)
      const prose = markdown => markdown.trim() && h('div', { className: 'dsh-code-wiki-prose' },
        approvedViewBlocks(markdown, chapterViews, result.format === 'skill-markdown').map((block, i) => block.architecture
          ? result.architecture && h(ArchitectureGraph, { key: 'architecture-' + i, graph: result.architecture })
          : block.view
            ? h(WikiView, { key: (block.view.id ?? 'mermaid') + '-' + i, view: block.view })
            : block.markdown.trim() && h(MarkdownText, { key: i, text: block.markdown, labels, omitHtml: true })))
      const sections = chapterSections(chapter.markdown)
      const revision = h(React.Fragment, null,
        h('span', { 'aria-hidden': true }, h(IconBranchOutlineRegular, { size: 14 })),
        h('code', null, shortCommit),
      )
      const walkthrough = chapterIndex === 0 && result.walkthrough && h(WikiWalkthrough, { key: result.id, walkthrough: result.walkthrough,
        graph: result.architecture, chapterTitles: result.chapters.map(item => item.title), ...walkthroughControls })

      return h('article', { className: 'dsh-code-wiki-article', 'aria-label': '文档正文', 'data-chapter-design': hasChapterDesign || undefined },
        h('header', { className: 'dsh-code-wiki-article-header' },
          isDocumentTitle && h('p', { className: 'dsh-code-wiki-eyebrow' }, title),
          h('h1', { ref: headingRef, tabIndex: -1, className: 'dsh-code-wiki-article-title' }, chapter.title),
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
        sections.length > 1 && h('nav', { className: 'dsh-code-wiki-sections', 'aria-label': '本章小节' },
          sections.map(section => h('button', { key: section, type: 'button', onClick: event => {
            const article = event.currentTarget.closest('article')
            const target = [...(article?.querySelectorAll('h2, h3') ?? [])].find(node => node.textContent.trim() === section)
            target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
          } }, section))),
        !hasChapterDesign && walkthrough,
        prose(overview ? overview.introduction : chapter.markdown),
        overview && h(ArchitectureGraph, { key: result.id, graph: result.architecture }),
        overview && prose(overview.remaining),
        hasChapterDesign && walkthrough,
        chapter.references && h('details', { className: 'dsh-code-wiki-sources' },
          h('summary', null, '本章引用', h('span', null, chapter.referenceCount)),
          h('div', { className: 'dsh-code-wiki-prose' },
            h(MarkdownText, { text: chapter.references, labels, omitHtml: true }))),
      )
    }

    function CodeWikiPage({ wiki }) {
      const snapshot = useSyncExternalStore(wiki.subscribe, wiki.getSnapshot)
      const { result, chapterIndex, formOpen, loading, picking, browserOpen,
        documents, historyStatus, historyError, openingId, returnDocumentId, generation, progressOffline, deletion, error } = snapshot
      const formId = useId()
      const page = useRef(null)
      const articleHeading = useRef(null)
      const focusChapter = useRef(false)
      const [walkthroughProgress, setWalkthroughProgress] = useState(null)
      const documentId = result?.id
      const repository = result && repositoryLabel(result)
      const showForm = formOpen && !loading

      useEffect(() => {
        void wiki.loadHistory()
        void wiki.resumeGeneration()
      }, [wiki])
      useEffect(() => {
        if (documentId) articleHeading.current?.focus({ preventScroll: true })
      }, [documentId])
      useEffect(() => {
        if (documentId && page.current) page.current.scrollTop = 0
        if (focusChapter.current) {
          focusChapter.current = false
          articleHeading.current?.focus({ preventScroll: true })
        }
      }, [documentId, chapterIndex])

      const walkthroughControls = result?.walkthrough && {
        selection: walkthroughProgress?.id === documentId ? walkthroughProgress.selection : initialWalkthroughSelection,
        setSelection(update) {
          setWalkthroughProgress(previous => ({ id: documentId,
            selection: update(previous?.id === documentId ? previous.selection : initialWalkthroughSelection) }))
        },
        onSelectChapter(index) {
          if (index === chapterIndex) return
          focusChapter.current = true
          wiki.selectChapter(index)
        },
      }

      const progress = generation && !(generation.phase === 'completed' && documentId === generation.id) && h(GenerationProgress, {
        generation, progressOffline, openDocument: wiki.openDocument,
      })

      return h('section', {
        'aria-label': panelTitle, className: 'dsh-code-wiki-page', 'data-reading': result ? '' : undefined, ref: page,
      },
        h('style', null, codeWikiStyles),
        deletion && h(DeleteDocumentDialog, { deletion, wiki }),
        h('div', { className: 'dsh-code-wiki-shell' },
          h('header', { className: 'dsh-code-wiki-bar' },
            result ? h('nav', { className: 'dsh-code-wiki-breadcrumb', 'aria-label': '当前位置' },
              h('button', { className: 'dsh-code-wiki-library-link', type: 'button', onClick: wiki.returnToHistory }, '文档库'),
              h(IconChevronRightOutlineRegular, { size: 13, 'aria-hidden': true }),
              result.source === 'github'
                ? h('a', { href: result.repoUrl, target: '_blank', rel: 'noreferrer', title: '在 GitHub 打开 ' + repository }, repository)
                : h('span', { title: result.repositoryPath }, repository),
            ) : h('h1', { className: 'dsh-code-wiki-brand' },
              h('span', { className: 'dsh-code-wiki-brand-icon', 'aria-hidden': true }, h(CodeWikiIcon, { size: 20 })),
              '文档库'),
            h('div', { className: 'dsh-code-wiki-actions' },
              result ? h(VideoPanel, { key: result.id, documentId: result.id, hasArchitecture: Boolean(result.architecture), repository })
                : h(Button, {
                  type: 'button', variant: showForm ? 'outline' : 'primary', size: 'sm',
                  icon: showForm ? undefined : h(IconPlusOutlineRegular, { size: 16 }),
                  disabled: loading || picking || browserOpen,
                  'aria-expanded': showForm,
                  'aria-controls': showForm ? formId : undefined,
                  onClick: () => wiki.setFormOpen(!showForm),
                }, showForm ? '取消新建' : '新建 Wiki')),
          ),
          result ? h('div', { className: 'dsh-code-wiki-columns' },
            h('aside', { className: 'dsh-code-wiki-sidebar' },
              h(ChapterDirectory, { chapters: result.chapters, chapterIndex, selectChapter: wiki.selectChapter })),
            h('div', { className: 'dsh-code-wiki-main' },
              progress,
              h(WikiArticle, { result, chapterIndex, headingRef: articleHeading, walkthroughControls })),
          ) : h('div', { className: 'dsh-code-wiki-library' },
            progress,
            showForm && h(GenerationForm, { wiki, formId, ...snapshot }),
            error && !showForm && h('p', { role: 'alert', className: 'dsh-code-wiki-feedback', 'data-error': 'true' }, error),
            h(DocumentHistory, { wiki, documents, historyStatus, historyError, openingId, returnDocumentId })),
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
