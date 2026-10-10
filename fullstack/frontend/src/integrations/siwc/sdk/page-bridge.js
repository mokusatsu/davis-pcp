// SPDX-License-Identifier: GPL-3.0-or-later
// Locally amended from siwc-bridge 0.1.1; see ../UPSTREAM.md.
import { assert, randomId, digest, boundedJSON, publicError, throwIfAborted, isObject } from '../extension/core/common.js';
import { normalizeCommands, planSchema, validatePlan } from '../extension/core/schema.js';
import { validateWorkflow, commandRole, assertWorkflowPlan, assertWorkflowPrecondition } from '../extension/core/workflow.js';

export const CHANNEL = 'siwc-page-commands/1';

/**
 * All data selection, application permissions and mutation semantics stay with the app.
 * No tokens, inference API or remotely supplied JavaScript are accepted here.
 * Same-window/origin checks are a transport boundary, not extension authentication.
 */
export function createPageAdapter({appId, appName, commands, getContext, getWorkflow, getRevision, handlers, authorize = async () => true, lockName = null, clock = () => Date.now()}) {
  assert(/^[a-z][a-z0-9.-]{0,79}$/.test(appId), 'INVALID_APP_ID');
  assert(typeof appName === 'string' && appName.length <= 120, 'INVALID_APP_NAME');
  assert(typeof getContext === 'function' && typeof getRevision === 'function', 'INVALID_ADAPTER');
  assert(getWorkflow === undefined || typeof getWorkflow === 'function', 'INVALID_ADAPTER');
  const snapshots = new Map(), plans = new Map(), cancelled = new Set(), running = new Map();
  let chain = Promise.resolve(), disposed = false;
  const active = () => assert(!disposed, 'ADAPTER_DISPOSED');
  const getCommands = async () => {
    active();
    const defs = typeof commands === 'function' ? await commands() : commands;
    active();
    return normalizeCommands(defs);
  };
  const revision = async () => {
    active();
    const value = await getRevision();
    active();
    assert(typeof value === 'string' && value.length <= 2048, 'INVALID_REVISION');
    return value;
  };
  const workflow = async () => {
    active();
    const value = getWorkflow ? await getWorkflow() : null;
    active();
    return value === null || value === undefined ? null : validateWorkflow(value);
  };
  // A reporting failure must never discard receipts for operations already completed.
  const reportedRevision = async () => {
    try { return {revision: await revision()}; } catch { return {}; }
  };

  async function snapshot() {
    active();
    const before = await revision();
    const defs = await getCommands();
    active();
    const rawContext = await getContext();
    active();
    const context = boundedJSON(rawContext);
    const currentWorkflow = await workflow();
    active();
    const schemaHash = await digest(defs);
    active();
    const after = await revision();
    assert(before === after, 'STATE_CHANGED_DURING_SNAPSHOT');
    active();
    for (const [id, snap] of snapshots) if (snap.expiresAt <= clock()) snapshots.delete(id);
    // Check capacity after the awaits so concurrent snapshots cannot overfill the cache.
    assert(snapshots.size < 128, 'TOO_MANY_SNAPSHOTS');
    const id = randomId(16), expiresAt = clock() + 300000;
    const result = boundedJSON({protocol: 1, contractRevision: 2, app: {id: appId, name: appName}, snapshotId: id, schemaHash, revision: after, expiresAt, commands: defs, context, workflow: currentWorkflow});
    snapshots.set(id, {revision: after, schemaHash, defs, expiresAt});
    return result;
  }

  async function work(envelope) {
    active();
    const {snapshotId, schemaHash, plan, runId, expiresAt} = envelope;
    const snap = snapshots.get(snapshotId);
    assert(snap, 'UNKNOWN_OR_USED_SNAPSHOT');
    snapshots.delete(snapshotId); // Consume before any asynchronous handler or authorizer.
    const check = () => {
      active();
      assert(clock() < expiresAt && clock() < snap.expiresAt, 'PLAN_EXPIRED');
      assert(!cancelled.has(runId), 'CANCELLED');
    };
    check();
    assert(envelope.revision === snap.revision && schemaHash === snap.schemaHash, 'SNAPSHOT_MISMATCH');
    assert(await revision() === snap.revision, 'STALE_STATE');
    check();
    const currentSchemaHash = await digest(await getCommands());
    check();
    assert(currentSchemaHash === snap.schemaHash, 'SCHEMA_CHANGED');
    const checked = validatePlan(planSchema(snap.defs), plan);
    assert(checked.kind === 'commands', 'NO_COMMANDS');
    assertWorkflowPlan(checked, snap.defs);
    const allowed = await authorize(checked.commands, {runId, revision: snap.revision});
    check();
    assert(allowed, 'APP_PERMISSION_DENIED');
    assert(await revision() === snap.revision, 'STALE_STATE');
    check();
    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => controller.abort(), Math.max(1, Math.min(expiresAt, snap.expiresAt) - clock()));
    running.set(runId, {controller, deadlineTimer});
    const results = [];
    let expectedRevision = snap.revision;
    try {
      for (let index = 0; index < checked.commands.length; index++) {
        check();
        throwIfAborted(controller.signal);
        assert(await revision() === expectedRevision, 'STATE_CHANGED_DURING_PLAN');
        check();
        throwIfAborted(controller.signal);
        const command = checked.commands[index];
        if (commandRole(command, snap.defs)) {
          const currentWorkflow = await workflow();
          check();
          throwIfAborted(controller.signal);
          // A workflow read can await application state. Never let its stale
          // binding outlive a generation change, cancellation or disposal.
          assert(await revision() === expectedRevision, 'STATE_CHANGED_DURING_PLAN');
          check();
          throwIfAborted(controller.signal);
          assertWorkflowPrecondition(command, {commands: snap.defs, workflow: currentWorkflow}, clock);
        }
        assert(Object.hasOwn(handlers, command.op) && typeof handlers[command.op] === 'function', 'NO_COMMAND_HANDLER');
        let result;
        try {
          // The host must compare expectedRevision synchronously immediately before mutation.
          const pending = handlers[command.op](boundedJSON(command.args), {
            signal: controller.signal, runId, planId: envelope.planId,
            operationId: envelope.planId + ':' + index, expectedRevision,
          });
          // Preserve synchronous commits: capture their successor revision in this
          // same turn, before unrelated microtasks can become the plan's baseline.
          const output = pending && typeof pending.then === 'function' ? await pending : pending;
          result = boundedJSON(output ?? null);
        } catch (error) {
          results.push({index, op: command.op, status: 'failed', error: publicError(error)});
          return {status: 'partial', results, ...await reportedRevision()};
        }
        // A resolved handler reports its completed effect, even if cancellation followed commit.
        // Later checks belong to the plan, never to a second receipt for this operation.
        results.push({index, op: command.op, status: 'completed', result});
        expectedRevision = await revision();
        check();
        throwIfAborted(controller.signal);
      }
      return {status: 'completed', results, revision: expectedRevision};
    } catch (error) {
      return {status: results.length ? 'partial' : 'failed', results, error: publicError(error), ...await reportedRevision()};
    } finally {
      clearTimeout(deadlineTimer);
      running.delete(runId);
    }
  }

  async function execute(raw) {
    active();
    const envelope = boundedJSON(raw);
    assert(isObject(envelope), 'INVALID_ENVELOPE');
    assert(typeof envelope.planId === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(envelope.planId), 'INVALID_PLAN_ID');
    assert(typeof envelope.runId === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(envelope.runId), 'INVALID_RUN_ID');
    assert(typeof envelope.snapshotId === 'string' && typeof envelope.schemaHash === 'string' && typeof envelope.revision === 'string' && envelope.revision.length <= 2048, 'INVALID_ENVELOPE');
    assert(Number.isFinite(envelope.expiresAt) && envelope.expiresAt > clock() && envelope.expiresAt <= clock() + 300000, 'INVALID_PLAN_EXPIRY');
    const fingerprint = await digest(envelope);
    active();
    const previous = plans.get(envelope.planId);
    if (previous) {
      assert(previous.fingerprint === fingerprint, 'PLAN_ID_REUSE');
      return previous.promise;
    }
    // A full cache fails closed; eviction must not make an old mutation executable again.
    assert(plans.size < 1024, 'EXECUTION_CACHE_FULL');
    const executeOnce = () => work(envelope);
    const locked = () => {
      active();
      return lockName && globalThis.navigator?.locks
        ? navigator.locks.request(lockName, executeOnce) : executeOnce();
    };
    const promise = chain.then(locked).catch(error => ({status: 'failed', results: [], error: publicError(error)}));
    chain = promise.then(() => {});
    plans.set(envelope.planId, {fingerprint, promise});
    return promise;
  }

  function cancel(runId) {
    active();
    assert(typeof runId === 'string' && runId.length <= 80, 'INVALID_RUN_ID');
    assert(cancelled.size < 1024 || cancelled.has(runId), 'CANCEL_CACHE_FULL');
    cancelled.add(runId);
    running.get(runId)?.controller.abort();
    return {cancelled: true};
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const {controller, deadlineTimer} of running.values()) {
      clearTimeout(deadlineTimer);
      controller.abort();
    }
    snapshots.clear();
    plans.clear();
    cancelled.clear();
    running.clear();
  }
  return {snapshot, execute, cancel, dispose};
}

