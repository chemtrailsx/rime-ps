import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Harness, samplesForMs } from './harness.js';
import { forTheEar } from '../server/ear.js';
import { rimeConfig, rimeDescriptor } from '../server/config.js';

/**
 * Acceptance-test runner.
 *
 * Every threshold in ACCEPTANCE below was written down before the demo was
 * recorded, which is the whole point of an acceptance test. The runner prints a
 * pass/fail table, writes the raw per-trial data to evidence/runs/, and
 * regenerates the results table in RIME_EVIDENCE.md.
 *
 *   npm run evidence          # 6 tests, ~2 minutes, needs RIME_API_KEY
 *   npm run evidence -- --n 40
 */

loadEnv();

const args = process.argv.slice(2);
const N = Number(argVal('--n') ?? 20);
const only = argVal('--only');
/**
 * `--remote wss://host/ws/voice` runs the identical tests against a DEPLOYED
 * instance over the real socket, so the measured stop latency includes the
 * full network round trip a user actually pays.
 */
const remote = argVal('--remote');

const ACCEPTANCE = {
  AT1_STOP_P95_MS: 150,
  AT2_FENCED_AUDIO_CHUNKS: 0,
  AT3_STALE_TOOL_RESULTS_SPOKEN: 0,
  AT4_HEARD_PREFIX_VIOLATIONS: 0,
  AT5_MIN_MIC_FRAMES: 1,
  AT6_UNCHANGED_IDENTIFIERS: 0,
};

type Test = { id: string; claim: string; run: (h: Harness) => Promise<TestResult> };
type TestResult = { pass: boolean; measured: string; detail: Record<string, unknown> };

