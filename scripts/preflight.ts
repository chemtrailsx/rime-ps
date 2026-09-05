import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { rimeConfig } from '../server/config.js';

/**
 * Configuration and secret preflight.
 *
 * The event rules are specific about three things, and this script checks all
 * three so that a judge does not have to take the README's word for any of them:
 *
 *   1. "Use a current production configuration ... from Rime's LIVE catalog,
 *      rather than copying a stale speaker list into the application."
 *      -> we fetch the catalog at run time and validate the shipped triple.
 *   2. "Test the shipped path ... the exact endpoint, model, audio format and
 *      transport used in the final demo."
 *      -> we synthesise one utterance over the shipped HTTP endpoint and time
 *         it, and open the shipped ws3 socket.
 *   3. "Never commit credentials to source, documentation, screenshots,
 *      recordings, or client code."
 *      -> we grep the working tree for anything key-shaped.
 *
 *   npm run preflight
 */

loadEnv();

type Check = { name: string; ok: boolean; detail: string; fatal: boolean };
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string, fatal = true) =>
  checks.push({ name, ok, detail, fatal });

async function main() {
  const cfg = rimeConfig();

  // -- 1. env hygiene -------------------------------------------------------
  add('RIME_API_KEY present', !!cfg.apiKey, cfg.apiKey ? 'set (server-side only)' : 'missing');

  const exampleOk = existsSync('.env.example');
  const exampleBody = exampleOk ? readFileSync('.env.example', 'utf8') : '';
  add(
    '.env.example has placeholders only',
    exampleOk && /REPLACE_ME/.test(exampleBody) && !/rime_[a-z0-9]{12,}/i.test(exampleBody),
    exampleOk ? 'placeholders only' : '.env.example missing',
  );

  add(
    '.env is gitignored',
    existsSync('.gitignore') && /^\.env(\.local)?$/m.test(readFileSync('.gitignore', 'utf8')),
    'checked .gitignore',
  );

  // -- 2. no committed secrets ---------------------------------------------
  const leaks = scanForSecrets('.');
  add(
    'no credential-shaped strings in the tree',
    leaks.length === 0,
    leaks.length ? leaks.join('; ') : 'clean',
  );

  // -- 3. live catalog validation ------------------------------------------
  try {
    const res = await fetch(cfg.catalogUrl, { signal: AbortSignal.timeout(15000) });
    const catalog = (await res.json()) as Record<string, Record<string, string[]>>;

    const models = Object.keys(catalog);
    add(
      `model "${cfg.modelId}" exists in the live catalog`,
      models.includes(cfg.modelId),
      `catalog offers: ${models.join(', ')}`,
    );

    const iso3 = toIso3(cfg.lang);
    const langs = Object.keys(catalog[cfg.modelId] ?? {});
    add(
      `language "${cfg.lang}" (${iso3}) supported by ${cfg.modelId}`,
      langs.includes(iso3),
      `available: ${langs.join(', ')}`,
    );

    const voices = catalog[cfg.modelId]?.[iso3] ?? [];
    add(
      `speaker "${cfg.speaker}" exists for ${cfg.modelId}/${iso3}`,
      voices.includes(cfg.speaker),
      voices.includes(cfg.speaker)
        ? `1 of ${voices.length} live voices`
        : `not in the ${voices.length} live voices; e.g. ${voices.slice(0, 6).join(', ')}`,
    );
  } catch (e) {
    add('live catalog reachable', false, (e as Error).message);
  }

  // -- 4. shipped synthesis path -------------------------------------------
  if (cfg.apiKey) {
    try {
      const t0 = Date.now();
      const res = await fetch(cfg.httpUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'audio/wav',
        },
        body: JSON.stringify({
          speaker: cfg.speaker,
          text: 'Radiator cap, R C, eleven forty-seven, B.',
          modelId: cfg.modelId,
          lang: cfg.lang,
          samplingRate: cfg.samplingRate,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const ms = Date.now() - t0;
      if (!res.ok) {
        add('shipped model/voice/lang synthesises', false, `HTTP ${res.status}: ${await res.text()}`);
      } else {
        const bytes = (await res.arrayBuffer()).byteLength;
        add(
          'shipped model/voice/lang synthesises',
          bytes > 1000,
          `${bytes} bytes of wav in ${ms}ms (cold HTTP, includes TLS handshake)`,
        );
      }
    } catch (e) {
      add('shipped model/voice/lang synthesises', false, (e as Error).message);
    }

    // The demo runs over ws3, not HTTP, so the socket itself is part of the
    // shipped path and gets its own check.
    try {
      const { RimeClient } = await import('../server/rime-client.js');
      const c = new RimeClient(cfg);
      await c.connect();
      add('ws3 socket opens with the shipped query string', true, `${c.lastConnectMs}ms to open`);
      const got = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 15000);
        c.on('audio', () => {
          clearTimeout(timer);
          resolve(true);
        });
        void c.speak('preflight', 'Torque is thirty-nine newton metres.').then(() => c.flush());
      });
      add('ws3 returns audio for the shipped config', got, got ? 'first chunk received' : 'no audio within 15s');
      c.close();
    } catch (e) {
      add('ws3 socket opens with the shipped query string', false, (e as Error).message);
    }
  } else {
    add('shipped model/voice/lang synthesises', false, 'skipped: no RIME_API_KEY', false);
  }

  // -- report ---------------------------------------------------------------
  console.log('\n  Bay Six preflight\n');
  console.log(`  shipped config: modelId=${cfg.modelId} speaker=${cfg.speaker} lang=${cfg.lang}`);
  console.log(`                  audioFormat=${cfg.audioFormat} samplingRate=${cfg.samplingRate} segment=${cfg.segment}`);
  console.log(`                  ws=${cfg.wsUrl}`);
  console.log(`                  http=${cfg.httpUrl}\n`);

  let fatalFails = 0;
  for (const c of checks) {
    const mark = c.ok ? ' ok ' : c.fatal ? 'FAIL' : 'warn';
    if (!c.ok && c.fatal) fatalFails++;
    console.log(`  [${mark}] ${c.name}`);
    console.log(`         ${c.detail}`);
  }
  console.log(
    `\n  ${checks.filter((c) => c.ok).length}/${checks.length} checks passed` +
      (fatalFails ? `  (${fatalFails} fatal)` : '') +
      '\n',
  );
  process.exit(fatalFails === 0 ? 0 : 1);
}

// ------------------------------------------------------------------ utils ---

/** ISO 639-1 (what the API takes) -> ISO 639-2 (how the catalog is keyed). */
function toIso3(lang: string): string {
  const map: Record<string, string> = {
    en: 'eng',
    es: 'spa',
    fr: 'fra',
    de: 'ger',
    pt: 'por',
    ja: 'jpn',
    ar: 'ara',
    hi: 'hin',
    it: 'ita',
    he: 'heb',
  };
  return map[lang] ?? lang;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'anthropic key'],
  [/\brime[_-]?(?:sk|api)[_-][A-Za-z0-9]{16,}/i, 'rime key'],
  [/\bBearer\s+[A-Za-z0-9._-]{30,}/, 'bearer token'],
];

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'evidence']);

function scanForSecrets(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      scanForSecrets(p, out);
      continue;
    }
    if (st.size > 2_000_000) continue;
    if (name === '.env' || name === '.env.local') continue; // gitignored by design
    let body: string;
    try {
      body = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const [re, what] of SECRET_PATTERNS) {
      // The patterns themselves live in this file; do not report ourselves.
      if (p.endsWith('preflight.ts')) continue;
      if (re.test(body)) out.push(`${what} in ${relative('.', p)}`);
    }
  }
  return out;
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
