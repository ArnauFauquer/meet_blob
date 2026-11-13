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
import { SHAPE, alertLook, alertShape, lookFor, type Look } from './tables';
import { morphMix, stepMorph, type Morph } from './morph';
import type { AlertItem } from '../protocol';
import type { View } from '../state';

export const RENDER_SCALE = 0.75;
const CALM_FRAME_MS = 1000 / 30; // idle (and error, offline, alert) is capped at 30 fps
const EASE_S = 0.6; // time constant of the state crossfade

export interface FrameInput {
  view: View;
  level: number; // mic level while listening, playback level while speaking
  alert?: Pick<AlertItem, 'source' | 'urgency'> | null; // the top alert, drawn when view is 'alert'
}

function targetOf(i: FrameInput): { look: Look; shape: number } {
  if (i.view === 'alert' && i.alert) return { look: alertLook(i.alert.urgency), shape: alertShape(i.alert.source) };
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
  private raf = 0;

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
      uniforms: {
        uRes: { value: new Vector2() },
        uFlow: { value: 0 },
        uPhase: { value: 0 },
        uColor: { value: new Vector3() },
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

  private frame(now: number): void {
    if (this.lost) return;
    const fi = this.input();
    const { view, level } = fi;
    const calm = view === 'idle' || view === 'error' || view === 'offline' || view === 'alert';
    if (calm && now - this.lastDraw < CALM_FRAME_MS - 2) return;
    this.lastDraw = now;
    const dt = Math.min(0.1, this.last ? (now - this.last) / 1000 : 0);
    this.last = now;

    const { look: target, shape } = targetOf(fi);
    stepMorph(this.morph, shape, dt);
    const k = 1 - Math.exp(-dt / EASE_S);
    const c = this.cur;
    for (let i = 0; i < 3; i++) c.color[i] += (target.color[i] - c.color[i]) * k;
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
    u.uAmp.value = c.amp;
    u.uBreath.value = c.breath;
    u.uLevel.value = this.level;
    u.uGlow.value = c.glow;
    u.uBright.value = c.bright;
    u.uFlash.value = this.flashT;
    u.uShapeA.value = this.morph.a;
    u.uShapeB.value = this.morph.b;
    u.uMix.value = morphMix(this.morph);

    this.frameMs = dt * 1000;
    this.renderer.render(this.scene, this.camera);
  }
}
