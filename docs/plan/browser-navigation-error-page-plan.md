# Browser Navigation Error Page Plan

## Status

Proposed, revised after browser-panel code review and visual direction review.

## Summary

Replace the browser panel's current raw error banner and Chromium error content with one reusable bigbud error page.

The page should follow Chromium's familiar error-page structure:

1. A recognizable status mark
2. A clear error title
3. A short explanation
4. A small list of suggested checks
5. The technical browser error code
6. One or two recovery actions

The Chromium status mark is replaced with the existing `BigbudLogo`. The logo uses the same size and muted color as the browser's current empty state and spins while the error page is visible.

Different navigation failures reuse the same page structure and change only the message, suggestions, technical code, and available actions.

## Problem Statement

The browser panel currently detects some failed main-frame navigations, but its user-facing treatment is incomplete:

1. [BrowserPanel.viewport.webview.tsx](../../apps/web/src/components/browser/BrowserPanel.viewport.webview.tsx) listens for `did-fail-load` and forwards the raw Electron failure data.
2. [BrowserPanel.tsx](../../apps/web/src/components/browser/BrowserPanel.tsx) reduces that data to a single `loadError` string.
3. The string appears in a narrow destructive banner above the browser viewport.
4. Chromium's own error page, an empty frame, or stale content remains underneath.
5. Users receive little explanation and no error-specific recovery guidance.

The result is inconsistent with the rest of bigbud and can look like a blank or broken panel.

## Visual Direction

The error page should match the structure and restraint of Chromium's dark error page rather than introducing a card, modal, illustration, or dense diagnostic interface.

### Layout

1. Render inside the browser viewport. Keep the existing browser toolbar visible.
2. Use the existing browser/background color without a bordered card or separate panel.
3. Place one left-aligned content column within the viewport.
4. Keep the logo above the title.
5. Follow the title with the explanation, suggestions, technical code, and actions.
6. Preserve comfortable spacing at narrow right-panel widths without forcing horizontal scrolling.

The content should feel vertically centered but slightly above the exact midpoint, following the reference error page. At narrow widths, use responsive horizontal padding rather than fixed pixel positioning.

### Logo

Reuse `BigbudLogo` from [SidebarProjectItem.tsx](../../apps/web/src/components/sidebar/SidebarProjectItem.tsx).

Required treatment:

1. Match the current browser empty state's `h-8 text-muted-foreground/30` styling.
2. Add a continuous spin animation while the error page is shown.
3. Respect reduced-motion preferences by disabling the rotation when the user requests reduced motion.
4. Do not introduce a second error icon or warning illustration.

### Typography

1. Title: visually strongest text, semibold, using the established browser-panel typography.
2. Explanation: muted foreground, concise, and specific to the failed host where possible.
3. `Try:` label and suggestions: plain text with a compact bulleted list.
4. Technical code: small muted text, displayed exactly as Electron reports it when available.
5. Buttons: existing bigbud button primitives and the standard `text-sm` sizing.

## Goals

1. Ensure a failed browser navigation never appears as an unexplained blank viewport.
2. Give users a familiar, calm, and actionable error page.
3. Reuse one layout for all initially supported navigation failures.
4. Preserve the failed URL and normal browser toolbar controls.
5. Keep the first implementation small and local to the browser panel.
6. Preserve raw error information for users who recognize browser error codes.

## Non-Goals

The first implementation should not:

1. Diagnose loaded pages that return HTTP `4xx` or `5xx` responses.
2. Detect client applications that load successfully but render blank content.
3. Add agent diagnostic handoff.
4. Add expandable technical diagnostics.
5. Add automatic retry or network-reconnection behavior.
6. Persist errors across app restarts.
7. Add site-owner-specific infrastructure instructions.
8. Add renderer crash or unresponsive-process recovery.
9. Add certificate trust exceptions or a "continue anyway" workflow.
10. Replace the browser toolbar or navigate the webview to a synthetic bigbud URL.

## Product Decisions

### 1. Use a first-party viewport overlay

The error page is bigbud UI layered over the failed browser viewport. It is not a document loaded into the webview.

This keeps browser history, the requested URL, reload behavior, and the toolbar unchanged while preventing Chromium's inconsistent error content from becoming the primary user experience.

The overlay must sit above the webview and capture pointer input while visible.

### 2. Keep one reusable structure

The reusable error page accepts:

1. Title
2. Description
3. Suggestions
4. Technical error code
5. Primary action
6. Optional secondary action

Avoid per-error components. Error classification and error-page presentation should remain separate so new mappings do not duplicate layout code.

### 3. Keep actions minimal

The first version supports:

1. **Reload** as the primary action.
2. **Go back** as an optional secondary action when browser history reports that it is available.

The existing toolbar remains usable, including editing the URL and opening the address in the default browser. These controls do not need to be duplicated in the error page.

### 4. Keep technical codes visible

Display the browser's error code beneath the suggestions, following the reference layout. The technical code is secondary information, not the title.

If Electron does not provide a useful description, show a stable bigbud fallback code such as `UNKNOWN_NAVIGATION_ERROR`.

