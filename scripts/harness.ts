import WebSocket from 'ws';
import { VoiceSession } from '../server/voice-session.js';
import type { ClientMessage, ServerMessage, TurnTrace } from '../server/protocol.js';

/**
 * A headless stand-in for the browser, driving the REAL VoiceSession.
 *
 * It is not a mock of the thing under test. The turn state machine, the Rime
 * ws3 socket, the fencing rules, the ledger and the planner are all the shipped
 * objects; only the microphone and the loudspeaker are simulated. That is the
 * line we hold so that "the acceptance test passes" and "the product works"
 * mean the same thing.
 *
 * The simulated speaker consumes audio in real time -- `samples / sampleRate`
 * seconds per chunk -- so `samplesPlayed` at the moment of a barge-in is a
 * faithful analogue of what a real output device would have delivered.
 *
 * Two transports, same tests:
 *
 *   - LOCAL  (default) drives a VoiceSession in this process. Measures the
 *     server-side stop path with no network in the loop: barge-in received ->
 *     `stop_audio` ordered -> playback halted.
 *   - REMOTE (`--remote wss://host/ws/voice`) drives a DEPLOYED instance over
 *     the real socket. The measured stop latency then includes a full
 *     client -> internet -> server -> internet -> client round trip, which is
 *     much closer to what a technician on that deployment experiences.
 *
 * A real browser adds one render quantum plus AudioContext.outputLatency on top
 * of either figure. All three are reported separately in RIME_EVIDENCE.md;
 * none is presented as another.
 */

/** Where client messages go and server messages come from. */
interface Transport {
  readonly kind: 'local' | 'remote';
  start(onServer: (m: ServerMessage) => void): Promise<void>;
  send(m: ClientMessage): void;
  stop(): void;
  /** Only the local transport can see the model history directly. */
  history(): unknown[] | null;
  /**
   * Median network round trip to the server, or null when there is no network
   * in the loop. Measured with WebSocket ping/pong on the SAME socket the test
   * traffic uses, so it is the round trip that a barge-in actually pays -- not
   * an ICMP ping to a different host over a different path.
   */
  rtt(samples: number): Promise<number | null>;
}

class LocalTransport implements Transport {
  readonly kind = 'local';
  session!: VoiceSession;
  async start(onServer: (m: ServerMessage) => void) {
    this.session = new VoiceSession(onServer);
    await this.session.start();
  }
  send(m: ClientMessage) {
    this.session.handle(m);
  }
  stop() {
    this.session.dispose();
  }
  history() {
    return this.session.traceHistory as unknown[];
  }
  async rtt() {
    return null; // in-process: there is no network to subtract
  }
}

class RemoteTransport implements Transport {
  readonly kind = 'remote';
  private ws!: WebSocket;
  constructor(private url: string) {}
  async start(onServer: (m: ServerMessage) => void) {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(
        () => reject(new Error(`timed out connecting to ${this.url}`)),
        120000, // a sleeping free-tier instance can take a minute to wake
      );
      ws.once('open', () => {
        clearTimeout(timer);
        ws.send(JSON.stringify({ type: 'hello', sampleRate: 24000 }));
        resolve();
      });
      ws.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      ws.on('message', (d) => onServer(JSON.parse(d.toString()) as ServerMessage));
    });
  }
  send(m: ClientMessage) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
  stop() {
    this.ws.close();
  }
  history() {
    return null; // not observable across the wire, by design
  }
  async rtt(samples = 15): Promise<number> {
    const xs: number[] = [];
    for (let i = 0; i < samples; i++) {
      const t0 = process.hrtime.bigint();
      await new Promise<void>((res) => {
        this.ws.ping();
        this.ws.once('pong', () => res());
      });
      xs.push(Number(process.hrtime.bigint() - t0) / 1e6);
      await new Promise((r) => setTimeout(r, 60));
    }
    xs.sort((a, b) => a - b);
    return xs[Math.floor(xs.length / 2)];
  }
}

const SAMPLE_RATE = Number(process.env.RIME_SAMPLING_RATE || 24000);

export type RunResult = {
  trace: TurnTrace | null;
  /** Audio chunks the "speaker" accepted after a stop order. Must be 0. */
  chunksAfterStop: number;
  /** Audio chunks delivered for a turn that was already fenced. Must be 0. */
  chunksForDeadTurn: number;
  agentText: string;
  toolEvents: { name: string; fenced: boolean; ms: number }[];
  stopOrderedAt: number | null;
  silenceAt: number | null;
  firstAudioAt: number | null;
  turnOpenAt: number | null;
  micFramesDuringPlayback: number;
  micFramesDuringTool: number;
};

export class Harness {
  private transport: Transport;
  private samplesPlayed = 0;
  private liveTurn = 0;
  private stopped = false;
  private playing = false;
  private toolRunning = false;
  private micTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private result!: RunResult;
  private resolveTurn: ((r: RunResult) => void) | null = null;
  /** Fires when the given number of samples has "reached the speaker". */
  private bargeAtSamples: number | null = null;
  private onBargeReady: (() => void) | null = null;

  constructor(remoteUrl?: string) {
    this.transport = remoteUrl ? new RemoteTransport(remoteUrl) : new LocalTransport();
  }

  get kind() {
    return this.transport.kind;
  }

