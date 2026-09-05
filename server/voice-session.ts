import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { RimeClient, type RimeAudioChunk, type RimeTimestamps } from './rime-client.js';
import { rimeConfig, rimeDescriptor, toolDelayMs, type RimeConfig } from './config.js';
import { makePlanner, type Planner } from './planner.js';
import { ClauseSegmenter } from './segmenter.js';
import { HeardLedger } from './ledger.js';
import { forTheEar } from './ear.js';
import type { ClientMessage, ServerMessage, TurnTrace } from './protocol.js';

/**
 * The Bay Six turn state machine.
 *
 * This is where the hard voice problem is actually solved. Everything else in
 * the repository exists to feed or measure this file.
 *
 * The problem: a technician says "radiator cap for the 2018 Civic". A catalog
 * lookup takes three seconds. Somewhere in second two, while the agent is
 * mid-sentence, they say "no, the 2019". Four things are now in flight and
 * every one of them can corrupt the conversation:
 *
 *   1. Audio Rime has already generated and shipped to the browser.
 *   2. Audio Rime has accepted but not yet generated.
 *   3. A model stream still emitting tokens about the 2018.
 *   4. A tool call that will return 2018 data in about a second.
 *
 * A naive agent lets all four land. The tech hears the tail of the 2018 answer,
 * then the 2019 answer, and the model's history claims it said things the tech
 * never heard. Bay Six fences all four against a single monotonically
 * increasing turn number, and reconciles history against what the browser
 * confirms actually reached the speaker.
 *
 * Ordering inside interrupt() is deliberate and load-bearing. See the comments
 * there.
 */

type TurnState = {
  id: number;
  /** Rime contextId for this turn. Every audio chunk carries it back. */
  contextId: string;
  abort: AbortController;
  segmenter: ClauseSegmenter;
  ledger: HeardLedger;
  trace: TurnTrace;
  /** Once true, no audio for this turn may reach the speaker, ever. */
  fenced: boolean;
  /** PCM samples forwarded to the client for this turn. */
  samplesSent: number;
  audioSeq: number;
  /** Set when the client confirms silence, so stop latency is client-measured. */
  interruptedAt: number | null;
  openedAt: number;
  /** Text the planner produced, before any interruption. */
  fullText: string;
  toolsRunning: number;
  awaitingRimeDone: boolean;
  plannerDone: boolean;
  closed: boolean;
};

export type Sink = (msg: ServerMessage) => void;

export class VoiceSession {
  private cfg: RimeConfig;
  private rime: RimeClient;
  private planner: Planner;
  private history: Anthropic.MessageParam[] = [];
  private turnCounter = 0;
  private live: TurnState | null = null;
  /** Recently closed turns, kept so late client acks can still be reconciled. */
  private recent = new Map<number, TurnState>();
  private toolDelay = toolDelayMs();
  private micFrames = { duringPlayback: 0, duringTool: 0 };

  constructor(private sink: Sink) {
    this.cfg = rimeConfig();
    this.rime = new RimeClient(this.cfg);
    this.planner = makePlanner();

    this.rime.on('audio', (c) => this.onRimeAudio(c));
    this.rime.on('timestamps', (t) => this.onRimeTimestamps(t));
    this.rime.on('done', (ctx) => this.onRimeDone(ctx));
    this.rime.on('error', (e) =>
      this.sink({ type: 'log', level: 'error', msg: `rime: ${e.message}`, at: Date.now() }),
    );
  }

  async start() {
    this.sink({
      type: 'ready',
      speech: rimeDescriptor(this.cfg),
      planner: this.planner.name,
      toolDelayMs: this.toolDelay,
    });
    // Warm the socket now rather than on the first turn: a cold handshake on
    // turn one would otherwise be reported as time-to-first-audio.
    try {
      await this.rime.connect();
      this.sink({
        type: 'log',
        level: 'info',
        msg: `rime ws3 connected in ${this.rime.lastConnectMs}ms`,
        at: Date.now(),
      });
    } catch (e) {
      this.sink({
        type: 'log',
        level: 'warn',
        msg: `rime not connected: ${(e as Error).message}`,
        at: Date.now(),
      });
    }
  }

