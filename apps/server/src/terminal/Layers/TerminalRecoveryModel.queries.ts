interface Expected {
  sequence: number;
  value: string;
  terminated: boolean;
}
interface Received {
  sequence: number;
  data: string;
}

/** Observe renderer replies only. Never forward headless answers or manufacture PTY input. */
export class TerminalRecoveryQueries {
  private expected: Expected[] = [];
  private received: Received[] = [];
  private overflow = false;

  expect(value: string, sequence: number, terminated = false): void {
    if (this.expected.length >= 64) {
      this.overflow = true;
      return;
    }
    this.expected.push({ value, sequence, terminated });
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

  get pending(): boolean {
    return this.overflow || this.expected.length > 0;
  }
}
