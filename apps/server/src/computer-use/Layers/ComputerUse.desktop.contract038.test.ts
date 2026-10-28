/**
 * Fixture conformance guard (lean upgrade M4): every argument bigbud sends to
 * the Driver must be a declared property of that tool's 0.38 `inputSchema`
 * (0.38 refuses unknown arguments with `invalid_arguments`), and every
 * required property must be present. Numeric ranges are not checked (scroll
 * amounts are clamped by the driver).
 */
import * as FS from "node:fs";

import { ThreadId, type ComputerUseAction } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { CuaDriverShape } from "../Services/CuaDriver.ts";
import { executeDesktopComputerUse } from "./ComputerUse.desktop.ts";

interface ToolSchema {
  readonly inputSchema: {
    readonly properties?: Record<string, unknown>;
    readonly required?: string[];
  };
}
const schemas = JSON.parse(
  FS.readFileSync(
    new URL(
      "../../../../../scripts/fixtures/cua-driver/0.38.0/live-schema.darwin.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { readonly tools: Record<string, ToolSchema> };

const THREAD_ID = ThreadId.makeUnsafe("thread-33333333-3333-4333-8333-333333333333");
const WINDOW = {
  pid: 321,
  window_id: 9,
  app_name: "Notes",
  title: "Notes",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  is_on_screen: true,
  on_current_space: true,
  z_index: 1,
};

type RecordedCall = { name: string; args: Record<string, unknown> };

function recordingDriver(calls: RecordedCall[]): CuaDriverShape {
  return {
    callTool: (name, args) => {
      calls.push({ name, args });
      const structuredContent =
        name === "list_windows"
          ? { windows: [WINDOW] }
          : name === "list_apps"
            ? { apps: [{ name: "Notes", pid: 321, running: true }] }
            : name === "launch_app"
              ? { pid: 321, windows: [WINDOW] }
              : { effect: "confirmed", route: "accessibility" };
      return Effect.succeed({
        content: [
          { type: "image", data: "aW1n", mimeType: "image/png" },
          { type: "text", text: "ok" },
        ],
        structuredContent,
      });
    },
    runDoctor: () => Effect.succeed("ok"),
    resetProxy: Effect.void,
    resetAfterUncertainAction: () => Effect.void,
    withExclusiveAccess: (effect) => effect,
    dispose: Effect.void,
  };
}

const ACTIONS: ReadonlyArray<ComputerUseAction> = [
  { action: "capture" },
  { action: "get_page_info" },
  { action: "list_windows" },
  { action: "list_apps" },
  { action: "check_permissions" },
  { action: "check_permissions", prompt: true },
  { action: "get_accessibility_tree" },
  { action: "launch_app", name: "Notes" },
  { action: "focus_app", name: "Notes" },
  { action: "focus_app", pid: 321 },
  { action: "click", x: 10, y: 20 },
  { action: "click", x: 10, y: 20, button: "right" },
  { action: "drag", startX: 1, startY: 2, endX: 30, endY: 40 },
  { action: "scroll", deltaY: 240 },
  { action: "scroll", deltaX: -120 },
  { action: "type", text: "hello" },
  { action: "key", key: "Enter" },
  { action: "key", key: "cmd+shift+s" },
  { action: "wait", durationMs: 1, captureAfter: true },
  { action: "doctor" },
] as ComputerUseAction[];

/** Every argument key declared, every required key present, for each recorded call. */
function assertDeclaredArguments(calls: ReadonlyArray<RecordedCall>): void {
  for (const { name, args } of calls) {
    const schema = schemas.tools[name]?.inputSchema;
    expect(schema, `tool ${name} is in the 0.38 profile`).toBeDefined();
    const properties = Object.keys(schema?.properties ?? {});
    for (const key of Object.keys(args)) {
      expect(properties, `${name}.${key} is declared`).toContain(key);
    }
    for (const required of schema?.required ?? []) {
      expect(Object.keys(args), `${name} sends required ${required}`).toContain(required);
    }
  }
}

describe("desktop arguments conform to the Driver 0.38 input schemas", () => {
  it("rejects an undeclared argument injected into a recorded call", async () => {
    const calls: RecordedCall[] = [];
    await Effect.runPromise(
      executeDesktopComputerUse(THREAD_ID, recordingDriver(calls), {
        action: "click",
        x: 10,
        y: 20,
        surface: "desktop",
      } as ComputerUseAction),
    );
    const click = calls.find((call) => call.name === "click");
    expect(click).toBeDefined();
    assertDeclaredArguments(calls);
    click!.args = { ...click!.args, bogus_field: 1 };
    expect(() => assertDeclaredArguments(calls)).toThrow(/click\.bogus_field is declared/);
    // And a missing required key is caught the same way.
    expect(() => assertDeclaredArguments([{ name: "type_text", args: {} }])).toThrow(
      /type_text sends required text/,
    );
  });

  it.each(ACTIONS.map((action) => [JSON.stringify(action), action] as const))(
    "%s",
    async (_label, action) => {
      const calls: RecordedCall[] = [];
      await Effect.runPromise(
        executeDesktopComputerUse(THREAD_ID, recordingDriver(calls), {
          ...action,
          surface: "desktop",
        } as ComputerUseAction),
      );
      if (action.action !== "doctor") expect(calls.length).toBeGreaterThan(0);
      assertDeclaredArguments(calls);
    },
  );
});
