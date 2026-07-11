import type { ServerDiscoveredSkill } from "@bigbud/contracts";

export type SkillMutationPolicy = "forbidden" | "approval-required";

export function resolveSkillMutationPolicy(
  skill: Pick<ServerDiscoveredSkill, "provider" | "source">,
): SkillMutationPolicy {
  if (skill.provider === "bigbud") return "forbidden";
  return skill.source === "user" || skill.source === "project" ? "approval-required" : "forbidden";
}

export function mayApplySkillMutation(input: {
  readonly policy: SkillMutationPolicy;
  readonly explicitlyApproved: boolean;
}): boolean {
  return input.policy === "approval-required" && input.explicitlyApproved;
}
