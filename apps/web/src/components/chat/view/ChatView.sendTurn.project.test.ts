import { beforeEach, expect, it, vi } from "vitest";

import {
  hydrateSelectedThread,
  runBoundedBootstrap,
} from "../../../routes/-__root.bounded-bootstrap";
import {
  chatsId,
  createProjectGateApi,
  otherId,
  prepareRecentPrompt,
  recentId,
  resetProjectGateStore,
} from "./ThreadProjectGate.test-helpers";

vi.mock("../../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
beforeEach(resetProjectGateStore);

it("explains a missing Recent project instead of silently swallowing send, preserving the prompt", async () => {
  const { api } = createProjectGateApi();
  await runBoundedBootstrap({ api, selectedThreadId: otherId, disposed: () => false });
  await hydrateSelectedThread({ api, threadId: recentId });
  const { result, promptRef, setThreadError, resetComposerDraft } = await prepareRecentPrompt(api);
  expect(result).toBeNull();
  expect(setThreadError).toHaveBeenCalledWith(
    recentId,
    expect.stringContaining("project is not loaded"),
  );
  expect(promptRef.current).toBe("Synthetic follow-up");
  expect(resetComposerDraft).not.toHaveBeenCalled();
});

it("still prepares stopped-session follow-ups when direct bootstrap has prioritized their project", async () => {
  const { api, orchestration } = createProjectGateApi();
  await runBoundedBootstrap({ api, selectedThreadId: recentId, disposed: () => false });
  expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledWith({
    scope: "local",
    limit: 2,
    priorityProjectId: chatsId,
  });
  expect((await prepareRecentPrompt(api)).result?.outgoingMessageText).toContain(
    "Synthetic follow-up",
  );
});
