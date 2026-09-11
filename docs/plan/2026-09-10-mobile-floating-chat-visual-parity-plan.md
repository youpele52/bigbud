# Mobile Floating Chat Visual Parity Plan

**Date:** 10 September 2026  
**Status:** Ready for implementation  
**Document lifecycle:** Proposed  
**Owner:** Planning agent; implementation owner unassigned

| Field            | Value                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Created          | 2026-09-10T20:57:02+02:00                                                                        |
| Last modified    | 2026-09-10T21:08:50+02:00                                                                        |
| Project root     | `/Users/youpele/DevWorld/bigbud`                                                                 |
| Inspected branch | `main`                                                                                           |
| Inspected commit | `75f02a937226129f2ca5e44475a64e546dfd4e3a`                                                       |
| Initial worktree | Untracked `docs/plan/2026-09-10-rust-coordinated-thread-auto-resume-plan.md`; no tracked changes |
| Related issue ID | None supplied                                                                                    |
| Authorization    | Update and save this plan; no implementation, commit, or push                                    |

## Summary

Redesign the mobile conversation screen using the floating chat on the **right** of the user's comparison screenshot as the primary visual reference. The left-hand mobile screen is the design to replace. This is a substantial presentation update across the conversation screen, not merely an icon refresh or a few spacing adjustments.

Use the floating chat's actual design patterns and styles as closely as mobile usability permits: header, typography, colors, borders, spacing, empty state, conversation presentation, composer, and context row. The composer is the highest-priority visual match. Prefer identical presentation where possible; document each meaningful departure with a concrete mobile usability or supported-functionality reason.

Retain mobile's existing transport, recovery, routes, draft storage, and interaction ownership. Desktop window chrome and Electron behavior are not part of the visual target.

## Related Work

- User-provided screenshots: current mobile navigation, mobile-left/floating-right comparison, desktop sidebar icon reference, and annotated floating header. The later clarification explicitly requires broad visual parity, especially the composer.
- [Earlier mobile adaptation plan](2026-09-06-mobile-floaty-chat-adaptation-plan.md): historical layout and reliability context. This plan supersedes its `[Chats | title | New]` visual direction for the new presentation work; it does not invalidate its reliability requirements or erase its history.
- [Mobile recovery correctness plan](2026-09-09-mobile-recovery-correctness-plan.md) and [validation evidence](../validation/2026-09-10-mobile-recovery-correctness-evidence.md): preserve existing recovery work rather than reopening it as part of styling.
- Stable note, Kanban, issue, or PR reference: none identified in the supplied task context. Do not invent one.

## Problem

The mobile screen has a prominent Chats button, labeled New action, text-only empty state, additional composer separator/insets, and a bordered model-picker pill. These differ noticeably from the floating chat's compact header, centered logo, integrated composer toolbar, and restrained surfaces. The user explicitly dislikes the current mobile design and wants most of the floating chat's design copied or reused.

Several mobile navigation symbols also differ from the desktop sidebar. Provider logos already share the desktop provider mapping, so they should not be replaced with generic symbols.

## Goals

- Match the floating chat's overall visual language and composition throughout the mobile conversation screen.
- Make the composer look as close as possible to the floating composer, including frame, input typography, placeholder treatment, internal spacing, model selector, action alignment, and context row.
- Arrange the conversation header as logo, current title, navigation action, and plus action. Title uses available space and truncates without displacing controls.
- Use `<HugeiconsIcon icon={SidebarBottomIcon} />` for the navigation action where the desktop open-window action appears in the annotated reference.
- Keep plus for new chat, which the user explicitly allowed. Do not render desktop open-window or hide-window actions in this header.
- Preserve current titles and the canonical default for a new thread.
- Modernize navigation icon semantics to match the current desktop sidebar.
- Maintain readable text, accessible names/focus, at least 44px mobile action targets, and usable layouts with the keyboard open.

