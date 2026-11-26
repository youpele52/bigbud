import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { WS_METHODS } from "../constants/websocket.constant";
import {
  GitCommandError,
  GitExecutionTargetError,
  GitGetCommitFileDiffInput,
  GitGetCommitFileDiffResult,
} from "../workspace/git";

/** One file's patch of one commit, loaded on demand with a per-file byte cap. */
export const WsGitGetCommitFileDiffRpc = Rpc.make(WS_METHODS.gitGetCommitFileDiff, {
  payload: GitGetCommitFileDiffInput,
  success: GitGetCommitFileDiffResult,
  error: Schema.Union([GitCommandError, GitExecutionTargetError]),
});
