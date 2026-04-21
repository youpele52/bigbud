/**
 * Pull-request creation step for GitManager stacked actions.
 *
 * Accepts service instances as parameters to remain decoupled from the
 * Effect service layer.
 *
 * @module GitManager.prStep
 */
import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Path } from "effect";

import type { ModelSelection } from "@bigbud/contracts";

import type { GitCoreShape } from "../Services/GitCore.ts";
import type { GitHubCliShape } from "../Services/GitHubCli.ts";
import type { TextGenerationShape } from "../Services/TextGeneration.ts";
import { limitContext } from "./GitManager.commitUtils.ts";
import { gitManagerError } from "./GitManager.prUtils.ts";
import type { GitActionProgressEmitter } from "./GitManager.types.ts";
import type { makeBranchContext } from "./GitManager.branchContext.ts";
import type { makePrLookup } from "./GitManager.prLookup.ts";

export function makePrStep(
  gitCore: GitCoreShape,
  gitHubCli: GitHubCliShape,
  textGeneration: TextGenerationShape,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  branchContext: ReturnType<typeof makeBranchContext>,
  prLookup: ReturnType<typeof makePrLookup>,
) {
  const { resolveBranchHeadContext, resolveBaseBranch } = branchContext;
  const { findOpenPr } = prLookup;
  const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

  const runPrStep = Effect.fn("runPrStep")(function* (
    modelSelection: ModelSelection,
    cwd: string,
    fallbackBranch: string | null,
    emit: GitActionProgressEmitter,
  ) {
    const details = yield* gitCore.statusDetails(cwd);
    const branch = details.branch ?? fallbackBranch;
    if (!branch) {
      return yield* gitManagerError(
        "runPrStep",
        "Cannot create a pull request from detached HEAD.",
      );
    }
    if (!details.hasUpstream) {
      return yield* gitManagerError(
        "runPrStep",
        "Current branch has not been pushed. Push before creating a PR.",
      );
    }

    const headContext = yield* resolveBranchHeadContext(cwd, {
      branch,
      upstreamRef: details.upstreamRef,
    });

    const existing = yield* findOpenPr(cwd, headContext);
    if (existing) {
      return {
        status: "opened_existing" as const,
        url: existing.url,
        number: existing.number,
        baseBranch: existing.baseRefName,
        headBranch: existing.headRefName,
        title: existing.title,
      };
    }

    const baseBranch = yield* resolveBaseBranch(cwd, branch, details.upstreamRef, headContext);
    yield* emit({
      kind: "phase_started",
      phase: "pr",
      label: "Generating PR content...",
    });
    const rangeContext = yield* gitCore.readRangeContext(cwd, baseBranch);

    const generated = yield* textGeneration.generatePrContent({
      cwd,
      baseBranch,
      headBranch: headContext.headBranch,
      commitSummary: limitContext(rangeContext.commitSummary, 20_000),
      diffSummary: limitContext(rangeContext.diffSummary, 20_000),
      diffPatch: limitContext(rangeContext.diffPatch, 60_000),
      modelSelection,
    });

    const bodyFile = path.join(tempDir, `t3code-pr-body-${process.pid}-${randomUUID()}.md`);
    yield* fileSystem
      .writeFileString(bodyFile, generated.body)
      .pipe(
        Effect.mapError((cause) =>
          gitManagerError("runPrStep", "Failed to write pull request body temp file.", cause),
        ),
      );
    yield* emit({
      kind: "phase_started",
      phase: "pr",
      label: "Creating GitHub pull request...",
    });
    yield* gitHubCli
      .createPullRequest({
        cwd,
        baseBranch,
        headSelector: headContext.preferredHeadSelector,
        title: generated.title,
        bodyFile,
      })
      .pipe(Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.catch(() => Effect.void))));

    const created = yield* findOpenPr(cwd, headContext);
    if (!created) {
      return {
        status: "created" as const,
        baseBranch,
        headBranch: headContext.headBranch,
        title: generated.title,
      };
    }

    return {
      status: "created" as const,
      url: created.url,
      number: created.number,
      baseBranch: created.baseRefName,
      headBranch: created.headRefName,
      title: created.title,
    };
  });

  return { runPrStep };
}