## Non-Goals

- New voice input, attachments, desktop tools, mode controls, or other capabilities solely to reproduce icons in a screenshot. Do not add inert microphone, attachment, or ellipsis controls.
- Changing backend commands, provider ownership, model availability, pairing, session recovery, or delivery semantics.
- Replacing mobile runtime with `ThreadComposerSurface`, the desktop store, or Electron bridges.
- Changing floating chat's appearance or behavior as a side effect of reuse.
- Copying desktop title bars, traffic lights, floating-window shadows, or the screenshot's colored annotation boxes into the mobile page.
- Redesigning every mobile secondary screen beyond consistent navigation/icon changes needed by this task.

## Current State

### Reference implementation

- `apps/web/src/components/floating-assistant/FloatingAssistantShell.tsx:200`: logo/title/action header; the desktop shell hosts this web UI.
- `apps/web/src/components/chat/side-chat/FloatingSideChat.tsx:60`: `CompactThreadConversation` composes transcript, compact composer, and project picker. Its runtime is a reference, not an import target for the mobile screen.
- `apps/web/src/components/chat/view/chat-view/ChatViewComposer.tsx:98`: composer form and nested rounded frame. Outer frame uses `rounded-[22px] p-px`; inner surface uses `rounded-[20px] border bg-card` with focus treatment. Compact input/footer spacing differs from the regular desktop composer.
- `ChatViewComposer.tsx:201`: state-aware placeholder. The screenshot's idle wording is “What are we working on?”; other desktop wording advertises commands unavailable on mobile and must not be copied blindly.
- `apps/web/src/components/chat/composer/ComposerFooterLeading.tsx`: compact provider/model picker and additional desktop controls. Reuse the visual treatment while preserving mobile capabilities.
- `apps/web/src/components/chat/messages/MessagesTimeline.tsx:323`: centered logo reference for the empty conversation.
- `apps/web/src/components/sidebar/Sidebar.chatsSection.tsx`: `Chatting01Icon` and `Comment03Icon`; `Sidebar.projectsSection.tsx` uses `LaptopMinimalIcon` for local Projects. `SidebarRenderedProjectItem.tsx` uses closed/open folder symbols for project rows.

### Mobile implementation and constraints

- `apps/mobile-web/src/components/shell/MobileAppHeader.tsx`: current header plus shared list primitives. `MobileAppFrame.tsx` supplies the title and owns router navigation-view state.
- `apps/mobile-web/src/logic/mobileHeader.logic.ts`: existing route/title resolution. `packages/shared/src/String.ts:10` defines `DEFAULT_THREAD_TITLE` as `New thread`. Preserve that default; do not rename persisted threads to match floating chat's display normalization.
- `apps/mobile-web/src/components/shell/MobileNavigationSheet.tsx`: one Base UI dialog with Chats, project, and Settings views. Existing dismissal, history, and mounted-conversation behavior must survive the selected menu presentation.
- `apps/mobile-web/src/components/threads/MobileThreadProviderIcon.tsx`: already uses the shared provider mapping and mobile running/unread state.
- `apps/mobile-web/src/screens/MobileThread.view.tsx:37`: transcript and content wrappers, work log, working state, outline, and composer layout. The inner transcript wrapper currently lacks the sizing/flex layout needed to center an empty-state child vertically.
- `apps/mobile-web/src/components/threads/thread/MobileMessages.tsx:20`: text-only empty state and existing message presentation.
- `apps/mobile-web/src/components/threads/thread/composer/MobileComposer.tsx`: 376 lines at inspection; handles approvals, questions, delivery notices, send, and stop. `MobileComposerModelPicker.tsx` overrides the shared picker with a bordered pill. `MobileComposerContextBar.tsx` renders project/branch context.
- `apps/mobile-web/src/components/shell/BigbudLogo.tsx`: fixed accessible title ID must become unique when logo appears in both header and empty state.
- `apps/mobile-web/src/main.tsx` imports web `index.css`; its existing `@supports (-webkit-touch-callout: none)` rule sets editable controls to 16px to avoid iOS input zoom. Preserve this platform-specific computed-size exception while using text-sm for ordinary mobile UI and picker menus.
- `apps/mobile-web/vite.config.ts` and `tsconfig.json`: `~` resolves to web source, allowing existing direct imports. Mobile has its own runtime and local UI primitives. Hugeicons dependencies currently belong to web and should be declared directly in mobile if imported there.
- Applicable instructions: root `AGENTS.md`; no additional app-level `AGENTS.md` was found. Every authored/materially edited source/test file must stay at or below 400 lines. Use focused dot-notation modules and direct subpath imports.

