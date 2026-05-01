import { XIcon } from "lucide-react";

interface ComposerListeningBarProps {
  onStop: () => void;
}

/**
 * Compact listening indicator shown in the composer's right-side action area
 * while STT is active. Replaces the mic and send buttons while recording.
 */
export function ComposerListeningBar({ onStop }: ComposerListeningBarProps) {
  return (
    <div className="flex items-center gap-2">
      <WaveformBars />
      <span className="select-none text-xs text-muted-foreground/80">Listening</span>
      {/* Stop button */}
      <button
        type="button"
        onClick={onStop}
        aria-label="Stop recording"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/40 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:h-7 sm:w-7"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

/** Five animated bars that mimic an audio waveform. */
function WaveformBars() {
  return (
    <span className="flex items-center gap-[3px]" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="block w-[3px] rounded-full bg-muted-foreground/60"
          style={{
            animation: `stt-bar 1s ease-in-out infinite`,
            animationDelay: `${i * 0.12}s`,
          }}
        />
      ))}
      <style>{`
        @keyframes stt-bar {
          0%, 100% { height: 4px; }
          50%       { height: 16px; }
        }
      `}</style>
    </span>
  );
}
