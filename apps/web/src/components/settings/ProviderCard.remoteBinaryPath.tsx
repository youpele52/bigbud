import { useState } from "react";
import { isTrustedRemoteExecutablePath } from "@bigbud/shared/remoteExecutablePath";
import { Input } from "../ui/input";

const INPUT_ID = "provider-install-opencodeV2-remote-binary-path";
const ERROR_ID = `${INPUT_ID}-error`;

/** Blank means "unset" (the SSH owner discovers OpenCode); otherwise the owner rule. */
export function remoteBinaryPathError(value: string): string | null {
  if (value.trim() === "") return null;
  return isTrustedRemoteExecutablePath(value)
    ? null
    : "Use an absolute, normalized path on the remote host (for example /usr/local/bin/opencode) with no surrounding spaces.";
}

type ProviderRemoteBinaryPathProps = {
  value: string;
  onChange: (value: string) => void;
};

/**
 * OpenCode v2 executable on SSH targets (`providers.opencodeV2.remoteBinaryPath`).
 * Only blank or trusted values are saved; an invalid draft stays local with an
 * inline error so the server never receives a path the owner would refuse.
 */
export function ProviderRemoteBinaryPath({ value, onChange }: ProviderRemoteBinaryPathProps) {
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  if (value !== savedValue) {
    setSavedValue(value);
    setDraft(value);
  }
  const error = remoteBinaryPathError(draft);

  return (
    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
      <label htmlFor={INPUT_ID} className="block">
        <span className="text-xs font-medium text-foreground">Remote binary path (SSH)</span>
        <Input
          id={INPUT_ID}
          className="mt-1.5"
          value={draft}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? ERROR_ID : undefined}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            if (remoteBinaryPathError(next) !== null) return;
            const saved = next.trim() === "" ? "" : next;
            setSavedValue(saved);
            onChange(saved);
          }}
          placeholder="Optional; blank auto-discovers opencode on the remote host"
          spellCheck={false}
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          Optional. Absolute path of OpenCode on SSH hosts. Leave blank to auto-discover it on the
          remote host (login PATH, then common install folders). The local binary path is
          unaffected.
        </span>
        {error ? (
          <span id={ERROR_ID} role="alert" className="mt-1 block text-xs text-destructive">
            {error}
          </span>
        ) : null}
      </label>
    </div>
  );
}