### Assumptions and preserved behavior

- “Use default” refers to the existing canonical default, supported by the user's wording and current title constant.
- Plus is the chosen new-chat icon because the user explicitly permits keeping it.
- The X removal refers to the annotated conversation header. It does not silently remove all dismissal affordances from the navigation overlay.
- Preserve draft persistence, focus/selection through recovery, history navigation, project selection, model/provider locking, approval/question flows, work logs, Markdown rendering, reader position, stream following, truthful delivery uncertainty, duplicate-send protection, and available Stop behavior during recovery.
- Navigation is settled: the user selected the existing tall sheet rising from the bottom, requested shadcn Drawer where possible, and requested good transitions. Use a local shadcn Base UI Drawer wrapper; installed Base UI 1.4.1 exports the needed drawer primitive.

## Phases

### Phase 1: Establish the shared visual foundation

**Goal:** Implement against the real floating design, with explicit reuse boundaries.

1. Capture the floating and mobile screens at the same content width and theme for idle, typed, running, and populated states. Use the supplied screenshots as product direction and live/source styles as exact implementation evidence.
2. Map header, transcript, composer frame, input, footer, picker, action, and context-row styles from the reference files above. Record spacing, typography, radii, colors, and state styling rather than independently redesigning them.
3. For frame/input/footer styles needed by both surfaces, extract a focused presentation-only module such as `apps/web/src/components/chat/composer/ComposerSurface.styles.ts`. Keep dependencies limited to presentation values; mobile imports directly through the existing alias. Existing floating consumers must produce equivalent styling. Keep compact/mobile touch-size differences explicit rather than adding desktop state dependencies.
4. Reuse existing mobile shadcn-style Button and Base UI primitives. Reuse the already-shared ProviderModelPicker and provider icons. Do not import the complete desktop composer to obtain its appearance.
5. Add `@hugeicons/core-free-icons` and `@hugeicons/react` to mobile at the existing web versions (`^4.3.0` and `^1.1.10` at inspection), using the package manager to update `bun.lock`.

**Resolved implementation boundaries:** Share only frame/input/footer presentation values used by both consumers, preserving the existing floating values when extracting them. Keep provider-state classes and all event handlers in their original owning components. Mobile may override touch dimensions and mobile menu font sizes explicitly. Verify Tailwind includes the extracted module in both builds and that named Hugeicons imports do not cause an unexpected bundle-size increase. Existing desktop files near the hard size limit include ChatViewComposer (371 lines) and MessagesTimeline (397 lines); the latter is a visual reference, not a required edit target.

**Exit:** Concrete style mapping and focused reuse boundary established; no desktop runtime dependency introduced and no floating visual regression.

### Phase 2: Header and navigation

**Dependency:** Phase 1. Navigation presentation is settled: a tall modal bottom drawer.

