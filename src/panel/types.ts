export type HeaderLine = {
    name: string;
    value: string;
};

export type HeaderSummary = {
    total: number;
    entries: HeaderLine[];
    flags: string[];
};

export type TimingSummary = {
    totalMs: number;
    blocked?: number;
    dns?: number;
    connect?: number;
    ssl?: number;
    send?: number;
    wait?: number;
    receive?: number;
};

export type CapturedRequest = {
    id: string;
    method: string;
    url: string;
    status: number;
    mimeType: string;
    requestHeadersSummary: HeaderSummary;
    responseHeadersSummary: HeaderSummary;
    timing: TimingSummary;
    requestBodyPreview: string | null;
    responseBodyPreview: string | null;
    bodySize: number | null;
    requestBodySize: number | null;
    resourceType: string;
    timestamp: string;
};

export type CaptureSession = {
    version: 1;
    sessionId: string;
    inspectedTabId: number;
    startedAt: string;
    stoppedAt: string | null;
    itemCount: number;
    items: CapturedRequest[];
};