const tests: Test[] = [
  {
    id: 'AT-1',
    claim: `p95 barge-in to silence, network excluded, <= ${ACCEPTANCE.AT1_STOP_P95_MS} ms`,
    async run(h) {
      // Separate model/server latency from network latency, which the brief
      // asks for explicitly. On a remote run the raw figure is one full
      // client -> server -> client round trip PLUS whatever the server spends;
      // subtracting the median RTT measured on the SAME socket leaves the part
      // this project is actually responsible for.
      //
      // The threshold is applied to the network-excluded figure, because that
      // is what the claim says. The end-to-end figure is reported alongside it
      // and is never hidden: it is what a user at this distance really waits.
      const rtt = await h.measureRtt();
      const lat: number[] = [];
      const trials: unknown[] = [];
      h.setToolDelay(0); // isolate the audio path from tool latency
      for (let i = 0; i < N; i++) {
        const r = await h.sayAndInterrupt(
          'radiator cap for the 2019 Civic 1.5T',
          { samples: samplesForMs(350) },
        );
        const ms = r.trace?.stopLatencyMs;
        if (typeof ms === 'number') lat.push(ms);
        trials.push({
          i,
          stopLatencyMs: ms,
          chunksAfterStop: r.chunksAfterStop,
          fencedAudioChunks: r.trace?.fencedAudioChunks,
        });
      }
      const net = rtt ?? 0;
      const excl = lat.map((x) => Math.max(0, x - net));
      const p95e = percentile(excl, 95);
      const p95raw = percentile(lat, 95);
      return {
        pass: excl.length > 0 && p95e <= ACCEPTANCE.AT1_STOP_P95_MS,
        measured:
          `network-excluded p50=${percentile(excl, 50).toFixed(1)}ms p95=${p95e.toFixed(1)}ms` +
          `  |  end-to-end p50=${percentile(lat, 50).toFixed(1)}ms p95=${p95raw.toFixed(1)}ms` +
          (rtt === null ? '  (no network in the loop)' : `  |  median RTT ${rtt.toFixed(1)}ms`),
        detail: {
          medianRttMs: rtt,
          networkExcluded: {
            p50: percentile(excl, 50),
            p95: p95e,
            max: excl.length ? Math.max(...excl) : null,
            samples: excl,
          },
          endToEnd: {
            p50: percentile(lat, 50),
            p95: p95raw,
            max: lat.length ? Math.max(...lat) : null,
            samples: lat,
          },
          trials,
        },
      };
    },
  },
  {
    id: 'AT-2',
    claim: 'zero audio chunks from a superseded turn ever reach the speaker',
    async run(h) {
      let after = 0;
      let dead = 0;
      let fenced = 0;
      h.setToolDelay(0);
      for (let i = 0; i < N; i++) {
        const r = await h.sayAndInterrupt(
          'radiator cap for the 2018 Civic 1.5T',
          { samples: samplesForMs(250) },
        );
        after += r.chunksAfterStop;
        dead += r.chunksForDeadTurn;
        fenced += r.trace?.fencedAudioChunks ?? 0;
      }
      return {
        pass: after === ACCEPTANCE.AT2_FENCED_AUDIO_CHUNKS && dead === 0,
        measured: `${after} chunks reached the speaker after stop; ${dead} for a dead turn; ${fenced} dropped server-side by contextId`,
        detail: { chunksAfterStop: after, chunksForDeadTurn: dead, fencedServerSide: fenced, n: N },
      };
    },
  },
  {
    id: 'AT-3',
    claim: 'a tool result that resolves after an interrupt is never spoken as current',
    async run(h) {
      // The brief's own full-duplex test: a fixed delay in a tool call,
      // interrupted mid-flight.
      h.setToolDelay(3000);
      let spokenStale = 0;
      let cancelled = 0;
      const trials: unknown[] = [];
      const n = Math.min(N, 10);
      for (let i = 0; i < n; i++) {
        const r = await h.sayAndInterrupt('radiator cap for the 2018 Civic 1.5T', 1200);
        const fencedTools = r.toolEvents.filter((t) => t.fenced).length;
        cancelled += fencedTools;
        // If a stale result had been spoken, the 2018-only SKU would appear in
        // the audio ledger for a turn the user cut off before any lookup
        // finished.
        const heard = r.trace?.heardTranscript ?? '';
        if (/eleven forty-seven/i.test(heard)) spokenStale++;
        trials.push({
          i,
          fencedTools,
          toolEvents: r.toolEvents,
          heard,
          fencedToolResults: r.trace?.fencedToolResults,
        });
      }
      h.setToolDelay(0);
      return {
        pass: spokenStale === ACCEPTANCE.AT3_STALE_TOOL_RESULTS_SPOKEN && cancelled === n,
        measured: `${cancelled}/${n} in-flight lookups cancelled at the source; ${spokenStale} stale results spoken`,
        detail: { cancelled, spokenStale, n, trials },
      };
    },
  },
  {
    id: 'AT-4',
    claim: 'the model history contains exactly what was heard, never more',
    async run(h) {
      h.setToolDelay(0);
      let violations = 0;
      const trials: unknown[] = [];
      const n = Math.min(N, 12);
      for (let i = 0; i < n; i++) {
        const r = await h.sayAndInterrupt(
          'radiator cap for the 2019 Civic 1.5T',
          { samples: samplesForMs(400) },
        );
        const t = r.trace;
        if (!t) {
          violations++;
          continue;
        }
        const heardWords = t.heardTranscript.split(/\s+/).filter(Boolean);
        // Two properties must hold:
        //   1. we never claim to have said more than we synthesised, and
        //   2. an interrupted turn must record strictly fewer words than it
        //      generated -- otherwise the ledger is not doing anything.
        const overclaim = t.wordsHeard > t.wordsSynthesised;
        const noTruncation = t.interrupted && t.wordsHeard >= t.wordsSynthesised;
        if (overclaim || noTruncation) violations++;
        trials.push({
          i,
          wordsHeard: t.wordsHeard,
          wordsSynthesised: t.wordsSynthesised,
          heard: t.heardTranscript,
          heardWordCount: heardWords.length,
        });
      }
      // The history itself must carry the cut-off marker, not the full
      // sentence. Model history is deliberately not exposed over the wire, so
      // this half of the assertion only runs on the local transport; a remote
      // run reports it as not-checked rather than silently passing.
      const hist = h.history as { role: string; content: unknown }[] | null;
      const lastAssistant = hist ? [...hist].reverse().find((m) => m.role === 'assistant') : null;
      const marked = hist
        ? typeof lastAssistant?.content === 'string' &&
          lastAssistant.content.includes('[cut off here')
        : null;
      return {
        pass: violations === ACCEPTANCE.AT4_HEARD_PREFIX_VIOLATIONS && marked !== false,
        measured:
          `${violations} violations in ${n} interrupted turns; ` +
          (marked === null
            ? 'history marker not checked (remote transport)'
            : `history marks the cut-off: ${marked}`),
        detail: { violations, n, historyMarked: marked, trials, lastAssistant },
      };
    },
  },
  {
    id: 'AT-5',
    claim: 'the application keeps accepting user audio while speaking AND while tools run',
    async run(h) {
      h.setToolDelay(2500);
      const r = await h.say('torque spec for the drain plug on a 2019 Civic 1.5T');
      h.setToolDelay(0);
      const okSpeak = r.micFramesDuringPlayback >= ACCEPTANCE.AT5_MIN_MIC_FRAMES;
      const okTool = r.micFramesDuringTool >= ACCEPTANCE.AT5_MIN_MIC_FRAMES;
      return {
        pass: okSpeak && okTool,
        measured: `${r.micFramesDuringPlayback} mic frames while speaking, ${r.micFramesDuringTool} while the lookup ran`,
        detail: {
          micFramesDuringPlayback: r.micFramesDuringPlayback,
          micFramesDuringTool: r.micFramesDuringTool,
        },
      };
    },
  },
  {
    id: 'AT-6',
    claim: 'every identifier, torque value and fluid grade is rewritten for the ear before synthesis',
    async run() {
      // Pure function test: no network, no model, fully deterministic.
      const fixtures: string[] = JSON.parse(
        readFileSync(join(process.cwd(), 'fixtures/pronunciation.json'), 'utf8'),
      ).cases.map((c: any) => c.text);
      const rows = fixtures.map((before) => {
        const { text: after, rulesFired } = forTheEar(before);
        // "Unchanged" means a raw identifier survived into speech.
        const stillRaw =
          /[A-Z]{2,3}-\d{2,6}/.test(after) ||
          /\d+\s*Nm\b/i.test(after) ||
          /\b\d{1,2}W-\d{2}\b/.test(after);
        return { before, after, rulesFired, stillRaw };
      });
      const bad = rows.filter((r) => r.stillRaw).length;
      return {
        pass: bad === ACCEPTANCE.AT6_UNCHANGED_IDENTIFIERS,
        measured: `${rows.length - bad}/${rows.length} fixtures rewritten; ${bad} raw identifiers survived`,
        detail: { rows },
      };
    },
  },
];

