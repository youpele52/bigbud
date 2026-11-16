import { createContext, useContext } from "react";

import type { StoredMobileSession } from "../lib/mobileSession";

import type { useMobileHostDirectory } from "../hooks/useMobileHostDirectory";
import type { useMobileHostCollection } from "./useMobileHostCollection";
import type { useMobileHostAdmission } from "./useMobileHostAdmission";

export interface MobileHostsState {
  readonly directory: ReturnType<typeof useMobileHostDirectory>;
  readonly legacySession: StoredMobileSession | null;
  readonly forgetSelected: () => boolean;
  readonly selectHost: (authorityId: string | null, legacySelected?: boolean) => boolean;
  readonly hosts: ReturnType<typeof useMobileHostCollection>;
  readonly admission: ReturnType<typeof useMobileHostAdmission>;
}
export const MobileHostsContext = createContext<MobileHostsState | null>(null);

/** Existing legacy/isolated consumers need not invent a verified host context. */
export function useMobileHosts() {
  return useContext(MobileHostsContext);
}
