import { ServiceMap } from "effect";

export type CliProxyLaunchStrategy = "homebrew" | "systemd-user" | "direct" | "none";

export type CliProxyCommandResult =
  | { readonly _tag: "available" }
  | { readonly _tag: "missing" }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "execution-failed" };

export type CliProxyActivationResult =
  | { readonly _tag: "started"; readonly reused: boolean }
  | { readonly _tag: "service-configuration-unverified" }
  | { readonly _tag: "direct-process-configuration-conflict" }
  | { readonly _tag: "startup-failed" }
  | { readonly _tag: "closed" }
  | { readonly _tag: "unavailable" };

export interface CliProxyLifecycleShape {
  isClaudeRunnable(input: { readonly binaryPath: string }): Promise<CliProxyCommandResult>;
  activate(input: { readonly configPath: string }): Promise<CliProxyActivationResult>;
}

export class CliProxyLifecycle extends ServiceMap.Service<
  CliProxyLifecycle,
  CliProxyLifecycleShape
>()("bigbud/provider/Services/CliProxyLifecycle") {}
