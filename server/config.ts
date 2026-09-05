/**
 * Single source of truth for the shipped Rime configuration.
 *
 * Every field here is echoed into the on-screen HUD, the README, and every
 * evidence run, so that "the configuration we tested" and "the configuration
 * we shipped" cannot drift apart. `npm run preflight` validates the
 * model/speaker/language triple against Rime's LIVE catalog.
 */

export type RimeConfig = {
  apiKey: string;
  modelId: string;
  speaker: string;
  lang: string;
  audioFormat: string;
  samplingRate: number;
  segment: string;
  wsUrl: string;
  httpUrl: string;
  catalogUrl: string;
};

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function rimeConfig(): RimeConfig {
  return {
    apiKey: process.env.RIME_API_KEY ?? '',
    modelId: env('RIME_MODEL_ID', 'coda'),
    speaker: env('RIME_SPEAKER', 'astra'),
    lang: env('RIME_LANG', 'en'),
    audioFormat: env('RIME_AUDIO_FORMAT', 'pcm'),
    samplingRate: Number(env('RIME_SAMPLING_RATE', '24000')),
    segment: env('RIME_SEGMENT', 'immediate'),
    wsUrl: env('RIME_WS_URL', 'wss://users-ws.rime.ai/ws3'),
    httpUrl: env('RIME_HTTP_URL', 'https://users.rime.ai/v1/rime-tts'),
    catalogUrl: env('RIME_CATALOG_URL', 'https://users.rime.ai/data/voices/all-v2.json'),
  };
}

/** Public, secret-free description of the shipped path, for the HUD. */
export function rimeDescriptor(c: RimeConfig) {
  return {
    provider: 'rime' as const,
    modelId: c.modelId,
    speaker: c.speaker,
    lang: c.lang,
    audioFormat: c.audioFormat,
    samplingRate: c.samplingRate,
    segment: c.segment,
    endpoint: c.wsUrl,
    transport: 'websocket-json (ws3), persistent, server-side proxied',
    keyPresent: c.apiKey.length > 0,
  };
}

export const toolDelayMs = () => Number(env('BAY6_TOOL_DELAY_MS', '3000'));
