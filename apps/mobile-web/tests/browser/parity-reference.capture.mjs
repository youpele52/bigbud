import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNativeQuestionChoices } from "./parity-reference.native-choice.mjs";
import { measureGreetingGeometry } from "./parity-reference.greeting-geometry.mjs";
import { assertGreetingCopyWidth } from "./parity-reference.greeting-width.mjs";
import { inspectLockedModelMenu } from "./parity-reference.locked-menu.mjs";
import { inspectUnlockedProviders } from "./parity-reference.providers.mjs";
import { inspectWorkEntryDetails } from "./parity-reference.work-entry.mjs";

const surfaces = [
  "shell",
  "header",
  "error",
  "thread-list",
  "empty",
  "loading",
  "editor",
  "approval",
  "question",
  "markdown",
  "work-log",
  "work-entry-details",
  "model-picker",
  "provider-picker",
];

export async function captureCurrentDesktopReferences(browser, origin, existing = null) {
  const directory = await mkdtemp(
    join(
      process.env.MOBILE_PARITY_OUTPUT_DIR ?? "/tmp",
      "bigbud-mobile-current-desktop-reference-",
    ),
  );
  const context =
    existing?.context ??
    (await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    }));
  const page = existing?.page ?? (await context.newPage());
  // Control only greeting entropy/time; timers and actual consumer behavior keep running.
  await page.clock.setFixedTime("2026-11-15T18:00:00.000Z");
  await page.addInitScript(() => {
    Math.random = () => 0.5;
  });
  const pageErrors = [];
  const consoleErrors = [];
  const rejectedApplicationRequests = [];
  const hmrClientRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.addInitScript((fixtureOrigin) => {
    if (location.origin === fixtureOrigin) {
      localStorage.setItem(
        "bigbud:theme",
        new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light",
      );
    }
  }, origin);
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/@vite/client") {
      hmrClientRequests.push(url.pathname);
      return route.abort();
    }
    if (url.origin !== origin || url.pathname.startsWith("/api/")) {
      rejectedApplicationRequests.push(`${url.origin}${url.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  // The fixture may import UI stores, but it must never open an application backend.
  await page.routeWebSocket("**/*", (socket) => {
    rejectedApplicationRequests.push("application-websocket");
    socket.close();
  });
  const captures = [];
  const mobileMenuFindings = [];
  const workEntryFindings = [];
  const selectedSurfaces = process.env.MOBILE_PARITY_SURFACES
    ? surfaces.filter((surface) => process.env.MOBILE_PARITY_SURFACES.split(",").includes(surface))
    : surfaces;
  assert.ok(selectedSurfaces.length > 0, "reference capture needs a known surface");
  try {
    for (const width of [360, 390, 430].filter(
      (value) =>
        !process.env.MOBILE_PARITY_WIDTHS ||
        process.env.MOBILE_PARITY_WIDTHS.split(",").includes(String(value)),
    )) {
      await page.setViewportSize({ width, height: 844 });
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        for (const surface of selectedSurfaces) {
          for (const client of ["desktop", "mobile"]) {
            await writeFile(
              join(directory, "progress.json"),
              JSON.stringify(
                {
                  current: { client, surface, width, theme },
                  captures: captures.length,
                  pageErrors,
                  rejectedApplicationRequests,
                },
                null,
                2,
              ),
            );
            await page.goto(
              `${origin}/__mobile-parity-reference?client=${client}&surface=${surface}&theme=${theme}`,
            );
            const panel = page.locator(`[data-parity-client="${client}"]`);
            await panel.waitFor();
            if (surface === "thread-list")
              await panel.getByText("Review the mobile implementation", { exact: true }).waitFor();
            if (surface === "header") {
              const heading =
                client === "desktop"
                  ? panel.locator('h2[title="Review the mobile implementation"]')
                  : panel.getByRole("heading", {
                      name: "Review the mobile implementation",
                      exact: true,
                    });
              await heading.waitFor();
            }
            if (surface === "shell") {
              const editor =
                client === "desktop"
                  ? panel.getByTestId("composer-editor")
                  : panel.getByRole("textbox", { name: "Message", exact: true });
              await editor.waitFor();
              const prompt =
                client === "desktop" ? await editor.innerText() : await editor.inputValue();
              assert.equal(
                prompt,
                "What are we working on?",
                "ready shell must show the fixture draft",
              );
            }
            let greetingText = null;
            let greetingGeometry = null;
            if (surface === "shell") {
              const greeting = panel.locator('[data-chat-greeting-copy="true"]');
              await greeting.waitFor();
              greetingText = await greeting.innerText();
              greetingGeometry = await measureGreetingGeometry(greeting);
              assert.ok(
                greetingText.length > 0,
                "controlled ready shell must display eligible copy",
              );
              const box = await greeting.boundingBox();
              assert.ok(
                box && box.y >= 0 && box.y + box.height <= 844,
                "greeting must remain visible",
              );
              if (client === "mobile") {
                const reference = captures.find(
                  (capture) =>
                    capture.surface === surface &&
                    capture.client === "desktop" &&
                    capture.width === width &&
                    capture.theme === theme,
                );
                assert.equal(
                  greetingText,
                  reference?.greetingText,
                  "actual consumers must share greeting copy",
                );
                assertGreetingCopyWidth(greetingGeometry, reference?.greetingGeometry);
              }
            }
            let emptyMark = null;
            if (surface === "empty") {
              const logo = panel.locator("svg").first();
              await logo.waitFor();
              emptyMark = await logo.evaluate((svg) => ({
                opacity: getComputedStyle(svg).opacity,
                color: getComputedStyle(svg).color,
                width: svg.getBoundingClientRect().width,
                height: svg.getBoundingClientRect().height,
              }));
              if (client === "mobile") {
                const reference = captures.find(
                  (capture) =>
                    capture.surface === surface &&
                    capture.client === "desktop" &&
                    capture.width === width &&
                    capture.theme === theme,
                )?.emptyMark;
                assert.ok(reference, "empty mark needs its actual current desktop reference");
                assert.deepEqual(
                  emptyMark,
                  reference,
                  "empty logo opacity/color/size should match",
                );
              }
            }
            let workEntryDetails = null;
            if (surface === "work-entry-details") {
              workEntryDetails = await inspectWorkEntryDetails(page, panel, client);
              if (workEntryDetails.missing)
                workEntryFindings.push({
                  client,
                  width,
                  theme,
                  reason: "missing local disclosure",
                });
              if (client === "mobile" && !workEntryDetails.missing) {
                const reference = captures.find(
                  (entry) =>
                    entry.surface === surface &&
                    entry.client === "desktop" &&
                    entry.width === width &&
                    entry.theme === theme,
                );
                assert.deepEqual(workEntryDetails.blocks, reference?.workEntryDetails?.blocks);
              }
            }
            let menuRows = [];
            let menuSearch = [];
            let menuControls = [];
            if (surface === "model-picker") {
              const inspected = await inspectLockedModelMenu(page, panel, client, width, theme);
              ({ menuRows, menuSearch, menuControls } = inspected);
              mobileMenuFindings.push(...inspected.findings);
            }
            const providerPicker =
              surface === "provider-picker"
                ? await inspectUnlockedProviders(page, panel, client, width, theme, directory)
                : null;
            await page.evaluate(() => document.fonts.ready);
            const geometry = await panel.evaluate((element) => ({
              innerWidth: window.innerWidth,
              desktopBreakpoint: matchMedia("(min-width: 640px)").matches,
              rootFontSize: getComputedStyle(document.documentElement).fontSize,
              spacing: getComputedStyle(document.documentElement).getPropertyValue("--spacing"),
              documentWidth: document.documentElement.clientWidth,
              scrollWidth: document.documentElement.scrollWidth,
              panelWidth: element.getBoundingClientRect().width,
              fontSize: getComputedStyle(element).fontSize,
              dark: document.documentElement.classList.contains("dark"),
            }));
            assert.equal(
              geometry.dark,
              theme === "dark",
              `${client}/${surface} must use the labelled theme`,
            );
            assert.ok(
              geometry.scrollWidth <= geometry.documentWidth,
              `${client}/${surface} must not overflow at ${width}: ${JSON.stringify(geometry)}`,
            );
            const path = join(directory, `${surface}-${client}-${theme}-${width}.png`);
            await page.screenshot({ path, animations: "disabled", caret: "hide" });
            const nativeChoiceChecks =
              surface === "question"
                ? await assertNativeQuestionChoices(page, origin, { client, theme })
                : null;
            captures.push({
              client,
              surface,
              width,
              theme,
              path,
              geometry,
              menuRows,
              menuSearch,
              menuControls,
              emptyMark,
              nativeChoiceChecks,
              greetingText,
              greetingGeometry,
              workEntryDetails,
              providerPicker,
            });
          }
        }
      }
    }
    const result = {
      directory,
      captures,
      pageErrors,
      consoleErrors,
      rejectedApplicationRequests,
      hmrClientRequests,
      mobileMenuFindings,
      workEntryFindings,
      limitations: [
        "Actual current pure desktop components and mobile counterparts are rendered with disposable data; no real desktop session is captured.",
        "Editor comparison covers ComposerPromptEditor, not the full runtime-bound floating composer or its desktop-only controls.",
        "Work-log comparison covers the actual CompactActivityGroup wrapper, with fixture text; it is not full desktop tool-entry rendering.",
        "Full navigation and physical keyboards/screen readers remain separate qualification; shell captures are controlled ready presentation, not bootstrap/provider/runtime proof.",
        "Each panel uses the same current web/mobile styles; external webfont loading is disabled for deterministic isolation.",
      ],
    };
    await writeFile(join(directory, "results.json"), JSON.stringify(result, null, 2));
    if (process.env.MOBILE_PARITY_RESULT_PATH)
      await writeFile(process.env.MOBILE_PARITY_RESULT_PATH, JSON.stringify(result, null, 2));
    assert.deepEqual(
      workEntryFindings,
      [],
      "each client must expose hidden work text through local disclosure",
    );
    assert.deepEqual(hmrClientRequests, [], "immutable fixture must not load Vite HMR client");
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(
      rejectedApplicationRequests,
      [],
      "reference components must not request a real backend or external origin",
    );
    assert.deepEqual(
      mobileMenuFindings,
      workEntryFindings,
      [],
      "mobile model menu needs 44px touch targets and 14px default text",
    );
    return result;
  } catch (error) {
    const fixtureText = await page
      .locator("body")
      .innerText()
      .catch(() => null);
    await page
      .screenshot({ path: join(directory, "failure.png"), animations: "disabled" })
      .catch(() => {});
    await writeFile(
      join(directory, "failure.json"),
      JSON.stringify(
        {
          error: String(error),
          fixtureText,
          hmrClientRequests,
          captures,
          pageErrors,
          consoleErrors,
          rejectedApplicationRequests,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    if (!existing) await context.close();
  }
}
