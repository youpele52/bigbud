/**
 * Dormant desktop episode coordinator (plan M4 "Logical session"). A pure
 * reducer over trusted lifecycle facts (provider generation + thread + turn
 * from dispatch context and ProviderRuntimeIngestion turn events, never
 * activity counters). Time is an injected monotonic millisecond clock and is
 * never persisted. Not wired while legacy Driver 0.9.1 stays selected.
 *
 * preparing → ready (warning/control-ready) → active → draining → settled,
 * plus `paused` carrying reason/epoch and a fresh pause token. Uncertainty
 * pauses; it never fabricates renewals. Only explicit Stop closes the episode
 * (its Resume permits a new one); other pauses keep the episode and notice
 * identity. A Resume must name the CURRENT epoch and pause token, so a delayed
 * or replayed Resume never reopens a later pause. Driver sessions are
 * independent of this coordinator.
 */
import {
  acknowledgeNotice,
  broadAccessGate,
  presentNotice,
  requireNotice,
  type EpisodeNotice,
} from "./computerUseEpisode.notice.ts";

export const EPISODE_PREPARATION_MS = 10_000;
export const PARTICIPATION_LEASE_MS = 10_000;
export const PARTICIPANT_RECONCILE_MS = 2_000;
export const MAX_EPISODE_PARTICIPANTS = 256;
export const MAX_ADHOC_PARTICIPATION_MS = 60 * 60_000;
/** Settled keys remembered per episode so a delayed start cannot revive them. */
export const MAX_SETTLED_KEYS = 4 * 256;

export type EpisodePhase = "idle" | "preparing" | "ready" | "active" | "draining" | "paused";
export type PauseReason =
  | "stopped"
  | "participation_uncertain"
  | "provider_lost"
  | "control_lost"
  | "restart_armed";

export interface Participant {
  readonly kind: "turn" | "adhoc";
  /** Turn: last verified renewal + lease. Ad-hoc: fixed at start (bounded). */
  readonly expiresAtMs: number;
}

export interface EpisodeState {
  readonly phase: EpisodePhase;
  /** Per-process random identity; pause tokens never repeat across restarts. */
  readonly instance: string;
  /** Monotonic count of pauses in this process (part of the pause token). */
  readonly pauses: number;
  readonly episodeId: string | null;
  readonly pauseEpoch: number;
  readonly pauseReason: PauseReason | null;
  readonly preparingSinceMs: number | null;
  /** Ready with no participant since then; bounded by the preparation budget. */
  readonly emptySinceMs: number | null;
  readonly participants: ReadonlyMap<string, Participant>;
  /** Insertion-ordered, bounded; reset when the episode closes. */
  readonly settledKeys: ReadonlySet<string>;
  readonly workPending: boolean;
  readonly notice: EpisodeNotice | null;
}

export type Admission =
  | "admit"
  | "present_notice"
  | "paused"
  | "control_unavailable"
  | "no_participant"
  | "no_episode";

/** Persisted across restarts (never monotonic timestamps). */
export interface PersistedEpisode {
  readonly pauseEpoch: number;
  readonly armed: boolean;
  readonly episodeId: string | null;
  readonly notice: EpisodeNotice | null;
}

/**
 * Restores after (re)start. An armed restart stays paused and keeps the
 * persisted episode/notice so the SAME card is reconciled; nothing replays.
 */
export function restoreEpisodeState(instance: string, persisted: PersistedEpisode): EpisodeState {
  const idle: EpisodeState = {
    phase: "idle",
    instance,
    pauses: 0,
    episodeId: null,
    pauseEpoch: persisted.pauseEpoch,
    pauseReason: null,
    preparingSinceMs: null,
    emptySinceMs: null,
    participants: new Map(),
    settledKeys: new Set(),
    workPending: false,
    notice: null,
  };
  if (!persisted.armed) return idle;
  const kept = { ...idle, episodeId: persisted.episodeId, notice: persisted.notice };
  return pause(kept, "restart_armed");
}

export const pauseToken = (state: EpisodeState): string => `${state.instance}:${state.pauses}`;

/** Stable trusted participant identity; labels are never authority. */
export const participantKey = (providerGeneration: string, threadId: string, turnId: string) =>
  JSON.stringify([providerGeneration, threadId, turnId]);

