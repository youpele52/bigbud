import { beforeEach, describe, it, expect } from "vitest";
import {
  ProjectId,
  ThreadId,
  LOCAL_EXECUTION_TARGET_ID,
} from "@bigbud/contracts/core/baseSchemas.ts";
import type { WorktreeBinding } from "@bigbud/contracts/workspace/worktreeBinding.ts";
import { normalizePersistedDraftThreads } from "./normalizers.store";
import { useComposerDraftStore } from "./composer.store";

const threadId = ThreadId.makeUnsafe("verified-draft"),
  projectId = ProjectId.makeUnsafe("project");
const binding: WorktreeBinding = {
  path: "/trees/physical",
  identity: "1:2",
  repository: "/repo/.git",
  executionTargetId: LOCAL_EXECUTION_TARGET_ID,
  revision: 42,
};

describe("persisted draft worktree binding", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      draftsByThreadId: {},
    });
  });
  it("preserves target, identity and revision through persistence and unrelated context edits", () => {
    useComposerDraftStore.getState().setDraftThreadContext(threadId, {
      projectId,
      worktreePath: binding.path,
      worktreeBinding: binding,
      branch: "different-branch",
    });
    useComposerDraftStore.getState().setDraftThreadContext(threadId, { branch: "another-branch" });
    const state = useComposerDraftStore.getState();
    const normalized = normalizePersistedDraftThreads(
      JSON.parse(JSON.stringify(state.draftThreadsByThreadId)),
      state.projectDraftThreadIdByProjectId,
    );
    expect(normalized.draftThreadsByThreadId[threadId]?.worktreeBinding).toEqual(binding);
  });
  it("drops identity when changing physical paths, rather than blessing the new path with old proof", () => {
    useComposerDraftStore.getState().setDraftThreadContext(threadId, {
      projectId,
      worktreePath: binding.path,
      worktreeBinding: binding,
    });
    useComposerDraftStore.getState().setDraftThreadContext(threadId, { worktreePath: "/other" });
    expect(
      useComposerDraftStore.getState().getDraftThread(threadId)?.worktreeBinding,
    ).toBeUndefined();
  });
});
