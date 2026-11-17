import type {
  ToastManager,
  ToastManagerAddOptions,
  ToastManagerPromiseOptions,
  ToastManagerUpdateOptions,
} from "@base-ui/react/toast";
import {
  type ConditionDismissal,
  isConditionSuppressed,
  isProgressOutcome,
  resolveToastStoreTimeout,
  toastSeverityRank,
} from "./toast.policy";

export interface ToastPolicyData {
  /** Identity of an ongoing condition; see `TOAST_CONDITION_COOLDOWN_MS`. */
  conditionKey?: string | undefined;
}

/** Why a toast was handed to the store; lets callers react only to new notices. */
export type ToastShowReason = "add" | "promise" | "resurface";

type AnyAddOptions = ToastManagerAddOptions<ToastPolicyData>;
type AnyUpdateOptions = ToastManagerUpdateOptions<ToastPolicyData>;

interface Entry {
  /** Caller's options, merged across updates; raw (pre-policy) timeout. */
  options: AnyAddOptions;
  state: "open" | "dismissed" | "suppressed";
  /** Timeout last handed to Base UI's store. */
  storeTimeout: number;
}

/** Retained so late outcomes/condition updates can find dismissed toasts. */
const MAX_TRACKED_TOASTS = 200;

function resolvePromiseOptions<Value>(
  options: string | AnyUpdateOptions | ((value: Value) => string | AnyUpdateOptions),
  value?: Value,
): AnyUpdateOptions {
  const resolved = typeof options === "function" ? options(value as Value) : options;
  return typeof resolved === "string" ? { description: resolved } : resolved;
}

function storeTimeoutOf(toast: AnyUpdateOptions): number {
  return resolveToastStoreTimeout(toast.type, toast.timeout);
}

function withoutTimeout(updates: AnyUpdateOptions): AnyUpdateOptions {
  if (!Object.hasOwn(updates, "timeout")) return updates;
  const { timeout: _ignored, ...rest } = updates;
  return rest;
}

/**
 * Wraps a Base UI toast manager with the shared lifetime policy. The returned
 * manager is a drop-in replacement (it keeps Base UI's private subscribe hook);
 * `dismiss` closes a toast as if the user dismissed it (used by auto-dismiss),
 * whereas `manager.close` is a programmatic close by the owner of the toast.
 */
export function withToastPolicy<Data extends ToastPolicyData>(
  base: ToastManager<Data>,
  options: { now?: () => number; onShow?: (reason: ToastShowReason) => void } = {},
): { manager: ToastManager<Data>; dismiss: (id: string) => void } {
  const now = options.now ?? Date.now;
  const baseAdd = base.add as (options: AnyAddOptions) => string;
  const baseUpdate = base.update as (id: string, updates: AnyUpdateOptions) => void;
  const entries = new Map<string, Entry>();
  const conditions = new Map<string, ConditionDismissal>();
  let sequence = 0;

  function trim() {
    if (entries.size <= MAX_TRACKED_TOASTS) return;
    for (const [id, entry] of entries) {
      if (entries.size <= MAX_TRACKED_TOASTS) return;
      if (entry.state !== "open") entries.delete(id);
    }
  }

  function handleClosed(id: string, entry: Entry) {
    // Programmatic closes drop the entry first; resurfaced toasts replace it.
    if (entries.get(id) !== entry) return;
    entry.state = "dismissed";
    const key = entry.options.data?.conditionKey;
    if (key) {
      conditions.set(key, {
        dismissedAt: now(),
        severityRank: toastSeverityRank(entry.options.type),
      });
    }
  }

  function show(id: string, toast: AnyAddOptions, reason: ToastShowReason) {
    const entry: Entry = { options: toast, state: "open", storeTimeout: storeTimeoutOf(toast) };
    entries.delete(id);
    entries.set(id, entry);
    trim();
    const key = toast.data?.conditionKey;
    if (key) conditions.delete(key);
    const onClose = toast.onClose;
    options.onShow?.(reason);
    baseAdd({
      ...toast,
      id,
      timeout: entry.storeTimeout,
      onClose: () => {
        handleClosed(id, entry);
        onClose?.();
      },
    });
  }

  function isSuppressed(toast: AnyAddOptions): boolean {
    const key = toast.data?.conditionKey;
    return key !== undefined && isConditionSuppressed(conditions.get(key), toast.type, now());
  }

  function addWithReason(toast: AnyAddOptions, reason: ToastShowReason): string {
    const id = toast.id ?? `toast-policy-${++sequence}`;
    const previous = entries.get(id);
    const outcome =
      previous !== undefined &&
      previous.state !== "open" &&
      isProgressOutcome(previous.options, toast);
    if (!outcome && isSuppressed(toast)) {
      entries.delete(id);
      entries.set(id, { options: toast, state: "suppressed", storeTimeout: storeTimeoutOf(toast) });
      trim();
      return id;
    }
    show(id, toast, reason);
    return id;
  }

  function update(id: string, updates: AnyUpdateOptions) {
    const entry = entries.get(id);
    if (!entry) {
      const unknown = Object.hasOwn(updates, "timeout")
        ? { ...updates, timeout: storeTimeoutOf(updates) }
        : updates;
      baseUpdate(id, unknown);
      return;
    }
    const merged: AnyAddOptions = { ...entry.options, ...updates };
    if (entry.state === "open") {
      // Content refreshes keep the running timer; a new severity (including a
      // loading toast settling into its result) or duration starts a fresh one.
      const storeTimeout = storeTimeoutOf(merged);
      const restart =
        (updates.type !== undefined && updates.type !== entry.options.type) ||
        storeTimeout !== entry.storeTimeout;
      entry.options = merged;
      entry.storeTimeout = storeTimeout;
      baseUpdate(id, restart ? { ...updates, timeout: storeTimeout } : withoutTimeout(updates));
      return;
    }
    // A settled outcome always shows; otherwise only a condition whose
    // cool-down ended (or whose severity escalated) comes back.
    const resurface =
      isProgressOutcome(entry.options, merged) ||
      (merged.data?.conditionKey !== undefined && !isSuppressed(merged));
    if (resurface) show(id, merged, "resurface");
    else entry.options = merged;
  }

  function close(id?: string) {
    if (id === undefined) entries.clear();
    else entries.delete(id);
    base.close(id);
  }

  function promise<Value>(
    promiseValue: Promise<Value>,
    toast: ToastManagerPromiseOptions<Value, ToastPolicyData>,
  ): Promise<Value> {
    // Base UI's own promise path writes to the store directly, bypassing this
    // policy (and losing the outcome once the loading toast was dismissed).
    const id = addWithReason(
      { ...resolvePromiseOptions(toast.loading), type: "loading" },
      "promise",
    );
    return promiseValue.then(
      (value) => {
        update(id, { ...resolvePromiseOptions(toast.success, value), type: "success" });
        return value;
      },
      (error: unknown) => {
        update(id, { ...resolvePromiseOptions(toast.error, error), type: "error" });
        throw error;
      },
    );
  }

  const manager = {
    ...base,
    add: (toast: AnyAddOptions) => addWithReason(toast, "add"),
    update,
    close,
    promise,
  } as unknown as ToastManager<Data>;
  return { manager, dismiss: (id) => base.close(id) };
}
