import { ChatAttachment } from "@bigbud/contracts";
import { decodeJsonResult } from "@bigbud/shared/schemaJson";
import { Result, Schema } from "effect";

import { attachmentRelativePath } from "../../attachments/attachmentStore.ts";

const decodeAttachments = decodeJsonResult(Schema.Array(ChatAttachment));

export interface ThreadAssetRow {
  readonly activityKind: string | null;
  readonly activityPayloadJson: string | null;
  readonly attachmentsJson: string | null;
  readonly worktreePath: string | null;
  readonly workspaceRoot: string | null;
}

export function safeEntitySegment(entityId: string): string | null {
  return entityId.length > 0 &&
    entityId !== "." &&
    entityId !== ".." &&
    !entityId.includes("/") &&
    !entityId.includes("\\")
    ? entityId
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`invalid ${label} JSON`);
  }
}

export function activityAttachmentRelativePaths(row: ThreadAssetRow): ReadonlyArray<string> {
  if (!row.activityPayloadJson) return [];
  const payload = parseJson(row.activityPayloadJson, "activity payload");
  if (
    !isRecord(payload) ||
    row.activityKind !== "tool.completed" ||
    payload.title !== "computer_use"
  ) {
    return [];
  }
  const data = payload.data;
  if (!isRecord(data)) throw new Error("invalid computer-use activity data");
  const result = data.result;
  if (!isRecord(result)) return [];
  const screenshot = result.screenshot;
  if (screenshot === undefined) return [];
  if (!isRecord(screenshot)) throw new Error("invalid computer-use screenshot metadata");
  if (typeof screenshot.attachmentId !== "string" || typeof screenshot.mimeType !== "string") {
    throw new Error("computer-use screenshot attachment ownership is ambiguous");
  }
  const relativePath = attachmentRelativePath({
    type: "image",
    id: screenshot.attachmentId,
    name: "computer-use.png",
    mimeType: screenshot.mimeType,
    sizeBytes: 0,
  });
  if (!relativePath) throw new Error("computer-use screenshot attachment path is invalid");
  return [relativePath];
}

export function threadAttachmentRelativePaths(
  rows: ReadonlyArray<ThreadAssetRow>,
): ReadonlyArray<string> {
  const paths = new Set<string>();
  for (const row of rows) {
    if (row.attachmentsJson) {
      const decoded = decodeAttachments(row.attachmentsJson);
      if (Result.isFailure(decoded)) throw new Error("invalid message attachment manifest");
      for (const attachment of decoded.success) {
        const relativePath = attachmentRelativePath(attachment);
        if (relativePath) paths.add(relativePath);
      }
    }
    for (const relativePath of activityAttachmentRelativePaths(row)) paths.add(relativePath);
  }
  return [...paths];
}
