/** Training disclosure kept visible but set apart as a muted badge, not glued to the model name. */
export function ContributorTrainingBadge() {
  return (
    <span className="ms-auto shrink-0 rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
      content may be used for training
    </span>
  );
}
