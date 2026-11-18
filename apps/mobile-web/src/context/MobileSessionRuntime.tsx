import { forgetMobileHostConnection } from "./MobileSessionRuntime.forget";
import { allowsMobileCredentialOrigin } from "../logic/mobileDeploymentPolicy";
import { useMobileHostDirectory } from "../hooks/useMobileHostDirectory";
import { MobileCrossHostNavigation } from "../components/shell/MobileCrossHostNavigation";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useTheme } from "../theme/useTheme";
import {
  isMobileSessionExpired,
  readMobileSession,
  type StoredMobileSession,
} from "../lib/mobileSession";
import { MobileHostAdmissionScreen } from "../components/shell/MobileHostAdmissionScreen";
import { MobileHostsContext } from "./MobileHostsContext";
import { useMobileHostCollection } from "./useMobileHostCollection";
import { useMobileHostAdmission } from "./useMobileHostAdmission";
import { sameMobileRuntimeSession } from "./MobileRuntimeBoundary.logic";
import { MobileRuntimeBoundary } from "./MobileRuntimeBoundary";
import { MobileSessionContext } from "./MobileSessionContext";
import { getMobileSessionAuthority } from "../lib/mobileSessionAuthority";
import { readMobileSelectedThread } from "../lib/mobileHostSelection";

export function MobileSessionRuntime({
  children,
}: {
  readonly children: (
    session: StoredMobileSession | null,
    setSession: Dispatch<SetStateAction<StoredMobileSession | null>>,
  ) => ReactNode;
}) {
  useTheme();
  const [legacyFallback, setLegacyFallback] = useState(() => {
    const current = readMobileSession();
    if (current && isMobileSessionExpired(current)) {
      return null;
    }
    return current;
  });
  const hosts = useMobileHostCollection();
  const directory = useMobileHostDirectory();
  const legacySource =
    hosts.value.legacySession === undefined ? legacyFallback : hosts.value.legacySession;
  const [legacyStored, setLegacyStored] = useState(legacySource);
  if (!sameMobileRuntimeSession(legacyStored, legacySource)) setLegacyStored(legacySource);
  // Retained legacy credentials cannot bypass an identity already pinned for that origin.
  const legacySession =
    legacyStored &&
    allowsMobileCredentialOrigin(hosts.policy, legacyStored.backendBaseUrl) &&
    !hosts.value.collection.entries.some(
      (entry) => entry.backendOrigin === legacyStored.backendBaseUrl,
    )
      ? legacyStored
      : null;
  const foreignOrigin =
    hosts.foreignSelectedOrigin ??
    (!hosts.selected &&
    hosts.value.legacySelected !== false &&
    legacyStored &&
    !allowsMobileCredentialOrigin(hosts.policy, legacyStored.backendBaseUrl)
      ? legacyStored.backendBaseUrl
      : null);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const pairingRoute = pathname.startsWith("/mobile/pair/");
  const admission = useMobileHostAdmission(pairingRoute ? null : hosts.selected);
  const session = pairingRoute
    ? null
    : foreignOrigin
      ? null
      : hosts.selected
        ? admission.session
        : hosts.value.legacySelected === false
          ? null
          : legacySession;
  const navigate = useNavigate();
  const pendingRestore = useRef<string | null>(null);
  const selectHost = useCallback(
    (
      authorityId: string | null,
      legacySelected = authorityId === null && legacySession !== null,
    ) => {
      if (!hosts.select(authorityId, legacySelected)) return false;
      pendingRestore.current = authorityId;
      void navigate({ to: "/mobile", replace: true, state: {} });
      return true;
    },
    [hosts, legacySession, navigate],
  );
  useEffect(() => {
    const authority = getMobileSessionAuthority(session);
    if (!authority || authority !== pendingRestore.current) return;
    pendingRestore.current = null;
    if (pathname !== "/mobile") return;
    const selectedThread = readMobileSelectedThread(session);
    if (selectedThread)
      void navigate({
        to: "/mobile/thread/$threadId",
        params: { threadId: selectedThread },
        replace: true,
        state: {},
      });
  }, [session, pathname, navigate]);
  const forgetSelected = useCallback(
    () =>
      forgetMobileHostConnection({
        selected: hosts.selected,
        legacyStored,
        forgetHost: hosts.forget,
        forgetLegacy: () => hosts.activateLegacySession(null, hosts.getRevision()),
        onPersisted: () => {
          pendingRestore.current = null;
        },
        onLegacyCleared: () => setLegacyFallback(null),
        reportIssue: hosts.reportIssue,
      }),
    [hosts, legacyStored],
  );
  const setSession: Dispatch<SetStateAction<StoredMobileSession | null>> = useCallback(
    (next) => {
      const value = typeof next === "function" ? next(session) : next;
      if (value === null) {
        forgetSelected();
        return;
      }
      hosts.activateLegacySession(value, hosts.getRevision());
    },
    [forgetSelected, hosts, session],
  );
  const sessionContextValue = useMemo(() => ({ session, setSession }), [session, setSession]);
  const hostsContextValue = useMemo(
    () => ({ hosts, directory, admission, legacySession, forgetSelected, selectHost }),
    [hosts, directory, admission, legacySession, forgetSelected, selectHost],
  );
  const blocked = hosts.selected && !admission.session && !pathname.startsWith("/mobile/pair/");
  return (
    <MobileHostsContext.Provider value={hostsContextValue}>
      <MobileSessionContext.Provider value={sessionContextValue}>
        <MobileRuntimeBoundary session={session}>
          {foreignOrigin && !pathname.startsWith("/mobile/pair/") ? (
            <MobileCrossHostNavigation backendOrigin={foreignOrigin} />
          ) : blocked ? (
            <MobileHostAdmissionScreen />
          ) : (
            children(session, setSession)
          )}
        </MobileRuntimeBoundary>
      </MobileSessionContext.Provider>
    </MobileHostsContext.Provider>
  );
}
