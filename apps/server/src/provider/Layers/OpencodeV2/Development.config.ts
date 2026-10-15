import type { V2ProcessConfig } from "./ServerManager.child.ts";

/** Ownership marker name for disposable private profiles (see `ProfileIsolation.mjs`). */
export const V2_DEVELOPMENT_MARKER = ".bigbud-opencode-v2-development";
export interface V2DevelopmentConfig {
  readonly process: V2ProcessConfig;
  readonly workspace: string;
}
