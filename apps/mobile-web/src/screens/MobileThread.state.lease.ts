import { useCallback, useLayoutEffect, useRef } from "react";

import {
  beginMobileComposerDraftLease,
  invalidateMobileComposerDraftLease,
  isMobileComposerDraftLeaseCurrent,
  type MobileComposerDraftIdentity,
  type MobileComposerDraftLease,
} from "../lib/mobileComposerDraft";

/** Only a committed owner acquires a durable-write lease; replay setup acquires a fresh epoch. */
export function useMobileDraftLease(identity: MobileComposerDraftIdentity | null) {
  const backendOrigin = identity?.backendOrigin;
  const sessionId = identity?.sessionId;
  const threadId = identity?.threadId;
  const authorityId = identity?.authorityId;
  const active = useRef<MobileComposerDraftLease | null>(null);
  useLayoutEffect(() => {
    if (backendOrigin === undefined || sessionId === undefined || threadId === undefined) return;
    const lease = beginMobileComposerDraftLease({
      backendOrigin,
      sessionId,
      threadId,
      ...(authorityId === undefined ? {} : { authorityId }),
    });
    active.current = lease;
    return () => {
      if (active.current === lease) active.current = null;
      if (isMobileComposerDraftLeaseCurrent(lease))
        invalidateMobileComposerDraftLease(lease.identity);
    };
  }, [backendOrigin, sessionId, threadId, authorityId]);
  return useCallback(() => {
    const lease = active.current;
    return lease &&
      lease.identity.backendOrigin === backendOrigin &&
      lease.identity.sessionId === sessionId &&
      lease.identity.threadId === threadId &&
      lease.identity.authorityId === authorityId &&
      isMobileComposerDraftLeaseCurrent(lease)
      ? lease
      : null;
  }, [backendOrigin, sessionId, threadId, authorityId]);
}
