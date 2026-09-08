import type {
  CliProxyDiagnostic,
  CliProxyDiagnosticCode,
} from "@bigbud/contracts/server/server.providers.ts";

import type {
  CliProxyActivationResult,
  CliProxyCommandResult,
} from "../../Services/CliProxy/Lifecycle.ts";
import type { CliProxyClientError, CliProxyClientErrorTag } from "./Client.ts";
import type { CliProxyConfigError, CliProxyConfigErrorTag } from "./config.ts";

const diagnostics = {
  "configuration-invalid": {
    classification: "user-action-required",
    action: "review-configuration",
  },
  "credential-missing": { classification: "user-action-required", action: "update-credentials" },
  "claude-cli-unavailable": {
    classification: "user-action-required",
    action: "install-or-configure-claude",
  },
  "cli-proxy-unavailable": { classification: "user-action-required", action: "install-cli-proxy" },
  "service-configuration-unverified": {
    classification: "user-action-required",
    action: "verify-service-configuration",
  },
  "direct-process-configuration-conflict": {
    classification: "user-action-required",
    action: "resolve-process-configuration",
  },
  "startup-failed": { classification: "retryable", action: "retry-activation" },
  "activation-unavailable": { classification: "user-action-required", action: "none" },
  "proxy-not-ready": { classification: "retryable", action: "retry-activation" },
  "authentication-failed": { classification: "user-action-required", action: "update-credentials" },
  "catalog-unavailable": { classification: "retryable", action: "wait-and-refresh" },
  "catalog-invalid": {
    classification: "user-action-required",
    action: "review-proxy-configuration",
  },
  "catalog-empty": { classification: "user-action-required", action: "configure-proxy-models" },
  "selected-model-unavailable": {
    classification: "user-action-required",
    action: "choose-available-model",
  },
} as const satisfies Record<CliProxyDiagnosticCode, Omit<CliProxyDiagnostic, "code">>;

export function cliProxyDiagnostic(code: CliProxyDiagnosticCode): CliProxyDiagnostic {
  return { code, ...diagnostics[code] };
}

export function diagnosticForConfigError(error: CliProxyConfigError): CliProxyDiagnostic {
  return diagnosticForConfigErrorTag(error._tag);
}

export function diagnosticForConfigErrorTag(tag: CliProxyConfigErrorTag): CliProxyDiagnostic {
  return cliProxyDiagnostic(
    tag === "MissingCredential" ? "credential-missing" : "configuration-invalid",
  );
}

export function diagnosticForClientError(error: CliProxyClientError): CliProxyDiagnostic {
  return diagnosticForClientErrorTag(error._tag);
}

export function diagnosticForClientErrorTag(tag: CliProxyClientErrorTag): CliProxyDiagnostic {
  switch (tag) {
    case "HealthProbeFailed":
      return cliProxyDiagnostic("proxy-not-ready");
    case "AuthenticationFailed":
      return cliProxyDiagnostic("authentication-failed");
    case "CatalogRequestFailed":
      return cliProxyDiagnostic("catalog-unavailable");
    case "CatalogMalformed":
      return cliProxyDiagnostic("catalog-invalid");
    case "ModelUnavailable":
      return cliProxyDiagnostic("selected-model-unavailable");
  }
}

export function diagnosticForCommandResult(
  _result: Exclude<CliProxyCommandResult, { readonly _tag: "available" }>,
): CliProxyDiagnostic {
  return cliProxyDiagnostic("claude-cli-unavailable");
}

export function diagnosticForActivationResult(
  result: Exclude<CliProxyActivationResult, { readonly _tag: "started" }>,
): CliProxyDiagnostic {
  switch (result._tag) {
    case "service-configuration-unverified":
      return cliProxyDiagnostic("service-configuration-unverified");
    case "direct-process-configuration-conflict":
      return cliProxyDiagnostic("direct-process-configuration-conflict");
    case "startup-failed":
      return cliProxyDiagnostic("startup-failed");
    case "closed":
      return cliProxyDiagnostic("activation-unavailable");
    case "unavailable":
      return cliProxyDiagnostic("cli-proxy-unavailable");
  }
}
