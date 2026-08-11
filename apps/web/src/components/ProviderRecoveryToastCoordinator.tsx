import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ServerProvider } from "@bigbud/contracts";

import { useServerProviders } from "../rpc/serverState";
import { toastManager } from "./ui/toast";
import { getProviderToastDecision } from "./ProviderRecoveryToastCoordinator.logic";

export function ProviderRecoveryToastCoordinator() {
  const providers = useServerProviders();
  const navigate = useNavigate();
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const sawRecoveryRef = useRef(false);
  const notifiedInitialFailureRef = useRef(false);

  useEffect(() => {
    const decision = getProviderToastDecision(providers, {
      sawRecovery: sawRecoveryRef.current,
      notifiedInitialFailure: notifiedInitialFailureRef.current,
    });
    sawRecoveryRef.current = decision.state.sawRecovery;
    notifiedInitialFailureRef.current = decision.state.notifiedInitialFailure;
    if (decision.kind === "none") return;
    const show = (toast: Parameters<typeof toastManager.add>[0]) => {
      if (toastIdRef.current) toastManager.update(toastIdRef.current, toast);
      else toastIdRef.current = toastManager.add(toast);
    };
    const openProviders = (affected: ReadonlyArray<ServerProvider>) =>
      void navigate({
        to: "/settings/providers",
        search: { providers: affected.map((provider) => provider.provider) },
      });

    if (decision.kind === "recovery" || decision.kind === "attention") {
      show({
        type: "warning",
        title: decision.title!,
        description: decision.description!,
        timeout: 0,
        data: { hideCopyButton: true },
        actionProps: {
          children: decision.kind === "recovery" ? "View providers" : "Review providers",
          onClick: () => openProviders(decision.affected),
        },
      });
      return;
    }
    if (decision.kind === "success") {
      show({
        type: "success",
        title: decision.title!,
        description: decision.description!,
        data: { hideCopyButton: true },
      });
      toastIdRef.current = null;
    }
  }, [navigate, providers]);

  return null;
}
