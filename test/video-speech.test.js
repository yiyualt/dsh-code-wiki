import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { speechProvider, voiceVideo, waveSeconds } from '../src/video-speech.js'

test('Charon speaks the English script in one take and the saved clips preserve every sample', async t => {
  const previous = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = 'mock-voice-key'
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previous
  })
  const input = ['Build the experiment from one configuration.', 'Load the ratings in reproducible batches.',
    'Fit the model using the selected trainer.', 'Compare rankings with the same metrics.']
  const plan = { language: 'en', scenes: input.map(narration => ({ narration })) }
  const pcm = Buffer.alloc(24_000 * 2 * 8)
  for (let i = 0; i < pcm.length / 2; i++) {
    const seconds = i / 24_000
    if (seconds >= 0.1 && ![2, 4, 6, 8].some(end => Math.abs(seconds - end) < 0.16)) {
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
    assert.match(request.provider.options['google-ai-studio'].speech_metadata.style, /natural pauses/)
    return new Response(pcm)
  })

  const signal = new AbortController().signal
  const provider = await speechProvider(undefined, signal)
  assert.equal(fetch.mock.callCount(), 0, 'selecting a voice must not send a synthesis request')
  const voiced = await voiceVideo(plan, provider, signal)
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(voiced.speech.label, 'Charon · Gemini 3.8 Flash TTS')
  assert.deepEqual(voiced.scenes.map(scene => scene.audioOffset), [0.2, 0, 0, 0])
  assert(Math.abs(voiced.duration - 8.8) < 0.0001)
  assert.deepEqual(Buffer.concat(voiced.clips.map(clip => clip.subarray(44))), pcm)
  voiced.clips.forEach((clip, i) => {
    assert.equal(waveSeconds(clip), voiced.scenes[i].speechSeconds)
    assert(Math.abs(waveSeconds(clip) - 2) <= 0.1)
  })
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
    assert.match(body.contents[0].parts[0].text, /warm, conversational English/)
    assert(body.contents[0].parts[0].text.endsWith('\n\n' + text))
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType, data: pcm.toString('base64') } }] } }] })
  })

  const signal = new AbortController().signal
  const provider = await speechProvider(undefined, signal, 'charon', configFile)
  assert.equal(provider.available, true)
  assert.equal(provider.label, 'Charon · Gemini 3.1 Flash TTS')
  assert.equal(fetch.mock.callCount(), 0)
  const voiced = await voiceVideo({ language: 'en', scenes: [{ narration: text }] }, provider, signal)
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(waveSeconds(voiced.clips[0]), 1)
  assert.deepEqual(voiced.clips[0].subarray(44), pcm)

  mimeType = 'audio/l16; rate=24000; channels=2'
  await assert.rejects(provider.speakTake(text, signal), /单声道 24 kHz PCM/)
})
