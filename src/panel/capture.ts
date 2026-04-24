import type { CaptureSession, CapturedRequest, HeaderLine, HeaderSummary, TimingSummary } from './types';

type DevtoolsRequest = chrome.devtools.network.Request & {
    _resourceType?: string;
    startedDateTime: string;
    time?: number;
    timings?: Record<string, number>;
    request: {
        method: string;
        url: string;
        headers?: HeaderLine[];
        postData?: {
            mimeType?: string;
            text?: string;
        };
    };
    response: {
        status: number;
        headers?: HeaderLine[];
        bodySize?: number;
        content?: {
            mimeType?: string;
            size?: number;
        };
    };
};

const MAX_PREVIEW_CHARS = 2_500;
const MAX_CAPTURED_REQUESTS = 500;

const NOISE_URL_PATTERN =
    /(google-analytics|googletagmanager|doubleclick|segment\.io|mixpanel|hotjar|fullstory|clarity\.ms|intercom|amplitude|newrelic|sentry|datadog|nr-data|optimizely|facebook\.com\/tr|tracking|pixel)/i;
const NOISE_FILE_PATTERN =
    /(\.map($|\?)|favicon\.ico($|\?)|\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|otf|css|less|sass|scss|mp3|wav|ogg|mp4|webm|avi|mov|zip|gz|br|pdf|wasm)(\?|$))/i;
const NOISE_MIME_PATTERN =
    /^(image\/|font\/|audio\/|video\/|text\/css\b|application\/octet-stream\b|application\/pdf\b)/i;
const TEXT_LIKE_MIME_PATTERN =
    /(application\/json|application\/graphql|application\/problem\+json|application\/x-www-form-urlencoded|multipart\/form-data|text\/|xml|javascript)/i;

export function createSession(inspectedTabId: number): CaptureSession {
    return {
        version: 1,
        sessionId: crypto.randomUUID(),
        inspectedTabId,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        itemCount: 0,
        items: []
    };
}

export function stopSession(session: CaptureSession): CaptureSession {
    return {
        ...session,
        stoppedAt: new Date().toISOString()
    };
}

export async function normalizeRequest(request: chrome.devtools.network.Request): Promise<CapturedRequest | null> {
    const candidate = request as DevtoolsRequest;
    const requestHeaders = normalizeHeaders(candidate.request.headers);
    const responseHeaders = normalizeHeaders(candidate.response.headers);
    const requestMimeType = pickHeader(requestHeaders, 'content-type') ?? candidate.request.postData?.mimeType ?? '';
    const responseMimeType =
        pickHeader(responseHeaders, 'content-type') ?? candidate.response.content?.mimeType ?? '';
    const resourceType = inferResourceType(candidate, responseMimeType);
    const bodySize = normalizeByteSize(candidate.response.bodySize ?? candidate.response.content?.size);
    const requestBodyText = candidate.request.postData?.text ?? null;

    if (
        shouldIgnoreRequest({
            bodySize,
            method: candidate.request.method,
            requestMimeType,
            resourceType,
            responseMimeType,
            url: candidate.request.url
        })
    ) {
        return null;
    }

    const responseBodyPreview = await readResponseBodyPreview(request, responseMimeType, bodySize);

    return {
        id: crypto.randomUUID(),
        method: candidate.request.method,
        url: candidate.request.url,
        status: candidate.response.status,
        mimeType: responseMimeType || requestMimeType || 'unknown',
        requestHeadersSummary: summarizeHeaders(requestHeaders, 'request'),
        responseHeadersSummary: summarizeHeaders(responseHeaders, 'response'),
        timing: summarizeTiming(candidate.time, candidate.timings),
        requestBodyPreview: formatBodyPreview(requestBodyText, requestMimeType),
        responseBodyPreview,
        bodySize,
        requestBodySize: normalizeByteSize(requestBodyText ? requestBodyText.length : null),
        resourceType,
        timestamp: candidate.startedDateTime
    };
}

export function appendCapturedRequest(
    session: CaptureSession,
    entry: CapturedRequest
): { nextSession: CaptureSession; overflowed: boolean } {
    const items = [...session.items, entry];
    const overflowed = items.length > MAX_CAPTURED_REQUESTS;
    const nextItems = overflowed ? items.slice(items.length - MAX_CAPTURED_REQUESTS) : items;

    return {
        nextSession: {
            ...session,
            itemCount: nextItems.length,
            items: nextItems
        },
        overflowed
    };
}

function normalizeHeaders(headers?: HeaderLine[]): HeaderLine[] {
    if (!Array.isArray(headers)) {
        return [];
    }

    return headers
        .map((header) => ({
            name: header.name.trim(),
            value: String(header.value ?? '').trim()
        }))
        .filter((header) => header.name.length > 0);
}

function pickHeader(headers: HeaderLine[], name: string): string | null {
    const match = headers.find((header) => header.name.toLowerCase() === name.toLowerCase());
    return match?.value ?? null;
}

function inferResourceType(request: DevtoolsRequest, responseMimeType: string): string {
    const explicitType = typeof request._resourceType === 'string' ? request._resourceType : '';
    if (explicitType) {
        return explicitType;
    }

    if (/graphql/i.test(request.request.url)) {
        return 'graphql';
    }

    if (/json/i.test(responseMimeType)) {
        return 'fetch';
    }

    if (/html/i.test(responseMimeType)) {
        return 'document';
    }

    const method = request.request.method.toUpperCase();
    if (method !== 'GET') {
        return 'xhr';
    }

    return 'other';
}

