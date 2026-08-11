import type { ServerProvider } from "@bigbud/contracts";

const labels: Record<ServerProvider["provider"], string> = {
  claudeAgent: "Claude",
  cliProxy: "CLIProxyAPI",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
  devin: "Devin",
  kilocode: "KiloCode",
  opencode: "OpenCode",
  pi: "Pi",
};

export interface ProviderToastState {
  readonly sawRecovery: boolean;
  readonly notifiedInitialFailure: boolean;
}

export interface ProviderToastDecision {
  readonly state: ProviderToastState;
  readonly kind: "none" | "recovery" | "attention" | "success";
  readonly affected: ReadonlyArray<ServerProvider>;
  readonly operationId?: string;
  readonly title?: string;
  readonly description?: string;
}

const names = (providers: ReadonlyArray<ServerProvider>) =>
  providers.map((provider) => labels[provider.provider]).join(", ");

const needsAttention = (provider: ServerProvider) =>
  provider.enabled && provider.failure !== undefined;

export function getProviderToastDecision(
  providers: ReadonlyArray<ServerProvider>,
  state: ProviderToastState,
): ProviderToastDecision {
  const recovering = providers.filter(
    (provider) => provider.enabled && provider.recovery?.status === "retrying",
  );
  if (recovering.length > 0) {
    const prioritized =
      recovering.find((provider) => provider.recovery?.trigger === "manual") ?? recovering[0]!;
    const operationId = prioritized.recovery!.operationId;
    const operationProviders = recovering.filter(
      (provider) => provider.recovery?.operationId === operationId,
    );
    const attempt = Math.max(...operationProviders.map((provider) => provider.recovery!.attempt));
    const maxAttempts = Math.max(
      ...operationProviders.map((provider) => provider.recovery!.maxAttempts),
    );
    const manual = prioritized.recovery!.trigger === "manual";
    const background = operationProviders.some(
      (provider) => provider.recovery!.trigger === "background",
    );
    return {
      state: { ...state, sawRecovery: true },
      kind: "recovery",
      affected: operationProviders,
      operationId,
      title: manual
        ? "Retrying providers"
        : background
          ? "Some providers still need another moment"
          : "Starting providers",
      description: manual
        ? `bigbud is checking ${names(operationProviders)} again (attempt ${attempt} of ${maxAttempts}).`
        : background
          ? `bigbud is retrying ${names(operationProviders)} in the background (attempt ${attempt} of ${maxAttempts}). You can keep working.`
          : `bigbud is checking ${names(operationProviders)} again during launch (attempt ${attempt} of ${maxAttempts}).`,
    };
  }
  const failed = providers.filter(needsAttention);
  if (failed.length > 0 && (!state.notifiedInitialFailure || state.sawRecovery)) {
    const userAction = failed.filter(
      (provider) => provider.failure?.classification === "user-action-required",
    );
    const retryable = failed.filter((provider) => provider.failure?.classification === "retryable");
    return {
      state: { ...state, notifiedInitialFailure: true },
      kind: "attention",
      affected: failed,
      ...(failed.find((provider) => provider.recovery)?.recovery?.operationId
        ? { operationId: failed.find((provider) => provider.recovery)!.recovery!.operationId }
        : {}),
      title:
        userAction.length > 0
          ? "Some providers need your attention"
          : "Some providers still need attention",
      description:
        userAction.length > 0 && retryable.length > 0
          ? `${names(userAction)} need an update in provider settings. bigbud couldn’t start ${names(retryable)} after retrying.`
          : userAction.length > 0
            ? `${names(userAction)} need an update in provider settings before they can start.`
            : `${names(failed)} couldn’t be started. Review their provider settings.`,
    };
  }
  if (state.sawRecovery) {
    return {
      state: { ...state, sawRecovery: false },
      kind: "success",
      affected: [],
      title: "Providers are ready",
      description: "bigbud started the providers that needed another moment.",
    };
  }
  return { state, kind: "none", affected: [] };
}
