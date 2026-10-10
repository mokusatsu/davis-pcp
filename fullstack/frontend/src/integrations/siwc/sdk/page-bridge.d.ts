// SPDX-License-Identifier: GPL-3.0-or-later
// Locally amended from siwc-bridge 0.1.1; see ../UPSTREAM.md.
export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type JSONSchema = { [key: string]: JSONValue };
export interface CommandDefinition {
  name: string;
  description: string;
  effect: 'read' | 'write' | 'external';
  inputSchema: JSONSchema;
}
export interface OperationContext {
  signal: AbortSignal;
  runId: string;
  planId: string;
  operationId: string;
  /** Compare synchronously with the current host generation immediately before mutation. */
  expectedRevision: string;
}
export interface PageBridgeOptions {
  appId: string;
  appName: string;
  commands: CommandDefinition[] | (() => CommandDefinition[] | Promise<CommandDefinition[]>);
  getContext: () => JSONValue | Promise<JSONValue>;
  getRevision: () => string | Promise<string>;
  handlers: Record<string, (args: Record<string, JSONValue>, context: OperationContext) => unknown | Promise<unknown>>;
  authorize?: (commands: Array<{op:string;args:Record<string,JSONValue>}>, context:{runId:string;revision:string}) => boolean | Promise<boolean>;
  lockName?: string | null;
  clock?: () => number;
}
export declare const CHANNEL: string;
export declare function registerPageBridge(options: PageBridgeOptions): () => void;
export declare function createPageAdapter(options: PageBridgeOptions): {
  snapshot(): Promise<unknown>;
  execute(envelope: unknown): Promise<unknown>;
  cancel(runId: string): {cancelled: boolean};
  dispose(): void;
};
