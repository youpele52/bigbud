/**
 * Dormant broad-access notice identity (plan M4). One persisted notice ID per
 * episode moves `required` → `presented_unconfirmed` → `acked`. A crash with
 * an uncertain acknowledgement reconciles the SAME visible card/ID instead of
 * minting a new warning: the persisted notice is simply re-presented under its
 * own ID and never treated as acked. This guarantees logical identity, not
 * exactly-once human perception. Not wired while legacy 0.9.1 is selected;
 * enrollment `hasSeenComputerUsePrompt` is deliberately not this state.
 */
export type NoticeState = "required" | "presented_unconfirmed" | "acked";

export interface EpisodeNotice {
  readonly id: string;
  readonly state: NoticeState;
}

/** Broad access = applied policy with zero user disallows (hard blocks remain). */
export type BroadAccessGate = "proceed" | "present_notice";

export function broadAccessGate(
  notice: EpisodeNotice | null,
  broadAccess: boolean,
): BroadAccessGate {
  return !broadAccess || notice?.state === "acked" ? "proceed" : "present_notice";
}

/**
 * Ensures a notice exists for this episode, reusing an outstanding one. Only
 * when none exists does `mintId` supply a fresh identity.
 */
export function requireNotice(notice: EpisodeNotice | null, mintId: () => string): EpisodeNotice {
  return notice ?? { id: mintId(), state: "required" };
}

/** The visible card was shown; acknowledgement not yet confirmed. */
export function presentNotice(notice: EpisodeNotice): EpisodeNotice {
  return notice.state === "acked" ? notice : { ...notice, state: "presented_unconfirmed" };
}

/** Only an acknowledgement for the current notice ID counts. */
export function acknowledgeNotice(notice: EpisodeNotice, id: string): EpisodeNotice {
  return notice.id === id && notice.state !== "required" ? { ...notice, state: "acked" } : notice;
}
