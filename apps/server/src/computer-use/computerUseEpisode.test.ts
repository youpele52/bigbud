import { describe, expect, it } from "vitest";

import {
  acknowledgeEpisodeNotice,
  admitDesktopWork,
  beginEpisode,
  controlLost,
  controlReady,
  latchEpisode,
  MAX_EPISODE_PARTICIPANTS,
  MAX_SETTLED_KEYS,
  participantKey,
  pauseToken,
  reconcileParticipants,
  renewParticipant,
  restoreEpisodeState,
  resumeEpisode,
  setWorkPending,
  settleParticipant,
  startParticipant,
  type EpisodeState,
} from "./computerUseEpisode.ts";
import { acknowledgeNotice, broadAccessGate, presentNotice } from "./computerUseEpisode.notice.ts";

const turn = participantKey("provider-1", "thread-1", "turn-1");
let minted = 0;
const mint = () => `notice-${(minted += 1)}`;
const fresh = (epoch = 3) =>
  restoreEpisodeState("proc-a", { pauseEpoch: epoch, armed: false, episodeId: null, notice: null });
const ready = (now = 0): EpisodeState =>
  controlReady(beginEpisode(fresh(), "episode-1", now), now + 1);
const started = (state: EpisodeState, key = turn, now = 0) =>
  startParticipant(state, key, "turn", now, 900_000).state;
const admit = (state: EpisodeState, broad = false, now = 1, key = turn) =>
  admitDesktopWork(state, key, broad, now, mint);

describe("episode lifecycle", () => {
  it("prepares, admits, drains and settles across turns and tool gaps", () => {
    let state = beginEpisode(fresh(), "episode-1", 0);
    expect(admit(state).admission).toBe("control_unavailable");
    state = controlReady(state, 5_000);
    expect(admit(state).admission).toBe("no_participant");
    state = started(state);
    const admitted = admit(state);
    expect(admitted.admission).toBe("admit");
    state = setWorkPending(admitted.state, true);
    state = settleParticipant(state, turn);
    expect(state.phase).toBe("draining");
    const turn2 = participantKey("provider-1", "thread-1", "turn-2");
    state = started(state, turn2, 100);
    expect([state.phase, state.episodeId]).toEqual(["active", "episode-1"]);
    state = setWorkPending(settleParticipant(state, turn2), false);
    expect([state.phase, state.episodeId]).toEqual(["idle", null]);
  });

  it("abandons preparation over the 10 s metadata budget before any admission", () => {
    const state = beginEpisode(fresh(0), "episode-1", 0);
    expect(controlReady(state, 10_001).phase).toBe("idle");
    expect(controlReady(state, 10_000).phase).toBe("ready");
  });

  it("pauses on an unrenewed lease, including at admission, never fabricating renewals", () => {
    let state = started(ready(), turn, 0);
    state = renewParticipant(state, turn, 9_000);
    expect(reconcileParticipants(state, 18_999).phase).toBe("ready");
    const uncertain = reconcileParticipants(state, 19_000);
    expect([uncertain.phase, uncertain.pauseReason]).toEqual(["paused", "participation_uncertain"]);
    expect(renewParticipant(state, turn, 19_000)).toBe(state);
    // Admission between reconcile ticks still sees the expired lease.
    expect(admit(state, false, 19_500).admission).toBe("paused");
  });

  it("never revives, re-kinds or extends an existing participant", () => {
    const state = started(ready(), turn, 0);
    for (const [kind, now] of [
      ["turn", 10_500],
      ["adhoc", 5_000],
    ] as const) {
      const again = startParticipant(state, turn, kind, now, 3_600_000);
      expect([again.accepted, again.state]).toEqual([false, state]);
    }
    const adhoc = participantKey("provider-1", "thread-1", "adhoc-1");
    const once = startParticipant(ready(), adhoc, "adhoc", 0, 2 * 60 * 60_000).state;
    expect(once.participants.get(adhoc)?.expiresAtMs).toBe(60 * 60_000);
    expect(startParticipant(once, adhoc, "adhoc", 1_000, 60_000).accepted).toBe(false);
    expect(renewParticipant(once, adhoc, 1_000)).toBe(once);
    expect(startParticipant(ready(), "k", "adhoc", 0, Number.NaN).accepted).toBe(false);
  });

  it("refuses participants beyond the 256 bound", () => {
    let state = ready();
    for (let index = 0; index < MAX_EPISODE_PARTICIPANTS; index += 1) {
      state = started(state, participantKey("p", "t", `turn-${index}`));
    }
    expect(startParticipant(state, participantKey("p", "t", "x"), "turn", 0, 1).accepted).toBe(
      false,
    );
  });
});

