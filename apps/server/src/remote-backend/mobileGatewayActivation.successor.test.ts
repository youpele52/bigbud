import { expect, it } from "vitest";
import {
  mobileSuccessorDecision,
  runMobileSuccessorRecovery,
  type MobileSuccessorNativePort,
  type MobileSuccessorResumption,
} from "./mobileGatewayActivation.successor.ts";

/** Controlled opaque-token model only; not a native, socket or CAS proof. */
const attaching = Object.freeze({ attaching: true }),
  lease = Object.freeze({ lease: true }),
  exit = Object.freeze({ exit: true });
type Step = MobileSuccessorResumption<typeof attaching, typeof lease> | "throw";
function model(
  script: {
    resume?: Step;
    attach?: Step[];
    consent?: Array<boolean | "throw">;
    reconcile?: "exited" | "unsettled" | "throw";
    stop?: "throw";
    serve?: "throw";
    release?: "throw";
    record?: "throw";
  } = {},
) {
  const events: string[] = [];
  const consent = [...(script.consent ?? [])];
  const attach = [...(script.attach ?? [{ state: "live", lease }])];
  const act = <A>(name: string, step: A | "throw"): A => {
    events.push(name);
    if (step === "throw") throw Error(`${name} failed`);
    return step;
  };
  const native: MobileSuccessorNativePort<typeof attaching, typeof lease, typeof exit> = {
    resume: async () => act("resume#1", script.resume ?? { state: "attaching", attaching }),
    attach: async (value) => {
      expect(value).toBe(attaching);
      return act("resume#2", attach.shift() ?? "throw");
    },
    credential: (value) => {
      expect(value).toBe(attaching);
      return "c".repeat(64);
    },
    reconcile: async () => {
      const kind = act("reconcile", script.reconcile ?? "unsettled");
      return kind === "exited" ? { kind, exit } : { kind };
    },
    stop: async () => act("stop", script.stop ?? exit),
  };
  const upstream = {
    release: async () => {
      act("release", script.release ?? null);
    },
  };
  const run = () =>
    runMobileSuccessorRecovery({
      native,
      signal: new AbortController().signal,
      consented: async () => act("consent", consent.shift() ?? true),
      serveUpstream: async (credential) => {
        expect(credential).toBe("c".repeat(64));
        return act("serve", script.serve ?? upstream);
      },
      recordExit: async (value) => {
        expect(value).toBe(exit);
        act("record-exit", script.record ?? null);
      },
    });
  return { run, events, upstream };
}

it("maps every observed step to exactly one next action", () => {
  expect(mobileSuccessorDecision({ consent: "on" })).toBe("continue");
  expect(mobileSuccessorDecision({ consent: "off" })).toBe("revoke");
  expect(mobileSuccessorDecision({ consent: "unknown" })).toBe("consent-unknown");
  expect(mobileSuccessorDecision({ resume: 1, result: "attaching" })).toBe("serve-upstream");
  expect(mobileSuccessorDecision({ resume: 1, result: "live" })).toBe("legacy-native");
  expect(mobileSuccessorDecision({ resume: 1, result: "failed" })).toBe("settle-exit");
  expect(mobileSuccessorDecision({ resume: 2, result: "live" })).toBe("ready");
  expect(mobileSuccessorDecision({ resume: 2, result: "attaching" })).toBe("unready");
  expect(mobileSuccessorDecision({ resume: 2, result: "failed" })).toBe("settle-exit");
});

it("resumes before binding, serves the bootstrap credential, and is ready only on Resume #2", async () => {
  const m = model();
  const outcome = await m.run();
  expect(outcome).toEqual({ kind: "ready", lease, upstream: m.upstream });
  expect(m.events).toEqual([
    "consent",
    "resume#1",
    "consent",
    "serve",
    "consent",
    "resume#2",
    "consent",
  ]);
});

it("attaching then socket absent stays unready: socket withdrawn, native untouched", async () => {
  const m = model({ attach: [{ state: "attaching", attaching }] });
  expect(await m.run()).toEqual({ kind: "unready" });
  expect(m.events.slice(-2)).toEqual(["resume#2", "release"]);
  expect(m.events).not.toContain("stop");
  expect(m.events).not.toContain("record-exit");
});