1. Update `MobileAppHeader.tsx` and `MobileAppFrame.tsx` for the reference layout: small logo, flexible current title, SidebarBottomIcon navigation action, plus new-chat action. Match reference typography, border, and spacing; retain at least 44px hit areas around compact glyphs.
2. Preserve nonconversation back links, pairing header suppression, title updates, and current new-chat callbacks. Keep accessible “Open Chats” and “New chat” names. Expose connection information through the existing indicator/description without crowding the title or losing recovery notices.
3. Use unique IDs (for example React `useId`) in the mobile BigbudLogo accessible title so simultaneous header and empty-state logos remain valid.
4. In `MobileNavigationSheet.tsx` and relevant mobile icon wrappers, use desktop semantics: Comment03Icon for Recents, LaptopMinimalIcon for Projects, folder symbols for projects, and Chatting01Icon wherever a Chats category is represented. Keep current shared provider logos and meaningful running/unread coloring. Retain current desktop-compatible New chat and Settings icons.
5. Add `apps/mobile-web/src/components/ui/drawer.tsx` following the current shadcn Base UI Drawer composition, importing directly from `@base-ui/react/drawer`. Installed version 1.4.1 supports this; set mobile's dependency floor to `^1.4.1` so future installs cannot resolve the old declared 1.2 minimum without drawer support. No Vaul dependency or broad shadcn regeneration is needed. Preserve local Button/cn conventions and text-sm sizing. Use Drawer root, portal, backdrop, viewport, popup, content, title/description, close, and swipe handle composition. Keep the existing MobileNavigationSheet feature name and its Chats/project/Settings content; replace its raw Dialog presentation with this wrapper.
6. Configure a single tall modal bottom drawer (`swipeDirection="down"`) with rounded upper corners, a visible swipe handle, current narrow side inset/max-width, and height bounded by `100dvh` minus a 2rem top gap and top safe area. Keep a nonshrinking title/header and explicit Close footer; the middle list is `min-h-0 flex-1 overflow-y-auto`. Apply bottom safe-area padding once. Chats, project, and Settings replace content inside this same drawer. Restrict dismissal gestures to the handle/header region and exclude scrolling/form content using the installed primitive's swipe-ignore support; verify list scrolling does not dismiss the drawer. Drawer.SwipeArea is a swipe-to-open affordance, not a dismissal handle; do not use it for this purpose or implement custom gesture listeners. Do not add snap points, background scaling, or a second modal.
7. Animate popup translation from fully below the viewport to its resting position and reverse it on close, with approximately 280ms ease-out opening and 220ms ease-in closing; fade the backdrop over 200ms. Use primitive state/gesture variables so swiping remains interactive, rather than overriding an active swipe transform. Disable nonessential motion under `prefers-reduced-motion`, with immediate completion. Add `body { position: relative; }` in mobile.css as required by shadcn's documented iOS overlay positioning, without changing desktop CSS.
8. Fix lifecycle ownership in MobileAppFrame: currently it renders the navigation only while router `view` is truthy, which would cut off exit animation. Keep the Drawer root mounted while paired on eligible routes, drive `open` from router state, and retain the last non-null view for closing content. Use the primitive's transition presence and `onOpenChangeComplete` for cleanup instead of timeouts. After closing completes, release retained view/content and unmount the feature body so snapshot hooks and Settings local state do not remain active while closed. A close completion must not clear a newer reopened view. Close/swipe/outside press updates router state once; browser Back closes without adding a history entry; Forward reopens the recorded view. Retain the existing push-on-open/replace-on-content-or-explicit-close policy. Clear retained content immediately on forgetting the session or entering pairing; do not retain sensitive content for an exit animation after unpairing.
9. Associate the detached header action with the drawer through its trigger handle/ID, or explicit focus refs supported by the primitive. Preserve the accessible Open Chats label, expanded state, dialog title/description, focus containment, and return focus to the header action after ordinary dismissal. Do not focus an editable Settings field automatically when opening. Thread selection and new chat follow existing route callbacks without remounting the active composer merely to open/close navigation. Keep Escape, outside press, swipe, and an explicit Close action; X exclusion continues to apply to the conversation header.
10. Keep existing list sorting, previews, expansion, project selection, and thread navigation behavior. Do not add unrelated desktop sidebar destinations.

