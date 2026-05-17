import { CheckIcon, InfoIcon, KeyRoundIcon, LoaderIcon, MicIcon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { type SttModel, useSttStore } from "../../stores/stt/stt.store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const STT_MODEL_OPTIONS: ReadonlyArray<{ value: SttModel; label: string; detail: string }> = [
  {
    value: "gpt-realtime-whisper",
    label: "GPT Realtime Whisper",
    detail: "Live streaming transcription",
  },
];

async function verifyOpenAIKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function SttSettingsSection() {
  const { apiKey, keyVerified, selectedModel, setApiKey, setKeyVerified, setSelectedModel } =
    useSttStore();
  const [draftKey, setDraftKey] = useState(apiKey);
  const [isVerifying, setIsVerifying] = useState(false);

  const isDirty = draftKey !== apiKey;
  const isMac = /mac/i.test(navigator.platform);

  const handleVerify = useCallback(async () => {
    const trimmedKey = draftKey.trim();
    if (!trimmedKey) return;

    setIsVerifying(true);
    try {
      const ok = await verifyOpenAIKey(trimmedKey);
      setApiKey(trimmedKey);
      setKeyVerified(ok);
      if (ok) {
        // Auto-select cheapest model on first successful verify if not already set.
        setSelectedModel(selectedModel);
      }
    } finally {
      setIsVerifying(false);
    }
  }, [draftKey, selectedModel, setApiKey, setKeyVerified, setSelectedModel]);

  const handleClear = useCallback(() => {
    setDraftKey("");
    setApiKey("");
    setKeyVerified(null);
  }, [setApiKey, setKeyVerified]);

  const keyStatusNode =
    keyVerified === true ? (
      <span className="flex items-center gap-1 text-[11px] text-green-500">
        <CheckIcon className="size-3" />
        Verified
      </span>
    ) : keyVerified === false ? (
      <span className="flex items-center gap-1 text-[11px] text-destructive">
        <XIcon className="size-3" />
        Invalid key
      </span>
    ) : apiKey ? (
      <span className="text-[11px] text-muted-foreground">Saved — not yet verified</span>
    ) : null;

  return (
    <SettingsSection title="Speech to Text" icon={<MicIcon className="size-3" />}>
      <SettingsRow
        title="OpenAI API Key"
        description="Used to transcribe microphone audio via the OpenAI Realtime transcription API. Stored locally only — never sent to the bigbud server."
        status={keyStatusNode}
      >
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <KeyRoundIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
            <Input
              type="password"
              className="pl-7"
              placeholder="sk-..."
              value={draftKey}
              onChange={(event) => {
                setDraftKey(event.target.value);
                if (keyVerified !== null) setKeyVerified(null);
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              disabled={!draftKey.trim() || isVerifying}
              onClick={() => void handleVerify()}
            >
              {isVerifying ? (
                <>
                  <LoaderIcon className="size-3.5 animate-spin" />
                  Verifying...
                </>
              ) : isDirty ? (
                "Save & Verify"
              ) : (
                "Re-verify"
              )}
            </Button>
            {apiKey ? (
              <Button
                type="button"
                variant="ghost"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={handleClear}
                aria-label="Clear API key"
              >
                <XIcon className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </div>
      </SettingsRow>

      <SettingsRow
        title="Transcription model"
        description="Model used for live microphone transcription. The app opens an OpenAI Realtime transcription session and uses GPT Realtime Whisper for streaming speech-to-text."
        control={
          <Select
            value={selectedModel}
            onValueChange={(value) => setSelectedModel(value as SttModel)}
          >
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {STT_MODEL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <span className="flex items-baseline gap-1.5">
                    {option.label}
                    <span className="text-xs text-muted-foreground">{option.detail}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      {isMac && (
        <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
          <InfoIcon className="mt-0.5 size-3 shrink-0" />
          <span>
            On macOS, the first time you use voice input the system will ask for microphone
            permission. If you denied it previously, re-enable it in{" "}
            <strong className="text-foreground/80">
              System Settings → Privacy &amp; Security → Microphone
            </strong>
            .
          </span>
        </div>
      )}
    </SettingsSection>
  );
}
