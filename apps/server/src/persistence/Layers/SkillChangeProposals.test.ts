import { ThreadId, TurnId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { SkillChangeProposalRepository } from "../Services/SkillChangeProposals.ts";
import { SkillChangeProposalRepositoryLive } from "./SkillChangeProposals.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = SkillChangeProposalRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(layer)("SkillChangeProposalRepository", (it) => {
  it.effect("persists and resolves an exact targeted patch", () =>
    Effect.gen(function* () {
      const repository = yield* SkillChangeProposalRepository;
      yield* repository.create({
        proposalId: "proposal-1",
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        provider: "opencode",
        skillPath: "/skills/example/SKILL.md",
        originalHash: "hash",
        oldText: "Old step",
        newText: "New step",
        reason: "Verified correction",
        status: "pending",
        createdAt: "2026-07-11T12:00:00.000Z",
        resolvedAt: null,
      });
      yield* repository.resolve({
        proposalId: "proposal-1",
        status: "rejected",
        resolvedAt: "2026-07-11T12:01:00.000Z",
      });
      const proposal = yield* repository.getById("proposal-1");
      assert.equal(proposal._tag, "Some");
      if (proposal._tag === "Some") {
        assert.equal(proposal.value.status, "rejected");
        assert.equal(proposal.value.oldText, "Old step");
      }
    }),
  );
});
