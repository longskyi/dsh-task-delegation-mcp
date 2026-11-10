import { registerTaskTools } from './tasks.js';
/** Register every tool exposed by this MCP server. */
export function registerTools(server, manager) {
    registerTaskTools(server, manager);
}
