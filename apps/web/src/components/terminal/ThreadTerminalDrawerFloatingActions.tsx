import {
  ThreadTerminalDrawerToolbar,
  type ThreadTerminalDrawerToolbarProps,
} from "./ThreadTerminalDrawerToolbar";
import { SOLID_FLOATING_SURFACE_CLASS_NAME } from "../ui/solidSurface";
import { cn } from "~/lib/utils";

export function ThreadTerminalDrawerFloatingActions(
  props: Omit<ThreadTerminalDrawerToolbarProps, "variant">,
) {
  return (
    <div className="pointer-events-none absolute right-2 top-2 z-20">
      <div
        className={cn(
          "pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80",
          SOLID_FLOATING_SURFACE_CLASS_NAME,
        )}
      >
        <ThreadTerminalDrawerToolbar {...props} />
      </div>
    </div>
  );
}
