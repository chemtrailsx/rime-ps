# Bay Six

**A voice copilot for a technician whose hands are inside an engine.**

Gloves on, eyes on the job, no screen within reach. Speech is not a feature of
this product — it is the entire interface. And a misheard part number or torque
spec is a comeback, not a typo.

Rime `coda` provides every spoken word.

---

## The one hard voice problem

> **Interruption and recovery while a slow tool call is in flight — and keeping
> application state consistent with what the technician actually heard.**

A technician says *"radiator cap for the 2018 Civic."* The parts-catalog lookup
takes three seconds. Somewhere in second two, while Bay Six is mid-sentence,
they cut in: *"no, the 2019."*

Four things are now in flight, and every one of them can corrupt the
conversation:

1. Audio Rime has already generated and shipped to the browser.
2. Audio Rime has accepted but not yet generated.
3. A model stream still emitting tokens about the 2018.
4. A tool call that will return 2018 data in about a second.

A naive agent lets all four land. The technician hears the tail of the 2018
answer, then the 2019 answer, and the model's history now claims it said things
they never heard. Bay Six fences all four against a single monotonically
increasing turn number, and reconciles history against what the browser confirms
actually reached the speaker.

The full claim, acceptance tests, procedure and limitations are in
[`RIME_EVIDENCE.md`](RIME_EVIDENCE.md).

### The idea that ties it together

Rime `ws3` returns **word timestamps**. The browser reports exactly how many PCM
**samples** reached the output device before it went silent. Divide, and you know
the second at which the technician stopped hearing you — and therefore precisely
which words they heard. Bay Six writes *only those words* into the model's
history, marked as cut off.

That is why Bay Six never says *"like I said, bin A14"* about audio that never
reached a speaker. See [`server/ledger.ts`](server/ledger.ts).

---

## Quick start

```bash
npm install
cp .env.example .env.local     # add your RIME_API_KEY
npm run preflight              # validates the config against Rime's LIVE catalog
npm run dev                    # http://localhost:3000
```

Chrome is recommended (the Web Speech API supplies recognition). An
`ANTHROPIC_API_KEY` is optional — without one, a deterministic scripted planner
runs over the same tools, so every voice behaviour below is reproducible with a
Rime key alone.

### Reproduce the demo

1. Click **Open mic and connect**, allow the microphone.
2. Leave the injected tool delay at **3000 ms**.
3. Say: *"radiator cap for the 2018 Civic 1.5T"*.
4. **While Bay Six is still speaking**, cut in with *"no, the 2019"*.

Watch the screen: audio stops, the 2018 lookup is marked **cancelled and
fenced**, and the history panel shows only the words you actually heard.

No microphone? Type the turn and press **Interrupt** — it sends the identical
`barge_in` message and produces a real measurement.

### Reproduce the numbers

```bash
npm run evidence                  # AT-1..AT-6, n=20, needs RIME_API_KEY
npm run evidence -- --only AT-6   # pure-function test, no key needed
npm run pronounce                 # before/after delivery clips
```

Results land in `evidence/RESULTS.md` (generated, never hand-edited) with
per-trial data in `evidence/latest.json`.

---

## Rime integration

Exactly what ships, validated against the live catalog by `npm run preflight`:

| field | value |
| --- | --- |
| model ID | `coda` |
| speaker | `astra` |
| language | `en` |
| audio format | `pcm` (s16le, mono) |
| sampling rate | `24000` Hz |
| segmentation | `segment=immediate` |
| endpoint | `wss://users-ws.rime.ai/ws3` |
| transport | JSON WebSocket, persistent, opened once and kept warm, proxied server-side |
| catalog | `https://users.rime.ai/data/voices/all-v2.json` (fetched at preflight time) |

All of it is shown live in the **Active speech provider** panel in the UI, as
the rules require. There is **no fallback TTS provider** — Rime is the only path
to audio, so nothing can quietly take over and make a Rime failure look like a
success. If the key is missing, the panel says **RIME — NO KEY** and stays that
way.

The API key is read server-side only and is never sent to the browser. All
synthesis is proxied through the Node server.

Regional or self-hosted deployments: override `RIME_WS_URL` and `RIME_HTTP_URL`
together in `.env.local`.

---

## Architecture

```
browser                                    node server
──────────────────────────────────────     ──────────────────────────────────────
mic (always open, AEC on)
  └─ mic-meter.js ──── RMS VAD ─────────►  barge_in ─┐
                                                     │
Web Speech API ────── user_final ────────►  VoiceSession
                                             │   ├─ turn N: contextId, AbortController
                                             │   ├─ Planner (Claude stream + tools)
                                             │   ├─ ClauseSegmenter
                                             │   ├─ ear.ts  (written → spoken)
                                             │   └─ HeardLedger
                                             ▼
pcm-player.js ◄────── audio (turn-tagged) ── RimeClient ──ws3──► Rime coda
  │                                            ▲                  │
  └─ playback_stopped(samplesPlayed) ──────────┴── clear/flush ────┘
```

