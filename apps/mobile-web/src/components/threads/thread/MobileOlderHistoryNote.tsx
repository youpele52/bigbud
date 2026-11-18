/** Shown when the recovery baseline left older messages of this thread on the desktop. */
export function MobileOlderHistoryNote({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <p
      className="pb-2 pt-1 text-center text-xs text-muted-foreground"
      data-mobile-older-history="true"
    >
      Earlier messages are on the desktop.
    </p>
  );
}