/** NaN-safe: anything not strictly in the future has expired. */
const expired = (participant: Participant, nowMs: number) => !(participant.expiresAtMs > nowMs);

function pause(state: EpisodeState, reason: PauseReason): EpisodeState {
  return { ...state, phase: "paused", pauseReason: reason, pauses: state.pauses + 1 };
}

/** Closed episode: idle, keeping process identity, pause count and epoch. */
const closed = (state: EpisodeState): EpisodeState => ({
  ...state,
  phase: "idle",
  episodeId: null,
  pauseReason: null,
  preparingSinceMs: null,
  emptySinceMs: null,
  participants: new Map(),
  settledKeys: new Set(),
  workPending: false,
  notice: null,
});

const live = (state: EpisodeState) =>
  state.phase === "preparing" ||
  state.phase === "ready" ||
  state.phase === "active" ||
  state.phase === "draining";

/** Ready with nobody joined for longer than the preparation budget. */
const emptyTooLong = (state: EpisodeState, nowMs: number): boolean =>
  state.phase === "ready" &&
  state.participants.size === 0 &&
  state.emptySinceMs !== null &&
  !(nowMs - state.emptySinceMs <= EPISODE_PREPARATION_MS);

/** Settles to idle once nothing participates and no work remains. */
function maybeSettle(state: EpisodeState): EpisodeState {
  if (state.participants.size > 0) return state;
  if (state.workPending) return { ...state, phase: "draining" };
  return closed(state);
}

export function beginEpisode(state: EpisodeState, episodeId: string, nowMs: number): EpisodeState {
  if (state.phase !== "idle" || !Number.isFinite(nowMs)) return state;
  return { ...state, phase: "preparing", episodeId, preparingSinceMs: nowMs, notice: null };
}

/** Required surface established and policy acknowledged (metadata only). */
export function controlReady(state: EpisodeState, nowMs: number): EpisodeState {
  if (state.phase !== "preparing" || state.preparingSinceMs === null) return state;
  if (!(nowMs - state.preparingSinceMs <= EPISODE_PREPARATION_MS)) {
    // Preparation over budget: abandon before any desktop admission.
    return closed(state);
  }
  return { ...state, phase: "ready", emptySinceMs: nowMs };
}

/** A key already present is never restarted (no revival or extension). */
export function startParticipant(
  state: EpisodeState,
  key: string,
  kind: Participant["kind"],
  nowMs: number,
  actionTimeoutMs: number,
): { readonly state: EpisodeState; readonly accepted: boolean } {
  const valid = Number.isFinite(nowMs) && Number.isFinite(actionTimeoutMs) && actionTimeoutMs > 0;
  // The empty-ready bound holds even without a reconcile tick in between.
  if (valid && emptyTooLong(state, nowMs)) return { state: closed(state), accepted: false };
  if (
    !live(state) ||
    !valid ||
    state.participants.has(key) ||
    state.settledKeys.has(key) ||
    state.participants.size >= MAX_EPISODE_PARTICIPANTS
  ) {
    return { state, accepted: false };
  }
  const bound = Math.min(actionTimeoutMs, MAX_ADHOC_PARTICIPATION_MS);
  const expiresAtMs = nowMs + (kind === "adhoc" ? bound : PARTICIPATION_LEASE_MS);
  const participants = new Map(state.participants).set(key, { kind, expiresAtMs });
  const phase = state.phase === "draining" ? "active" : state.phase;
  return { state: { ...state, participants, phase, emptySinceMs: null }, accepted: true };
}

/** Renewal only from verified live lifecycle state; ad-hoc never extends. */
export function renewParticipant(state: EpisodeState, key: string, nowMs: number): EpisodeState {
  const participant = state.participants.get(key);
  if (!live(state) || participant?.kind !== "turn" || expired(participant, nowMs)) {
    return state;
  }
  const renewed = { ...participant, expiresAtMs: nowMs + PARTICIPATION_LEASE_MS };
  return { ...state, participants: new Map(state.participants).set(key, renewed) };
}

