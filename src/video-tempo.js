// Adapted from GitDiagram's MIT-licensed time-stretch.ts (Ahmed Khaleel).
// See THIRD_PARTY_NOTICES.md for the full copyright and license notice.

function hann(size) {
  const window = new Float32Array(size)
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size)
  return window
}

function similarity(signal, a, b, length, stride) {
  let sum = 0
  for (let i = 0; i < length; i += stride) sum += signal[a + i] * signal[b + i]
  return sum
}

function align(signal, natural, target, tolerance, length, last) {
  if (natural + length > signal.length) return target
  const low = Math.max(0, target - tolerance)
  const high = Math.min(last, target + tolerance)
  let best = target
  let bestScore = -Infinity
  for (let start = low; start <= high; start += 4) {
    const score = similarity(signal, natural, start, length, 4)
    if (score > bestScore) [best, bestScore] = [start, score]
  }
  const coarse = best
  bestScore = -Infinity
  for (let start = Math.max(low, coarse - 4); start <= Math.min(high, coarse + 4); start++) {
    const score = similarity(signal, natural, start, length, 2)
    if (score > bestScore) [best, bestScore] = [start, score]
  }
  return best
}

// WSOLA shifts the spacing of overlapping windows while matching their waveforms.
// Sample rate stays constant. The caller supplies mono, signed 16-bit little-endian PCM.
export function stretchSpeechPcm(pcm, sampleRate, rate) {
  const inputLength = pcm.length / 2
  const size = 2 ** Math.round(Math.log2(sampleRate * 0.025))
  if (rate === 1 || inputLength < size * 2) return pcm

  const samples = new Float32Array(inputLength)
  for (let i = 0; i < inputLength; i++) samples[i] = pcm.readInt16LE(i * 2)
  const outputLength = Math.round(inputLength / rate)
  const window = hann(size)
  const output = new Float32Array(outputLength + size)
  const envelope = new Float32Array(outputLength + size)
  const hop = size / 2
  const last = inputLength - size
  let previous = 0
  for (let at = 0; at < outputLength; at += hop) {
    const target = Math.min(last, Math.round(at * rate))
    const start = at === 0 ? 0 : align(samples, previous + hop, target, hop / 2, hop, last)
    for (let i = 0; i < size; i++) {
      output[at + i] += window[i] * samples[start + i]
      envelope[at + i] += window[i]
    }
    previous = start
  }

  const bytes = Buffer.alloc(outputLength * 2)
  bytes.writeInt16LE(samples[0], 0)
  for (let i = 1; i < outputLength; i++) {
    const sample = Math.round(output[i] / envelope[i])
    bytes.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2)
  }
  return bytes
}
