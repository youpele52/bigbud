import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useUpdateSettings } from "../../hooks/useSettings";
import { useWelcomeTourStore, type WelcomeTourMode } from "../../stores/ui/welcomeTour.store";
import { FileAccessLevelChoice } from "../file-access/FileAccessLevelChoice";
import {
  applyFileAccessChoice,
  type FileAccessPromptLevel,
} from "../file-access/FileAccessLevelChoice.logic";
import { useGreetingNameDraft } from "../settings/GeneralSettingsGreetingName.hooks";
import { useSidebarNewChatActions } from "../sidebar/Sidebar.state.newChat";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { WELCOME_TOUR_SEEN_PATCH, welcomeTourSteps } from "./WelcomeTourDialog.logic";
import { WelcomeTourProvidersStep } from "./WelcomeTourDialog.providers";
import { WELCOME_TOUR_STEP_COPY, WelcomeTourNameStep } from "./WelcomeTourDialog.steps";

const AUTOFOCUS_SELECTOR = '[data-welcome-autofocus], [aria-pressed="true"]';

function focusStepTarget(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-welcome-tour] ${AUTOFOCUS_SELECTOR}`);
}

/**
 * First-launch welcome tour, mounted once at the app root. The steps write straight to the
 * existing settings; closing it any way (Skip tour, Escape, finishing) records it as seen.
 */
export function WelcomeTourDialog() {
  const open = useWelcomeTourStore((state) => state.open);
  const mode = useWelcomeTourStore((state) => state.mode);
  // Escape and the close button go through the content's skip so a typed name is kept.
  const skipRef = useRef<(() => void) | null>(null);

  return (
    <Dialog
      open={open}
      disablePointerDismissal
      onOpenChange={(nextOpen) => {
        if (!nextOpen) skipRef.current?.();
      }}
    >
      <DialogPopup
        className="max-w-md"
        data-welcome-tour=""
        showCloseButton={false}
        initialFocus={() => focusStepTarget() ?? true}
      >
        <WelcomeTourContent key={mode} mode={mode} skipRef={skipRef} />
      </DialogPopup>
    </Dialog>
  );
}

function WelcomeTourContent({
  mode,
  skipRef,
}: {
  mode: WelcomeTourMode;
  skipRef: MutableRefObject<(() => void) | null>;
}) {
  const steps = welcomeTourSteps(mode);
  const [index, setIndex] = useState(0);
  const step = steps[index] ?? "file-access";
  const isTour = mode === "tour";
  const { updateSettings } = useUpdateSettings();
  const greetingName = useGreetingNameDraft();
  const [level, setLevel] = useState<FileAccessPromptLevel>("unrestricted");
  const [busy, setBusy] = useState(false);
  const [openProvidersAfterTour, setOpenProvidersAfterTour] = useState(false);
  const closeTour = useWelcomeTourStore((state) => state.closeTour);
  const requestWelcomeGreeting = useWelcomeTourStore((state) => state.requestWelcomeGreeting);
  const navigate = useNavigate();
  const { handleNewChats } = useSidebarNewChatActions(useHandleNewThread());
  const closedRef = useRef(false);

  useEffect(() => {
    focusStepTarget()?.focus();
  }, [index]);

  const close = useCallback(() => {
    if (closedRef.current) return false;
    closedRef.current = true;
    updateSettings(WELCOME_TOUR_SEEN_PATCH);
    closeTour();
    return true;
  }, [closeTour, updateSettings]);

  const skip = useCallback(() => {
    // Skipping never discards a name that was typed but not saved yet.
    if (greetingName.draft.trim() !== greetingName.name) void greetingName.save(greetingName.draft);
    close();
  }, [close, greetingName]);
  skipRef.current = skip;

  const finish = useCallback(async () => {
    if (!close() || !isTour) return;
    if (openProvidersAfterTour) {
      await navigate({ to: "/settings/providers", search: { providers: [] } });
    } else {
      await handleNewChats();
    }
    requestWelcomeGreeting();
  }, [close, handleNewChats, isTour, navigate, openProvidersAfterTour, requestWelcomeGreeting]);

  const next = useCallback(async () => {
    if (step === "name" && !(await greetingName.save(greetingName.draft))) return;
    setIndex((current) => Math.min(current + 1, steps.length - 1));
  }, [greetingName, step, steps.length]);

  const allowFileAccess = useCallback(async () => {
    setBusy(true);
    await applyFileAccessChoice(level, updateSettings);
    setBusy(false);
    await finish();
  }, [finish, level, updateSettings]);

  const copy = WELCOME_TOUR_STEP_COPY[step];
  const disabled = busy || greetingName.saving;

  return (
    <>
      <DialogHeader>
        {isTour ? (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            Welcome to bigbud · Step {index + 1} of {steps.length}
          </p>
        ) : null}
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>

      <DialogPanel>
        {step === "name" ? (
          <WelcomeTourNameStep greetingName={greetingName} onSubmit={() => void next()} />
        ) : null}
        {step === "providers" ? (
          <WelcomeTourProvidersStep
            onOpenProvidersAfterTour={() => {
              setOpenProvidersAfterTour(true);
              void next();
            }}
          />
        ) : null}
        {step === "file-access" ? (
          <>
            <FileAccessLevelChoice value={level} onChange={setLevel} disabled={disabled} />
            {openProvidersAfterTour ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Settings → Providers opens when you finish.
              </p>
            ) : null}
          </>
        ) : null}
      </DialogPanel>

      <DialogFooter className="sm:justify-between">
        <Button variant="ghost" size="sm" onClick={skip} disabled={busy}>
          {isTour ? "Skip tour" : "Maybe Later"}
        </Button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          {index > 0 ? (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => setIndex((current) => Math.max(current - 1, 0))}
            >
              Back
            </Button>
          ) : null}
          {step === "file-access" && isTour ? (
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => void finish()}>
              Not now
            </Button>
          ) : null}
          {step === "file-access" ? (
            <Button size="sm" disabled={disabled} onClick={() => void allowFileAccess()}>
              {busy ? (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Saving...
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <CheckIcon className="size-3.5" />
                  Allow
                </span>
              )}
            </Button>
          ) : (
            <Button size="sm" disabled={disabled} onClick={() => void next()}>
              {step === "name" && !greetingName.draft.trim() ? "Skip" : "Next"}
            </Button>
          )}
        </div>
      </DialogFooter>
    </>
  );
}
