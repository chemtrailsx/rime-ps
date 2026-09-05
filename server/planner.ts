import Anthropic from '@anthropic-ai/sdk';
import { TOOL_DEFS, runTool, AbortedError, type ToolResult } from './tools.js';

/**
 * The reasoning layer.
 *
 * Two implementations behind one interface:
 *
 *  - ClaudePlanner: streaming Claude with tool use. A manual loop rather than
 *    the SDK tool runner, because barge-in has to abort the HTTP stream, the
 *    in-flight tool, and the loop itself at a point of OUR choosing -- and then
 *    hand back the partial text so the ledger can record what was actually said.
 *
 *  - ScriptedPlanner: a deterministic keyword planner over the same tools.
 *    It exists so that a judge with a Rime key and no Anthropic key can still
 *    reproduce every voice claim in RIME_EVIDENCE.md. The acceptance tests run
 *    against it by default, precisely because it removes model nondeterminism
 *    from measurements of voice behaviour.
 *
 * The active planner is reported in the HUD and stamped into every trace.
 */

export const SYSTEM_PROMPT = `You are Bay Six, the voice copilot for a working auto-repair bay.

You are talking to a technician whose hands are inside an engine and whose eyes are on the job. They cannot look at a screen and cannot scroll back. Everything you say has to survive being heard exactly once, from a speaker two metres away, over shop noise.

Rules:
- Answer in at most two short sentences. Lead with the answer, not a preamble.
- Never say "I'll look that up" and then look it up. Just look it up.
- Speak part numbers, torque values and fluid grades exactly as the tool returns them in its "spoken" field. That text has already been shaped for the ear. Do not re-format it, do not add digits, do not abbreviate units.
- If a tool has no answer, say so plainly and say not to guess. A wrong torque spec is a safety defect.
- If the technician corrects you mid-sentence, drop what you were saying and answer the correction. Never say "as I was saying", and never refer back to anything they did not hear you finish.
- No lists, no markdown, no emoji. This is speech.`;

export type PlannerEvents = {
  onText: (delta: string) => void;
  onToolStart: (id: string, name: string, args: unknown) => void;
  onToolEnd: (id: string, name: string, ok: boolean, fenced: boolean, ms: number) => void;
};

export interface Planner {
  readonly name: string;
  run(
    history: Anthropic.MessageParam[],
    userText: string,
    signal: AbortSignal,
    toolDelayMs: number,
    ev: PlannerEvents,
  ): Promise<{ text: string; aborted: boolean }>;
}

/** Shared tool execution with fencing semantics. */
async function execute(
  id: string,
  name: string,
  args: unknown,
  signal: AbortSignal,
  toolDelayMs: number,
  ev: PlannerEvents,
): Promise<ToolResult> {
  const t0 = Date.now();
  ev.onToolStart(id, name, args);
  try {
    const r = await runTool(name, args, { delayMs: toolDelayMs, signal });
    ev.onToolEnd(id, name, true, false, Date.now() - t0);
    return r;
  } catch (e) {
    const fenced = e instanceof AbortedError;
    ev.onToolEnd(id, name, false, fenced, Date.now() - t0);
    throw e;
  }
}

export class ClaudePlanner implements Planner {
  readonly name: string;
  private client: Anthropic;

  constructor(private model: string) {
    this.client = new Anthropic();
    this.name = `claude:${model}`;
  }

