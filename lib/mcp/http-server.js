import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
const MCP_PATH = '/mcp';
const HEALTH_PATH = '/healthz';
const MAX_MCP_SESSIONS = 64;
const SESSION_IDLE_MS = 10 * 60 * 1000;
/**
 * Create the plugin's HTTP surface: `GET /healthz` and `/mcp` (Streamable HTTP).
 * The returned server is not listening yet; the plugin entry owns `listen`.
 */
export function createHttpServer(runtime, manager) {
    const { logger } = runtime;
    const servers = new Map();
    const transports = new Map();
    const lastSeen = new Map();
    let closing = false;
    const reaper = setInterval(() => {
        const cutoff = Date.now() - SESSION_IDLE_MS;
        for (const [id, seen] of lastSeen) {
            if (seen >= cutoff)
                continue;
            const transport = transports.get(id);
            void transport?.close().catch(() => undefined);
        }
    }, Math.min(60_000, SESSION_IDLE_MS));
    reaper.unref();
    const server = http.createServer((req, res) => {
        void handleRequest(req, res).catch((error) => {
            logger.error('http request failed', { error });
            if (!res.headersSent)
                sendJson(res, 500, { error: 'internal_error' });
            else
                res.end();
        });
    });
    async function handleRequest(req, res) {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === HEALTH_PATH) {
            if (req.method !== 'GET') {
                sendJson(res, 405, { error: 'method_not_allowed' });
                return;
            }
            const health = manager.health();
            sendJson(res, 200, {
                status: 'ok',
                name: 'dsh-task-delegation',
                version: runtime.version,
                uptimeMs: Date.now() - runtime.startedAt,
                queue: health.queue,
                agents: health.agents,
            });
            return;
        }
        if (url.pathname !== MCP_PATH) {
            sendJson(res, 404, { error: 'not_found' });
            return;
        }
        if (closing) {
            sendJson(res, 503, { error: 'shutting_down' });
            return;
        }
        if (!authorized(req, runtime)) {
            sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
            return;
        }
        if (!originAllowed(req, runtime)) {
            sendJson(res, 403, { error: 'forbidden_origin' });
            return;
        }
        if (!bodyAllowed(req, runtime)) {
            sendJson(res, 413, { error: 'payload_too_large' });
            return;
        }
        const sessionId = header(req, 'mcp-session-id');
        const existing = sessionId === undefined ? undefined : transports.get(sessionId);
        if (existing !== undefined && sessionId !== undefined) {
            lastSeen.set(sessionId, Date.now());
            if (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE') {
                await existing.handleRequest(req, res);
                return;
            }
            sendJson(res, 405, { error: 'method_not_allowed' });
            return;
        }
        if (req.method === 'POST' && sessionId === undefined) {
            if (transports.size >= MAX_MCP_SESSIONS) {
                sendJson(res, 503, { error: 'too_many_sessions' });
                return;
            }
            const mcp = createMcpServer(runtime, manager);
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                maxRequestBodySize: runtime.config.http.maxBodyBytes,
                onsessioninitialized: (id) => {
                    transports.set(id, transport);
                    servers.set(id, mcp);
                    lastSeen.set(id, Date.now());
                    logger.debug('mcp session initialized', { sessionId: id });
                },
            });
            transport.onclose = () => {
                const id = transport.sessionId;
                if (id === undefined)
                    return;
                transports.delete(id);
                servers.delete(id);
                lastSeen.delete(id);
                logger.debug('mcp session closed', { sessionId: id });
            };
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
            return;
        }
        if (sessionId !== undefined) {
            sendJson(res, 404, { error: 'session_not_found' });
            return;
        }
        sendJson(res, 400, { error: 'invalid_request' });
    }
    server.on('clientError', (error, socket) => {
        logger.warn('http client error', { error });
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    return {
        server,
        address: () => server.address(),
        close: async () => {
            closing = true;
            clearInterval(reaper);
            for (const mcp of [...servers.values()]) {
                try {
                    await mcp.close();
                }
                catch {
                    // Closing is best effort; the transport close below is the backstop.
                }
            }
            for (const transport of [...transports.values()]) {
                try {
                    await transport.close();
                }
                catch {
                    // Already closed by the peer; nothing to release.
                }
            }
            transports.clear();
            servers.clear();
            lastSeen.clear();
            server.closeAllConnections();
            await new Promise((resolve) => {
                server.close(() => resolve());
            });
        },
    };
}
function header(req, name) {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}
function authorized(req, runtime) {
    const token = runtime.config.http.authToken;
    if (token === '')
        return true;
    const actual = Buffer.from(header(req, 'authorization') ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function originAllowed(req, runtime) {
    const origin = header(req, 'origin');
    if (origin === undefined)
        return true;
    const allowed = runtime.config.http.allowedOrigins;
    return allowed.includes(origin);
}
function bodyAllowed(req, runtime) {
    const raw = header(req, 'content-length');
    if (raw === undefined)
        return true;
    const length = Number(raw);
    return Number.isFinite(length) && length >= 0 && length <= runtime.config.http.maxBodyBytes;
}
function sendJson(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        ...extraHeaders,
    });
    res.end(payload);
}