async function main() {
  const cfg = rimeConfig();
  const needsRime = tests.some((t) => t.id !== 'AT-6' && (!only || t.id === only));

  if (needsRime && !remote && !cfg.apiKey) {
    console.error(
      '\n  RIME_API_KEY is not set.\n\n' +
        '  AT-1..AT-5 measure real audio over the shipped Rime ws3 socket, so they\n' +
        '  cannot run without a key. AT-6 is a pure function test and can:\n\n' +
        '      npm run evidence -- --only AT-6\n',
    );
    process.exit(2);
  }

  const h = new Harness(remote);
  try {
    await h.start();
  } catch (e) {
    console.error(`
  could not reach ${remote ?? 'the local session'}: ${(e as Error).message}
`);
    process.exit(3);
  }

  const started = new Date().toISOString();
  const results: Record<string, TestResult & { claim: string }> = {};

  console.log(`\n  Bay Six acceptance tests   n=${N}`);
  console.log(`  rime: ${cfg.modelId}/${cfg.speaker}/${cfg.lang} ${cfg.audioFormat}@${cfg.samplingRate} via ${cfg.wsUrl}`);
  console.log(`  planner: ${process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_MODEL || 'claude-opus-5' : 'scripted (deterministic)'}\n`);

  for (const t of tests) {
    if (only && t.id !== only) continue;
    process.stdout.write(`  ${t.id}  ${t.claim}\n        running...`);
    let r: TestResult;
    try {
      r = await t.run(h);
    } catch (e) {
      r = { pass: false, measured: `threw: ${(e as Error).message}`, detail: {} };
    }
    process.stdout.write(`\r        ${r.pass ? 'PASS' : 'FAIL'}  ${r.measured}\n\n`);
    results[t.id] = { ...r, claim: t.claim };
  }

  h.stop();

  const payload = {
    startedAt: started,
    finishedAt: new Date().toISOString(),
    n: N,
    transport: remote ? { kind: 'remote', url: remote } : { kind: 'local' },
    node: process.version,
    platform: process.platform,
    rime: rimeDescriptor(cfg),
    planner: process.env.ANTHROPIC_API_KEY
      ? process.env.ANTHROPIC_MODEL || 'claude-opus-5'
      : 'scripted (deterministic)',
    acceptance: ACCEPTANCE,
    results,
  };

  mkdirSync(join(process.cwd(), 'evidence/runs'), { recursive: true });
  const stamp = started.replace(/[:.]/g, '-');
  const out = join(process.cwd(), 'evidence/runs', `${stamp}.json`);
  writeFileSync(out, JSON.stringify(payload, null, 2));
  writeFileSync(join(process.cwd(), 'evidence/latest.json'), JSON.stringify(payload, null, 2));
  writeFileSync(join(process.cwd(), 'evidence/RESULTS.md'), renderResults(payload));

  const passed = Object.values(results).filter((r) => r.pass).length;
  const total = Object.keys(results).length;
  console.log(`  ${passed}/${total} acceptance tests passed`);
  console.log(`  raw data:   evidence/runs/${stamp}.json`);
  console.log(`  results:    evidence/RESULTS.md\n`);
  process.exit(passed === total ? 0 : 1);
}

