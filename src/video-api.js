import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { generateVideoPlan, videoRepository } from './video-plan.js'
import { speechProvider, voiceVideo } from './video-speech.js'
import { createVideoStorage, validVideoId } from './video-storage.js'

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
const hasJson = request => request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json'
const voiceModes = new Set(['charon', 'alternative', 'none'])

export function registerVideoApi(ctx, config, documents, selectModel, lifetime) {
  const storage = createVideoStorage(join(ctx.profileContext.dir, 'dsh-code-wiki', 'videos'))
  const jobs = new Map()
  let active
  const status = job => {
    if (!job) return null
    const { stop, startedAt, finishedAt, ...result } = job
    return { ...result, elapsedMs: (finishedAt ?? Date.now()) - startedAt }
  }
  function register(suffix, methods, fetch) {
    ctx.connection.fetch.register({ path: '/api/dsh-code-wiki/video' + suffix, methods, requestBody: 'buffered', fetch })
  }
  async function run(job, document, provider) {
    const timeout = AbortSignal.timeout(10 * 60_000)
    const signal = AbortSignal.any([lifetime.signal, job.stop.signal, timeout])
    try {
      const { llm, selection } = await selectModel(ctx, config?.modelConfigFile, signal)
      job.model = selection.model
      const plan = await generateVideoPlan(llm, selection, document, signal, phase => { job.phase = phase })
      job.phase = 'voicing'
      job.scenes = plan.scenes.length
      const voiced = await voiceVideo(plan, provider, signal, done => { job.voiced = done })
      signal.throwIfAborted()
      job.phase = 'saving'
      const { clips, ...content } = voiced
      const artifact = { version: 1, id: job.id, documentId: document.id,
        repository: videoRepository(document), commit: document.commit, title: plan.title,
        source: document.source, ...(document.repoUrl && { repoUrl: document.repoUrl }),
        ...(plan.language && { language: plan.language }),
        model: selection.model, createdAt: new Date().toISOString(), ...content }
      await storage.save(artifact, clips)
      Object.assign(job, { phase: 'completed', artifact, finishedAt: Date.now() })
    } catch (error) {
      let message = '视频生成失败，请重试。'
      if (timeout.aborted) message = '视频生成达到十分钟上限，请重试。'
      else if (signal.aborted) message = '视频生成已取消。'
      else if (['video-plan-invalid', 'video-voice-failed'].includes(error.code)) message = error.message
      else if (error.code === 'model-unavailable') message = error.providerCode === 'MODEL_CONFIG'
        ? '无法读取本地模型配置。' : `讲解模型调用失败${error.providerCode ? `（${error.providerCode}）` : ''}，请检查模型配置后重试。`
      Object.assign(job, { phase: signal.aborted ? 'cancelled' : 'failed', error: message, finishedAt: Date.now() })
    } finally { if (active === job) active = undefined }
  }
  register('/capabilities', ['GET'], async () => {
    try {
      const { available, label, kind, error } = await speechProvider(config?.voiceConfigFile, lifetime.signal, 'charon', config?.modelConfigFile)
      return json({ speech: { available, label, kind, error } })
    } catch (error) {
      return json({ speech: { available: false, label: 'Charon · Gemini 3.8 Flash TTS',
        error: error?.code === 'video-voice-failed' ? error.message : '无法读取语音设置。' } })
    }
  })
  register('', ['GET', 'POST'], async request => {
    if (request.method === 'GET') {
      const id = new URL(request.url).searchParams.get('documentId')
      if (!validVideoId(id)) return json({ error: '文档编号无效。' }, 400)
      try {
        if (!await documents.get(id)) return json({ error: '文档不存在。' }, 404)
        const recent = [...jobs.values()].findLast(job => job.documentId === id)
        return json({ artifact: await storage.latest(id), job: active?.documentId === id ? status(active) : null,
          ...(recent?.phase === 'failed' && { lastFailure: recent.error }) })
      } catch { return json({ error: '无法读取视频。' }, 500) }
    }
    if (!hasJson(request)) return json({ error: '请求必须是 JSON。' }, 415)
    const body = await request.json().catch(() => null)
    if (!validVideoId(body?.documentId) || (body.narration !== undefined && typeof body.narration !== 'boolean')
      || (body.voice !== undefined && (body.narration !== undefined || !voiceModes.has(body.voice)))) return json({ error: '视频请求无效。' }, 400)
    if (active) return json({ error: '已有讲解视频正在生成，请稍后重试。', job: status(active) }, 409)
    // Reserve before any awaited reads, so two concurrent requests cannot both start.
    const job = { id: randomUUID(), documentId: body.documentId, phase: 'scripting', startedAt: Date.now(), stop: new AbortController() }
    active = job
    try {
      const document = await documents.get(body.documentId)
      if (!document) return json({ error: '文档不存在。' }, 404)
      if (!document.architecture?.layers?.length) return json({ error: '请先生成包含整体架构的 Wiki。' }, 422)
      const mode = body.voice ?? (body.narration === false ? 'none' : 'charon')
      const provider = mode === 'none' ? { available: false, kind: 'none', label: '字幕版' }
        : await speechProvider(config?.voiceConfigFile, lifetime.signal, mode, config?.modelConfigFile)
      if (mode !== 'none' && !provider.available) return json({ error: provider.error || '没有可用的英语语音。' }, 422)
      jobs.set(job.id, job)
      if (jobs.size > 16) jobs.delete(jobs.keys().next().value)
      void run(job, document, provider)
      return json({ job: status(job) }, 202)
    } catch (error) {
      if (error.code === 'video-voice-failed') return json({ error: error.message }, 422)
      return json({ error: '无法准备视频，请检查文档和语音配置。' }, 500)
    }
    finally { if (!jobs.has(job.id) && active === job) active = undefined }
  })
  register('/job', ['GET', 'POST'], async request => {
    if (request.method === 'GET') return json({ job: status(jobs.get(new URL(request.url).searchParams.get('id'))) })
    if (!hasJson(request)) return json({ error: '请求必须是 JSON。' }, 415)
    const body = await request.json().catch(() => null)
    const job = jobs.get(body?.id)
    if (job && job === active) job.stop.abort()
    return json({ job: status(job) })
  })
  register('/audio', ['GET'], async request => {
    const query = new URL(request.url).searchParams
    const rawIndex = query.get('scene')
    if (!rawIndex || !/^\d$/.test(rawIndex)) return json({ error: '音频不存在。' }, 404)
    try {
      if (!await documents.get(query.get('documentId'))) return json({ error: '文档不存在。' }, 404)
      const audio = await storage.audio(query.get('documentId'), query.get('id'), Number(rawIndex))
      if (!audio) return json({ error: '音频不存在。' }, 404)
      return new Response(audio, { headers: { 'content-type': 'audio/wav', 'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff' } })
    } catch { return json({ error: '无法读取音频。' }, 500) }
  })
  return {
    busy: documentId => Boolean(active && active.documentId === documentId),
    async remove(documentId) {
      await storage.remove(documentId)
      for (const [id, job] of jobs) if (job.documentId === documentId) jobs.delete(id)
    },
  }
}