**Exit:** Requested header structure and current icon language are visible; navigation passes existing interaction guarantees under the agreed presentation.

### Phase 3: Conversation and composer parity

**Dependency:** Phase 1; may be developed alongside header/navigation work.

1. Update `MobileThread.view.tsx` and `MobileMessages.tsx` to follow the floating transcript's spacing and message surfaces. Reuse existing Markdown and user-message rendering. Match text rhythm, bubble treatment, muted metadata, and content insets without changing message filtering or ordering.
2. Give the empty transcript wrapper available-height sizing/flex behavior and render a subdued centered logo for an idle empty conversation. Keep the transcript/content refs and measurement hooks intact. Do not show a misleading idle state in place of work logs, active work, errors, or recovery content.

   Derive empty-state eligibility in the mobile view from its existing message/activity/composer props, and pass an explicit presentation flag to MobileMessages. Show the centered logo only when there are no user/assistant entries under the existing filter, no work-log entries, no working indicator or running turn, no pending approval/question, and no displayed recovery notice. Reuse `resolveMobileConnectionNotice` for notice visibility rather than inventing a second freshness mapping. Keep new unsent drafts eligible when otherwise idle. Preserve existing message filtering, including empty streaming entries. Use minimum available height with content growth rather than a fixed-height content wrapper: the ResizeObserver in MobileThread.scroll.ts must still observe growth and the transcript must remain the scrolling owner.

3. Rework `MobileComposer.tsx` around the floating compact frame and shared presentation styles. Remove redundant outer separator/insets where they cause the current boxed-off appearance. Match the reference's rounded frame, subtle border, background, focus treatment, and compact input/footer spacing.
4. Use “What are we working on?” for the ordinary empty prompt and preserve contextual approval/question prompts. Match text and placeholder styling; keep mobile multiline editing and draft updates. Preserve the existing iOS 16px editable-control override to avoid focus zoom; do not defeat it to achieve desktop-sized composer text. Do not advertise desktop-only file tagging or slash commands.
5. Update `MobileComposerModelPicker.tsx` to remove the separate bordered pill and use the floating model trigger's integrated ghost appearance. Retain provider logo, model name, chevron, mobile popup bounds, provider lock/unlock, unavailable-provider handling, and model-selection data flow. Constrain long labels so the primary action remains reachable. Keep mobile picker menus at `text-sm` (14px), with `text-xs` reserved for secondary labels; do not copy floating compact picker's smaller menu-text overrides. This is an explicit repository-convention and mobile-readability difference.
6. Match the toolbar's left/right arrangement: provider/model on the left and the available mobile primary action on the right. Preserve Send, Stop, approval, and question controls and their current handlers/disabled semantics. Omit unsupported desktop microphone, attachment, and additional-controls icons rather than creating false affordances.
7. Restyle `MobileComposerContextBar.tsx` to match the understated row below the floating composer, preserving project and branch information. Keep it informational unless an existing supported action is wired; do not add a misleading dropdown chevron.
8. Preserve an in-flow nonshrinking composer and independently scrolling transcript. Use `mobile.css`/frame adjustments only where needed for responsive geometry and existing safe-area ownership. Avoid fixed composer overlays or hardcoded transcript compensation.
9. Split focused presentation/control sections if edits would push MobileComposer (376 lines) or MobileNavigationSheet (344 lines) beyond 400 lines. Keep extraction behavior-preserving and follow dot-notation naming.

**Exit:** At matched content widths, the mobile composer and conversation visibly follow floating chat; every remaining difference has a documented functional or mobile-usability reason.

### Phase 4: Validate and hand off

