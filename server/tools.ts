import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { forTheEar } from './ear.js';

/**
 * Bay Six's tools. Two properties matter more than the data itself:
 *
 *  1. They are SLOW. A real parts-catalog round trip is 1-4 seconds. The brief
 *     asks for "a fixed delay in a tool call"; BAY6_TOOL_DELAY_MS is that dial,
 *     and it is exposed in the UI so a judge can turn it up live.
 *  2. They are CANCELLABLE. Every tool takes an AbortSignal. When the user
 *     barges in, in-flight work is aborted at the source rather than merely
 *     ignored on arrival -- so a stale result cannot re-enter the conversation
 *     even by accident.
 */

const root = process.cwd();
const parts = JSON.parse(readFileSync(join(root, 'fixtures/parts.json'), 'utf8'));
const torque = JSON.parse(readFileSync(join(root, 'fixtures/torque.json'), 'utf8'));

export class AbortedError extends Error {
  constructor() {
    super('tool aborted');
    this.name = 'AbortedError';
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError());
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new AbortedError());
      },
      { once: true },
    );
  });
}

export type ToolContext = { delayMs: number; signal: AbortSignal };

export type ToolResult = {
  /** Structured result for the model. */
  data: unknown;
  /** A short, already ear-normalised sentence the agent may speak verbatim. */
  spoken: string;
};

export const TOOL_DEFS = [
  {
    name: 'lookup_part',
    description:
      'Look up a part in the shop catalog by description and vehicle. Returns SKU, shelf bin, stock on hand and price. Slow: this hits the supplier catalog.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What the part is, e.g. "radiator cap"' },
        vehicle: { type: 'string', description: 'Year, model and engine, e.g. "2019 Civic 1.5T"' },
      },
      required: ['query', 'vehicle'],
    },
  },
  {
    name: 'torque_spec',
    description: 'Get the factory torque spec for a fastener on a vehicle.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fastener: { type: 'string' },
        vehicle: { type: 'string' },
      },
      required: ['fastener', 'vehicle'],
    },
  },
  {
    name: 'fluid_spec',
    description: 'Get the fluid grade and capacity for a system on a vehicle.',
    input_schema: {
      type: 'object' as const,
      properties: {
        system: { type: 'string', description: 'e.g. "engine oil", "coolant"' },
        vehicle: { type: 'string' },
      },
      required: ['system', 'vehicle'],
    },
  },
];

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9. ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function vehicleMatch(candidate: string, asked: string): boolean {
  const a = norm(asked), c = norm(candidate);
  if (c === a) return true;
  const year = a.match(/\b(19|20)\d{2}\b/)?.[0];
  const cYear = c.match(/\b(19|20)\d{2}\b/)?.[0];
  if (year && cYear && year !== cYear) return false;
  const tokens = a.split(' ').filter((t) => t.length > 2 && !/^\d{4}$/.test(t));
  return tokens.some((t) => words(c).includes(t));
}

/** Tokenise to whole words. */
function words(s: string): string[] {
  return norm(s).split(' ').filter(Boolean);
}

/**
 * Whole-word token overlap, scored.
 *
 * Substring matching is not good enough here and the failure is not academic:
 * "lug" is a substring of "plug", so a naive `includes` resolves "lug nut
 * torque" to the oil DRAIN PLUG spec -- 39 Nm instead of 108 Nm, delivered
 * confidently, to someone holding a torque wrench. Whole-word matching, and a
 * best-score-wins rule rather than first-hit-wins, is the difference between a
 * wheel that stays on and one that does not.
 */
function bestMatch<T>(rows: T[], field: (r: T) => string, asked: string): T | undefined {
  const want = words(asked);
  if (!want.length) return undefined;
  let best: T | undefined;
  let bestScore = 0;
  for (const r of rows) {
    const have = words(field(r));
    const score = want.filter((w) => have.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore > 0 ? best : undefined;
}

export async function runTool(
  name: string,
  args: any,
  ctx: ToolContext,
): Promise<ToolResult> {
  await delay(ctx.delayMs, ctx.signal);

  switch (name) {
    case 'lookup_part': {
      const q = norm(String(args?.query ?? ''));
      const v = String(args?.vehicle ?? '');
      // Whole-word tokens, and every asked-for word must be present. See the
      // note on bestMatch: substring matching on shop vocabulary is a safety
      // problem, not a relevance problem.
      const qTokens = words(q);
      const hits = parts.parts.filter(
        (p: any) =>
          qTokens.length > 0 &&
          qTokens.every((t: string) => words(p.name).includes(t)) &&
          p.vehicles.some((veh: string) => vehicleMatch(veh, v)),
      );
      if (hits.length === 0) {
        return {
          data: { found: false, query: args?.query, vehicle: v },
          spoken: `No catalog match for ${args?.query} on that vehicle. Want me to widen it?`,
        };
      }
      const p = hits[0];
      const stock =
        p.onHand > 0 ? `${p.onHand} on the shelf in bin ${p.bin}` : `none on the shelf, it is a special order`;
      return {
        data: { found: true, ...p, alternates: hits.slice(1).map((h: any) => h.sku) },
        spoken: forTheEar(`${p.name}, part number ${p.sku}. ${stock}.`).text,
      };
    }
    case 'torque_spec': {
      const f = norm(String(args?.fastener ?? ''));
      const v = String(args?.vehicle ?? '');
      const hit = bestMatch(
        torque.specs.filter((s: any) => vehicleMatch(s.vehicle, v)),
        (s: any) => s.fastener,
        f,
      ) as any;
      if (!hit) {
        return {
          data: { found: false },
          spoken: `I do not have a factory spec for that fastener. Do not guess it.`,
        };
      }
      return {
        data: { found: true, ...hit },
        spoken: forTheEar(
          `${hit.fastener}, ${hit.nm} Nm. That is ${hit.ftlb} ft-lb.${hit.note ? ` ${hit.note}.` : ''}`,
        ).text,
      };
    }
    case 'fluid_spec': {
      const sys = norm(String(args?.system ?? ''));
      const v = String(args?.vehicle ?? '');
      const hit = bestMatch(
        torque.fluids.filter((s: any) => vehicleMatch(s.vehicle, v)),
        (s: any) => s.system,
        sys,
      ) as any;
      if (!hit) return { data: { found: false }, spoken: `No fluid spec on file for that.` };
      return {
        data: { found: true, ...hit },
        spoken: forTheEar(`${hit.system}, ${hit.grade}, ${hit.capacityL}L.`).text,
      };
    }
    default:
      return { data: { error: `unknown tool ${name}` }, spoken: `That lookup is not available.` };
  }
}
