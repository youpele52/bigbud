import { createTerminalAgentEvidenceResolver } from "./terminalAgentEvidence.ts";
import { TERMINAL_AGENTS, type TerminalAgentDescriptor } from "./terminalAgents.ts";
import type { TerminalAgentIdentity } from "@bigbud/contracts/workspace/terminal.agentIdentity.ts";

export interface TerminalTaskTitleContext {
  /** Only populate from verified foreground detection or an equivalently trusted adapter. */
  readonly foregroundAgent: TerminalAgentIdentity | null;
  readonly directories?: ReadonlyArray<string>;
}
const STATUS =
  /^(?:working|ready(?: for (?:input|instructions|prompt))?|idle|thinking|loading|connecting|running|busy|waiting(?: for .*)?|awaiting(?: .*)?|done|completed|session|new (?:chat|thread|session)|welcome|agent|terminal)(?:[.!…\s]*|\s*[·|:-]?\s*\(?\d[\d.:\s]*(?:ms|s|m|h|%|tokens)?\)?[.!…\s]*)$/i;
const SHELL =
  /^(?:\S+@\S+|[~/.\\]|[a-z]:[\\/]|(?:ba|z|fi|da|k|pw)?sh\b|powershell\b|cmd(?:\.exe)?\b|(?:bun|npm|pnpm|yarn|git|cd|ls|pwd|node|python\d*|cargo|make|ssh|docker|vim|nvim|echo|printf)\b)/i;

/** Share parsing/filtering across trusted adapters without encoding provider knowledge. */
export function createTerminalTaskTitleResolver(
  agents: ReadonlyArray<TerminalAgentDescriptor> = TERMINAL_AGENTS,
) {
  const resolver = createTerminalAgentEvidenceResolver(agents);
  return (raw: string, context: TerminalTaskTitleContext): string | null => {
    if (raw.length > 1024) return null;
    for (let index = 0; index < raw.length; index++) {
      const code = raw.charCodeAt(index);
      if (code < 32 || (code >= 127 && code <= 159)) return null;
    }
    const evidence = resolver.resolve(raw, context.foregroundAgent);
    if (!evidence) return null;
    const title = evidence.title.replace(/\s+/g, " ").trim();
    if (
      context.directories?.some((directory) => {
        const normalized = directory.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
        const candidate = title.toLowerCase();
        return candidate === normalized || candidate === normalized.split("/").at(-1);
      })
    )
      return null;
    if (
      resolver.isIdentity(title, evidence) ||
      /^(?:welcome to\b|trust (?:this|the) (?:folder|directory)\b)/i.test(title) ||
      STATUS.test(title) ||
      SHELL.test(title) ||
      !/\p{L}/u.test(title) ||
      title.split(" ").length < 2 ||
      /^(?:https?:\/\/|file:\/\/)/i.test(title)
    )
      return null;
    return title.length <= 80 ? title : `${title.slice(0, 77).trimEnd()}...`;
  };
}

/** Only native task labels; ordinary terminal prose cannot supply its own agent evidence. */
export const meaningfulTerminalTaskTitle = createTerminalTaskTitleResolver();

/** Streaming OSC 0/2 reader with bounded memory, including unterminated strings. */
export function createTerminalTitleReader() {
  let state: "text" | "escape" | "osc" | "string" = "text";
  let escaped = false;
  let payload = "";
  let overflow = false;
  return (data: string): string[] => {
    const titles: string[] = [];
    for (const character of data) {
      if (state === "text") {
        if (character === "\x1b") state = "escape";
        else if (character === "\x9d") state = "osc";
        else if ("\x90\x98\x9e\x9f".includes(character)) state = "string";
        continue;
      }
      if (state === "escape") {
        state = character === "]" ? "osc" : "PX^_".includes(character) ? "string" : "text";
        continue;
      }
      const end =
        character === "\x9c" ||
        (escaped && character === "\\") ||
        (state === "osc" && character === "\x07");
      if (end || character === "\x18" || character === "\x1a") {
        if (end && state === "osc" && !overflow && /^[02];/.test(payload)) {
          titles.push(payload.slice(2));
        }
        state = "text";
        escaped = false;
        payload = "";
        overflow = false;
        continue;
      }
      if (state === "osc" && !overflow) {
        if (escaped) payload += "\x1b";
        if (character !== "\x1b") payload += character;
        if (payload.length > 1026) {
          payload = "";
          overflow = true;
        }
      }
      escaped = character === "\x1b";
    }
    return titles;
  };
}
