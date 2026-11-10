import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools/index.js';
/** Create one MCP server for one transport session. */
export function createMcpServer(runtime, manager) {
    const server = new McpServer({
        name: 'dsh-task-delegation',
        version: runtime.version,
    });
    registerTools(server, manager);
    return server;
}
