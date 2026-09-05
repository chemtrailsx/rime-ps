import { createServer } from 'node:http';
import { parse } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import next from 'next';
import { WebSocketServer, type WebSocket } from 'ws';
import { VoiceSession } from './voice-session.js';
import type { ClientMessage } from './protocol.js';

/**
 * Custom server, because Next route handlers cannot accept a WebSocket
 * upgrade. Voice needs a real socket in both directions: HTTP request/response
 * would force us to poll for barge-in, which is the one thing that must not
 * wait for a poll interval.
 */

// Minimal .env.local loader -- avoids a dependency for six lines of parsing.
for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT || 3000);

async function main() {
  const app = next({ dev });
  const handle = app.getRequestHandler();
  await app.prepare();

  const server = createServer((req, res) => {
    handle(req, res, parse(req.url!, true));
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url!, true);
    // Leave every other upgrade (Next HMR) alone.
    if (pathname !== '/ws/voice') return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    const session = new VoiceSession((msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    });

    void session.start();

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      session.handle(msg);
    });

    ws.on('close', () => session.dispose());
    ws.on('error', () => session.dispose());
  });

  server.listen(port, () => {
    const key = process.env.RIME_API_KEY ? 'present' : 'MISSING';
    console.log(`\n  Bay Six  ->  http://localhost:${port}`);
    console.log(
      `  rime key: ${key}   model: ${process.env.RIME_MODEL_ID || 'coda'}   speaker: ${process.env.RIME_SPEAKER || 'astra'}`,
    );
    console.log(
      `  planner:  ${process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_MODEL || 'claude-opus-5' : 'scripted (no ANTHROPIC_API_KEY)'}\n`,
    );
  });
}

void main();