  async start() {
    await this.transport.start((m) => this.onServer(m));
    // The microphone is open for the whole session and never gated on whether
    // the agent is speaking. This timer is the proof of that, and its counts
    // are what AT-5 asserts on.
    this.micTimer = setInterval(() => {
      this.send({
        type: 'mic_frame',
        at: now(),
        rms: 0.002,
        playing: this.playing,
        toolRunning: this.toolRunning,
      });
    }, 20);
  }

  stop() {
    if (this.micTimer) clearInterval(this.micTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.transport.stop();
  }

  private send(m: ClientMessage) {
    this.transport.send(m);
  }

  private onServer(m: ServerMessage) {
    switch (m.type) {
      case 'turn_open':
        this.liveTurn = m.turn;
        this.samplesPlayed = 0;
        this.stopped = false;
        this.playing = true;
        this.result.turnOpenAt = now();
        break;

      case 'audio': {
        const samples = Math.floor((m.b64.length * 3) / 4 / 2);
        if (this.stopped) {
          // A chunk arriving after the stop order is exactly the failure this
          // project claims not to have. Count it; never play it.
          this.result.chunksAfterStop++;
          return;
        }
        if (m.turn !== this.liveTurn) {
          this.result.chunksForDeadTurn++;
          return;
        }
        if (this.result.firstAudioAt === null) this.result.firstAudioAt = now();
        this.samplesPlayed += samples;

        if (
          this.bargeAtSamples !== null &&
          this.samplesPlayed >= this.bargeAtSamples &&
          this.onBargeReady
        ) {
          const fire = this.onBargeReady;
          this.onBargeReady = null;
          fire();
        }
        break;
      }

      case 'stop_audio': {
        // Simulated speaker goes silent on the next quantum, matching the
        // AudioWorklet's behaviour.
        this.stopped = true;
        this.playing = false;
        this.result.silenceAt = now();
        this.send({
          type: 'playback_stopped',
          turn: m.turn,
          at: this.result.silenceAt,
          samplesPlayed: this.samplesPlayed,
        });
        break;
      }

      case 'audio_end':
        this.playing = false;
        this.send({
          type: 'playback_drained',
          turn: m.turn,
          at: now(),
          samplesPlayed: this.samplesPlayed,
        });
        break;

      case 'agent_text':
        this.result.agentText += m.delta;
        break;

      case 'tool_start':
        this.toolRunning = true;
        break;

      case 'tool_end':
        this.toolRunning = false;
        this.result.toolEvents.push({ name: m.name, fenced: m.fenced, ms: m.ms });
        break;

      case 'trace': {
        this.result.trace = m.trace;
        this.result.micFramesDuringPlayback = m.trace.micFramesDuringPlayback;
        this.result.micFramesDuringTool = m.trace.micFramesDuringTool;
        this.playing = false;
        const r = this.resolveTurn;
        this.resolveTurn = null;
        if (r) r(this.result);
        break;
      }

      default:
        break;
    }
  }

  private fresh(): RunResult {
    return {
      trace: null,
      chunksAfterStop: 0,
      chunksForDeadTurn: 0,
      agentText: '',
      toolEvents: [],
      stopOrderedAt: null,
      silenceAt: null,
      firstAudioAt: null,
      turnOpenAt: null,
      micFramesDuringPlayback: 0,
      micFramesDuringTool: 0,
    };
  }

  setToolDelay(ms: number) {
    this.send({ type: 'set_tool_delay', ms });
  }

  /** Run one uninterrupted turn to completion. */
  say(text: string, timeoutMs = 30000): Promise<RunResult> {
    this.result = this.fresh();
    const p = new Promise<RunResult>((resolve) => {
      this.resolveTurn = resolve;
      setTimeout(() => {
        if (this.resolveTurn === resolve) {
          this.resolveTurn = null;
          resolve(this.result);
        }
      }, timeoutMs).unref?.();
    });
    this.send({ type: 'user_final', text, at: now() });
    return p;
  }

  /**
   * Run a turn and barge in.
   *
   * `after` is either a wall-clock delay in ms (used to interrupt DURING a tool
   * call, before any audio exists) or `{ samples }` to interrupt once a given
   * amount of speech has reached the speaker.
   */
  sayAndInterrupt(
    text: string,
    after: number | { samples: number },
    timeoutMs = 30000,
  ): Promise<RunResult> {
    this.result = this.fresh();
    const p = new Promise<RunResult>((resolve) => {
      this.resolveTurn = resolve;
      setTimeout(() => {
        if (this.resolveTurn === resolve) {
          this.resolveTurn = null;
          resolve(this.result);
        }
      }, timeoutMs).unref?.();
    });

    const fireBarge = () => {
      const at = now();
      this.result.stopOrderedAt = at;
      // `at` is the client's own clock at the instant the user's voice crossed
      // the threshold. The server echoes it back through the stop-latency
      // calculation, so the round trip is inside the measurement, not outside.
      this.send({ type: 'barge_in', turn: this.liveTurn, at, reason: 'vad' });
    };

    if (typeof after === 'number') {
      this.bargeAtSamples = null;
      setTimeout(fireBarge, after).unref?.();
    } else {
      this.bargeAtSamples = after.samples;
      this.onBargeReady = fireBarge;
    }

    this.send({ type: 'user_final', text, at: now() });
    return p;
  }

  get history(): unknown[] | null {
    return this.transport.history();
  }

  /** Median network round trip, or null for the in-process transport. */
  measureRtt(samples = 15): Promise<number | null> {
    return this.transport.rtt(samples);
  }
}

export function now(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

export const samplesForMs = (ms: number) => Math.floor((SAMPLE_RATE * ms) / 1000);
