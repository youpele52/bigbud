import { ChatAttachment } from "@bigbud/contracts";
import { decodeJsonResult } from "@bigbud/shared/schemaJson";
import { Result, Schema } from "effect";

const decodeAttachments = decodeJsonResult(Schema.Array(ChatAttachment));

export interface AttachmentReferenceExtraction {
  readonly attachmentIds: ReadonlyArray<string>;
  readonly unresolved: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractMessageAttachmentReferences(
  raw: string | null,
): AttachmentReferenceExtraction {
  if (raw === null) return { attachmentIds: [], unresolved: false };
  const decoded = decodeAttachments(raw);
  if (Result.isFailure(decoded)) return { attachmentIds: [], unresolved: true };
  return {
    attachmentIds: decoded.success
      .filter((attachment) => attachment.type === "image" || attachment.type === "file")
      .map((attachment) => attachment.id),
    unresolved: false,
  };
}

export function extractActivityAttachmentReferences(input: {
  readonly kind: string;
  readonly payloadJson: string;
}): AttachmentReferenceExtraction {
  let payload: unknown;
  try {
    payload = JSON.parse(input.payloadJson) as unknown;
  } catch {
    return { attachmentIds: [], unresolved: true };
  }
  if (!isRecord(payload) || input.kind !== "tool.completed" || payload.title !== "computer_use") {
    return { attachmentIds: [], unresolved: false };
  }
  if (!isRecord(payload.data)) return { attachmentIds: [], unresolved: true };
  if (!isRecord(payload.data.result) || payload.data.result.screenshot === undefined) {
    return { attachmentIds: [], unresolved: false };
  }
  const screenshot = payload.data.result.screenshot;
  if (
    !isRecord(screenshot) ||
    typeof screenshot.attachmentId !== "string" ||
    typeof screenshot.mimeType !== "string"
  ) {
    return { attachmentIds: [], unresolved: true };
  }
  if (screenshot.attachmentId.trim() === "") return { attachmentIds: [], unresolved: true };
  return { attachmentIds: [screenshot.attachmentId], unresolved: false };
}