  async run(
    history: Anthropic.MessageParam[],
    userText: string,
    signal: AbortSignal,
    toolDelayMs: number,
    ev: PlannerEvents,
  ): Promise<{ text: string; aborted: boolean }> {
    const messages: Anthropic.MessageParam[] = [
      ...history,
      { role: 'user', content: userText },
    ];
    let spoken = '';

    try {
      for (;;) {
        if (signal.aborted) return { text: spoken, aborted: true };

        const stream = this.client.messages.stream(
          {
            model: this.model,
            max_tokens: 1024,
            // Latency is the product here. Low effort keeps adaptive thinking
            // on (which avoids the disabled-thinking failure modes) while
            // keeping time-to-first-token inside what a spoken turn tolerates.
            output_config: { effort: 'low' },
            system: SYSTEM_PROMPT,
            tools: TOOL_DEFS,
            messages,
          },
          { signal },
        );

        stream.on('text', (delta) => {
          spoken += delta;
          ev.onText(delta);
        });

        const message = await stream.finalMessage();

        if (message.stop_reason === 'refusal') {
          return { text: 'I cannot help with that one.', aborted: false };
        }
        if (message.stop_reason === 'end_turn') {
          return { text: spoken, aborted: false };
        }
        if (message.stop_reason === 'pause_turn') {
          messages.push({ role: 'assistant', content: message.content });
          continue;
        }

        const toolUses = message.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        if (toolUses.length === 0) return { text: spoken, aborted: false };

        messages.push({ role: 'assistant', content: message.content });

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const t of toolUses) {
          const r = await execute(t.id, t.name, t.input, signal, toolDelayMs, ev);
          results.push({
            type: 'tool_result',
            tool_use_id: t.id,
            content: JSON.stringify({ ...(r.data as object), spoken: r.spoken }),
          });
        }
        messages.push({ role: 'user', content: results });
      }
    } catch (e) {
      if (signal.aborted || e instanceof AbortedError || (e as Error)?.name === 'AbortError') {
        return { text: spoken, aborted: true };
      }
      if (e instanceof Anthropic.RateLimitError) {
        return {
          text: 'Reasoning is rate limited right now. Say that again in a moment.',
          aborted: false,
        };
      }
      if (e instanceof Anthropic.APIError) {
        return { text: 'I lost the catalog connection. Say that again.', aborted: false };
      }
      throw e;
    }
  }
}

/**
 * Deterministic planner. Same tools, same spoken formatting, no model.
 * Used for the acceptance tests so that a measured stop latency is a property
 * of the audio pipeline and not of a sampling temperature.
 */
export class ScriptedPlanner implements Planner {
  readonly name = 'scripted (no ANTHROPIC_API_KEY)';
  /** Tool-call ids must be unique across turns, or a late tool_end from a
   *  cancelled turn reconciles against the wrong row. */
  private seq = 0;

  async run(
    _history: Anthropic.MessageParam[],
    userText: string,
    signal: AbortSignal,
    toolDelayMs: number,
    ev: PlannerEvents,
  ): Promise<{ text: string; aborted: boolean }> {
    const t = userText.toLowerCase();
    const vehicle =
      userText.match(/\b(19|20)\d{2}\s+[A-Za-z]+(?:\s+[0-9.]+T?)?/i)?.[0] ?? '2019 Civic 1.5T';

    // Emit in word chunks so the segmenter and the TTFA path are exercised
    // exactly as they are with a real model stream.
    const emit = (s: string) => {
      for (const w of s.split(/(?<=\s)/)) ev.onText(w);
      return s;
    };

    // Whole-word matching, deliberately. "lug" is a substring of "plug", so a
    // naive includes() routes "spark plug torque" to the lug nut spec. Same
    // hazard as in server/tools.ts, same fix.
    const said = t.replace(/[^a-z0-9. ]/g, ' ').split(/\s+/).filter(Boolean);
    const mentions = (phrase: string) => phrase.split(' ').some((w) => said.includes(w));

    try {
      if (/torque|tighten|ft.?lb|nm\b/.test(t)) {
        const fastener =
          ['lug nut', 'spark plug', 'water pump', 'caliper', 'oil filter housing', 'drain plug'].find(
            (f) => mentions(f),
          ) ?? 'drain plug';
        const r = await execute(`s${++this.seq}`, 'torque_spec', { fastener, vehicle }, signal, toolDelayMs, ev);
        return { text: emit(r.spoken), aborted: false };
      }
      if (/oil|coolant|fluid|grade|capacity/.test(t) && !/filter|pump/.test(t)) {
        const system = t.includes('coolant') ? 'coolant' : 'engine oil';
        const r = await execute(`s${++this.seq}`, 'fluid_spec', { system, vehicle }, signal, toolDelayMs, ev);
        return { text: emit(r.spoken), aborted: false };
      }
      const query =
        ['radiator cap', 'oil filter', 'water pump', 'spark plug', 'timing belt', 'brake pad'].find(
          (p) => mentions(p),
        ) ?? 'radiator cap';
      const r = await execute(`s${++this.seq}`, 'lookup_part', { query, vehicle }, signal, toolDelayMs, ev);
      return { text: emit(r.spoken), aborted: false };
    } catch (e) {
      if (e instanceof AbortedError || signal.aborted) return { text: '', aborted: true };
      throw e;
    }
  }
}

export function makePlanner(): Planner {
  if (process.env.ANTHROPIC_API_KEY) {
    return new ClaudePlanner(process.env.ANTHROPIC_MODEL || 'claude-opus-5');
  }
  return new ScriptedPlanner();
}
