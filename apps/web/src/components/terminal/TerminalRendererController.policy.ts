export class TerminalRendererBudget {
  private contexts = 0;
  private incidents: number[] = [];
  private latched = false;

  reserve(): (() => void) | null {
    if (this.contexts >= 8) return null;
    this.contexts++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.contexts--;
      }
    };
  }
  loss(now: number): void {
    this.incidents = this.incidents.filter((time) => now - time < 60_000);
    if (this.incidents.length === 0 || now - this.incidents.at(-1)! >= 1000)
      this.incidents.push(now);
    if (this.incidents.length >= 3) this.latched = true;
  }
  get isLatched(): boolean {
    return this.latched;
  }
  get count(): number {
    return this.contexts;
  }
}
export const terminalRendererBudget = new TerminalRendererBudget();
