import { QueryClientProvider } from "@tanstack/react-query";
import { useLayoutEffect, useState, type ReactNode } from "react";

import type { StoredMobileSession } from "../lib/mobileSession";
import { MobileRpcProvider } from "./MobileRpcContext";
import {
  copyMobileRuntimeSession,
  createMobileRuntimeOwner,
  sameMobileRuntimeSession,
} from "./MobileRuntimeBoundary.logic";

function MobileRuntimeOwner({ children }: { readonly children: ReactNode }) {
  const [owner] = useState(createMobileRuntimeOwner);
  useLayoutEffect(() => () => owner.dispose(), [owner]);
  return (
    <QueryClientProvider client={owner.queryClient}>
      <MobileRpcProvider>{children}</MobileRpcProvider>
    </QueryClientProvider>
  );
}

/**
 * Replace the entire read/connection/composer owner before rendering a different binding.
 * The opaque React key contains no credentials. Durable drafts/command IDs stay in their
 * existing storage namespaces; this boundary does not authorize or migrate a host session.
 */
export function MobileRuntimeBoundary({
  session,
  children,
}: {
  readonly session: StoredMobileSession | null;
  readonly children: ReactNode;
}) {
  const [active, setActive] = useState(() => ({
    session: copyMobileRuntimeSession(session),
    generation: 1,
  }));
  // React tracks this derived state across abandoned renders; no owner is retired here.
  if (!sameMobileRuntimeSession(active.session, session)) {
    setActive({
      session: copyMobileRuntimeSession(session),
      generation: active.generation + 1,
    });
  }
  return <MobileRuntimeOwner key={active.generation}>{children}</MobileRuntimeOwner>;
}