/**
 * Rendered into evidence/RESULTS.md on every run. RIME_EVIDENCE.md links here
 * rather than restating numbers, so the document can never drift ahead of a
 * measurement -- if no run has happened, there is no table to quote.
 */
function renderResults(p: any): string {
  const rows = Object.entries(p.results as Record<string, any>).map(
    ([id, r]) => `| ${id} | ${r.pass ? '**PASS**' : '**FAIL**'} | ${r.claim} | ${r.measured} |`,
  );
  return [
    '# Acceptance test results',
    '',
    '_Generated by `npm run evidence`. Do not hand-edit._',
    '',
    `- run started: \`${p.startedAt}\``,
    `- trials per test: \`${p.n}\``,
    `- transport: \`${p.transport?.kind ?? 'local'}\`` +
      (p.transport?.url ? ` \`${p.transport.url}\` (network round trip included)` : ' (no network in the loop)'),
    `- node: \`${p.node}\` on \`${p.platform}\``,
    `- planner: \`${p.planner}\``,
    `- Rime: \`${p.rime.modelId}\` / \`${p.rime.speaker}\` / \`${p.rime.lang}\`, ` +
      `\`${p.rime.audioFormat}\` @ \`${p.rime.samplingRate}\` Hz, \`segment=${p.rime.segment}\``,
    `- endpoint: \`${p.rime.endpoint}\` (${p.rime.transport})`,
    '',
    '| test | result | claim | measured |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '## Thresholds (fixed before the demo was recorded)',
    '',
    '```json',
    JSON.stringify(p.acceptance, null, 2),
    '```',
    '',
    'Per-trial data, including every individual latency sample, is in',
    '`evidence/latest.json` and the timestamped file under `evidence/runs/`.',
    '',
  ].join('\n');
}

// ------------------------------------------------------------------ utils ---

function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, i)];
}

function argVal(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

void main();
