import { useRouter } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { MenuItem } from "../../ui/menu";

/** Setup navigation never selects a model or acknowledges native execution trust. */
export function OpenCodeSetupMenuItem({
  message,
  className,
}: {
  message?: string | undefined;
  className?: string | undefined;
}) {
  // The picker is also shared with mobile, whose router has no provider settings page.
  const router = useRouter();
  if (!Object.hasOwn(router.routesByPath, "/settings/providers")) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        Review OpenCode setup and native service trust in desktop or web Providers settings.
      </p>
    );
  }
  return (
    <MenuItem
      className={className}
      title={message}
      onClick={() =>
        void router
          .navigate({
            href: `/settings/providers?${new URLSearchParams({ providers: JSON.stringify(["opencodeV2"]) })}`,
          })
          .catch((error: unknown) => console.warn("Failed to open OpenCode settings", error))
      }
    >
      <SettingsIcon aria-hidden="true" />
      <span>Set up OpenCode</span>
      <span className="ms-auto text-xs text-muted-foreground">Review settings</span>
    </MenuItem>
  );
}
