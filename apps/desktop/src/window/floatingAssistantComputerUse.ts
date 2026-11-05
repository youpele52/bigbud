import { desktopIpcChannels } from "../main.channels";
import type { DesktopWindowRegistry } from "./DesktopWindowRegistry";

/**
 * Mascot-menu "Stop computer use". The mascot renderer mirrors the server's computer-use
 * activity here; the menu reads it at popup time, so it always reflects the latest report.
 * A report counts only while it came from the current mascot window, so a replaced or reloaded
 * mascot never inherits a stale "active".
 */
export class FloatingAssistantComputerUseStop {
  #active = false;
  #reporterId: number | null = null;

  constructor(private readonly registry: Pick<DesktopWindowRegistry, "get">) {}

  get isActive(): boolean {
    const mascot = this.registry.get("mascot");
    return (
      this.#active &&
      mascot !== null &&
      !mascot.isDestroyed() &&
      mascot.webContents.id === this.#reporterId
    );
  }

  /** Accepts reports from the current mascot window only. */
  setActive(senderId: number, active: boolean): boolean {
    const mascot = this.registry.get("mascot");
    if (!mascot || mascot.isDestroyed() || mascot.webContents.id !== senderId) return false;
    this.#active = active;
    this.#reporterId = senderId;
    return true;
  }

  /** The mascot renderer runs the server-wide Stop and reports the outcome. */
  requestStop(): boolean {
    const mascot = this.registry.get("mascot");
    if (!mascot || mascot.isDestroyed()) return false;
    mascot.webContents.send(desktopIpcChannels.stopComputerUseRequested);
    return true;
  }

  reset(): void {
    this.#active = false;
    this.#reporterId = null;
  }
}