function shouldIgnoreRequest(input: {
    bodySize: number | null;
    method: string;
    requestMimeType: string;
    resourceType: string;
    responseMimeType: string;
    url: string;
}): boolean {
    const resourceType = input.resourceType.toLowerCase();
    const responseMime = input.responseMimeType.toLowerCase();
    const requestMime = input.requestMimeType.toLowerCase();
    const method = input.method.toUpperCase();

    if (NOISE_URL_PATTERN.test(input.url) || NOISE_FILE_PATTERN.test(input.url)) {
        return true;
    }

    if (['image', 'imageset', 'font', 'stylesheet', 'media'].includes(resourceType)) {
        return true;
    }

    if (NOISE_MIME_PATTERN.test(responseMime) || NOISE_MIME_PATTERN.test(requestMime)) {
        return true;
    }

    if (input.bodySize !== null && input.bodySize > 5_000_000 && !isTextLikeMime(responseMime)) {
        return true;
    }

    if (resourceType === 'document') {
        return method === 'GET' && !/html/i.test(responseMime);
    }

    if (['fetch', 'xhr', 'graphql'].includes(resourceType)) {
        return false;
    }

    if (method !== 'GET') {
        return false;
    }

    if (isTextLikeMime(responseMime) || isTextLikeMime(requestMime)) {
        return false;
    }

    return true;
}

function summarizeHeaders(headers: HeaderLine[], kind: 'request' | 'response'): HeaderSummary {
    const preferredNames =
        kind === 'request'
            ? ['content-type', 'accept', 'authorization', 'x-requested-with', 'origin', 'referer']
            : ['content-type', 'cache-control', 'location', 'server', 'content-length', 'set-cookie'];

    const entries = preferredNames
        .map((name) => headers.find((header) => header.name.toLowerCase() === name))
        .filter((header): header is HeaderLine => Boolean(header))
        .map((header) => ({
            name: header.name,
            value:
                header.name.toLowerCase() === 'authorization'
                    ? redactAuthorization(header.value)
                    : truncateText(header.value, 120)
        }));

    const flags: string[] = [];
    if (headers.some((header) => header.name.toLowerCase() === 'authorization')) {
        flags.push('auth');
    }
    if (headers.some((header) => header.name.toLowerCase() === 'cookie')) {
        flags.push('cookie');
    }
    if (headers.some((header) => header.name.toLowerCase() === 'set-cookie')) {
        flags.push('set-cookie');
    }

    return {
        total: headers.length,
        entries,
        flags
    };
}

function summarizeTiming(totalTime = 0, timings?: Record<string, number>): TimingSummary {
    const safe = (value: number | undefined): number | undefined => {
        if (typeof value !== 'number' || value < 0) {
            return undefined;
        }

        return roundMs(value);
    };

    return {
        totalMs: roundMs(totalTime),
        blocked: safe(timings?.blocked),
        dns: safe(timings?.dns),
        connect: safe(timings?.connect),
        ssl: safe(timings?.ssl),
        send: safe(timings?.send),
        wait: safe(timings?.wait),
        receive: safe(timings?.receive)
    };
}

async function readResponseBodyPreview(
    request: chrome.devtools.network.Request,
    responseMimeType: string,
    bodySize: number | null
): Promise<string | null> {
    if (!isTextLikeMime(responseMimeType)) {
        return null;
    }

    if (bodySize !== null && bodySize > 2_000_000) {
        return null;
    }

    const content = await new Promise<{ body: string | null; encoding: string | undefined }>((resolve) => {
        request.getContent((body, encoding) => {
            resolve({
                body,
                encoding
            });
        });
    });

    if (!content.body) {
        return null;
    }

    if (content.encoding === 'base64') {
        return null;
    }

    return formatBodyPreview(content.body, responseMimeType);
}

function formatBodyPreview(text: string | null, mimeType: string): string | null {
    if (!text) {
        return null;
    }

    const trimmed = text.trim();
    if (!trimmed) {
        return null;
    }

    const isJsonLike =
        /json|graphql/i.test(mimeType) || trimmed.startsWith('{') || trimmed.startsWith('[');

    if (isJsonLike) {
        try {
            return truncateText(JSON.stringify(JSON.parse(trimmed), null, 2), MAX_PREVIEW_CHARS);
        } catch {
            return truncateText(trimmed, MAX_PREVIEW_CHARS);
        }
    }

    return truncateText(trimmed, MAX_PREVIEW_CHARS);
}

function truncateText(value: string, limit: number): string {
    if (value.length <= limit) {
        return value;
    }

    return `${value.slice(0, limit)}\n…truncated`;
}

function redactAuthorization(value: string): string {
    const token = value.trim();
    if (!token) {
        return '';
    }

    const [scheme, credentials] = token.split(/\s+/, 2);
    if (!credentials) {
        return `${scheme.slice(0, 12)}…`;
    }

    return `${scheme} ${credentials.slice(0, 6)}…`;
}

function roundMs(value: number): number {
    return Math.round(value * 100) / 100;
}

function normalizeByteSize(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
        return null;
    }

    return Math.round(value);
}

function isTextLikeMime(mimeType: string): boolean {
    return TEXT_LIKE_MIME_PATTERN.test(mimeType);
}
