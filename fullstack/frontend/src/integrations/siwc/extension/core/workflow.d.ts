// SPDX-License-Identifier: GPL-3.0-or-later
// Local declarations for the unmodified generic workflow.js from siwc-bridge 0.1.3.
import type { CommandDefinition, JSONValue, WorkflowRole } from '../../sdk/page-bridge.js';

export interface WorkflowQuestion {
  id: string;
  type: 'single' | 'multi' | 'text' | 'confirmation';
  prompt: string;
  required: boolean;
  requiresPageAction?: boolean;
  pageAction?: { view: string; instruction: string };
  options?: Array<{ value: string; label: string }>;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
}
export interface PageWorkflow {
  workflow: 'page-workflow/1';
  status: 'needs_input' | 'ready' | 'completed' | 'invalidated' | 'cancelled';
  requestId: string;
  draftRevision: number;
  expiresAt: number;
  method?: string;
  running?: boolean;
  resume?: { command: string };
  run?: { command: string };
  cancel?: { command: string };
  message?: string;
  preview?: Record<string, JSONValue>;
  questions?: WorkflowQuestion[];
  resultId?: string;
  view?: string;
}
export interface WorkflowCommand { op: string; args: Record<string, unknown> }
export interface WorkflowSnapshot { commands: CommandDefinition[]; workflow?: unknown }
export interface WorkflowAnswer { questionId: string; value: JSONValue }
export declare const WORKFLOW_PROTOCOL: 'page-workflow/1';
export declare const WORKFLOW_ROLES: readonly WorkflowRole[];
export declare const FORM_LIMITS: Readonly<{ questions: number; optionsPerQuestion: number; optionsTotal: number; textLength: number; bytes: number }>;
export declare function safeView(value: unknown): boolean;
export declare function validateQuestions(raw: unknown): WorkflowQuestion[];
export declare function validateWorkflow(raw: unknown): PageWorkflow;
export declare function commandRole(command: string | WorkflowCommand, definitions: CommandDefinition[]): WorkflowRole | null;
export declare function workflowCommand(workflow: PageWorkflow | null | undefined, role: Exclude<WorkflowRole, 'prepare'>, definitions: CommandDefinition[]): string;
export declare function pendingWorkflow(snapshot: { workflow?: unknown }): PageWorkflow | null;
export declare function workflowFromExecution(result: { results: Array<{ op: string; status: string; result?: unknown }> }, definitions: CommandDefinition[]): PageWorkflow | null;
export declare function questionIdentity(question: WorkflowQuestion): string;
export declare function workflowIdentity(workflow: PageWorkflow): string;
export declare function preserveInputs(previousQuestions: WorkflowQuestion[], nextQuestions: WorkflowQuestion[], values?: Record<string, JSONValue>): Record<string, JSONValue>;
export declare function answerErrors(questions: WorkflowQuestion[], raw: unknown): { errors: Record<string, string>; answers: unknown[] };
export declare function validateAnswers(questions: WorkflowQuestion[], raw: unknown): WorkflowAnswer[];
export declare function assertWorkflowPlan(plan: { commands: WorkflowCommand[] }, definitions: CommandDefinition[], options?: { model?: boolean }): void;
export declare function assertWorkflowPrecondition(command: WorkflowCommand, snapshot: WorkflowSnapshot, clock?: () => number): void;
