import { greetingForChat, renderGreeting } from "@bigbud/shared/greeting";
import { useMemo } from "react";

export interface MobileGreetingContext {
  readonly identity: string | null;
  readonly name: string;
  readonly settingsReady: boolean;
}

/** Generic copy is page-local; current configured names are never cached with the choice. */
export function useMobileGreeting(context: MobileGreetingContext | undefined, eligible: boolean) {
  const identity = context?.identity;
  const ready = eligible && context?.settingsReady === true && identity != null;
  const message = useMemo(() => (ready ? greetingForChat(identity) : null), [identity, ready]);
  return renderGreeting(message, ready ? (context?.name ?? "") : "");
}
