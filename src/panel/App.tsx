import { startTransition, useDeferredValue, useEffect, useEffectEvent, useRef, useState } from 'react';

import { appendCapturedRequest, createSession, normalizeRequest, stopSession } from './capture';
import type { CaptureSession, CapturedRequest, HeaderSummary, TimingSummary } from './types';

const inspectedTabId = chrome.devtools.inspectedWindow.tabId;
const storageKey = `tracelens.session.${inspectedTabId}`;

export default function App() {
    const [session, setSession] = useState<CaptureSession | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [notice, setNotice] = useState('Ready to capture.');
    const deferredQuery = useDeferredValue(query);
    const sessionRef = useRef<CaptureSession | null>(null);
    const activeRef = useRef(false);
    const persistTimeoutRef = useRef<number | null>(null);

    useEffect(() => {
        chrome.storage.local.get(storageKey, (result) => {
            const nextSession = (result[storageKey] as CaptureSession | undefined) ?? null;
            sessionRef.current = nextSession;
            setSession(nextSession);
            setSelectedId(nextSession?.items.at(-1)?.id ?? null);
            activeRef.current = Boolean(nextSession && !nextSession.stoppedAt);
            setNotice(
                nextSession
                    ? `Loaded ${nextSession.itemCount} captured requests for tab ${inspectedTabId}.`
                    : 'Ready to capture.'
            );
        });
    }, []);

    useEffect(() => {
        sessionRef.current = session;

        if (persistTimeoutRef.current !== null) {
            window.clearTimeout(persistTimeoutRef.current);
        }

        persistTimeoutRef.current = window.setTimeout(() => {
            if (session) {
                chrome.storage.local.set({ [storageKey]: session });
                return;
            }

            chrome.storage.local.remove(storageKey);
        }, 150);

        return () => {
            if (persistTimeoutRef.current !== null) {
                window.clearTimeout(persistTimeoutRef.current);
            }
        };
    }, [session]);

    const handleRequestFinished = useEffectEvent(async (request: chrome.devtools.network.Request) => {
        if (!activeRef.current) {
            return;
        }

        const captured = await normalizeRequest(request);
        if (!captured) {
            return;
        }

        const currentSession = sessionRef.current;
        if (!currentSession || currentSession.stoppedAt) {
            return;
        }

        const { nextSession, overflowed } = appendCapturedRequest(currentSession, captured);
        sessionRef.current = nextSession;

        startTransition(() => {
            setSession(nextSession);
            setSelectedId(captured.id);
            setNotice(
                overflowed
                    ? 'Capture limit reached. Keeping the most recent 500 requests.'
                    : `Captured ${nextSession.itemCount} requests.`
            );
        });
    });

    useEffect(() => {
        chrome.devtools.network.onRequestFinished.addListener(handleRequestFinished);

        return () => {
            chrome.devtools.network.onRequestFinished.removeListener(handleRequestFinished);
        };
    }, []);

    const activeSession = Boolean(session && !session.stoppedAt);
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    const filteredItems = (session?.items ?? [])
        .slice()
        .reverse()
        .filter((item) => {
            if (!normalizedQuery) {
                return true;
            }

            return [
                item.method,
                item.url,
                item.mimeType,
                item.resourceType,
                String(item.status)
            ].some((value) => value.toLowerCase().includes(normalizedQuery));
        });
    const selectedEntry =
        filteredItems.find((item) => item.id === selectedId) ??
        session?.items.find((item) => item.id === selectedId) ??
        filteredItems[0] ??
        null;

    const jsonCount = (session?.items ?? []).filter((item) => /json|graphql/i.test(item.mimeType)).length;
    const documentCount = (session?.items ?? []).filter((item) => item.resourceType === 'document').length;
    const mutationCount = (session?.items ?? []).filter((item) => item.method !== 'GET').length;

    function handleStartCapture() {
        const nextSession = createSession(inspectedTabId);
        sessionRef.current = nextSession;
        activeRef.current = true;
        setSession(nextSession);
        setSelectedId(null);
        setNotice(`Capture started for tab ${inspectedTabId}.`);
    }

    function handleStopCapture() {
        const currentSession = sessionRef.current;
        if (!currentSession || currentSession.stoppedAt) {
            return;
        }

        const nextSession = stopSession(currentSession);
        sessionRef.current = nextSession;
        activeRef.current = false;
        setSession(nextSession);
        setNotice(`Capture stopped with ${currentSession.itemCount} requests.`);
    }

    function handleClearCapture() {
        activeRef.current = false;
        sessionRef.current = null;
        setSession(null);
        setSelectedId(null);
        setNotice('Cleared the stored session for this tab.');
    }

    function handleExport() {
        if (!session) {
            return;
        }

        const blob = new Blob([JSON.stringify(session, null, 2)], {
            type: 'application/json'
        });
        const url = URL.createObjectURL(blob);
        const filename = `tracelens-session-${session.startedAt.slice(0, 10)}.json`;

        chrome.downloads.download(
            {
                url,
                filename,
                saveAs: true
            },
            () => {
                window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
            }
        );

        setNotice(`Exported ${filename}.`);
    }

    return (
        <div className="shell">
            <header className="hero">
                <div>
                    <p className="eyebrow">DevTools Capture</p>
                    <h1>TraceLens</h1>
                    <p className="lede">
                        Capture fetch, XHR, documents, JSON, GraphQL, and form submissions while filtering
                        out the usual noise.
                    </p>
                </div>
                <div className={`status-pill ${activeSession ? 'status-pill--active' : 'status-pill--idle'}`}>
                    {activeSession ? 'Live' : session ? 'Stopped' : 'Idle'}
                </div>
            </header>

            <section className="toolbar">
                <div className="button-row">
                    <button className="button button--primary" onClick={handleStartCapture} type="button">
                        Start Capture
                    </button>
                    <button
                        className="button"
                        disabled={!activeSession}
                        onClick={handleStopCapture}
                        type="button"
                    >
                        Stop
                    </button>
                    <button className="button" disabled={!session} onClick={handleClearCapture} type="button">
                        Clear
                    </button>
                    <button
                        className="button"
                        disabled={!session || session.itemCount === 0}
                        onClick={handleExport}
                        type="button"
                    >
                        Export JSON
                    </button>
                </div>

                <label className="search">
                    <span>Filter</span>
                    <input
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="method, URL, mime, type, status"
                        type="search"
                        value={query}
                    />
                </label>
            </section>

            <section className="stats">
                <StatCard label="Captured" value={String(session?.itemCount ?? 0)} />
                <StatCard label="JSON or GraphQL" value={String(jsonCount)} />
                <StatCard label="Documents" value={String(documentCount)} />
                <StatCard label="Mutating Requests" value={String(mutationCount)} />
            </section>

            <p className="notice">{notice}</p>

            <main className="workspace">
                <section className="list-panel">
                    <div className="panel-heading">
                        <h2>Requests</h2>
                        <span>{filteredItems.length} visible</span>
                    </div>

                    <div className="request-list">
                        {filteredItems.length === 0 ? (
                            <div className="empty-state">
                                Start a capture, use the site, then stop to inspect the cleaned request stream.
                            </div>
                        ) : null}

                        {filteredItems.map((item) => (
                            <button
                                className={`request-card ${selectedEntry?.id === item.id ? 'request-card--active' : ''}`}
                                key={item.id}
                                onClick={() => setSelectedId(item.id)}
                                type="button"
                            >
                                <div className="request-card__top">
                                    <span className={`method method--${item.method.toLowerCase()}`}>{item.method}</span>
                                    <span className={`status status--${statusTone(item.status)}`}>{item.status}</span>
                                </div>
                                <div className="request-card__url">{item.url}</div>
                                <div className="request-card__meta">
                                    <span>{item.resourceType}</span>
                                    <span>{item.mimeType || 'unknown mime'}</span>
                                    <span>{formatBytes(item.bodySize)}</span>
                                    <span>{item.timing.totalMs} ms</span>
                                </div>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="detail-panel">
                    {selectedEntry ? (
                        <>
                            <div className="panel-heading">
                                <h2>Request Detail</h2>
                                <span>{new Date(selectedEntry.timestamp).toLocaleTimeString()}</span>
                            </div>

                            <article className="detail-card">
                                <DetailRow label="Method" value={selectedEntry.method} />
                                <DetailRow label="URL" value={selectedEntry.url} />
                                <DetailRow label="Status" value={String(selectedEntry.status)} />
                                <DetailRow label="Mime Type" value={selectedEntry.mimeType || 'unknown'} />
                                <DetailRow label="Resource Type" value={selectedEntry.resourceType} />
                                <DetailRow label="Body Size" value={formatBytes(selectedEntry.bodySize)} />
                            </article>

                            <article className="detail-card">
                                <h3>Timing</h3>
                                <TimingGrid timing={selectedEntry.timing} />
                            </article>

                            <article className="detail-card">
                                <h3>Request Headers Summary</h3>
                                <HeaderSummaryBlock summary={selectedEntry.requestHeadersSummary} />
                            </article>

                            <article className="detail-card">
                                <h3>Response Headers Summary</h3>
                                <HeaderSummaryBlock summary={selectedEntry.responseHeadersSummary} />
                            </article>

                            <article className="detail-card">
                                <h3>Request Body Preview</h3>
                                <pre>{selectedEntry.requestBodyPreview ?? 'No request body preview available.'}</pre>
                            </article>

                            <article className="detail-card">
                                <h3>Response Body Preview</h3>
                                <pre>{selectedEntry.responseBodyPreview ?? 'No response body preview available.'}</pre>
                            </article>
                        </>
                    ) : (
                        <div className="empty-state empty-state--detail">
                            Select a captured request to inspect its timing, headers, and body previews.
                        </div>
                    )}
                </section>
            </main>
        </div>
    );
}

function StatCard(props: { label: string; value: string }) {
    return (
        <article className="stat-card">
            <span>{props.label}</span>
            <strong>{props.value}</strong>
        </article>
    );
}

function DetailRow(props: { label: string; value: string }) {
    return (
        <div className="detail-row">
            <dt>{props.label}</dt>
            <dd>{props.value}</dd>
        </div>
    );
}

function HeaderSummaryBlock(props: { summary: HeaderSummary }) {
    return (
        <>
            <p className="meta-line">
                {props.summary.total} headers
                {props.summary.flags.length > 0 ? ` • ${props.summary.flags.join(' • ')}` : ''}
            </p>
            <div className="summary-list">
                {props.summary.entries.length > 0 ? (
                    props.summary.entries.map((entry) => (
                        <div className="summary-list__row" key={`${entry.name}-${entry.value}`}>
                            <span>{entry.name}</span>
                            <strong>{entry.value}</strong>
                        </div>
                    ))
                ) : (
                    <div className="summary-list__row">
                        <span>No notable headers</span>
                        <strong>None</strong>
                    </div>
                )}
            </div>
        </>
    );
}

function TimingGrid(props: { timing: TimingSummary }) {
    const entries = [
        ['Total', `${props.timing.totalMs} ms`],
        ['Blocked', formatTiming(props.timing.blocked)],
        ['DNS', formatTiming(props.timing.dns)],
        ['Connect', formatTiming(props.timing.connect)],
        ['SSL', formatTiming(props.timing.ssl)],
        ['Send', formatTiming(props.timing.send)],
        ['Wait', formatTiming(props.timing.wait)],
        ['Receive', formatTiming(props.timing.receive)]
    ];

    return (
        <div className="timing-grid">
            {entries.map(([label, value]) => (
                <div className="timing-grid__item" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                </div>
            ))}
        </div>
    );
}

function formatTiming(value?: number): string {
    return typeof value === 'number' ? `${value} ms` : 'n/a';
}

function formatBytes(value: number | null): string {
    if (value === null) {
        return 'n/a';
    }

    if (value < 1_024) {
        return `${value} B`;
    }

    if (value < 1_048_576) {
        return `${(value / 1_024).toFixed(1)} KB`;
    }

    return `${(value / 1_048_576).toFixed(2)} MB`;
}

function statusTone(status: number): 'ok' | 'warn' | 'error' {
    if (status >= 500) {
        return 'error';
    }

    if (status >= 400) {
        return 'warn';
    }

    return 'ok';
}
