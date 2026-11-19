import type {
  TerminalViewInput,
  TerminalWorkActivity,
} from "@bigbud/contracts/workspace/terminal.activity.ts";
import { Effect, ServiceMap } from "effect";
import type { TerminalFinishedCandidate } from "../activity/terminalWorkSignalReader.ts";

/**
 * Terminal recency and finished terminal work. Fed by the terminal manager (Enter, OSC 133,
 * process poll, agent hook marker) and by client view reports; persists recency (coalesced)
 * and finished items, and reports attention facts to the organiser. Never decides placement.
 */
export interface TerminalActivityShape {
  readonly submit: (threadId: string, terminalId: string, atMs: number) => Effect.Effect<void>;
  readonly finished: (
    threadId: string,
    terminalId: string,
    candidate: TerminalFinishedCandidate,
  ) => Effect.Effect<void>;
  readonly view: (caller: string, input: TerminalViewInput) => Effect.Effect<void>;
  readonly subscribe: (
    listener: (item: TerminalWorkActivity) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
}

export class TerminalActivity extends ServiceMap.Service<TerminalActivity, TerminalActivityShape>()(
  "bigbud/terminal/Services/TerminalActivity",
) {}
