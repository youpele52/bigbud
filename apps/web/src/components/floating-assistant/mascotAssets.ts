import type { FloatingAssistantCaller } from "@bigbud/contracts/server/ipc.ts";

import chromeCelebration from "~/assets/mascot/bigbud-hand/chrome/celebration.webp";
import chromeOkay from "~/assets/mascot/bigbud-hand/chrome/okay.webp";
import chromeThinking from "~/assets/mascot/bigbud-hand/chrome/thinking.webp";
import chromeThumbsUp from "~/assets/mascot/bigbud-hand/chrome/thumbs-up.webp";
import chromeTyping from "~/assets/mascot/bigbud-hand/chrome/typing.webp";
import chromeWave from "~/assets/mascot/bigbud-hand/chrome/wave.webp";
import matteCelebration from "~/assets/mascot/bigbud-hand/matte/celebration.webp";
import matteOkay from "~/assets/mascot/bigbud-hand/matte/okay.webp";
import matteThinking from "~/assets/mascot/bigbud-hand/matte/thinking.webp";
import matteThumbsUp from "~/assets/mascot/bigbud-hand/matte/thumbs-up.webp";
import matteTyping from "~/assets/mascot/bigbud-hand/matte/typing.webp";
import matteWave from "~/assets/mascot/bigbud-hand/matte/wave.webp";

import type { MascotAnimation } from "./mascotAnimation.logic";

export type MascotFinish = Exclude<FloatingAssistantCaller, "logo">;

export const MASCOT_ANIMATIONS = {
  chrome: {
    celebration: chromeCelebration,
    okay: chromeOkay,
    thinking: chromeThinking,
    "thumbs-up": chromeThumbsUp,
    typing: chromeTyping,
    wave: chromeWave,
  },
  matte: {
    celebration: matteCelebration,
    okay: matteOkay,
    thinking: matteThinking,
    "thumbs-up": matteThumbsUp,
    typing: matteTyping,
    wave: matteWave,
  },
} as const satisfies Record<MascotFinish, Record<MascotAnimation, string>>;
