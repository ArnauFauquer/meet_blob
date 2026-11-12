import type { Recording } from './audio/pcm';
import type { ClientMessage, ErrorMsg, StateMsg, TurnDoneMsg } from './protocol';
import { PCM_RATE } from './protocol';
import type { TurnPhase } from './taps';

export interface Mic {
  start(onCap: () => void): Promise<void>;
  stop(): Recording;
  close(): void;
}

export interface TurnDeps {
  send(msg: ClientMessage, binary?: ArrayBuffer): boolean;
  mic: Mic;
  capMs: number;
  onTurn(turn: number): void; // this page learned its turn id
  onMicDenied(): void;
  onBusy(): void;
}

// The client side of one turn (design: Turn pipeline, entry 48).
// tap -> wait for the first `state` listening with a turn id -> open the mic
// -> stop tap or 15 s cap -> utterance + PCM -> wait for turn_done.
export class TurnClient {
  phase: TurnPhase = 'idle';
  turn: number | null = null;
  private capTimer: ReturnType<typeof setTimeout> | undefined;
  private micOpening: Promise<void> | null = null;
  private readonly d: TurnDeps;

  constructor(deps: TurnDeps) {
    this.d = deps;
  }

  startTurn(): void {
    if (this.phase !== 'idle') return;
    if (this.d.send({ type: 'tap' })) this.phase = 'requested';
  }

  onState(m: Pick<StateMsg, 'conv' | 'turn'>): void {
    if (this.phase === 'requested' && m.conv === 'listening' && m.turn !== null) {
      this.turn = m.turn;
      this.phase = 'listening';
      this.d.onTurn(m.turn);
      this.openMic(m.turn);
      return;
    }
    // The turn ended without a turn_done reaching us (or a mirror view).
    if (m.conv === 'idle' && this.phase !== 'requested' && this.phase !== 'idle') this.reset();
  }

  onError(m: ErrorMsg): void {
    // busy or not_ready answer our tap. A state listening may have come first
    // (another device's turn), so a mic opened for it is closed again.
    if (m.code === 'bad_message') return;
    if (this.phase === 'requested' || this.phase === 'listening') {
      this.reset();
      if (m.code === 'busy') this.d.onBusy();
    }
  }

  onTurnDone(m: TurnDoneMsg): void {
    if (m.turn === this.turn) this.reset();
  }

  // Listening tap or the 15 s cap: stop the mic and send the audio.
  async sendUtterance(): Promise<void> {
    if (this.phase !== 'listening' || this.turn === null) return;
    const turn = this.turn;
    this.phase = 'thinking';
    clearTimeout(this.capTimer);
    try {
      await this.micOpening;
    } catch {
      return; // denial already handled
    }
    if (this.turn !== turn || this.phase !== 'thinking') return;
    const rec = this.d.mic.stop();
    this.d.send(
      {
        type: 'utterance',
        turn,
        format: 'pcm_s16le',
        rate: PCM_RATE,
        dur_ms: rec.durMs,
        tail_silence_ms: rec.tailSilenceMs,
      },
      rec.durMs > 0 ? (rec.pcm.buffer as ArrayBuffer) : undefined,
    );
  }

  // Thinking or speaking tap. The phase stays until turn_done arrives.
  cancel(): void {
    if (this.turn === null || this.phase === 'idle') {
      // speaking after turn_done: the backend has already released the turn
      if (this.turn !== null) this.d.send({ type: 'cancel', turn: this.turn });
      return;
    }
    this.d.mic.close();
    clearTimeout(this.capTimer);
    this.d.send({ type: 'cancel', turn: this.turn });
    this.phase = 'thinking';
  }

  // Socket dropped or the turn ended: close the mic, forget the phase.
  reset(): void {
    clearTimeout(this.capTimer);
    this.d.mic.close();
    this.micOpening = null;
    this.phase = 'idle';
  }

  private openMic(turn: number): void {
    this.capTimer = setTimeout(() => void this.sendUtterance(), this.d.capMs);
    const opening = this.d.mic.start(() => void this.sendUtterance());
    this.micOpening = opening;
    opening.then(
      () => {
        // the turn ended while the mic was opening
        if (this.turn !== turn || this.phase === 'idle') this.d.mic.close();
      },
      () => {
        if (this.turn !== turn) return;
        clearTimeout(this.capTimer);
        this.d.send({ type: 'cancel', turn });
        this.phase = 'thinking'; // wait for turn_done{cancel}
        this.d.onMicDenied();
      },
    );
  }
}
