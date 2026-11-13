// A/B frame cost of blob.frag variants in one page (SwiftShader), alternating
// frames so machine load hits every variant alike. Compare ratios only.
// Each file is a full fragment shader; an optional :N sets QUALITY.
// cd web && node scripts/shader-bench.mjs \
//   base=<(git show 576a5b6:web/src/render/blob.frag) cur=src/render/blob.frag cur_q0=src/render/blob.frag:0
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const specs = process.argv.slice(2).map((a) => {
  const [name, rest] = a.split('=');
  const [file, q] = rest.split(':');
  return { name, src: readFileSync(file, 'utf8'), q: q ?? '' };
});
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
await p.setContent('<canvas id=c width=960 height=600></canvas>');
const res = await p.evaluate(async (specs) => {
  const c = document.getElementById('c');
  const gl = c.getContext('webgl2');
  const vs = '#version 300 es\nin vec2 position;void main(){gl_Position=vec4(position,0.,1.);}';
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const compileMs = {};
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const progs = specs.map((s) => {
    const t0 = performance.now();
    const sh = (t, src) => { const o = gl.createShader(t); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, '#version 300 es\n' + (s.q ? `#define QUALITY ${s.q}\n` : '') + s.src));
    gl.bindAttribLocation(pr, 0, 'position');
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    gl.useProgram(pr);
    gl.drawArrays(gl.TRIANGLES, 0, 3); // drivers may compile lazily, at the first draw
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    compileMs[s.name] = performance.now() - t0; // compile + link + first draw: the load-time stall
    return pr;
  });
  const lobes = new Float32Array(20);
  const flow = 3.0, amp = 0.1, reach = 0.95 + amp * 3;
  for (let i = 0; i < 5; i++) { const ph = i * 2.39996, t = flow * (0.8 + 0.13 * i) + ph, a = ph * 1.3 + flow * (0.2 + 0.06 * i) * (i % 2 ? 1 : -1), rad = 0.34 + 0.1 * Math.sin(i * 1.7 + flow * 0.13); lobes.set([Math.cos(a) * rad * reach, Math.sin(t + 0.45 * Math.sin(t)) * 0.52 * reach, Math.sin(a) * rad * reach, 0.44 + 0.07 * Math.sin(t * 1.6 + i)], i * 4); }
  const set = (pr, level) => {
    gl.useProgram(pr);
    const u = (n) => gl.getUniformLocation(pr, n);
    gl.uniform2f(u('uRes'), 960, 600); gl.uniform1f(u('uFlow'), flow); gl.uniform1f(u('uPhase'), 1);
    gl.uniform3f(u('uColor'), 0.2, 0.13, 0.85); gl.uniform3f(u('uLava'), 0.62, 0.22, 1); gl.uniform1f(u('uAmp'), amp);
    gl.uniform1f(u('uBreath'), 0.03); gl.uniform1f(u('uLevel'), level); gl.uniform1f(u('uGlow'), 0.8); gl.uniform1f(u('uBright'), 1);
    gl.uniform1f(u('uFlash'), 0); gl.uniform1f(u('uRadius'), 0.78); gl.uniform1f(u('uMix'), 0); gl.uniform4fv(u('uLobes'), lobes);
  };
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const px = new Uint8Array(4);
  const out = {};
  for (const k in compileMs) out[`${k} compile+link`] = `${compileMs[k].toFixed(0)} ms`;
  for (const level of [0, 0.7]) {
    const ms = specs.map(() => []);
    for (let k = 0; k < 2; k++) progs.forEach((pr) => { set(pr, level); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); });
    for (let k = 0; k < 25; k++) progs.forEach((pr, i) => { set(pr, level); const t0 = performance.now(); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); ms[i].push(performance.now() - t0); });
    specs.forEach((s, i) => { const m = ms[i].sort((a, b) => a - b); out[`${s.name} level ${level}`] = `min ${m[0].toFixed(1)} median ${m[12].toFixed(1)}`; });
  }
  return out;
}, specs);
console.log(res);
await b.close();
