/**
 * Streaming clause segmenter.
 *
 * Time-to-first-audio is dominated by how long we wait before handing Rime
 * anything at all. Waiting for a complete model response costs whole seconds.
 * Sending every token costs prosody -- Rime would synthesise fragments with no
 * sentence contour.
 *
 * So we emit at the first *safe* boundary: sentence-final punctuation, or a
 * comma once enough words have accumulated. The guard that matters for this
 * product is `endsMidIdentifier`: we must never split "R C, eleven forty-seven,
 * B" across two synthesis requests, because Rime would then apply two separate
 * sentence contours to one part number and the tech would hear two parts.
 */

const MIN_WORDS_FOR_COMMA_FLUSH = 6;

/** True if the buffer ends somewhere inside a spelled-out identifier. */
function endsMidIdentifier(s: string): boolean {
  const tail = s.slice(-48);
  // A trailing single capital letter, or "..., B" style group, means an
  // identifier is still being spelled out.
  if (/(?:^|[\s,])[A-Z](?:\s[A-Z])*\s*,?\s*$/.test(tail)) return true;
  // Numbers still being grouped: "eleven forty-" or a trailing "oh".
  if (/\b(?:oh|point|hundred|thousand)\s*$/i.test(tail)) return true;
  if (/-\s*$/.test(tail)) return true;
  return false;
}

export class ClauseSegmenter {
  private buf = '';

  /** Feed a model delta. Returns zero or more clauses ready to synthesise. */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];

    for (;;) {
      const m = this.buf.match(/[.!?](?=\s|$)/);
      if (m && m.index !== undefined) {
        const cut = m.index + 1;
        const clause = this.buf.slice(0, cut).trim();
        const rest = this.buf.slice(cut);
        if (clause && !endsMidIdentifier(clause.slice(0, -1))) {
          out.push(clause);
          this.buf = rest;
          continue;
        }
      }
      // No sentence end. Consider a comma flush to shave latency on the first
      // clause of a turn, which is the one the user is waiting on.
      const ci = this.buf.lastIndexOf(',');
      if (ci > 0) {
        const head = this.buf.slice(0, ci + 1).trim();
        if (head.split(/\s+/).length >= MIN_WORDS_FOR_COMMA_FLUSH && !endsMidIdentifier(head.slice(0, -1))) {
          out.push(head);
          this.buf = this.buf.slice(ci + 1);
          continue;
        }
      }
      break;
    }
    return out;
  }

  /** Everything still buffered, at end of turn. */
  drain(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }
}
