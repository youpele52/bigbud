export const FILES_DRAWER_OPEN_DELAY = 250;
export const FILES_DRAWER_CLOSE_DELAY = 1000;

export type FilesDrawerMode = "closed" | "hover" | "open" | "pinned";
type DrawerActivity = "pointer" | "focus" | "menu" | "interaction" | "drag";
type HoverTrigger = "header" | "edge";

/** Owns cancellable drawer timers independently of file selection and rendering. */
export class FilesDrawerController {
  private mode: FilesDrawerMode = "closed";
  private active = false;
  private activities = new Set<DrawerActivity>();
  private hoverTriggers = new Set<HoverTrigger>();
  private hoverSuppressed = false;
  private openTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onChange: (mode: FilesDrawerMode) => void) {}

  private clearTimers() {
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    this.openTimer = undefined;
    this.closeTimer = undefined;
  }

  private setMode(mode: FilesDrawerMode) {
    this.clearTimers();
    if (mode === this.mode) return;
    this.mode = mode;
    this.onChange(mode);
  }

  /** Resets transient state on preview/workspace boundaries, but retains the pin. */
  setActive(active: boolean) {
    this.active = active;
    this.activities.clear();
    this.hoverTriggers.clear();
    this.hoverSuppressed = false;
    this.clearTimers();
    if (this.mode !== "pinned") this.setMode("closed");
    return this.mode;
  }

  enterHandle() {
    this.setTrigger("header", true);
  }

  setTrigger(trigger: HoverTrigger, inside: boolean) {
    if (inside) this.hoverTriggers.add(trigger);
    else this.hoverTriggers.delete(trigger);
    this.updateTriggers();
  }

  /** Atomically observes trigger occupancy so hiding the drawer cannot accidentally rearm it. */
  observeTriggers(edge: boolean, header: boolean) {
    this.hoverTriggers.clear();
    if (edge) this.hoverTriggers.add("edge");
    if (header) this.hoverTriggers.add("header");
    this.updateTriggers();
  }

  private updateTriggers() {
    if (this.hoverTriggers.size === 0) {
      this.hoverSuppressed = false;
      clearTimeout(this.openTimer);
      this.openTimer = undefined;
      this.scheduleClose();
      return;
    }
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
    if (
      !this.active ||
      this.hoverSuppressed ||
      this.mode !== "closed" ||
      this.openTimer !== undefined
    )
      return;
    this.openTimer = setTimeout(() => {
      this.openTimer = undefined;
      if (this.active && !this.hoverSuppressed && this.hoverTriggers.size > 0)
        this.setMode("hover");
    }, FILES_DRAWER_OPEN_DELAY);
  }

  setActivity(activity: DrawerActivity, active: boolean) {
    if (active) {
      this.activities.add(activity);
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
      return;
    }
    this.activities.delete(activity);
    this.scheduleClose();
  }

  private scheduleClose() {
    if (
      !this.active ||
      this.mode !== "hover" ||
      this.activities.size > 0 ||
      this.hoverTriggers.size > 0
    )
      return;
    if (this.closeTimer !== undefined) return;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined;
      if (this.activities.size === 0 && this.hoverTriggers.size === 0 && this.mode === "hover")
        this.setMode("closed");
    }, FILES_DRAWER_CLOSE_DELAY);
  }

  open() {
    if (!this.active) return;
    this.hoverSuppressed = false;
    this.setMode("open");
  }

  toggle() {
    if (!this.active) return false;
    if (this.mode !== "closed") {
      this.dismiss();
      return false;
    }
    this.open();
    return true;
  }

  togglePin() {
    if (!this.active) return;
    this.hoverSuppressed = false;
    this.setMode(this.mode === "pinned" ? "open" : "pinned");
  }

  dismiss() {
    this.hoverSuppressed = true;
    this.setMode("closed");
    this.activities.clear();
  }

  dispose() {
    this.clearTimers();
  }
}
