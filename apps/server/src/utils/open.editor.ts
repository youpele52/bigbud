import { EDITORS } from "@bigbud/contracts";

type EditorDefinition = (typeof EDITORS)[number];

const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;

function parseTargetPathAndPosition(target: string): {
  path: string;
  line: string | undefined;
  column: string | undefined;
} | null {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target);
  if (!match?.[1] || !match[2]) return null;

  return { path: match[1], line: match[2], column: match[3] };
}

export function hasTargetPosition(target: string): boolean {
  return parseTargetPathAndPosition(target) !== null;
}

export function resolveEditorArgs(editor: EditorDefinition, target: string): ReadonlyArray<string> {
  const baseArgs: ReadonlyArray<string> =
    "baseArgs" in editor && Array.isArray(editor.baseArgs) ? editor.baseArgs : [];
  const parsedTarget = parseTargetPathAndPosition(target);

  switch (editor.launchStyle) {
    case "direct-path":
      return [...baseArgs, target];
    case "goto":
      return [...baseArgs, ...(parsedTarget ? ["--goto", target] : [target])];
    case "line-column": {
      if (!parsedTarget) return [...baseArgs, target];
      const { path, line, column } = parsedTarget;
      return [
        ...baseArgs,
        ...(line ? ["--line", line] : []),
        ...(column ? ["--column", column] : []),
        path,
      ];
    }
  }
}
