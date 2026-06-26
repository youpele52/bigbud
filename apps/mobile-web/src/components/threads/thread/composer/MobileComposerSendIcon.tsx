export function MobileComposerSendIcon({ spinning = false }: { spinning?: boolean | undefined }) {
  if (spinning) {
    return (
      <svg
        aria-hidden="true"
        className="animate-spin"
        fill="none"
        height="14"
        viewBox="0 0 14 14"
        width="14"
      >
        <circle
          cx="7"
          cy="7"
          r="5.5"
          stroke="currentColor"
          strokeDasharray="20 12"
          strokeLinecap="round"
          strokeWidth="1.5"
        />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 14 14" width="14">
      <path
        d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
