import type { ProviderKind } from "@bigbud/contracts";
import { Effect, FileSystem, Path } from "effect";

import type { SkillReviewContext } from "../../learning/LearningReview.ts";
import { resolveSkillMutationPolicy } from "../../learning/SkillMutationPolicy.ts";
import type { DiscoveryRegistryShape } from "../../provider/Services/DiscoveryRegistry.ts";

export function resolveSkillName(sourceUserMessage: string): string | null {
  return (
    /(?:@skill::?|\/skills?\s+)([^\s@]+)/i.exec(sourceUserMessage)?.[1]?.trim().toLowerCase() ??
    null
  );
}

export function makeResolveSkillContext(input: {
  readonly discovery: DiscoveryRegistryShape;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  return (sourceUserMessage: string, provider: ProviderKind) =>
    Effect.gen(function* () {
      const name = resolveSkillName(sourceUserMessage);
      if (!name) return null;
      const catalog = yield* input.discovery.getCatalog;
      const target = catalog.skills.find(
        (skill) =>
          skill.name.toLowerCase() === name &&
          skill.provider === provider &&
          (skill.source === "user" || skill.source === "project") &&
          resolveSkillMutationPolicy(skill) === "approval-required" &&
          skill.sourcePath,
      );
      if (!target?.sourcePath) return null;
      const content = yield* input.fs
        .readFileString(target.sourcePath)
        .pipe(Effect.orElseSucceed(() => ""));
      if (!content) return null;
      const skillsRoot = input.path.dirname(input.path.dirname(target.sourcePath));
      const examples = yield* Effect.forEach(
        catalog.skills
          .filter(
            (skill) =>
              skill.provider === target.provider &&
              skill.source === target.source &&
              skill.sourcePath &&
              skill.sourcePath !== target.sourcePath &&
              input.path.dirname(input.path.dirname(skill.sourcePath)) === skillsRoot,
          )
          .slice(0, 2),
        (skill) =>
          input.fs.readFileString(skill.sourcePath!).pipe(
            Effect.map((exampleContent) => ({ path: skill.sourcePath!, content: exampleContent })),
            Effect.orElseSucceed(() => null),
          ),
      );
      return {
        target,
        context: {
          path: target.sourcePath,
          content,
          sameProviderExamples: examples.filter(
            (example): example is NonNullable<typeof example> => example !== null,
          ),
        } satisfies SkillReviewContext,
      };
    });
}
