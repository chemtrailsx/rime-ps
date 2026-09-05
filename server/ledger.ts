import type { RimeTimestamps } from './rime-client.js';

/**
 * The heard-transcript ledger.
 *
 * This is the piece that keeps application state consistent with what the user
 * actually heard, which the brief calls out explicitly.
 *
 * The naive implementation of an interruptible agent writes the model's FULL
 * intended response into conversation history, even when the user cut it off
 * after six words. The model then believes it has told the technician a part
 * number it never finished saying, and its next turn says "like I said, bin
 * A14" about audio that never reached a speaker. That is the bug that makes
 * barge-in demos fall apart on the second turn.
 *
 * We fix it with two facts we already have:
 *   - Rime ws3 returns word timestamps for the audio it generated.
 *   - The browser reports exactly how many PCM samples reached the output
 *     device before it went silent.
 *
 * samplesPlayed / sampleRate = the wall-clock second at which the user stopped
 * hearing us. Every word whose START is before that second was heard; every
 * word after it was not. We write only the heard prefix into history, marked as
 * interrupted, so the model's next turn is grounded in the user's reality.
 */

export type SpokenSegment = {
  contextId: string;
  /** Text we asked Rime to say, in order. */
  text: string;
  /** Word timings from Rime, if the model/language supplied them. */
  timestamps: RimeTimestamps | null;
  /** PCM samples this segment contributed, in order. */
  samples: number;
};

export class HeardLedger {
  private segments: SpokenSegment[] = [];

  constructor(private sampleRate: number) {}

  addSegment(contextId: string, text: string) {
    this.segments.push({ contextId, text, timestamps: null, samples: 0 });
  }

  addTimestamps(ts: RimeTimestamps) {
    // Attach to the first segment for this context that has none yet.
    const seg = this.segments.find((s) => s.contextId === ts.contextId && s.timestamps === null);
    if (seg) seg.timestamps = ts;
  }

  addSamples(contextId: string, n: number) {
    const seg = [...this.segments].reverse().find((s) => s.contextId === contextId);
    if (seg) seg.samples += n;
  }

  get wordsSynthesised(): number {
    return this.segments.reduce(
      (n, s) => n + (s.timestamps?.words.length ?? s.text.split(/\s+/).filter(Boolean).length),
      0,
    );
  }

  /**
   * Resolve what the user heard, given the sample count the browser confirmed
   * reached the speaker across the whole turn.
   */
  resolve(samplesPlayedTotal: number): { text: string; words: number; complete: boolean } {
    let remaining = samplesPlayedTotal;
    const heardParts: string[] = [];
    let words = 0;
    let complete = true;

    for (const seg of this.segments) {
      if (remaining <= 0) {
        complete = false;
        break;
      }
      if (remaining >= seg.samples && seg.samples > 0) {
        // This segment played in full.
        heardParts.push(seg.text);
        words += seg.timestamps?.words.length ?? seg.text.split(/\s+/).filter(Boolean).length;
        remaining -= seg.samples;
        continue;
      }
      // Partial segment: cut on word timestamps where we have them.
      complete = false;
      const playedSec = remaining / this.sampleRate;
      const ts = seg.timestamps;
      if (ts && ts.words.length && ts.start.length === ts.words.length) {
        const heardWords = ts.words.filter((_, i) => ts.start[i] < playedSec);
        if (heardWords.length) {
          heardParts.push(heardWords.join(' '));
          words += heardWords.length;
        }
      } else {
        // No timestamps (e.g. a language without them): fall back to a linear
        // estimate. Reported as an approximation, never as a measurement.
        const frac = seg.samples > 0 ? remaining / seg.samples : 0;
        const all = seg.text.split(/\s+/).filter(Boolean);
        const n = Math.max(0, Math.floor(all.length * frac));
        if (n) {
          heardParts.push(all.slice(0, n).join(' '));
          words += n;
        }
      }
      remaining = 0;
      break;
    }

    if (remaining > 0 && this.segments.length) {
      // Played everything we queued.
      complete = true;
    }

    return { text: heardParts.join(' ').replace(/\s+/g, ' ').trim(), words, complete };
  }

  reset() {
    this.segments = [];
  }
}
