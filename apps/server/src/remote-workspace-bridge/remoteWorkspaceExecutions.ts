import { CommandCancellationUnconfirmedError } from "../utils/commandCancellation.ts";

const owners = new Map<string, RemoteWorkspaceExecutions>();
const scopes = new Map<string, RemoteWorkspaceExecutions>();
const MAX_ACTIVE = 64;
const MAX_CANCELLED = 4096;

/** Credential-scoped ownership, independent of native queues and HTTP-client lifetimes. */
export class RemoteWorkspaceExecutions {
  private readonly active = new Set<{
    controller: AbortController;
    done: Promise<unknown>;
    root: string;
  }>();
  private readonly cancelledRoots = new Set<string>();
  private blocked = false;
  private closed = false;
  private uncertain: unknown;
  private generation = 0;

  captureGeneration = () => this.generation;
  assertGeneration = (generation: number) => {
    if (generation !== this.generation) throw new Error("Remote turn was stopped before dispatch.");
  };

  busyCount = () => this.active.size + (this.uncertain ? 1 : 0);

  resume = () => {
    if (this.closed || this.busyCount() || this.cancelledRoots.size >= MAX_CANCELLED)
      throw new Error(
        "Remote commands have not drained; reconnect only after existing work is confirmed stopped.",
      );
    this.blocked = false;
  };

  run<T>(
    id: string,
    run: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    // MCP uses one durable invocation root and a step suffix for multi-command edit/patch tools.
    const root = id.replace(/:\d+$/, "");
    if (this.closed || this.blocked || this.uncertain || this.cancelledRoots.has(root))
      return Promise.reject(
        new Error("Remote workspace tools were stopped; no command was dispatched."),
      );
    if (this.active.size >= MAX_ACTIVE || this.cancelledRoots.size >= MAX_CANCELLED)
      return Promise.reject(new Error("Remote workspace execution capacity exceeded."));
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    const markCancelled = () => this.cancelledRoots.add(root);
    signal.addEventListener("abort", markCancelled, { once: true });
    if (signal.aborted) markCancelled();
    const entry = { controller, root, done: Promise.resolve() as Promise<unknown> };
    const result = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run(signal);
      })
      .catch((cause: unknown) => {
        if (cause instanceof CommandCancellationUnconfirmedError) {
          this.uncertain = cause;
          this.blocked = true;
        }
        throw cause;
      })
      .finally(() => {
        signal.removeEventListener("abort", markCancelled);
        this.active.delete(entry);
      });
    entry.done = result;
    this.active.add(entry);
    return result;
  }

  cancelActive = async () => {
    // Fence first, before awaiting anything: queued HTTP requests cannot start after Stop.
    this.blocked = true;
    this.generation++;
    const active = [...this.active];
    for (const entry of active) {
      this.cancelledRoots.add(entry.root);
      entry.controller.abort();
    }
    await Promise.allSettled(active.map((entry) => entry.done));
    if (this.uncertain) throw this.uncertain;
  };

  close = async () => {
    this.closed = true;
    await this.cancelActive();
  };
}

export function registerRemoteWorkspaceExecutions(token: string, scope: string) {
  if (owners.has(token) || scopes.has(scope))
    throw new Error(
      "Remote workspace execution owner is active or cancellation remains unconfirmed; no replacement tools were connected.",
    );
  const owner = new RemoteWorkspaceExecutions();
  owners.set(token, owner);
  scopes.set(scope, owner);
  return {
    owner,
    close: async () => {
      try {
        await owner.close();
      } finally {
        if (owners.get(token) === owner) owners.delete(token);
        // Credential rotation/reconnect must not erase unresolved physical remote work.
        if (!owner.busyCount() && scopes.get(scope) === owner) scopes.delete(scope);
      }
    },
  };
}

export function findRemoteWorkspaceExecutions(token: string) {
  return owners.get(token);
}
