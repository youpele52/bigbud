/** Colours for the liquid working loader. Values are CSS colours, normally app theme tokens. */
export interface AgentWorkingBlobColors {
  /** Main working colour. */
  readonly working: string;
  /** Colour the working blob quietly shifts to and back from; `null` keeps it solid. */
  readonly shift: string | null;
  /** Settled colour once the work is done. */
  readonly done: string;
}

export type AgentWorkingBlobTone = "agent" | "subagent";

/** Agents shift between the app's working blue and its primary (matte/chrome) colour. */
export const AGENT_WORKING_BLOB_TONES: Record<AgentWorkingBlobTone, AgentWorkingBlobColors> = {
  agent: { working: "var(--info)", shift: "var(--primary)", done: "var(--success)" },
  subagent: { working: "var(--subagent)", shift: "var(--primary)", done: "var(--success)" },
};

/** Default rendered size in CSS pixels. */
export const AGENT_WORKING_BLOB_DEFAULT_SIZE = 14;

/** Smallest size that still reads as a blob inline with 11–12px text. There is no maximum. */
export const AGENT_WORKING_BLOB_MIN_SIZE = 8;

/** Seconds for one quiet working → shift → working colour cycle. */
export const AGENT_WORKING_BLOB_SHIFT_PERIOD_SECONDS = 10;

/** Droplets that split off and melt back into the core. */
export const AGENT_WORKING_BLOB_SATELLITE_COUNT = 5;
