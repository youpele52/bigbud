/**
 * Dormant ordered call plan for grounded desktop v2 actions against the
 * pinned cua-driver 0.38.0 live tools (plan M2 "Primitive plan and delivery
 * mapping"). TypeScript only plans: every driver call carries model-derived
 * arguments, and the fields in `stamp` are supplied by the native owner from
 * verified references (never by the model). Native dispatch re-validates the
 * whole sequence. Nothing calls this while legacy Driver 0.9.1 stays selected.
 */
import type { ComputerUseDelivery } from "@bigbud/contracts/orchestration/computerUseDesktopV2";

import { normalizeKeyChord } from "./keys";
import { chunkScrollAmount, MACOS_SCROLL_CHUNK_MAX } from "./scroll";
import type { GroundedDesktopV2Action } from "./v2.grounding";

export const ACCESSIBILITY_DEFAULT_DEPTH = 25;
export const ACCESSIBILITY_MAX_ELEMENTS = 250;
export const ACCESSIBILITY_TIMEOUT_MS = 1000;
export const DRAG_DURATION_MS = 500;
export const DRAG_STEPS = 20;

export type DriverTool =
  | "get_window_state"
  | "click"
  | "drag"
  | "scroll"
  | "type_text"
  | "press_key"
  | "hotkey"
  | "bring_to_front"
  | "list_apps"
  | "list_windows"
  | "check_permissions"
  | "health_report";

/** Fields only the native owner supplies, from verified references. */
export type OwnerStamp = "session" | "pid" | "window_id" | "capture_id";
export type PlanArgument = string | number | boolean | ReadonlyArray<string>;

export interface DriverCall {
  readonly kind: "driver";
  readonly tool: DriverTool;
  readonly arguments: Readonly<Record<string, PlanArgument>>;
  readonly stamp: ReadonlyArray<OwnerStamp>;
}
export interface OwnerStep {
  readonly kind: "owner";
  /** Native OS evidence that the exact target is frontmost, or a timer. */
  readonly step: "verify_foreground" | "wait";
  readonly durationMs?: number;
}
export interface BrokerStep {
  readonly kind: "broker";
  readonly operation: "launch" | "resolve_app" | "navigate";
  readonly name?: string;
  readonly url?: string;
  readonly delivery?: ComputerUseDelivery;
}
export type DesktopV2Step = DriverCall | OwnerStep | BrokerStep;

export interface DesktopV2Plan {
  /**
   * What the owner must hold before the first driver step. `broker_target`:
   * the broker step must return a verified target (never the frontmost
   * window); every later driver step and `captureAfter` is stamped from it,
   * and the plan stops when the broker returns none.
   */
  readonly binding: "none" | "target" | "observation" | "focused_target" | "broker_target";
  readonly steps: ReadonlyArray<DesktopV2Step>;
  /** Fresh capture of the same target, only after a known completed mutation. */
  readonly captureAfter?: DriverCall;
}

const TARGET: ReadonlyArray<OwnerStamp> = ["session", "pid", "window_id"];
const SESSION: ReadonlyArray<OwnerStamp> = ["session"];
const call = (
  tool: DriverTool,
  args: Readonly<Record<string, PlanArgument>>,
  stamp: ReadonlyArray<OwnerStamp> = TARGET,
): DriverCall => ({ kind: "driver", tool, arguments: args, stamp });

/** Qualified window capture: registers an action capture (never display-only). */
const capture = (): DriverCall =>
  call("get_window_state", { include_screenshot: true, include_accessibility_tree: false });
const accessibility = (depth: number, screenshot: boolean): DriverCall =>
  call("get_window_state", {
    include_screenshot: screenshot,
    include_accessibility_tree: true,
    tree_format: "elements",
    max_elements: ACCESSIBILITY_MAX_ELEMENTS,
    max_depth: depth,
    timeout_ms: ACCESSIBILITY_TIMEOUT_MS,
  });

/**
 * Foreground is a non-restoring prelude (bring_to_front, then native
 * verification) before input; background never escalates to a prelude.
 */
const input = (delivery: ComputerUseDelivery, calls: ReadonlyArray<DriverCall>) =>
  delivery === "foreground"
    ? [call("bring_to_front", {}), { kind: "owner", step: "verify_foreground" } as const, ...calls]
    : calls;

/** Without a reference, capture resolves the genuine OS-focused target once. */
const targeted = (targetRef: string | undefined) =>
  targetRef === undefined ? ("focused_target" as const) : ("target" as const);

const withCaptureAfter = (plan: DesktopV2Plan, requested: boolean | undefined): DesktopV2Plan =>
  requested === true ? { ...plan, captureAfter: capture() } : plan;

