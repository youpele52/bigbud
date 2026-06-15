export function buildSkillMentionPrompt(skillName: string): string {
  return `@skill::${skillName}`;
}
