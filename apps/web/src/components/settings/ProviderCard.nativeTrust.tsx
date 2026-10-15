import { Switch } from "../ui/switch";
import { Input } from "../ui/input";
import { ProviderDetails } from "./ProviderDetails";

/** Consent is explicit and revocable; enabling a provider alone never implies host trust. */
export function ProviderNativeTrust({
  consented,
  onConsentChange,
  serviceFile,
  onServiceFileChange,
}: {
  consented: boolean;
  onConsentChange?: ((enabled: boolean) => void) | undefined;
  serviceFile: string;
  onServiceFileChange?: ((file: string) => void) | undefined;
}) {
  return (
    <div className="space-y-3 border-t border-border/60 px-4 py-3 sm:px-5">
      <div className="flex items-center justify-between gap-3 text-sm">
        <div className="space-y-1">
          <label htmlFor="opencode-native-trust" className="font-medium">
            Allow native tools
          </label>
          <p id="opencode-native-trust-description" className="text-xs text-muted-foreground">
            Native tools run as your user, not in a sandbox. Also allows automatic setup of
            bigbud&apos;s required thread-tools plugin. Installation and breaking updates may reload
            plugins.
          </p>
        </div>
        <Switch
          tone="success"
          id="opencode-native-trust"
          checked={consented}
          onCheckedChange={onConsentChange}
          aria-label="Allow native tools"
          aria-describedby="opencode-native-trust-description"
        />
      </div>
      <ProviderDetails label="What this allows">
        <p>
          Activating a workspace may load or install already-configured native plugins. Chat writes
          native session history; native tools and plugins run as your user, not in a bigbud
          sandbox. Identical copied histories count as the same logical history. You also authorize
          automatic installation/upgrades of only bigbud&apos;s required global thread-tools plugin
          entry. Account, model, permission and unrelated plugin configuration stays unchanged;
          bigbud does not reload or restart the native service. Native watching may reload this and
          later plugins on first installation or breaking updates. Automatic best-effort checks wait
          for known busy work but cannot exclude another native client starting work at the same
          time. Compatible broker updates leave native plugin files and registrations unchanged.
          Older host-user acknowledgement did not grant this file-write scope. Revoking consent
          stops new bigbud requests, but does not prove native work stopped.
        </p>
      </ProviderDetails>
      <ProviderDetails label="Connection settings">
        <label className="block text-xs">
          Connection file (optional)
          <Input
            className="mt-1.5"
            value={serviceFile}
            onChange={(event) => onServiceFileChange?.(event.target.value)}
            placeholder="Default native service registration"
            aria-label="Connection file (optional)"
            spellCheck={false}
          />
        </label>
      </ProviderDetails>
    </div>
  );
}
