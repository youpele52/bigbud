/** Feasibility reference only: complete synthetic operation replay, never a production checkpoint. */
export class BoundedReplayReference {
  constructor(maxBytes = 65536) {
    this.maxBytes = maxBytes;
    this.operations = [];
    this.bytes = 0;
  }
  write(data) {
    const cost = typeof data === "string" ? data.length * 3 : data.length;
    if (this.bytes + cost > this.maxBytes || this.operations.length >= 4096)
      throw new Error("Reference exhausted; pause source, never truncate.");
    this.operations.push(typeof data === "string" ? data : Uint8Array.from(data));
    this.bytes += cost;
  }
  async restore(terminal) {
    // Queries replay too: precisely why this is NOT a safe checkpoint import contract.
    for (const data of this.operations)
      await new Promise((resolve) => terminal.write(data, resolve));
  }
}
