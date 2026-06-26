import type { ThreadId } from "@bigbud/contracts";
import { useQuery } from "@tanstack/react-query";

import { MobileStartupSplash } from "../components/shell/MobileStartupSplash";
import { useMobileSnapshot } from "../hooks/useMobileSnapshot";
import { MobileCard, MobileMuted, MobilePage } from "../components/shell/MobileShell";
import { useMobileSessionState } from "../context/MobileSessionContext";

export function MobileDiff({ threadId, toTurnCount }: { threadId: ThreadId; toTurnCount: number }) {
  const { session } = useMobileSessionState();
  const { client } = useMobileSnapshot(session);
  const diffQuery = useQuery({
    enabled: client !== null && session !== null,
    queryKey: ["mobile-diff", session?.sessionId ?? "anonymous", threadId, toTurnCount],
    queryFn: () => client!.getFullThreadDiff({ threadId, toTurnCount }),
  });

  if (!session || !client) {
    return (
      <MobilePage>
        <MobileCard>
          <MobileMuted>Pair this phone first.</MobileMuted>
        </MobileCard>
      </MobilePage>
    );
  }

  if (diffQuery.isError) {
    return (
      <MobilePage>
        <MobileCard>
          <MobileMuted>{diffQuery.error.message}</MobileMuted>
        </MobileCard>
      </MobilePage>
    );
  }

  if (!diffQuery.data) {
    return <MobileStartupSplash className="min-h-[calc(100dvh-5rem)]" />;
  }

  return (
    <MobilePage>
      <MobileCard>
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-foreground">
          {diffQuery.data.diff}
        </pre>
      </MobileCard>
    </MobilePage>
  );
}
