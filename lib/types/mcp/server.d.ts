import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import type { TaskManager } from '../tasks/manager.js';
/** Create one MCP server for one transport session. */
export declare function createMcpServer(runtime: Runtime, manager: TaskManager): McpServer;
