import {
  WORKSPACE_RECOVERY_RETRY_DELAYS_MS,
  WORKSPACE_RECOVERY_RETRY_SPACING_MS,
  WORKSPACE_RECOVERY_WINDOW_MS,
} from "../constants/workspaceRecovery";
import { isRetryableWorkspaceError } from "./workspaceRequestRecovery.errors";

interface RecoveryCallbacks<T> {
  readonly onRecovering?: () => void;
  readonly onSuccess?: (value: T) => void;
  readonly onError?: (error: unknown, pending: boolean) => void;
  readonly onSettled?: () => void;
}

interface RecoveryRequest {
  readonly key: string;
  readonly operation: () => Promise<unknown>;
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly callbacks: RecoveryCallbacks<unknown>;
  deadline?: ReturnType<typeof setTimeout> | undefined;
  retry?: ReturnType<typeof setTimeout> | undefined;
  error?: unknown;
  failures: number;
  expired: boolean;
  busy: boolean;
}

/** Retries reads through the existing transport, never reconnecting it independently. */
export class WorkspaceRequestRecovery {
  private readonly requests = new Map<string, RecoveryRequest>();
  private readonly queue: RecoveryRequest[] = [];
  private readonly running = new Set<RecoveryRequest>();
  private disposed = false;
  private retryCooldown: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly remote: boolean) {}

  resume(): void {
    this.disposed = false;
  }

  isActive(key: string): boolean {
    return this.requests.has(key);
  }

  execute<T>(
    key: string,
    operation: () => Promise<T>,
    callbacks: RecoveryCallbacks<T> = {},
  ): Promise<T> {
    const existing = this.requests.get(key);
    if (existing) return existing.promise as Promise<T>;
    if (this.disposed) return Promise.reject(new DOMException("Cancelled", "AbortError"));
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const request: RecoveryRequest = {
      key,
      operation,
      promise,
      resolve,
      reject,
      callbacks: {
        ...callbacks,
        onSuccess: (value) => callbacks.onSuccess?.(value as T),
      },
      failures: 0,
      expired: false,
      busy: false,
    };
    this.requests.set(key, request);
    if (this.remote) this.armDeadline(request);
    this.enqueue(request);
    return promise as Promise<T>;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retryCooldown);
    this.retryCooldown = undefined;
    for (const request of this.requests.values()) {
      this.clearTimers(request);
      request.reject(new DOMException("Cancelled", "AbortError"));
    }
    this.requests.clear();
    this.queue.length = 0;
    this.running.clear();
  }

  private isCurrent(request: RecoveryRequest): boolean {
    return !this.disposed && this.requests.get(request.key) === request;
  }

  private clearTimers(request: RecoveryRequest): void {
    clearTimeout(request.deadline);
    clearTimeout(request.retry);
  }

  private armDeadline(request: RecoveryRequest): void {
    clearTimeout(request.deadline);
    request.deadline = setTimeout(() => {
      if (!this.isCurrent(request)) return;
      request.expired = true;
      request.error ??= new Error("The remote workspace did not respond within 30 seconds.");
      clearTimeout(request.retry);
      request.callbacks.onError?.(request.error, request.busy);
      request.reject(request.error);
      // A hung RPC retains its key/slot until it settles, preventing overlapping retries.
      if (!request.busy) this.finish(request);
    }, WORKSPACE_RECOVERY_WINDOW_MS);
  }

  private enqueue(request: RecoveryRequest): void {
    if (!this.isCurrent(request) || request.expired) return;
    this.queue.push(request);
    this.drain();
  }

  private drain(): void {
    while (this.queue.length > 0 && (!this.remote || this.running.size === 0)) {
      const index = this.queue.findIndex(
        (request) => !this.remote || request.failures === 0 || this.retryCooldown === undefined,
      );
      if (index === -1) return;
      const request = this.queue.splice(index, 1)[0]!;
      if (!this.isCurrent(request) || request.expired) continue;
      if (this.remote && request.failures > 0) {
        this.retryCooldown = setTimeout(() => {
          this.retryCooldown = undefined;
          this.drain();
        }, WORKSPACE_RECOVERY_RETRY_SPACING_MS);
      }
      request.busy = true;
      this.running.add(request);
      void this.attempt(request);
    }
  }

  private async attempt(request: RecoveryRequest): Promise<void> {
    try {
      const value = await request.operation();
      if (!this.isCurrent(request)) return;
      request.callbacks.onSuccess?.(value);
      request.resolve(value);
      this.finish(request);
    } catch (error) {
      if (!this.isCurrent(request)) return;
      request.error = error;
      if (request.expired || !this.remote || !isRetryableWorkspaceError(error)) {
        request.callbacks.onError?.(error, false);
        request.reject(error);
        this.finish(request);
      } else {
        if (request.failures === 0) {
          this.armDeadline(request);
          request.callbacks.onRecovering?.();
        }
        const delays = WORKSPACE_RECOVERY_RETRY_DELAYS_MS;
        const delay = delays[Math.min(request.failures, delays.length - 1)]!;
        request.failures += 1;
        request.retry = setTimeout(() => this.enqueue(request), delay);
      }
    } finally {
      request.busy = false;
      this.running.delete(request);
      this.drain();
    }
  }

  private finish(request: RecoveryRequest): void {
    this.clearTimers(request);
    this.requests.delete(request.key);
    if (this.requests.size === 0) {
      clearTimeout(this.retryCooldown);
      this.retryCooldown = undefined;
    }
    const queued = this.queue.indexOf(request);
    if (queued !== -1) this.queue.splice(queued, 1);
    request.callbacks.onSettled?.();
  }
}
