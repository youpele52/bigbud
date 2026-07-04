import { type ProviderKind } from "@bigbud/contracts";

interface ResolveTerminalBaseLabelInput {
  projectName: string | null | undefined;
  cwd: string | null | undefined;
}

export function resolveTerminalBaseLabel(input: ResolveTerminalBaseLabelInput): string {
  const trimmedProjectName = input.projectName?.trim();
  if (trimmedProjectName) {
    return trimmedProjectName;
  }

  const trimmedCwd = input.cwd?.trim();
  if (trimmedCwd) {
    const segments = trimmedCwd.split(/[/\\]/).filter((segment) => segment.length > 0);
    return segments.at(-1) ?? trimmedCwd;
  }

  return "Terminal";
}

export function buildTerminalLabelMap(
  terminalIds: ReadonlyArray<string>,
  baseLabel: string,
): ReadonlyMap<string, string> {
  return new Map(
    terminalIds.map((terminalId, index) => [
      terminalId,
      index === 0 ? baseLabel : `${baseLabel} ${index + 1}`,
    ]),
  );
}

interface ResolveTerminalProviderInput {
  sessionProvider: ProviderKind | null | undefined;
  modelProvider: ProviderKind | null | undefined;
}

export function resolveTerminalProvider(input: ResolveTerminalProviderInput): ProviderKind | null {
  return input.sessionProvider ?? input.modelProvider ?? null;
}
