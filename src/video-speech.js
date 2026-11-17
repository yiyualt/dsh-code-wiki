import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const voiceError = message => Object.assign(new Error(message), { code: 'video-voice-failed' })
const command = (file, args, signal) => exec(file, args, { signal, timeout: 90_000, maxBuffer: 1024 * 1024, windowsHide: true })
const speechEndpoint = 'https://openrouter.ai/api/v1/audio/speech'
const charonModel = 'google/gemini-3.8-flash-tts'
const gatewayCharonModel = 'gemini-3.1-flash-tts-preview'
const charonStyle = 'A warm, technically precise engineer speaking to a colleague. Keep the delivery understated, with gentle changes in pace and natural pauses at punctuation.'
const sampleRate = 24_000
const pcmBytesPerSecond = sampleRate * 2

// Duration comes from the actual PCM file; headers may contain extra chunks.
export function waveSeconds(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw voiceError('语音服务需要返回 PCM WAV 音频。')
  }
  let byteRate = 0
  let length = 0
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4)
    const kind = bytes.toString('ascii', offset, offset + 4)
    if (kind === 'fmt ' && size >= 16 && offset + 24 <= bytes.length) {
      if (![1, 3].includes(bytes.readUInt16LE(offset + 8))) throw voiceError('语音服务返回了不支持的 WAV 编码。')
      byteRate = bytes.readUInt32LE(offset + 16)
    }
    if (kind === 'data') length += Math.min(size, bytes.length - offset - 8)
    offset += 8 + size + (size % 2)
  }
  const seconds = length / byteRate
  if (!Number.isFinite(seconds) || seconds < 0.15 || seconds > 120) throw voiceError('未生成有效音频，请检查配音设置，或改用字幕版。')
  return seconds
}

