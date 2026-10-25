// Ported from Orca (stablyai/orca, MIT) src/renderer/src/lib/pane-manager/pane-terminal-mouse-wheel.test.ts at be4e0719.
export const DOM_DELTA_PIXEL = 0;
export const DOM_DELTA_LINE = 1;

export class TestWheelEvent extends Event {
  static readonly DOM_DELTA_PIXEL = DOM_DELTA_PIXEL;
  static readonly DOM_DELTA_LINE = DOM_DELTA_LINE;
  static readonly DOM_DELTA_PAGE = 2;

  readonly altKey: boolean;
  readonly button: number;
  readonly buttons: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly ctrlKey: boolean;
  readonly deltaMode: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaZ: number;
  readonly detail: number;
  readonly metaKey: boolean;
  readonly relatedTarget: EventTarget | null;
  readonly screenX: number;
  readonly screenY: number;
  readonly shiftKey: boolean;
  readonly view: Window | null;

  constructor(type: string, init: WheelEventInit = {}) {
    super(type, init);
    this.altKey = init.altKey ?? false;
    this.button = init.button ?? 0;
    this.buttons = init.buttons ?? 0;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.ctrlKey = init.ctrlKey ?? false;
    this.deltaMode = init.deltaMode ?? DOM_DELTA_PIXEL;
    this.deltaX = init.deltaX ?? 0;
    this.deltaY = init.deltaY ?? 0;
    this.deltaZ = init.deltaZ ?? 0;
    this.detail = init.detail ?? 0;
    this.metaKey = init.metaKey ?? false;
    this.relatedTarget = init.relatedTarget ?? null;
    this.screenX = init.screenX ?? 0;
    this.screenY = init.screenY ?? 0;
    this.shiftKey = init.shiftKey ?? false;
    this.view = init.view ?? null;
  }
}

export function terminalElement(mouseReporting = true): HTMLElement {
  return {
    classList: {
      contains: (className: string) => mouseReporting && className === "enable-mouse-events",
    },
  } as HTMLElement;
}

export function wheelEvent(
  init: Partial<WheelEventInit> & { wheelDelta?: number; wheelDeltaY?: number } = {},
): WheelEvent {
  return {
    deltaY: 100,
    deltaMode: DOM_DELTA_PIXEL,
    ...init,
  } as WheelEvent;
}
