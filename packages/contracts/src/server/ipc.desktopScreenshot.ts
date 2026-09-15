/** A desktop-owned screenshot awaiting insertion into a floating chat draft. */
export interface CompactChatScreenshot {
  readonly id: string;
  readonly threadId: string;
  readonly name: string;
  readonly mimeType: "image/jpeg";
  readonly sizeBytes: number;
  readonly dataUrl: string;
}

export interface DesktopScreenshotBridge {
  readonly compactChatScreenshot?: {
    /** Claim pending capture for the restored chat; repeated reads keep its destination. */
    getPending: (threadId: string) => Promise<CompactChatScreenshot | null>;
    /** Release a delivered or explicitly discarded capture. */
    acknowledge: (captureId: string) => Promise<boolean>;
    onAvailable: (listener: () => void) => () => void;
  };
}
