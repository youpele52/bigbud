/**
 * A query unanswered this long after the mirror parsed it is treated as abandoned. Terminals are
 * not obliged to reply, so programs time out far sooner, and a view attaching without the mirror
 * cannot answer a pre-cut query either. Refusing past this point only costs recovery fidelity.
 */
export const RECOVERY_QUERY_ABANDON_MS = 2000;
const MAX_EXPECTED = 64;

interface Expected {
  sequence: number;
  value: string;
  terminated: boolean;
  at: number;
}
interface Received {
  sequence: number;
  data: string;
}

/** Observe renderer replies only. Never forward headless answers or manufacture PTY input. */
export class TerminalRecoveryQueries {
  private expected: Expected[] = [];
  private received: Received[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  expect(value: string, sequence: number, terminated = false): void {
    this.abandon();
    // The oldest entry is the closest to abandonment; a full ledger never refuses for good.
    if (this.expected.length >= MAX_EXPECTED) this.expected.shift();
    this.expected.push({ value, sequence, terminated, at: this.now() });
    this.match();
  }

  observe(data: string, sequence: number): void {
    const last = this.received.at(-1);
    if (last?.sequence === sequence) last.data = (last.data + data).slice(-4096);
    else this.received.push({ sequence, data: data.slice(-4096) });
    while (this.received.length > 16) this.received.shift();
    this.match();
  }

  private match(): void {
    this.expected = this.expected.filter((expected) => {
      for (const received of this.received) {
        // An input preceding the query's native ingress cannot acknowledge that query.
        if (received.sequence < expected.sequence) continue;
        const start = received.data.indexOf(expected.value);
        if (start < 0) continue;
        let end = start + expected.value.length;
        if (expected.terminated) {
          const tail = received.data.slice(end);
          const terminator = tail.indexOf("\x1b\\");
          const bell = tail.indexOf("\x07");
          if (terminator < 0 && bell < 0) continue;
          end += bell >= 0 && (terminator < 0 || bell < terminator) ? bell + 1 : terminator + 2;
        }
        received.data = received.data.slice(0, start) + received.data.slice(end);
        return false;
      }
      return true;
    });
  }

  /** Only queries young enough that a reply may still be in flight block a capture. */
  get pending(): boolean {
    const cutoff = this.now() - RECOVERY_QUERY_ABANDON_MS;
    return this.expected.some((expected) => expected.at > cutoff);
  }

  private abandon(): void {
    const cutoff = this.now() - RECOVERY_QUERY_ABANDON_MS;
    if (this.expected[0] && this.expected[0].at <= cutoff)
      this.expected = this.expected.filter((expected) => expected.at > cutoff);
  }
}