export function planDesktopV2Action(grounded: GroundedDesktopV2Action): DesktopV2Plan | null {
  const { action } = grounded;
  const delivery = grounded.delivery ?? "background";
  const deliveryMode = { delivery_mode: delivery };
  switch (action.action) {
    case "capture":
      return { binding: targeted(action.targetRef), steps: [capture()] };
    case "get_page_info":
      return {
        binding: targeted(action.targetRef),
        steps: [accessibility(ACCESSIBILITY_DEFAULT_DEPTH, true)],
      };
    case "click": {
      const args = { x: action.x, y: action.y, ...deliveryMode };
      const clicked = call("click", action.button ? { ...args, button: action.button } : args, [
        ...TARGET,
        "capture_id",
      ]);
      const plan = { binding: "observation", steps: input(delivery, [clicked]) } as const;
      return withCaptureAfter(plan, action.captureAfter);
    }
    case "drag": {
      const dragged = call("drag", {
        from_x: action.startX,
        from_y: action.startY,
        to_x: action.endX,
        to_y: action.endY,
        ...deliveryMode,
        duration_ms: DRAG_DURATION_MS,
        steps: DRAG_STEPS,
      });
      const plan = { binding: "observation", steps: input(delivery, [dragged]) } as const;
      return withCaptureAfter(plan, action.captureAfter);
    }
    case "scroll": {
      const scroll = grounded.scroll;
      if (scroll === undefined) return null;
      const point =
        action.x === undefined || action.y === undefined ? {} : { x: action.x, y: action.y };
      const chunks = chunkScrollAmount(scroll.amount, MACOS_SCROLL_CHUNK_MAX).map((amount) =>
        call("scroll", { direction: scroll.direction, amount, ...point, ...deliveryMode }),
      );
      const binding = "x" in point ? "observation" : "target";
      return withCaptureAfter({ binding, steps: input(delivery, chunks) }, action.captureAfter);
    }
    case "type": {
      const typed = call("type_text", { text: action.text, ...deliveryMode });
      return withCaptureAfter(
        { binding: "target", steps: input(delivery, [typed]) },
        action.captureAfter,
      );
    }
    case "key": {
      const keys = normalizeKeyChord(action.key);
      if (keys.length === 0) return null;
      const [only] = keys;
      const pressed =
        keys.length === 1 && only !== undefined
          ? call("press_key", { key: only, ...deliveryMode })
          : call("hotkey", { keys, ...deliveryMode });
      return withCaptureAfter(
        { binding: "target", steps: input(delivery, [pressed]) },
        action.captureAfter,
      );
    }
    case "focus_app": {
      const focus = [
        call("bring_to_front", {}),
        { kind: "owner", step: "verify_foreground" } as const,
      ];
      if (action.targetRef !== undefined) return { binding: "target", steps: focus };
      if (action.name === undefined) return null;
      const resolve = { kind: "broker", operation: "resolve_app", name: action.name } as const;
      return { binding: "broker_target", steps: [resolve, ...focus] };
    }
    case "launch_app":
      return {
        binding: "none",
        steps: [{ kind: "broker", operation: "launch", name: action.name, delivery }],
      };
    case "navigate": {
      const step = { kind: "broker", operation: "navigate", url: action.url, delivery } as const;
      // A later capture needs the navigated window, never a re-acquired frontmost one.
      const binding = action.captureAfter === true ? "broker_target" : "none";
      return withCaptureAfter({ binding, steps: [step] }, action.captureAfter);
    }
    case "wait": {
      const plan = {
        binding: action.targetRef === undefined ? "none" : "target",
        steps: [{ kind: "owner", step: "wait", durationMs: action.durationMs }],
      } as const;
      return withCaptureAfter(plan, action.captureAfter);
    }
    case "list_apps":
      return { binding: "none", steps: [call("list_apps", {}, SESSION)] };
    case "list_windows":
      return { binding: "none", steps: [call("list_windows", {}, SESSION)] };
    case "get_accessibility_tree":
      // Unscoped accessibility is filtered discovery, never a global tree.
      return action.targetRef === undefined
        ? { binding: "none", steps: [call("list_windows", {}, SESSION)] }
        : {
            binding: "target",
            steps: [accessibility(action.maxDepth ?? ACCESSIBILITY_DEFAULT_DEPTH, false)],
          };
    case "check_permissions":
      return {
        binding: "none",
        steps: [call("check_permissions", { prompt: false, probe_direct_capture: false }, SESSION)],
      };
    case "doctor":
      return {
        binding: "none",
        steps: [call("health_report", { skip: ["screen_capture_capability"] }, SESSION)],
      };
  }
}
