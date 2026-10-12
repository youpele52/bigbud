import { Switch } from "../ui/switch";
import { Input } from "../ui/input";

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
      <p id="opencode-native-trust-description" className="text-xs text-muted-foreground">
        Connect to your existing native accounts and configuration. Activating a workspace may load
        or install already-configured native plugins. Chat writes native session history; native
        tools and plugins run as your user, not in a bigbud sandbox. Identical copied histories
        count as the same logical history. Revoking consent stops new bigbud requests, but does not
        prove native work stopped.
      </p>
      <div className="flex items-center justify-between gap-3 text-sm">
        <label htmlFor="opencode-native-trust">Trust native service execution</label>
        <Switch
          id="opencode-native-trust"
          checked={consented}
          onCheckedChange={onConsentChange}
          aria-label="Trust native service execution"
          aria-describedby="opencode-native-trust-description"
        />
      </div>
      <label className="block text-xs">
        Native service registration file (optional)
        <Input
          className="mt-1.5"
          value={serviceFile}
          onChange={(event) => onServiceFileChange?.(event.target.value)}
          placeholder="Default native service registration"
          aria-label="Native service registration file"
          spellCheck={false}
        />
      </label>
    </div>
  );
}
