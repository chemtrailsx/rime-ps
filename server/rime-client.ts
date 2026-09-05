import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { RimeConfig } from './config.js';

/**
 * Persistent client for Rime's ws3 JSON WebSocket API.
 *
 * Why ws3 and not the HTTP endpoint:
 *
 *  1. `{"operation":"clear"}` cancels synthesis that Rime has already accepted
 *     but not yet emitted. Without it, barge-in can only drop audio locally
 *     while the server keeps generating and billing for a response nobody will
 *     ever hear. With it, the cancellation is authoritative end to end.
 *  2. `contextId` tags every audio chunk with the turn that requested it. That
 *     turns "is this chunk stale?" from a timing guess into an equality check.
 *  3. Word timestamps let us compute exactly which words reached the speaker
 *     before a barge-in, which is the basis of the heard-transcript ledger.
 *
 * The socket is opened once and kept warm. Opening it per turn would add a TCP
 * + TLS + auth handshake (~120-260 ms on our network) to time-to-first-audio;
 * cold and warm numbers are reported separately in RIME_EVIDENCE.md.
 */

export type RimeAudioChunk = { contextId: string | null; pcm: Buffer; seq: number };
export type RimeTimestamps = {
  contextId: string | null;
  words: string[];
  start: number[];
  end: number[];
};

export interface RimeClientEvents {
  audio: (c: RimeAudioChunk) => void;
  timestamps: (t: RimeTimestamps) => void;
  done: (contextId: string | null) => void;
  error: (e: Error) => void;
  open: () => void;
  close: () => void;
}

export class RimeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private seq = 0;
  private closed = false;
  /** True until the first successful synthesis on this process. */
  public cold = true;
  public lastConnectMs: number | null = null;

  constructor(private cfg: RimeConfig) {
    super();
  }

  get url(): string {
    const q = new URLSearchParams({
      speaker: this.cfg.speaker,
      modelId: this.cfg.modelId,
      audioFormat: this.cfg.audioFormat,
      lang: this.cfg.lang,
      samplingRate: String(this.cfg.samplingRate),
      segment: this.cfg.segment,
    });
    return `${this.cfg.wsUrl}?${q.toString()}`;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    if (!this.cfg.apiKey) throw new Error('RIME_API_KEY is not set');

    const t0 = Date.now();
    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
      });
      this.ws = ws;

      const onFail = (e: Error) => {
        this.connecting = null;
        reject(e);
      };

      ws.once('open', () => {
        this.lastConnectMs = Date.now() - t0;
        this.connecting = null;
        this.emit('open');
        resolve();
      });
      ws.once('error', onFail);

      ws.on('message', (raw: WebSocket.RawData) => this.onMessage(raw));
      ws.on('close', () => {
        this.emit('close');
        this.ws = null;
        if (!this.closed) {
          // Reconnect lazily on next speak(); no busy loop.
        }
      });
    });
    return this.connecting;
  }

  private onMessage(raw: WebSocket.RawData) {
    // ws3 is a JSON protocol: audio arrives base64-encoded inside a frame so
    // that it can carry its contextId. That coupling is the whole point --
    // a bare binary frame would be untraceable to a turn.
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this.emit('error', new Error('rime: non-JSON frame'));
      return;
    }
    switch (msg.type) {
      case 'chunk': {
        const pcm = Buffer.from(msg.data, 'base64');
        this.emit('audio', { contextId: msg.contextId ?? null, pcm, seq: this.seq++ });
        break;
      }
      case 'timestamps': {
        const wt = msg.word_timestamps ?? {};
        this.emit('timestamps', {
          contextId: msg.contextId ?? null,
          words: wt.words ?? [],
          start: wt.start ?? [],
          end: wt.end ?? [],
        });
        break;
      }
      case 'done':
        this.cold = false;
        this.emit('done', msg.contextId ?? null);
        break;
      case 'error':
        this.emit('error', new Error(`rime: ${msg.message ?? 'unknown'}`));
        break;
      default:
        break;
    }
  }

  /** Queue text for synthesis under a specific turn's context. */
  async speak(contextId: string, text: string): Promise<void> {
    if (!text.trim()) return;
    await this.connect();
    this.ws!.send(JSON.stringify({ text, contextId }));
  }

  /** Ask Rime to emit whatever it is holding for the current context. */
  async flush(): Promise<void> {
    if (!this.connected) return;
    this.ws!.send(JSON.stringify({ operation: 'flush' }));
  }

  /**
   * Authoritative barge-in. Discards text Rime has accepted but not yet
   * synthesised. Fire-and-forget by design: we must not await a network
   * round trip before telling the client to go silent.
   */
  clear(): void {
    if (!this.connected) return;
    this.ws!.send(JSON.stringify({ operation: 'clear' }));
  }

  close(): void {
    this.closed = true;
    if (this.connected) {
      try {
        this.ws!.send(JSON.stringify({ operation: 'eos' }));
      } catch {
        /* socket already gone */
      }
    }
    this.ws?.close();
    this.ws = null;
  }
}
