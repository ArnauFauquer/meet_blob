import {
  GLSL3,
  Matrix3,
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
import { morphMix, newTwirl, stepMorph, stepTwirl, type Morph } from './morph';
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
// Fixed pseudo-random 0..1 for glance n (same reason).
const rnd = (n: number, k: number) => (Math.sin(n * 91.345 + k * 47.853) * 43758.5453) % 1 * 0.5 + 0.5;

// Body motion (character): a squash-and-stretch spring that every landing,
// state change and minute tick kicks, a hop and a full twirl during a shape
// morph, bounces with the alert pulse and a gentle float for the clock.
const SQUASH_HZ = 2.6;
const SQUASH_DAMP = 0.22; // damping ratio: a few visible jiggles
const HOP = 0.22; // morph hop height (the blob radius is 0.78)
const isAlertShape = (s: number) => s === SHAPE.triangle || s === SHAPE.square;

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
  private t = 0; // own animation time, s
  private sq = 0; // squash spring: + stretches tall, - squashes wide
  private sqV = 0;
  private twirl = newTwirl();
  private alertW = 0; // 0..1 weight of the alert bounce
  private urgentW = 0; // 0..1 weight of the urgent tremble
  private clockW = 0; // 0..1 weight of the clock float
  private glance = { n: 1, t: 0, x: 0, y: 0 }; // eye saccades: n-th glance, time in it, current offset
  private lastView: View | null = null;
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
        uBodyPos: { value: new Vector3() },
        uBodyRot: { value: new Matrix3() },
        uBodyInv: { value: new Vector3(1, 1, 1) },
        uDigitY: { value: new Vector4() },
        uColon: { value: 0 },
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
  freeze(view: View, clock?: Date | null, alert?: FrameInput['alert']): void {
    this.stop();
    const { look, shape } = targetOf({ view, level: 0, clock, alert });
    Object.assign(this.cur, structuredClone(look));
    Object.assign(this.morph, { a: shape, b: shape, t: 0 });
    const u = this.material.uniforms;
    u.uFlow.value = 0;
    u.uPhase.value = 0;
    this.level = 0;
    this.flashT = 0;
    this.blinkT = 0;
    this.blinkN = 1;
    Object.assign(this, { t: 0, sq: 0, sqV: 0, twirl: newTwirl(), lastView: view });
    this.alertW = isAlertShape(shape) ? 1 : 0;
    this.urgentW = alert?.urgency === 'urgent' && view === 'alert' ? 1 : 0;
    this.clockW = shape === SHAPE.clock ? 1 : 0;
    this.glance = { n: 1, t: 0, x: 0, y: 0 };
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
    const wasMorphing = this.morph.a !== this.morph.b;
    const phase0 = this.material.uniforms.uPhase.value as number;
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
        if (this.morph.a === SHAPE.clock) this.kick(-2.4); // a hiccup on each new minute
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
    this.animateBody(dt, fi, shape, wasMorphing, phase0);
  }

  private kick(v: number): void {
    this.sqV += v;
  }

  // Character on top of the look: squash and stretch, the morph hop and
  // twirl, the alert bounce and tremble, the clock float and eye glances.
  private animateBody(dt: number, fi: FrameInput, shape: number, wasMorphing: boolean, phase0: number): void {
    const u = this.material.uniforms;
    const m = this.morph;
    const t = (this.t += dt);
    const k = 1 - Math.exp(-dt / 0.3);
    this.alertW += ((isAlertShape(shape) ? 1 : 0) - this.alertW) * k;
    this.urgentW += ((fi.view === 'alert' && fi.alert?.urgency === 'urgent' ? 1 : 0) - this.urgentW) * k;
    this.clockW += ((shape === SHAPE.clock ? 1 : 0) - this.clockW) * k;

    // Kicks: a crouch before a morph jumps, a landing after it, a small
    // jiggle on any other change of view.
    const morphing = m.a !== m.b;
    if (morphing && !wasMorphing) this.kick(-2.2);
    if (!morphing && wasMorphing) this.kick(-4);
    if (this.lastView !== null && fi.view !== this.lastView && !morphing) this.kick(-1.6);
    this.lastView = fi.view;
    // Alert shapes jump with the pulse (sin > 0 is the air time) and land on its zero crossing.
    const phase = u.uPhase.value as number;
    const landed = Math.sin(phase0) > 0 && Math.sin(phase) <= 0;
    if (landed && this.alertW > 0.5) this.kick(-2.6 - 1.2 * this.urgentW);

    // Spring, in small substeps so a long frame cannot blow it up.
    const w = 2 * Math.PI * SQUASH_HZ;
    const n = Math.max(1, Math.ceil(dt * 240));
    for (let i = 0; i < n; i++) {
      const h = dt / n;
      this.sqV += (-w * w * this.sq - 2 * SQUASH_DAMP * w * this.sqV) * h;
      this.sq += this.sqV * h;
    }

    // Morph: hop and stretch in the air, and one full twirl.
    stepTwirl(this.twirl, m);
    const air = morphing ? Math.sin(Math.PI * m.t) : 0;

    const bounce = Math.max(0, Math.sin(phase));
    const hop = HOP * air + this.alertW * (0.1 - 0.03 * this.urgentW) * bounce + this.clockW * 0.035 * Math.sin(t * 0.8);
    const shake = this.urgentW * (0.011 * Math.sin(t * 47) + 0.007 * Math.sin(t * 31 + 1.3));
    (u.uBodyPos.value as Vector3).set(shake, hop, 0);
    const roll = this.alertW * 0.09 * Math.sin(t * 1.3) * (1 - 0.5 * this.urgentW) + this.urgentW * 0.03 * Math.sin(t * 39) + this.clockW * 0.035 * Math.sin(t * 0.53);
    // World to body: yaw (twirl, sway) then roll, as rows.
    const yaw = this.twirl.angle + this.clockW * 0.14 * Math.sin(t * 0.37);
    const [cy, sy, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(roll), Math.sin(roll)];
    (u.uBodyRot.value as Matrix3).set(cr * cy, sr, cr * sy, -sr * cy, cr, -sr * sy, -sy, 0, cy);
    // Squash and stretch at constant volume, sent inverted (the shader divides by it).
    const st = 1 + Math.max(-0.3, Math.min(0.3, this.sq + 0.16 * air + this.alertW * 0.05 * bounce));
    (u.uBodyInv.value as Vector3).set(Math.sqrt(st), 1 / st, Math.sqrt(st));

    // Clock: the digits ride a slow wave, the colon beats once a second.
    const dy = u.uDigitY.value as Vector4;
    for (let i = 0; i < 4; i++) dy.setComponent(i, 0.03 * Math.sin(t * 1.7 - i * 0.8));
    u.uColon.value = Math.exp(-(t % 1) * 5);

    // Glances: the eyes dart somewhere every 1.2 to 4 s, often back to centre.
    const g = this.glance;
    g.t += dt;
    if (g.t > 1.2 + 2.8 * rnd(g.n, 0)) {
      g.t = 0;
      g.n++;
    }
    const centre = rnd(g.n, 1) < 0.35;
    const gk = 1 - Math.exp(-dt / 0.07);
    g.x += ((centre ? 0 : (rnd(g.n, 2) - 0.5) * 0.16) - g.x) * gk;
    g.y += ((centre ? 0 : (rnd(g.n, 3) - 0.5) * 0.08) - g.y) * gk;
    const gaze = u.uGaze.value as Vector2;
    gaze.x += g.x;
    gaze.y += g.y;
  }
}
