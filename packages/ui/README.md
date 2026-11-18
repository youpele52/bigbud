# Shared presentation

`@bigbud/ui` owns presentation needed by both web clients. Import explicit subpaths: `alert`, `statusSurface`, `composerSurface`, `cn` and `notificationTypography.css`. React is a peer dependency. There is no barrel or dependency on application stores, provider lifecycle, server modules or desktop bridges.

The initial extraction preserves existing alert markup, status colors, 14px notification typography and composer surface tokens. Desktop compatibility modules re-export the same implementations; mobile consumes package subpaths directly. Behavior stays with consumer callbacks and children.

Both app stylesheets scan `packages/ui/src` for Tailwind classes. Alerts import notification typography; existing desktop toast consumers retain their CSS compatibility import. When adding a primitive, keep its dependencies presentation-only and verify both consumers. Existing mobile imports of desktop markdown, model pickers and application logic are separate migration debt, not exported through this package.

Run `bun run --cwd packages/ui typecheck` and focused Vitest via `bun run --cwd packages/ui vitest run src/alert.test.tsx`. The central [command reference](../../docs/COMMANDS.md) includes just aliases. Desktop screenshot comparison and physical phone validation remain separate acceptance gates.

Working-status presentation is also shared through `SpinnerVerbShimmer`, `formatWorkingTimer`, `spinnerVerbs` and `spinnerVerbConstants`. The verb list lives in its own constants module; the functions and component retain the desktop implementation. Desktop compatibility exports preserve existing callers, while mobile imports these subpaths directly. No provider/session state or timers move into the package; consumers still own working-state updates.
