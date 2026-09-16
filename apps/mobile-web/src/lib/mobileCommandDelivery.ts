import type { ClientOrchestrationCommand } from "@bigbud/contracts";

import {
  MOBILE_COMMAND_DEADLINE_MS,
  beginMobileCommandDelivery,
  beginMobileCommandReconciliation,
  createMobileCommandDeliveryState,
  markMobileCommandUncertain,
  settleMobileCommandAccepted,
  settleMobileCommandOutcome,
  settleMobileCommandRejected,
  type MobileCommandDeliveryOperation,
  type MobileCommandDeliveryState,
  type MobileCommandOutcome,
} from "./mobileCommandDelivery.logic";

export interface MobileCommandDeliveryController {
  readonly getState: () => MobileCommandDeliveryState;
  readonly submit: (input: {
    readonly command: ClientOrchestrationCommand;
    readonly submittedRevision: number;
    readonly dispatch: (command: ClientOrchestrationCommand) => Promise<unknown>;
  }) => Promise<MobileCommandDeliveryState>;
  readonly reconcile: (
    readOutcome: () => Promise<MobileCommandOutcome>,
  ) => Promise<MobileCommandDeliveryState>;
  readonly retrySameOperation: (
    dispatch: (command: ClientOrchestrationCommand) => Promise<unknown>,
  ) => Promise<MobileCommandDeliveryState>;
  readonly dispose: () => void;
}

interface TimerApi {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delay: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
}

interface MobileCommandDeliveryOptions {
  readonly initialState?: MobileCommandDeliveryState;
  readonly deadlineMs?: number;
  readonly timer?: Partial<TimerApi>;
  readonly onStateChange?: (state: MobileCommandDeliveryState) => void;
}

function defaultTimer(): TimerApi {
  return {
    now: Date.now,
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
}

function operationFromCommand(
  command: ClientOrchestrationCommand,
  submittedRevision: number,
  deadlineMs: number,
  now: number,
): MobileCommandDeliveryOperation {
  const immutableCommand =
    typeof structuredClone === "function"
      ? structuredClone(command)
      : (JSON.parse(JSON.stringify(command)) as ClientOrchestrationCommand);
  return {
    command: immutableCommand,
    submittedRevision,
    submittedAt: "createdAt" in command ? command.createdAt : new Date().toISOString(),
    deadlineAt: now + deadlineMs,
  };
}

export function createMobileCommandDeliveryController(
  options: MobileCommandDeliveryOptions = {},
): MobileCommandDeliveryController {
  const timer = { ...defaultTimer(), ...options.timer };
  const deadlineMs = options.deadlineMs ?? MOBILE_COMMAND_DEADLINE_MS;
  let state = options.initialState ?? createMobileCommandDeliveryState(null);
  let locked = false;
  let disposed = false;
  let cancelActive: (() => void) | null = null;

  const publish = (next: MobileCommandDeliveryState) => {
    state = next;
    options.onStateChange?.(next);
  };

  const submitOperation = async (
    operation: MobileCommandDeliveryOperation,
    dispatch: (command: ClientOrchestrationCommand) => Promise<unknown>,
  ): Promise<MobileCommandDeliveryState> => {
    const started = beginMobileCommandDelivery(state, operation);
    if (!started || disposed) return state;
    // This lock is deliberately set before dispatch is called. Click, Enter,
    // and touch handlers can therefore share one synchronous admission point.
    locked = true;
    publish(started);
    let timerId: unknown;
    let finished = false;

    return await new Promise<MobileCommandDeliveryState>((resolve) => {
      const finish = (
        next: MobileCommandDeliveryState,
        settle: (value: MobileCommandDeliveryState) => void,
      ) => {
        if (finished) return;
        finished = true;
        if (timerId !== undefined) timer.clearTimeout(timerId);
        if (cancelActive !== null) cancelActive = null;
        locked = false;
        publish(next);
        settle(next);
      };
      timerId = timer.setTimeout(
        () => {
          finish(markMobileCommandUncertain(state), resolve);
        },
        Math.max(0, operation.deadlineAt - timer.now()),
      );
      cancelActive = () => finish(markMobileCommandUncertain(state), resolve);
      let dispatched: Promise<unknown>;
      try {
        dispatched = dispatch(operation.command);
      } catch {
        finish(markMobileCommandUncertain(state), resolve);
        return;
      }
      void Promise.resolve(dispatched).then(
        () => finish(settleMobileCommandAccepted(state), resolve),
        () => finish(markMobileCommandUncertain(state), resolve),
      );
    });
  };

  const submit: MobileCommandDeliveryController["submit"] = async ({
    command,
    submittedRevision,
    dispatch,
  }) => {
    if (locked || disposed) return state;
    const operation = operationFromCommand(command, submittedRevision, deadlineMs, timer.now());
    return submitOperation(operation, dispatch);
  };

  const reconcile: MobileCommandDeliveryController["reconcile"] = async (readOutcome) => {
    if (locked || disposed) return state;
    const reconciling = beginMobileCommandReconciliation(state);
    if (!reconciling) return state;
    locked = true;
    publish(reconciling);
    let cancelled = false;
    cancelActive = () => {
      cancelled = true;
      locked = false;
      publish(markMobileCommandUncertain(state));
    };
    try {
      const outcome = await readOutcome();
      if (cancelled || disposed) return state;
      const settled = settleMobileCommandOutcome(state, outcome);
      locked = false;
      cancelActive = null;
      publish(settled);
      return settled;
    } catch {
      if (cancelled || disposed) return state;
      locked = false;
      cancelActive = null;
      const uncertain = markMobileCommandUncertain(state);
      publish(uncertain);
      return uncertain;
    }
  };

  const retrySameOperation: MobileCommandDeliveryController["retrySameOperation"] = async (
    dispatch,
  ) => {
    if (locked || disposed || state.status !== "uncertain" || !state.operation) return state;
    const operation = {
      ...state.operation,
      deadlineAt: timer.now() + deadlineMs,
    };
    const retryState = { status: "pending" as const, operation };
    locked = true;
    publish(retryState);
    let timerId: unknown;
    let finished = false;
    return await new Promise<MobileCommandDeliveryState>((resolve) => {
      const finish = (next: MobileCommandDeliveryState) => {
        if (finished) return;
        finished = true;
        if (timerId !== undefined) timer.clearTimeout(timerId);
        locked = false;
        cancelActive = null;
        publish(next);
        resolve(next);
      };
      timerId = timer.setTimeout(
        () => finish(markMobileCommandUncertain(retryState)),
        Math.max(0, operation.deadlineAt - timer.now()),
      );
      cancelActive = () => finish(markMobileCommandUncertain(retryState));
      let dispatched: Promise<unknown>;
      try {
        dispatched = dispatch(operation.command);
      } catch {
        finish(markMobileCommandUncertain(retryState));
        return;
      }
      void Promise.resolve(dispatched).then(
        () => finish(settleMobileCommandAccepted(retryState)),
        () => finish(markMobileCommandUncertain(retryState)),
      );
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelActive?.();
    cancelActive = null;
    locked = false;
  };

  return {
    getState: () => state,
    reconcile,
    retrySameOperation,
    submit,
    dispose,
  };
}

export {
  createMobileCommandDeliveryState,
  settleMobileCommandAccepted,
  settleMobileCommandRejected,
};
