import { LONG_PRESS_MS } from './config';

export type DiagSource = () => Record<string, unknown>;

// Long press opens the diagnostics view: page version, socket and mic status,
// hermes_reachable (from /healthz), last turn timings, frame time, and a
// button that copies a text report. Any tap outside the button closes it.
export class Diag {
  private readonly el: HTMLElement;
  private readonly source: DiagSource;
  private health: unknown = 'not checked';
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(el: HTMLElement, source: DiagSource) {
    this.el = el;
    this.source = source;
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  show(): void {
    this.el.hidden = false;
    this.health = 'checking';
    fetch('/healthz')
      .then((r) => r.json())
      .then((j: { hermes_reachable?: unknown }) => (this.health = j.hermes_reachable ?? 'unknown'))
      .catch(() => (this.health = 'unreachable'));
    this.render();
    this.timer = setInterval(() => this.render(), 500);
  }

  hide(): void {
    this.el.hidden = true;
    clearInterval(this.timer);
  }

  report(): string {
    const data = { ...this.source(), hermes_reachable: this.health };
    return Object.entries(data)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join('\n');
  }

  private render(): void {
    this.el.replaceChildren();
    const pre = document.createElement('pre');
    pre.textContent = this.report();
    const btn = document.createElement('button');
    btn.textContent = 'Copy report';
    btn.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      void navigator.clipboard?.writeText(this.report()).then(() => (btn.textContent = 'Copied'));
    });
    this.el.append(pre, btn);
  }
}

// Tap and long press on one element. A press longer than LONG_PRESS_MS is a
// long press and does not also count as a tap.
export function onPress(el: HTMLElement, tap: () => void, longPress: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let longFired = false;
  el.addEventListener('pointerdown', () => {
    longFired = false;
    timer = setTimeout(() => {
      longFired = true;
      longPress();
    }, LONG_PRESS_MS);
  });
  const end = (fire: boolean) => {
    clearTimeout(timer);
    if (fire && !longFired) tap();
  };
  el.addEventListener('pointerup', () => end(true));
  el.addEventListener('pointercancel', () => end(false));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
