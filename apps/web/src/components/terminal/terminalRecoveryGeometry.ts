import type { FitAddon } from "@xterm/addon-fit";

type Geometry = { cols: number; rows: number };
const owners = new WeakMap<object, { desired?: Geometry }>();

/** Fit proposes native geometry; only the ordered recovery suffix applies it to the renderer. */
export function ownRecoveryGeometry(terminal: object): () => void {
  const owner: { desired?: Geometry } = {};
  owners.set(terminal, owner);
  return () => {
    if (owners.get(terminal) === owner) owners.delete(terminal);
  };
}

export function deferRecoveryFit(
  terminal: object,
  fit: Partial<Pick<FitAddon, "proposeDimensions">>,
): boolean {
  const owner = owners.get(terminal);
  if (!owner) return false;
  const desired = fit.proposeDimensions?.();
  if (
    desired &&
    Number.isInteger(desired.cols) &&
    Number.isInteger(desired.rows) &&
    desired.cols > 0 &&
    desired.rows > 0
  )
    owner.desired = desired;
  return true;
}

export function terminalResizeGeometry(terminal: Geometry): Geometry {
  return owners.get(terminal)?.desired ?? { cols: terminal.cols, rows: terminal.rows };
}
