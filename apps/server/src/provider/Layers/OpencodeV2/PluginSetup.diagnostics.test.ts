import { expect, it } from "vitest";
import { atV2SetupStage, v2SetupFailureKind } from "./PluginSetup.diagnostics.ts";
import { V2ActivationBusy } from "./PluginSetup.activation.errors.ts";
import { V2NativeCompatibilityError } from "./NativeCompatibility.types.ts";

it("retains the failing setup stage and finite errno without leaking private exception contents", async () => {
  const error = Object.assign(new Error("secret body /private/path"), {
    code: "EACCES",
    path: "/private/path",
  });
  await expect(
    atV2SetupStage("publication", async () => {
      throw error;
    }),
  ).rejects.toThrow(
    "V2 setup failed at publication (EACCES); history/uncertain evidence was retained.",
  );
  expect(v2SetupFailureKind(Object.assign(new Error("secret"), { code: "SECRET_TOKEN" }))).toBe(
    "unclassified",
  );
  expect(v2SetupFailureKind(new TypeError("secret"))).toBe("type-error");
  expect(v2SetupFailureKind(new SyntaxError("secret"))).toBe("syntax-error");
  expect(v2SetupFailureKind(new DOMException("secret", "AbortError"))).toBe("aborted");
  expect(v2SetupFailureKind(new DOMException("secret", "TimeoutError"))).toBe("timeout");
  expect(v2SetupFailureKind("secret")).toBe("unclassified");
  const accessor = Object.defineProperty(new Error(), "code", {
    get() {
      throw new Error("do not invoke");
    },
  });
  expect(v2SetupFailureKind(accessor)).toBe("unclassified");
});

it("preserves typed compatibility and busy decisions and does not retry failures", async () => {
  for (const error of [
    new V2ActivationBusy("V2 busy"),
    new V2NativeCompatibilityError("native-version-unsupported", "fixture"),
  ]) {
    let calls = 0;
    await expect(
      atV2SetupStage("eligibility", async () => {
        calls++;
        throw error;
      }),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
  }
  expect(await atV2SetupStage("config-scope", async () => 42)).toBe(42);
});
