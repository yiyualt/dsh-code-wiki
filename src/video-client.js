function createCodeWikiVideo(React, primitives) {
  const { createElement: h, useEffect, useId, useRef, useState } = React
  const { Button } = primitives
  const labels = { reading: '读取素材', scripting: '编写讲稿', designing: '设计分镜', reviewing: '检查分镜', voicing: '生成配音', saving: '保存视频' }
  const running = job => job && !['completed', 'failed', 'cancelled'].includes(job.phase)
  const timeLabel = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
  function Icon({ name, size = 18 }) {
    const paths = { play: 'M8 5l11 7-11 7z', pause: 'M8 5v14M16 5v14',
      close: 'M6 6l12 12M18 6L6 18', full: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
      captions: 'M4 5h16v14H4zM10 10H7v4h3M17 10h-3v4h3', replay: 'M4 10a8 8 0 1 1 1 8M4 4v6h6',
      download: 'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5' }
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: name === 'play' ? 'currentColor' : 'none',
      stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: paths[name] || paths.play }))
  }
  const endpoint = (path = '', query = {}) => {
    const url = new URL('api/dsh-code-wiki/video' + path, document.baseURI)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    return url
  }
  async function request(path, query, body, signal) {
    const response = await fetch(endpoint(path, query), { credentials: 'same-origin',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      ...(body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '视频请求失败。')
    return result
  }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)
      const cancel = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, ms)
      signal.addEventListener('abort', cancel, { once: true })
    })
  }
  function supportedRecording(hasAudio) {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return null
    const types = hasAudio
      ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    return types.find(type => MediaRecorder.isTypeSupported(type)) || null
  }

  // Web Audio is the single clock for preview and recording, including seek/resume.
  function createAudioClock(film) {
    const Audio = window.AudioContext || window.webkitAudioContext
    if (!Audio) throw new Error('当前浏览器不支持音频播放，请使用新版 Chrome、Edge 或 Safari。')
    const context = new Audio()
    let buffers
    let sources = []
    let origin = 0
    let position = 0
    let playing = false
    let rate = 1
    function pause() {
      position = now()
      playing = false
      for (const source of sources) { try { source.stop() } catch {} source.disconnect() }
      sources = []
    }
    function now() { return Math.min(film.duration, playing ? position + (context.currentTime - origin) * rate : position) }
    return {
      context, now, pause,
      async load(signal) {
        await context.resume()
        if (!buffers && film.speech.available) {
          const loaded = []
          for (let i = 0; i < film.scenes.length; i++) {
            const response = await fetch(endpoint('/audio', { documentId: film.documentId, id: film.id, scene: i }), { credentials: 'same-origin', signal })
            if (!response.ok) throw new Error('无法读取配音，请重新打开视频。')
            loaded.push(await context.decodeAudioData(await response.arrayBuffer()))
          }
          buffers = loaded
        }
      },
      play(at, destination, speed = 1) {
        pause()
        origin = context.currentTime
        position = at
        rate = speed
        playing = true
        if (!buffers) return
        film.scenes.forEach((scene, i) => {
          const start = scene.start + (scene.audioOffset ?? 0.2)
          if (start + buffers[i].duration <= at) return
          const source = context.createBufferSource()
          source.buffer = buffers[i]
          source.playbackRate.value = rate
          source.connect(destination || context.destination)
          source.start(origin + Math.max(0, start - at) / rate, Math.max(0, at - start))
          sources.push(source)
        })
      },
      dispose() { pause(); void context.close().catch(() => {}) },
    }
  }

  function Player({ film, regeneration }) {
    const shell = useRef(null)
    const canvas = useRef(null)
    const clock = useRef(null)
    const frame = useRef(0)
    const lifetime = useRef(null)
    const record = useRef(null)
    const download = useRef(null)
    const regenerationTrigger = useRef(null)
    const current = useRef(0)
    const [position, setPosition] = useState(0)
    const [playing, setPlaying] = useState(false)
    const [preparing, setPreparing] = useState(false)
    const [exporting, setExporting] = useState(false)
    const [error, setError] = useState('')
    const [file, setFile] = useState(null)
    const [full, setFull] = useState(false)
    const [speed, setSpeed] = useState(1)
    const speedRef = useRef(1)
    const [captions, setCaptions] = useState(true)
    const captionsRef = useRef(true)
    const regenerationId = useId()
    const mime = supportedRecording(film.speech.available)
    const extension = mime?.startsWith('video/mp4') ? 'mp4' : 'webm'

    function draw(time) {
      current.current = Math.min(film.duration, Math.max(0, time))
      if (canvas.current) codeWikiVideoFrame(canvas.current, film, current.current, { captions: record.current ? true : captionsRef.current })
      setPosition(current.current)
    }
    function pause() {
      cancelAnimationFrame(frame.current)
      clock.current?.pause()
      setPlaying(false)
    }
    function loop() {
      const time = clock.current.now()
      draw(time)
      if (time >= film.duration) {
        pause()
        if (record.current?.recorder.state === 'recording') record.current.recorder.stop()
        return
      }
      frame.current = requestAnimationFrame(loop)
    }
    function cancelExport(message = '') {
      const task = record.current
      if (!task) return
      task.cancelled = true
      pause()
      if (task.recorder.state !== 'inactive') task.recorder.stop()
      setExporting(false)
      if (message) setError(message)
    }
    useEffect(() => {
      const controller = new AbortController()
      lifetime.current = controller
      draw(0)
      void prepareMotionImages(film).then(() => { if (!controller.signal.aborted) draw(current.current) })
      // Font loading can finish after the first still is drawn.
      document.fonts?.ready.then(() => { if (!controller.signal.aborted && !clock.current) draw(current.current) })
      const visibility = () => {
        if (document.hidden && record.current) cancelExport('导出已停止：页面切到了后台。请保持此页面可见后重新导出。')
      }
      document.addEventListener('visibilitychange', visibility)
      const fullscreen = () => setFull(document.fullscreenElement === shell.current)
      document.addEventListener('fullscreenchange', fullscreen)
      return () => {
        controller.abort()
        cancelAnimationFrame(frame.current)
        const task = record.current
        if (task) { task.cancelled = true; if (task.recorder.state !== 'inactive') task.recorder.stop() }
        clock.current?.dispose()
        if (download.current) URL.revokeObjectURL(download.current)
        document.removeEventListener('visibilitychange', visibility)
        document.removeEventListener('fullscreenchange', fullscreen)
      }
    }, [film.id])
    async function audio() {
      if (!clock.current) clock.current = createAudioClock(film)
      await prepareMotionImages(film)
      await clock.current.load(lifetime.current.signal)
      lifetime.current.signal.throwIfAborted()
      return clock.current
    }
    async function play(at = current.current >= film.duration ? 0 : current.current) {
      setError('')
      setPreparing(true)
      try {
        const player = await audio()
        cancelAnimationFrame(frame.current)
        player.play(at, undefined, speedRef.current)
        setPlaying(true)
        frame.current = requestAnimationFrame(loop)
      } catch (failure) { if (!lifetime.current.signal.aborted) setError(failure.message || '播放失败。') }
      finally { if (!lifetime.current.signal.aborted) setPreparing(false) }
    }
    function seek(at) {
      draw(at)
      if (!playing) return
      if (current.current >= film.duration) pause()
      else clock.current.play(current.current, undefined, speedRef.current)
    }
    function cycleSpeed() {
      const rates = [1, 1.25, 1.5, 2, 0.75]
      const next = rates[(rates.indexOf(speedRef.current) + 1) % rates.length]
      const at = clock.current?.now() ?? current.current
      speedRef.current = next
      setSpeed(next)
      if (playing) clock.current.play(at, undefined, next)
    }
    function toggleCaptions() {
      captionsRef.current = !captionsRef.current
      setCaptions(captionsRef.current)
      draw(current.current)
    }
    function toggleFull() {
      if (document.fullscreenElement) void document.exitFullscreen()
      else if (full) setFull(false)
      else if (shell.current?.requestFullscreen && document.fullscreenEnabled) {
        void shell.current.requestFullscreen().catch(() => setFull(true))
      } else setFull(true)
    }
    function keyboard(event) {
      if (event.key === 'Escape' && full && !document.fullscreenElement) {
        event.preventDefault(); event.stopPropagation(); setFull(false); return
      }
      if (exporting || preparing || event.target.closest('button, input, summary, a')) return
      if (event.key === ' ' || event.key.toLowerCase() === 'k') {
        event.preventDefault(); playing ? pause() : void play()
      } else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault(); seek(current.current + (event.key === 'ArrowLeft' ? -5 : 5))
      }
    }
    async function exportFilm() {
      if (!mime) { setError('当前浏览器不支持视频导出，请使用新版 Chrome、Edge 或 Safari。'); return }
      pause()
      setError('')
      setPreparing(true)
      let stream
      let destination
      try {
        const player = await audio()
        draw(0)
        stream = canvas.current.captureStream(30)
        if (film.speech.available) {
          destination = player.context.createMediaStreamDestination()
          for (const track of destination.stream.getAudioTracks()) stream.addTrack(track)
        }
        const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3_500_000, audioBitsPerSecond: 128_000 })
        const task = { recorder, cancelled: false }
        record.current = task
        draw(0)
        const chunks = []
        let bytes = 0
        const completion = new Promise((resolve, reject) => {
          recorder.ondataavailable = event => {
            if (!event.data.size) return
            bytes += event.data.size
            if (bytes > 120 * 1024 * 1024) { cancelExport('导出文件过大，已停止。'); return }
            chunks.push(event.data)
          }
          recorder.onerror = () => reject(new Error('浏览器编码失败，请重试或换用新版 Chrome。'))
          recorder.onstop = resolve
        })
        recorder.start(1000)
        setExporting(true)
        setPlaying(true)
        player.play(0, destination)
        frame.current = requestAnimationFrame(loop)
        await completion
        if (!task.cancelled && !lifetime.current.signal.aborted) {
          const blob = new Blob(chunks, { type: recorder.mimeType })
          if (!blob.size) throw new Error('浏览器没有生成有效视频。')
          if (download.current) URL.revokeObjectURL(download.current)
          download.current = URL.createObjectURL(blob)
          const name = film.repository.replace(/[^\w\u4e00-\u9fff.-]+/g, '-') + '-仓库介绍.' + extension
          setFile({ url: download.current, name })
          const anchor = document.createElement('a')
          anchor.href = download.current
          anchor.download = name
          anchor.click()
        }
      } catch (failure) { if (!lifetime.current.signal.aborted) setError(failure.message || '导出失败。') }
      finally {
        if (record.current?.recorder.state === 'recording') record.current.recorder.stop()
        record.current = null
        stream?.getTracks().forEach(track => track.stop())
        destination?.disconnect()
        if (!lifetime.current.signal.aborted) { pause(); setPreparing(false); setExporting(false) }
      }
    }
    const sceneIndex = Math.max(0, film.scenes.findLastIndex(scene => position >= scene.start))
    return h('div', { className: 'dsh-code-wiki-video-player' },
      h('div', { ref: shell, className: 'dsh-code-wiki-video-shell', 'data-expanded': full || undefined,
        tabIndex: 0, onKeyDown: keyboard, 'aria-label': '视频播放器' },
      h('div', { className: 'dsh-code-wiki-video-stage' },
        h('canvas', { ref: canvas, width: 1280, height: 720, role: 'img', 'aria-label': `${film.title}：${film.scenes[sceneIndex].title}` }),
        h('button', { type: 'button', className: 'dsh-code-wiki-video-surface', disabled: preparing || exporting,
          'aria-label': playing ? '暂停讲解' : '播放讲解', onClick: playing ? pause : () => void play() },
          !playing && h('span', { className: 'dsh-code-wiki-video-big-play' },
            h(Icon, { name: position >= film.duration ? 'replay' : 'play', size: 32 })))),
      h('div', { className: 'dsh-code-wiki-video-controls' },
        h('button', { type: 'button', className: 'dsh-code-wiki-video-control', disabled: preparing || exporting,
          'aria-label': playing ? '暂停' : '播放', onClick: playing ? pause : () => void play() }, h(Icon, { name: playing ? 'pause' : 'play' })),
        h('input', { type: 'range', min: 0, max: film.duration, step: 0.1, value: position,
          disabled: exporting || preparing, 'aria-label': '视频播放进度', 'aria-valuetext': `${timeLabel(position)} / ${timeLabel(film.duration)}`,
          onChange: event => seek(Number(event.target.value)), onKeyDown: event => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
              event.preventDefault(); seek(current.current + (['ArrowLeft', 'ArrowDown'].includes(event.key) ? -5 : 5))
            }
          } }),
        h('span', { className: 'dsh-code-wiki-video-time' }, `${timeLabel(position)} / ${timeLabel(film.duration)}`),
        h('button', { type: 'button', className: 'dsh-code-wiki-video-control', disabled: preparing || exporting,
          'aria-label': `播放速度 ${speed} 倍，点击切换`, onClick: cycleSpeed }, `${speed}×`),
        h('button', { type: 'button', className: 'dsh-code-wiki-video-control', disabled: exporting, 'aria-pressed': captions,
          'aria-label': captions ? '隐藏字幕' : '显示字幕', onClick: toggleCaptions }, h(Icon, { name: 'captions' })),
        h('button', { type: 'button', className: 'dsh-code-wiki-video-control', 'aria-label': full ? '退出全屏' : '全屏',
          onClick: toggleFull }, h(Icon, { name: full ? 'close' : 'full' })))),
      h('div', { className: 'dsh-code-wiki-video-scene-heading' },
        h('h3', null, '场景'),
        h('div', { className: 'dsh-code-wiki-video-actions' },
          regeneration && !regeneration.requested && h('button', { type: 'button',
            ref: regenerationTrigger,
            className: 'dsh-code-wiki-video-action dsh-code-wiki-video-action-quiet', disabled: preparing || exporting,
            'aria-expanded': false, 'aria-controls': regenerationId,
            onClick: () => { pause(); regeneration.onRequest() } }, h(Icon, { name: 'replay', size: 14 }), '重新生成'),
          exporting ? h('button', { type: 'button', className: 'dsh-code-wiki-video-action', onClick: () => cancelExport() }, '取消导出')
            : h('button', { type: 'button', className: 'dsh-code-wiki-video-action', disabled: preparing || !mime || regeneration?.requested,
              onClick: () => void exportFilm() }, h(Icon, { name: 'download', size: 14 }), `导出 ${extension.toUpperCase()}`))),
      regeneration?.requested && h('div', { id: regenerationId, className: 'dsh-code-wiki-video-confirm', role: 'group', 'aria-label': '重新生成视频' },
        h('p', null, regeneration.available ? '重新生成完成后，将替换当前视频。' : regeneration.error || '当前没有可用的 Charon 配音服务。'),
        h('div', { className: 'dsh-code-wiki-video-actions' },
          h('button', { type: 'button', className: 'dsh-code-wiki-video-action dsh-code-wiki-video-action-quiet',
            autoFocus: true, disabled: regeneration.starting, onClick: () => {
              regeneration.onCancel()
              requestAnimationFrame(() => regenerationTrigger.current?.focus())
            } }, '取消'),
          h('button', { type: 'button', className: 'dsh-code-wiki-video-action dsh-code-wiki-video-primary',
            disabled: regeneration.starting || !regeneration.available, onClick: regeneration.onConfirm }, regeneration.starting ? '正在提交…' : '重新生成')),
      ),
      exporting && h('p', { role: 'status' }, `正在导出 ${Math.round(position / film.duration * 100)}% · 请保持此页面可见，约需 ${timeLabel(film.duration)}。`),
      preparing && !exporting && h('p', { role: 'status' }, '正在准备音频…'),
      !mime && h('p', null, '当前浏览器不支持视频导出，请使用新版 Chrome、Edge 或 Safari。'),
      file && h('a', { href: file.url, download: file.name, className: 'dsh-code-wiki-video-download' }, `再次下载 ${file.name}`),
      error && h('p', { role: 'alert', className: 'dsh-code-wiki-error' }, error),
      h('div', { className: 'dsh-code-wiki-video-scenes', role: 'group', 'aria-label': '视频场景' },
        film.scenes.map((scene, i) => h('button', { key: scene.id, type: 'button', disabled: exporting || preparing,
          'aria-current': sceneIndex === i ? 'true' : undefined, onClick: () => seek(scene.start) },
        h('small', null, timeLabel(scene.start)), h('span', null, scene.title)))),
    )
  }

  return function VideoPanel({ documentId, hasArchitecture, repository }) {
    const [open, setOpen] = useState(false)
    const [film, setFilm] = useState(null)
    const [job, setJob] = useState(null)
    const [error, setError] = useState('')
    const [generationFailed, setGenerationFailed] = useState(false)
    const [loading, setLoading] = useState(true)
    const [starting, setStarting] = useState(false)
    const [lookupError, setLookupError] = useState(false)
    const [lookup, setLookup] = useState(0)
    const [speech, setSpeech] = useState(null)
    const [regenerate, setRegenerate] = useState(false)
    const headingId = useId()
    const configurationHintId = useId()
    const control = useRef(null)
    const dialog = useRef(null)
    const entry = useRef(null)
    const submitting = useRef(false)
    const busy = running(job)
    useEffect(() => {
      const controller = new AbortController()
      control.current = controller
      return () => controller.abort()
    }, [documentId])
    useEffect(() => {
      if (open && !dialog.current.open) dialog.current.showModal()
      else if (!open && dialog.current.open) dialog.current.close()
    }, [open])
    // Opening a document does nothing. Opening Video only looks up saved results.
    // The POST that starts generation is reachable only from the explicit button.
    useEffect(() => {
      if (!open || busy || submitting.current) return
      const lookupController = new AbortController()
      const signal = AbortSignal.any([control.current.signal, lookupController.signal])
      setLoading(true)
      setLookupError(false)
      setError('')
      setGenerationFailed(false)
      void (async () => {
        try {
          const [saved, capability] = await Promise.all([
            request('', { documentId }, null, signal), request('/capabilities', {}, null, signal),
          ])
          if (signal.aborted) return
          setFilm(saved.artifact)
          setSpeech(capability.speech)
          if (saved.job) void follow(saved.job, control.current.signal)
          else if (saved.lastFailure) { setGenerationFailed(true); setError(saved.lastFailure) }
        } catch (failure) {
          if (!signal.aborted) { setError(failure.message); setLookupError(true) }
        } finally { if (!signal.aborted) setLoading(false) }
      })()
      return () => lookupController.abort()
    }, [open, lookup, documentId])
    async function follow(initial, signal) {
      let next = initial
      try {
        while (!signal.aborted) {
          setJob(next)
          if (!running(next)) {
            if (next.phase === 'completed') { setFilm(next.artifact); setError(''); setRegenerate(false) }
            else if (next.phase === 'failed') { setGenerationFailed(true); setError(next.error || '生成失败，请重试。') }
            return
          }
          await delay(1500, signal)
          try {
            const result = await request('/job', { id: next.id }, null, signal)
            if (!result.job) { setJob(null); setError('任务已失效，服务可能已重启。请重新生成。'); return }
            next = result.job
            setError('')
          } catch {
            if (signal.aborted) return
            setError('连接暂时中断，正在重试。服务端任务会继续。')
          }
        }
      } catch { /* Leaving this document stops following, not the server job. */ }
    }
    async function generate() {
      if (submitting.current || busy || loading || lookupError || !speech?.available) return
      submitting.current = true
      setError('')
      setGenerationFailed(false)
      setStarting(true)
      const signal = control.current.signal
      try {
        const result = await request('', {}, { documentId, voice: 'charon' }, signal)
        await follow(result.job, signal)
      } catch (failure) { if (!signal.aborted) setError(failure.message) }
      finally { submitting.current = false; if (!signal.aborted) setStarting(false) }
    }
    async function cancel() {
      try { await request('/job', {}, { id: job.id }, control.current.signal) }
      catch (failure) { if (!control.current.signal.aborted) setError(failure.message) }
    }
    const showFilm = film && !busy && !lookupError
    const generationCard = h('div', { className: 'dsh-code-wiki-video-generate' },
      h('div', { className: 'dsh-code-wiki-video-generate-row' },
        h('div', null,
          h('h3', null, '暂无讲解视频'),
          h('p', null, hasArchitecture ? '英语男声 · Charon' : '请先生成包含架构图的 Wiki。')),
        hasArchitecture && h('div', { className: 'dsh-code-wiki-video-generate-actions' },
          h(Button, { type: 'button', size: 'sm', variant: 'primary', className: 'dsh-code-wiki-video-primary',
            disabled: starting || !speech?.available, 'aria-describedby': speech?.available ? undefined : configurationHintId,
            onClick: () => void generate() }, starting ? '正在提交…' : '生成视频'))),
      hasArchitecture && !speech?.available && h('p', { id: configurationHintId, className: 'dsh-code-wiki-video-generate-hint' },
        speech?.error || '当前没有可用的 Charon 配音服务。'))
    return h(React.Fragment, null,
      h(Button, { type: 'button', size: 'sm', variant: 'outline', className: 'dsh-code-wiki-video-entry',
        icon: h(Icon, { name: 'play', size: 14 }), 'aria-haspopup': 'dialog', onClick: event => {
          entry.current = event.currentTarget
          setOpen(true)
        } },
        busy ? '视频 · 生成中' : '视频'),
      h('dialog', {
        ref: dialog, className: 'dsh-code-wiki-video-dialog', 'aria-labelledby': headingId,
        'data-has-video': showFilm ? '' : undefined,
        onCancel: () => setOpen(false),
        onClose: () => {
          setOpen(false)
          setRegenerate(false)
          entry.current?.focus()
        },
      },
        open && h(React.Fragment, null,
          h('header', { className: 'dsh-code-wiki-video-heading' },
            h('div', null, h('h2', { id: headingId }, '仓库介绍'), h('p', null, repository)),
            h('button', { type: 'button', className: 'dsh-code-wiki-video-close', 'aria-label': '关闭视频', title: '关闭视频',
              onClick: () => setOpen(false) }, h(Icon, { name: 'close', size: 19 }))),
          h('div', { className: 'dsh-code-wiki-video-watch' },
            generationFailed && showFilm && error && h('p', { role: 'alert', className: 'dsh-code-wiki-video-failure' },
              h('strong', null, '重新生成失败，当前仍是上次保存的视频。'), h('span', null, error)),
            showFilm && h(Player, { key: film.id, film, regeneration: !loading && hasArchitecture ? {
              requested: regenerate, available: speech?.available, error: speech?.error, starting,
              onRequest: () => setRegenerate(true), onCancel: () => setRegenerate(false), onConfirm: () => void generate(),
            } : null }),
            !showFilm && !busy && loading && h('p', { role: 'status', className: 'dsh-code-wiki-video-lookup' },
              h('span', { className: 'dsh-code-wiki-video-spinner', 'aria-hidden': true }), '正在读取视频…'),
            !busy && !loading && !lookupError && !film && generationCard,
            busy && h('div', { className: 'dsh-code-wiki-video-generate' },
              h('div', { className: 'dsh-code-wiki-video-generate-row' },
                h('div', { role: 'status' },
                  h('h3', null, h('span', { className: 'dsh-code-wiki-video-spinner', 'aria-hidden': true }), labels[job.phase] || '准备视频'),
                  h('p', null, '关闭窗口后会继续生成。')),
                h(Button, { size: 'sm', variant: 'outline', onClick: () => void cancel() }, '取消生成'))),
            error && !(generationFailed && showFilm) && h('p', { role: 'alert', className: 'dsh-code-wiki-error' }, error),
            lookupError && h(Button, { size: 'sm', onClick: () => setLookup(value => value + 1) }, '重新读取视频'),
          ),
        ),
      ),
    )
  }
}
