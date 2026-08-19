import { ProjectId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { evaluateProjectThreadSettle } from "./ProviderCommandReactorHandlers.project-delete.ts";

const projectId = ProjectId.makeUnsafe("project-settle");
const rootId = ThreadId.makeUnsafe("root");
const childId = ThreadId.makeUnsafe("child");

describe("evaluateProjectThreadSettle", () => {
  it("waits while a child without deletingAt still belongs to a deleting root", () => {
    expect(
      evaluateProjectThreadSettle(
        [
          {
            id: rootId,
            deletedAt: null,
            deletingAt: "2026-08-19T00:00:00.000Z",
          },
          {
            id: childId,
            deletedAt: null,
            deletingAt: null,
            parentThread: { threadId: rootId },
          },
        ] as never,
        projectId,
      ),
    ).toEqual({ done: false });
  });

  it("succeeds when no active threads remain", () => {
    expect(
      evaluateProjectThreadSettle(
        [
          {
            id: rootId,
            deletedAt: "2026-08-19T00:00:01.000Z",
            deletingAt: null,
          },
        ] as never,
        projectId,
      ),
    ).toEqual({ done: true, value: { ok: true } });
  });

  it("fails when an active thread is not in a deleting subtree", () => {
    expect(
      evaluateProjectThreadSettle(
        [
          {
            id: rootId,
            deletedAt: null,
            deletingAt: null,
          },
        ] as never,
        projectId,
      ),
    ).toEqual({
      done: true,
      value: {
        ok: false,
        detail: `Thread '${rootId}' deletion failed while deleting project '${projectId}'.`,
      },
    });
  });
});
