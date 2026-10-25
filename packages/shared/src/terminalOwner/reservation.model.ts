import { requireContract } from "./errors";

/** Explicit queued/in-flight/retained-copy accounting, not measured JS heap sizing. */
export class ReservationPoolModel {
  private bytes = 0;
  private records = new Map<number, number>();
  private next = 0;
  constructor(
    readonly byteCap: number,
    readonly itemCap: number,
    readonly perItemCap: number = byteCap,
  ) {}
  reserve(bytes: number): number {
    requireContract(
      Number.isSafeInteger(bytes) &&
        bytes >= 0 &&
        bytes <= this.perItemCap &&
        this.bytes + bytes <= this.byteCap &&
        this.records.size < this.itemCap,
      "CAPACITY",
    );
    requireContract(this.next < Number.MAX_SAFE_INTEGER, "COUNTER_EXHAUSTED");
    const id = ++this.next;
    this.records.set(id, bytes);
    this.bytes += bytes;
    return id;
  }
  release(id: number) {
    const bytes = this.records.get(id);
    requireContract(bytes !== undefined, "RESERVATION_UNKNOWN");
    this.records.delete(id);
    this.bytes -= bytes;
  }
  snapshot() {
    return {
      bytes: this.bytes,
      items: this.records.size,
      byteCap: this.byteCap,
      itemCap: this.itemCap,
      perItemCap: this.perItemCap,
    };
  }
}

/** Non-borrowable startup arena accounting. Native allocation/layout evidence is deferred. */
export class OwnerReservationModel {
  readonly ordinaryRoot = new ReservationPoolModel(248 * 1024, 248, 1024);
  readonly authorityRoot = new ReservationPoolModel(7 * 1024, 7, 1024);
  readonly cleanupParent = new ReservationPoolModel(1024, 1, 1024);
  readonly ordinaryGrants = new ReservationPoolModel(65536, 126, 8192);
  readonly ordinaryResponses = new ReservationPoolModel(1048576, 256, 4096);
  readonly activeMutations = new ReservationPoolModel(128, 128, 1);
  readonly bulkTickets = new ReservationPoolModel(32768, 64, 8192);
  readonly ordinaryCopies = new ReservationPoolModel(98304, 240, 65536);
  readonly cleanupCopies = new ReservationPoolModel(16384, 16, 8192);
  readonly childRecordBytes = 768;
  readonly childOutcomeBytes = 512;
  readonly capsuleBytes = 8192;
  rootEnvelope() {
    const ledger = 262144;
    const arena = 112 * this.childRecordBytes + 2 * this.capsuleBytes + 4096 + 4096 + 20480;
    const copies = 114688;
    const bookkeeping = 16384;
    requireContract(
      arena === 131072 && ledger + arena + copies + bookkeeping === 524288,
      "LAYOUT_INVALID",
    );
    return { ledger, arena, copies, bookkeeping, total: ledger + arena + copies + bookkeeping };
  }
}
