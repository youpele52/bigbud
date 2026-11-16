/** Bounded, credential-free destination text shared by host links and menu rows. */
export function MobileHostDestination({
  origin,
  label,
  prefix = "",
  detail,
}: {
  origin: string;
  label?: string | undefined;
  prefix?: string;
  detail?: string;
}) {
  return (
    <span className="block min-w-0 max-w-full [overflow-wrap:anywhere]">
      <span className="block">
        {prefix}
        {label ?? origin}
      </span>
      {label ? <span className="block text-xs text-muted-foreground">{origin}</span> : null}
      {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
    </span>
  );
}