async function requestSpeech(url, headers, body, signal) {
  const timeout = AbortSignal.timeout(90_000)
  const response = await fetch(url, { method: 'POST', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers,
    body: JSON.stringify(body) })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw voiceError(`配音服务调用失败（HTTP ${response.status}）。`)
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 16 * 1024 * 1024) throw voiceError('配音文件过大。')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function charonProvider(url, key) {
  return { available: true, kind: 'api', label: 'Charon · Gemini 3.8 Flash TTS',
    speakTake(text, signal) {
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` }
      return requestSpeech(url, headers, { model: charonModel, voice: 'Charon', input: text, response_format: 'pcm',
        provider: { options: { 'google-ai-studio': { speech_metadata: { style: charonStyle } } } } }, signal)
    } }
}

function modelCredential(config) {
  const envKey = typeof config.api_key_env === 'string' ? process.env[config.api_key_env]?.trim() : undefined
  return envKey || (typeof config.api_key === 'string' && config.api_key.trim())
}

async function gatewayCharonProvider(configFile, signal) {
  let endpoint
  let headers
  try {
    const config = JSON.parse(await readFile(configFile, { encoding: 'utf8', signal })).judge
    const judge = new URL(config.url)
    const key = modelCredential(config)
    if (!['http:', 'https:'].includes(judge.protocol) || judge.username || judge.password || judge.search || judge.hash
      || !judge.pathname.endsWith('/v1/chat/completions') || !key) return null
    endpoint = new URL(judge)
    endpoint.pathname = judge.pathname.replace(/\/v1\/chat\/completions$/, `/v1beta/models/${gatewayCharonModel}:generateContent`)
    headers = new Headers(config.headers ?? {})
    headers.set('content-type', 'application/json')
    headers.set('authorization', `Bearer ${key}`)
    headers.set('x-goog-api-key', key)
    if (!headers.has('user-agent')) headers.set('user-agent', 'DSH Code Wiki')
  } catch {
    signal?.throwIfAborted()
    return null
  }
  return { available: true, kind: 'api', label: 'Charon · Gemini 3.1 Flash TTS',
    async speakTake(text, signal) {
      const body = {
        contents: [{ role: 'user', parts: [{ text: `Read the following in a warm, conversational English tone:\n\n${text}` }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } } },
      }
      const response = await requestSpeech(endpoint, headers, body, signal)
      let audio
      try {
        const data = JSON.parse(response.toString('utf8'))
        audio = data.candidates?.[0]?.content?.parts?.find(part => part.inlineData)?.inlineData
      } catch { throw voiceError('Charon 配音返回了无效响应。') }
      const format = typeof audio?.mimeType === 'string' ? audio.mimeType.toLowerCase().split(';').map(part => part.trim()) : []
      const [media, ...attrs] = format
      const params = new Map(attrs.map(attr => attr.split('=').map(part => part.trim())))
      const encoded = audio?.data
      if (media !== 'audio/l16' || params.get('rate') !== String(sampleRate) || params.get('channels') !== '1'
        || typeof encoded !== 'string' || !encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        throw voiceError('Charon 配音未返回单声道 24 kHz PCM。')
      }
      return Buffer.from(encoded, 'base64')
    } }
}

function wrapPcm(pcm) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(pcm.length + 36, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(pcmBytesPerSecond, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function estimateSpeechWeight(text) {
  const words = text.match(/[\p{L}\p{N}'’-]+/gu) ?? []
  const pauses = text.match(/[,.!?]/g)?.length ?? 0
  return words.reduce((sum, word) => sum + 1 + 0.1 * Math.min(word.length, 12), 0) + pauses * 0.7 + 1
}

function splitTake(pcm, paragraphs) {
  const duration = pcm.length / pcmBytesPerSecond
  if (duration < paragraphs.length * 0.25 || duration > 120 || pcm.length % 2 || pcm.toString('ascii', 0, 4) === 'RIFF') {
    throw voiceError('Charon 配音的 PCM 格式或时长无效。')
  }

  // Find sustained quiet around the estimated end of each paragraph. This changes
  // scene timing only. The successive clips contain every sample of one take.
  const levels = []
  const frameBytes = pcmBytesPerSecond / 50
  for (let base = 0; base < pcm.length; base += frameBytes) {
    let sum = 0
    let count = 0
    for (let offset = base; offset < Math.min(base + frameBytes, pcm.length); offset += 8) {
      sum += Math.abs(pcm.readInt16LE(offset))
      count++
    }
    levels.push(sum / count)
  }
  const typical = levels.reduce((sum, level) => sum + level, 0) / levels.length
  if (typical < 45) throw voiceError('Charon 配音返回了静音。')
  const silence = Math.max(50, typical * 0.12)
  const pauses = []
  let quietStart = 0
  for (const [i, level] of levels.entries()) {
    if (level <= silence) continue
    if (i - quietStart >= 6 && quietStart > 0) pauses.push({ at: (quietStart + i) / 100, seconds: (i - quietStart) / 50 })
    quietStart = i + 1
  }

  const weights = paragraphs.map(estimateSpeechWeight)
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const boundaries = [0]
  let previous = 0
  for (let i = 0; i < paragraphs.length - 1; i++) {
    const remainingWeight = weights.slice(i).reduce((sum, weight) => sum + weight, 0)
    const expected = previous + (duration - previous) * weights[i] / remainingWeight
    const padding = Math.min(3, Math.max(0.4, duration * Math.min(weights[i], weights[i + 1]) / totalWeight * 0.25))
    const latest = duration - (paragraphs.length - i - 1) * 0.25
    let cut = Math.max(previous + 0.25, Math.min(latest, expected))
    let bestScore = Infinity
    for (const pause of pauses) {
      const difference = Math.abs(pause.at - expected)
      if (pause.at < previous + 0.25 || pause.at > latest || difference > padding) continue
      const score = difference - Math.min(0.6, pause.seconds) * 1.6
      if (score < bestScore) { cut = pause.at; bestScore = score }
    }
    previous = cut
    boundaries.push(Math.round(cut * sampleRate) * 2)
  }
  boundaries.push(pcm.length)
  return paragraphs.map((_, i) => pcm.subarray(boundaries[i], boundaries[i + 1]))
}

const unavailableCharon = { available: false, kind: 'api', label: 'Charon · Gemini 3.8 Flash TTS',
  error: '配置 OpenRouter API Key 后即可生成。' }

export async function speechProvider(configFile, signal, mode = 'charon', modelConfigFile) {
  if (configFile !== undefined) {
    let config
    try {
      config = JSON.parse(await readFile(configFile, { encoding: 'utf8', signal }))
      const url = new URL(config.url)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
        || !url.pathname.endsWith('/audio/speech') || typeof config.model !== 'string' || !config.model.trim()
        || typeof config.voice !== 'string' || !config.voice.trim()) throw new Error()
    } catch { throw voiceError('无法读取语音配置。请检查 voiceConfigFile。') }
    const isCharon = config.model === charonModel && config.voice.toLowerCase() === 'charon' && new URL(config.url).href === speechEndpoint
    if (isCharon === (mode === 'charon')) {
      const key = modelCredential(config)
      if (!key) throw voiceError(isCharon ? unavailableCharon.error : '自定义英语旁白缺少凭据。')
      if (isCharon) return charonProvider(config.url, key)
      return { available: true, kind: 'api', label: config.voice,
        async speak(text, signal) {
          const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` }
          const bytes = await requestSpeech(config.url, headers, { model: config.model, voice: config.voice, input: text, response_format: 'wav' }, signal)
          return { bytes, seconds: waveSeconds(bytes) }
        } }
    }
  }
  if (mode === 'charon') {
    const openRouterKey = process.env.OPENROUTER_API_KEY?.trim()
    if (openRouterKey) return charonProvider(speechEndpoint, openRouterKey)
    return (configFile === undefined && modelConfigFile ? await gatewayCharonProvider(modelConfigFile, signal) : null) ?? unavailableCharon
  }

  let executable
  let voice
  if (process.platform === 'darwin') {
    const { stdout } = await command('/usr/bin/say', ['-v', '?'], signal)
    const voices = stdout.split('\n').flatMap(line => {
      const match = /^(.+?)\s+(en_[A-Z]{2})\s+#/.exec(line)
      return match ? [{ name: match[1].trim(), locale: match[2] }] : []
    })
    const preferred = ['Tom', 'Oliver', 'Daniel', 'Ava', 'Allison', 'Serena', 'Samantha']
    voice = voices.find(item => /\b(?:Premium|Enhanced)\b/i.test(item.name))?.name
      ?? preferred.find(name => voices.some(item => item.name === name))
      ?? voices.find(item => item.locale === 'en_US' && /^Reed\b/.test(item.name))?.name
    executable = voice && '/usr/bin/say'
  } else if (process.platform === 'win32') {
    const { stdout } = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | Where-Object {$_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*'} | Sort-Object {$_.VoiceInfo.Culture.Name -ne 'en-US'} | ForEach-Object {$_.VoiceInfo.Name}; $s.Dispose()"], signal)
    voice = stdout.trim().split(/\r?\n/)[0]
    executable = voice && 'powershell.exe'
  } else {
    for (const name of ['espeak-ng', 'espeak']) {
      try { await command(name, ['--version'], signal); executable = name; voice = 'en-us'; break } catch { signal?.throwIfAborted() }
    }
  }
  if (!executable) return { available: false, kind: 'none', label: '字幕版' }
  return { available: true, kind: 'system', label: voice,
    async speak(text, signal) {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-wiki-voice-'))
      try {
        const input = join(dir, 'script.txt')
        const output = join(dir, 'voice.wav')
        await writeFile(input, text, { mode: 0o600 })
        if (process.platform === 'darwin') {
          await command(executable, ['-v', voice, '-r', '156', '-f', input, '-o', output,
            '--file-format=WAVE', '--data-format=LEI16@22050'], signal)
        } else if (process.platform === 'win32') {
          const script = join(dir, 'speak.ps1')
          await writeFile(script, `param([string]$SourceFile,[string]$DestinationFile,[string]$VoiceName)\nAdd-Type -AssemblyName System.Speech\n$s=New-Object System.Speech.Synthesis.SpeechSynthesizer\ntry {$s.SelectVoice($VoiceName); $s.SetOutputToWaveFile($DestinationFile); $s.Speak([IO.File]::ReadAllText($SourceFile, [Text.Encoding]::UTF8))} finally {$s.Dispose()}\n`, { mode: 0o600 })
          await command(executable, ['-NoProfile', '-NonInteractive', '-File', script, input, output, voice], signal)
        } else {
          await command(executable, ['-v', voice, '-s', '155', '-f', input, '-w', output], signal)
        }
        const bytes = await readFile(output)
        return { bytes, seconds: waveSeconds(bytes) }
      } finally { await rm(dir, { recursive: true, force: true }) }
    } }
}

