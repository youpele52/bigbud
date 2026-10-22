import { Input } from "../ui/input";
import type { RemoteProjectDraft, UpdateRemoteProjectDraft } from "./Sidebar.projects.logic";

export type RemoteProjectFieldErrors = Partial<
  Record<"displayName" | "host" | "username" | "port" | "workspaceRoot" | "sshKeyPath", string>
>;

export const remoteProjectInputClassName =
  "mt-1.5 flex border-border bg-card font-sans has-focus-visible:border-ring/45 has-focus-visible:ring-0 [&_input]:placeholder:text-xs [&_input]:placeholder:tracking-normal";

export function FieldError({ message }: { message: string | undefined }) {
  if (!message) {
    return null;
  }
  return <p className="text-destructive text-xs leading-4">{message}</p>;
}

export function RemoteProjectOptionButton({
  active,
  disabled = false,
  description,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  description: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      className={`rounded-xl border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 ${
        active
          ? "border-primary/35 bg-primary/8 text-foreground shadow-xs/5"
          : "border-border/70 bg-muted/24 text-foreground/90 hover:bg-accent/50"
      }`}
      onClick={onClick}
    >
      <div className="text-sm font-medium">{label}</div>
      <div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div>
    </button>
  );
}

interface DraftSectionProps {
  draft: RemoteProjectDraft;
  onFieldChange: UpdateRemoteProjectDraft;
}

/** Shown in both connection sources: how bigbud works with the machine once it is found. */
export function RemoteProjectConnectionOptions({ draft, onFieldChange }: DraftSectionProps) {
  return (
    <>
      <div className="space-y-2">
        <div className="text-xs font-medium text-foreground">Connection method</div>
        <p className="text-muted-foreground text-xs leading-4">
          Direct SSH runs each operation over SSH without installing an agent. The bigbud remote
          agent keeps remote terminals and long-running work available through reconnects. This
          choice is independent of where the provider runtime runs.
        </p>
        <div aria-label="Connection method" className="grid gap-2 sm:grid-cols-2" role="group">
          <RemoteProjectOptionButton
            active={draft.remoteTransport === "direct-ssh"}
            description="Uses your existing SSH setup without an agent."
            label="Direct SSH"
            onClick={() => onFieldChange("remoteTransport", "direct-ssh")}
          />
          <RemoteProjectOptionButton
            active={draft.remoteTransport === "agent"}
            description="Requires installation on the remote host."
            label="bigbud remote agent"
            onClick={() => onFieldChange("remoteTransport", "agent")}
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium text-foreground">Provider runtime</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <RemoteProjectOptionButton
            active={draft.providerRuntimeLocation === "local"}
            description="Run the provider on this machine while using the remote workspace."
            label="Local runtime"
            onClick={() => onFieldChange("providerRuntimeLocation", "local")}
          />
          <RemoteProjectOptionButton
            active={draft.providerRuntimeLocation === "remote"}
            description="Run the provider CLI on the remote host. Requires the CLI and auth there."
            label="Remote runtime"
            onClick={() => onFieldChange("providerRuntimeLocation", "remote")}
          />
        </div>
      </div>
    </>
  );
}

/** Manual mode shows this inline; SSH-config mode shows it under Advanced as an override. */
export function RemoteProjectAuthenticationFields({ draft, onFieldChange }: DraftSectionProps) {
  return (
    <>
      <div className="space-y-2">
        <div className="text-xs font-medium text-foreground">Authentication</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <RemoteProjectOptionButton
            active={draft.authMode === "ssh-key"}
            description="Leave the key path blank to use your SSH agent or default identities."
            label="SSH key"
            onClick={() => onFieldChange("authMode", "ssh-key")}
          />
          <RemoteProjectOptionButton
            active={draft.authMode === "password"}
            description="Prompt for the SSH password when the remote target needs reconnecting."
            label="Password"
            onClick={() => onFieldChange("authMode", "password")}
          />
        </div>
      </div>

      {draft.authMode === "ssh-key" ? (
        <label htmlFor="remote-project-key" className="block">
          <span className="text-xs font-medium text-foreground">SSH key path</span>
          <Input
            id="remote-project-key"
            className={remoteProjectInputClassName}
            placeholder="Leave blank to use your SSH agent or defaults or e.g. ~/.ssh/id_ed25519"
            spellCheck={false}
            value={draft.sshKeyPath}
            onChange={(event) => onFieldChange("sshKeyPath", event.target.value)}
          />
          <p className="mt-1.5 text-muted-foreground text-xs leading-4">
            Optional. When set, bigbud uses only this key for the connection.
          </p>
        </label>
      ) : null}
    </>
  );
}
