// Small WAV writer shared by the mock backend and the e2e fixtures.

export function wav(samples: Float32Array, rate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// Speech-like test signal: a voiced tone with a 4 Hz syllable envelope for
// `voicedS` seconds, then `silenceS` seconds of silence.
export function speechLike(rate: number, voicedS: number, silenceS = 0, freq = 220): Float32Array {
  const n = Math.round(rate * (voicedS + silenceS));
  const out = new Float32Array(n);
  for (let i = 0; i < rate * voicedS; i++) {
    const t = i / rate;
    const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t);
    out[i] = 0.5 * env * (Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(2 * Math.PI * freq * 2.03 * t));
  }
  return out;
}
