import { inspect } from "node:util";
import { Cause, Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { ProviderAdapterProcessError, ProviderAdapterRequestError } from "../../Errors.ts";
import {
  getMuseFailureEvidence,
  mapMuseRequestError,
  museProcessError,
  museRequestError,
} from "./Client.errors.ts";
import { makeMuseTestHost, startInput, threadId } from "./Adapter.failures.test.helpers.ts";

const credential = "synthetic-native-credential-SECRET";
const token = "synthetic-token-SECRET";
const account = "synthetic-account@example.test";
const payload = "PRIVATE_NATIVE_PAYLOAD_" + "z".repeat(50_000);

function nativeFailure() {
  const nested = Object.assign(
    new Error(`private nested evidence ${credential} ${account} ${payload}`),
    { token },
  );
  return Object.assign(
    new Error(
      `Useful native failure\nBearer ${credential} token=${token} ${account}\n${"safe context ".repeat(100)}${payload}`,
      { cause: nested },
    ),
    {
      kind: "commandRejected",
      data: { reason: "session_id_conflict", payload, account },
    },
  );
}

/** Match the reactor warning and session.lastError persistence presentation patterns. */
function assertSafePresentations(error: ProviderAdapterRequestError | ProviderAdapterProcessError) {
  const effectCause = Cause.fail(error);
  const pretty = Cause.pretty(effectCause);
  const presentations = [
    pretty,
    JSON.stringify({ eventType: "thread.session-stop-requested", cause: pretty }),
    JSON.stringify({ session: { lastError: pretty } }),
    JSON.stringify(effectCause),
    JSON.stringify(error),
    String(error),
    inspect(error, { depth: null }),
  ];
  expect(error.cause).toBeUndefined();
  expect(Object.hasOwn(error, "cause")).toBe(false);
  expect(error.detail.length).toBeLessThanOrEqual(300);
  expect(error.detail).not.toContain("\n");
  for (const rendered of presentations) {
    expect(rendered).not.toContain(credential);
    expect(rendered).not.toContain(token);
    expect(rendered).not.toContain(account);
    expect(rendered).not.toContain("PRIVATE_NATIVE_PAYLOAD_");
    expect(rendered).not.toContain("z".repeat(500));
    expect(rendered).not.toContain("\nBearer");
    expect(rendered).not.toContain("[cause]");
    expect(rendered.length).toBeLessThan(15_000);
    expect(rendered).toContain("Useful native failure");
  }
  expect(pretty).toContain("[redacted]");
}

describe("Muse private evidence and public error presentation", () => {
  it.each(["native-error", "plain-object", "combined-evidence"])(
    "does not expose %s evidence through installed Effect, JSON or string renderers",
    (shape) => {
      const raw = nativeFailure();
      const evidence =
        shape === "native-error"
          ? raw
          : shape === "plain-object"
            ? { message: raw.message, detail: payload, data: raw.data, cause: raw.cause }
            : { persistence: raw, uncertainty: nativeFailure(), payload };
      const error =
        shape === "combined-evidence"
          ? museRequestError("bindings.blocked", raw.message, "unsafe-to-replay", evidence)
          : mapMuseRequestError("turn/cancel", evidence, "unsafe-to-replay");
      expect(getMuseFailureEvidence(error)).toBe(evidence);
      expect(error.failureClass).toBe("unsafe-to-replay");
      assertSafePresentations(error);
      // Rewrapping at another Muse boundary also keeps its evidence out of the public chain.
      const wrapped = mapMuseRequestError("startup", error, "unsafe-to-replay");
      expect(getMuseFailureEvidence(wrapped)).toBe(error);
      assertSafePresentations(wrapped);
    },
  );

  it("keeps composition bridge/process evidence private as well", () => {
    const raw = nativeFailure();
    const error = museProcessError(threadId, raw.message, "provider-unavailable", raw);
    expect(getMuseFailureEvidence(error)).toBe(raw);
    expect(error.failureClass).toBe("provider-unavailable");
    assertSafePresentations(error);
  });

  it("keeps an actual Stop failure safe for reactor logging and persisted session.lastError", async () => {
    const raw = nativeFailure();
    const host = makeMuseTestHost();
    const original = host.transport.command;
    host.transport.command = async (method, params, cid) => {
      if (method === "turn/cancel") throw raw;
      return original(method, params, cid);
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* host.adapter();
        yield* adapter.startSession(startInput);
        const turn = yield* adapter.sendTurn({ threadId, input: "work" });
        const result = yield* adapter.interruptTurn(threadId, turn.turnId).pipe(Effect.result);
        if (result._tag === "Success" || result.failure._tag !== "ProviderAdapterRequestError")
          throw new Error("Expected the typed native Stop failure.");
        expect(getMuseFailureEvidence(result.failure)).toBe(raw);
        expect(result.failure.failureClass).toBe("unsafe-to-replay");
        assertSafePresentations(result.failure);
        yield* adapter.stopAll();
      }),
    );
  });
});
