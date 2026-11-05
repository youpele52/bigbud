import { open, unlink, writeFile } from "node:fs/promises";
import { renameSync } from "node:fs";
import { Schema } from "effect";
import {
  ResourcePreferences,
  ResourceRuleMutation,
} from "@bigbud/contracts/system-monitor/awareness.ts";
import {
  changeResourcePreferences,
  defaultResourcePreferences,
  validateResourceRule,
} from "@bigbud/shared/resourceAwareness.preferences";

/** Owns the serialized revision-check/write/publish transaction for all transports. */
export class ResourcePreferencesStore {
  value = defaultResourcePreferences();
  diagnostic: string | undefined;
  cooldowns: Record<string, number> = {};
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private lastMutation = "";
  private preserveOriginal = false;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const file = await open(this.path, "r");
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await file.read(buffer).finally(() => file.close());
      if (bytesRead > 65536) throw new Error("preferences too large");
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const parsed = JSON.parse(text);
      const value = Schema.decodeUnknownSync(ResourcePreferences)(parsed);
      value.rules.forEach(validateResourceRule);
      if (new Set(value.rules.map((rule) => rule.id)).size !== value.rules.length)
        throw new Error("duplicate rule IDs");
      this.value = value;
      if (
        typeof parsed.lastMutation === "string" &&
        Buffer.byteLength(parsed.lastMutation) <= 16384
      )
        this.lastMutation = parsed.lastMutation;
      if (parsed.cooldowns && typeof parsed.cooldowns === "object") {
        this.cooldowns = Object.fromEntries(
          Object.entries(parsed.cooldowns)
            .slice(-256)
            .filter(
              ([key, value]) =>
                key.length <= 512 && typeof value === "number" && Number.isFinite(value),
            ) as [string, number][],
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.preserveOriginal = true;
        this.diagnostic =
          "Saved monitoring preferences could not be read; using defaults until explicitly saved.";
      }
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.queued >= 4) return Promise.reject(new Error("monitor settings busy"));
    this.queued++;
    const result = this.tail.then(operation).finally(() => {
      this.queued--;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async write(
    value: ResourcePreferences,
    cooldowns: Record<string, number>,
    authorized: () => boolean,
    lastMutation = this.lastMutation,
  ): Promise<void> {
    const temporary = `${this.path}.tmp`;
    try {
      const text = JSON.stringify({ ...value, cooldowns, lastMutation });
      if (Buffer.byteLength(text) > 65536)
        throw new Error("monitor preferences exceed storage bound");
      await writeFile(temporary, text, { mode: 0o600 });
      if (!authorized()) throw new Error("monitor authorization revoked");
      // Synchronous atomic commit prevents token revocation interleaving with the final fence.
      renameSync(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  mutate(raw: unknown, authorized: () => boolean = () => true): Promise<ResourcePreferences> {
    const mutation = Schema.decodeUnknownSync(ResourceRuleMutation)(raw);
    return this.serialize(async () => {
      if (!authorized()) throw new Error("monitor authorization revoked");
      const fingerprint = JSON.stringify(mutation);
      if (fingerprint === this.lastMutation) return this.value;
      const next = changeResourcePreferences(this.value, mutation, Date.now());
      if (next !== this.value || this.diagnostic) {
        await this.write(next, this.cooldowns, authorized, fingerprint);
        this.value = next;
        this.lastMutation = fingerprint;
        this.preserveOriginal = false;
        this.diagnostic = undefined;
      }
      return this.value;
    });
  }

  saveCooldowns(cooldowns: Record<string, number>): Promise<void> {
    return this.serialize(async () => {
      // A corrupt file is retained until an explicit user mutation, not overwritten by telemetry.
      if (this.preserveOriginal) return;
      await this.write(this.value, cooldowns, () => true);
      this.cooldowns = cooldowns;
      this.diagnostic = undefined;
    });
  }
}
