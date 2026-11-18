import { describe, it, expect } from "vitest";
import {
  NativeLeaseTokens,
  type PendingOriginalNativeLease,
  type VerifiedNativeLease,
  type ConfirmedNativeLeaseExit,
} from "./remoteAgentServiceLease.tokens.ts";
import {
  stateDir,
  launch,
  response,
  retainedReference,
} from "./remoteAgentServiceLease.test.fixture.ts";

function fresh(tokens: NativeLeaseTokens) {
  const attempt = tokens.beginAttempt();
  return { attempt, input: launch(tokens.attemptNonce(attempt)) };
}
function prepare(tokens: NativeLeaseTokens) {
  const value = fresh(tokens);
  return tokens.prepare(value.attempt, value.input);
}
describe("original native owner capability tokens", () => {
  it("atomically fences every later invocation with an original never-invoked proof", () => {
    const tokens = new NativeLeaseTokens("epoch", stateDir),
      pending = prepare(tokens);
    const proof = tokens.neverInvoked(pending);
    expect(tokens.cancellation(proof).binding.nonce).toMatch(/^[a-f0-9-]{36}$/);
    expect(tokens.cancellation(proof).kind).toBe("never-invoked");
    expect(() => tokens.invoke(pending)).toThrow(/cancelled/);
    expect(() => tokens.neverInvoked(pending)).toThrow();
  });
  it("never upgrades restored or already-sent intent into local never-invoked authority", () => {
    const tokens = new NativeLeaseTokens("epoch", stateDir),
      input = launch();
    expect(() => tokens.neverInvoked(tokens.restore(retainedReference(input)))).toThrow();
    const prepared = fresh(tokens);
    const token = tokens.prepare(prepared.attempt, prepared.input);
    tokens.invoke(token);
    expect(() => tokens.neverInvoked(token)).toThrow();
  });
  it("snapshots original bytes before async IO and never reveals capability/bootstrap in JSON", () => {
    const tokens = new NativeLeaseTokens("epoch", stateDir),
      source = fresh(tokens),
      input = source.input,
      token = tokens.prepare(source.attempt, input);
    input.capability.fill(0);
    input.guard.fill(0);
    input.binding!.configurationSha256.fill(0);
    const original = tokens.invoke(token);
    expect(original.capability[0]).toBe(7);
    expect(Buffer.from(original.guard).toString()).toBe("fixture-guard");
    expect(JSON.stringify(token)).toBe("{}");
    expect(JSON.stringify(tokens.binding(token))).not.toContain("memory-only-secret");
    expect(Object.isFrozen(tokens.binding(token))).toBe(true);
    expect(tokens.originalView(token).assetsReference).toEqual({
      schemaVersion: 1,
      generation: `assets-${"0".repeat(32)}`,
      sizeBytes: 1234,
      sha256: "06".repeat(32),
    });
    expect(Object.isFrozen(tokens.originalView(token).assetsReference)).toBe(true);
  });
  it("refuses mismatched original fingerprints and tokens from another owner", () => {
    const a = new NativeLeaseTokens("epoch", stateDir),
      b = new NativeLeaseTokens("epoch", stateDir);
    const source = fresh(a),
      input = source.input;
    input.binding!.configurationSha256.fill(0);
    expect(() => a.prepare(source.attempt, input)).toThrow(/fingerprint/);
    const token = prepare(a);
    expect(() => b.invoke(token)).toThrow(/Original/);
    expect(() => a.invoke({} as PendingOriginalNativeLease)).toThrow();
  });
  it("fences stale generations and cannot fabricate terminal evidence from missing or malformed status", () => {
    const tokens = new NativeLeaseTokens("epoch", stateDir),
      source = fresh(tokens),
      input = source.input,
      token = tokens.prepare(source.attempt, input);
    const first = tokens.grant(token, response(input));
    tokens.grant(token, response(input, 2));
    expect(() => tokens.granted(first)).toThrow(/stale/);
    expect(() => tokens.terminal(token, { ...response(input), state: "not-found" })).toThrow();
    expect(() =>
      tokens.terminal(token, {
        ...response(input),
        state: "exited",
        originalController: undefined,
      }),
    ).toThrow();
    const live = tokens.grant(token, response(input, 3));
    expect(() => tokens.exitView(live as unknown as ConfirmedNativeLeaseExit)).toThrow();
    const exit = tokens.terminal(token, {
      ...response(input),
      state: "exited",
      generation: 0,
      originalChildPid: 0,
    });
    expect(tokens.view(exit).originalChildPid).toBe(0);
    expect(tokens.exitView(exit).kind).toBe("native-exit");
    expect(() => tokens.granted(first)).toThrow();
    expect(() => tokens.view({} as ConfirmedNativeLeaseExit)).toThrow();
    expect(() => tokens.granted({} as VerifiedNativeLease)).toThrow();
  });
  it("bounds uncertain history without evicting an original nonce fence", () => {
    const tokens = new NativeLeaseTokens("epoch", stateDir);
    for (let i = 0; i < 64; i++) prepare(tokens);
    expect(() => prepare(tokens)).toThrow(/capacity/);
  });
});

it("fresh preparation cannot import a caller nonce or consume the same original attempt twice", () => {
  const tokens = new NativeLeaseTokens("epoch", stateDir),
    source = fresh(tokens);
  const old = launch();
  expect(() => tokens.prepare(source.attempt, old)).toThrow(/nonce/);
  const token = tokens.prepare(source.attempt, source.input);
  expect(() => tokens.prepare(source.attempt, source.input)).toThrow(/consumed/);
  expect(() => tokens.restore(retainedReference(source.input))).toThrow(/duplicate/);
  expect(tokens.binding(token).nonce).toBe(tokens.attemptNonce(source.attempt));
});
