import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { speechProvider, voiceVideo, waveSeconds } from '../src/video-speech.js'
import { stretchSpeechPcm } from '../src/video-tempo.js'

test('speech tempo preserves pitch at faster and 0.9 playback durations and the original at rate one', () => {
  const sampleRate = 24_000
  const frequency = 185
  const sampleCount = sampleRate * 2
  const pcm = Buffer.alloc(sampleCount * 2)
  for (let i = 0; i < sampleCount; i++) pcm.writeInt16LE(Math.round(12_000 * Math.sin(2 * Math.PI * frequency * i / sampleRate)), i * 2)
  assert.deepEqual(stretchSpeechPcm(pcm, sampleRate, 1), pcm)
  for (const ratio of [0.9, 1.2]) {
    const processed = stretchSpeechPcm(pcm, sampleRate, ratio)
    assert.equal(processed.length, 2 * Math.round(sampleCount / ratio))
    const first = Math.floor(sampleRate / 10)
    const last = processed.length / 2 - first
    let cycles = 0
    for (let i = first + 1; i < last; i++) {
      if (processed.readInt16LE((i - 1) * 2) < 0 && processed.readInt16LE(i * 2) >= 0) cycles++
    }
    const observed = cycles * sampleRate / (last - first)
    assert(Math.abs(observed - frequency) < 2, `expected ~${frequency} Hz at ${ratio}, measured ${observed} Hz`)
  }
})

test('Charon speaks one take and saves every tempo-adjusted sample with topic pauses', async t => {
  const previous = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = 'mock-voice-key'
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previous
  })
  const input = ['Build the experiment from one configuration.', 'Load the ratings in reproducible batches.',
    'Fit the model using the selected trainer.', 'Compare rankings with the same metrics.']
  const plan = { language: 'en', scenes: input.map(narration => ({ narration })) }
  const pcm = Buffer.alloc(24_000 * 2 * 10)
  for (let i = 0; i < pcm.length / 2; i++) {
    const seconds = i / 24_000
    if (seconds >= 0.1 && ![2, 4, 6, 8, 10].some(end => Math.abs(seconds - end) < 0.16)) {
      pcm.writeInt16LE(i % 2 ? 1200 : -1200, i * 2)
    }
  }
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/audio/speech')
    assert.equal(options.method, 'POST')
    const request = JSON.parse(options.body)
    assert.equal(request.model, 'google/gemini-3.8-flash-tts')
    assert.equal(request.voice, 'Charon')
    assert.equal(request.response_format, 'pcm')
    assert.equal(request.input, input.join('\n\n'))
    assert.match(request.provider.options['google-ai-studio'].speech_metadata.style, /135–145 words per minute/)
    return new Response(pcm)
  })

  const signal = new AbortController().signal
  const provider = await speechProvider(undefined, signal)
  assert.equal(fetch.mock.callCount(), 0, 'selecting a voice must not send a synthesis request')
  const voiced = await voiceVideo(plan, provider, signal)
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(voiced.speech.label, 'Charon · Gemini 3.8 Flash TTS')
  assert.equal(voiced.speech.alignment, 'estimated')
  const ratio = 140 / (25 * 60 / 10)
  const processed = stretchSpeechPcm(pcm, 24_000, ratio)
  assert.equal(voiced.speech.tempoRatio, ratio)
  assert.equal(voiced.speech.originalWordsPerMinute, 150)
  assert.equal(voiced.speech.wordsPerMinute, 140)
  assert.equal(voiced.speech.scenePauseSeconds, 0.5)
  assert.deepEqual(voiced.scenes.map(scene => scene.audioOffset), [0.2, 0, 0, 0])
  assert(Math.abs(voiced.duration - (processed.length / 48_000 + 2.3)) < 0.0001)
  assert.deepEqual(Buffer.concat(voiced.clips.map(clip => clip.subarray(44))), processed)
  voiced.clips.forEach((clip, i) => {
    const scene = voiced.scenes[i]
    assert.equal(waveSeconds(clip), scene.speechSeconds)
    assert(Math.abs(scene.duration - scene.speechSeconds - scene.audioOffset - (i < 3 ? 0.5 : 0.6)) < .000001)
    if (i) assert.equal(scene.start, voiced.scenes[i - 1].start + voiced.scenes[i - 1].duration)
  })
})

