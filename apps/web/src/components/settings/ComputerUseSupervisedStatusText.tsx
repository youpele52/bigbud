import { cn } from "~/lib/utils";

import type { AppliedStateCopy } from "./ComputerUseSupervisedSettings.logic";

const TONE_CLASS: Record<AppliedStateCopy["tone"], string> = {
  info: "text-blue-600 dark:text-blue-400",
  success: "text-green-600 dark:text-green-400",
  warning: "text-amber-600 dark:text-amber-400",
  error: "text-red-600 dark:text-red-400",
};

/** Desired/applied state line; tone carries severity (blue/green/amber/red). */
export function ComputerUseSupervisedStatusText({ copy }: { copy: AppliedStateCopy }) {
  return (
    <span role="status" className={cn("text-xs", TONE_CLASS[copy.tone])}>
      {copy.text}
    </span>
  );
}
