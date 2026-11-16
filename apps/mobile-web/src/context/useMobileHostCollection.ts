import {
  prepareMobileHostRenewal,
  retireMatchingRenewalLegacySession,
} from "../lib/mobileHostRenewal";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";
import type { StoredMobileSession } from "../lib/mobileSession";
import { decodeStoredMobileSession } from "../lib/mobileSession.codec";
import {
  allowsMobileCredentialOrigin,
  currentMobileDeploymentPolicy,
  type MobileDeploymentPolicy,
} from "../logic/mobileDeploymentPolicy";
import {
  EMPTY_MOBILE_HOST_COLLECTION,
  MOBILE_HOST_STORAGE_UNCONFIRMED_MESSAGE,
  MOBILE_HOST_COLLECTION_STORAGE_KEY,
  persistMobileHostCollection,
  prepareMobileHostPairing,
  readMobileHostCollection,
  sameMobileHostCollection,
  type MobileHostCollection,
} from "../lib/mobileHostCollection";

function readInitialCollection() {
  try {
    const result = readMobileHostCollection(window.localStorage);
    return result.status === "ready"
      ? { value: result.value, error: null }
      : {
          value: EMPTY_MOBILE_HOST_COLLECTION,
          error: "Saved hosts could not be read. Existing data has been preserved.",
        };
  } catch {
    return {
      value: EMPTY_MOBILE_HOST_COLLECTION,
      error: "Browser storage is unavailable. Existing data has been preserved.",
    };
  }
}
function containsForeign(policy: MobileDeploymentPolicy, value: MobileHostCollection) {
  return (
    value.collection.entries.some(
      (entry) => !allowsMobileCredentialOrigin(policy, entry.backendOrigin),
    ) ||
    (!!value.legacySession &&
      !allowsMobileCredentialOrigin(policy, value.legacySession.backendBaseUrl))
  );
}
const FOREIGN_DATA_MESSAGE =
  "Saved credentials for another origin are preserved without use. Open that host's own mobile app.";

