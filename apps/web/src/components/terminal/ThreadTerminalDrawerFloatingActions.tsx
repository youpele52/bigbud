import {
  ThreadTerminalDrawerToolbar,
  type ThreadTerminalDrawerToolbarProps,
} from "./ThreadTerminalDrawerToolbar";

export function ThreadTerminalDrawerFloatingActions(
  props: Omit<ThreadTerminalDrawerToolbarProps, "variant">,
) {
  return (
    <div className="pointer-events-none absolute right-2 top-2 z-20">
      <div className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background/70">
        <ThreadTerminalDrawerToolbar {...props} />
      </div>
    </div>
  );
}
