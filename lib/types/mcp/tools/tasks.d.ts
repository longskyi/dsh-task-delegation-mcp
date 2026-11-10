import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TaskManager } from '../../tasks/manager.js';
/** Register every core task-delegation tool on one MCP server. */
export declare function registerTaskTools(server: McpServer, manager: TaskManager): void;
