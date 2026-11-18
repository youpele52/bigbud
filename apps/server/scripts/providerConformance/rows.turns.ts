/**
 * Session rows driven by one turn each (WP-5D): plain text, attachment, tool use, approval,
 * question and cancel. A row passes only on observed events: a settled turn with the expected
 * outcome, the per-run token in the reply, and the row's own activity kinds.
 */
import { randomUUID } from "node:crypto";

import { DECLARED_UNSUPPORTED, prompt, result, type RowResult } from "./rows.ts";
import {
  FILES,
  FULL_ACCESS,
  withThread,
  type ProviderContext,
  type RowOutcome,
} from "./rows.context.ts";
import {
  assistantText,
  containsToken,
  dispatch,
  isSettled,
  nowIso,
  pendingRequest,
  turnStartCommand,
  waitForView,
  type ThreadRef,
  type ThreadView,
} from "./session.ts";

const startTurn = (
  context: ProviderContext,
  thread: ThreadRef,
  text: string,
  modes = FULL_ACCESS,
  attachments: ReadonlyArray<unknown> = [],
) =>
  dispatch(
    context.rpc,
    turnStartCommand({
      threadId: thread.threadId,
      provider: context.provider,
      model: context.model,
      text,
      attachments,
      ...modes,
    }),
  );

const settledOutcome = (view: ThreadView) =>
  view.turnStartFailed ? "turn-start-failed" : (view.settled.at(-1)?.outcome ?? "none");

/** Settled `completed` with the token in the reply, plus an optional row-specific check. */
export function judgeCompletedTurn(
  view: ThreadView,
  met: boolean,
  token: string,
  extra?: { readonly ok: boolean; readonly missing: string },
): RowOutcome {
  const evidence = {
    outcome: settledOutcome(view),
    tokenInReply: containsToken(assistantText(view), token),
    activityCount: view.activities.length,
  };
  if (!met) return { status: "fail", reason: "turn did not settle before the deadline", evidence };
  if (evidence.outcome !== "completed")
    return { status: "fail", reason: `turn settled ${evidence.outcome}`, evidence };
  if (!evidence.tokenInReply)
    return { status: "fail", reason: "reply did not contain the expected token", evidence };
  if (extra && !extra.ok) return { status: "fail", reason: extra.missing, evidence };
  return { status: "pass", reason: "observed", evidence };
}

export const textTurnRow = (context: ProviderContext) =>
  withThread(context, "text-turn", FULL_ACCESS, async (thread) => {
    await startTurn(context, thread, prompt("text", context.tokens.text));
    const { view, met } = await waitForView(context.rpc, thread, context.timing, isSettled);
    return judgeCompletedTurn(view, met, context.tokens.text);
  });

export function attachmentRow(context: ProviderContext): Promise<RowResult> {
  const declared = DECLARED_UNSUPPORTED.attachment?.[context.provider];
  const contents = `${context.tokens.attachment}\n`;
  const attachment = {
    type: "file",
    transport: "base64",
    name: FILES.attachment,
    mimeType: "text/plain",
    sizeBytes: Buffer.byteLength(contents),
    dataUrl: `data:text/plain;base64,${Buffer.from(contents).toString("base64")}`,
  };
  return withThread(context, "attachment", FULL_ACCESS, async (thread) => {
    try {
      await startTurn(context, thread, prompt("attachment"), FULL_ACCESS, [attachment]);
    } catch (error) {
      if (declared)
        return { status: "unsupported-by-provider", reason: `${declared}; rejected explicitly` };
      throw error;
    }
    const { view, met } = await waitForView(context.rpc, thread, context.timing, isSettled);
    if (declared && view.turnStartFailed)
      return {
        status: "unsupported-by-provider",
        reason: `${declared}; turn start failed explicitly`,
      };
    return judgeCompletedTurn(view, met, context.tokens.attachment);
  });
}

const hasToolActivity = (view: ThreadView) =>
  view.activities.some((entry) => entry.kind.startsWith("tool."));

export const toolUseRow = (context: ProviderContext) =>
  withThread(context, "tool-use", FULL_ACCESS, async (thread) => {
    await startTurn(context, thread, prompt("tool"));
    const { view, met } = await waitForView(context.rpc, thread, context.timing, isSettled);
    return judgeCompletedTurn(view, met, context.tokens.tool, {
      ok: hasToolActivity(view),
      missing: "no tool activity observed",
    });
  });

const APPROVAL_MODES = { runtimeMode: "approval-required", interactionMode: "default" } as const;

