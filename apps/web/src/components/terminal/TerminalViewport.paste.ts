import type { Terminal } from "@xterm/xterm";
import type { NativeApi, TerminalDropPathMode } from "@bigbud/contracts";
import {
  TERMINAL_PASTE_MAX_FILE_MB,
  terminalPasteMaxFileBytes,
} from "@bigbud/contracts/core/settings.terminalPaste.ts";
import { formatBytes } from "@bigbud/shared/bytes";
import { readTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { getServerConfig } from "../../rpc/serverState";
import { desktopAttachmentPath } from "../chat/view/ChatView.attachments.logic";
import { toastManager } from "../ui/toast.manager";
import { formatTerminalPathPastes } from "./TerminalViewport.paths";
import {
  planTerminalPaste,
  terminalPasteHostKind,
  type TerminalPastePlan,
} from "./TerminalViewport.paste.logic";
import { stageTerminalFile, terminalPasteErrorMessage } from "./TerminalViewport.paste.upload";

/** Keystrokes typed during an upload wait at most this long behind the pasted path. */
export const TERMINAL_PASTE_TIMEOUT_MS = 120_000;

export interface TerminalFileDelivery {
  /** Lands every item as an absolute path, in order, ahead of anything typed afterwards. */
  readonly deliver: (plan: TerminalPastePlan) => void;
}

export interface TerminalPasteGesture {
  readonly text: string;
  readonly files: ReadonlyArray<File>;
}

export interface AttachTerminalPasteOptions {
  readonly terminal: Terminal;
  readonly api: NativeApi;
  readonly threadId: string;
  readonly terminalId: string;
  readonly enqueueDeferred: (data: Promise<string | null>, timeoutMs: number) => void;
  /** Admits input exactly like typing (generation sync, lifecycle, input-enabled). */
  readonly admitInput: () => boolean;
  readonly readDropPathMode: () => TerminalDropPathMode;
  readonly writeNotice: (message: string) => void;
  /** OSC 5522 hook; returns true when it consumed the paste as a paste event. */
  readonly onPasteGesture?: (gesture: TerminalPasteGesture) => boolean;
}

const deliveries = new WeakMap<Terminal, TerminalFileDelivery>();

/** The mounted delivery for a terminal (drops reuse the paste pipeline). */
export function terminalFileDelivery(terminal: Terminal | null): TerminalFileDelivery | undefined {
  return terminal ? deliveries.get(terminal) : undefined;
}

/** The server's per-file paste cap (Settings › Terminal), in bytes. */
export function maxPasteBytes(): number {
  return terminalPasteMaxFileBytes(
    getServerConfig()?.settings.terminalPasteMaxFileMb ?? TERMINAL_PASTE_MAX_FILE_MB.default,
  );
}

/**
 * Capture-phase paste handling on the terminal element, ahead of xterm's text-only handler.
 * Text pastes (and Ctrl+V, which is a key, not a paste event) are left untouched.
 */
export function attachTerminalPaste(options: AttachTerminalPasteOptions): () => void {
  const { terminal, threadId, terminalId } = options;
  const launch = () => readTerminalLaunch(threadId, terminalId);

  const stage = async (file: File): Promise<string | null> => {
    const size = formatBytes(file.size);
    const limit = maxPasteBytes();
    if (file.size === 0 || file.size > limit) {
      toastManager.add({
        type: "error",
        title: `Could not paste ${file.name || "the file"}`,
        description:
          file.size === 0
            ? "The file is empty."
            : `It is ${size}; the paste limit is ${formatBytes(limit)}. Change it in Settings › Terminal.`,
      });
      return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TERMINAL_PASTE_TIMEOUT_MS);
    let toastId: string | null = null;
    try {
      const staged = await stageTerminalFile({
        api: options.api,
        threadId,
        terminalId,
        expectedGeneration: launch()?.runtimeGeneration,
        file,
        signal: controller.signal,
        onBegin: (begun) => {
          if (begun.host !== "remote") return;
          toastId = toastManager.add({
            type: "loading",
            title: `Uploading ${file.name || "pasted file"}`,
            description: `${size} to ${begun.hostLabel}`,
            timeout: 0,
            actionProps: { children: "Cancel", onClick: () => controller.abort() },
          });
        },
      });
      if (toastId)
        toastManager.update(toastId, {
          type: "success",
          title: `Uploaded ${file.name || "pasted file"}`,
          description: `${size} to ${staged.hostLabel}. Its path was pasted${
            staged.clipboard === "set" ? " and the image is on that machine's clipboard" : ""
          }.`,
          timeout: 4_000,
          actionProps: undefined,
        });
      return staged.path;
    } catch (error) {
      const options = {
        type: "error" as const,
        title: controller.signal.aborted
          ? `Paste of ${file.name || "the file"} cancelled`
          : `Could not paste ${file.name || "the file"}`,
        description: controller.signal.aborted
          ? "Nothing was pasted."
          : terminalPasteErrorMessage(error),
        timeout: 8_000,
        actionProps: undefined,
      };
      if (toastId) toastManager.update(toastId, options);
      else toastManager.add(options);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  const delivery: TerminalFileDelivery = {
    deliver: (plan) => {
      if (plan.kind === "passthrough") return;
      if (plan.kind === "reject") {
        options.writeNotice(plan.message);
        return;
      }
      if (!options.admitInput()) return;
      terminal.focus();
      const paths = (async () => {
        const resolved: string[] = [];
        for (const item of plan.items) {
          const path = item.kind === "path" ? item.path : await stage(item.file);
          if (path) resolved.push(path);
        }
        if (resolved.length === 0) return null;
        return formatTerminalPathPastes(
          resolved,
          options.readDropPathMode(),
          terminal.modes.bracketedPasteMode,
        );
      })();
      options.enqueueDeferred(paths, TERMINAL_PASTE_TIMEOUT_MS + 5_000);
    },
  };

  const onPaste = (event: ClipboardEvent) => {
    const data = event.clipboardData;
    if (!data) return;
    const text = data.getData("text/plain");
    const files = Array.from(data.files);
    if (options.onPasteGesture?.({ text, files })) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const plan = planTerminalPaste({
      text,
      files: files.map((file) => ({ file, nativePath: desktopAttachmentPath(file) })),
      host: terminalPasteHostKind(launch()?.executionTargetId),
    });
    if (plan.kind === "passthrough") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    delivery.deliver(plan);
  };

  const element = terminal.element;
  element?.addEventListener("paste", onPaste, true);
  deliveries.set(terminal, delivery);
  return () => {
    element?.removeEventListener("paste", onPaste, true);
    if (deliveries.get(terminal) === delivery) deliveries.delete(terminal);
  };
}
