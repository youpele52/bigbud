/**
 * Maps host output sequences onto the manager's published output stream (plan §8.1, §9.1).
 *
 * Output events carry text, not sequences, and the drain coalesces chunks. Every char the
 * session queues for publication is counted (`arrived`), and each applied host sequence records
 * how many chars had arrived through it. Published output events are tagged with their end
 * offset in that same char space, so a subscriber can cut its stream exactly at a snapshot's
 * `through_sequence` and drop duplicates.
 *
 * @module Manager.hostScreen.ledger
 */

/** Recent sequences kept for splicing; a snapshot's sequence is always recent. */
const LEDGER_CAPACITY = 8_192;

export class TerminalHostOutputLedger {
  /** Chars queued for publication (in publication order). */
  private arrived = 0;
  /** Chars published to listeners. */
  private published = 0;
  private lastSequence = 0;
  private readonly sequences: number[] = [];
  private readonly offsets: number[] = [];
  private head = 0;

  get sequence(): number {
    return this.lastSequence;
  }

  get publishedChars(): number {
    return this.published;
  }

  /** Text queued for publication; called before `noteSequence` for the same chunk. */
  noteData(text: string): void {
    this.arrived += text.length;
  }

  /** An applied host sequence; every applied sequence is reported, even with no text. */
  noteSequence(sequence: number): void {
    if (sequence <= this.lastSequence) return;
    this.lastSequence = sequence;
    if (this.sequences.length < LEDGER_CAPACITY) {
      this.sequences.push(sequence);
      this.offsets.push(this.arrived);
      return;
    }
    this.sequences[this.head] = sequence;
    this.offsets[this.head] = this.arrived;
    this.head = (this.head + 1) % LEDGER_CAPACITY;
  }

  /** Records one published output event and returns its end offset. */
  notePublished(length: number): number {
    this.published += length;
    return this.published;
  }

  /**
   * Chars that arrived through `sequence`: `undefined` while it has not arrived yet, and 0 when
   * it is older than the ledger (everything retained is newer).
   */
  charsThrough(sequence: number): number | undefined {
    if (sequence > this.lastSequence) return undefined;
    let found: number | undefined;
    for (let index = 0; index < this.sequences.length; index++) {
      const slot = (this.head + index) % this.sequences.length;
      if (this.sequences[slot]! > sequence) break;
      found = this.offsets[slot]!;
    }
    return found ?? 0;
  }

  /** The newest sequence whose output lies entirely within the first `chars` chars. */
  sequenceAtChars(chars: number): number | undefined {
    let found: number | undefined;
    for (let index = 0; index < this.sequences.length; index++) {
      const slot = (this.head + index) % this.sequences.length;
      if (this.offsets[slot]! > chars) break;
      found = this.sequences[slot]!;
    }
    return found;
  }
}

/** End offsets of published host output events, keyed by the event object every listener sees. */
const publishedEnds = new WeakMap<object, number>();

export function tagTerminalHostOutput(event: object, end: number): void {
  publishedEnds.set(event, end);
}

export function terminalHostOutputEnd(event: object): number | undefined {
  return publishedEnds.get(event);
}
