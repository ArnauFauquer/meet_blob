import { describe, expect, it } from 'vitest';
import contract from '../../protocol/messages.json';
import {
  CLIENT_TYPES,
  CLOSE_BAD_TOKEN,
  CLOSE_BEFORE_HELLO,
  CONV_STATES,
  ERROR_CODES,
  SERVER_BINARY_TYPES,
  SERVER_TYPES,
  TIMEOUT_KINDS,
  TURN_DONE_REASONS,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from './protocol';

// One sample per message. The object literals are type-checked against the TS
// types, and their keys are compared with the contract fields below.
const clientSamples: { [K in ClientMessage['type']]: Extract<ClientMessage, { type: K }> } = {
  hello: { type: 'hello', version: '1', token: 't', device: 'd' },
  tap: { type: 'tap' },
  utterance: { type: 'utterance', turn: 1, format: 'pcm_s16le', rate: 16000, dur_ms: 1, tail_silence_ms: 0 },
  cancel: { type: 'cancel', turn: 1 },
  ping: { type: 'ping' },
  client_event: { type: 'client_event', kind: 'fault' },
  wake: { type: 'wake', followup: false },
  alert_read: { type: 'alert_read', key: 'k' },
  alert_ack: { type: 'alert_ack', key: 'k' },
};
const serverSamples: { [K in ServerMessage['type']]: Extract<ServerMessage, { type: K }> } = {
  hello_ok: { type: 'hello_ok', version: '1', ok: true },
  snapshot: { type: 'snapshot', conv: 'idle', alerts: [] },
  state: { type: 'state', conv: 'listening', turn: 1 },
  tts: { type: 'tts', turn: 1, alert: null, seq: 0, final: true, followup: false },
  turn_done: {
    type: 'turn_done',
    turn: 1,
    reason: 'ok',
    timeout_kind: null,
    timings: { stt_ms: 1, hermes_ms: 1, tts_ms: 1, first_audio_ms: 1, sc1_ms: 1 },
  },
  error: { type: 'error', code: 'busy' },
  pong: { type: 'pong' },
};

type Spec = Record<string, { slice: string; binary?: string; fields: Record<string, string> }>;
const c2s = contract.client_to_server as Spec;
const s2c = contract.server_to_client as Spec;

const fieldsOf = (o: object) => Object.keys(o).filter((k) => k !== 'type').sort();

describe('protocol matches protocol/messages.json', () => {
  it('has the same message names', () => {
    expect([...CLIENT_TYPES].sort()).toEqual(Object.keys(c2s).sort());
    expect([...SERVER_TYPES].sort()).toEqual(Object.keys(s2c).sort());
  });

  it('has the same enums and close codes', () => {
    expect([...CONV_STATES]).toEqual(contract.conv_states);
    expect([...TURN_DONE_REASONS]).toEqual(contract.turn_done_reasons);
    expect([...TIMEOUT_KINDS]).toEqual(contract.timeout_kinds);
    expect([...ERROR_CODES]).toEqual(contract.error_codes);
    expect(Object.keys(contract.close_codes).map(Number).sort()).toEqual([CLOSE_BEFORE_HELLO, CLOSE_BAD_TOKEN]);
  });

  it('has the same fields per client message', () => {
    for (const [name, spec] of Object.entries(c2s)) {
      const expected = Object.keys(spec.fields).filter((k) => k !== '...').sort();
      expect(fieldsOf(clientSamples[name as ClientMessage['type']]), name).toEqual(expected);
    }
  });

  it('has the same fields per server message', () => {
    for (const [name, spec] of Object.entries(s2c)) {
      expect(fieldsOf(serverSamples[name as ServerMessage['type']]), name).toEqual(Object.keys(spec.fields).sort());
    }
    expect(Object.keys(serverSamples.turn_done.timings).sort()).toEqual(
      ['first_audio_ms', 'hermes_ms', 'sc1_ms', 'stt_ms', 'tts_ms'],
    );
  });

  it('knows which server messages carry a binary frame', () => {
    const binary = Object.entries(s2c).filter(([, s]) => s.binary).map(([n]) => n);
    expect([...SERVER_BINARY_TYPES].sort()).toEqual(binary.sort());
  });

  it('parses only known server messages', () => {
    expect(parseServerMessage('{"type":"pong"}')).toEqual({ type: 'pong' });
    expect(parseServerMessage('{"type":"nope"}')).toBeNull();
    expect(parseServerMessage('[1]')).toBeNull();
    expect(parseServerMessage('not json')).toBeNull();
  });
});
