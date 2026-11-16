import { useLayoutEffect, useRef, useState } from "react";
import type { MobileHostsState } from "../../context/MobileHostsContext";
import { Button } from "../ui/button";

/** Scoped to the exact selected connection by the parent, including credential renewal. */
export function MobileHostAdmissionActions({ context }: { context: MobileHostsState }) {
  const [confirmForget, setConfirmForget] = useState(false);
  const retry = useRef<HTMLButtonElement>(null);
  const forget = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const focus = useRef<"retry" | "forget" | "keep" | null>(null);
  useLayoutEffect(() => {
    const element =
      focus.current === "retry"
        ? retry.current
        : focus.current === "forget"
          ? forget.current
          : focus.current === "keep"
            ? keep.current
            : null;
    if (!element) return;
    if (document.activeElement === document.body || !document.activeElement?.isConnected)
      element.focus();
    focus.current = null;
  });
  return (
    <>
      {context.admission.status !== "checking" ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            ref={retry}
            className="min-h-11"
            onClick={() => {
              focus.current = "retry";
              context.admission.retry();
            }}
          >
            Retry identity verification
          </Button>
          <Button
            className="min-h-11"
            variant="outline"
            onClick={() => context.selectHost(null, false)}
          >
            Leave selected host
          </Button>
        </div>
      ) : null}
      {confirmForget ? (
        <div className="mt-3 grid gap-2 text-sm">
          <p>Forget this host's saved authorization and local drafts? Other hosts are kept.</p>
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-11" onClick={() => context.forgetSelected()}>
              Forget this host
            </Button>
            <Button
              ref={keep}
              className="min-h-11"
              variant="outline"
              onClick={() => {
                focus.current = "forget";
                setConfirmForget(false);
              }}
            >
              Keep host
            </Button>
          </div>
        </div>
      ) : (
        <Button
          ref={forget}
          className="mt-3 min-h-11"
          variant="outline"
          onClick={() => {
            focus.current = "keep";
            setConfirmForget(true);
          }}
        >
          Forget host
        </Button>
      )}
    </>
  );
}
