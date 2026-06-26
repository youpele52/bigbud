import { useEffect, useRef, useState } from "react";

import { randomSpinnerVerb } from "~/utils/copy";

export function useMobileWorkingState(isWorking: boolean) {
  const [nowTick, setNowTick] = useState(() => Date.now());
  const workingVerbRef = useRef<string | null>(null);

  if (isWorking && workingVerbRef.current === null) {
    workingVerbRef.current = randomSpinnerVerb();
  } else if (!isWorking) {
    workingVerbRef.current = null;
  }

  useEffect(() => {
    if (!isWorking) {
      return;
    }

    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isWorking]);

  return {
    workingVerb: workingVerbRef.current ?? randomSpinnerVerb(),
    nowIso: new Date(nowTick).toISOString(),
  };
}