1. Extend existing mobile browser coverage for changed behavior and layout; do not add tests that merely mirror CSS strings.
2. Run required repository checks and targeted browser/build checks below. If shared presentation consumers changed, run relevant floating browser coverage as well.
3. Compare before/after mobile and floating screenshots for idle, typed, populated, running, approval/question, and long-label states. Review at phone widths and equal reference widths in light and dark themes.
4. Record executed commands, results, screenshots, remaining platform limitations, and justified visual differences in the implementation handoff. Do not claim real-device validation from desktop emulation.

**Visual acceptance procedure:** Use the same theme, viewport/content width, title, prompt text, and model-label length when comparing floating and mobile. Compare header baseline/insets, composer radius and border, input/footer padding, picker treatment, and context-row alignment against the shared source values. Repeat at the narrow phone widths below; each intentional difference must map to touch sizing, typography convention, safe areas, or an unsupported action. Screenshots can be attached to the implementation handoff; a new committed screenshot suite or pixel-perfect automated baseline is not required. If the Electron window cannot be driven, render the existing floating browser fixture for comparison and report that limitation; absence of a live provider must not prevent deterministic visual checks.

## Risks And Decision Gates

- **Drawer transition lifecycle:** Router state can become closed before the exit animation finishes. Keep the primitive mounted and guard completion against rapid reopen; validate Back/Forward, swipe, session disposal, and reduced-motion closure.
- **Visual dilution:** A small mobile polish would miss the request. Review the whole screen and especially composer against the floating reference, not merely the presence of the new icon.
- **Runtime coupling:** Shared presentation extraction must not pull in desktop stores, commands, provider lifecycle, or Electron APIs. Preserve all current mobile callbacks/state ownership.
- **Keyboard and narrow widths:** Identical desktop control dimensions may compromise mobile use. Keep compact visible styling with larger hit areas, bounded labels, safe-area support, and a usable transcript.
- **Draft/scroll regressions:** Do not remount the composer or replace scrolling containers during styling/navigation changes. Preserve existing refs and recovery notice behavior.
- **Source size:** Enforce 400 lines per materially edited source/test file; perform necessary focused extraction rather than postponing it as cleanup debt.
- **Rollout/rollback:** Header/icons and conversation styling can be reviewed as separate changes. No schema or persisted-state migration is required. Rollback restores presentation and dependency changes without touching saved sessions or drafts. Commit/push still require fresh explicit user approval.

## Testing And Validation

Planning has been read-only apart from this authorized Markdown file. No application checks were run or claimed as passing during planning. The following are implementation completion requirements:

```sh
bun fmt
bun lint
bun typecheck
bun run --cwd apps/mobile-web test
bun run --cwd apps/mobile-web test:browser
node apps/mobile-web/tests/browser/recovery.mjs
node apps/mobile-web/tests/browser/delivery.mjs
bun run --cwd apps/mobile-web build
bun run --cwd apps/mobile-web build:desktop
```

Never run `bun test`. No Rust changes are planned. `bun fmt` is intentionally deferred to implementation because it mutates project files beyond this plan's write boundary.

- Preserve/extend `logic/mobileHeader.logic.test.ts` for titles and nonconversation routes where behavior changes.
- Extend `tests/browser/shell.mjs` for header naming/order, 44px targets, no desktop window actions, long titles, logo centering, unique accessible IDs, navigation focus/dismissal/history, project/Settings transitions, and a mounted draft. Preserve existing `/Open Chats/`, dialog, and heading assertions for the chosen bottom drawer. Add open/close transition-presence checks, reduced-motion dismissal, rapid close/reopen, Back/Forward, swipe-versus-list-scroll behavior, and unpairing during closure. Check focus/body-scroll restoration after each dismissal path.
- Exercise model picker interaction and long model names, not just appearance. Verify new chat remains functional and disabled/available actions remain correct.
- Existing mobile harnesses do not produce parity screenshots. Add screenshot capture to the extended shell harness or a focused `tests/browser/visual-parity.mjs` harness, using deterministic fixtures and an output directory under `/tmp`. Include exact reproduction/capture commands in the implementation handoff. These artifacts support visual comparison; they are separate from existing recovery JSON evidence.
- Existing recovery and delivery harnesses protect cached content, drafts, focus, selection, uncertain send outcomes, duplicate-send suppression, and Stop during stale state.
- Validate at 320px, 390px, and 430px phone widths, reduced keyboard-height viewport, landscape, and matched wider reference dimensions. Cover light/dark, focus, overflow, safe areas, tall approvals/questions, and reader-controlled streaming.
- If shared web presentation files change, run `bun run --cwd apps/web test:browser` with the repository's installed browser prerequisite; include floating assistant coverage. Report any unavailable browser dependencies rather than claiming success.
- Physical iOS Safari and Android Chrome keyboard/safe-area checks are separate manual evidence; report when unavailable.

