import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
/** Cordis plugin name. */
export declare const name = "dsh-task-delegation";
/** Services required before the MCP surface and agent factory are usable. */
export declare const inject: string[];
/** Start the MCP server and own its lifecycle through `ctx.effect`. */
export declare function apply(ctx: Context, config?: Config): Promise<void>;
