import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

import { openRpcSocket, requestRpc, waitFor } from "./inyosira-qualification.rpc.ts";

type OrganizationRow = { state: string; revision: number; deadline: string | null };

export function assertDeadlineObservation(
  row: OrganizationRow,
  snoozed: OrganizationRow,
  observedAt: number,
): void {
  assert(snoozed.deadline, "Missing canonical snooze deadline");
  if (observedAt < Date.parse(snoozed.deadline)) {
    assert.equal(row.state, "later", "Snooze expired before its canonical deadline");
    assert.equal(row.revision, snoozed.revision, "Revision changed before deadline");
  } else if (row.state === "needs-you") {
    assert.equal(row.revision, snoozed.revision + 1, "Expiry must commit exactly once");
  } else {
    assert.equal(row.state, "later", "Unexpected state while awaiting expiry");
    assert.equal(row.revision, snoozed.revision);
  }
}

export async function runOrganizationScenario(url: string, databasePath: string) {
  const sockets: WebSocket[] = [];
  const open = async () => {
    const socket = await openRpcSocket(url);
    sockets.push(socket);
    return socket;
  };
  let database: DatabaseSync | undefined;
  try {
    const a = await open();
    await waitFor(
      async () => {
        const status = await requestRpc<{ state: string }>(a, "orchestration.organizationStatus");
        assert.notEqual(status.state, "paused", "Native organisation paused");
        return status.state === "healthy";
      },
      "native organisation healthy",
      30_000,
    );
    const dispatch = (command: unknown) => requestRpc(a, "orchestration.dispatchCommand", command);
    const createdAt = new Date().toISOString();
    await dispatch({
      type: "project.create",
      commandId: "qual-project-create",
      projectId: "qual-project",
      title: "Synthetic qualification",
      workspaceRoot: null,
      createdAt,
    });
    await dispatch({
      type: "thread.create",
      commandId: "qual-thread-create",
      projectId: "qual-project",
      threadId: "qual-thread",
      title: "Synthetic engagement",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    database = new DatabaseSync(databasePath, { readOnly: true });
    const db = database;
    const digest = () =>
      db
        .prepare(
          "SELECT semantic_digest FROM thread_organization_runtime_threads WHERE thread_id = ?",
        )
        .get("qual-thread")?.semantic_digest;
    const engage = async (socket: WebSocket, engaged: boolean) => {
      assert.equal(
        await requestRpc(socket, "orchestration.organizationEngagement", {
          threadId: "qual-thread",
          engaged,
        }),
        true,
      );
    };
    await waitFor(() => Boolean(digest()), "initial thread facts");
    const baseline = digest();
    await engage(a, true);
    await waitFor(() => digest() !== baseline, "A engagement");
    const aDigest = digest();
    const b = await open();
    await delay(100);
    await engage(b, true);
    await waitFor(() => digest() !== aDigest, "B engagement");
    const bDigest = digest();
    a.close();
    await delay(17_000);
    assert.equal(digest(), bDigest, "A disconnect released B's engagement");
    const c = await open();
    await engage(c, false);
    await delay(500);
    assert.equal(digest(), bDigest, "Reconnect released another client's lease");
    await engage(b, false);
    await waitFor(() => digest() !== bDigest, "B release republishes facts");
    await requestRpc(b, "orchestration.dispatchCommand", {
      type: "thread.organization.snooze",
      commandId: "qual-snooze",
      threadId: "qual-thread",
      durationMinutes: 2,
      createdAt: new Date().toISOString(),
    });
    const row = () =>
      db
        .prepare(
          "SELECT organization_state AS state, organization_revision AS revision, organization_snooze_until AS deadline FROM projection_threads WHERE thread_id = ?",
        )
        .get("qual-thread") as OrganizationRow;
    const snoozed = row();
    assert.equal(snoozed.state, "later");
    assert(snoozed.deadline);
    const deadline = Date.parse(snoozed.deadline);
    assert(deadline > Date.now() + 110_000, "Expected a full two-minute deadline");
    console.log(JSON.stringify({ snooze: "waiting", deadline: snoozed.deadline }));
    while (true) {
      const current = row();
      assertDeadlineObservation(current, snoozed, Date.now());
      if (current.state === "needs-you") break;
      assert(Date.now() < deadline + 15_000, "Native deadline did not commit");
      await delay(100);
    }
    await delay(1500);
    assert.equal(row().revision, snoozed.revision + 1, "Duplicate canonical move");
    const count = (sql: string) => db.prepare(sql).get()?.count;
    assert.equal(
      count(
        "SELECT COUNT(*) AS count FROM thread_organization_operations WHERE status = 'prepared'",
      ),
      0,
    );
    const applied = db
      .prepare(
        "SELECT payload_json, outcome_json FROM thread_organization_operations WHERE thread_id = ? AND status = 'applied'",
      )
      .all("qual-thread");
    assert.equal(applied.length, 1, "Expected one applied native operation");
    assert.equal(JSON.parse(String(applied[0]!.payload_json)).reason, "snooze-expired");
    assert.equal(JSON.parse(String(applied[0]!.outcome_json)).resultRevision, snoozed.revision + 1);
    assert.equal(count("SELECT COUNT(*) AS count FROM provider_session_runtime"), 0);
    assert.equal(count("SELECT COUNT(*) AS count FROM projection_turns"), 0);
    assert.equal(
      (await requestRpc<{ state: string }>(b, "orchestration.organizationStatus")).state,
      "healthy",
    );
    return {
      engagement: "PASS",
      disconnect: "PASS",
      reconnect: "PASS",
      nativeDeadline: "PASS",
      appliedNativeOperations: applied.length,
      revision: row().revision,
      pendingOperations: 0,
      providerSessions: 0,
      providerTurns: 0,
    };
  } finally {
    database?.close();
    for (const socket of sockets) socket.close();
  }
}
