import { useEffect, useRef, useState } from "react";
import type { ThreadId } from "@bigbud/contracts";
import type { ServerOpencodeV2ThreadToolsSetupResult } from "@bigbud/contracts/server/server.opencodeV2ThreadToolsSetup";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ProviderDetails } from "./ProviderDetails";
import {
  isPendingOpenCodeSetup,
  openCodeSetupPollDelay,
} from "../chat/provider/opencodeSetup.observer";

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
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  const scope = JSON.stringify([consented, enabled, configRoot, threadId]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  useEffect(() => {
    generation.current++;
    setDraft(configRoot);
    setResult(null);
    setMessage(null);
    setWorking(false);
  }, [scope, configRoot]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const request = useRef(setupRequest);
  useEffect(() => {
    const jobId = result?.jobId;
    if (!jobId || !enabled || !consented || !isPendingOpenCodeSetup(result)) return;
    let ignored = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const current = generation.current,
      accepted = scope,
      deadline = Date.now() + 300000;
    async function poll() {
      if (
        ignored ||
        Date.now() >= deadline ||
        current !== generation.current ||
        latestScope.current !== accepted
      )
        return;
      try {
        const value = await ensureNativeApi().server.getOpencodeV2ThreadToolsSetup({
          operation: "status",
          jobId: jobId!,
        });
        if (ignored || current !== generation.current || latestScope.current !== accepted) return;
        setResult((previous) => (previous?.jobId === jobId ? { ...previous, ...value } : previous));
        if (!isPendingOpenCodeSetup({ ...value, jobId: jobId! })) return;
        timer = setTimeout(() => void poll(), openCodeSetupPollDelay(value));
      } catch {
        if (!ignored && current === generation.current && latestScope.current === accepted)
          setMessage(
            "Automatic setup status is unavailable; history is retained. Polling did not start another job.",
          );
      }
    }
    timer = setTimeout(() => void poll(), openCodeSetupPollDelay(result));
    return () => {
      ignored = true;
      if (timer) clearTimeout(timer);
    }; // View disposal never cancels another foreground interest.
    // The authorized job identity/scope, not each status reply, owns this bounded observer.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.jobId, scope]);
  useEffect(() => {
    if (setupRequest > request.current && consented && enabled) {
      request.current = setupRequest;
      void load(true);
    }
    // This trigger changes only after an explicit persisted acknowledgement, never settings-open.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [setupRequest, consented, enabled]);

  async function load(refresh: boolean) {
    if (refresh && (!consented || !enabled || draft.trim() !== configRoot)) return;
    const current = ++generation.current;
    const accepted = scope;
    setWorking(true);
    setMessage(null);
    setResult(null);
    try {
      const value = await ensureNativeApi().server.getOpencodeV2ThreadToolsSetup({
        ...(threadId ? { threadId } : {}),
        refresh,
      });
      if (current === generation.current && latestScope.current === accepted) setResult(value);
    } catch {
      if (current === generation.current && latestScope.current === accepted)
        setMessage(
          "Required setup did not verify. Existing history is preserved; no service restart or prompt fallback.",
        );
    } finally {
      if (current === generation.current && latestScope.current === accepted) setWorking(false);
    }
  }
  async function save() {
    if (!onConfigRootChange || saving) return;
    const current = ++generation.current;
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
  async function cancelInterest() {
    if (!result?.jobId || !result.interestId) return;
    const current = ++generation.current,
      accepted = scope;
    try {
      const value = await ensureNativeApi().server.getOpencodeV2ThreadToolsSetup({
        operation: "cancel-interest",
        jobId: result.jobId,
        interestId: result.interestId,
      });
      if (current === generation.current && latestScope.current === accepted) setResult(value);
    } catch {
      if (current === generation.current && latestScope.current === accepted)
        setMessage("Cancellation did not verify; no native work was interrupted.");
    }
  }
  const tone = result?.severity ?? (result?.status === "ready" ? "success" : "warning");
  const colors = {
    info: "text-info",
    success: "text-success",
    warning: "text-warning",
    error: "text-destructive",
  };
  return (
    <section
      className="space-y-3 border-t border-border/60 px-4 py-3 text-sm sm:px-5"
      aria-label="Required canonical thread-tools setup"
    >
      <ProviderDetails label="Thread tools & setup">
        <p>
          The required plugin lets OpenCode create, message, rename and check bigbud chats. Setup
          runs automatically after you allow native tools. Chat directories are detected
          automatically; signing in alone does not enable these tools. OpenCode chats automatically
          verify the bridge and clear the chat qualification notice after success. Native semantic
          qualification may still be incomplete; it is separate from runtime readiness.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={working || saving} onClick={() => void load(false)}>
            Show status
          </Button>
          <Button
            variant="outline"
            disabled={working || saving || !enabled || !consented || draft.trim() !== configRoot}
            onClick={() => void load(true)}
          >
            Retry setup
          </Button>
          {result?.jobId && result.interestId && result.activationState !== "ready" ? (
            <Button variant="outline" onClick={() => void cancelInterest()}>
              Cancel this setup request
            </Button>
          ) : null}
        </div>
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
          <p role="status" className={colors[tone]}>
            {result.message}
          </p>
          {result.qualificationState ? (
            <p className="text-xs text-muted-foreground">
              Native qualification: {result.qualificationState}
              {result.nativeVersion ? ` (${result.nativeVersion})` : ""}
            </p>
          ) : null}
        </div>
      ) : null}
      {message ? (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
      ) : null}
    </section>
  );
}
