import { Effect, Option, Schema } from "effect";
import {
  type KanbanCreateInput,
  KanbanCreateError,
  type KanbanDeleteInput,
  KanbanDeleteError,
  type KanbanGetInput,
  KanbanGetError,
  type KanbanListInput,
  KanbanListError,
  type KanbanMoveInput,
  KanbanMoveError,
  type KanbanReorderInput,
  KanbanReorderError,
  type KanbanUpdateInput,
  KanbanUpdateError,
  WS_METHODS,
} from "@bigbud/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext";

function deriveCardTitle(content: string): string {
  const firstLine =
    content
      .trim()
      .split("\n")
      .find((line) => line.trim().length > 0) ?? "Untitled";

  return (
    firstLine
      .replace(/^#+\s*/, "")
      .trim()
      .slice(0, 200) || "Untitled"
  );
}

export function makeWsRpcKanbanHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.kanbanList]: (input: KanbanListInput) =>
      observeRpcEffect(
        WS_METHODS.kanbanList,
        context.projectionKanban.list(input).pipe(
          Effect.map((cards) => ({
            cards: cards.map(
              ({ cardId, projectId, title, status, absolutePath, createdAt, updatedAt }) => ({
                cardId,
                projectId,
                title,
                status,
                absolutePath,
                createdAt,
                updatedAt,
              }),
            ),
          })),
          Effect.mapError(
            (cause) =>
              new KanbanListError({
                message: "Failed to list kanban cards",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "kanban" },
      ),
    [WS_METHODS.kanbanGet]: (input: KanbanGetInput) =>
      observeRpcEffect(
        WS_METHODS.kanbanGet,
        context.projectionKanban.getById(input).pipe(
          Effect.flatMap((card) =>
            Option.match(card, {
              onNone: () =>
                Effect.fail(
                  new KanbanGetError({
                    message: "Kanban card not found",
                  }),
                ),
              onSome: (value) => Effect.succeed(value),
            }),
          ),
          Effect.mapError((cause) =>
            Schema.is(KanbanGetError)(cause)
              ? cause
              : new KanbanGetError({
                  message: "Failed to load kanban card",
                  cause,
                }),
          ),
        ),
        { "rpc.aggregate": "kanban" },
      ),
    [WS_METHODS.kanbanCreate]: (input: KanbanCreateInput) =>
      observeRpcEffect(
        WS_METHODS.kanbanCreate,
        Effect.gen(function* () {
          const now = new Date().toISOString();

          return yield* context.projectionKanban.create({
            projectId: input.projectId,
            title: input.title ?? deriveCardTitle(input.content),
            content: input.content,
            status: input.status ?? "backlog",
            createdAt: now,
            updatedAt: now,
          });
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(KanbanCreateError)(cause)
              ? cause
              : new KanbanCreateError({
                  message: "Failed to create kanban card",
                  cause,
                }),
          ),
        ),
        { "rpc.aggregate": "kanban" },
      ),
    [WS_METHODS.kanbanUpdate]: (input: KanbanUpdateInput) =>
      observeRpcEffect(
        WS_METHODS.kanbanUpdate,
        Effect.gen(function* () {
          const existing = yield* context.projectionKanban.getById({
            cardId: input.cardId,
          });
          const card = yield* Option.match(existing, {
            onNone: () =>
              Effect.fail(
                new KanbanUpdateError({
                  message: "Kanban card not found",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          });

          if (input.expectedUpdatedAt && input.expectedUpdatedAt !== card.updatedAt) {
            return yield* new KanbanUpdateError({
              message: "Kanban card changed since you opened it. Reload and try again.",
            });
          }

          return yield* context.projectionKanban.update({
            cardId: input.cardId,
            title: input.title,
            content: input.content,
            updatedAt: new Date().toISOString(),
          });
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(KanbanUpdateError)(cause)
              ? cause
              : new KanbanUpdateError({
                  message: "Failed to update kanban card",
                  cause,
                }),
          ),
        ),
        { "rpc.aggregate": "kanban" },
      ),
    [WS_METHODS.kanbanDelete]: (input: KanbanDeleteInput) =>
      observeRpcEffect(
        WS_METHODS.kanbanDelete,
        context.projectionKanban.deleteById(input).pipe(
          Effect.map(() => ({ cardId: input.cardId })),
          Effect.mapError(
            (cause) =>
              new KanbanDeleteError({
                message: "Failed to delete kanban card",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "kanban" },
      ),
    [WS_METHODS.kanbanMove]: (input: KanbanMoveInput) =>
      observeRpcEffect(
        WS_METHODS.kanbanMove,
        context.projectionKanban
          .move({
            cardId: input.cardId,
            status: input.status,
            targetIndex: input.targetIndex,
            updatedAt: new Date().toISOString(),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new KanbanMoveError({
                  message: "Failed to move kanban card",
                  cause,
                }),
            ),
          ),
        { "rpc.aggregate": "kanban" },
      ),
    [WS_METHODS.kanbanReorder]: (input: KanbanReorderInput) =>
      observeRpcEffect(
        WS_METHODS.kanbanReorder,
        context.projectionKanban
          .reorderWithinStatus({
            cardId: input.cardId,
            status: input.status,
            targetIndex: input.targetIndex,
            updatedAt: new Date().toISOString(),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new KanbanReorderError({
                  message: "Failed to reorder kanban card",
                  cause,
                }),
            ),
          ),
        { "rpc.aggregate": "kanban" },
      ),
  };
}
