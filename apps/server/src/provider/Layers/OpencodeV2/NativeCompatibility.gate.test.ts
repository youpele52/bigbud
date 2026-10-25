import { expect, it, vi } from "vitest";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import type { V2NativeRuntimeProof } from "./NativeCompatibility.types.ts";

it("proof is checked at reservation and dispatch, binds root/transport/Location, and cannot be reused after epoch replacement", () => {
  let valid = true;
  const proof = {
    root: "/root",
    transport: "transport",
    generation: "generation",
    directory: "/A",
    assertCurrent: () => {
      if (!valid) throw new Error("Revoked proof");
    },
  } as V2NativeRuntimeProof;
  const gate = new V2ActivationGate(
    JSON.stringify(["/root", "issuer", "transport", "generation"]),
    "A",
    () => {},
  );
  expect(() => gate.verify("/B", "A", "instance", proof)).toThrow("proof scope");
  const ready = gate.verify("/A", "A", "instance", proof);
  valid = false;
  expect(() => gate.tryReserve(ready, "start")).toThrow("Revoked proof");
  valid = true;
  const token = gate.tryReserve(ready, "start")!,
    dispatch = vi.fn(async () => {});
  valid = false;
  expect(() => gate.dispatch(token, dispatch)).toThrow("Revoked proof");
  expect(dispatch).not.toHaveBeenCalled();
  expect(gate.busyCount()).toBe(1);
  // Exact cleanup remains possible after proof/consent loss; revocation cannot orphan physical evidence.
  expect(gate.cancelUndispatched(token)).toBe(true);
  valid = true;
  gate.invalidate("B");
  expect(gate.tryReserve(ready, "stale")).toBeUndefined();
});
