export class AsyncBoundedChannel<T> {
  private readonly values: T[] = [];
  private readonly takers: Array<(value: T | null) => void> = [];
  private readonly offerWaiters: Array<() => void> = [];
  private closed = false;

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("channel capacity must be a positive integer");
    }
  }

  async offer(value: T): Promise<boolean> {
    while (!this.closed && this.values.length >= this.capacity && this.takers.length === 0) {
      await new Promise<void>((resolve) => this.offerWaiters.push(resolve));
    }
    if (this.closed) return false;
    const taker = this.takers.shift();
    if (taker) taker(value);
    else this.values.push(value);
    return true;
  }

  tryOffer(value: T): boolean {
    if (this.closed || (this.values.length >= this.capacity && this.takers.length === 0)) {
      return false;
    }
    const taker = this.takers.shift();
    if (taker) taker(value);
    else this.values.push(value);
    return true;
  }

  take(): Promise<T | null> {
    const value = this.values.shift();
    if (value !== undefined) {
      this.offerWaiters.shift()?.();
      return Promise.resolve(value);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise<T | null>((resolve) => this.takers.push(resolve));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.values.length = 0;
    for (const take of this.takers.splice(0)) take(null);
    for (const resolve of this.offerWaiters.splice(0)) resolve();
  }
}
