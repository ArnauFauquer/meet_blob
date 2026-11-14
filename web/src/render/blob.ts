import {
  GLSL3,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  Scene,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from 'three';
import fragmentShader from './blob.frag?raw';
import vertexShader from './blob.vert?raw';
import { CLOCK_LOOK, LOBE_COUNT, SHAPE, alertLook, alertShape, clockDigits, lobes, lookFor, type Look } from './tables';
import { morphMix, stepMorph, type Morph } from './morph';
import type { AlertItem } from '../protocol';
import type { View } from '../state';

export const RENDER_SCALE = 0.75;
const CALM_FRAME_MS = 1000 / 30; // idle (and error, offline, alert) is capped at 30 fps
const EASE_S = 0.6; // time constant of the state crossfade
// Quality tiers (QUALITY define in blob.frag): 2 full, 1 fewer march steps,
// lobes and lava samples, 0 minimal. The page starts at 2 and steps down,
// never up, when the moving average of the frame interval stays above SLOW_MS.
export const MAX_QUALITY = 2;
const SLOW_MS = 50; // under 20 fps
const SLOW_FOR_S = 4;
const BLINK_S = 0.16; // one blink, closed at the middle
const FACE_KEYS = ['eyeW', 'eyeH', 'eyeY', 'gazeX', 'gazeY', 'happy', 'smile', 'mouth', 'talk', 'face'] as const;

// Open time before blink n: 3 to 6 s from a fixed sequence, so frozen film
// strips stay reproducible.
const blinkGap = (n: number) => 3 + 3 * (Math.sin(n * 12.9898) * 0.5 + 0.5);

export interface FrameInput {
  view: View;
  level: number; // mic level while listening, playback level while speaking
  alert?: Pick<AlertItem, 'source' | 'urgency'> | null; // the top alert, drawn when view is 'alert'
  clock?: Date | null; // the time to show: the idle blob rests as a clock while this is set
}

function targetOf(i: FrameInput): { look: Look; shape: number } {
  if (i.view === 'alert' && i.alert) return { look: alertLook(i.alert.urgency), shape: alertShape(i.alert.source) };
  if (i.view === 'idle' && i.clock) return { look: CLOCK_LOOK, shape: SHAPE.clock };
  return { look: lookFor(i.view === 'alert' ? 'idle' : i.view), shape: SHAPE.sphere };
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
  readonly morph: Morph;
  private readonly input: () => FrameInput;
  private last = 0;
  private lastDraw = 0;
  private level = 0;
  private flashT = 0;
  private blinkT = 0; // time since the last blink ended
  private blinkN = 1;
  private tickT = 1; // progress of the melt from the old clock digits to the new ones
  private raf = 0;
  quality = MAX_QUALITY;
  autoQuality = true;
  dim = 1; // night dimming, 0..1, multiplies every state's brightness (uBright)
  private avgMs = 0;
  private slowS = 0;

  constructor(canvas: HTMLCanvasElement, input: () => FrameInput, onLost: (lost: boolean) => void) {
    this.canvas = canvas;
    this.input = input;
    const first = targetOf(input());
    this.cur = structuredClone(first.look);
    this.morph = { a: first.shape, b: first.shape, t: 0 };
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
        uShapeA: { value: first.shape },
        uShapeB: { value: first.shape },
        uMix: { value: 0 },
        uLobes: { value: new Float32Array(LOBE_COUNT * 4) },
        uEyes: { value: new Vector4() },
        uGaze: { value: new Vector2() },
        uMouth: { value: new Vector3() },
        uDigits: { value: new Vector4() },
        uDigitsPrev: { value: new Vector4() },
        uTick: { value: 1 },
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
  freeze(view: View, clock?: Date | null): void {
    this.stop();
    const { look, shape } = targetOf({ view, level: 0, clock });
    Object.assign(this.cur, structuredClone(look));
    Object.assign(this.morph, { a: shape, b: shape, t: 0 });
    const u = this.material.uniforms;
    u.uFlow.value = 0;
    u.uPhase.value = 0;
    this.level = 0;
    this.flashT = 0;
    this.blinkT = 0;
    this.blinkN = 1;
  }

  // Advances the frozen clock by `dtS` with the given input; draws when asked.
  step(dtS: number, input: FrameInput, draw: boolean): void {
    this.advance(dtS, input);
    if (draw) this.renderer.render(this.scene, this.camera);
  }

  private frame(now: number): void {
    if (this.lost) return;
    const fi = this.input();
    const { view } = fi;
    const calm = view === 'idle' || view === 'error' || view === 'offline' || view === 'alert';
    if (calm && now - this.lastDraw < CALM_FRAME_MS - 2) return;
    this.lastDraw = now;
    const dt = Math.min(0.1, this.last ? (now - this.last) / 1000 : 0);
    this.last = now;
    this.frameMs = dt * 1000;
    this.adaptQuality(dt);
    this.advance(dt, fi);
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

  private advance(dt: number, fi: FrameInput): void {
    const { level } = fi;
    const { look: target, shape } = targetOf(fi);
    stepMorph(this.morph, shape, dt);
    const k = 1 - Math.exp(-dt / EASE_S);
    const c = this.cur;
    for (let i = 0; i < 3; i++) {
      c.color[i] += (target.color[i] - c.color[i]) * k;
      c.lava[i] += (target.lava[i] - c.lava[i]) * k;
    }
    for (const key of ['speed', 'amp', 'breath', 'breathHz', 'levelGain', 'glow', 'bright', ...FACE_KEYS] as const) {
      c[key] += (target[key] - c[key]) * k;
    }
    // Fast attack, slower release, so the surface follows syllables but settles softly.
    const want = level * c.levelGain;
    this.level += (want - this.level) * (1 - Math.exp(-dt / (want > this.level ? 0.05 : 0.25)));
    this.maxLevel = Math.max(this.maxLevel, this.level);
    this.flashT = Math.max(0, this.flashT - dt / 0.4);
    this.blinkT += dt;
    const gap = blinkGap(this.blinkN);
    if (this.blinkT > gap + BLINK_S) {
      this.blinkT -= gap + BLINK_S;
      this.blinkN++;
    }
    const open = this.blinkT < gap ? 1 : Math.abs((this.blinkT - gap) / BLINK_S - 0.5) * 2;

    const u = this.material.uniforms;
    if (fi.clock) {
      const d = clockDigits(fi.clock);
      const shown = u.uDigits.value as Vector4;
      if (d.some((v, i) => v !== shown.getComponent(i))) {
        // A minute change melts the old digits into the new ones. The digits
        // of an earlier rest are stale: those are replaced at once.
        const prev = u.uDigitsPrev.value as Vector4;
        if (this.morph.a === SHAPE.clock) prev.copy(shown);
        else prev.fromArray(d);
        shown.fromArray(d);
        this.tickT = 0;
      }
    }
    this.tickT = Math.min(1, this.tickT + dt / EASE_S);
    u.uTick.value = this.tickT;
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
    u.uShapeA.value = this.morph.a;
    u.uShapeB.value = this.morph.b;
    u.uMix.value = morphMix(this.morph);
    (u.uEyes.value as Vector4).set(c.eyeW, Math.max(0.012, c.eyeH * open), c.eyeY, c.happy);
    (u.uGaze.value as Vector2).set(c.gazeX, c.gazeY);
    (u.uMouth.value as Vector3).set(c.smile, c.mouth + c.talk * this.level, c.face);
    lobes(u.uFlow.value as number, c.amp, u.uLobes.value as Float32Array);
  }
}
