import type { TraceInclude, TraceState } from './types.js';
/** Structural slice of a DSH SessionEvent; the adapter never exposes raw JSON. */
export interface TraceEvent {
    seq: number;
    type: string;
    data?: unknown;
}
export interface TraceFormatOptions {
    taskId: string;
    afterSeq?: number;
    limit: number;
    include: readonly TraceInclude[];
    maxBytes: number;
}
export interface TracePage {
    content: string;
    state: TraceState;
}
/** Build the readable trace page. Pure; the adapter supplies events. */
export declare function formatTrace(events: readonly TraceEvent[], options: TraceFormatOptions): TracePage;
