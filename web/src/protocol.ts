// Message types for the page/backend WebSocket contract.
// Source of truth: protocol/messages.json (checked by protocol.test.ts).

export const CONV_STATES = ['idle', 'listening', 'thinking', 'speaking'] as const;
export type ConvState = (typeof CONV_STATES)[number];

export const TURN_DONE_REASONS = [
  'ok',
  'empty',
  'stt_fail',
  'hermes_fail',
  'timeout',
  'tts_fail',
  'cancel',
] as const;
export type TurnDoneReason = (typeof TURN_DONE_REASONS)[number];

export const TIMEOUT_KINDS = ['hermes', 'turn', 'listen'] as const;
export type TimeoutKind = (typeof TIMEOUT_KINDS)[number];

export const ERROR_CODES = ['busy', 'bad_message', 'not_ready'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const CLOSE_BEFORE_HELLO = 4400;
export const CLOSE_BAD_TOKEN = 4401;

export const PCM_RATE = 16000;

// An active alert in snapshot.alerts[].
export interface AlertItem {
  key: string;
  source: string;
  urgency: 'info' | 'urgent';
  text: string;
  lang: string;
  late: boolean;
  activated_at: number;
}

export interface Timings {
  stt_ms: number | null;
  hermes_ms: number | null;
  tts_ms: number | null;
  first_audio_ms: number | null;
  sc1_ms: number | null;
}

// Client to server
export interface HelloMsg { type: 'hello'; version: string; token: string; device: string }
export interface TapMsg { type: 'tap' }
export interface UtteranceMsg {
  type: 'utterance';
  turn: number;
  format: 'pcm_s16le';
  rate: typeof PCM_RATE;
  dur_ms: number;
  tail_silence_ms: number;
}
export interface CancelMsg { type: 'cancel'; turn: number }
export interface PingMsg { type: 'ping' }
export interface ClientEventMsg { type: 'client_event'; kind: string; [extra: string]: unknown }
// S3 and S4 messages.
export interface WakeMsg { type: 'wake'; followup: boolean }
export interface AlertReadMsg { type: 'alert_read'; key: string }
export interface AlertAckMsg { type: 'alert_ack'; key: string }

export type ClientMessage =
  | HelloMsg
  | TapMsg
  | UtteranceMsg
  | CancelMsg
  | PingMsg
  | ClientEventMsg
  | WakeMsg
  | AlertReadMsg
  | AlertAckMsg;

// Server to client
export interface HelloOkMsg { type: 'hello_ok'; version: string; ok: boolean }
export interface SnapshotMsg { type: 'snapshot'; conv: ConvState; alerts: AlertItem[] }
export interface StateMsg { type: 'state'; conv: ConvState; turn: number | null }
export interface TtsMsg {
  type: 'tts';
  turn: number | null;
  alert: string | null;
  seq: number;
  final: boolean;
  followup: boolean;
}
export interface TurnDoneMsg {
  type: 'turn_done';
  turn: number;
  reason: TurnDoneReason;
  timeout_kind: TimeoutKind | null;
  timings: Timings;
}
export interface ErrorMsg { type: 'error'; code: ErrorCode }
export interface PongMsg { type: 'pong' }

export type ServerMessage =
  | HelloOkMsg
  | SnapshotMsg
  | StateMsg
  | TtsMsg
  | TurnDoneMsg
  | ErrorMsg
  | PongMsg;

export const CLIENT_TYPES = [
  'hello', 'tap', 'utterance', 'cancel', 'ping', 'client_event', 'wake', 'alert_read', 'alert_ack',
] as const satisfies readonly ClientMessage['type'][];
export const SERVER_TYPES = [
  'hello_ok', 'snapshot', 'state', 'tts', 'turn_done', 'error', 'pong',
] as const satisfies readonly ServerMessage['type'][];

// Messages followed by exactly one binary frame.
export const SERVER_BINARY_TYPES: readonly ServerMessage['type'][] = ['tts'];

// Trust boundary: a server message must be an object with a known string type.
export function parseServerMessage(text: string): ServerMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const t = (v as { type?: unknown }).type;
  if (typeof t !== 'string' || !(SERVER_TYPES as readonly string[]).includes(t)) return null;
  return v as ServerMessage;
}
