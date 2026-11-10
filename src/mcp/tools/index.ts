import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { TaskManager } from '../../tasks/manager.js'
import { registerTaskTools } from './tasks.js'

/** Register every tool exposed by this MCP server. */
export function registerTools(server: McpServer, manager: TaskManager): void {
  registerTaskTools(server, manager)
}
