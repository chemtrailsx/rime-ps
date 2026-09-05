/**
 * Microphone meter and barge-in detector.
 *
 * The mic is NEVER closed and NEVER gated on whether the agent is speaking.
 * That is what makes the application full duplex, and it is a property of the
 * application, not of the TTS model -- the brief is explicit about that
 * distinction.
 *
 * Detection is deliberately dumb and fast: RMS over a 128-frame quantum,
 * compared against a noise floor calibrated during the first second, requiring
 * a short run of consecutive loud quanta to fire. Anything cleverer (a neural
 * VAD, an ASR interim result) is slower, and on barge-in every millisecond is
 * user-visible. The ASR interim result is used too, as a second trigger, but it
 * arrives later and is treated as a backstop rather than the primary path.
 *
 * Echo is handled upstream by getUserMedia's echoCancellation, which is why the
 * agent does not interrupt itself. That dependency is disclosed in the README:
 * on a device without AEC, Bay Six needs a headset.
 */
class MicMeter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.floor = 0.004;
    this.calibN = 0;
    this.calibSum = 0;
    this.calibBlocks = o.calibBlocks || 180; // ~1 s at 24 kHz
    this.runNeeded = o.runNeeded || 3; // ~16 ms of sustained speech
    this.run = 0;
    this.armed = false; // only fires when the main thread says we are speaking
    this.firstCrossCtxTime = 0;
    this.frameCountdown = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === 'arm') {
        this.armed = e.data.armed;
        if (!this.armed) this.run = 0;
      } else if (e.data.type === 'recalibrate') {
        this.calibN = 0;
        this.calibSum = 0;
      }
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);

    if (this.calibN < this.calibBlocks) {
      this.calibSum += rms;
      this.calibN++;
      if (this.calibN === this.calibBlocks) {
        // Threshold sits well above the measured room, so shop noise alone
        // cannot cut the agent off mid-part-number.
        this.floor = Math.max(0.004, (this.calibSum / this.calibN) * 3.5);
        this.port.postMessage({ type: 'calibrated', floor: this.floor });
      }
    }

    if (rms > this.floor) {
      if (this.run === 0) this.firstCrossCtxTime = currentTime;
      this.run++;
      if (this.armed && this.run === this.runNeeded) {
        this.port.postMessage({
          type: 'barge_in',
          // The time of the FIRST loud quantum, not the one that convinced us.
          // Reporting the later one would quietly shave ~16 ms off every
          // measured stop latency.
          ctxTime: this.firstCrossCtxTime,
          rms,
        });
      }
    } else {
      this.run = 0;
    }

    // Liveness heartbeat proving the mic keeps delivering audio while the agent
    // speaks and while tools run.
    if (this.frameCountdown <= 0) {
      this.port.postMessage({ type: 'frame', rms, ctxTime: currentTime });
      this.frameCountdown = 8; // ~43 ms
    } else {
      this.frameCountdown--;
    }
    return true;
  }
}

registerProcessor('mic-meter', MicMeter);