export function registerPageBridge(options) {
  assert(globalThis.window && window === window.top && location.protocol === 'https:', 'HTTPS_TOP_LEVEL_REQUIRED');
  for (const name of ['siwc-bridge', 'siwc-bridge-app']) {
    assert(document.querySelectorAll(`meta[name="${name}"]`).length <= 1, 'DUPLICATE_META');
  }
  const adapter = createPageAdapter(options);
  let disposed = false;
  const metaCleanups = [];
  function meta(name, value) {
    let element = document.querySelector(`meta[name="${name}"]`);
    const created = !element;
    if (!element) {
      element = document.createElement('meta');
      element.name = name;
      document.head.append(element);
    }
    const previous = element.getAttribute('content');
    element.content = value;
    metaCleanups.push(() => {
      if (element.content !== value) return;
      if (created) element.remove();
      else if (previous === null) element.removeAttribute('content');
      else element.setAttribute('content', previous);
    });
  }
  meta('siwc-bridge', 'page-commands/1');
  meta('siwc-bridge-app', options.appId);
  const listener = async event => {
    if (disposed || event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.direction !== 'to-page' || typeof message.id !== 'string' || message.id.length > 100) return;
    if (!['snapshot', 'execute', 'cancel'].includes(message.method)) return;
    let reply;
    try {
      const value = message.method === 'snapshot' ? await adapter.snapshot()
        : message.method === 'execute' ? await adapter.execute(message.payload) : adapter.cancel(message.payload?.runId);
      reply = {ok: true, value: boundedJSON(value)};
    } catch (error) { reply = {ok: false, error: publicError(error)}; }
    if (!disposed) window.postMessage({channel: CHANNEL, direction: 'to-extension', id: message.id, ...reply}, location.origin);
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('message', listener);
    window.removeEventListener('pagehide', dispose);
    adapter.dispose();
    metaCleanups.forEach(cleanup => cleanup());
  }
  window.addEventListener('message', listener);
  window.addEventListener('pagehide', dispose);
  // The host re-registers after pageshow/readiness; disposed instances never revive.
  return dispose;
}
