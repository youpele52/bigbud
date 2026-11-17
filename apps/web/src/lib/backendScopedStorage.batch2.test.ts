import { ProjectId } from "@bigbud/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSpyStorage,
  IDENTITY_A,
  installWindow,
  PREFIX_A,
  touchedKeys,
  type SpyStorage,
} from "./backendScopedStorage.test.helpers";

async function openBoundWindow(storage: SpyStorage) {
  vi.resetModules();
  installWindow(storage, "?backend=prof-a");
  const scoped = await import("./backendScopedStorage");
  scoped.setBackendStorageIdentity(IDENTITY_A);
  return scoped;
}

afterEach(() => vi.unstubAllGlobals());

describe("backend-scoped stores (batch 2)", () => {
  it("reconnect requests stay with their backend", async () => {
    const local = [{ requestId: "local", projectId: "p", projectName: "L" }];
    const storage = createSpyStorage({
      "bigbud:remote-reconnect-requests": JSON.stringify(local),
    });
    await openBoundWindow(storage);
    const reconnect =
      await import("../components/sidebar/Sidebar.projectActions.reconnect.persistence");
    expect(reconnect.readReconnectRequests()).toEqual([]);
    reconnect.saveReconnectRequest({
      requestId: "remote",
      projectId: ProjectId.makeUnsafe("p"),
      projectName: "R",
      expectedWorkspaceExecutionTargetId: "target",
    });
    expect(reconnect.readReconnectRequests().map((entry) => entry.requestId)).toEqual(["remote"]);
    expect(JSON.parse(storage.entries.get("bigbud:remote-reconnect-requests")!)).toEqual(local);
    expect(touchedKeys(storage).every((key) => key.startsWith(PREFIX_A))).toBe(true);
  });

  it("recently used models are recorded per backend, legacy keys untouched", async () => {
    const storage = createSpyStorage({
      "bigbud:recently-used-models:v1": JSON.stringify([
        { provider: "codex", model: "local-model", lastUsedAt: "2026-01-01T00:00:00.000Z" },
      ]),
    });
    await openBoundWindow(storage);
    const recents = await import("../models/recentlyUsedModels");
    expect(recents.getRecentlyUsedModels("codex")).toEqual([]);
    recents.recordModelUsage("codex", "gpt-5");
    expect(recents.getRecentlyUsedModels("codex").map((entry) => entry.model)).toEqual(["gpt-5"]);
    expect(storage.entries.has("bigbud:recently-used-models:v1")).toBe(true);
    expect(touchedKeys(storage).every((key) => key.startsWith(PREFIX_A))).toBe(true);
  });

  it("advisory dismissal and admission ids live under the backend prefix", async () => {
    const storage = createSpyStorage();
    await openBoundWindow(storage);
    const advisory =
      await import("../components/chat/provider/ProviderStatusBanner.advisory.state");
    const admission = await import("../stores/remoteAccess/remoteAgentAdmissionRequest");
    advisory.createRetainedHistoryAdvisoryState().dismiss();
    const requestId = admission.getRemoteAgentAdmissionRequestId("target-1");

    expect(storage.entries.get(`${PREFIX_A}${advisory.RETAINED_HISTORY_DISMISSAL_KEY}`)).toBe(
      "true",
    );
    expect(admission.readRemoteAgentAdmissionRequestId("target-1")).toBe(requestId);
    expect([...storage.entries.keys()].every((key) => key.startsWith(PREFIX_A))).toBe(true);
  });
});
