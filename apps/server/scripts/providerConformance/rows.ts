/**
 * Row definitions for the provider conformance harness (WP-5D, M4 "nine-provider conformance
 * per tuple"). Each row ends as exactly one of:
 *
 * - `pass`: the behaviour was observed through the client socket.
 * - `fail`: it was attempted and not observed; the reason says what was missing.
 * - `unsupported-by-provider`: only where `DECLARED_UNSUPPORTED` cites the adapter's own
 *   declaration, or the tuple has no bigbud artifact (`unsupported` provisioning state).
 * - `not-run`: a prerequisite was missing (needs auth, disabled, not selected, dry run).
 *
 * Prompts are fixed. The report may name them; it never records model output.
 */
export const PROVIDERS = [
  "codex",
  "claudeAgent",
  "cliProxy",
  "copilot",
  "cursor",
  "devin",
  "muse",
  "opencodeV2",
  "pi",
] as const;
export type Provider = (typeof PROVIDERS)[number];

export const ROW_IDS = [
  "install-reuse",
  "auth-state",
  "text-turn",
  "attachment",
  "tool-use",
  "approval",
  "question",
  "cancel",
  "disconnect-replay",
  "duplicate-receipt",
  "version-rejection",
] as const;
export type RowId = (typeof ROW_IDS)[number];

export type RowStatus = "pass" | "fail" | "unsupported-by-provider" | "not-run";

/** Non-secret facts only: enums, counts, booleans. Strings are redacted again on output. */
export type Evidence = Readonly<Record<string, string | number | boolean | null>>;

export interface RowResult {
  readonly row: RowId;
  /** A provider kind, or `backend` for rows that do not depend on the provider. */
  readonly provider: Provider | "backend";
  readonly status: RowStatus;
  readonly reason: string;
  readonly evidence: Evidence;
  readonly durationMs: number;
}

export interface RowDefinition {
  readonly id: RowId;
  readonly scope: "provider" | "backend";
  readonly title: string;
  /** Needs a working session (provider `ready`). */
  readonly needsSession: boolean;
}

export const ROWS: ReadonlyArray<RowDefinition> = [
  { id: "install-reuse", scope: "provider", title: "Install reuse", needsSession: false },
  { id: "auth-state", scope: "provider", title: "Auth required/expired", needsSession: false },
  { id: "text-turn", scope: "provider", title: "Plain text turn", needsSession: true },
  { id: "attachment", scope: "provider", title: "Attachment", needsSession: true },
  { id: "tool-use", scope: "provider", title: "Tool use", needsSession: true },
  { id: "approval", scope: "provider", title: "Approval", needsSession: true },
  { id: "question", scope: "provider", title: "Question", needsSession: true },
  { id: "cancel", scope: "provider", title: "Cancel", needsSession: true },
  { id: "disconnect-replay", scope: "provider", title: "Disconnect + replay", needsSession: true },
  { id: "duplicate-receipt", scope: "provider", title: "Duplicate receipt", needsSession: true },
  { id: "version-rejection", scope: "backend", title: "Version rejection", needsSession: false },
];

/**
 * Where the plan allows `unsupported-by-provider`: the adapter itself declares the gap. A row
 * not listed here must pass for the provider to conform.
 */
export const DECLARED_UNSUPPORTED: Partial<Record<RowId, Partial<Record<Provider, string>>>> = {
  attachment: {
    muse: "Muse Code accepts no attachments in bigbud (packages/shared/src/providerAttachments.ts)",
  },
  approval: {
    pi: "Pi adapter exposes no separate approval requests (provider/Layers/Pi/Adapter.methods.ts)",
  },
};

/** Fixed test prompts. `{token}` is replaced by a per-run nonce that never reaches the report. */
export const PROMPTS = {
  text: "bigbud conformance check (text). Reply with exactly this token and nothing else: {token}",
  attachment:
    "bigbud conformance check (attachment). The attached file bigbud-conformance-attachment.txt " +
    "contains one token. Reply with that token only.",
  tool:
    "bigbud conformance check (tool). Use your shell or file-reading tool to read the file " +
    "bigbud-conformance-tool.txt in the workspace, then reply with the token it contains.",
  approval:
    "bigbud conformance check (approval). Run the shell command `cat bigbud-conformance-approval.txt` " +
    "in the workspace and reply with its output.",
  question:
    "bigbud conformance check (question). Before anything else, use your tool for asking the user " +
    "a multiple-choice question: ask which colour to use, with exactly the options blue and green. " +
    "After I answer, reply with the chosen colour only.",
  cancel:
    "bigbud conformance check (cancel). Count from 1 to 500, one number per line, nothing else.",
  replay:
    "bigbud conformance check (replay). Write the numbers 1 to 40 separated by spaces, then the " +
    "token {token}.",
  duplicate: "bigbud conformance check (duplicate). Reply with exactly this token: {token}",
} as const;
export type PromptId = keyof typeof PROMPTS;

export const prompt = (id: PromptId, token = "") => PROMPTS[id].replace("{token}", token);

export function selectRows(list: string | undefined): ReadonlyArray<RowDefinition> {
  if (!list) return ROWS;
  const wanted = list.split(",").map((entry) => entry.trim());
  for (const id of wanted)
    if (!ROW_IDS.includes(id as RowId)) throw new Error(`Unknown row ${id}; rows: ${ROW_IDS}.`);
  return ROWS.filter((row) => wanted.includes(row.id));
}

export function selectProviders(list: string | undefined): ReadonlyArray<Provider> {
  if (!list) return PROVIDERS;
  const wanted = list.split(",").map((entry) => entry.trim());
  for (const id of wanted)
    if (!PROVIDERS.includes(id as Provider))
      throw new Error(`Unknown provider ${id}; providers: ${PROVIDERS}.`);
  return PROVIDERS.filter((provider) => wanted.includes(provider));
}

export function result(
  row: RowId,
  provider: RowResult["provider"],
  status: RowStatus,
  reason: string,
  evidence: Evidence = {},
  durationMs = 0,
): RowResult {
  return { row, provider, status, reason, evidence, durationMs: Math.round(durationMs) };
}
