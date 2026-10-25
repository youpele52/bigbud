import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import { GitCommandError } from "../workspace/git.errors";
import {
  WorktreeOperationRecovery,
  WorktreeOperationSummary,
  WorktreeContext,
  WorktreeCreate,
  WorktreeInventory,
  WorktreeMutation,
  WorktreeOperationResult,
  WorktreeSelection,
} from "../workspace/worktrees";

export const WsWorktreeListRpc = Rpc.make("worktrees.list", {
  payload: WorktreeContext,
  success: WorktreeInventory,
  error: GitCommandError,
});
export const WsWorktreeOperationsRpc = Rpc.make("worktrees.operations", {
  payload: WorktreeContext,
  success: Schema.Array(WorktreeOperationSummary),
  error: GitCommandError,
});
export const WsWorktreeRecoverRpc = Rpc.make("worktrees.recover", {
  payload: WorktreeOperationRecovery,
  success: WorktreeOperationSummary,
  error: GitCommandError,
});
export const WsWorktreeCreateRpc = Rpc.make("worktrees.create", {
  payload: WorktreeCreate,
  success: Schema.Struct({ path: Schema.String, branch: Schema.String }),
  error: GitCommandError,
});
export const WsWorktreeDeleteRpc = Rpc.make("worktrees.delete", {
  payload: WorktreeMutation,
  success: WorktreeOperationResult,
  error: GitCommandError,
});
export const WsWorktreeSelectRpc = Rpc.make("worktrees.select", {
  payload: WorktreeSelection,
  success: Schema.Void,
  error: GitCommandError,
});
