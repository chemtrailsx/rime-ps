'use client';

import type { ClientMessage, ServerMessage, SpeechProviderDescriptor, TurnTrace } from '@/server/protocol';

/**
 * Browser half of the Bay Six voice loop.
 *
 * Three things run at once and never block each other:
 *   - the microphone, which is open continuously (full duplex),
 *   - speech recognition, which produces the user's turns,
 *   - the PCM player, which renders Rime audio and can be silenced instantly.
 *
 * The AudioContext is pinned to Rime's sample rate. Letting the browser pick
 * its native 48 kHz would force a resample on every chunk and make
 * `samplesPlayed` an estimate rather than a count -- and `samplesPlayed` is the
 * evidence for what the technician actually heard.
 */

export type ClientEvents = {
  onReady: (d: SpeechProviderDescriptor, planner: string, toolDelayMs: number) => void;
  onState: (s: ClientState) => void;
  onUserText: (text: string, final: boolean) => void;
  onAgentText: (turn: number, delta: string) => void;
  onTurnOpen: (turn: number, userText: string) => void;
  onTool: (e: { turn: number; id: string; name: string; phase: 'start' | 'end'; fenced?: boolean; ms?: number }) => void;
  onTrace: (t: TurnTrace) => void;
  onLog: (level: string, msg: string) => void;
  onBargeIn: (turn: number) => void;
};

export type ClientState = {
  connected: boolean;
  micOpen: boolean;
  listening: boolean;
  speaking: boolean;
  toolRunning: boolean;
  turn: number;
  noiseFloor: number;
  micRms: number;
  outputLatencyMs: number;
};

const SAMPLE_RATE = 24000;

export class VoiceClient {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private player: AudioWorkletNode | null = null;
  private meter: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private recognition: any = null;
  private liveTurn = 0;
  private state: ClientState = {
    connected: false,
    micOpen: false,
    listening: false,
    speaking: false,
    toolRunning: false,
    turn: 0,
    noiseFloor: 0,
    micRms: 0,
    outputLatencyMs: 0,
  };

  constructor(private ev: ClientEvents) {}

  // ---------------------------------------------------------------- setup ---

