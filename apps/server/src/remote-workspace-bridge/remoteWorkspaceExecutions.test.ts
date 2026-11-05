import { expect, it, vi } from "vitest";
import {
  RemoteWorkspaceExecutions,
  registerRemoteWorkspaceExecutions,
} from "./remoteWorkspaceExecutions.ts";
import {
  CommandCancellationUnconfirmedError,
  withCommandCancellation,
} from "../utils/commandCancellation.ts";

it("fences late requests, joins every active command, and leaves other sessions alone", async () => {
  const owner = new RemoteWorkspaceExecutions();
  const other = new RemoteWorkspaceExecutions();
  let cancel!: () => void;
  const confirmed = new Promise<void>((resolve) => {
    cancel = resolve;
  });
  const entered = vi.fn();
  const running = owner.run("edit:0", (signal) =>
    withCommandCancellation(
      signal,
      () => {
        entered();
        return new Promise<void>(() => {});
      },
      () => confirmed,
    ),
  );
  const rejected = expect(running).rejects.toThrow("cancelled");
  await expect.poll(() => entered.mock.calls.length).toBe(1);
  let stopped = false;
  const stopping = owner.cancelActive().then(() => {
    stopped = true;
  });
  await expect(owner.run("late:0", async () => "bad")).rejects.toThrow("stopped");
  await expect(other.run("other:0", async () => "unaffected")).resolves.toBe("unaffected");
  expect(stopped).toBe(false);
  expect(() => owner.resume()).toThrow("not drained");
  cancel();
  await rejected;
  await stopping;
  expect(owner.busyCount()).toBe(0);
  owner.resume();
  // Stopping the first step of an edit must prevent its delayed write step, even next turn.
  await expect(owner.run("edit:1", async () => "bad")).rejects.toThrow("stopped");
  await expect(owner.run("new-turn:0", async () => "ok")).resolves.toBe("ok");
});

it("Stop before physical dispatch never launches the command", async () => {
  const owner = new RemoteWorkspaceExecutions();
  const dispatch = vi.fn(async () => "bad");
  const running = owner.run("queued:0", dispatch);
  const rejected = expect(running).rejects.toThrow();
  await owner.cancelActive();
  await rejected;
  expect(dispatch).not.toHaveBeenCalled();
});

it("retains an uncertain cancellation as busy and rejects restart rather than claiming success", async () => {
  const owner = new RemoteWorkspaceExecutions();
  const entered = vi.fn();
  const running = owner.run("uncertain:0", (signal) =>
    withCommandCancellation(
      signal,
      () => {
        entered();
        return new Promise<void>(() => {});
      },
      async () => {
        throw new Error("offline");
      },
    ),
  );
  const rejected = expect(running).rejects.toBeInstanceOf(CommandCancellationUnconfirmedError);
  await expect.poll(() => entered.mock.calls.length).toBe(1);
  await expect(owner.cancelActive()).rejects.toThrow("could not be confirmed");
  await rejected;
  expect(owner.busyCount()).toBe(1);
  expect(() => owner.resume()).toThrow("not drained");
  await expect(owner.run("new:0", async () => "bad")).rejects.toThrow("stopped");
});

it("HTTP disconnect aborts the physical command and prevents a subsequent step", async () => {
  const owner = new RemoteWorkspaceExecutions();
  const http = new AbortController();
  const cancel = vi.fn(async () => {});
  const entered = vi.fn();
  const running = owner.run(
    "write:0",
    (signal) =>
      withCommandCancellation(
        signal,
        () => {
          entered();
          return new Promise<void>(() => {});
        },
        cancel,
      ),
    http.signal,
  );
  const rejected = expect(running).rejects.toThrow("cancelled");
  await expect.poll(() => entered.mock.calls.length).toBe(1);
  http.abort();
  await rejected;
  expect(cancel).toHaveBeenCalledTimes(1);
  await expect(owner.run("write:1", async () => "bad")).rejects.toThrow("stopped");
});

it("rotating credentials cannot discard an unconfirmed command owner", async () => {
  const scope = crypto.randomUUID();
  const registered = registerRemoteWorkspaceExecutions("old-token", scope);
  const entered = vi.fn();
  const running = registered.owner.run("uncertain:0", (signal) =>
    withCommandCancellation(
      signal,
      () => {
        entered();
        return new Promise<void>(() => {});
      },
      async () => {
        throw new Error("offline");
      },
    ),
  );
  const observed = running.catch((cause: unknown) => cause);
  await expect.poll(() => entered.mock.calls.length).toBe(1);
  await expect(registered.close()).rejects.toThrow("could not be confirmed");
  await observed;
  expect(() => registerRemoteWorkspaceExecutions("new-token", scope)).toThrow(
    "cancellation remains unconfirmed",
  );
});
