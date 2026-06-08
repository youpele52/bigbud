import { Effect, Option, Schema } from "effect";
import {
  type NotesCreateInput,
  NotesCreateError,
  type NotesDeleteInput,
  NotesDeleteError,
  type NotesGetInput,
  NotesGetError,
  type NotesListInput,
  NotesListError,
  type NotesUpdateInput,
  NotesUpdateError,
  WS_METHODS,
} from "@bigbud/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext";

function deriveNoteTitle(content: string): string {
  const firstLine =
    content
      .trim()
      .split("\n")
      .find((line) => line.trim().length > 0) ?? "Untitled note";

  return (
    firstLine
      .replace(/^#+\s*/, "")
      .trim()
      .slice(0, 200) || "Untitled note"
  );
}

export function makeWsRpcNotesHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.notesList]: (input: NotesListInput) =>
      observeRpcEffect(
        WS_METHODS.notesList,
        context.projectionNotes.list(input).pipe(
          Effect.map((notes) => ({
            notes: notes.map(
              ({ noteId, projectId, title, absolutePath, createdAt, updatedAt }) => ({
                noteId,
                projectId,
                title,
                absolutePath,
                createdAt,
                updatedAt,
              }),
            ),
          })),
          Effect.mapError(
            (cause) =>
              new NotesListError({
                message: "Failed to list notes",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "notes" },
      ),
    [WS_METHODS.notesGet]: (input: NotesGetInput) =>
      observeRpcEffect(
        WS_METHODS.notesGet,
        context.projectionNotes.getById(input).pipe(
          Effect.flatMap((note) =>
            Option.match(note, {
              onNone: () =>
                Effect.fail(
                  new NotesGetError({
                    message: "Note not found",
                  }),
                ),
              onSome: (value) => Effect.succeed(value),
            }),
          ),
          Effect.mapError((cause) =>
            Schema.is(NotesGetError)(cause)
              ? cause
              : new NotesGetError({
                  message: "Failed to load note",
                  cause,
                }),
          ),
        ),
        { "rpc.aggregate": "notes" },
      ),
    [WS_METHODS.notesCreate]: (input: NotesCreateInput) =>
      observeRpcEffect(
        WS_METHODS.notesCreate,
        Effect.gen(function* () {
          const now = new Date().toISOString();

          return yield* context.projectionNotes.create({
            projectId: input.projectId,
            title: input.title ?? deriveNoteTitle(input.content),
            content: input.content,
            createdAt: now,
            updatedAt: now,
          });
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(NotesCreateError)(cause)
              ? cause
              : new NotesCreateError({
                  message: "Failed to create note",
                  cause,
                }),
          ),
        ),
        { "rpc.aggregate": "notes" },
      ),
    [WS_METHODS.notesUpdate]: (input: NotesUpdateInput) =>
      observeRpcEffect(
        WS_METHODS.notesUpdate,
        Effect.gen(function* () {
          const existing = yield* context.projectionNotes.getById({
            noteId: input.noteId,
          });
          const note = yield* Option.match(existing, {
            onNone: () =>
              Effect.fail(
                new NotesUpdateError({
                  message: "Note not found",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          });

          if (input.expectedUpdatedAt && input.expectedUpdatedAt !== note.updatedAt) {
            return yield* new NotesUpdateError({
              message: "Note changed since you opened it. Reload the note and try again.",
            });
          }

          return yield* context.projectionNotes.update({
            noteId: note.noteId,
            title: input.title ?? deriveNoteTitle(input.content),
            content: input.content,
            updatedAt: new Date().toISOString(),
          });
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(NotesUpdateError)(cause)
              ? cause
              : new NotesUpdateError({
                  message: "Failed to update note",
                  cause,
                }),
          ),
        ),
        { "rpc.aggregate": "notes" },
      ),
    [WS_METHODS.notesDelete]: (input: NotesDeleteInput) =>
      observeRpcEffect(
        WS_METHODS.notesDelete,
        context.projectionNotes.deleteById(input).pipe(
          Effect.map(() => ({ noteId: input.noteId })),
          Effect.mapError(
            (cause) =>
              new NotesDeleteError({
                message: "Failed to delete note",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "notes" },
      ),
  };
}
