// SPDX-License-Identifier: GPL-3.0-or-later
// Local declarations for the unmodified common.js from siwc-bridge 0.1.1.
export declare class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message?: string);
}
export declare function assert(ok: unknown, code: string, message?: string): asserts ok;
export declare const textEncoder: TextEncoder;
export declare function isObject(value: unknown): value is Record<string, unknown>;
export declare function randomId(bytes?: number): string;
export declare function base64url(bytes: Uint8Array): string;
export declare function unbase64url(value: string): Uint8Array;
export declare function canonical(value: unknown): string;
export declare function digest(value: unknown): Promise<string>;
export declare function boundedJSON<T>(value: T, maxBytes?: number): T;
export declare function publicError(error: unknown): {code: string};
export declare function abortError(): BridgeError;
export declare function throwIfAborted(signal?: AbortSignal | null): void;
export declare function safeTarget(raw: string, incognito?: boolean): boolean;
export declare function linkedSignal(signals?: Array<AbortSignal | null | undefined>, timeoutMs?: number): {signal: AbortSignal; dispose(): void};