/** Own storage commits before selection. Host-served origins never copy/store foreign credentials. */
export function useMobileHostCollection() {
  const [state, setState] = useState(readInitialCollection);
  const policy = useMemo(currentMobileDeploymentPolicy, []);
  const currentRef = useRef(state);
  const revisionRef = useRef(0);
  const activeRef = useRef(false);
  const apply = useCallback((next: typeof state) => {
    currentRef.current = next;
    revisionRef.current += 1;
    setState(next);
  }, []);
  useLayoutEffect(() => {
    activeRef.current = true;
    const onStorage = (event: StorageEvent) => {
      if (
        activeRef.current &&
        (event.key === MOBILE_HOST_COLLECTION_STORAGE_KEY || event.key === null)
      )
        apply(readInitialCollection());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      activeRef.current = false;
      revisionRef.current += 1;
      window.removeEventListener("storage", onStorage);
    };
  }, [apply]);
  const commit = useCallback(
    (value: MobileHostCollection) => {
      const current = currentRef.current;
      if (!activeRef.current || current.error) return false;
      if (containsForeign(policy, current.value) || containsForeign(policy, value)) {
        apply({ ...current, error: FOREIGN_DATA_MESSAGE });
        return false;
      }
      let persisted = false;
      try {
        const fresh = readMobileHostCollection(window.localStorage);
        if (fresh.status !== "ready" || !sameMobileHostCollection(fresh.value, current.value)) {
          apply({
            ...current,
            error: "Saved hosts changed in another tab. Reload them before changing connections.",
          });
          return false;
        }
        persisted = persistMobileHostCollection(window.localStorage, value);
      } catch {
        /* The browser storage property itself can throw. */
      }
      if (!persisted) {
        apply({
          ...current,
          error: MOBILE_HOST_STORAGE_UNCONFIRMED_MESSAGE,
        });
        return false;
      }
      apply({ value, error: null });
      return true;
    },
    [apply, policy],
  );
  const select = useCallback(
    (authorityId: string | null, legacySelected = authorityId === null) => {
      const value = currentRef.current.value;
      if (
        authorityId !== null &&
        !value.collection.entries.some((entry) => entry.pin.authority.authorityId === authorityId)
      )
        return false;
      return commit({ ...value, selectedAuthorityId: authorityId, legacySelected });
    },
    [commit],
  );
  const addPairing = useCallback(
    (input: {
      readonly descriptor: RemoteBackendMobileDescriptor;
      readonly backendOrigin: string;
      readonly session: unknown;
      readonly confirmedFirstSeen: boolean;
      readonly expectedRevision: number;
    }) => {
      const current = currentRef.current;
      if (current.error) return { accepted: false, reason: current.error } as const;
      if (!allowsMobileCredentialOrigin(policy, input.backendOrigin))
        return {
          accepted: false,
          reason: "Open that host's own mobile app before pairing.",
        } as const;
      if (input.expectedRevision !== revisionRef.current)
        return {
          accepted: false,
          reason: "Selected host changed while pairing. Start again.",
        } as const;
      const prepared = prepareMobileHostPairing({
        current: current.value,
        ...input,
        now: Date.now(),
      });
      if (!prepared.accepted) return prepared;
      const next = prepared.value.collection.entries.find(
        (entry) => entry.pin.authority.authorityId === prepared.value.selectedAuthorityId,
      );
      const previous =
        next &&
        current.value.collection.entries.find(
          (entry) => entry.pin.authority.authorityId === next.pin.authority.authorityId,
        );
      const renewed = previous && next && previous.session.sessionId !== next.session.sessionId;
      if (
        renewed &&
        (!prepareMobileHostRenewal(previous, next) || !retireMatchingRenewalLegacySession(previous))
      )
        return {
          accepted: false,
          reason:
            "Saved drafts could not be safely retained. Reload saved hosts before pairing again.",
        } as const;
      const value = renewed
        ? {
            ...prepared.value,
            storageVersion: 3 as const,
            ...(prepared.value.legacySession &&
            previous &&
            prepared.value.legacySession.sessionId === previous.session.sessionId &&
            prepared.value.legacySession.backendBaseUrl === previous.backendOrigin &&
            prepared.value.legacySession.sessionToken === previous.session.sessionToken
              ? { legacySession: null }
              : {}),
          }
        : prepared.value;
      return commit(value)
        ? ({ accepted: true } as const)
        : ({
            accepted: false,
            reason: MOBILE_HOST_STORAGE_UNCONFIRMED_MESSAGE,
          } as const);
    },
    [commit, policy],
  );
  const forget = useCallback(
    (authorityId: string, dropLegacy = false) => {
      const value = currentRef.current.value;
      const collection = {
        version: 2 as const,
        entries: value.collection.entries.filter(
          (entry) => entry.pin.authority.authorityId !== authorityId,
        ),
      };
      if (
        collection.entries.length === value.collection.entries.length &&
        (!dropLegacy || value.legacySession === null)
      )
        return true;
      return commit({
        ...value,
        collection,
        ...(dropLegacy ? { legacySession: null } : {}),
        ...(value.selectedAuthorityId === authorityId ? { legacySelected: false } : {}),
        selectedAuthorityId:
          value.selectedAuthorityId === authorityId ? null : value.selectedAuthorityId,
      });
    },
    [commit],
  );
  const activateLegacySession = useCallback(
    (session: StoredMobileSession | null, expectedRevision: number) => {
      if (expectedRevision !== revisionRef.current) return false;
      const value = currentRef.current.value;
      const decoded = session === null ? null : decodeStoredMobileSession(session);
      if (session !== null && (!decoded || Date.parse(decoded.expiresAt) <= Date.now()))
        return false;
      if (
        decoded &&
        (!allowsMobileCredentialOrigin(policy, decoded.backendBaseUrl) ||
          value.collection.entries.some((entry) => entry.backendOrigin === decoded.backendBaseUrl))
      )
        return false;
      return commit({
        ...value,
        selectedAuthorityId: null,
        legacySelected: decoded !== null,
        legacySession: decoded,
      });
    },
    [commit, policy],
  );
  const retryStorage = useCallback(() => {
    if (activeRef.current) apply(readInitialCollection());
  }, [apply]);
  const getRevision = useCallback(() => revisionRef.current, []);
  const reportIssue = useCallback(
    (error: string) => {
      if (activeRef.current) apply({ ...currentRef.current, error });
    },
    [apply],
  );
  return useMemo(() => {
    const savedSelected =
      state.value.collection.entries.find(
        (entry) => entry.pin.authority.authorityId === state.value.selectedAuthorityId,
      ) ?? null;
    const selectedAllowed =
      savedSelected && allowsMobileCredentialOrigin(policy, savedSelected.backendOrigin);
    return {
      ...state,
      policy,
      error: state.error ?? (containsForeign(policy, state.value) ? FOREIGN_DATA_MESSAGE : null),
      selected: selectedAllowed ? savedSelected : null,
      foreignSelectedOrigin: savedSelected && !selectedAllowed ? savedSelected.backendOrigin : null,
      select,
      addPairing,
      forget,
      activateLegacySession,
      retryStorage,
      getRevision,
      reportIssue,
    };
  }, [
    state,
    policy,
    select,
    addPairing,
    forget,
    activateLegacySession,
    retryStorage,
    getRevision,
    reportIssue,
  ]);
}