  async start() {
    await this.openSocket();
    await this.openAudio();
    this.startRecognition();
    // Deliberately NOT awaited. A permission dialog the user ignores leaves
    // getUserMedia pending forever; gating session start on it would hang the
    // whole product behind a prompt. Playback, reasoning and typed turns come
    // up immediately, and the mic joins when (or if) it is granted.
    void this.openMic();
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws/voice`);
      this.ws = ws;
      ws.onopen = () => {
        this.patch({ connected: true });
        this.send({ type: 'hello', sampleRate: SAMPLE_RATE });
        resolve();
      };
      ws.onerror = () => reject(new Error('voice socket failed'));
      ws.onclose = () => this.patch({ connected: false });
      ws.onmessage = (e) => this.onServer(JSON.parse(e.data) as ServerMessage);
    });
  }

  private async openAudio() {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule('/worklets/pcm-player.js');
    await ctx.audioWorklet.addModule('/worklets/mic-meter.js');

    const player = new AudioWorkletNode(ctx, 'pcm-player', { outputChannelCount: [1] });
    player.connect(ctx.destination);
    player.port.onmessage = (e) => this.onPlayerMessage(e.data);
    this.player = player;

    this.patch({ outputLatencyMs: Math.round((ctx.outputLatency || 0) * 1000) });
  }

  /**
   * The microphone is a separate failure domain from playback. Denied, absent,
   * blocked by an embedding context, or simply left sitting behind an
   * unanswered permission dialog -- in every case the session still runs on
   * typed turns rather than refusing to start. Voice barge-in is gone, so the
   * UI says so rather than quietly looking healthy.
   */
  private async openMic() {
    const ctx = this.ctx!;
    try {
      this.stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: {
            // Without AEC the agent hears its own voice through the speakers
            // and barges in on itself. Disclosed in the README as a hardware
            // dependency: on a device without AEC, use a headset.
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        }),
        20000,
        'microphone permission was never answered',
      );
      const src = ctx.createMediaStreamSource(this.stream);
      const meter = new AudioWorkletNode(ctx, 'mic-meter', { processorOptions: {} });
      src.connect(meter);
      // The meter analyses only; it must not feed the speakers.
      meter.port.onmessage = (e) => this.onMeterMessage(e.data);
      this.meter = meter;
      this.patch({ micOpen: true });
    } catch (e) {
      this.ev.onLog(
        'warn',
        `microphone unavailable (${(e as Error).message || (e as Error).name}): ` +
          'voice barge-in is off. Type a turn and use the Interrupt button, which sends ' +
          'the identical barge_in message and produces a real measurement.',
      );
      this.patch({ micOpen: false });
    }
  }

  /**
   * Manual barge-in, for demos and environments without a microphone. It sends
   * the identical `barge_in` message the VAD sends, so it exercises the same
   * server path and produces a real stop-latency measurement.
   */
  interruptNow() {
    this.bargeIn('vad', performance.now());
  }

  /** AudioContext time -> performance.now() milliseconds, sampled fresh. */
  private ctxToWall(ctxTime: number): number {
    const ctx = this.ctx!;
    const offset = performance.now() - ctx.currentTime * 1000;
    return offset + ctxTime * 1000;
  }

  // ------------------------------------------------------------------ ASR ---

  private startRecognition() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      this.ev.onLog('warn', 'Web Speech API unavailable: use Chrome, or type a turn in the box.');
      return;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';

    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) {
            this.ev.onUserText(text, true);
            this.sendUserFinal(text);
          }
        } else {
          interim += r[0].transcript;
        }
      }
      if (interim.trim()) {
        this.ev.onUserText(interim.trim(), false);
        // Backstop trigger. The energy VAD in the worklet almost always fires
        // first; this catches the case where the tech speaks quietly enough to
        // stay under the energy threshold but clearly enough to recognise.
        if (this.state.speaking) this.bargeIn('asr_interim', performance.now());
      }
    };
    rec.onend = () => {
      // Chrome ends recognition on its own schedule. Restart immediately or the
      // session silently goes half duplex after ~60 s.
      if (this.state.micOpen) {
        try {
          rec.start();
        } catch {
          /* already starting */
        }
      }
    };
    rec.onerror = (e: any) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.ev.onLog('warn', `asr: ${e.error}`);
      }
    };

    try {
      rec.start();
      this.patch({ listening: true });
    } catch {
      /* already started */
    }
    this.recognition = rec;
  }

  // ------------------------------------------------------------- messages ---

  private onServer(msg: ServerMessage) {
    switch (msg.type) {
      case 'ready':
        this.ev.onReady(msg.speech, msg.planner, msg.toolDelayMs);
        break;
      case 'turn_open':
        this.liveTurn = msg.turn;
        this.player?.port.postMessage({ type: 'turn', turn: msg.turn });
        this.meter?.port.postMessage({ type: 'arm', armed: true });
        this.patch({ turn: msg.turn, speaking: true });
        this.ev.onTurnOpen(msg.turn, msg.userText);
        break;
      case 'audio': {
        if (msg.turn !== this.liveTurn) return; // client-side fence
        const pcm = int16ToFloat32(base64ToBytes(msg.b64));
        this.player?.port.postMessage({ type: 'push', turn: msg.turn, pcm }, [pcm.buffer]);
        break;
      }
      case 'stop_audio':
        if (msg.turn !== this.liveTurn) return;
        this.player?.port.postMessage({ type: 'flush' });
        break;
      case 'audio_end':
        break;
      case 'agent_text':
        this.ev.onAgentText(msg.turn, msg.delta);
        break;
      case 'tool_start':
        this.patch({ toolRunning: true });
        this.ev.onTool({ turn: msg.turn, id: msg.id, name: msg.name, phase: 'start' });
        break;
      case 'tool_end':
        this.patch({ toolRunning: false });
        this.ev.onTool({
          turn: msg.turn,
          id: msg.id,
          name: msg.name,
          phase: 'end',
          fenced: msg.fenced,
          ms: msg.ms,
        });
        break;
      case 'trace':
        this.patch({ speaking: false });
        this.meter?.port.postMessage({ type: 'arm', armed: false });
        this.ev.onTrace(msg.trace);
        break;
      case 'log':
        this.ev.onLog(msg.level, msg.msg);
        break;
      case 'error':
        this.ev.onLog('error', msg.msg);
        break;
    }
  }

  private onPlayerMessage(m: any) {
    if (m.type === 'flushed') {
      this.patch({ speaking: false });
      this.send({
        type: 'playback_stopped',
        turn: m.turn,
        // Latency-corrected: the last sample handed to the device is still in
        // the output buffer for outputLatency seconds. Correcting toward the
        // eardrum makes the reported stop latency slightly WORSE, which is the
        // direction honesty runs in.
        at: this.ctxToWall(m.ctxTime) + (this.ctx?.outputLatency ?? 0) * 1000,
        samplesPlayed: m.samplesPlayed,
      });
    } else if (m.type === 'drained') {
      this.send({
        type: 'playback_drained',
        turn: m.turn,
        at: this.ctxToWall(m.ctxTime),
        samplesPlayed: m.samplesPlayed,
      });
    } else if (m.type === 'rejected') {
      this.ev.onLog('info', `client fence dropped audio for turn ${m.turn} (live ${m.live})`);
    }
  }

  private onMeterMessage(m: any) {
    if (m.type === 'calibrated') {
      this.patch({ noiseFloor: m.floor });
      this.ev.onLog('info', `mic calibrated: noise floor ${m.floor.toFixed(4)}`);
    } else if (m.type === 'frame') {
      this.state.micRms = m.rms;
      this.send({
        type: 'mic_frame',
        at: performance.now(),
        rms: m.rms,
        playing: this.state.speaking,
        toolRunning: this.state.toolRunning,
      });
    } else if (m.type === 'barge_in') {
      this.bargeIn('vad', this.ctxToWall(m.ctxTime));
    }
  }

  private bargeIn(reason: 'vad' | 'asr_interim', at: number) {
    if (!this.state.speaking || this.liveTurn === 0) return;
    this.ev.onBargeIn(this.liveTurn);
    this.send({ type: 'barge_in', turn: this.liveTurn, at, reason });
  }

  // ---------------------------------------------------------------- public ---

  sendUserFinal(text: string) {
    this.send({ type: 'user_final', text, at: performance.now() });
  }

  setToolDelay(ms: number) {
    this.send({ type: 'set_tool_delay', ms });
  }

  reset() {
    this.send({ type: 'reset' });
  }

  private send(m: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private patch(p: Partial<ClientState>) {
    this.state = { ...this.state, ...p };
    this.ev.onState(this.state);
  }

  async resumeAudio() {
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
  }

  dispose() {
    this.recognition?.stop?.();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ws?.close();
    void this.ctx?.close();
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function int16ToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** Reject a pending promise that a user (or an embedding context) never answers. */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
