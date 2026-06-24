import { createContext, useContext } from "react";

import type { StoredMobileSession } from "./mobileSession";

export interface MobileSessionState {
  readonly session: StoredMobileSession | null;
  readonly setSession: (session: StoredMobileSession | null) => void;
}

export const MobileSessionContext = createContext<MobileSessionState>({
  session: null,
  setSession: () => undefined,
});

export function useMobileSessionState() {
  return useContext(MobileSessionContext);
}
