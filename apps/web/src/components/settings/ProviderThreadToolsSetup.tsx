import { useEffect, useRef, useState } from "react";
import type { ThreadId } from "@bigbud/contracts";
import type {
  ServerOpencodeV2ThreadToolsSetupInput,
  ServerOpencodeV2ThreadToolsSetupResult,
} from "@bigbud/contracts/server/server.opencodeV2ThreadToolsSetup";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ProviderDetails } from "./ProviderDetails";
import { OpenCodeSetupStatus } from "../chat/provider/OpenCodeSetupStatus";
import { observeOpenCodeSetup } from "../chat/provider/opencodeSetup.observer";

/** Only explicit acknowledgement/retry installs; config placement is separate from inferred chat cwd. */
export function ProviderThreadToolsSetup({
  consented = false,
  enabled = false,
  configRoot = "",
  onConfigRootChange,
  setupRequest = 0,
  threadId,
}: {
  consented?: boolean;
  enabled?: boolean;
  configRoot?: string;
  onConfigRootChange?: ((root: string) => Promise<void>) | undefined;
  setupRequest?: number;
  threadId?: ThreadId | undefined;
}) {
  const [draft, setDraft] = useState(configRoot);
  const [result, setResult] = useState<ServerOpencodeV2ThreadToolsSetupResult | null>(null);
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
  const stopObservation = useRef<(() => void) | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  const scope = JSON.stringify([consented, enabled, configRoot, threadId]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  useEffect(() => {
    generation.current++;
    stopObservation.current?.();
    setDraft(configRoot);
    setResult(null);
    setMessage(null);
    setWorking(false);
  }, [scope, configRoot]);
  useEffect(
    () => () => {
      generation.current++;
      stopObservation.current?.();
    },
    [],
  );
  const request = useRef(setupRequest);
  useEffect(() => {
    if (setupRequest > request.current && consented && enabled) {
      request.current = setupRequest;
      void load(true);
    }
    // This trigger changes only after an explicit persisted acknowledgement, never settings-open.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [setupRequest, consented, enabled]);

  function load(refresh: boolean) {
    if (refresh && (!consented || !enabled || draft.trim() !== configRoot)) return;
    observe(
      !refresh && result?.jobId
        ? { operation: "status", jobId: result.jobId }
        : { ...(threadId ? { threadId } : {}), refresh },
    );
  }
  function observe(input: ServerOpencodeV2ThreadToolsSetupInput) {
    stopObservation.current?.();
    const current = ++generation.current;
    const accepted = scope;
    setWorking(true);
    setMessage(null);
    stopObservation.current = observeOpenCodeSetup(
      (request) => ensureNativeApi().server.getOpencodeV2ThreadToolsSetup(request),
      input,
      (value) => {
        if (current !== generation.current || latestScope.current !== accepted) return;
        setResult((previous) =>
          input.operation === "status" && previous?.jobId === input.jobId
            ? { ...previous, ...value }
            : value,
        );
        setWorking(false);
      },
      () => {
        if (current !== generation.current || latestScope.current !== accepted) return;
        setWorking(false);
        setMessage(
          "Setup status observation stopped or timed out. The last reported result is retained and the job may still be running. Use Show status to check again; history is preserved and no prompt was replayed.",
        );
      },
    );
  }
  async function save() {
    if (!onConfigRootChange || saving) return;
    const current = ++generation.current;
    stopObservation.current?.();
    setSaving(true);
    setWorking(false);
    setResult(null);
    setMessage(null);
    try {
      await onConfigRootChange(draft.trim());
    } catch {
      if (current === generation.current)
        setMessage(
          "Plugin configuration directory was not saved. Use an absolute directory or clear the override.",
        );
    } finally {
      setSaving(false);
    }
  }
  function cancelInterest() {
    if (!result?.jobId || !result.interestId) return;
    observe({
      operation: "cancel-interest",
      jobId: result.jobId,
      interestId: result.interestId,
    });
  }
  return (
    <section
      className="space-y-3 border-t border-border/60 px-4 py-3 text-sm sm:px-5"
      aria-label="Required canonical thread-tools setup"
    >
      {result ? (
        <OpenCodeSetupStatus
          result={result}
          error={message}
          disabled={working || saving || !enabled || !consented || draft.trim() !== configRoot}
          onRetry={() => void load(true)}
          onCancel={() => void cancelInterest()}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={working || saving} onClick={() => void load(false)}>
          Show status
        </Button>
        {!result ? (
          <Button
            variant="outline"
            disabled={working || saving || !enabled || !consented || draft.trim() !== configRoot}
            onClick={() => void load(true)}
          >
            Retry setup
          </Button>
        ) : null}
      </div>
      <ProviderDetails label="Thread tools & setup">
        <p>
          The required plugin lets OpenCode create, message, rename and check bigbud chats. Setup
          runs automatically after you allow native tools. Chat directories are detected
          automatically; signing in alone does not enable these tools. OpenCode chats automatically
          verify the bridge and clear the chat qualification notice after success. Native semantic
          qualification may still be incomplete; it is separate from runtime readiness.
        </p>
        <ProviderDetails label="Plugin configuration">
          <label className="block text-xs">
            Plugin config directory (optional)
            <Input
              className="mt-1.5"
              aria-label="Plugin config directory (optional)"
              placeholder="Default: native user-level opencode config directory"
              value={draft}
              spellCheck={false}
              disabled={saving}
              onChange={(event) => {
                generation.current++;
                stopObservation.current?.();
                setDraft(event.target.value);
                setResult(null);
                setWorking(false);
                setMessage(null);
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Leave blank for the user-level default; this changes plugin placement, never the chat
            directory.
          </p>
          <Button
            variant="outline"
            disabled={saving || !onConfigRootChange || draft.trim() === configRoot}
            onClick={() => void save()}
          >
            Save
          </Button>
        </ProviderDetails>
        <ProviderDetails label="Setup details">
          <p>
            After expanded native trust, required global plugin setup is automatic and reused across
            projects. Opening settings or disclosures does not install anything. First installation
            and breaking updates wait for known native work; other clients remain a best-effort
            race. Compatible broker updates do not reload native registrations. Retrying never
            bypasses runtime checks or changes native permissions.
          </p>
          {result ? (
            <>
              <p>Detected chat Location: {result.directory}</p>
              {result.nativePluginConfigRoot ? (
                <p>Native plugin config: {result.nativePluginConfigRoot}</p>
              ) : null}
              {result.defaultImplementationDigest ? (
                <p>
                  Default broker implementation: {result.defaultImplementationDigest}
                  {result.activeImplementationDigest
                    ? ` · Pinned owner: ${result.activeImplementationDigest}`
                    : ""}
                </p>
              ) : null}
            </>
          ) : null}
        </ProviderDetails>
      </ProviderDetails>
      {working ? (
        <p role="status" className="text-info">
          Verifying required setup for the detected Location…
        </p>
      ) : null}
      {result ? (
        <div>
          {result.qualificationState ? (
            <p className="text-xs text-muted-foreground">
              Native qualification: {result.qualificationState}
              {result.nativeVersion ? ` (${result.nativeVersion})` : ""}
            </p>
          ) : null}
        </div>
      ) : null}
      {message && !result ? (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
      ) : null}
    </section>
  );
}
