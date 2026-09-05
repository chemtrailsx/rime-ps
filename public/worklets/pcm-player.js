/**
 * Sample-accurate PCM player with instant flush.
 *
 * Why an AudioWorklet instead of an <audio> element or MediaSource:
 *
 *  - Stopping an <audio> element stops a *decoder*, not a buffer. Whatever the
 *    browser has already handed to the output device still plays. That is
 *    audible as a syllable of overrun on every barge-in.
 *  - More importantly, an <audio> element cannot tell you HOW MUCH played. Bay
 *    Six needs that number: `samplesPlayed / sampleRate` is the second at which
 *    the technician stopped hearing us, and every word after that second must
 *    be removed from the model's history.
 *
 * So we own the buffer. `flush` drops it on the next render quantum and reports
 * exactly how many samples reached the output, along with the AudioContext time
 * at which that happened.
 *
 * Timing caveat, disclosed in RIME_EVIDENCE.md: `currentTime` is the boundary
 * of the last rendered quantum (128 frames = 5.33 ms at 24 kHz). The device
 * output buffer adds AudioContext.outputLatency on top. The main thread reports
 * both the raw figure and the latency-corrected one; neither is presented as
 * the other.
 */
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Float32Array[]} */
    this.queue = [];
    this.readOffset = 0;
    this.played = 0;
    this.turn = 0;
    this.reportCountdown = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'push') {
        // Only accept audio for the turn the main thread believes is live.
        // Belt and braces: the server already fenced this, but a client-side
        // check means a single bug on either side cannot produce stale speech.
        if (m.turn !== this.turn) {
          this.port.postMessage({ type: 'rejected', turn: m.turn, live: this.turn });
          return;
        }
        this.queue.push(m.pcm);
      } else if (m.type === 'turn') {
        this.turn = m.turn;
        this.queue.length = 0;
        this.readOffset = 0;
        this.played = 0;
      } else if (m.type === 'flush') {
        const played = this.played;
        this.queue.length = 0;
        this.readOffset = 0;
        this.port.postMessage({
          type: 'flushed',
          turn: this.turn,
          samplesPlayed: played,
          ctxTime: currentTime,
        });
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    let i = 0;
    let drainedThisBlock = false;
    while (i < out.length) {
      if (this.queue.length === 0) {
        // Underrun or end of speech: emit silence rather than stalling.
        out.fill(0, i);
        drainedThisBlock = true;
        break;
      }
      const chunk = this.queue[0];
      const n = Math.min(out.length - i, chunk.length - this.readOffset);
      out.set(chunk.subarray(this.readOffset, this.readOffset + n), i);
      i += n;
      this.readOffset += n;
      this.played += n;
      if (this.readOffset >= chunk.length) {
        this.queue.shift();
        this.readOffset = 0;
      }
    }

    if (drainedThisBlock && this.played > 0 && this.queue.length === 0) {
      if (this.reportCountdown <= 0) {
        this.port.postMessage({
          type: 'drained',
          turn: this.turn,
          samplesPlayed: this.played,
          ctxTime: currentTime,
        });
        this.reportCountdown = 40; // ~0.2 s between idle reports
      } else {
        this.reportCountdown--;
      }
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
