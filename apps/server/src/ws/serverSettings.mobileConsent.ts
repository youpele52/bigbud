import { Effect, Option, ServiceMap } from "effect";
import { ServerSettingsError, type ServerSettings } from "@bigbud/contracts/settings";

export interface MobileSettingsConsentGuard {
  readonly revoke: Effect.Effect<void, Error>;
}

/** Remote host policy, supplied before settings start; never enables durable consent. */
export class ServerSettingsMobileConsentGuard extends ServiceMap.Service<
  ServerSettingsMobileConsentGuard,
  MobileSettingsConsentGuard
>()("bigbud/serverSettings/MobileConsentGuard") {}

export function guardMobileSettingsAcceptance(
  mode: string,
  settingsPath: string,
  guard: Option.Option<MobileSettingsConsentGuard>,
  settings: ServerSettings,
): Effect.Effect<void, ServerSettingsError> {
  if (mode !== "remote" || settings.mobileRemoteControl.enabled) return Effect.void;
  if (Option.isNone(guard))
    return Effect.fail(
      new ServerSettingsError({
        settingsPath,
        detail: "Remote mobile settings require durable consent revocation before acceptance.",
      }),
    );
  return guard.value.revoke.pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "Remote mobile consent revocation did not complete; settings cannot be accepted.",
          cause,
        }),
    ),
  );
}