test('continuous English narration settles around 140 WPM and skips implausible short samples', async () => {
  const pcm = Buffer.alloc(48_000 * 10, 7)
  const narration = 'Build the experiment from one configuration, load the ratings into training batches, fit the recommendation model, and compare its rankings with the usual metrics.'
  const voiced = await voiceVideo({ language: 'en', scenes: [{ narration }] },
    { available: true, kind: 'test', label: 'Charon', speakTake: async () => pcm }, new AbortController().signal)
  assert.equal(voiced.speech.label, 'Charon')
  assert.equal(voiced.speech.originalWordsPerMinute, 144)
  assert.equal(voiced.speech.tempoRatio, 140 / 144)
  assert.equal(voiced.speech.wordsPerMinute, 140)
  assert.equal(waveSeconds(voiced.clips[0]), voiced.scenes[0].speechSeconds)

  const old172 = Buffer.alloc(Math.round(24 * 60 / 172 * 24_000) * 2, 7)
  const slower = await voiceVideo({ language: 'en', scenes: [{ narration }] },
    { available: true, kind: 'test', label: 'Charon', speakTake: async () => old172 }, new AbortController().signal)
  assert(Math.abs(slower.speech.tempoRatio - 140 / 172) < .00001)
  assert.equal(slower.speech.wordsPerMinute, 140)

  // A valid but leisurely take must still reach the requested presentation pace.
  const slowTake = Buffer.alloc(48_000 * 12, 7)
  const corrected = await voiceVideo({ language: 'en', scenes: [{ narration }] },
    { available: true, kind: 'test', label: 'Charon', speakTake: async () => slowTake }, new AbortController().signal)
  assert.equal(corrected.speech.originalWordsPerMinute, 120)
  assert.equal(corrected.speech.tempoRatio, 140 / 120)
  assert.equal(corrected.speech.wordsPerMinute, 140)
  assert.equal(waveSeconds(corrected.clips[0]), corrected.scenes[0].speechSeconds)

  const sparse = await voiceVideo({ language: 'en', scenes: [{ narration: 'Start the test.' }] },
    { available: true, kind: 'test', label: 'Charon', speakTake: async () => pcm }, new AbortController().signal)
  assert.equal(sparse.speech.tempoRatio, 1)
  assert.deepEqual(sparse.clips[0].subarray(44), pcm)
})

test('a continuous silent or malformed response fails before saving any scene', async () => {
  const signal = new AbortController().signal
  const plan = { language: 'en', scenes: [{ narration: 'This paragraph should have audible speech.' }] }
  const provider = { available: true, kind: 'api', label: 'Charon', speakTake: async () => Buffer.alloc(48_000) }
  await assert.rejects(voiceVideo(plan, provider, signal), /静音/)
  provider.speakTake = async () => Buffer.alloc(48_001)
  await assert.rejects(voiceVideo(plan, provider, signal), /格式或时长/)
})

test('Charon can use the Gemini endpoint at the configured model gateway without probing on selection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-video-gateway-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const previous = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  t.after(() => {
    if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous
    else delete process.env.OPENROUTER_API_KEY
  })
  const configFile = join(directory, 'model.json')
  await writeFile(configFile, JSON.stringify({ judge: {
    url: 'https://gateway.example/prefix/v1/chat/completions', api_key: 'mock-gateway-key', headers: { 'x-route': 'keep' },
  } }))
  const text = 'Use the same configuration to compare two training runs.'
  const pcm = Buffer.alloc(48_000, 4)
  let mimeType = 'audio/l16; rate=24000; channels=1'
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://gateway.example/prefix/v1beta/models/gemini-3.1-flash-tts-preview:generateContent')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.get('authorization'), 'Bearer mock-gateway-key')
    assert.equal(options.headers.get('x-goog-api-key'), 'mock-gateway-key')
    assert.equal(options.headers.get('x-route'), 'keep')
    const body = JSON.parse(options.body)
    assert.deepEqual(body.generationConfig.responseModalities, ['AUDIO'])
    assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon')
    assert.match(body.contents[0].parts[0].text, /Warm, conversational English.*135–145 words per minute/)
    assert.match(body.contents[0].parts[0].text, /Read only the words after TRANSCRIPT/)
    assert(body.contents[0].parts[0].text.endsWith('\n\nTRANSCRIPT\n' + text))
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType, data: pcm.toString('base64') } }] } }] })
  })

  const signal = new AbortController().signal
  const provider = await speechProvider(undefined, signal, 'charon', configFile)
  assert.equal(provider.available, true)
  assert.equal(provider.label, 'Charon · Gemini 3.1 Flash TTS')
  assert.equal(fetch.mock.callCount(), 0)
  const voiced = await voiceVideo({ language: 'en', scenes: [{ narration: text,
    beats: [{ narration: 'Use the same configuration', brief: 'Configuration' }, { narration: 'to compare two training runs.', brief: 'Compare runs' }] }] }, provider, signal)
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(waveSeconds(voiced.clips[0]), 1)
  assert.deepEqual(voiced.clips[0].subarray(44), pcm)
  assert.equal(voiced.speech.words, 9)
  assert.equal(voiced.speech.wordsPerMinute, 540)
  assert.equal(voiced.speech.tempoRatio, 1)
  assert.equal(voiced.speech.alignment, 'estimated')
  assert.deepEqual(voiced.scenes[0].beats.map(beat => beat.wordIndex), [0, 4])
  assert.equal(voiced.scenes[0].words, undefined)
  assert.equal(voiced.scenes[0].beatOffsets, undefined)

  mimeType = 'audio/l16; rate=24000; channels=2'
  await assert.rejects(provider.speakTake(text, signal), /单声道 24 kHz PCM/)
})
