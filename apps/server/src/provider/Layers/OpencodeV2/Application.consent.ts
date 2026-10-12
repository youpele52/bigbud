import { resolveOpencodeV2ConnectionMode } from "@bigbud/shared/serverSettings";
import type { ServerSettingsShape } from "../../../ws/serverSettings.ts";
import { v2ApplicationConfigKey } from "./Application.configKey.ts";

export interface V2ConsentPermit {
  readonly revision: number;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly release: () => void;
}

/** Synchronous accepted-settings authority. Revocation cancels clients, not native execution. */
export class V2ConsentAuthority {
  private revision = 0;
  private key = "";
  private closed = false;
  private readonly pending = new Set<AbortController>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly settings: Pick<ServerSettingsShape, "currentSnapshot" | "onSnapshotChange">,
  ) {
    this.accept();
    this.unsubscribe = settings.onSnapshotChange?.(() => this.accept()) ?? (() => {});
  }

  private accept() {
    const config = this.settings.currentSnapshot?.()?.settings.providers.opencodeV2;
    const key = config
      ? JSON.stringify([
          config.enabled,
          v2ApplicationConfigKey(config),
          config.nativeServiceTrust ?? null,
        ])
      : "";
    if (key === this.key) return;
    this.key = key;
    this.revision++;
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }

  capture(healthOnly = false): V2ConsentPermit {
    const config = this.settings.currentSnapshot?.()?.settings.providers.opencodeV2;
    if (
      this.closed ||
      !config?.enabled ||
      (!healthOnly &&
        resolveOpencodeV2ConnectionMode(config) === "shared" &&
        config.nativeServiceTrust !== "host-user-v1")
    )
      throw new Error(
        "V2 native service trust consent is required; no Location activation or execution.",
      );
    const revision = this.revision;
    const controller = new AbortController();
    this.pending.add(controller);
    return {
      revision,
      signal: controller.signal,
      assertCurrent: () => {
        if (this.closed || revision !== this.revision || controller.signal.aborted)
          throw new Error(
            "V2 consent/configuration revision changed; late dispatch/publication rejected.",
          );
      },
      release: () => {
        this.pending.delete(controller);
      },
    };
  }

  close() {
    this.closed = true;
    this.unsubscribe();
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }
}
