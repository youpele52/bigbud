import {
  DEFAULT_SERVER_SETTINGS,
  KanbanCardId,
  NoteId,
  type ServerProvider,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { baseServerConfig, defaultProviders, rpcClientMock } from "./wsNativeApi.test.helpers";

describe("wsNativeApi — server", () => {
  it("forwards server config fetches directly to the RPC client", async () => {
    rpcClientMock.server.getConfig.mockResolvedValue(baseServerConfig);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.getConfig()).resolves.toEqual(baseServerConfig);
    expect(rpcClientMock.server.getConfig).toHaveBeenCalledWith();
    expect(rpcClientMock.server.subscribeConfig).not.toHaveBeenCalled();
    expect(rpcClientMock.server.subscribeLifecycle).not.toHaveBeenCalled();
  });

  it("forwards provider refreshes directly to the RPC client", async () => {
    const nextProviders: ReadonlyArray<ServerProvider> = [
      {
        ...defaultProviders[0]!,
        checkedAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    rpcClientMock.server.refreshProviders.mockResolvedValue({ providers: nextProviders });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.refreshProviders()).resolves.toEqual({ providers: nextProviders });
    expect(rpcClientMock.server.refreshProviders).toHaveBeenCalledWith();
  });

  it("forwards server settings updates directly to the RPC client", async () => {
    const nextSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      enableAssistantStreaming: true,
    };
    rpcClientMock.server.updateSettings.mockResolvedValue(nextSettings);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.updateSettings({ enableAssistantStreaming: true })).resolves.toEqual(
      nextSettings,
    );
    expect(rpcClientMock.server.updateSettings).toHaveBeenCalledWith({
      enableAssistantStreaming: true,
    });
  });

  it("forwards document URL reads directly to the RPC client", async () => {
    const result = {
      sourceUrl: "https://example.com/report",
      resolvedUrl: "https://example.com/report.pdf",
      title: "Report",
      text: "Body",
    };
    rpcClientMock.server.readDocumentUrl.mockResolvedValue(result);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(
      api.server.readDocumentUrl({ url: "https://example.com/report" }),
    ).resolves.toEqual(result);
    expect(rpcClientMock.server.readDocumentUrl).toHaveBeenCalledWith({
      url: "https://example.com/report",
    });
  });

  it("forwards handoff document writes directly to the RPC client", async () => {
    const result = {
      path: "/Users/test/.bigbud/skills/handoff/tmp/handoff.md",
    };
    rpcClientMock.server.writeHandoffDocument.mockResolvedValue(result);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(
      api.server.writeHandoffDocument({
        title: "Thread title",
        content: "# Handoff\n\nBody",
      }),
    ).resolves.toEqual(result);
    expect(rpcClientMock.server.writeHandoffDocument).toHaveBeenCalledWith({
      title: "Thread title",
      content: "# Handoff\n\nBody",
    });
  });

  it("forwards mobile remote control RPCs directly to the RPC client", async () => {
    const pairing = {
      pairingId: "pairing-1",
      scope: "thread-control" as const,
      expiresAt: "2026-06-24T12:00:00.000Z",
      pairUrl: "https://mobile.example/mobile/pair/pairing-1#secret=secret-1",
      secret: "secret-1",
    };
    const sessions = {
      sessions: [
        {
          sessionId: "session-1",
          scope: "thread-control" as const,
          createdAt: "2026-06-24T12:00:00.000Z",
          expiresAt: "2026-07-01T12:00:00.000Z",
          lastUsedAt: null,
          revokedAt: null,
          label: "iphone",
        },
      ],
    };
    rpcClientMock.server.createMobileRemotePairing.mockResolvedValue(pairing);
    rpcClientMock.server.listMobileRemoteSessions.mockResolvedValue(sessions);
    rpcClientMock.server.revokeMobileRemoteSession.mockResolvedValue(undefined);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(
      api.server.createMobileRemotePairing({
        scope: "thread-control",
        baseUrl: "https://mobile.example",
        backendBaseUrl: "https://desktop.example",
      }),
    ).resolves.toEqual(pairing);
    await expect(api.server.listMobileRemoteSessions()).resolves.toEqual(sessions);
    await expect(
      api.server.revokeMobileRemoteSession({ sessionId: "session-1" }),
    ).resolves.toBeUndefined();
    expect(rpcClientMock.server.createMobileRemotePairing).toHaveBeenCalledWith({
      scope: "thread-control",
      baseUrl: "https://mobile.example",
      backendBaseUrl: "https://desktop.example",
    });
    expect(rpcClientMock.server.listMobileRemoteSessions).toHaveBeenCalledWith();
    expect(rpcClientMock.server.revokeMobileRemoteSession).toHaveBeenCalledWith({
      sessionId: "session-1",
    });
  });

  it("forwards notes RPCs directly to the RPC client", async () => {
    const note = {
      noteId: NoteId.makeUnsafe("note-1"),
      projectId: null,
      title: "Untitled note",
      absolutePath: "/tmp/notes/global/Untitled note.md",
      content: "# Untitled note\n",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
    };
    rpcClientMock.notes.list.mockResolvedValue({ notes: [note] });
    rpcClientMock.notes.get.mockResolvedValue(note);
    rpcClientMock.notes.create.mockResolvedValue(note);
    rpcClientMock.notes.update.mockResolvedValue(note);
    rpcClientMock.notes.delete.mockResolvedValue({ noteId: NoteId.makeUnsafe("note-1") });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.notes.list({ projectId: null, scope: "global" })).resolves.toEqual({
      notes: [note],
    });
    await expect(api.notes.get({ noteId: NoteId.makeUnsafe("note-1") })).resolves.toEqual(note);
    await expect(
      api.notes.create({ projectId: null, content: "# Untitled note\n" }),
    ).resolves.toEqual(note);
    await expect(
      api.notes.update({ noteId: NoteId.makeUnsafe("note-1"), content: "next" }),
    ).resolves.toEqual(note);
    await expect(api.notes.delete({ noteId: NoteId.makeUnsafe("note-1") })).resolves.toEqual({
      noteId: NoteId.makeUnsafe("note-1"),
    });
  });

  it("forwards kanban RPCs directly to the RPC client", async () => {
    const card = {
      cardId: KanbanCardId.makeUnsafe("kanban/global/card-1.md"),
      projectId: null,
      title: "Card 1",
      status: "backlog" as const,
      absolutePath: "/tmp/kanban/global/card-1.md",
      content: "# Card 1\n",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
    };
    rpcClientMock.kanban.list.mockResolvedValue({ cards: [card] });
    rpcClientMock.kanban.get.mockResolvedValue(card);
    rpcClientMock.kanban.create.mockResolvedValue(card);
    rpcClientMock.kanban.update.mockResolvedValue(card);
    rpcClientMock.kanban.delete.mockResolvedValue({ cardId: card.cardId });
    rpcClientMock.kanban.move.mockResolvedValue({
      ...card,
      status: "todo",
      updatedAt: "2026-06-08T00:00:01.000Z",
    });
    rpcClientMock.kanban.reorder.mockResolvedValue({
      ...card,
      updatedAt: "2026-06-08T00:00:02.000Z",
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.kanban.list({ projectId: null, scope: "global" })).resolves.toEqual({
      cards: [card],
    });
    await expect(api.kanban.get({ cardId: card.cardId })).resolves.toEqual(card);
    await expect(
      api.kanban.create({ projectId: null, title: "Card 1", content: "# Card 1\n" }),
    ).resolves.toEqual(card);
    await expect(
      api.kanban.update({
        cardId: card.cardId,
        title: "Card 1",
        content: "# Card 1\n",
      }),
    ).resolves.toEqual(card);
    await expect(api.kanban.delete({ cardId: card.cardId })).resolves.toEqual({
      cardId: card.cardId,
    });
    await expect(api.kanban.move({ cardId: card.cardId, status: "todo" })).resolves.toMatchObject({
      cardId: card.cardId,
      status: "todo",
    });
    await expect(
      api.kanban.reorder({ cardId: card.cardId, status: "backlog", targetIndex: 0 }),
    ).resolves.toMatchObject({
      cardId: card.cardId,
    });
  });
});
