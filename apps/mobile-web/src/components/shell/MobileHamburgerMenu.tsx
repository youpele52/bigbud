import { LogOutIcon, MoonIcon, PanelLeftIcon, RefreshCwIcon, SunIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/cn";
import { useTheme } from "../../theme/useTheme";
import { clearMobileSession } from "../../lib/mobileSession";

interface MobileHamburgerMenuProps {
  onReconnect: () => void;
  onSignOut: () => void;
}

export function MobileHamburgerMenu({ onReconnect, onSignOut }: MobileHamburgerMenuProps) {
  const [open, setOpen] = useState(false);
  const { resolvedTheme, setTheme, theme } = useTheme();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  function toggleTheme() {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
    setOpen(false);
  }

  return (
    <div ref={menuRef} className="relative">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Open menu"
        className="inline-flex size-9 items-center justify-center rounded-full text-foreground transition-colors active:bg-accent"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <PanelLeftIcon className="size-3.5" />
      </button>
      {open ? (
        <div
          className="absolute top-full right-0 z-50 mt-2 min-w-44 rounded-xl border border-border bg-popover py-1 shadow-lg"
          role="menu"
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-foreground transition-colors active:bg-accent"
            onClick={toggleTheme}
            role="menuitem"
            type="button"
          >
            {resolvedTheme === "dark" ? (
              <SunIcon className="size-4 text-muted-foreground" />
            ) : (
              <MoonIcon className="size-4 text-muted-foreground" />
            )}
            <span>
              {theme === "system"
                ? "Toggle theme"
                : resolvedTheme === "dark"
                  ? "Light mode"
                  : "Dark mode"}
            </span>
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-foreground transition-colors active:bg-accent"
            onClick={() => {
              setOpen(false);
              onReconnect();
            }}
            role="menuitem"
            type="button"
          >
            <RefreshCwIcon className="size-4 text-muted-foreground" />
            <span>Reconnect</span>
          </button>
          <button
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-destructive transition-colors active:bg-accent",
            )}
            onClick={() => {
              setOpen(false);
              clearMobileSession();
              onSignOut();
            }}
            role="menuitem"
            type="button"
          >
            <LogOutIcon className="size-4 text-muted-foreground" />
            <span>Sign out</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