export function approvalRow(context: ProviderContext): Promise<RowResult> {
  const declared = DECLARED_UNSUPPORTED.approval?.[context.provider];
  if (declared)
    return Promise.resolve(
      result("approval", context.provider, "unsupported-by-provider", declared),
    );
  return withThread(context, "approval", APPROVAL_MODES, async (thread) => {
    await startTurn(context, thread, prompt("approval"), APPROVAL_MODES);
    const asked = await waitForView(
      context.rpc,
      thread,
      context.timing,
      (view) =>
        Boolean(pendingRequest(view, "approval.requested", "approval.resolved")) || isSettled(view),
    );
    const request = pendingRequest(asked.view, "approval.requested", "approval.resolved");
    if (!request)
      return { status: "fail", reason: `no approval request; turn ${settledOutcome(asked.view)}` };
    await dispatch(context.rpc, {
      type: "thread.approval.respond",
      commandId: randomUUID(),
      threadId: thread.threadId,
      requestId: request.requestId,
      decision: "accept",
      createdAt: nowIso(),
    });
    const { view, met } = await waitForView(context.rpc, thread, context.timing, isSettled);
    return judgeCompletedTurn(view, met, context.tokens.approval, {
      ok: view.activities.some((entry) => entry.kind === "approval.resolved"),
      missing: "approval was never resolved",
    });
  });
}

/** The first question's id and the option to answer (`blue` when offered). */
export function chooseAnswer(payload: Record<string, unknown>) {
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  const first = questions[0] as { id?: unknown; options?: Array<{ label?: unknown }> } | undefined;
  if (!first || typeof first.id !== "string") return null;
  const labels = (first.options ?? []).map((option) => String(option.label ?? ""));
  const label = labels.find((entry) => entry.toLowerCase() === "blue") ?? labels[0];
  return label ? { questionId: first.id, label } : null;
}

export const questionRow = (context: ProviderContext) =>
  withThread(context, "question", FULL_ACCESS, async (thread) => {
    await startTurn(context, thread, prompt("question"));
    const asked = await waitForView(
      context.rpc,
      thread,
      context.timing,
      (view) =>
        Boolean(pendingRequest(view, "user-input.requested", "user-input.resolved")) ||
        isSettled(view),
    );
    const request = pendingRequest(asked.view, "user-input.requested", "user-input.resolved");
    if (!request)
      return {
        status: "fail",
        reason: `no question request; turn ${settledOutcome(asked.view)} (the model may have answered directly)`,
      };
    const answer = chooseAnswer(request.payload);
    if (!answer) return { status: "fail", reason: "question request had no answerable options" };
    await dispatch(context.rpc, {
      type: "thread.user-input.respond",
      commandId: randomUUID(),
      threadId: thread.threadId,
      requestId: request.requestId,
      answers: { [answer.questionId]: answer.label },
      createdAt: nowIso(),
    });
    const { view, met } = await waitForView(context.rpc, thread, context.timing, isSettled);
    return judgeCompletedTurn(view, met, answer.label, {
      ok: view.activities.some((entry) => entry.kind === "user-input.resolved"),
      missing: "question was never resolved",
    });
  });

const CANCELLED = new Set(["interrupted", "cancelled"]);

export const cancelRow = (context: ProviderContext) =>
  withThread(context, "cancel", FULL_ACCESS, async (thread) => {
    await startTurn(context, thread, prompt("cancel"));
    const started = performance.now();
    // Interrupt once the turn visibly runs (any reply or activity), or after cancelAfterMs.
    const running = await waitForView(
      context.rpc,
      thread,
      { ...context.timing, turnDeadlineMs: context.timing.cancelAfterMs },
      (view) => view.messages.size > 1 || view.activities.length > 0 || isSettled(view),
    );
    if (isSettled(running.view))
      return {
        status: "fail",
        reason: `turn settled ${settledOutcome(running.view)} before the interrupt`,
      };
    await dispatch(context.rpc, {
      type: "thread.turn.interrupt",
      commandId: randomUUID(),
      threadId: thread.threadId,
      createdAt: nowIso(),
    });
    const { view, met } = await waitForView(context.rpc, thread, context.timing, isSettled);
    const evidence = {
      outcome: settledOutcome(view),
      interruptAfterMs: Math.round(performance.now() - started),
    };
    if (!met)
      return { status: "fail", reason: "turn did not settle after the interrupt", evidence };
    return CANCELLED.has(evidence.outcome)
      ? { status: "pass", reason: `settled ${evidence.outcome}`, evidence }
      : { status: "fail", reason: `settled ${evidence.outcome} after the interrupt`, evidence };
  });
