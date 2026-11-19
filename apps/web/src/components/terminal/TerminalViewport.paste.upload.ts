import type { NativeApi } from "@bigbud/contracts";
import type {
  TerminalPasteHost,
  TerminalPasteStageResult,
} from "@bigbud/contracts/workspace/terminal.paste.ts";
import { bytesToBase64 } from "./TerminalViewport.paste.logic";

export interface StagedTerminalFile {
  /** Absolute path on the terminal's machine, as resolved by that machine. */
  readonly path: string;
  readonly host: TerminalPasteHost;
  readonly hostLabel: string;
  readonly clipboard: "set" | "unavailable" | "skipped";
}

type Result<T extends TerminalPasteStageResult["op"]> = Extract<
  TerminalPasteStageResult,
  { op: T }
>;

async function sha256Hex(file: File): Promise<string | undefined> {
  // Insecure origins (a phone on a LAN address) have no WebCrypto; the server always hashes.
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const digest = new Uint8Array(await subtle.digest("SHA-256", await file.arrayBuffer()));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function terminalPasteErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const detail = (error as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" && detail ? detail : "The file could not be pasted.";
}

/**
 * Uploads one file in chunks. The server chooses the machine from the terminal session and
 * returns the staged file's absolute path there; a cancelled upload is aborted server-side.
 */
export async function stageTerminalFile(input: {
  readonly api: NativeApi;
  readonly threadId: string;
  readonly terminalId: string;
  readonly expectedGeneration: string | undefined;
  readonly file: File;
  readonly signal: AbortSignal;
  readonly onBegin?: (begun: Result<"begin">) => void;
}): Promise<StagedTerminalFile> {
  const stage = input.api.terminal.stagePasteFile;
  if (!stage) throw new Error("This bigbud server cannot receive pasted files. Update it first.");
  const begun = (await stage({
    op: "begin",
    threadId: input.threadId,
    terminalId: input.terminalId,
    ...(input.expectedGeneration ? { expectedGeneration: input.expectedGeneration } : {}),
    fileName: input.file.name.slice(0, 512),
    mimeType: input.file.type.slice(0, 255),
    byteLength: input.file.size,
  })) as Result<"begin">;
  input.onBegin?.(begun);
  try {
    for (let offset = 0; offset < input.file.size; offset += begun.chunkBytes) {
      input.signal.throwIfAborted();
      const bytes = new Uint8Array(
        await input.file.slice(offset, offset + begun.chunkBytes).arrayBuffer(),
      );
      await stage({ op: "chunk", uploadId: begun.uploadId, offset, data: bytesToBase64(bytes) });
    }
    input.signal.throwIfAborted();
    const sha256 = await sha256Hex(input.file);
    const committed = (await stage({
      op: "commit",
      uploadId: begun.uploadId,
      ...(sha256 ? { sha256 } : {}),
    })) as Result<"commit">;
    return {
      path: committed.path,
      host: committed.host,
      hostLabel: committed.hostLabel,
      clipboard: committed.clipboard,
    };
  } catch (error) {
    if (input.signal.aborted)
      await stage({ op: "abort", uploadId: begun.uploadId }).catch(() => undefined);
    throw error;
  }
}
