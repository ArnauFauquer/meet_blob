import type { Recording } from './audio/pcm';
import type { ClientMessage, ErrorMsg, StateMsg, TurnDoneMsg } from './protocol';
import { PCM_RATE } from './protocol';
import type { TurnPhase } from './taps';
import type { Vad, VadEnd } from './vad';

// How a turn was started: a tap, the wake word, or the follow-up window.
export type TurnKind = 'tap' | 'wake' | 'followup';

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
  // Hands-free devices (wake=true): the VAD ends the utterance, with these limits in ms.
  vad?: Vad;
  noSpeechMs?: () => { listen: number; followup: number };
  onListenEnd?: (kind: TurnKind) => void; // the listening phase ended (any reason)
}

// The client side of one turn (design: Turn pipeline, entry 48).
// tap or wake -> wait for the first `state` listening with a turn id -> open
// the mic -> stop tap, VAD end or 15 s cap -> utterance + PCM -> wait for
// turn_done. When the VAD hears no speech within its limit, a zero-length
// utterance (dur_ms 0, no binary frame) is sent instead.
export class TurnClient {
  phase: TurnPhase = 'idle';
  turn: number | null = null;
  kind: TurnKind = 'tap';
  private capTimer: ReturnType<typeof setTimeout> | undefined;
  private micOpening: Promise<void> | null = null;
  private readonly d: TurnDeps;

  constructor(deps: TurnDeps) {
    this.d = deps;
  }

  startTurn(kind: TurnKind = 'tap'): boolean {
    if (this.phase !== 'idle') return false;
    const msg: ClientMessage = kind === 'tap' ? { type: 'tap' } : { type: 'wake', followup: kind === 'followup' };
    if (!this.d.send(msg)) return false;
    this.phase = 'requested';
    this.kind = kind;
    return true;
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
    // (another device's turn), so a mic opened for it is closed again. A
    // bad_message while requested is a refused wake; any other is ignored
    // (for example a cancel for a turn that already ended).
    if (m.code === 'bad_message') {
      if (this.phase === 'requested') this.reset();
      return;
    }
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
    this.leaveListening();
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

  // The VAD heard no speech within its limit: zero-length utterance, no frame.
  async sendNoSpeech(): Promise<void> {
    if (this.phase !== 'listening' || this.turn === null) return;
    const turn = this.turn;
    this.leaveListening();
    try {
      await this.micOpening;
    } catch {
      return;
    }
    if (this.turn !== turn || this.phase !== 'thinking') return;
    this.d.mic.close();
    this.d.send({ type: 'utterance', turn, format: 'pcm_s16le', rate: PCM_RATE, dur_ms: 0, tail_silence_ms: 0 });
  }

  // Thinking or speaking tap. The phase stays until turn_done arrives.
  cancel(): void {
    if (this.turn === null || this.phase === 'idle') {
      // speaking after turn_done: the backend has already released the turn
      if (this.turn !== null) this.d.send({ type: 'cancel', turn: this.turn });
      return;
    }
    this.d.mic.close();
    if (this.phase === 'listening') this.leaveListening();
    this.d.send({ type: 'cancel', turn: this.turn });
    this.phase = 'thinking';
  }

  // Socket dropped or the turn ended: close the mic, forget the phase.
  reset(): void {
    if (this.phase === 'listening' || this.phase === 'requested') this.leaveListening();
    clearTimeout(this.capTimer);
    this.d.mic.close();
    this.micOpening = null;
    this.phase = 'idle';
  }

  private leaveListening(): void {
    this.phase = 'thinking';
    clearTimeout(this.capTimer);
    this.d.vad?.stop();
    this.d.onListenEnd?.(this.kind);
  }

  private onVadEnd(end: VadEnd): void {
    if (end === 'no_speech') void this.sendNoSpeech();
    else void this.sendUtterance();
  }

  private openMic(turn: number): void {
    this.capTimer = setTimeout(() => void this.sendUtterance(), this.d.capMs);
    if (this.d.vad) {
      const lim = this.d.noSpeechMs?.() ?? { listen: 8000, followup: 6000 };
      this.d.vad.start({ noSpeechMs: this.kind === 'followup' ? lim.followup : lim.listen }, (e) => this.onVadEnd(e));
    }
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
