import type {
  SessionMessageInfo,
  SessionMessageAssistant,
  SessionMessageIdle,
} from "@opencode/client";

export interface V2TurnProjection {
  readonly assistants: SessionMessageAssistant[];
  readonly idle: SessionMessageIdle | undefined;
  readonly terminalOutcome?: SessionMessageIdle["outcome"];
  readonly background?: { readonly shellIds: readonly string[]; readonly pending: number };
}

// Only these direct native tools are covered by the shell continuation contract. Code-mode,
// subagents and custom tools can hide background work; they need their own provenance proof.
const directTools = new Set(["shell", "read", "glob", "grep"]);

/** Scan delivered native input, including exact owned shell notifications across busy periods. */
export function projectV2TurnInterval(
  messages: readonly SessionMessageInfo[],
  nativeCompletions?: ReadonlySet<string>,
): V2TurnProjection | undefined {
  const assistants: SessionMessageAssistant[] = [];
  const shells = new Set<string>(),
    pending = new Set<string>();
  let idle: SessionMessageIdle | undefined;
  let outcome: SessionMessageIdle["outcome"] | undefined;
  let unsupportedTool = false;
  let unconfirmedShell = false;
  const result = (): V2TurnProjection => ({
    assistants,
    idle: pending.size ? undefined : idle,
    ...(outcome ? { terminalOutcome: outcome } : {}),
    ...(shells.size ? { background: { shellIds: [...shells], pending: pending.size } } : {}),
  });
  for (const message of messages) {
    if (message.type === "user") return idle && !pending.size ? result() : undefined;
    if (message.type === "shell" || message.type === "skill") return undefined;
    if (message.type === "synthetic") {
      if (nativeCompletions?.has(message.id)) {
        idle = undefined;
        continue;
      }
      const metadata = message.metadata;
      const id = metadata?.shellID;
      if (
        unsupportedTool ||
        metadata?.source !== "shell" ||
        typeof id !== "string" ||
        metadata.jobID !== id ||
        !pending.has(id) ||
        !["completed", "error", "cancelled"].includes(String(metadata.state))
      )
        return undefined;
      pending.delete(id);
      idle = undefined; // A delivered notification must have its own subsequent terminal marker.
    }
    if (message.type === "assistant") {
      if (idle) return undefined; // No attributed input justified a new busy period.
      assistants.push(message);
      for (const part of message.content) {
        if (part.type !== "tool") continue;
        if (!directTools.has(part.name)) unsupportedTool = true;
        if (
          part.name === "shell" &&
          (part.state.status !== "completed" ||
            !["running", "completed"].includes(String(part.state.metadata?.status)))
        )
          unconfirmedShell = true;
        if (
          part.name !== "shell" ||
          part.state.status !== "completed" ||
          part.state.metadata?.status !== "running"
        )
          continue;
        const id = part.state.metadata.shellID;
        if (
          typeof id !== "string" ||
          !/^sh_[A-Za-z0-9_-]{1,100}$/.test(id) ||
          shells.has(id) ||
          shells.size >= 64
        )
          return undefined;
        shells.add(id);
        pending.add(id);
      }
      if (shells.size && (unsupportedTool || unconfirmedShell)) return undefined;
    }
    if (message.type === "idle") {
      idle = message;
      outcome =
        outcome === "interrupted" || message.outcome === "interrupted"
          ? "interrupted"
          : outcome === "failed" || message.outcome === "failed"
            ? "failed"
            : "succeeded";
      if (!shells.size && !nativeCompletions?.size) return result(); // Preserve ordinary one-input interval behavior.
    }
  }
  return result();
}
