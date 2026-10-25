import { useState } from "react";

import { updateServerSettings, useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";

type CapKey = "maxSubagentSpawnDepth" | "maxConcurrentSubagents";

const CAP_MAX = 64;

/** Empty clears the cap (CLI default); otherwise an integer from 1 to 64, or invalid. */
export function parseSubagentCap(raw: string): number | null | "invalid" {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (!/^\d+$/.test(value)) return "invalid";
  const parsed = Number(value);
  return parsed >= 1 && parsed <= CAP_MAX ? parsed : "invalid";
}

function SubagentCapInput(props: {
  capKey: CapKey;
  label: string;
  description: string;
  value: number | null;
}) {
  const [draft, setDraft] = useState(props.value === null ? "" : String(props.value));
  const parsed = parseSubagentCap(draft);
  const id = `provider-claudeAgent-${props.capKey}`;
  return (
    <label htmlFor={id} className="block">
      <span className="text-xs font-medium text-foreground">{props.label}</span>
      <Input
        id={id}
        className="mt-1.5 text-sm"
        inputMode="numeric"
        value={draft}
        placeholder="CLI default"
        aria-invalid={parsed === "invalid" || undefined}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const cap = parseSubagentCap(next);
          if (cap !== "invalid" && cap !== props.value) {
            updateServerSettings({ providers: { claudeAgent: { [props.capKey]: cap } } });
          }
        }}
      />
      <span
        className={
          parsed === "invalid"
            ? "mt-1 block text-xs text-destructive"
            : "mt-1 block text-xs text-muted-foreground"
        }
      >
        {parsed === "invalid" ? `Enter a whole number from 1 to ${CAP_MAX}.` : props.description}
      </span>
    </label>
  );
}

/** Optional Claude Code subagent caps; unset keeps the Claude Code default (6.6). */
export function ClaudeSubagentCapsSettings() {
  const claude = useSettings().providers.claudeAgent;
  return (
    <div className="space-y-3 border-t border-border/60 px-4 py-3 sm:px-5">
      <SubagentCapInput
        capKey="maxSubagentSpawnDepth"
        label="Maximum subagent nesting depth"
        description="How deep subagents may start their own subagents. Empty uses the Claude Code default. Applies to new sessions."
        value={claude.maxSubagentSpawnDepth}
      />
      <SubagentCapInput
        capKey="maxConcurrentSubagents"
        label="Maximum concurrent subagents"
        description="How many subagents may run at once. Empty uses the Claude Code default. Applies to new sessions."
        value={claude.maxConcurrentSubagents}
      />
    </div>
  );
}
