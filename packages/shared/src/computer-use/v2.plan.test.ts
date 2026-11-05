import { readFileSync } from "node:fs";

import { ComputerUseDesktopV2Action } from "@bigbud/contracts/orchestration/computerUseDesktopV2";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { CUA_DRIVER_REQUIRED_TOOLS } from "../cua-driver/policy";
import { schemaViolation } from "./schemaSubset.test.helpers";
import { groundDesktopV2Action } from "./v2.grounding";
import { type DesktopV2Plan, type DriverCall, planDesktopV2Action } from "./v2.plan";

const readJson = (relative: string) =>
  JSON.parse(readFileSync(new URL(`../../../../${relative}`, import.meta.url), "utf8"));

interface GoldenCase {
  readonly name: string;
  readonly userDefault: "foreground" | "background";
  readonly action: unknown;
  readonly plan: DesktopV2Plan;
}
const golden = readJson("protocol/computer-use/plan.v1.golden.json") as {
  readonly format: string;
  readonly cases: ReadonlyArray<GoldenCase>;
};
const live = readJson("scripts/fixtures/cua-driver/0.38.0/live-schema.darwin.json") as {
  readonly tools: Readonly<
    Record<string, { readonly inputSchema: Readonly<Record<string, unknown>> }>
  >;
};
const decode = Schema.decodeUnknownSync(ComputerUseDesktopV2Action);

const planOf = (testCase: GoldenCase): DesktopV2Plan | null => {
  const grounded = groundDesktopV2Action(decode(testCase.action), testCase.userDefault);
  if (!grounded.ok) throw new Error(`${testCase.name}: ${grounded.code}`);
  return planDesktopV2Action(grounded.value);
};

const driverCalls = (plan: DesktopV2Plan): ReadonlyArray<DriverCall> => [
  ...plan.steps.filter((step): step is DriverCall => step.kind === "driver"),
  ...(plan.captureAfter === undefined ? [] : [plan.captureAfter]),
];

/** Representative owner values; the model never supplies these fields. */
const STAMPED = { session: "c1", pid: 42, window_id: 7, capture_id: "cap-1" } as const;
const stamped = (call: DriverCall) => ({
  ...call.arguments,
  ...Object.fromEntries(call.stamp.map((field) => [field, STAMPED[field]])),
});

describe("planDesktopV2Action (golden plan.v1)", () => {
  it.each(golden.cases.map((testCase) => [testCase.name, testCase] as const))(
    "%s",
    (_name, testCase) => {
      expect(golden.format).toBe("bigbud.computerUsePlan.v1");
      expect(planOf(testCase)).toEqual(testCase.plan);
    },
  );
});

describe("planned driver calls against the pinned 0.38.0 live schemas", () => {
  const calls = golden.cases.flatMap((testCase) => driverCalls(testCase.plan));

  it("validate once stamped, with explicit delivery for every input", () => {
    expect(calls.length).toBeGreaterThan(20);
    for (const call of calls) {
      const tool = live.tools[call.tool];
      expect(tool, call.tool).toBeDefined();
      expect(schemaViolation(tool!.inputSchema, stamped(call)), call.tool).toBeNull();
      const input = ["click", "drag", "scroll", "type_text", "press_key", "hotkey"];
      if (input.includes(call.tool)) expect(call.arguments.delivery_mode).toBeDefined();
    }
  });

  it("detects violations (the validator is not vacuous)", () => {
    const schema = (tool: string) => live.tools[tool]!.inputSchema;
    const click = { x: 1, y: 2, delivery_mode: "background", session: "c1", pid: 1, window_id: 2 };
    expect(schemaViolation(schema("click"), click)).toBeNull();
    expect(schemaViolation(schema("click"), { ...click, x: "1" })).toContain("$.x");
    expect(schemaViolation(schema("click"), { ...click, extra: 1 })).toContain("not allowed");
    expect(schemaViolation(schema("click"), { ...click, button: "back" })).toContain("enum");
    expect(schemaViolation(schema("drag"), { from_x: 1, from_y: 1, to_x: 1 })).toContain("to_y");
    const scroll = { direction: "down", amount: 51 };
    expect(schemaViolation(schema("scroll"), scroll)).toContain("above maximum");
    expect(schemaViolation(schema("hotkey"), { keys: ["cmd"] })).toContain("too few items");
  });

  it("never lets the model supply an owner-stamped field", () => {
    for (const call of calls) {
      for (const field of Object.keys(STAMPED)) expect(call.arguments).not.toHaveProperty(field);
    }
  });

  it("stamps capture_id only where the live schema accepts it", () => {
    for (const call of calls) {
      const accepts = "capture_id" in (live.tools[call.tool]!.inputSchema.properties as object);
      if (call.stamp.includes("capture_id")) expect(accepts, call.tool).toBe(true);
    }
    const props = (tool: string) => live.tools[tool]!.inputSchema.properties as object;
    expect("capture_id" in props("drag")).toBe(false);
    expect("capture_id" in props("scroll")).toBe(false);
    expect(calls.filter((call) => call.stamp.includes("capture_id")).map((c) => c.tool)).toEqual([
      "click",
      "click",
    ]);
  });

  it("covers every tool the current required profile names (M6.3 fixture parity)", () => {
    for (const tool of CUA_DRIVER_REQUIRED_TOOLS) expect(live.tools[tool], tool).toBeDefined();
  });
});

describe("plan refusals", () => {
  it("refuses an empty key chord instead of sending no key", () => {
    const action = decode({
      schemaVersion: 2,
      surface: "desktop",
      action: "key",
      targetRef: "t",
      key: "+",
    });
    const grounded = groundDesktopV2Action(action, "background");
    expect(grounded.ok && planDesktopV2Action(grounded.value)).toBeNull();
  });
});
