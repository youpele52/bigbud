export const MASCOT_SINGLE_CLICK_DELAY_MS = 250;

export function createMascotClickHandler(actions: {
  readonly onOpenChat: () => void;
  readonly onOpenMain: () => void;
}) {
  let pendingClick: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (pendingClick === null) return;
    clearTimeout(pendingClick);
    pendingClick = null;
  };

  return {
    cancel,
    handleClick: (clickCount: number) => {
      if (clickCount > 1) {
        cancel();
        if (clickCount === 2) actions.onOpenMain();
        return;
      }
      cancel();
      pendingClick = setTimeout(() => {
        pendingClick = null;
        actions.onOpenChat();
      }, MASCOT_SINGLE_CLICK_DELAY_MS);
    },
  };
}
