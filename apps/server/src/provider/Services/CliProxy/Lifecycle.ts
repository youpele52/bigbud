import { ServiceMap } from "effect";

export type CliProxyLaunchStrategy = "homebrew" | "systemd-user" | "direct" | "none";

export type CliProxyCommandResult =
  | { readonly _tag: "available" }
  | { readonly _tag: "missing"; readonly command: string }
  | { readonly _tag: "timeout"; readonly command: string }
  | { readonly _tag: "failed"; readonly command: string; readonly detail: string };

export type CliProxyActivationResult =
  | { readonly _tag: "started"; readonly strategy: Exclude<CliProxyLaunchStrategy, "none"> }
  | { readonly _tag: "unavailable"; readonly strategy: "none"; readonly detail: string };

export interface CliProxyLifecycleShape {
  isClaudeRunnable(input: { readonly binaryPath: string }): Promise<CliProxyCommandResult>;
  activate(input: { readonly configPath: string }): Promise<CliProxyActivationResult>;
}

export class CliProxyLifecycle extends ServiceMap.Service<
  CliProxyLifecycle,
  CliProxyLifecycleShape
>()("bigbud/provider/Services/CliProxyLifecycle") {}