| file | role |
| --- | --- |
| [`server/voice-session.ts`](server/voice-session.ts) | The turn state machine. Barge-in ordering, fencing, history reconciliation. **Start here.** |
| [`server/rime-client.ts`](server/rime-client.ts) | Persistent `ws3` client. `clear`, `flush`, `contextId`, word timestamps. |
| [`server/ledger.ts`](server/ledger.ts) | Word timestamps + samples played → what the technician actually heard. |
| [`server/ear.ts`](server/ear.ts) | Written text → spoken text. Every rule is named and testable. |
| [`server/segmenter.ts`](server/segmenter.ts) | Streams clauses to Rime early without splitting a part number in half. |
| [`server/planner.ts`](server/planner.ts) | Claude streaming + tool use, and the deterministic fallback. |
| [`server/tools.ts`](server/tools.ts) | Slow, cancellable catalog lookups. |
| [`public/worklets/pcm-player.js`](public/worklets/pcm-player.js) | Sample-accurate playback with instant flush. |
| [`public/worklets/mic-meter.js`](public/worklets/mic-meter.js) | Always-on mic, energy VAD, full-duplex heartbeat. |
| [`scripts/harness.ts`](scripts/harness.ts) | Headless client that drives the **real** session. |

### Three decisions worth explaining

**Why a custom Node server instead of Next route handlers.** Route handlers
cannot accept a WebSocket upgrade. Voice needs a real duplex socket: barge-in
must not wait for a poll interval.

**Why not LiveKit Agents.** LiveKit is the recommended starting point and would
have given us transport and turn handling for free. We implemented the
interruption and fencing model directly against Rime's own `ws3` primitives
instead, for two reasons. First, the hard problem *is* the fencing model — using
a framework's implementation would have meant demonstrating LiveKit rather than
solving the problem. Second, a judge can reproduce everything here with one API
key and `npm install`, with no additional cloud account. The trade-off is real:
Bay Six has no telephony path today, and LiveKit would have provided one.

**Why the AudioContext is pinned to 24 kHz.** The browser's native rate is
usually 48 kHz. Resampling every chunk would make `samplesPlayed` an estimate
rather than a count — and that count is the evidence for what was heard.

---

## Deploying

> **Bay Six cannot run on a serverless host, Vercel included.** This is not a
> configuration problem, it is the architecture. Three things need a
> long-lived process: the server owns its own HTTP listener so it can accept a
> WebSocket upgrade at `/ws/voice`; the Rime `ws3` socket is opened once and
> held warm for the whole session (a per-turn handshake would land on
> time-to-first-audio); and `operation: clear` has to reach a socket that is
> still open. Rebuilding this to fit serverless would mean deleting the
> mechanism the project exists to demonstrate.

Anything that runs a persistent container works. A [`Dockerfile`](Dockerfile)
and a Render blueprint ([`render.yaml`](render.yaml)) are included.

**Render** (free tier, WebSockets supported):

1. Dashboard → **New** → **Blueprint** → point at this repository.
2. Set `RIME_API_KEY` in the dashboard. It is marked `sync: false` in
   `render.yaml`, so it is never committed. `ANTHROPIC_API_KEY` is optional.
3. Deploy. Everything else in `render.yaml` mirrors `.env.example`, so the
   deployed configuration and the tested configuration cannot drift.

**Anywhere else** — Railway, Fly.io, a VPS, any container host:

```bash
docker build -t bay-six .
docker run -p 3000:3000 -e RIME_API_KEY=... bay-six
```

Two things to know before you demo from a deployed URL:

- **HTTPS is required.** `getUserMedia` and the Web Speech API only run on a
  secure origin (`localhost` is exempt, a bare IP is not). Without TLS the mic
  never opens and barge-in is dead — the app will still start on typed turns
  and say so in the log, but that is not the demo.
- **Free tiers sleep.** Render's free plan spins down when idle and cold-starts
  in roughly a minute. Load the page once before recording. The cold start is
  a hosting artifact and is not what the `cold` column in the trace table
  measures — that flag tracks the Rime socket only.

---

## Third-party services

| service | role | required |
| --- | --- | --- |
| **Rime** (`coda`) | All spoken output. `ws3` for the live session, HTTP for preflight and clip rendering. | **Yes** |
| **Anthropic** (`claude-opus-5`) | Reasoning and tool selection. Streaming, low effort, adaptive thinking. | No — falls back to a scripted planner |
| **Web Speech API** | Speech recognition. Browser-native, no key, no account. | No — typed turns work |

Nothing else. No analytics, no telemetry, no third-party fonts.

---

## Configuration and secrets

`.env.example` contains placeholders only. `npm run preflight` fails the run if
it finds anything credential-shaped anywhere in the working tree, and checks
that `.env` is gitignored.

Keys are server-side only. The browser never receives one; it talks to
`/ws/voice` and the Node process holds the credentials.

---

## Known limitations

Stated in full, with the reasoning, in
[`RIME_EVIDENCE.md` §5](RIME_EVIDENCE.md#5-limitations--read-this-before-quoting-any-number).
The short version:

- Barge-in depends on the device's acoustic echo cancellation. Without it, use a
  headset.
- The headless harness measures the **server-side** stop path; a browser adds a
  render quantum plus output-buffer latency. Both are reported; neither is
  presented as the other.
- Web Speech API recognition is the weakest link for accented speech and shop
  noise. It is swappable and is not part of any claim.
- No telephony path has been measured, so none is claimed.
- Catalog and torque fixtures are synthetic.
- Default `n=20` per test. Treat single runs as exploratory.

---

## Safety note

Torque specifications are safety-critical. Bay Six refuses to guess: when a
fastener is not in the fixtures it says so and says not to guess, rather than
producing a plausible number. That behaviour is in the system prompt and in
[`server/tools.ts`](server/tools.ts), and it is the reason
[`server/ear.ts`](server/ear.ts) exists at all.
