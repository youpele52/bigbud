import {
  TERMINAL_FINISHED_COMMAND_MAX_CHARS,
  type TerminalFinishedSource,
} from "@bigbud/contracts/workspace/terminal.activity.ts";

/** A finished piece of terminal work, before the attention policy decides anything. */
export interface TerminalFinishedCandidate {
  readonly atMs: number;
  readonly command?: string;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly source: TerminalFinishedSource;
}

/** OSC bodies longer than this are ignored without buffering more (a `cmdline_url` is cut). */
const MAX_OSC_BODY = 4096;
const AGENT_DONE_BODY = "777;bigbud;done";

// oxlint-disable-next-line no-control-regex -- Removing control characters is the purpose.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Untrusted command text: decoded, single-line, control-free, bounded. */
export function sanitizeTerminalCommand(value: string, encoded: boolean): string | undefined {
  let text = value;
  if (encoded) {
    try {
      text = decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  const clean = text.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, TERMINAL_FINISHED_COMMAND_MAX_CHARS) : undefined;
}

function commandFromParams(params: readonly string[]): string | undefined {
  for (const param of params) {
    if (param.startsWith("cmdline_url=")) return sanitizeTerminalCommand(param.slice(12), true);
    if (param.startsWith("cmdline=")) return sanitizeTerminalCommand(param.slice(8), false);
  }
  return undefined;
}

/**
 * Reads OSC 133 command markers and the exact `bigbud;done` agent marker from PTY output, across
 * chunk boundaries. Output is observed, never modified. Only `C` (output start) and `D` (finished)
 * matter: a `D` without a fresh `C` (duplicate integrations, missing start) is ignored.
 */
export class TerminalWorkSignalReader {
  private state: "ground" | "escape" | "osc" | "oscEscape" = "ground";
  private body = "";
  private overflow = false;
  private started: { atMs: number; command?: string } | null = null;
  /** True once any OSC 133 marker was seen: the process-poll fallback then stays silent. */
  shellIntegrationSeen = false;

  constructor(private readonly now: () => number = Date.now) {}

  receive(data: string): TerminalFinishedCandidate[] {
    const signals: TerminalFinishedCandidate[] = [];
    let index = 0;
    while (index < data.length) {
      if (this.state === "ground") {
        const escape = data.indexOf("\u001b", index);
        if (escape < 0) break;
        this.state = "escape";
        index = escape + 1;
        continue;
      }
      const code = data.charCodeAt(index);
      if (this.state === "escape") {
        this.state = code === 0x5d ? "osc" : "ground";
        this.body = "";
        this.overflow = false;
        if (code === 0x1b) this.state = "escape";
        index++;
        continue;
      }
      if (this.state === "oscEscape") {
        // ESC \ is ST; any other byte follows an ESC that opened a new sequence.
        if (code === 0x5c) this.finish(signals);
        this.state = code === 0x5c ? "ground" : code === 0x5d ? "osc" : "ground";
        this.body = "";
        index++;
        continue;
      }
      // osc: find the terminator in bulk.
      let end = index;
      while (end < data.length) {
        const value = data.charCodeAt(end);
        if (value === 0x07 || value === 0x1b || value === 0x18 || value === 0x1a) break;
        end++;
      }
      if (!this.overflow) {
        this.body += data.slice(index, end);
        if (this.body.length > MAX_OSC_BODY) {
          this.overflow = true;
          this.body = "";
        }
      }
      if (end >= data.length) break;
      const terminator = data.charCodeAt(end);
      if (terminator === 0x07) {
        this.finish(signals);
        this.state = "ground";
      } else if (terminator === 0x1b) this.state = "oscEscape";
      else this.state = "ground"; // CAN/SUB abort the sequence.
      index = end + 1;
    }
    return signals;
  }

  private finish(signals: TerminalFinishedCandidate[]) {
    const body = this.overflow ? "" : this.body;
    this.body = "";
    this.overflow = false;
    if (body === AGENT_DONE_BODY) {
      signals.push({ atMs: this.now(), exitCode: null, durationMs: null, source: "agent-hook" });
      return;
    }
    if (!body.startsWith("133;")) return;
    const [kind, ...params] = body.slice(4).split(";");
    if (kind === "A" || kind === "B") {
      this.shellIntegrationSeen = true;
      return;
    }
    if (kind === "C") {
      this.shellIntegrationSeen = true;
      const command = commandFromParams(params);
      this.started = { atMs: this.now(), ...(command ? { command } : {}) };
      return;
    }
    if (kind !== "D") return;
    this.shellIntegrationSeen = true;
    const started = this.started;
    this.started = null;
    if (!started) return;
    const status =
      params[0] !== undefined && /^-?\d{1,3}$/.test(params[0]) ? Number(params[0]) : null;
    const atMs = this.now();
    signals.push({
      atMs,
      ...(started.command ? { command: started.command } : {}),
      exitCode: status,
      durationMs: Math.max(0, atMs - started.atMs),
      source: "shell-integration",
    });
  }
}
