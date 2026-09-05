/**
 * Wire protocol between the browser and the Bay Six voice server.
 *
 * Design note: every message that can possibly result in audio reaching a
 * speaker carries a `turn` number. The client refuses to enqueue audio for any
 * turn other than the one it currently believes is live. The server refuses to
 * forward it. Barge-in correctness therefore does not depend on either side
 * alone -- see server/voice-session.ts and lib/client/audio-player.ts.
 */

export type SpeechProviderDescriptor = {
  provider: 'rime' | 'fallback-webspeech';
  modelId: string;
  speaker: string;
  lang: string;
  audioFormat: string;
  samplingRate: number;
  segment: string;
  endpoint: string;
  transport: string;
  keyPresent: boolean;
};

/** Browser -> server */
export type ClientMessage =
  | { type: 'hello'; sampleRate: number }
  /** Final recognised user utterance. Opens a new turn. */
  | { type: 'user_final'; text: string; at: number }
  /**
   * Voice activity detected while the agent was speaking or a tool was
   * running. This is barge-in. `at` is the client clock at the FIRST audio
   * frame that crossed the threshold, not when the message was sent, so the
   * measured stop latency includes our own network hop.
   */
  | { type: 'barge_in'; turn: number; at: number; reason: 'vad' | 'asr_interim' }
  /**
   * Client-side acknowledgement that playback actually went silent, plus the
   * exact number of PCM samples that reached the output device for that turn.
   * This is what makes the "what the user actually heard" ledger honest.
   */
  | { type: 'playback_stopped'; turn: number; at: number; samplesPlayed: number }
  | { type: 'playback_drained'; turn: number; at: number; samplesPlayed: number }
  /** Continuous mic liveness proof, used to demonstrate full duplex. */
  | { type: 'mic_frame'; at: number; rms: number; playing: boolean; toolRunning: boolean }
  | { type: 'set_tool_delay'; ms: number }
  | { type: 'reset' };

/** Server -> browser */
export type ServerMessage =
  | { type: 'ready'; speech: SpeechProviderDescriptor; planner: string; toolDelayMs: number }
  | { type: 'turn_open'; turn: number; userText: string; at: number }
  /** base64 PCM (s16le, mono, `samplingRate` Hz) for exactly this turn. */
  | { type: 'audio'; turn: number; b64: string; seq: number }
  | { type: 'audio_end'; turn: number }
  /** Server has ordered playback to stop. Client must flush its buffer NOW. */
  | { type: 'stop_audio'; turn: number; at: number }
  | { type: 'agent_text'; turn: number; delta: string }
  | { type: 'tool_start'; turn: number; id: string; name: string; args: unknown; at: number }
  | { type: 'tool_end'; turn: number; id: string; name: string; ok: boolean; fenced: boolean; ms: number }
  | { type: 'trace'; trace: TurnTrace }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string; at: number }
  | { type: 'error'; msg: string };

/** One row of user-visible, measurable behaviour per turn. */
export type TurnTrace = {
  turn: number;
  userText: string;
  /** ms from turn open to first PCM byte handed to the client. */
  ttfbMs: number | null;
  /** ms from turn open to the client reporting audible output. */
  ttfaMs: number | null;
  /** Whether this turn was cut off by the user. */
  interrupted: boolean;
  /**
   * ms from the client's barge-in timestamp to the client confirming silence.
   * This is the headline number: it is measured on the CLIENT clock at both
   * ends, so it includes the client->server->client round trip.
   */
  stopLatencyMs: number | null;
  /** Rime audio chunks that arrived for a superseded context and were dropped. */
  fencedAudioChunks: number;
  /** Tool results that resolved after the interrupt and were not spoken as current. */
  fencedToolResults: number;
  /** Words Rime was asked to say. */
  wordsSynthesised: number;
  /** Words that actually reached the speaker, derived from word timestamps. */
  wordsHeard: number;
  /** The exact text written back into the model's history for this turn. */
  heardTranscript: string;
  /** Mic frames received while audio was playing (full-duplex proof). */
  micFramesDuringPlayback: number;
  /** Mic frames received while a tool was running (full-duplex proof). */
  micFramesDuringTool: number;
  provider: string;
  cold: boolean;
};