  handle(msg: ClientMessage) {
    switch (msg.type) {
      case 'user_final':
        void this.openTurn(msg.text, msg.at);
        break;
      case 'barge_in':
        this.interrupt(msg.turn, msg.at, msg.reason);
        break;
      case 'playback_stopped':
      case 'playback_drained':
        this.onPlaybackReport(msg.turn, msg.at, msg.samplesPlayed, msg.type === 'playback_stopped');
        break;
      case 'mic_frame':
        // Full-duplex proof: these keep arriving while we speak and while tools
        // run. If they ever stop, the application is half duplex regardless of
        // what the TTS model supports.
        if (msg.playing) this.micFrames.duringPlayback++;
        if (msg.toolRunning) this.micFrames.duringTool++;
        break;
      case 'set_tool_delay':
        this.toolDelay = Math.max(0, Math.min(15000, msg.ms));
        break;
      case 'reset':
        this.history = [];
        this.live = null;
        this.recent.clear();
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- turns ---

  private async openTurn(userText: string, _clientAt: number) {
    // A new utterance arriving while we are speaking IS a barge-in, even if the
    // client's VAD did not classify it as one first.
    if (this.live && !this.live.closed) {
      this.interrupt(this.live.id, Date.now(), 'asr_interim');
    }

    const id = ++this.turnCounter;
    const contextId = randomUUID();
    const openedAt = Date.now();
    this.micFrames = { duringPlayback: 0, duringTool: 0 };

    const t: TurnState = {
      id,
      contextId,
      abort: new AbortController(),
      segmenter: new ClauseSegmenter(),
      ledger: new HeardLedger(this.cfg.samplingRate),
      fenced: false,
      samplesSent: 0,
      audioSeq: 0,
      interruptedAt: null,
      openedAt,
      fullText: '',
      toolsRunning: 0,
      awaitingRimeDone: false,
      plannerDone: false,
      closed: false,
      trace: {
        turn: id,
        userText,
        ttfbMs: null,
        ttfaMs: null,
        interrupted: false,
        stopLatencyMs: null,
        fencedAudioChunks: 0,
        fencedToolResults: 0,
        wordsSynthesised: 0,
        wordsHeard: 0,
        heardTranscript: '',
        micFramesDuringPlayback: 0,
        micFramesDuringTool: 0,
        provider: `rime/${this.cfg.modelId}/${this.cfg.speaker}`,
        cold: this.rime.cold,
      },
    };
    this.live = t;
    this.recent.set(id, t);
    if (this.recent.size > 8) this.recent.delete([...this.recent.keys()][0]);

    this.sink({ type: 'turn_open', turn: id, userText, at: openedAt });

    const speakClause = async (raw: string) => {
      if (t.fenced) return;
      // Safety net: even if the model ignores its instruction to pass tool text
      // through verbatim, nothing reaches Rime without going through the
      // for-the-ear rewriter first.
      const { text } = forTheEar(raw);
      t.ledger.addSegment(t.contextId, text);
      try {
        await this.rime.speak(t.contextId, text);
        t.awaitingRimeDone = true;
      } catch (e) {
        this.sink({
          type: 'log',
          level: 'error',
          msg: `rime speak failed: ${(e as Error).message}`,
          at: Date.now(),
        });
      }
    };

    let result: { text: string; aborted: boolean };
    try {
      result = await this.planner.run(this.history, userText, t.abort.signal, this.toolDelay, {
        onText: (delta) => {
          if (t.fenced) return;
          t.fullText += delta;
          this.sink({ type: 'agent_text', turn: id, delta });
          for (const clause of t.segmenter.push(delta)) void speakClause(clause);
        },
        onToolStart: (toolId, name, args) => {
          t.toolsRunning++;
          this.sink({ type: 'tool_start', turn: id, id: toolId, name, args, at: Date.now() });
        },
        onToolEnd: (toolId, name, ok, fenced, ms) => {
          t.toolsRunning = Math.max(0, t.toolsRunning - 1);
          if (fenced) t.trace.fencedToolResults++;
          this.sink({ type: 'tool_end', turn: id, id: toolId, name, ok, fenced, ms });
        },
      });
    } catch (e) {
      this.sink({ type: 'error', msg: (e as Error).message });
      result = { text: t.fullText, aborted: true };
    }

    t.plannerDone = true;
    if (t.fenced || result.aborted) {
      // interrupt() owns closing this turn; it is waiting on the client's
      // silence confirmation to know what the technician actually heard.
      return;
    }

    for (const clause of t.segmenter.drain()) await speakClause(clause);
    await this.rime.flush();

    if (!t.awaitingRimeDone) this.closeTurn(t, /* heardAll */ true);
  }

  // ------------------------------------------------------------ barge-in ---

  /**
   * Barge-in. Every statement below is ordered by how directly it affects what
   * the technician hears; the cheapest, most user-visible action goes first.
   */
  private interrupt(turn: number, clientAt: number, reason: string) {
    const t = this.live;
    // A barge-in for a turn that is already over is not an error -- it is a
    // race we expect -- but it must not silence the turn that replaced it.
    if (!t || t.closed || t.id !== turn) return;

    t.fenced = true;
    t.trace.interrupted = true;
    t.interruptedAt = clientAt;

    // 1. Tell the browser to go silent. No await before this line. This is the
    //    number the acceptance test measures, and it is measured on the
    //    client's clock at both ends, so it already includes this round trip.
    this.sink({ type: 'stop_audio', turn: t.id, at: Date.now() });

    // 2. Cancel synthesis Rime has accepted but not yet emitted. Without this,
    //    Rime keeps generating a response nobody will hear, and the chunks
    //    arrive at a socket that now has to discard them one by one.
    this.rime.clear();

    // 3. Abort the model stream and any in-flight tool at the source. Fencing
    //    on arrival would be enough for correctness, but aborting means a stale
    //    result never exists in the first place.
    t.abort.abort();

    this.sink({
      type: 'log',
      level: 'info',
      msg: `barge-in on turn ${t.id} (${reason}): rime cleared, planner aborted`,
      at: Date.now(),
    });
  }

  // ------------------------------------------------------------ rime i/o ---

  private onRimeAudio(c: RimeAudioChunk) {
    const t = this.live;
    // Fencing, stated as an equality rather than a timing guess: a chunk is
    // current if and only if it carries the live turn's contextId and that turn
    // has not been fenced.
    if (!t || t.fenced || c.contextId !== t.contextId) {
      const owner = c.contextId ? this.findByContext(c.contextId) : null;
      if (owner) owner.trace.fencedAudioChunks++;
      else if (t) t.trace.fencedAudioChunks++;
      return;
    }

    if (t.trace.ttfbMs === null) t.trace.ttfbMs = Date.now() - t.openedAt;

    const samples = Math.floor(c.pcm.length / 2); // s16le mono
    t.samplesSent += samples;
    t.ledger.addSamples(t.contextId, samples);

    this.sink({
      type: 'audio',
      turn: t.id,
      b64: c.pcm.toString('base64'),
      seq: t.audioSeq++,
    });
  }

  private onRimeTimestamps(ts: RimeTimestamps) {
    const owner = ts.contextId ? this.findByContext(ts.contextId) : this.live;
    if (!owner) return;
    owner.ledger.addTimestamps(ts);
  }

  private onRimeDone(contextId: string | null) {
    const t = contextId ? this.findByContext(contextId) : this.live;
    if (!t || t.closed) return;
    t.awaitingRimeDone = false;
    if (t.fenced) return;
    if (!t.plannerDone) return;
    this.sink({ type: 'audio_end', turn: t.id });
    // We do not close here. The turn is not finished until the browser tells us
    // how much of it actually played -- see onPlaybackReport.
  }

  private findByContext(ctx: string): TurnState | null {
    for (const t of this.recent.values()) if (t.contextId === ctx) return t;
    return null;
  }

  // --------------------------------------------------- client reconciles ---

  private onPlaybackReport(turn: number, clientAt: number, samplesPlayed: number, stopped: boolean) {
    const t = this.recent.get(turn);
    if (!t || t.closed) return;

    if (stopped && t.interruptedAt !== null) {
      // Both timestamps come from the client clock, so no clock-skew
      // correction is needed and none is being hidden.
      t.trace.stopLatencyMs = Math.round(Math.max(0, clientAt - t.interruptedAt) * 10) / 10;
    }
    this.closeTurn(t, !stopped, samplesPlayed);
  }

  private closeTurn(t: TurnState, heardAll: boolean, samplesPlayed?: number) {
    if (t.closed) return;
    t.closed = true;

    const played = samplesPlayed ?? t.samplesSent;
    const heard = t.ledger.resolve(played);

    t.trace.wordsSynthesised = t.ledger.wordsSynthesised;
    t.trace.wordsHeard = heard.words;
    t.trace.heardTranscript = heard.text;
    t.trace.micFramesDuringPlayback = this.micFrames.duringPlayback;
    t.trace.micFramesDuringTool = this.micFrames.duringTool;

    // History reconciliation. This is the part that keeps the NEXT turn honest.
    //
    // We write only what the technician heard. If they cut us off after six
    // words, the model's history contains six words and an explicit marker --
    // not the full sentence it intended to say. That is why Bay Six never says
    // "like I said, bin A14" about audio that never reached a speaker.
    this.history.push({ role: 'user', content: t.trace.userText });
    if (t.trace.interrupted) {
      const partial = heard.text || '(nothing)';
      this.history.push({
        role: 'assistant',
        content: `${partial} [cut off here by the technician; they did not hear the rest]`,
      });
    } else if (t.fullText.trim()) {
      this.history.push({ role: 'assistant', content: t.fullText.trim() });
    }
    if (this.history.length > 20) this.history = this.history.slice(-20);

    this.sink({ type: 'trace', trace: t.trace });
    if (this.live === t) this.live = null;
    void heardAll;
  }

  // ------------------------------------------------------------- helpers ---

  /** Exposed for the acceptance-test harness. */
  get traceHistory(): Anthropic.MessageParam[] {
    return this.history;
  }

  get currentTurn(): number {
    return this.turnCounter;
  }

  setToolDelay(ms: number) {
    this.toolDelay = ms;
  }

  dispose() {
    this.live?.abort.abort();
    this.rime.close();
  }
}
