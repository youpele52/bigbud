import { describe, expect, it } from "vitest";

import {
  deriveThreadRemoteTargetNotice,
  describeThreadRemoteTargetNotice,
} from "./ThreadRemoteTargetNotice.logic";
import { toResendAttachment, toResendAttachments } from "./ThreadRemoteTargetNotice.resend";

const failure = {
  remoteTarget: { reason: "auth-required" as const, authMode: "password" as const },
  createdAt: "2026-11-21T10:00:00.000Z",
};
const base = {
  isRemote: true,
  userDisconnected: false,
  failure,
  check: undefined,
  canResend: true,
};

describe("deriveThreadRemoteTargetNotice", () => {
  it("shows nothing for local threads or without a remote-target failure", () => {
    expect(deriveThreadRemoteTargetNotice({ ...base, isRemote: false })).toBeNull();
    expect(deriveThreadRemoteTargetNotice({ ...base, failure: null })).toBeNull();
  });

  it("a user-disconnected workspace shows the read-only banner with Reconnect", () => {
    const state = deriveThreadRemoteTargetNotice({
      ...base,
      userDisconnected: true,
      failure: null,
    });
    expect(state).toEqual({ kind: "disconnected" });
    expect(describeThreadRemoteTargetNotice(state!, "ice-2-kg")).toMatchObject({
      variant: "warning",
      title: "ice-2-kg is disconnected",
      actionLabel: "Reconnect",
    });
    expect(describeThreadRemoteTargetNotice(state!, "ice-2-kg").description).toContain("read-only");
  });

  it("an unsent message offers Enter password (amber), and a running check shows Reconnecting", () => {
    const state = deriveThreadRemoteTargetNotice(base);
    expect(state).toEqual({ kind: "unavailable", authMode: "password", checking: false });
    expect(describeThreadRemoteTargetNotice(state!, "ice-2-kg")).toMatchObject({
      variant: "warning",
      title: "ice-2-kg is not connected",
      description: "Your message was not sent.",
      actionLabel: "Enter password",
    });
    const checking = deriveThreadRemoteTargetNotice({
      ...base,
      check: { status: "checking", authMode: null, updatedAt: "2026-11-21T10:01:00.000Z" },
    });
    expect(describeThreadRemoteTargetNotice(checking!, "h")).toMatchObject({
      variant: "loading",
      actionLabel: null,
    });
  });

  it("offers Resend once access was verified after the failure, never automatically", () => {
    const check = {
      status: "verified" as const,
      authMode: null,
      updatedAt: "2026-11-21T10:02:00.000Z",
    };
    const state = deriveThreadRemoteTargetNotice({ ...base, check });
    expect(state).toEqual({ kind: "reconnected", canResend: true });
    expect(describeThreadRemoteTargetNotice(state!, "h")).toMatchObject({
      variant: "success",
      actionLabel: "Resend",
    });
    const images = deriveThreadRemoteTargetNotice({ ...base, check, canResend: false });
    expect(describeThreadRemoteTargetNotice(images!, "h").actionLabel).toBeNull();
  });
});

describe("resend attachments", () => {
  it("resends path and thread references and files by source path, but not images", () => {
    expect(
      toResendAttachment({
        type: "file",
        id: "f1",
        name: "a.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        sourcePath: "/tmp/a.txt",
      }),
    ).toEqual({
      type: "file",
      transport: "path",
      name: "a.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      filePath: "/tmp/a.txt",
    });
    expect(toResendAttachments([])).toEqual([]);
    expect(
      toResendAttachments([
        { type: "image", id: "i1", name: "x.png", mimeType: "image/png", sizeBytes: 1 },
      ]),
    ).toBeNull();
  });
});
