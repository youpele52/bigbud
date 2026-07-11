import { ThreadId, TurnId, type VisibleBrowserCommand } from "@bigbud/contracts";
import { Effect, Fiber, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { VisibleBrowserControl } from "../Services/VisibleBrowserControl.ts";
import { VisibleBrowserControlLive } from "./VisibleBrowserControl.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-visible-browser");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-visible-browser-other");
const TURN_ID = TurnId.makeUnsafe("turn-visible-browser");
const NEXT_TURN_ID = TurnId.makeUnsafe("turn-visible-browser-next");
const RENDERER_ID = "renderer-visible-browser" as const;

describe("VisibleBrowserControlLive", () => {
  it("keeps a visible tab leased through navigation, interaction, and history actions", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* VisibleBrowserControl;
        const commands = yield* Queue.unbounded<VisibleBrowserCommand>();
        yield* Stream.runForEach(control.streamCommands(RENDERER_ID), (command) =>
          Queue.offer(commands, command),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const execution = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "navigate", target: "visible", url: "https://example.com" },
          })
          .pipe(Effect.forkScoped);
        const command = yield* Queue.take(commands);
        yield* control.complete({
          commandId: command.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "navigate",
            summary: "Navigated visible browser.",
            tabId: "browser:agent-tab",
            target: "visible",
          },
        });

        const navigationResult = yield* Fiber.join(execution);
        const tabId = navigationResult.tabId!;
        const runFollowUp = (action: VisibleBrowserCommand["action"]) =>
          Effect.gen(function* () {
            const followUp = yield* control
              .execute({ threadId: THREAD_ID, turnId: TURN_ID, action })
              .pipe(Effect.forkScoped);
            const followUpCommand = yield* Queue.take(commands);
            yield* control.complete({
              commandId: followUpCommand.commandId,
              rendererId: RENDERER_ID,
              result: {
                action: action.action,
                summary: `Executed ${action.action}.`,
                tabId,
                target: "visible",
              },
            });
            return yield* Fiber.join(followUp);
          });

        const clickResult = yield* runFollowUp({
          action: "click",
          target: "visible",
          tabId,
          x: 10,
          y: 20,
        });
        const backResult = yield* runFollowUp({ action: "go_back", target: "visible", tabId });
        const forwardResult = yield* runFollowUp({
          action: "go_forward",
          target: "visible",
          tabId,
        });
        const reloadResult = yield* runFollowUp({ action: "reload", target: "visible", tabId });
        const leasesBeforeRelease = yield* control.getLeases(RENDERER_ID);

        yield* control.reconcileThread({
          threadId: THREAD_ID,
          activeTurnId: null,
          isRunning: false,
        });
        const releaseCommand = yield* Queue.take(commands);
        const leasesAfterRelease = yield* control.getLeases(RENDERER_ID);

        return {
          result: navigationResult,
          clickResult,
          backResult,
          forwardResult,
          reloadResult,
          leasesBeforeRelease,
          leasesAfterRelease,
          releaseCommand,
        };
      }).pipe(Effect.provide(VisibleBrowserControlLive), Effect.scoped),
    );

    expect(result.result).toMatchObject({
      target: "visible",
      tabId: "browser:agent-tab",
      leaseId: expect.any(String),
    });
    expect(result.releaseCommand).toMatchObject({
      action: { action: "release_tab", tabId: "browser:agent-tab" },
    });
    expect(result.leasesBeforeRelease).toHaveLength(1);
    expect(result.leasesAfterRelease).toEqual([]);
    for (const actionResult of [
      result.clickResult,
      result.backResult,
      result.forwardResult,
      result.reloadResult,
    ]) {
      expect(actionResult).toMatchObject({
        leaseId: result.result.leaseId,
        tabId: "browser:agent-tab",
      });
    }
  });

  it("fails pending work when the user revokes a visible browser lease", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* VisibleBrowserControl;
        const commands = yield* Queue.unbounded<VisibleBrowserCommand>();
        yield* Stream.runForEach(control.streamCommands(RENDERER_ID), (command) =>
          Queue.offer(commands, command),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const execution = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "navigate", target: "visible", url: "https://example.com" },
          })
          .pipe(Effect.forkScoped);
        const command = yield* Queue.take(commands);
        yield* control.complete({
          commandId: command.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "navigate",
            summary: "Navigated visible browser.",
            tabId: "browser:agent-tab",
            target: "visible",
          },
        });
        const navigation = yield* Fiber.join(execution);

        const pending = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "reload", target: "visible", tabId: navigation.tabId! },
          })
          .pipe(Effect.forkScoped);
        yield* Queue.take(commands);

        yield* control.revokeLease({
          leaseId: navigation.leaseId!,
          rendererId: RENDERER_ID,
          tabId: navigation.tabId!,
        });

        const subsequent = yield* Effect.exit(
          control.execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "reload", target: "visible", tabId: navigation.tabId! },
          }),
        );
        return [yield* Effect.exit(Fiber.join(pending)), subsequent] as const;
      }).pipe(Effect.provide(VisibleBrowserControlLive), Effect.scoped),
    ).then(([pending, subsequent]) => {
      expect(pending._tag).toBe("Failure");
      expect(subsequent._tag).toBe("Failure");
    });
  });

  it("allows another thread to close a tab after explicit user instruction", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* VisibleBrowserControl;
        const commands = yield* Queue.unbounded<VisibleBrowserCommand>();
        yield* Stream.runForEach(control.streamCommands(RENDERER_ID), (command) =>
          Queue.offer(commands, command),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const navigation = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "navigate", target: "visible", url: "https://example.com" },
          })
          .pipe(Effect.forkScoped);
        const navigateCommand = yield* Queue.take(commands);
        yield* control.complete({
          commandId: navigateCommand.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "navigate",
            summary: "Navigated visible browser.",
            tabId: "browser:agent-tab",
            target: "visible",
          },
        });
        const result = yield* Fiber.join(navigation);
        yield* control.reconcileThread({
          threadId: THREAD_ID,
          activeTurnId: NEXT_TURN_ID,
          isRunning: true,
        });
        const releaseCommand = yield* Queue.take(commands);
        yield* control.complete({
          commandId: releaseCommand.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "release_tab",
            summary: "Released visible browser tab.",
            tabId: result.tabId!,
            target: "visible",
          },
        });

        const close = yield* control
          .execute({
            threadId: OTHER_THREAD_ID,
            turnId: NEXT_TURN_ID,
            action: { action: "close_tab", target: "visible", tabId: result.tabId! },
          })
          .pipe(Effect.forkScoped);
        const closeCommand = yield* Queue.take(commands);
        yield* control.complete({
          commandId: closeCommand.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "close_tab",
            summary: "Closed visible browser tab.",
            tabId: result.tabId!,
            target: "visible",
          },
        });

        return [yield* Fiber.join(close), yield* control.getLeases(RENDERER_ID)] as const;
      }).pipe(Effect.provide(VisibleBrowserControlLive), Effect.scoped),
    ).then(([closeResult, leases]) => {
      expect(closeResult).toMatchObject({ action: "close_tab", target: "visible" });
      expect(leases).toEqual([]);
    });
  });

  it("interrupts another thread that is actively using a tab before closing it", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* VisibleBrowserControl;
        const commands = yield* Queue.unbounded<VisibleBrowserCommand>();
        yield* Stream.runForEach(control.streamCommands(RENDERER_ID), (command) =>
          Queue.offer(commands, command),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const navigation = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "navigate", target: "visible", url: "https://example.com" },
          })
          .pipe(Effect.forkScoped);
        const navigateCommand = yield* Queue.take(commands);
        yield* control.complete({
          commandId: navigateCommand.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "navigate",
            summary: "Navigated visible browser.",
            tabId: "browser:agent-tab",
            target: "visible",
          },
        });
        const result = yield* Fiber.join(navigation);

        const pending = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "reload", target: "visible", tabId: result.tabId! },
          })
          .pipe(Effect.forkScoped);
        yield* Queue.take(commands);
        const close = yield* control
          .execute({
            threadId: OTHER_THREAD_ID,
            turnId: NEXT_TURN_ID,
            action: { action: "close_tab", target: "visible", tabId: result.tabId! },
          })
          .pipe(Effect.forkScoped);
        const closeCommand = yield* Queue.take(commands);
        yield* control.complete({
          commandId: closeCommand.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "close_tab",
            summary: "Closed visible browser tab.",
            tabId: result.tabId!,
            target: "visible",
          },
        });

        return [yield* Effect.exit(Fiber.join(pending)), yield* Fiber.join(close)] as const;
      }).pipe(Effect.provide(VisibleBrowserControlLive), Effect.scoped),
    ).then(([pending, close]) => {
      expect(pending._tag).toBe("Failure");
      expect(close).toMatchObject({ action: "close_tab" });
    });
  });

  it("closes a user-created tab after explicit user instruction", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* VisibleBrowserControl;
        const commands = yield* Queue.unbounded<VisibleBrowserCommand>();
        yield* Stream.runForEach(control.streamCommands(RENDERER_ID), (command) =>
          Queue.offer(commands, command),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const close = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "close_tab", target: "visible", tabId: "browser:user-tab" },
          })
          .pipe(Effect.forkScoped);
        const command = yield* Queue.take(commands);
        yield* control.complete({
          commandId: command.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "close_tab",
            summary: "Closed visible browser tab.",
            tabId: "browser:user-tab",
            target: "visible",
          },
        });
        return yield* Fiber.join(close);
      }).pipe(Effect.provide(VisibleBrowserControlLive), Effect.scoped),
    );

    expect(result).toMatchObject({ action: "close_tab", tabId: "browser:user-tab" });
  });

  it("releases an unbound lease when the renderer reaches its tab limit", async () => {
    const leases = await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* VisibleBrowserControl;
        const commands = yield* Queue.unbounded<VisibleBrowserCommand>();
        yield* Stream.runForEach(control.streamCommands(RENDERER_ID), (command) =>
          Queue.offer(commands, command),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const execution = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "navigate", target: "visible", url: "https://example.com" },
          })
          .pipe(Effect.forkScoped);
        const command = yield* Queue.take(commands);
        yield* control.complete({
          commandId: command.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "navigate",
            summary: "Browser tab limit reached (5).",
            target: "visible",
            selectionReason: "tab_limit_reached",
            tabLimit: { limit: 5, tabs: [] },
          },
        });
        yield* Fiber.join(execution);
        return yield* control.getLeases(RENDERER_ID);
      }).pipe(Effect.provide(VisibleBrowserControlLive), Effect.scoped),
    );

    expect(leases).toEqual([]);
  });
});