it("an uncertain Resume #2 stays uncertain unless native confirms exit", async () => {
  const uncertain = model({ attach: ["throw"] });
  expect(await uncertain.run()).toEqual({ kind: "uncertain", reason: "native-unsettled" });
  expect(uncertain.events.slice(-4)).toEqual(["resume#2", "consent", "reconcile", "release"]);
  expect(uncertain.events).not.toContain("stop");
  const lost = model({ attach: ["throw"], reconcile: "throw" });
  expect(await lost.run()).toEqual({ kind: "uncertain", reason: "native-unsettled" });
  // The gateway died while attaching: confirmed exit settles through the journal.
  const died = model({ attach: ["throw"], reconcile: "exited" });
  expect(await died.run()).toEqual({ kind: "exited" });
  expect(died.events.slice(-3)).toEqual(["reconcile", "record-exit", "release"]);
});

it("a gone gateway settles confirmed exit before any socket work; unsettled stays uncertain", async () => {
  const gone = model({ resume: "throw", reconcile: "exited" });
  expect(await gone.run()).toEqual({ kind: "exited" });
  expect(gone.events).toEqual(["consent", "resume#1", "reconcile", "record-exit"]);
  const pending = model({ resume: "throw", reconcile: "unsettled" });
  expect(await pending.run()).toEqual({ kind: "uncertain", reason: "native-unsettled" });
  expect(pending.events).not.toContain("serve");
  const unrecorded = model({ resume: "throw", reconcile: "exited", record: "throw" });
  expect(await unrecorded.run()).toEqual({ kind: "uncertain", reason: "exit-unrecorded" });
});

it("consent revoked while attaching stops natively, records exit, then withdraws the socket", async () => {
  const sealed = model({ consent: [true, true, false] });
  expect(await sealed.run()).toEqual({ kind: "revoked" });
  expect(sealed.events.slice(3)).toEqual(["serve", "consent", "stop", "record-exit", "release"]);
  expect(sealed.events).not.toContain("resume#2");
  // Native guard refusal racing revocation: consent decides before status observation.
  const raced = model({ consent: [true, true, true, false], attach: ["throw"] });
  expect(await raced.run()).toEqual({ kind: "revoked" });
  expect(raced.events).not.toContain("reconcile");
  // Revoked after native verified the socket: never reported ready.
  const late = model({ consent: [true, true, true, false] });
  expect(await late.run()).toEqual({ kind: "revoked" });
  expect(late.events.slice(-4)).toEqual(["consent", "stop", "record-exit", "release"]);
  // Already off at controller start: no takeover, no socket, exact native stop.
  const off = model({ consent: [false] });
  expect(await off.run()).toEqual({ kind: "revoked" });
  expect(off.events).toEqual(["consent", "stop", "record-exit"]);
  const unconfirmed = model({ consent: [true, false], stop: "throw" });
  expect(await unconfirmed.run()).toEqual({ kind: "uncertain", reason: "native-unsettled" });
  expect(unconfirmed.events).not.toContain("record-exit");
});

it("legacy spawned, unknown consent and local socket failures never report ready", async () => {
  const legacy = model({ resume: { state: "live", lease } });
  expect(await legacy.run()).toEqual({ kind: "uncertain", reason: "legacy-native" });
  expect(legacy.events).toEqual(["consent", "resume#1"]);
  const unknown = model({ consent: [true, "throw"] });
  expect(await unknown.run()).toEqual({ kind: "uncertain", reason: "consent-unknown" });
  expect(unknown.events).not.toContain("serve");
  const unbound = model({ serve: "throw" });
  expect(await unbound.run()).toEqual({ kind: "uncertain", reason: "upstream-unavailable" });
  expect(unbound.events).not.toContain("resume#2");
  const stuck = model({ attach: [{ state: "attaching", attaching }], release: "throw" });
  expect(await stuck.run()).toEqual({ kind: "uncertain", reason: "upstream-unreleased" });
});
