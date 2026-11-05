import type { ProviderSessionStartInput } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import { realpath } from "node:fs/promises";

import type { MuseTransport } from "./Client.ts";
import { decodeAccount } from "./Client.schema.ts";

import { describeMuseError, museRequestError, museValidationError } from "./Client.errors.ts";
import type { MusePermissionSelection } from "./Provider.permissions.ts";
import {
  museInteractionModeSupported,
  resolveMusePermissionSelection,
} from "./Provider.permissions.ts";

export function selectionFingerprint(input: {
  readonly model: string;
  readonly subProviderID: string;
  readonly selection: MusePermissionSelection;
}): string {
  return JSON.stringify({
    model: input.model,
    subProviderID: input.subProviderID,
    permissionProfile: input.selection.permissionProfile,
    approvalMode: input.selection.approvalMode,
  });
}

export interface ValidatedMuseStart {
  readonly model: string;
  readonly subProviderID: string;
  readonly selection: MusePermissionSelection;
}

/** Validate a session start before any native prompt/tool side effects. */
export function validateMuseStart(input: ProviderSessionStartInput): ValidatedMuseStart {
  const mode = resolveMusePermissionSelection(input.runtimeMode);
  if (!mode.supported) {
    throw museValidationError("startSession", mode.reason, "invalid-request");
  }
  const selection = input.modelSelection;
  if (!selection || selection.provider !== "muse") {
    throw museValidationError(
      "startSession",
      "Muse requires an explicit Muse model selection from the verified catalog.",
      "invalid-request",
    );
  }
  if (selection.model === "default") {
    throw museValidationError(
      "startSession",
      "The Muse 'default' sentinel is app-only and is never sent natively; choose a verified catalog model.",
      "invalid-request",
    );
  }
  const subProviderID =
    selection.provider === "muse" ? (selection.subProviderID ?? "meta") : "meta";
  if (subProviderID !== "meta") {
    throw museValidationError(
      "startSession",
      `Muse catalog provider '${subProviderID}' is not the qualified Meta catalog.`,
      "invalid-request",
    );
  }
  return { model: selection.model, subProviderID, selection: mode.selection };
}

/**
 * The native host requires every `workspaceRoots` entry to be the canonical
 * path (symlinks resolved; `/tmp` → `/private/tmp` on macOS; true on-disk
 * case on Windows) and rejects anything else as invalid params. The native
 * `fs.promises.realpath` is used deliberately: it fixes Windows case, which
 * the JS realpath does not. Resolve once here so the session, binding and
 * cursor share one plain identity; Client.platform.ts derives the wire form
 * (verbatim on Windows). An unresolvable path is passed through unchanged so
 * the native error, not a fabricated one, surfaces.
 */
export const resolveMuseWorkspace = (cwd: string) =>
  Effect.promise(() => realpath(cwd).catch(() => cwd));

export function validateMuseInteractionMode(interactionMode: string | undefined): void {
  if (interactionMode !== undefined && !museInteractionModeSupported(interactionMode)) {
    throw museValidationError(
      "sendTurn",
      `Muse interaction mode '${interactionMode}' is not supported; plan mode is not native read-only enforcement.`,
      "invalid-request",
    );
  }
}

export const KNOWN_HISTORY_MODES: ReadonlySet<string> = new Set([
  "inline",
  "snapshot",
  "suffix",
  "none",
]);

/**
 * Auth-lane gate before any native session side effects: only the native
 * browser-login lane (`accountLogin`) may proceed. Logged-out gets an
 * explicit sign-in instruction; API-key lanes are rejected with remediation
 * and are never silently used or unset.
 */
export const assertMuseAuthLane = (transport: MuseTransport) =>
  Effect.gen(function* () {
    const accountRaw = yield* Effect.tryPromise({
      try: () => transport.request("account/read", {}),
      catch: (error) => museRequestError("account/read", describeMuseError(error)),
    });
    const account = decodeAccount(accountRaw);
    const accountState = Option.isSome(account) ? account.value.state : undefined;
    if (accountState !== "accountLogin") {
      return yield* museValidationError(
        "startSession",
        accountState === "envKey" || accountState === "apiKey"
          ? "An API key is taking precedence over Muse browser sign-in. Remove the key override and run `muse` in a terminal to sign in; bigbud never uses an API key for Muse."
          : "Muse is not signed in. Run `muse` in a terminal and complete browser sign-in; bigbud never signs in for you.",
        "auth-or-quota",
      );
    }
  });
