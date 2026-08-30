import { ProjectId, ThreadId, type GetThreadOwnershipResult } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  classifyStartupCandidate,
  resolveRootRestorationCandidates,
  resolveStartupRouteIntent,
  restoreStartupContext,
  type StartupCandidateValidation,
} from "./-__root.startup-restoration";
import { useStore } from "../stores/main";

const serverThread = ThreadId.makeUnsafe("server-thread");
const persistedThread = ThreadId.makeUnsafe("persisted-thread");
const serverProject = ProjectId.makeUnsafe("server-project");

function makeInput(
  overrides: Partial<Parameters<typeof restoreStartupContext>[0]> = {},
): Parameters<typeof restoreStartupContext>[0] {
  return {
    pathname: "/",
    bootstrapProjectId: null,
    bootstrapThreadId: null,
    persistedThreadId: null,
    bootstrap: vi.fn(async () => undefined),
    validate: vi.fn(async () => "valid" as StartupCandidateValidation),
    clearPersistedThread: vi.fn(),
    isCurrent: () => true,
    navigateToThread: vi.fn(async () => undefined),
    startFreshChat: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("startup context restoration", () => {
  it("gives an explicit thread URL precedence over root restoration candidates", async () => {
    const input = makeInput({
      pathname: `/${serverThread}`,
      bootstrapProjectId: serverProject,
      bootstrapThreadId: persistedThread,
      persistedThreadId: persistedThread,
    });

    await expect(restoreStartupContext(input)).resolves.toBe("explicit-thread");

    expect(input.bootstrap).toHaveBeenCalledWith(serverThread);
    expect(input.validate).not.toHaveBeenCalled();
    expect(input.navigateToThread).not.toHaveBeenCalled();
    expect(input.startFreshChat).not.toHaveBeenCalled();
  });

  it("keeps an explicit non-thread route in place", async () => {
    const input = makeInput({
      pathname: "/settings/providers",
      bootstrapProjectId: serverProject,
      bootstrapThreadId: serverThread,
      persistedThreadId: persistedThread,
    });

    await expect(restoreStartupContext(input)).resolves.toBe("non-thread");

    expect(input.bootstrap).toHaveBeenCalledWith(null);
    expect(input.navigateToThread).not.toHaveBeenCalled();
    expect(input.startFreshChat).not.toHaveBeenCalled();
  });

  it("treats Plugins as an explicit non-thread route", () => {
    expect(resolveStartupRouteIntent("/plugins")).toEqual({ kind: "non-thread" });
    expect(resolveStartupRouteIntent("/plugins/installed")).toEqual({ kind: "non-thread" });
  });

  it("orders valid server intent before the persisted candidate", () => {
    expect(
      resolveRootRestorationCandidates({
        bootstrapProjectId: serverProject,
        bootstrapThreadId: serverThread,
        persistedThreadId: persistedThread,
      }),
    ).toEqual([
      expect.objectContaining({ source: "server", threadId: serverThread }),
      expect.objectContaining({ source: "persisted", threadId: persistedThread }),
    ]);
  });

  it("restores a valid persisted candidate after bounded bootstrap", async () => {
    const calls: string[] = [];
    const input = makeInput({
      persistedThreadId: persistedThread,
      bootstrap: vi.fn(async () => calls.push("bootstrap")),
      validate: vi.fn(async (): Promise<StartupCandidateValidation> => {
        calls.push("validate");
        return "valid";
      }),
      navigateToThread: vi.fn(async () => calls.push("navigate")),
    });

    await expect(restoreStartupContext(input)).resolves.toBe("restored");

    expect(calls).toEqual(["bootstrap", "validate", "navigate"]);
    expect(input.navigateToThread).toHaveBeenCalledWith(persistedThread);
    expect(input.clearPersistedThread).not.toHaveBeenCalled();
  });

  it("clears a stale persisted candidate and starts one fresh fallback", async () => {
    const input = makeInput({
      persistedThreadId: persistedThread,
      validate: vi.fn(async (): Promise<StartupCandidateValidation> => "stale"),
    });

    await expect(restoreStartupContext(input)).resolves.toBe("fresh");

    expect(input.clearPersistedThread).toHaveBeenCalledTimes(1);
    expect(input.startFreshChat).toHaveBeenCalledTimes(1);
    expect(input.navigateToThread).not.toHaveBeenCalled();
  });

  it("retains a transient candidate without creating a competing draft", async () => {
    const input = makeInput({
      persistedThreadId: persistedThread,
      validate: vi.fn(async (): Promise<StartupCandidateValidation> => "unavailable"),
    });

    await expect(restoreStartupContext(input)).resolves.toBe("unavailable");

    expect(input.clearPersistedThread).not.toHaveBeenCalled();
    expect(input.startFreshChat).not.toHaveBeenCalled();
    expect(input.navigateToThread).not.toHaveBeenCalled();
  });

  it("cancels navigation when the launch pathname changes during validation", async () => {
    let resolveValidation!: (value: StartupCandidateValidation) => void;
    let currentPathname = "/";
    const input = makeInput({
      persistedThreadId: persistedThread,
      isCurrent: () => currentPathname === "/",
      validate: vi.fn(
        () =>
          new Promise<StartupCandidateValidation>((resolve) => {
            resolveValidation = resolve;
          }),
      ),
    });

    const restoration = restoreStartupContext(input);
    await vi.waitFor(() => expect(input.validate).toHaveBeenCalledTimes(1));
    currentPathname = "/settings";
    resolveValidation("valid");

    await expect(restoration).resolves.toBe("cancelled");
    expect(input.navigateToThread).not.toHaveBeenCalled();
    expect(input.startFreshChat).not.toHaveBeenCalled();
  });

  it("cancels fresh fallback when the launch pathname changes during bootstrap", async () => {
    let resolveBootstrap!: () => void;
    let currentPathname = "/";
    const input = makeInput({
      isCurrent: () => currentPathname === "/",
      bootstrap: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveBootstrap = resolve;
          }),
      ),
    });

    const restoration = restoreStartupContext(input);
    await vi.waitFor(() => expect(input.bootstrap).toHaveBeenCalledTimes(1));
    currentPathname = "/plugins";
    resolveBootstrap();

    await expect(restoration).resolves.toBe("cancelled");
    expect(input.startFreshChat).not.toHaveBeenCalled();
  });

  it("lets a newer overlapping restoration invalidate the older run", async () => {
    let currentRun = 1;
    let resolveFirst!: (value: StartupCandidateValidation) => void;
    const first = makeInput({
      persistedThreadId: persistedThread,
      isCurrent: () => currentRun === 1,
      validate: vi.fn(
        () =>
          new Promise<StartupCandidateValidation>((resolve) => {
            resolveFirst = resolve;
          }),
      ),
    });
    const firstRestoration = restoreStartupContext(first);
    await vi.waitFor(() => expect(first.validate).toHaveBeenCalledTimes(1));

    currentRun = 2;
    const second = makeInput({
      persistedThreadId: persistedThread,
      isCurrent: () => currentRun === 2,
    });
    await expect(restoreStartupContext(second)).resolves.toBe("restored");
    resolveFirst("valid");

    await expect(firstRestoration).resolves.toBe("cancelled");
    expect(first.navigateToThread).not.toHaveBeenCalled();
    expect(second.navigateToThread).toHaveBeenCalledTimes(1);
  });

  it("falls through stale server intent to a valid persisted candidate", async () => {
    const input = makeInput({
      bootstrapProjectId: serverProject,
      bootstrapThreadId: serverThread,
      persistedThreadId: persistedThread,
      validate: vi.fn(async (candidate) => (candidate.source === "server" ? "stale" : "valid")),
    });

    await expect(restoreStartupContext(input)).resolves.toBe("restored");

    expect(input.bootstrap).toHaveBeenNthCalledWith(1, serverThread);
    expect(input.bootstrap).toHaveBeenNthCalledWith(2, persistedThread);
    expect(input.navigateToThread).toHaveBeenCalledWith(persistedThread);
  });

  it("treats malformed encoded paths as non-thread routes", () => {
    expect(resolveStartupRouteIntent("/%E0%A4%A")).toEqual({ kind: "non-thread" });
  });

  it.each(["absent", "archived", "deleted", "deleting"] as const)(
    "classifies %s canonical ownership as stale",
    (status) => {
      const ownership = {
        threadId: persistedThread,
        status,
      } as GetThreadOwnershipResult;
      const candidate = resolveRootRestorationCandidates({
        bootstrapProjectId: null,
        bootstrapThreadId: null,
        persistedThreadId: persistedThread,
      })[0]!;

      expect(classifyStartupCandidate({ candidate, ownership })).toBe("stale");
    },
  );

  it("accepts an active, hydrated, renderable standard thread", () => {
    useStore.setState({
      projects: [{ id: serverProject, deletingAt: null } as never],
      threads: [
        {
          id: persistedThread,
          projectId: serverProject,
          purpose: "standard",
          archivedAt: null,
          deletingAt: null,
        } as never,
      ],
      threadHydrationById: { [persistedThread]: { status: "complete" } },
    });
    const candidate = resolveRootRestorationCandidates({
      bootstrapProjectId: null,
      bootstrapThreadId: null,
      persistedThreadId: persistedThread,
    })[0]!;

    expect(
      classifyStartupCandidate({
        candidate,
        ownership: {
          threadId: persistedThread,
          projectId: serverProject,
          status: "active",
          serverEpoch: "server-1",
          canonicalRevision: 1,
        },
      }),
    ).toBe("valid");
  });

  it("treats failed detail hydration with active ownership as unavailable", () => {
    useStore.setState({
      projects: [{ id: serverProject, deletingAt: null } as never],
      threads: [
        {
          id: persistedThread,
          projectId: serverProject,
          purpose: "standard",
          archivedAt: null,
          deletingAt: null,
        } as never,
      ],
      threadHydrationById: {
        [persistedThread]: { status: "failed", error: "offline", retry: { kind: "initial" } },
      },
    });
    const candidate = resolveRootRestorationCandidates({
      bootstrapProjectId: null,
      bootstrapThreadId: null,
      persistedThreadId: persistedThread,
    })[0]!;

    expect(
      classifyStartupCandidate({
        candidate,
        ownership: {
          threadId: persistedThread,
          projectId: serverProject,
          status: "active",
          serverEpoch: "server-1",
          canonicalRevision: 1,
        },
      }),
    ).toBe("unavailable");
  });
});
