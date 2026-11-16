import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/settings";
import type { ServerConfig } from "@bigbud/contracts/server/server";
import { describe, expect, it, vi } from "vitest";

import {
  currentMobileServerConfig,
  subscribeMobileServerConfig,
  type ScopedMobileServerConfig,
} from "./useMobileServerConfig.logic";

const config: ServerConfig = {
  cwd: "/fixture",
  storage: { notesDir: "/fixture/notes", kanbanDir: "/fixture/kanban" },
  keybindingsConfigPath: "/fixture/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  discovery: { agents: [], skills: [] },
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/fixture/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: { ...DEFAULT_SERVER_SETTINGS, greetingName: "Fixture name" },
};

function fixture() {
  let state: ScopedMobileServerConfig | null = null;
  let listener: (event: unknown) => void = vi.fn();
  const unsubscribe = vi.fn();
  const client = {
    onServerConfigEvent: (callback: typeof listener) => {
      listener = callback;
      return unsubscribe;
    },
  };
  const stop = subscribeMobileServerConfig(client, "session-a", (apply) => {
    state = apply(state);
  });
  return {
    client,
    stop,
    unsubscribe,
    state: () => state,
    emit: (event: unknown) => listener(event),
  };
}

describe("mobile server config binding", () => {
  it("hides the previous authorized name synchronously on client or session replacement", () => {
    const source = fixture();
    source.emit({ type: "snapshot", config });
    expect(currentMobileServerConfig(source.state(), source.client, "session-a")).toBe(config);
    expect(currentMobileServerConfig(source.state(), {}, "session-a")).toBeNull();
    expect(currentMobileServerConfig(source.state(), source.client, "session-b")).toBeNull();
    expect(currentMobileServerConfig(source.state(), null, undefined)).toBeNull();
  });

  it("ignores a queued old callback after subscription cleanup", () => {
    const source = fixture();
    source.emit({ type: "snapshot", config });
    const previous = source.state();
    source.stop();
    source.emit({
      type: "snapshot",
      config: { ...config, settings: { ...config.settings, greetingName: "Old host" } },
    });
    expect(source.state()).toBe(previous);
    expect(source.unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps same-binding settings during provider status recovery", () => {
    const source = fixture();
    source.emit({ type: "snapshot", config });
    source.emit({ type: "providerStatuses", payload: { providers: [] } });
    expect(currentMobileServerConfig(source.state(), source.client, "session-a")?.settings).toBe(
      config.settings,
    );
  });

  it("discards an already queued state update when its subscription is replaced", () => {
    let listener: (event: unknown) => void = vi.fn();
    let apply: (previous: ScopedMobileServerConfig | null) => ScopedMobileServerConfig | null =
      vi.fn();
    const client = {
      onServerConfigEvent: (callback: typeof listener) => {
        listener = callback;
        return () => {};
      },
    };
    const stop = subscribeMobileServerConfig(client, "old-session", (queued) => {
      apply = queued;
    });
    listener({ type: "snapshot", config });
    stop();
    const replacement = { client: {}, sessionId: "new-session", config };
    expect(apply(replacement)).toBe(replacement);
  });

  it("cannot treat provider statuses before the new snapshot as configured settings", () => {
    const source = fixture();
    source.emit({ type: "providerStatuses", payload: { providers: [] } });
    expect(currentMobileServerConfig(source.state(), source.client, "session-a")).toBeNull();
    source.emit({ type: "snapshot", config });
    expect(currentMobileServerConfig(source.state(), source.client, "session-a")).toBe(config);
  });
});