describe("pause, Stop and Resume", () => {
  it("never lets a stale or replayed Resume reopen a later pause at the same epoch", () => {
    const first = controlLost(started(ready()), "control_lost");
    const firstToken = pauseToken(first);
    const resumed = resumeEpisode(first, 3, firstToken, 0);
    expect(resumed.phase).toBe("ready");
    const second = controlLost(started(resumed), "provider_lost");
    expect(second.pauseEpoch).toBe(3);
    expect(resumeEpisode(second, 3, firstToken, 0)).toBe(second);
    expect(resumeEpisode(second, 2, pauseToken(second), 0)).toBe(second);
    expect(resumeEpisode(second, 3, pauseToken(second), 0).phase).toBe("ready");
  });

  it("closes only on explicit Stop; other latches keep episode and notice identity", () => {
    const shown = admit(started(ready()), true).state;
    const noticeId = shown.notice?.id ?? "";
    const lost = latchEpisode(shown, 4, "control_lost");
    expect([lost.episodeId, lost.notice?.id, lost.participants.size]).toEqual([
      "episode-1",
      noticeId,
      0,
    ]);
    const resumed = resumeEpisode(lost, 4, pauseToken(lost), 0);
    // The SAME visible card can still be acknowledged after reconnect/resume.
    const acked = acknowledgeEpisodeNotice(resumed, noticeId);
    expect(admit(started(acked), true).admission).toBe("admit");
    const stopped = latchEpisode(shown, 5, "stopped");
    expect([stopped.episodeId, stopped.notice, stopped.pauseEpoch]).toEqual([null, null, 5]);
    expect(latchEpisode(stopped, 2, "stopped").pauseEpoch).toBe(5);
    const reopened = resumeEpisode(stopped, 5, pauseToken(stopped), 0);
    expect([reopened.phase, reopened.episodeId]).toEqual(["idle", null]);
  });

  it("restores an armed restart paused with the persisted notice; tokens never repeat", () => {
    const notice = { id: "notice-persisted", state: "presented_unconfirmed" as const };
    const restored = restoreEpisodeState("proc-b", {
      pauseEpoch: 9,
      armed: true,
      episodeId: "episode-7",
      notice,
    });
    expect([restored.phase, restored.pauseReason, restored.notice]).toEqual([
      "paused",
      "restart_armed",
      notice,
    ]);
    expect(admit(restored, true).admission).toBe("paused");
    // A token minted by the previous process cannot resume this one.
    expect(resumeEpisode(restored, 9, "proc-a:1", 0)).toBe(restored);
    const resumed = resumeEpisode(restored, 9, pauseToken(restored), 0);
    expect(acknowledgeEpisodeNotice(resumed, "notice-persisted").notice?.state).toBe("acked");
  });
});

describe("broad-access notice", () => {
  it("presents one notice per episode before broad access and reuses its identity", () => {
    const state = started(ready());
    expect(admit(state).admission).toBe("admit");
    const first = admit(state, true);
    expect(first.admission).toBe("present_notice");
    const id = first.state.notice?.id ?? "";
    const again = admit(first.state, true);
    expect([again.admission, again.state.notice?.id]).toEqual(["present_notice", id]);
    const stale = acknowledgeEpisodeNotice(again.state, "stale-id");
    expect(stale.notice?.state).toBe("presented_unconfirmed");
    expect(admit(acknowledgeEpisodeNotice(stale, id), true).admission).toBe("admit");
    expect(admit(started(ready()), true).state.notice?.id).not.toBe(id);
  });

  it("never acknowledges a notice that was not yet presented", () => {
    const notice = { id: "n-1", state: "required" as const };
    expect(acknowledgeNotice(notice, "n-1")).toBe(notice);
    expect(broadAccessGate(presentNotice(notice), true)).toBe("present_notice");
    expect(broadAccessGate(null, false)).toBe("proceed");
  });
});

describe("r7 regressions", () => {
  it("closes a resumed or fresh ready episode nobody joins within the budget", () => {
    const shown = admit(started(ready()), true).state;
    const lost = latchEpisode(shown, 4, "control_lost");
    const resumed = resumeEpisode(lost, 4, pauseToken(lost), 100);
    expect(reconcileParticipants(resumed, 10_100).phase).toBe("ready");
    const later = reconcileParticipants(resumed, 10_101);
    expect([later.phase, later.notice]).toEqual(["idle", null]);
    expect(admit(resumed, true, 20_000).admission).toBe("no_episode");
    expect(reconcileParticipants(ready(0), 10_002).phase).toBe("idle");
    // A joined episode is governed by its leases, not the empty-ready bound.
    expect(reconcileParticipants(started(ready(0), turn, 5_000), 10_002).phase).toBe("ready");
  });

  it("admits only the caller's own live participant and never restarts a settled key", () => {
    const other = participantKey("provider-1", "thread-2", "turn-9");
    const state = started(ready());
    expect(admit(state, false, 1, other).admission).toBe("no_participant");
    const turn2 = participantKey("provider-1", "thread-1", "turn-2");
    const settled = settleParticipant(started(state, turn2), turn);
    expect(startParticipant(settled, turn, "turn", 5, 900_000).accepted).toBe(false);
    expect(admit(settled, false, 5, turn2).admission).toBe("admit");
  });

  it("bounds empty-ready at start time and records settles that arrive while paused", () => {
    const empty = ready(0);
    const late = startParticipant(empty, turn, "turn", 10_002, 900_000);
    expect([late.accepted, late.state.phase]).toEqual([false, "idle"]);
    const running = started(ready(0), turn, 5_000);
    const lost = latchEpisode(running, 4, "control_lost");
    const settledWhilePaused = settleParticipant(lost, turn);
    const resumed = resumeEpisode(settledWhilePaused, 4, pauseToken(settledWhilePaused), 6_000);
    expect(startParticipant(resumed, turn, "turn", 6_001, 900_000).accepted).toBe(false);
  });

  it("evicts only the oldest settled key once the bound is reached", () => {
    // An ad-hoc anchor keeps the episode open while turns come and go.
    const anchor = participantKey("p", "t", "anchor");
    let state = startParticipant(ready(0), anchor, "adhoc", 1, 3_600_000).state;
    const keys = Array.from({ length: MAX_SETTLED_KEYS + 1 }, (_, index) =>
      participantKey("p", "t", `turn-${index}`),
    );
    for (const key of keys) {
      state = settleParticipant(startParticipant(state, key, "turn", 2, 900_000).state, key);
    }
    expect([state.phase, state.settledKeys.size]).toEqual(["ready", MAX_SETTLED_KEYS]);
    expect(startParticipant(state, keys[0]!, "turn", 3, 900_000).accepted).toBe(true);
    expect(startParticipant(state, keys.at(-1)!, "turn", 3, 900_000).accepted).toBe(false);
  });
});
