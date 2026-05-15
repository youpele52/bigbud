import { MicIcon, MicOffIcon } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { Ref } from "react";
import { useVoiceTranscribe } from "../../../hooks/useVoiceTranscribe";
import { useSttStore } from "../../../stores/stt/stt.store";
import { toastManager } from "../../ui/toast";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

export interface ComposerMicButtonHandle {
  stopRecording: () => void;
}

interface ComposerMicButtonProps {
  prompt: string;
  onTranscript: (text: string) => void;
  /** Called whenever the recording state changes so the parent can respond. */
  onRecordingChange?: (isRecording: boolean) => void;
  disabled?: boolean;
  /** Imperative handle so the parent can call stopRecording from the listening bar. */
  ref?: Ref<ComposerMicButtonHandle>;
}

/**
 * Microphone button that streams real-time transcription directly into the
 * composer prompt via the OpenAI Realtime transcription WebSocket API.
 *
 * Text that was already in the composer before recording starts is preserved
 * as a prefix; partials are appended after it as they arrive.
 *
 * Rendered greyed-out with a tooltip when no API key has been saved and
 * verified.
 */
export function ComposerMicButton({
  prompt,
  onTranscript,
  onRecordingChange,
  disabled = false,
  ref,
}: ComposerMicButtonProps) {
  const { apiKey, keyVerified } = useSttStore();
  const hasValidKey = !!(apiKey && keyVerified === true);

  // Snapshot of the prompt text that was in the field when recording began.
  const prefixRef = useRef<string>("");

  const handlePartial = useCallback(
    (partial: string) => {
      const prefix = prefixRef.current;
      const combined = prefix.length > 0 ? `${prefix} ${partial}` : partial;
      onTranscript(combined);
    },
    [onTranscript],
  );

  const handleFinal = useCallback(
    (final: string) => {
      const prefix = prefixRef.current;
      const combined = prefix.length > 0 ? `${prefix} ${final}` : final;
      onTranscript(combined);
    },
    [onTranscript],
  );

  const { status, error, startRecording, stopRecording } = useVoiceTranscribe({
    onPartial: handlePartial,
    onFinal: handleFinal,
  });

  const isRecording = status === "recording";
  const isStopping = status === "stopping";
  const isBusy = status === "requesting";

  // Expose stopRecording so the parent's listening bar cancel button can stop it.
  useImperativeHandle(ref, () => ({ stopRecording }), [stopRecording]);

  // Notify parent when the session is active (recording OR waiting for final transcript).
  useEffect(() => {
    onRecordingChange?.(isRecording || isStopping);
  }, [isRecording, isStopping, onRecordingChange]);

  const lastErrorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!error) {
      lastErrorRef.current = null;
      return;
    }
    if (lastErrorRef.current === error) return;
    lastErrorRef.current = error;
    toastManager.add({
      type: "error",
      title: "Voice input failed",
      description: error,
    });
  }, [error]);

  const handleClick = useCallback(() => {
    if (isRecording || isStopping) {
      stopRecording();
    } else {
      // Snapshot the current prompt as the prefix before we start recording.
      prefixRef.current = prompt.trimEnd();
      void startRecording();
    }
  }, [isRecording, isStopping, prompt, startRecording, stopRecording]);

  const button = (
    <button
      type="button"
      disabled={!hasValidKey || isBusy || disabled}
      onClick={handleClick}
      aria-label={
        !hasValidKey
          ? "No OpenAI Key found or verified"
          : isRecording
            ? "Stop recording"
            : isBusy
              ? "Connecting..."
              : "Start voice input"
      }
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded-full transition-all duration-150 sm:h-8 sm:w-8",
        hasValidKey && !disabled
          ? "cursor-pointer text-muted-foreground/70 hover:bg-accent/50 hover:text-foreground/80"
          : "cursor-default text-muted-foreground/30",
      )}
    >
      {hasValidKey ? <MicIcon className="size-4" /> : <MicOffIcon className="size-4" />}
    </button>
  );

  if (!hasValidKey) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span />}>{button}</TooltipTrigger>
        <TooltipPopup>No OpenAI Key found or verified</TooltipPopup>
      </Tooltip>
    );
  }

  return button;
}
