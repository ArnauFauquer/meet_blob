// Test helper: a 20 ms block (16 kHz) whose RMS is `db` dBFS, a 400 Hz tone
// (amplitude √2 × RMS) with a small seeded random wobble, like a real background.
let seed = 1;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

export function block(db: number, wobbleDb = 0): Int16Array {
  const rms = 10 ** ((db + wobbleDb * (2 * rand() - 1)) / 20);
  return Int16Array.from({ length: 320 }, (_, i) =>
    Math.round(Math.SQRT2 * rms * 0x8000 * Math.sin((2 * Math.PI * 400 * i) / 16000)),
  );
}
