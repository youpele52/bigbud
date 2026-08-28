import type {
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitListBranchesInput,
  GitListBranchesResult,
  GitServiceError,
} from "@bigbud/contracts";
import { Effect } from "effect";

export type BootstrapGit = {
  readonly createWorktree: (
    input: GitCreateWorktreeInput,
  ) => Effect.Effect<GitCreateWorktreeResult, GitServiceError>;
  readonly listBranches: (
    input: GitListBranchesInput,
  ) => Effect.Effect<GitListBranchesResult, GitServiceError>;
};

const registeredWorktrees = (result: GitListBranchesResult, branch: string) =>
  result.branches.flatMap((candidate) =>
    candidate.name === branch && candidate.worktreePath !== null
      ? [{ worktree: { branch, path: candidate.worktreePath } }]
      : [],
  );

export const ensureBootstrapWorktree = Effect.fn("ensureBootstrapWorktree")(function* (input: {
  readonly git: BootstrapGit;
  readonly createInput: GitCreateWorktreeInput;
  readonly branch: string;
  readonly expectedPath?: string;
  readonly canonicalizePath?: (path: string) => Effect.Effect<string | null>;
}) {
  const listInput = {
    cwd: input.createInput.cwd,
    ...(input.createInput.executionTargetId
      ? { executionTargetId: input.createInput.executionTargetId }
      : {}),
    query: input.branch,
    limit: 200,
  } satisfies GitListBranchesInput;
  const inspect = input.git.listBranches(listInput).pipe(
    Effect.flatMap((result) => {
      const candidates = registeredWorktrees(result, input.branch);
      if (!input.expectedPath) return Effect.succeed(candidates[0] ?? null);
      if (!input.canonicalizePath) return Effect.succeed(null);
      return Effect.gen(function* () {
        const expected = yield* input.canonicalizePath!(input.expectedPath!);
        if (!expected) return null;
        for (const candidate of candidates) {
          const registered = yield* input.canonicalizePath!(candidate.worktree.path);
          if (registered === expected) return candidate;
        }
        return null;
      });
    }),
  );
  const existing = yield* inspect;
  if (existing) return existing;

  return yield* input.git.createWorktree(input.createInput).pipe(
    Effect.catch((createError) =>
      inspect.pipe(
        Effect.mapError(() => createError),
        Effect.flatMap((createdDespiteError) =>
          createdDespiteError ? Effect.succeed(createdDespiteError) : Effect.fail(createError),
        ),
      ),
    ),
  );
});
