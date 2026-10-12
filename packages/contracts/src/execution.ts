import type { Item } from './nodes';

export const EXECUTION_STATES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const TERMINAL_EXECUTION_STATES: readonly ExecutionState[] = ['succeeded', 'failed', 'cancelled', 'timed_out'];

export const STEP_STATES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'retrying',
  'skipped',
  'cancelled',
  'timed_out',
  'waiting',
] as const;
export type StepState = (typeof STEP_STATES)[number];

export type ExecutionMode = 'manual' | 'trigger' | 'retry' | 'subworkflow' | 'test' | 'api' | 'cli';

export interface ExecutionError {
  code: string;
  message: string;
  nodeId?: string;
  stack?: string;
}

export interface Execution {
  id: string;
  workflowId: string;
  versionId: string | null;
  workflowName: string;
  triggerNodeId: string;
  mode: ExecutionMode;
  state: ExecutionState;
  triggerItems: Item[];
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  engineVersion: string;
  correlationId: string;
  error: ExecutionError | null;
  parentExecutionId: string | null;
  retryOfExecutionId: string | null;
  /** Graph that actually ran (pinned version or draft snapshot for manual tests). */
  graphChecksum: string;
}

export interface StepLog {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export interface ExecutionStep {
  id: string;
  executionId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  attempt: number;
  state: StepState;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Sanitized input items per input port. */
  input: Record<string, Item[]> | null;
  /** Sanitized output items per output port. */
  output: Record<string, Item[]> | null;
  error: ExecutionError | null;
  logs: StepLog[];
  retryInMs: number | null;
  truncated: boolean;
}

export type EngineEvent =
  | {
      type: 'execution.updated';
      executionId: string;
      workflowId: string;
      state: ExecutionState;
      ts: string;
      error?: ExecutionError | null;
    }
  | {
      type: 'step.updated';
      executionId: string;
      workflowId: string;
      stepId: string;
      nodeId: string;
      attempt: number;
      state: StepState;
      ts: string;
      durationMs?: number | null;
      retryInMs?: number | null;
      error?: ExecutionError | null;
    }
  | {
      type: 'step.log';
      executionId: string;
      workflowId: string;
      nodeId: string;
      level: StepLog['level'];
      message: string;
      ts: string;
    }
  | { type: 'notification'; id: string; title: string; body: string; workflowId?: string; ts: string }
  | { type: 'workflow.updated'; workflowId: string; ts: string };
