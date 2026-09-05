'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceClient, type ClientState } from '@/lib/client/voice-client';
import type { SpeechProviderDescriptor, TurnTrace } from '@/server/protocol';

type Entry =
  | { kind: 'tech'; text: string; final: boolean }
  | { kind: 'bay'; turn: number; text: string; cut: boolean }
  | { kind: 'tool'; turn: number; id: string; name: string; ms?: number; fenced?: boolean; done: boolean };

export default function Console() {
  const [started, setStarted] = useState(false);
  const [speech, setSpeech] = useState<SpeechProviderDescriptor | null>(null);
  const [planner, setPlanner] = useState('');
  const [toolDelay, setToolDelay] = useState(3000);
  const [state, setState] = useState<ClientState | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [traces, setTraces] = useState<TurnTrace[]>([]);
  const [logs, setLogs] = useState<{ level: string; msg: string }[]>([]);
  const [typed, setTyped] = useState('');
  const clientRef = useRef<VoiceClient | null>(null);
  const txRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    txRef.current?.scrollTo({ top: txRef.current.scrollHeight });
  }, [entries]);

  const start = useCallback(async () => {
    const c = new VoiceClient({
      onReady: (d, p, ms) => {
        setSpeech(d);
        setPlanner(p);
        setToolDelay(ms);
      },
      onState: setState,
      onUserText: (text, final) =>
        setEntries((e) => {
          const last = e[e.length - 1];
          if (last?.kind === 'tech' && !last.final) {
            return [...e.slice(0, -1), { kind: 'tech', text, final }];
          }
          return [...e, { kind: 'tech', text, final }];
        }),
      onTurnOpen: (turn) =>
        setEntries((e) => [...e, { kind: 'bay', turn, text: '', cut: false }]),
      onAgentText: (turn, delta) =>
        setEntries((e) => {
          const i = e.findIndex((x) => x.kind === 'bay' && x.turn === turn);
          if (i < 0) return e;
          const c2 = [...e];
          const b = c2[i] as Extract<Entry, { kind: 'bay' }>;
          c2[i] = { ...b, text: b.text + delta };
          return c2;
        }),
      onTool: (t) =>
        setEntries((e) => {
          if (t.phase === 'start') {
            return [...e, { kind: 'tool', turn: t.turn, id: t.id, name: t.name, done: false }];
          }
          // Match on turn AND id. Matching on id alone reconciles a late
          // tool_end from a cancelled turn against an earlier turn's row.
          const i = e.findIndex((x) => x.kind === 'tool' && x.id === t.id && x.turn === t.turn);
          if (i < 0) return e;
          const c2 = [...e];
          c2[i] = { ...(c2[i] as any), done: true, ms: t.ms, fenced: t.fenced };
          return c2;
        }),
      onBargeIn: (turn) =>
        setEntries((e) =>
          e.map((x) => (x.kind === 'bay' && x.turn === turn ? { ...x, cut: true } : x)),
        ),
      onTrace: (t) => setTraces((ts) => [t, ...ts].slice(0, 12)),
      onLog: (level, msg) => setLogs((l) => [{ level, msg }, ...l].slice(0, 60)),
    });
    clientRef.current = c;
    try {
      await c.start();
      await c.resumeAudio();
      setStarted(true);
    } catch (err) {
      setLogs((l) => [{ level: 'error', msg: (err as Error).message }, ...l]);
    }
  }, []);

  useEffect(() => () => clientRef.current?.dispose(), []);

  const submitTyped = (e: React.FormEvent) => {
    e.preventDefault();
    const t = typed.trim();
    if (!t || !clientRef.current) return;
    setEntries((x) => [...x, { kind: 'tech', text: t, final: true }]);
    clientRef.current.sendUserFinal(t);
    setTyped('');
  };

  const live = traces[0];

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <h1>
            BAY <span>SIX</span>
          </h1>
          <p>
            A voice copilot for a technician whose hands are inside an engine and whose eyes are on
            the job. There is no screen to look at, so speech is the entire interface &mdash; and a
            misheard part number or torque spec is a comeback, not a typo.
          </p>
        </div>

        {/* The brief requires the active speech provider to be observable. */}
        <div className="provider">
          <div className="lbl">Active speech provider</div>
          <div className="name">
            <span
              className={`dot ${
                speech?.keyPresent ? (state?.speaking ? 'hot' : 'on') : 'bad'
              }`}
            />
            {speech ? speech.provider.toUpperCase() : 'not connected'}
            {speech && !speech.keyPresent && ' - NO KEY'}
          </div>
          {speech && (
            <dl>
              <dt>model</dt>
              <dd>{speech.modelId}</dd>
              <dt>speaker</dt>
              <dd>{speech.speaker}</dd>
              <dt>lang</dt>
              <dd>{speech.lang}</dd>
              <dt>format</dt>
              <dd>
                {speech.audioFormat} / {speech.samplingRate} Hz / segment={speech.segment}
              </dd>
              <dt>endpoint</dt>
              <dd>{speech.endpoint}</dd>
              <dt>transport</dt>
              <dd>{speech.transport}</dd>
              <dt>planner</dt>
              <dd>{planner}</dd>
            </dl>
          )}
        </div>
      </header>

      <div className="grid">
        <div style={{ display: 'grid', gap: 18 }}>
          <section className="card">
            <h2>
              <span>Bay floor</span>
              <span style={{ color: state?.speaking ? 'var(--amber)' : 'var(--dimmer)' }}>
                {state?.speaking ? 'SPEAKING - interrupt me' : state?.toolRunning ? 'LOOKING UP' : 'IDLE'}
              </span>
            </h2>
            <div className="body">
              {!started ? (
                <div className="controls">
                  <button className="primary" onClick={start}>
                    Open mic and connect
                  </button>
                  <span style={{ fontSize: 12, color: 'var(--dim)' }}>
                    Chrome recommended. Grants microphone access and opens the Rime socket.
                  </span>
                </div>
              ) : (
                <>
                  <div className="tx" ref={txRef}>
                    {entries.length === 0 && (
                      <p className="hint" style={{ margin: 0 }}>
                        Try: <code>radiator cap for the 2018 Civic 1.5T</code> &mdash; then, while
                        it is still talking, cut in with <code>no, the 2019</code>.
                      </p>
                    )}
                    {entries.map((e, i) =>
                      e.kind === 'tool' ? (
                        <div key={i} className={`toolline ${e.fenced ? 'fenced' : ''}`}>
                          {e.done
                            ? e.fenced
                              ? `x ${e.name} cancelled after ${e.ms}ms - result fenced, never spoken`
                              : `> ${e.name} returned in ${e.ms}ms`
                            : `. ${e.name} running...`}
                        </div>
                      ) : (
                        <div key={i} className={`msg ${e.kind}`}>
                          <div className="who">{e.kind === 'tech' ? 'tech' : 'bay 6'}</div>
                          <div className={`txt ${e.kind === 'tech' && !e.final ? 'interim' : ''}`}>
                            {e.text}
                            {e.kind === 'bay' && e.cut && <span className="cut">CUT OFF</span>}
                          </div>
                        </div>
                      ),
                    )}
                  </div>

                  <form className="controls" style={{ marginTop: 14 }} onSubmit={submitTyped}>
                    <input
                      type="text"
                      value={typed}
                      placeholder="Type a turn (for demos without a mic)"
                      onChange={(e) => setTyped(e.target.value)}
                    />
                    <button type="submit">Send</button>
                    {/* Sends the identical barge_in message the VAD sends, so a
                        demo without a microphone still exercises the real stop
                        path and produces a real measurement. */}
                    <button
                      type="button"
                      disabled={!state?.speaking && !state?.toolRunning}
                      onClick={() => clientRef.current?.interruptNow()}
                    >
                      Interrupt
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        clientRef.current?.reset();
                        setEntries([]);
                        setTraces([]);
                      }}
                    >
                      Reset
                    </button>
                  </form>

                  <div className="statusrow">
                    <span>
                      mic{' '}
                      <span className={`dot ${state?.micOpen ? 'on' : 'bad'}`} />{' '}
                      <span className="meter">
                        <i style={{ width: `${Math.min(100, (state?.micRms ?? 0) * 900)}%` }} />
                      </span>
                    </span>
                    <span>
                      asr <b>{state?.listening ? 'live' : 'off'}</b>
                    </span>
                    <span>
                      floor <b>{state?.noiseFloor.toFixed(4) ?? '-'}</b>
                    </span>
                    <span>
                      out latency <b>{state?.outputLatencyMs ?? 0}ms</b>
                    </span>
                    <span>
                      turn <b>{state?.turn ?? 0}</b>
                    </span>
                  </div>

                  <div className="controls" style={{ marginTop: 12 }}>
                    <label style={{ fontSize: 12, color: 'var(--dim)' }}>
                      Injected tool delay
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={8000}
                      step={250}
                      value={toolDelay}
                      onChange={(e) => {
                        const ms = Number(e.target.value);
                        setToolDelay(ms);
                        clientRef.current?.setToolDelay(ms);
                      }}
                    />
                    <b style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{toolDelay} ms</b>
                    <span style={{ fontSize: 11.5, color: 'var(--dimmer)' }}>
                      the brief&apos;s fixed tool delay &mdash; turn it up and interrupt mid-lookup
                    </span>
                  </div>
                </>
              )}
            </div>
          </section>

          <section className="card">
            <h2>Per-turn measurements</h2>
            <div className="body">
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>TTFB</th>
                      <th>stop</th>
                      <th>fenced audio</th>
                      <th>fenced tools</th>
                      <th>heard/said</th>
                      <th>mic while spk</th>
                      <th>mic while tool</th>
                      <th>cold</th>
                    </tr>
                  </thead>
                  <tbody>
                    {traces.length === 0 && (
                      <tr>
                        <td colSpan={9} style={{ color: 'var(--dimmer)' }}>
                          no turns yet
                        </td>
                      </tr>
                    )}
                    {traces.map((t) => (
                      <tr key={t.turn}>
                        <td>{t.turn}</td>
                        <td>{t.ttfbMs === null ? '—' : `${t.ttfbMs}ms`}</td>
                        <td className={t.stopLatencyMs === null ? '' : t.stopLatencyMs <= 150 ? 'good' : 'warn'}>
                          {t.interrupted ? `${t.stopLatencyMs ?? '?'}ms` : '-'}
                        </td>
                        <td className={t.fencedAudioChunks > 0 ? 'warn' : ''}>{t.fencedAudioChunks}</td>
                        <td className={t.fencedToolResults > 0 ? 'warn' : ''}>{t.fencedToolResults}</td>
                        <td>
                          {t.wordsHeard}/{t.wordsSynthesised}
                        </td>
                        <td className={t.micFramesDuringPlayback > 0 ? 'good' : 'bad'}>
                          {t.micFramesDuringPlayback}
                        </td>
                        <td className={t.micFramesDuringTool > 0 ? 'good' : 'bad'}>
                          {t.micFramesDuringTool}
                        </td>
                        <td>{t.cold ? 'cold' : 'warm'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {live && (
                <div className="heard">
                  <span style={{ color: 'var(--dimmer)' }}>
                    what turn {live.turn} put into the model&apos;s history:
                  </span>
                  {'\n'}
                  <b>{live.heardTranscript || '(nothing heard)'}</b>
                  {live.interrupted && (
                    <span style={{ color: 'var(--red)' }}>
                      {'  '}[cut off here - the rest was never written to history]
                    </span>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>

        <div style={{ display: 'grid', gap: 18 }}>
          <section className="card">
            <h2>The stress case</h2>
            <div className="body">
              <p className="hint">
                One hard problem, proven under load: <b>interruption and recovery while a slow tool
                is in flight.</b>
              </p>
              <ol className="hint">
                <li>
                  Set the tool delay to <code>3000 ms</code>.
                </li>
                <li>
                  Say <code>radiator cap for the 2018 Civic 1.5T</code>.
                </li>
                <li>
                  While Bay Six is still speaking, cut in with <code>no, the 2019</code>.
                </li>
                <li>
                  Watch: audio stops, the 2018 lookup is <b>cancelled and fenced</b>, and the
                  history row shows only the words you actually heard.
                </li>
              </ol>
              <p className="hint" style={{ marginTop: 10 }}>
                Reproduce headlessly with <code>npm run evidence</code>.
              </p>
            </div>
          </section>

          <section className="card">
            <h2>Session log</h2>
            <div className="body">
              <div className="log">
                {logs.length === 0 && <div>-</div>}
                {logs.map((l, i) => (
                  <div key={i} className={l.level}>
                    {l.msg}
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
