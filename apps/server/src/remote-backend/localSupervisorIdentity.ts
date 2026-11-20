import type { ShellHostScope } from "@bigbud/contracts/workspace/terminalShell.ts";

const PREFIX = "remote-backend:";

export function localSupervisorTarget(authorityId: string): string {
  if (!/^[a-f0-9]{32}$/.test(authorityId)) throw new Error("Invalid backend authority identity.");
  return `${PREFIX}${authorityId}`;
}

export function localSupervisorShellHost(target: string): ShellHostScope {
  if (!target.startsWith(PREFIX) || localSupervisorTarget(target.slice(PREFIX.length)) !== target)
    throw new Error("A local supervisor target must name one backend authority.");
  return { kind: "agent", hostId: target };
}
