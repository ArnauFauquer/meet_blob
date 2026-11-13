import {
  GLSL3,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import fragmentShader from './blob.frag?raw';
import vertexShader from './blob.vert?raw';
import { LOBE_COUNT, lobes, lookFor, type Look } from './tables';
import type { View } from '../state';

export const RENDER_SCALE = 0.75;
const CALM_FRAME_MS = 1000 / 30; // idle (and error/offline) is capped at 30 fps
const EASE_S = 0.6; // time constant of the state crossfade
// Quality tiers (QUALITY define in blob.frag): 2 full, 1 fewer march steps and
// reflection taps, 0 minimal. The page starts at 2 and steps down, never up,
// when the moving average of the frame interval stays above SLOW_MS.
export const MAX_QUALITY = 2;
const SLOW_MS = 50; // under 20 fps
const SLOW_FOR_S = 4;

export interface FrameInput {
  view: View;
  level: number; // mic level while listening, playback level while speaking
}

// One fullscreen quad with the blob shader. The caller gives the view and the
// level each frame through `input`.
export class BlobRenderer {
  readonly canvas: HTMLCanvasElement;
  frameMs = 0; // interval between the last two frames, for the diagnostics view only
  maxLevel = 0; // highest level uniform since the last reset (e2e check)
  lost = false;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: RawShaderMaterial;
  private readonly cur: Look;
  private readonly input: () => FrameInput;
  private last = 0;
  private lastDraw = 0;
  private level = 0;
  private flashT = 0;
  private raf = 0;
  quality = MAX_QUALITY;
  dim = 1; // night dimming, 0..1, multiplies every state's brightness (uBright)
  autoQuality = true;
  private avgMs = 0;
  private slowS = 0;

  constructor(canvas: HTMLCanvasElement, input: () => FrameInput, onLost: (lost: boolean) => void) {
    this.canvas = canvas;
    this.input = input;
    this.cur = structuredClone(lookFor(input().view));
    this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'low-power' });
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      defines: { QUALITY: MAX_QUALITY },
      uniforms: {
        uRes: { value: new Vector2() },
        uFlow: { value: 0 },
        uPhase: { value: 0 },
        uColor: { value: new Vector3() },
        uLava: { value: new Vector3() },
        uAmp: { value: 0 },
        uBreath: { value: 0 },
        uLevel: { value: 0 },
        uGlow: { value: 0 },
        uBright: { value: 0 },
        uFlash: { value: 0 },
        uRadius: { value: 0.78 },
        uShapeA: { value: 0 },
        uShapeB: { value: 0 },
        uMix: { value: 0 },
        uLobes: { value: new Float32Array(LOBE_COUNT * 4) },
      },
    });
    this.scene.add(new Mesh(new PlaneGeometry(2, 2), this.material));
    // three.js rebuilds its GL state on restore; we only pause the loop meanwhile.
    canvas.addEventListener('webglcontextlost', () => {
      this.lost = true;
      onLost(true);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      onLost(false);
    });
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  start(): void {
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  flash(): void {
    this.flashT = 1;
  }

  get uniforms(): Record<string, { value: unknown }> {
    return this.material.uniforms;
  }

  private resize(): void {
    this.renderer.setPixelRatio((devicePixelRatio || 1) * RENDER_SCALE);
    this.renderer.setSize(innerWidth, innerHeight, false);
    const v = new Vector2();
    this.renderer.getDrawingBufferSize(v);
    (this.material.uniforms.uRes.value as Vector2).copy(v);
  }

  setQuality(q: number): void {
    q = Math.max(0, Math.min(MAX_QUALITY, Math.round(q)));
    if (q === this.quality) return;
    this.quality = q;
    this.material.defines.QUALITY = q;
    this.material.needsUpdate = true; // one shader rebuild per tier change
  }

  // Debug clock for the film strip: stop the loop and restart the motion from
  // zero in `view`'s look, so frames are reproducible.
  freeze(view: View): void {
    this.stop();
    Object.assign(this.cur, structuredClone(lookFor(view)));
    const u = this.material.uniforms;
    u.uFlow.value = 0;
    u.uPhase.value = 0;
    this.level = 0;
    this.flashT = 0;
  }

  // Advances the frozen clock by `dtS` with the given input; draws when asked.
  step(dtS: number, input: FrameInput, draw: boolean): void {
    this.advance(dtS, input.view, input.level);
    if (draw) this.renderer.render(this.scene, this.camera);
  }

  private frame(now: number): void {
    if (this.lost) return;
    const { view, level } = this.input();
    const calm = view === 'idle' || view === 'error' || view === 'offline';
    if (calm && now - this.lastDraw < CALM_FRAME_MS - 2) return;
    this.lastDraw = now;
    const dt = Math.min(0.1, this.last ? (now - this.last) / 1000 : 0);
    this.last = now;
    this.frameMs = dt * 1000;
    this.adaptQuality(dt);
    this.advance(dt, view, level);
    this.renderer.render(this.scene, this.camera);
  }

  // Simple moving average of the frame interval; a long slow stretch drops one tier.
  private adaptQuality(dt: number): void {
    if (dt <= 0 || document.hidden || !this.autoQuality) return;
    this.avgMs += (dt * 1000 - this.avgMs) * 0.05;
    this.slowS = this.avgMs > SLOW_MS ? this.slowS + dt : 0;
    if (this.slowS > SLOW_FOR_S && this.quality > 0) {
      this.setQuality(this.quality - 1);
      this.slowS = 0;
      this.avgMs = 0;
    }
  }

  private advance(dt: number, view: View, level: number): void {
    const target = lookFor(view);
    const k = 1 - Math.exp(-dt / EASE_S);
    const c = this.cur;
    for (let i = 0; i < 3; i++) {
      c.color[i] += (target.color[i] - c.color[i]) * k;
      c.lava[i] += (target.lava[i] - c.lava[i]) * k;
    }
    for (const key of ['speed', 'amp', 'breath', 'breathHz', 'levelGain', 'glow', 'bright'] as const) {
      c[key] += (target[key] - c[key]) * k;
    }
    // Fast attack, slower release, so the surface follows syllables but settles softly.
    const want = level * c.levelGain;
    this.level += (want - this.level) * (1 - Math.exp(-dt / (want > this.level ? 0.05 : 0.25)));
    this.maxLevel = Math.max(this.maxLevel, this.level);
    this.flashT = Math.max(0, this.flashT - dt / 0.4);

    const u = this.material.uniforms;
    u.uFlow.value += dt * c.speed;
    u.uPhase.value = (u.uPhase.value + dt * c.breathHz * 2 * Math.PI) % (2 * Math.PI);
    (u.uColor.value as Vector3).set(c.color[0], c.color[1], c.color[2]);
    (u.uLava.value as Vector3).set(c.lava[0], c.lava[1], c.lava[2]);
    u.uAmp.value = c.amp;
    u.uBreath.value = c.breath;
    u.uLevel.value = this.level;
    u.uGlow.value = c.glow;
    u.uBright.value = c.bright * this.dim;
    u.uFlash.value = this.flashT;
    lobes(u.uFlow.value as number, c.amp, u.uLobes.value as Float32Array);
  }
}
