import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Runtime } from '../runtime.js';
import type { TaskManager } from '../tasks/manager.js';
export interface HttpServerHandle {
    readonly server: http.Server;
    readonly close: () => Promise<void>;
    readonly address: () => AddressInfo | null;
}
/**
 * Create the plugin's HTTP surface: `GET /healthz` and `/mcp` (Streamable HTTP).
 * The returned server is not listening yet; the plugin entry owns `listen`.
 */
export declare function createHttpServer(runtime: Runtime, manager: TaskManager): HttpServerHandle;
