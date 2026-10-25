/** Read-only main-process policy. Setting intent is not observed GPU availability. */
export interface TerminalRenderingPolicy {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly webglFeatureStatus: string;
}
