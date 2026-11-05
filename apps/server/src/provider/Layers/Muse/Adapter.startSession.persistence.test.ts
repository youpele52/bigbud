import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { PersistenceSqlError } from "../../../persistence/Errors.ts";
import type {
  MuseSessionBinding,
  MuseSessionBindingsShape,
} from "../../../persistence/Services/MuseSessionBindings.ts";
import { makeMuseTestHost, startInput, threadId } from "./Adapter.failures.test.helpers.ts";
import { getMuseFailureEvidence } from "./Client.errors.ts";

const row: MuseSessionBinding = {
  threadId,
  nativeSessionId: "native",
  creationCommandId: "creation",
  workspace: process.cwd(),
  storageIdentity: "home",
  selectionFingerprint: "fp",
  createdAt: "2026-10-29T00:00:00.000Z",
  phase: "reserved",
  revision: 0,
};
const outage = new PersistenceSqlError({ operation: "binding", detail: "write failed" });

describe("Muse durable binding failures", () => {
  it.each(["success", "already-applied", "uncertain"] as const)(
    "does not succeed when the %s transition fails",
    async (scenario) => {
      const host = makeMuseTestHost();
      const original = host.transport.command;
      const uncertainty = new Error("transport lost");
      const transitions: Array<string> = [];
      host.transport.command = async (method, params, cid) => {
        if (method === "session/start" && scenario !== "success")
          throw scenario === "already-applied"
            ? { kind: "commandRejected", data: { reason: "session_id_conflict" } }
            : uncertainty;
        return original(method, params, cid);
      };
      const bindings: MuseSessionBindingsShape = {
        find: () => Effect.succeed(row),
        reserve: () => Effect.succeed(row),
        transition: (_row, phase) => {
          transitions.push(phase);
          return Effect.fail(outage);
        },
      };
      const adapter = await Effect.runPromise(host.adapter({ bindings }));
      const result = await Effect.runPromise(Effect.result(adapter.startSession(startInput)));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "ProviderAdapterRequestError",
          failureClass: "unsafe-to-replay",
        });
        if (scenario === "uncertain")
          expect(getMuseFailureEvidence(result.failure)).toEqual({
            persistence: outage,
            uncertainty,
          });
        else expect(getMuseFailureEvidence(result.failure)).toBe(outage);
        expect(result.failure.cause).toBeUndefined();
      }
      expect(transitions).toEqual([scenario === "uncertain" ? "blocked" : "bound"]);
      expect(host.calls.some((call) => call.method === "session/resume")).toBe(false);
      expect(host.calls.find((call) => call.method === "session/start")?.params.sessionId).toBe(
        scenario === "success" ? "native" : undefined,
      );
      expect(host.closed()).toBe(1);
      expect(await Effect.runPromise(adapter.hasSession(threadId))).toBe(false);
    },
  );
});
