import { type ProviderKind, type TerminalEvent } from "@bigbud/contracts";

interface ResolveTerminalBaseLabelInput {
  projectName: string | null | undefined;
  cwd: string | null | undefined;
}

export function resolveTerminalBaseLabel(input: ResolveTerminalBaseLabelInput): string {
  const trimmedProjectName = input.projectName?.trim();
  if (trimmedProjectName) {
    return trimmedProjectName;
  }

  const trimmedCwd = input.cwd?.trim();
  if (trimmedCwd) {
    const segments = trimmedCwd.split(/[/\\]/).filter((segment) => segment.length > 0);
    return segments.at(-1) ?? trimmedCwd;
  }

  return "Terminal";
}

export function buildTerminalLabelMap(
  terminalIds: ReadonlyArray<string>,
  baseLabel: string,
  overridesByTerminalId: Readonly<Record<string, string>> = {},
): ReadonlyMap<string, string> {
  return new Map(
    terminalIds.map((terminalId, index) => {
      const fallbackLabel = index === 0 ? baseLabel : `${baseLabel} ${index + 1}`;
      const override = overridesByTerminalId[terminalId]?.trim();
      return [terminalId, override && override.length > 0 ? override : fallbackLabel];
    }),
  );
}

interface ResolveTerminalProviderInput {
  sessionProvider: ProviderKind | null | undefined;
  modelProvider: ProviderKind | null | undefined;
}

export function resolveTerminalProvider(input: ResolveTerminalProviderInput): ProviderKind | null {
  return input.sessionProvider ?? input.modelProvider ?? null;
}

const ANSI_ESCAPE_PATTERN = new RegExp(
  // Matches common CSI and OSC escape sequences emitted by TUI startup banners.
  String.raw`\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])`,
  "g",
);

const TERMINAL_PROVIDER_SIGNATURES: ReadonlyArray<{
  provider: ProviderKind;
  patterns: ReadonlyArray<RegExp>;
}> = [
  {
    provider: "pi",
    patterns: [/\bpi v\d+\.\d+\.\d+\b/i, /press ctrl\+o to show full startup help/i],
  },
  {
    provider: "opencode",
    patterns: [/\bopencode\b/i, /\b@opencode-ai\b/i],
  },
  {
    provider: "codex",
    patterns: [/\bcodex\b/i, /\bopenai codex\b/i],
  },
  {
    provider: "claudeAgent",
    patterns: [/\bclaude\b/i],
  },
  {
    provider: "copilot",
    patterns: [/\bcopilot\b/i, /\bgithub copilot\b/i],
  },
  {
    provider: "cursor",
    patterns: [/\bcursor\b/i],
  },
  {
    provider: "devin",
    patterns: [/\bdevin\b/i],
  },
  {
    provider: "kilocode",
    patterns: [/\bkilocode\b/i, /\bkilo code\b/i],
  },
] as const;

function stripTerminalAnsi(text: string): string {
  return text.replaceAll(ANSI_ESCAPE_PATTERN, "");
}

function readTerminalEventText(event: TerminalEvent): string {
  if (event.type === "output") {
    return event.data;
  }
  if (event.type === "started" || event.type === "restarted") {
    return event.snapshot.history;
  }
  return "";
}

export function resolveTerminalProviderFromEvents(
  events: ReadonlyArray<{ event: TerminalEvent }>,
): ProviderKind | null {
  if (events.length === 0) {
    return null;
  }

  const normalizedText = stripTerminalAnsi(
    events
      .map((entry) => readTerminalEventText(entry.event))
      .join("\n")
      .toLowerCase(),
  );
  if (normalizedText.trim().length === 0) {
    return null;
  }

  for (const signature of TERMINAL_PROVIDER_SIGNATURES) {
    if (signature.patterns.some((pattern) => pattern.test(normalizedText))) {
      return signature.provider;
    }
  }

  return null;
}
