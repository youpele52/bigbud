import type { Icon } from "../Icons";

export function SidebarThreadProviderIcon({
  animationClass,
  colorClass,
  icon: ProviderIcon,
}: {
  animationClass: string;
  colorClass: string;
  icon: Icon;
}) {
  return (
    <span
      aria-hidden="true"
      data-slot="thread-provider-icon"
      className={`inline-flex size-3 shrink-0 items-center justify-center transition-[color,opacity] duration-200 ease-out ${colorClass}`}
    >
      <ProviderIcon focusable="false" className={`size-3 shrink-0 ${animationClass}`.trim()} />
    </span>
  );
}
