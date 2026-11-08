import { expect, it } from "vitest";
import { OrganizationFailureGate } from "./organizationBridge.failure.ts";
import { OrganizationResync } from "./organizationLifecycle.ts";

it("defers a routine resync until the in-flight proposal settles; real faults are immediate", () => {
  const fenced: Error[] = [];
  const gate = new OrganizationFailureGate((error) => void fenced.push(error));
  gate.proposalStarted();
  const resync = new OrganizationResync("policy");
  gate.fail(resync);
  gate.fail(new OrganizationResync("clock"));
  expect(fenced).toEqual([]);
  gate.proposalSettled();
  expect(fenced).toEqual([resync]);
  const fault = new Error("child exited");
  gate.proposalStarted();
  gate.fail(fault);
  expect(fenced.at(-1)).toBe(fault);
  const idle = new OrganizationFailureGate((error) => void fenced.push(error));
  const immediate = new OrganizationResync("overflow");
  idle.fail(immediate);
  expect(fenced.at(-1)).toBe(immediate);
});
