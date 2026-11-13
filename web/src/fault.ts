// One dim text line naming the most important current fault.
// Hermes down is not shown here (diagnostics view only).

export const FAULTS = {
  bad_token: 'Wrong or missing token. Open the install link again.',
  version: 'Page and server versions differ. Reload did not help.',
  socket_down: 'Offline. Reconnecting…',
  mic_denied: 'Microphone blocked.',
  wake: 'Wake word unavailable. Tap to talk.', // model or worker failed to load
  render: 'Graphics unavailable.', // context lost (recovers on restore) or no WebGL
  audio_locked: 'Audio locked. Tap to enable sound.',
} as const;
export type Fault = keyof typeof FAULTS;

// Object key order is the priority order.
const ORDER = Object.keys(FAULTS) as Fault[];

export class FaultLine {
  private active = new Set<Fault>();
  private readonly onChange: (text: string) => void;

  constructor(onChange: (text: string) => void) {
    this.onChange = onChange;
  }

  set(f: Fault, on: boolean): void {
    if (on === this.active.has(f)) return;
    if (on) this.active.add(f);
    else this.active.delete(f);
    this.onChange(this.text);
  }

  has(f: Fault): boolean {
    return this.active.has(f);
  }

  get current(): Fault | null {
    return ORDER.find((f) => this.active.has(f)) ?? null;
  }

  get text(): string {
    const f = this.current;
    return f ? FAULTS[f] : '';
  }
}
