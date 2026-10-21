/** Fixed-capacity ring that keeps the newest entries and drops the oldest. */
export class BoundedRing<T> {
  private readonly slots: Array<T | undefined>;
  private next = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("BoundedRing capacity must be a positive integer");
    }
    this.slots = Array.from({ length: capacity });
  }

  push(entry: T): void {
    this.slots[this.next] = entry;
    this.next = (this.next + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
  }

  get length(): number {
    return this.size;
  }

  /** Newest first, at most `limit` entries. */
  newest(limit = this.capacity): ReadonlyArray<T> {
    const count = Math.max(0, Math.min(limit, this.size));
    const result: T[] = [];
    for (let offset = 1; offset <= count; offset += 1) {
      const entry = this.slots[(this.next - offset + this.capacity) % this.capacity];
      if (entry !== undefined) result.push(entry);
    }
    return result;
  }
}