## Acceptance Criteria

- The screen reads visually as the floating chat adapted to a phone; composer parity is demonstrated with matched-state screenshots.
- Header contains logo, actual/default title, requested SidebarBottomIcon, and plus; no desktop open/hide window controls.
- Idle empty state centers the logo in the available transcript area without hiding real activity or errors.
- Composer frame, typography, placeholder, padding, model selector, action alignment, and context row match reference styles wherever supported. Exceptions are documented concretely.
- Navigation symbols match desktop semantics; provider logos and state meanings remain intact.
- No inert screenshot-only controls, misleading capabilities, extra modal stacking, draft loss, or recovery/delivery regressions are introduced.
- Mobile controls remain accessible and usable with long content and an open keyboard.
- All required implementation checks pass, materially edited source/test files meet the 400-line limit, and actual validation limitations are stated.

## Open Questions

None. The user selected the tall bottom Chats sheet with shadcn Drawer where possible and smooth transitions. Installed Base UI supports the current shadcn drawer architecture, so the preferred implementation is feasible.

Saved-file delivery is settled: the user explicitly requested updating and saving the plan in `docs/plan`.

## Plan Validity And Handoff

This plan describes the branch/commit and worktree recorded above. Revalidate if mobile header, navigation, composer, reference floating styles, package versions, or recovery interfaces change before implementation. No external web facts are required.

Implement shared presentation mapping first, then header/icons and conversation/composer work, then integrated validation. Do not reopen the settled broad visual-parity goal, composer priority, requested menu icon, plus choice, lack of window X, or preservation of mobile behavior without new evidence.

Requirements-coverage and execution-readiness reviews explicitly include the user's later clarification that most floating styles should be copied/reused. Independent review identified centering-wrapper growth, explicit idle-state inputs, duplicate SVG IDs, title default, file-size constraints, navigation semantics, mobile menu text-sm sizing, the existing iOS editable-control size exception, and explicit screenshot capture; all are incorporated. The blocker audit resolves these technical gaps without asking the user to decide implementation details. The user subsequently resolved the menu decision; the implementation specification now includes the compatible drawer primitive, animation lifecycle, accessibility, and validation. Independent read-only review confirmed the installed drawer API and required transition-presence, rapid-reopen, focus/history, content-cleanup, and gesture safeguards; these are incorporated. No product decision remains unresolved. Final worktree verification showed only this authorized plan added alongside the pre-existing untracked Rust plan; application files were unchanged.

### Drawer source verification

- Official shadcn guidance checked on 10 September 2026: https://ui.shadcn.com/docs/components/base/drawer. It documents the Base UI implementation, down swipe direction, scrollable flex content, and mobile body-position requirement. Installed `@base-ui/react` is 1.4.1 and exposes `./drawer`; its types confirm controlled open, `onOpenChangeComplete`, detached trigger handles, and initial/final focus support.
- External retrieval: Firecrawl was unavailable due to exhausted credits; official documentation was read using the fallback browser research tool. No dependency or application files were changed during planning. Revalidate component API compatibility if the lockfile changes.
