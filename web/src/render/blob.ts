import {
  Euler,
  GLSL3,
  Matrix3,
  Matrix4,
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
import {
  CLOCK_LOOK,
  CLOCK_REACH,
  LOBE_COUNT,
  SHAPE,
  alertLook,
  alertShape,
  clockDigits,
  lobes,
  lookFor,
  skyParts,
  weatherLook,
  type Look,
  type Sky,
  type SkyParts,
} from './tables';
import { Actor, rest, scaled, type Mood, type Pose } from './acts';
import { morphMix, newTwirl, stepMorph, stepTwirl, type Morph } from './morph';
import type { AlertItem } from '../protocol';
import type { View } from '../state';

const RENDER_SCALE = 0.75;
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
const LEAN_HZ = 2.2;

// Mouth shapes while speaking, one per syllable: half width, opening (times
// the look's talk), pucker (0 wide lips, 1 round). Roughly a, e, i, o, u, m.
const VOWELS: readonly [number, number, number][] = [
  [0.21, 1, 0],
  [0.25, 0.6, 0],
  [0.27, 0.38, 0],
  [0.14, 0.85, 1],
  [0.11, 0.55, 1],
  [0.2, 0.18, 0.2],
];
const MOUTH_W = 0.2; // half width at rest

// A damped spring towards `to`, in substeps so a long frame cannot blow it up.
function spring(s: { x: number; v: number }, to: number, hz: number, damp: number, dt: number): void {
  const w = 2 * Math.PI * hz;
  const n = Math.max(1, Math.ceil(dt * 240));
  for (let i = 0; i < n; i++) {
    const h = dt / n;
    s.v += (-w * w * (s.x - to) - 2 * damp * w * s.v) * h;
    s.x += s.v * h;
  }
}

interface MouthState {
  open: { x: number; v: number };
  w: { x: number; v: number };
  pucker: { x: number; v: number };
  tilt: number;
  env: number; // fast envelope of the speech level: closes between syllables
  peak: number; // recent loudest envelope, to normalise it
  armed: boolean; // the envelope dipped: the next rise is a new syllable
  n: number; // syllable count, picks the vowel
}
const newMouth = (): MouthState => ({
  open: { x: 0, v: 0 },
  w: { x: MOUTH_W, v: 0 },
  pucker: { x: 0, v: 0 },
  tilt: 0,
  env: 0,
  peak: 0.05,
  armed: true,
  n: 0,
});

// Largest stretch of a 3x3 map (its top singular value), by power iteration.
const v3 = new Vector3();
const ata = new Matrix3();
function largestStretch(m: Matrix3): number {
  ata.copy(m).transpose().multiply(m);
  v3.set(0.6, 0.7, 0.4);
  for (let i = 0; i < 12; i++) v3.applyMatrix3(ata).normalize();
  return Math.sqrt(v3.applyMatrix3(ata).length());
}

export interface FrameInput {
  view: View;
  level: number; // mic level while listening, playback level while speaking
  alert?: Pick<AlertItem, 'source' | 'urgency'> | null; // the top alert, drawn when view is 'alert'
  clock?: Date | null; // the time to show: the idle blob rests as a clock while this is set
  weather?: Sky | null; // the sky outside: the idle blob shows it while this is set (before the clock)
  room?: number; // 0..1 of the screen's height taken at the bottom (the week strip): the resting clock or sky fits above it
}

function targetOf(i: FrameInput): { look: Look; shape: number } {
  if (i.view === 'alert' && i.alert) return { look: alertLook(i.alert.urgency), shape: alertShape(i.alert.source) };
  if (i.view === 'idle' && i.weather) return { look: weatherLook(i.weather), shape: SHAPE.weather };
  if (i.view === 'idle' && i.clock) return { look: CLOCK_LOOK, shape: SHAPE.clock };
  return { look: lookFor(i.view === 'alert' ? 'idle' : i.view), shape: SHAPE.sphere };
}

// One fullscreen quad with the blob shader. The caller gives the view and the
// level each frame through `input`.
export class BlobRenderer {
  frameMs = 0; // interval between the last two frames, for the diagnostics view only
  maxLevel = 0; // highest level uniform since the last reset (e2e check)
  lost = false;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: RawShaderMaterial;
  private readonly cur: Look;
  private readonly morph: Morph;
  private readonly input: () => FrameInput;
  private last = 0;
  private lastDraw = 0;
  private level = 0;
  private flashT = 0;
  private blinkT = 0; // time since the last blink ended
  private blinkN = 1;
  private tickT = 1; // progress of the melt from the old clock digits to the new ones
  private t = 0; // own animation time, s
  private squash = { x: 0, v: 0 }; // squash spring: + stretches tall, - squashes wide
  private twirl = newTwirl();
  private actor = new Actor();
  private actW = 0; // 0..1, an act is playing
  private moodW = 0; // 0..1, acts are allowed (fades a cut act out)
  private held: Pose = rest(); // the act's last pose
  private lean = 0; // jelly lean spring: top offset per unit of height
  private leanV = 0;
  private lastX = 0;
  private lastVx = 0;
  private readonly euler = new Euler();
  private readonly rot = new Matrix4();
  private readonly shear = new Matrix3();
  private readonly scale = new Matrix3();
  private readonly inv = new Matrix3();
  private alertW = 0; // 0..1 weight of the alert bounce
  private urgentW = 0; // 0..1 weight of the urgent tremble
  private clockW = 0; // 0..1 weight of the clock float
  private restW = 0; // 0..1 weight of a resting shape (clock or sky)
  private restY = 0; // resting shape: eased offset and scale that fit it above FrameInput.room
  private restFit = 1;
  private glance = { n: 1, t: 0, x: 0, y: 0 }; // eye saccades: n-th glance, time in it, current offset
  private lastView: View | null = null;
  private mouth = newMouth();
  private sky: SkyParts = skyParts({ kind: 'clear', day: true });
  private fallT = 0; // fall time of the drops or flakes
  private skyShown = false; // the weather shape was on screen last frame
  private boltT = 3; // storm: time to the next lightning
  private bolt2 = 0; // storm: time to the second, fainter flash
  private raf = 0;
  quality = MAX_QUALITY;
  autoQuality = true;
  dim = 1; // night dimming, 0..1, multiplies every state's brightness (uBright)
  private avgMs = 0;
  private slowS = 0;

  constructor(canvas: HTMLCanvasElement, input: () => FrameInput, onLost: (lost: boolean) => void) {
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
      defines: { QUALITY: MAX_QUALITY, WEATHER: 0 },
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
        uBody: { value: new Matrix3() },
        uBodyK: { value: 1 },
        uBodyR: { value: 1 },
        uDigitY: { value: new Vector4() },
        uColon: { value: 0 },
        uMouthShape: { value: new Vector4(MOUTH_W, 0, 0, 1) },
        uSky: { value: new Vector4() },
        uFall: { value: new Vector3() },
        uFaceT: { value: new Vector3(0, 0, 1) },
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
  freeze(view: View, clock?: Date | null, alert?: FrameInput['alert'], weather?: Sky | null): void {
    this.stop();
    const { look, shape } = targetOf({ view, level: 0, clock, alert, weather });
    this.mouth = newMouth();
    if (weather) this.sky = skyParts(weather);
    this.fallT = 0;
    this.boltT = 3;
    this.skyShown = shape === SHAPE.weather;
    Object.assign(this.cur, structuredClone(look));
    Object.assign(this.morph, { a: shape, b: shape, t: 0 });
    const u = this.material.uniforms;
    u.uFlow.value = 0;
    u.uPhase.value = 0;
    this.level = 0;
    this.flashT = 0;
    this.blinkT = 0;
    this.blinkN = 1;
    Object.assign(this, { t: 0, squash: { x: 0, v: 0 }, twirl: newTwirl(), lastView: view, actor: new Actor(), actW: 0, moodW: 0, held: rest(), lean: 0, leanV: 0, lastX: 0, lastVx: 0 });
    this.alertW = isAlertShape(shape) ? 1 : 0;
    this.urgentW = alert?.urgency === 'urgent' && view === 'alert' ? 1 : 0;
    this.clockW = shape === SHAPE.clock ? 1 : 0;
    this.restW = shape === SHAPE.clock || shape === SHAPE.weather ? 1 : 0;
    this.restY = 0;
    this.restFit = 1;
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
    if (fi.weather && this.material.defines.WEATHER !== 1) {
      this.material.defines.WEATHER = 1; // one shader rebuild, the first time the sky shows
      this.material.needsUpdate = true;
    }
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
    this.stepMouth(dt, fi, c);
    this.stepSky(dt, fi);
    lobes(u.uFlow.value as number, c.amp, u.uLobes.value as Float32Array);
    this.animateBody(dt, fi, shape, wasMorphing, phase0);
  }

  // The mouth. Speaking, a fast envelope of the playback level opens it on
  // each syllable and closes it in between, and each syllable gets its own
  // vowel shape (wide, narrow, round), all on jelly springs that overshoot a
  // little. At rest it keeps drifting into a lopsided grin and back; thinking
  // pulls it to one side ("hmm").
  private stepMouth(dt: number, fi: FrameInput, c: Look): void {
    const mo = this.mouth;
    const talkW = Math.min(1, c.talk / 0.12); // how much of the speaking look is in
    const raw = talkW > 0.01 ? fi.level : 0;
    mo.env += (raw - mo.env) * (1 - Math.exp(-dt / (raw > mo.env ? 0.025 : 0.07)));
    mo.peak = Math.max(0.04, mo.peak * Math.exp(-dt / 2), mo.env);
    const e = Math.min(1, mo.env / mo.peak);
    if (mo.armed && e > 0.6) {
      mo.armed = false;
      mo.n++;
    } else if (e < 0.35) mo.armed = true;
    const v = VOWELS[Math.floor(rnd(mo.n, 4) * VOWELS.length) % VOWELS.length];
    const say = talkW * Math.min(1, e * 2);
    const openTo = c.mouth * (1 - 0.65 * talkW) + c.talk * 1.8 * talkW * e ** 0.7 * v[1];
    spring(mo.open, openTo, 11, 0.4, dt);
    spring(mo.w, MOUTH_W + 0.012 * c.smile + say * (v[0] - MOUTH_W), 7, 0.5, dt);
    spring(mo.pucker, say * v[2], 7, 0.6, dt);
    const t = this.t;
    const drift = 0.08 * Math.sin(t * 0.31) * Math.sin(t * 0.17 + 1);
    const hmm = fi.view === 'thinking' ? 0.16 + 0.06 * Math.sin(t * 1.3) : 0;
    const twist = talkW * 0.12 * (rnd(mo.n, 6) - 0.5);
    mo.tilt += (drift * (1 - talkW) + hmm + twist - mo.tilt) * (1 - Math.exp(-dt / 0.25));
    const u = this.material.uniforms;
    (u.uMouth.value as Vector3).set(c.smile + 0.25 * Math.sin(t * 0.23) * (1 - talkW), Math.max(0, mo.open.x), c.face);
    (u.uMouthShape.value as Vector4).set(Math.max(0.06, mo.w.x), mo.tilt, Math.max(0, Math.min(1, mo.pucker.x)), 1);
  }

  // The weather shape's parts melt from one sky to the next; drops fall; a
  // storm flashes now and then (twice, the second fainter) and startles the blob.
  private stepSky(dt: number, fi: FrameInput): void {
    const u = this.material.uniforms;
    const showing = this.morph.a === SHAPE.weather || this.morph.b === SHAPE.weather;
    const shown = this.skyShown;
    this.skyShown = showing;
    if (fi.weather) {
      const to = skyParts(fi.weather);
      const k = shown ? 1 - Math.exp(-dt / 0.8) : 1; // coming on screen: take the new sky at once
      for (const key of Object.keys(to) as (keyof SkyParts)[]) this.sky[key] += (to[key] - this.sky[key]) * k;
    }
    const s = this.sky;
    this.fallT += dt * (0.75 - 0.5 * s.snow);
    (u.uSky.value as Vector4).set(s.sun, s.moon, s.cloud, s.size);
    (u.uFall.value as Vector3).set(s.fall, s.snow, this.fallT);
    (u.uFaceT.value as Vector3).set(s.faceX, s.faceY, s.faceS);
    if (fi.weather?.kind !== 'storm' || this.morph.a !== SHAPE.weather || this.morph.b !== SHAPE.weather) return;
    this.boltT -= dt;
    if (this.boltT <= 0) {
      this.flashT = 1;
      this.bolt2 = 0.14;
      this.boltT = 2.5 + 4.5 * rnd(Math.floor(this.t), 7);
      this.kick(-1.4);
    }
    if (this.bolt2 > 0 && (this.bolt2 -= dt) <= 0) this.flashT = Math.max(this.flashT, 0.6);
  }

  // Debug and film strips: start an act now (names in ACTS, acts.ts).
  play(name: string): void {
    this.actor.play(name);
  }

  private kick(v: number): void {
    this.squash.v += v;
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
    this.restW += ((shape === SHAPE.clock || shape === SHAPE.weather ? 1 : 0) - this.restW) * k;
    // The resting shape centres itself in the free space above the strip and
    // shrinks only if it does not fit there (its volume stays the sphere's otherwise).
    const [top, bottom] = shape === SHAPE.weather ? [this.sky.top, this.sky.bottom] : CLOCK_REACH;
    const half = 1.417; // the camera sees +-1.417 world units at the body's depth
    const hi = half - 0.08;
    const lo = -half + 2 * half * (fi.room ?? 0) + 0.06;
    const fit = Math.min(1, (hi - lo) / (top - bottom));
    const ke = 1 - Math.exp(-dt / 0.6);
    this.restFit += (fit - this.restFit) * ke;
    this.restY += ((fi.room ? (hi + lo) / 2 - (fit * (top + bottom)) / 2 : 0) - this.restY) * ke;

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

    spring(this.squash, 0, SQUASH_HZ, SQUASH_DAMP, dt);

    // Morph: hop and stretch in the air, and one full twirl.
    stepTwirl(this.twirl, m);
    const air = morphing ? Math.sin(Math.PI * m.t) : 0;

    // Acts at rest (acts.ts): only once the shape has settled.
    const mood: Mood | null = morphing
      ? null
      : shape === SHAPE.clock
        ? 'clock'
        : isAlertShape(shape)
          ? fi.alert?.urgency === 'urgent' ? 'urgent' : 'info'
          : fi.view === 'idle' || fi.view === 'thinking' ? fi.view : null;
    const { pose: live, kick } = this.actor.step(dt, mood);
    // An act cut short (a tap, a reply, a morph) fades out from its last pose.
    this.moodW += ((mood ? 1 : 0) - this.moodW) * (1 - Math.exp(-dt / 0.15));
    if (mood) this.held = live;
    const p = mood ? live : scaled(this.held, this.moodW);
    if (kick) this.kick(kick);
    this.actW += ((this.actor.busy ? 1 : 0) - this.actW) * (1 - Math.exp(-dt / 0.2));
    const calm = 1 - this.actW; // the ambient motion yields to an act

    const bounce = Math.max(0, Math.sin(phase)) * calm;
    const hop = HOP * air + this.alertW * (0.1 - 0.03 * this.urgentW) * bounce + this.restW * (0.035 * Math.sin(t * 0.8) + this.restY) + p.y;
    const shake = this.urgentW * calm * (0.011 * Math.sin(t * 47) + 0.007 * Math.sin(t * 31 + 1.3));
    const x = shake + p.x;
    (u.uBodyPos.value as Vector3).set(x, hop, p.z);
    const roll =
      (this.alertW * 0.09 * Math.sin(t * 1.3) * (1 - 0.5 * this.urgentW) + this.urgentW * 0.03 * Math.sin(t * 39) + this.clockW * 0.035 * Math.sin(t * 0.53)) * calm + p.roll;
    const yaw = this.twirl.angle + this.clockW * 0.14 * Math.sin(t * 0.37) * calm + p.yaw;

    // Jelly lean: the top lags behind sideways moves, on its own spring.
    const vx = dt > 0 ? (x - this.lastX) / dt : 0;
    const ax = dt > 0 ? (vx - this.lastVx) / dt : 0;
    this.lastX = x;
    this.lastVx = vx;
    const lw = 2 * Math.PI * LEAN_HZ;
    const n = Math.max(1, Math.ceil(dt * 240)); // substeps, as in spring()
    for (let i = 0; i < n; i++) {
      const h = dt / n;
      this.leanV += (-lw * lw * this.lean - 2 * 0.3 * lw * this.leanV - ax * 0.4) * h;
      this.lean += this.leanV * h;
    }
    this.lean = Math.max(-0.25, Math.min(0.25, this.lean));

    // World to body: undo the lean (x - lean * y), then the turn (yaw, pitch,
    // roll), then the squash and stretch at constant volume.
    const st = 1 + Math.max(-0.3, Math.min(0.35, this.squash.x + 0.16 * air + this.alertW * 0.05 * bounce + p.sq));
    this.euler.set(p.pitch, yaw, roll, 'YXZ');
    const body = (u.uBody.value as Matrix3).setFromMatrix4(this.rot.makeRotationFromEuler(this.euler)).transpose();
    body.multiply(this.shear.set(1, -this.lean, 0, 0, 1, 0, 0, 0, 1));
    body.premultiply(this.scale.set(Math.sqrt(st), 0, 0, 0, 1 / st, 0, 0, 0, Math.sqrt(st)));
    body.multiplyScalar(1 / (1 + this.restW * (this.restFit - 1))); // a resting shape too big for its room
    const big = largestStretch(body);
    u.uBodyK.value = 1 / big;
    u.uBodyR.value = largestStretch(this.inv.copy(body).invert());

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
    gaze.x += g.x * calm + p.gx;
    gaze.y += g.y * calm + p.gy;

    // The act's expression on top of the state's face.
    const eyes = u.uEyes.value as Vector4;
    // A long close stops at 0.03: a flatter ellipse leaves a faint line across the blob.
    eyes.y = Math.max(Math.min(eyes.y, 0.03), eyes.y * (1 + p.lid));
    const glad = mood !== 'urgent'; // an urgent alert never looks pleased
    eyes.w = Math.max(0, Math.min(1, eyes.w + (glad ? p.happy : 0)));
    const mouth = u.uMouth.value as Vector3;
    mouth.x += glad ? p.smile : Math.min(0, p.smile);
    mouth.y += p.mouth;
  }
}
