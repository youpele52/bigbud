import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { titleFixture } from "./ProviderCommandReactorSessionOps.title.fixture.ts";
import { maybeGenerateThreadTitleForFirstTurn } from "./ProviderCommandReactorSessionOps.title.ts";
import { MetadataCoordinatorError } from "./ThreadMetadataGeneration.coordinator.types.ts";
import {
  isThreadTitleLocked,
  resetThreadTitleLockForTests,
} from "../../orchestration-tools/ThreadTitleLock.ts";

// Stage execution, ownership races, budgets, and uncertain settlement now belong to
// durable coordinator/canonical tests. These tests guard the production queue boundary.
describe("automatic title queue boundary", () => {
  afterEach(resetThreadTitleLockForTests);

  it("does not acquire manual ownership or create ordinary chat turns", async () => {
    const f = titleFixture();
    const title = vi.fn(
      (_request: import("./ThreadMetadataGeneration.requests.ts").MetadataTitleRequest) =>
        Effect.void,
    );
    const services = {
      ...f.services,
      metadataGeneration: { title, summary: () => Effect.void, start: () => Effect.void },
    };
    await Effect.runPromise(maybeGenerateThreadTitleForFirstTurn(services)(f.input()));
    expect(title).toHaveBeenCalledTimes(1);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(isThreadTitleLocked(f.thread.id)).toBe(false);
  });

  it("never invents a new retry identity from a legacy retry boolean", async () => {
    const f = titleFixture();
    const title = vi.fn(
      (_request: import("./ThreadMetadataGeneration.requests.ts").MetadataTitleRequest) =>
        Effect.void,
    );
    const services = {
      ...f.services,
      metadataGeneration: { title, summary: () => Effect.void, start: () => Effect.void },
    };
    for (let index = 0; index < 2; index++) {
      await Effect.runPromise(
        maybeGenerateThreadTitleForFirstTurn(services)({ ...f.input(), retry: true }),
      );
    }
    expect(title.mock.calls.map(([request]) => request)).toEqual([
      { threadId: f.thread.id, messageText: f.input().messageText },
      { threadId: f.thread.id, messageText: f.input().messageText },
    ]);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("keeps admission failure from invoking any alternative paid path", async () => {
    const f = titleFixture();
    const title = () =>
      Effect.fail(new MetadataCoordinatorError({ detail: "Admission unavailable" }));
    const services = {
      ...f.services,
      metadataGeneration: { title, summary: () => Effect.void, start: () => Effect.void },
    };
    await Effect.runPromise(maybeGenerateThreadTitleForFirstTurn(services)(f.input()));
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.thread.title).toBe("New thread");
  });

  it("propagates interruption instead of turning cancellation into a warning or fallback", async () => {
    const f = titleFixture();
    const title = () => Effect.interrupt;
    const services = {
      ...f.services,
      metadataGeneration: { title, summary: () => Effect.void, start: () => Effect.void },
    };
    const exit = await Effect.runPromiseExit(
      maybeGenerateThreadTitleForFirstTurn(services)(f.input()),
    );
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});