## Initial Error Content

The initial classifier should cover common main-frame navigation failures and fall back safely for all other codes.

### Domain not found

Typical code: `ERR_NAME_NOT_RESOLVED` (`-105`).

- Title: `This site can't be reached`
- Description: `<hostname>'s server IP address could not be found.`
- Suggestions:
  - `Checking the address`
  - `Checking the connection, proxy, firewall, and DNS configuration`
- Primary action: `Reload`
- Secondary action: `Go back`, when available

### Offline

Typical code: `ERR_INTERNET_DISCONNECTED` (`-106`).

- Title: `You're offline`
- Description: `This page can't be loaded without an internet connection.`
- Suggestions:
  - `Checking your network connection`
  - `Reconnecting to Wi-Fi or Ethernet`
- Primary action: `Reload`
- Secondary action: `Go back`, when available

### Connection unavailable

Typical codes include:

- `ERR_CONNECTION_CLOSED` (`-100`)
- `ERR_CONNECTION_RESET` (`-101`)
- `ERR_CONNECTION_REFUSED` (`-102`)
- `ERR_CONNECTION_ABORTED` (`-103`)
- `ERR_ADDRESS_UNREACHABLE` (`-109`)

Content:

- Title: `This site can't be reached`
- Description: `<hostname> refused or closed the connection.`
- Suggestions:
  - `Checking the connection`
  - `Checking the proxy and firewall`
- Primary action: `Reload`
- Secondary action: `Go back`, when available

The description may distinguish refused, reset, and unreachable failures when the mapping remains simple. They should still reuse the same page and action set.

### Timed out

Typical codes include `ERR_TIMED_OUT` (`-7`) and `ERR_CONNECTION_TIMED_OUT` (`-118`).

- Title: `This site took too long to respond`
- Description: `<hostname> didn't respond in time.`
- Suggestions:
  - `Checking the connection`
  - `Checking the proxy and firewall`
- Primary action: `Reload`
- Secondary action: `Go back`, when available

### Secure connection failed

Certificate and TLS failures should use one simple page in the first version.

- Title: `Your connection isn't private`
- Description: `bigbud couldn't establish a secure connection to <hostname>.`
- Suggestions:
  - `Checking your computer's date and time`
  - `Opening the site in your default browser for more information`
- Primary action: `Reload`
- Secondary action: `Go back`, when available

The first version must not bypass or approve an invalid certificate. A one-time continuation workflow remains a separate follow-up because it requires desktop-process certificate handling and a security confirmation flow.

### Unknown navigation failure

- Title: `This page couldn't be loaded`
- Description: `bigbud couldn't load <hostname>.`
- Suggestions:
  - `Checking the address and connection`
  - `Trying again in a moment`
- Primary action: `Reload`
- Secondary action: `Go back`, when available

Show Electron's error description when it is safe and useful. Otherwise show `UNKNOWN_NAVIGATION_ERROR`.

## State And Event Behavior

Keep the first version local to the mounted browser tab rather than adding persisted browser failure state.

### Failure state

Replace the current `string | null` state with the existing structured failure information:

1. `errorCode`
2. `errorDescription`
3. `validatedURL`

Derive the page content from this object through a pure classifier/presentation helper.

### State transitions

1. A new URL submission clears the previous error before navigation begins.
2. `did-start-loading` clears the previous error so Reload can visibly attempt navigation.
3. A qualifying main-frame `did-fail-load` event sets the structured error state.
4. `did-finish-load` clears the error state after successful navigation.
5. The existing `ERR_ABORTED` (`-3`) behavior remains ignored because it commonly represents an intentionally superseded navigation.
6. Subframe failures remain ignored and must not replace an otherwise usable page.
7. Changing browser tabs or closing the current tab naturally disposes of the local error state.

Do not clear an error merely because back or forward history exists. The current `onNavigationStateChange` clearing behavior should be removed in favor of explicit load lifecycle events.

## Webview And Iframe Behavior

### Electron webview

Electron provides the detailed main-frame failure information required for the initial classifier. The webview viewport should forward explicit load-start and load-success callbacks in addition to the existing failure callback.

### Web iframe fallback

Cross-origin iframes cannot reliably expose DNS, TLS, status-code, or framing details. Reuse the same visual error page when the iframe emits an error, but use generic content:

- Title: `This site couldn't be displayed here`
- Description: `The site may not support being opened inside bigbud.`
- Suggestions:
  - `Reloading the page`
  - `Opening it in your default browser`

Do not claim a specific network or certificate cause without evidence.

The iframe's existing local overlay should be replaced by the shared error-page component rather than maintaining a second error design.

## Implementation Direction

### 1. Add a pure error-content classifier

Create a browser-local helper near the existing browser-panel modules. It should:

1. Accept the structured load failure.
2. Parse a safe hostname from `validatedURL`.
3. Map known error codes to the initial content categories.
4. Return unknown fallback content for unmapped errors.
5. Contain no React state or Electron calls.

Keeping classification pure makes the mappings easy to test without rendering the browser panel.

### 2. Add one reusable error-page component