export async function voiceVideo(plan, provider, signal, onScene = () => {}) {
  const clips = []
  let start = 0
  const scenes = []
  const continuous = provider.available && provider.speakTake
  let takes
  if (continuous) {
    const paragraphs = plan.scenes.map(scene => scene.narration)
    const pcm = await provider.speakTake(paragraphs.join('\n\n'), signal)
    signal.throwIfAborted()
    takes = splitTake(pcm, paragraphs)
  }
  for (const [i, scene] of plan.scenes.entries()) {
    signal.throwIfAborted()
    const take = takes ? { bytes: wrapPcm(takes[i]), seconds: takes[i].length / pcmBytesPerSecond }
      : provider.available ? await provider.speak(scene.narration, signal) : null
    if (take) clips.push(take.bytes)
    const estimatedSeconds = plan.language === 'en' ? scene.narration.split(/\s+/).length * 60 / 155 : scene.narration.length / 4.2
    const speechSeconds = take?.seconds ?? Math.max(5, estimatedSeconds)
    const audioOffset = !takes || i === 0 ? 0.2 : 0
    const tail = !takes || i === plan.scenes.length - 1 ? 0.6 : 0
    const duration = speechSeconds + (audioOffset + tail)
    scenes.push({ ...scene, start, duration, speechSeconds, ...(takes && { audioOffset }) })
    start += duration
    onScene(scenes.length)
  }
  if (start > 240) throw voiceError('视频超过四分钟，请缩短讲稿后重新生成。')
  return { scenes, duration: start, clips, speech: { kind: provider.kind, label: provider.label, available: provider.available } }
}
