import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { TaskManager } from '../../tasks/manager.js'
import { asDomainError } from '../../errors.js'
import type { TraceInclude } from '../../types.js'
import { failure, listContent, success } from '../format.js'

const taskId = z.string().min(1).describe('Task id returned by dsh_task_submit or dsh_agent_run.')
const timeoutMs = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe('Maximum wait in milliseconds. Defaults to the plugin setting; capped by interactions.maxWaitMs.')

const submitFields = {
  task: z.string().min(1).describe('The task for the DSH agent. Be specific about the goal and constraints.'),
  context: z.string().optional().describe('Optional background the executing agent needs.'),
  cwd: z.string().optional().describe('Absolute working directory. Defaults to the plugin process cwd.'),
  sessionId: z.string().min(1).optional().describe('Continue this DSH session instead of allocating one.'),
  sessionMode: z
    .enum(['reuse', 'fresh'])
    .optional()
    .describe('reuse: reuse an idle session for the same cwd/preset/model; fresh: start a new conversation.'),
  title: z.string().optional().describe('Optional title for a newly created DSH session.'),
}

const traceInclude = z.enum(['messages', 'reasoning', 'toolCalls', 'toolResults', 'interactions'])

/** Register every core task-delegation tool on one MCP server. */
export function registerTaskTools(server: McpServer, manager: TaskManager): void {
  server.registerTool(
    'dsh_task_submit',
    {
      title: 'Submit a DSH task',
      description: 'Enqueue a task for DSH and return its taskId immediately.',
      inputSchema: z.object(submitFields),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        const record = await manager.submit(args)
        return success(record, manager.queueInfo(record.taskId))
      } catch (error) {
        return failure(asDomainError(error))
      }
    },
  )

  server.registerTool(
    'dsh_task_get',
    {
      title: 'Read task state',
      description: "Read a task's current state without waiting.",
      inputSchema: z.object({ taskId }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ taskId: id }) => {
      try {
        const record = manager.get(id)
        return success(record, manager.queueInfo(id))
      } catch (error) {
        return failure(asDomainError(error))
      }
    },
  )

  server.registerTool(
    'dsh_task_wait',
    {
      title: 'Wait for a task',
      description: 'Wait until a task finishes or needs approval/answer, or the timeout expires.',
      inputSchema: z.object({ taskId, timeoutMs }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ taskId: id, timeoutMs: timeout }) => {
      try {
        const record = await manager.wait(id, { timeoutMs: timeout })
        return success(record, manager.queueInfo(id))
      } catch (error) {
        return failure(asDomainError(error))
      }
    },
  )

  server.registerTool(
    'dsh_agent_run',
    {
      title: 'Run a task and wait',
      description: 'Submit a task and wait for it; convenience for one-shot delegation.',
      inputSchema: z.object({ ...submitFields, timeoutMs }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        const record = await manager.submit(args)
        const waited = await manager.wait(record.taskId, { timeoutMs: args.timeoutMs })
        return success(waited, manager.queueInfo(waited.taskId))
      } catch (error) {
        return failure(asDomainError(error))
      }
    },
  )

  server.registerTool(
    'dsh_task_cancel',
    {
      title: 'Cancel a task',
      description: 'Cancel a queued or running task; a pending approval/question is canceled too.',
      inputSchema: z.object({ taskId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ taskId: id }) => {
      try {
        const result = await manager.cancel(id)
        const text =
          !result.already && result.record.status === 'canceled'
            ? `Task ${id} canceled.`
            : `Task ${id} is already ${result.record.status}; nothing to cancel.`
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: success(result.record).structuredContent,
        }
      } catch (error) {
        return failure(asDomainError(error))
      }
    },
  )

  server.registerTool(
    'dsh_task_list',
    {
      title: 'List tasks',
      description: 'List recent tasks; returns summaries only.',
      inputSchema: z.object({
        status: z
          .enum(['queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled', 'interrupted'])
          .optional(),
        cwd: z.string().optional().describe('Only tasks in this working directory.'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20, maximum 100.'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (filter) => {
      try {
        const records = manager.list(filter)
        const summaries = manager.summaries(records)
        return {
          content: [{ type: 'text' as const, text: listContent(records, summaries) }],
          structuredContent: { taskIds: records.map((record) => record.taskId) },
        }
      } catch (error) {
        return failure(asDomainError(error))
      }
    },
  )

  server.registerTool(
    'dsh_task_approve',
    {
      title: 'Decide an approval',
      description: 'Approve or reject the pending approval on a waiting task.',
      inputSchema: z.object({
        taskId,
        requestId: z.string().min(1).describe('requestId from the waiting TaskState.'),
        decision: z.enum(['allow-once', 'reject']),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ taskId: id, requestId, decision }) => {
      try {
        const result = await manager.approve(id, requestId, decision)
        const text = result.already
          ? `Approval already recorded (${decision}); task ${id} is ${result.record.status}.`
          : `Approval recorded (${decision}); task ${id} resumed.`
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: success(result.record).structuredContent,
        }
      } catch (error) {
        return failure(asDomainError(error))
      }
    },
  )

  server.registerTool(
    'dsh_task_answer',
    {
      title: 'Answer a question',
      description: 'Answer the pending questions on a waiting task.',
      inputSchema: z.object({
        taskId,
        requestId: z.string().min(1).describe('requestId from the waiting TaskState.'),
        answers: z
          .array(
            z.object({
              questionId: z.string().min(1),
              selected: z.array(z.string()).default([]),
              custom: z.string().optional(),
            }),
          )
          .min(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ taskId: id, requestId, answers }) => {
      try {
        const result = await manager.answer(id, requestId, answers)
        const text = result.already
          ? `Answer already recorded; task ${id} is ${result.record.status}.`
          : `Answer recorded; task ${id} resumed.`
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: success(result.record).structuredContent,
        }
      } catch (error) {
        return failure(asDomainError(error))
      }
    },
  )

  server.registerTool(
    'dsh_task_trace',
    {
      title: 'Read a task trace',
      description: "Read a task's execution transcript in pages.",
      inputSchema: z.object({
        taskId,
        afterSeq: z.number().int().nonnegative().optional().describe('Exclusive event sequence to continue after.'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50, maximum 200 events.'),
        include: z.array(traceInclude).optional().describe('Default: everything except reasoning.'),
        maxBytes: z
          .number()
          .int()
          .min(256)
          .max(262_144)
          .optional()
          .describe('Default 65536, maximum 262144 bytes.'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ taskId: id, afterSeq, limit, include, maxBytes }) => {
      try {
        const result = await manager.trace(id, {
          afterSeq,
          limit,
          include: include as TraceInclude[] | undefined,
          maxBytes,
        })
        return {
          content: [{ type: 'text' as const, text: result.content }],
          structuredContent: result.state as unknown as Record<string, unknown>,
        }
      } catch (error) {
        return failure(asDomainError(error))
      }
    },
  )
}