Create a dedicated component rather than extending [BrowserPanel.tsx](../../apps/web/src/components/browser/BrowserPanel.tsx), which is already at the project's 400-line source-file limit.

The component should:

1. Fill the viewport with an absolute overlay.
2. Render the spinning `BigbudLogo`.
3. Render the supplied title, description, suggestions, and error code.
4. Render Reload and conditional Go back actions.
5. Use semantic heading, paragraph, list, and button elements.
6. Announce the failure using an appropriate live-region treatment without repeatedly announcing animation updates.

### 3. Preserve structured failures in `BrowserPanel`

Update [BrowserPanel.tsx](../../apps/web/src/components/browser/BrowserPanel.tsx) to:

1. Store the full failure object instead of only `errorDescription`.
2. Remove the current destructive error banner.
3. Render the shared error page over the viewport when a failure exists.
4. Wire Reload to the existing viewport reload method.
5. Wire Go back to the existing viewport history method.
6. Keep the toolbar visible and functional.

### 4. Forward explicit loading lifecycle events

Update the browser viewport props and [BrowserPanel.viewport.webview.tsx](../../apps/web/src/components/browser/BrowserPanel.viewport.webview.tsx) to forward load-start and load-success events.

Use these events to clear stale errors predictably instead of inferring success from history state.

### 5. Reuse the page in the iframe fallback

Update [BrowserPanel.viewport.iframe.tsx](../../apps/web/src/components/browser/BrowserPanel.viewport.iframe.tsx) to use the shared visual component with generic iframe-safe content.

Do not route iframe error code `-3` through the Electron classifier because Electron treats `-3` as an aborted navigation while the iframe currently uses it as a synthetic embedding failure.

## Accessibility Requirements

1. Error titles use a real heading.
2. Suggestions use a semantic list.
3. Actions are keyboard-reachable buttons with visible focus states.
4. The failure is announced once when it appears.
5. The spinning logo is decorative in the error page and should not duplicate the error announcement.
6. Rotation is disabled under `prefers-reduced-motion`.
7. Text and actions retain sufficient contrast in both light and dark themes.
8. The layout remains usable at narrow browser-panel widths and at browser zoom up to 200%.

## Testing Plan

### Classifier tests

Add table-driven unit tests covering:

1. Domain not found
2. Offline
3. Connection refused/reset/unreachable
4. Timeout
5. Representative certificate/TLS failures
6. Unknown codes
7. Invalid or missing failure URLs
8. Safe hostname extraction

### Component tests

Verify that the shared error page:

1. Renders the logo, title, description, suggestions, and technical code.
2. Calls Reload from the primary action.
3. Shows Go back only when navigation history permits it.
4. Uses semantic heading/list/button elements.
5. Includes reduced-motion-safe animation styling.

### Browser-panel tests

Verify that:

1. A main-frame load failure shows the overlay.
2. A subframe failure does not show the overlay.
3. `ERR_ABORTED` does not show the overlay.
4. Starting a new navigation clears the previous overlay.
5. Successful load completion clears the overlay.
6. Reload and Go back call the existing viewport methods.
7. The toolbar remains rendered while the error page is visible.

### Iframe fallback tests

Verify that iframe failures use the shared layout with generic embedding-safe copy and do not claim a specific DNS or TLS cause.

## Acceptance Criteria

1. Navigating to a nonexistent domain shows a bigbud error page instead of only the current banner or an unexplained blank viewport.
2. The error page follows the supplied Chromium reference structure.
3. The Chromium swirl is replaced by the spinning bigbud logo.
4. The logo matches the browser empty state's current size and color.
5. Common errors change copy while reusing the same component and layout.
6. Reload retries the current URL.
7. Go back appears and works only when back history exists.
8. The failed URL remains visible and editable in the browser toolbar.
9. A successful subsequent navigation removes the error page.
10. Unknown errors still show a useful generic page and technical code.
11. No error state is persisted after the tab is closed or the app restarts.
12. `bun fmt`, `bun lint`, `bun typecheck`, and focused browser-panel tests pass.

## Implementation Order

1. Add the structured failure type and pure classifier.
2. Add classifier unit tests.
3. Add the reusable error-page component and component tests.
4. Add explicit load-start/load-success callbacks to the viewport boundary.
5. Replace `BrowserPanel`'s raw banner with the error-page overlay.
6. Reuse the error page in the iframe fallback.
7. Add browser-panel lifecycle tests.
8. Run formatting, linting, typechecking, and focused tests.

## Deferred Follow-Ups

Only add these after the simple error page is shipped and validated:

1. One-time certificate continuation with an explicit security warning
2. Renderer crash and unresponsive-tab recovery
3. Automatic retry after reconnecting
4. Agent diagnostic handoff
5. Expandable detailed diagnostics
6. Operator-specific remediation guidance

## Recommendation

Implement the reusable error page exactly as a small browser-panel enhancement: one visual structure, a compact classifier for common failures, Reload plus conditional Go back, and a safe unknown fallback.

This solves the blank and inconsistent failure experience without introducing a broad browser diagnostics subsystem.
