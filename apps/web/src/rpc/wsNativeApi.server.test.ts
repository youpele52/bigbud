import { DEFAULT_SERVER_SETTINGS, NoteId, type ServerProvider } from "@bigbud/contracts";
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
});