/** Turn completed/aborted or an ad-hoc invocation finalizer ran. */
/** Also records a key that settles while paused (its lease was cleared). */
export function settleParticipant(state: EpisodeState, key: string): EpisodeState {
  if (state.episodeId === null) return state;
  const participants = new Map(state.participants);
  participants.delete(key);
  const settledKeys = new Set(state.settledKeys).add(key);
  if (settledKeys.size > MAX_SETTLED_KEYS) {
    const oldest = settledKeys.values().next();
    if (oldest.done !== true) settledKeys.delete(oldest.value);
  }
  const next = { ...state, participants, settledKeys };
  return live(state) ? maybeSettle(next) : next;
}

/**
 * Run every PARTICIPANT_RECONCILE_MS: an unrenewed lease is uncertainty, and
 * a ready episode nobody joined within the preparation budget closes (so an
 * old acknowledgement can never carry over to unrelated later work).
 */
export function reconcileParticipants(state: EpisodeState, nowMs: number): EpisodeState {
  if (!live(state)) return state;
  if (emptyTooLong(state, nowMs)) return closed(state);
  for (const participant of state.participants.values()) {
    if (expired(participant, nowMs)) return pause(state, "participation_uncertain");
  }
  return state;
}

export function setWorkPending(state: EpisodeState, pending: boolean): EpisodeState {
  const next = { ...state, workPending: pending };
  return live(state) && !pending ? maybeSettle(next) : next;
}

/**
 * Desktop admission gate (before native admission). Reconciles leases first
 * and requires a live participant. Broad access requires the episode notice
 * to be acknowledged; `mintNoticeId` is used only when none exists yet.
 */
export function admitDesktopWork(
  current: EpisodeState,
  participant: string,
  broadAccess: boolean,
  nowMs: number,
  mintNoticeId: () => string,
): { readonly state: EpisodeState; readonly admission: Admission } {
  const state = reconcileParticipants(current, nowMs);
  if (state.phase === "paused") return { state, admission: "paused" };
  if (state.phase === "idle") return { state, admission: "no_episode" };
  if (state.phase === "preparing") return { state, admission: "control_unavailable" };
  // Work is tracked for draining/uncertainty only through its own live lease.
  const own = state.participants.get(participant);
  if (own === undefined || expired(own, nowMs)) return { state, admission: "no_participant" };
  if (broadAccessGate(state.notice, broadAccess) === "present_notice") {
    const notice = presentNotice(requireNotice(state.notice, mintNoticeId));
    return { state: { ...state, notice }, admission: "present_notice" };
  }
  return { state: { ...state, phase: "active" }, admission: "admit" };
}

export function acknowledgeEpisodeNotice(state: EpisodeState, noticeId: string): EpisodeState {
  return state.notice === null
    ? state
    : { ...state, notice: acknowledgeNotice(state.notice, noticeId) };
}

export function controlLost(state: EpisodeState, reason: "provider_lost" | "control_lost") {
  return live(state) ? pause(state, reason) : state;
}

/**
 * Applies a native latch at its pause epoch (never lowered). Explicit Stop
 * closes the episode; any other latch keeps episode/notice identity while
 * invalidating participants (execution references are retired natively).
 */
export function latchEpisode(
  state: EpisodeState,
  pauseEpoch: number,
  reason: PauseReason,
): EpisodeState {
  const epoch = Math.max(state.pauseEpoch, pauseEpoch);
  const base = reason === "stopped" ? closed(state) : state;
  return pause({ ...base, pauseEpoch: epoch, participants: new Map(), workPending: false }, reason);
}

/**
 * Human Resume for the CURRENT epoch and pause token only. After Stop it
 * permits a new episode; otherwise the same episode and notice continue in
 * `ready` with no participants: the integration re-registers still-running
 * turns from verified lifecycle state, and if none joins within the
 * preparation budget the episode closes.
 */
export function resumeEpisode(
  state: EpisodeState,
  pauseEpoch: number,
  token: string,
  nowMs: number,
): EpisodeState {
  const current = pauseEpoch === state.pauseEpoch && token === pauseToken(state);
  if (state.phase !== "paused" || !current || !Number.isFinite(nowMs)) return state;
  if (state.episodeId === null) return closed(state);
  return {
    ...state,
    phase: "ready",
    pauseReason: null,
    participants: new Map(),
    workPending: false,
    emptySinceMs: nowMs,
  };
}
