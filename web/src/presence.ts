// Presence wake: a motion or occupancy sensor (through Home Assistant and
// POST /presence) tells the page whether someone is in the room.
//
//   awake  the screen as without a sensor: the face, and the clock after
//          CLOCK_AFTER_MS of idle.
//   rest   nobody there: the idle blob rests as the clock (and the sky) after
//          only REST_WHEN_EMPTY_MS of quiet.
//   sleep  nobody there for presence_sleep_s: the screen fades to black and the
//          renderer stops drawing. The microphone, the wake word and the socket
//          keep running; the screen wake lock stays held (see docs/presence.md).
//
// Only an idle view can rest or sleep: a turn, an alert, an error or offline
// is always shown. Someone arriving (present: true) wakes the face at once
// from rest or sleep; so does a tap on the dark screen (the tap only wakes, it
// does not start a turn). A true while the face shows, while someone is
// already there or after no report at all wakes nothing: the usual clock after
// CLOCK_AFTER_MS goes on, so a motion sensor that fires again and again does
// not keep pulling the face back. It only stops the screen from sleeping.
// With no report (present: null, the default, and after a lost socket) the page
// behaves exactly as without a sensor.

export type Screen = 'awake' | 'rest' | 'sleep';

// Nobody in the room: quiet time before the face rests as the clock.
export const REST_WHEN_EMPTY_MS = 30_000;

export class PresenceMachine {
  present: boolean | null = null;
  private wokeAt = -Infinity; // when someone arriving or a tap last woke the screen from rest or sleep
  private emptyAt = -Infinity; // when the room became empty

  private readonly sleepMs: () => number;

  // sleepMs: quiet time with nobody there before the screen goes dark (presence_sleep_s).
  constructor(sleepMs: () => number) {
    this.sleepMs = sleepMs;
  }

  // A presence message. sinceS: how long the reported value has held, so a
  // page that loads into an empty room does not wait the whole time again.
  // idleSince and idle as for screen(): a true wakes only a resting or dark screen.
  report(present: boolean | null, sinceS: number | null, now: number, idleSince = now, idle = false): void {
    if (present === true && this.screen(now, idleSince, idle) !== 'awake') this.wokeAt = now;
    if (present === false && this.present !== false) this.emptyAt = now - Math.max(0, sinceS ?? 0) * 1000;
    this.present = present;
  }

  // A tap. True when it only woke the dark screen (the caller does nothing else).
  tap(now: number, idleSince: number, idle: boolean): boolean {
    const asleep = this.screen(now, idleSince, idle) === 'sleep';
    if (asleep) this.wokeAt = now;
    return asleep;
  }

  // idleSince: start of the current unbroken idle stretch; idle: the view is idle.
  screen(now: number, idleSince: number, idle: boolean): Screen {
    if (!idle || this.present !== false) return 'awake';
    const quiet = now - this.quietSince(idleSince);
    if (quiet >= this.sleepMs()) return 'sleep';
    return quiet >= REST_WHEN_EMPTY_MS ? 'rest' : 'awake';
  }

  // Milliseconds since the idle blob started resting as the clock (negative
  // before). Without a sensor this is now - idleSince - clockAfterMs, as before.
  restMs(now: number, idleSince: number, clockAfterMs: number): number {
    let start = Math.max(idleSince, this.wokeAt) + clockAfterMs;
    if (this.present === false) start = Math.min(start, this.quietSince(idleSince) + REST_WHEN_EMPTY_MS);
    return now - start;
  }

  private quietSince(idleSince: number): number {
    return Math.max(idleSince, this.wokeAt, this.emptyAt);
  }
}

// Frame cap of the dark screen: one black frame every 5 s. The cap applies in
// every view, so it is lifted the moment the screen is not 'sleep' (call
// showScreen on every animation frame: they keep coming, only drawing stops).
export const DARK_FPS = 0.2;

interface Dimmable {
  setDim(source: string, v: number): void;
  setMaxFps(source: string, fps: number): void;
  readonly dark: boolean; // faded to exact black
}

// What the page does with the screen state: the renderer fades to black (its
// 'presence' dim source; night mode is another, the lowest of all wins), then
// draws almost nothing, and the text strips around the blob fade out.
export function showScreen(s: Screen, renderer: Dimmable | null): void {
  const asleep = s === 'sleep';
  renderer?.setDim('presence', asleep ? 0 : 1);
  renderer?.setMaxFps('presence', asleep && renderer.dark ? DARK_FPS : Infinity);
  document.body.classList.toggle('asleep', asleep);
}
