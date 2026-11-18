import { HOSTED, installHostAccessRoutes } from "./mobile-host-access.routes.mjs";

export const CONTROL_ORIGINS = Object.fromEntries(
  ["A", "B", "C", "D"].map((key) => [
    key,
    `https://${key.toLowerCase().repeat(63)}.${"remote".repeat(8)}.example.invalid`,
  ]),
);
export const CONTROL_SIZES = [
  { name: "360-portrait", width: 360, height: 800 },
  { name: "390-portrait", width: 390, height: 844 },
  { name: "430-portrait", width: 430, height: 932 },
  { name: "landscape", width: 844, height: 390 },
  { name: "keyboard", width: 390, height: 844, visibleHeight: 320 },
];
/** Reject misspelled/empty subsets instead of accepting a zero-case browser run. */
export function selectHostControlSizes(configured) {
  if (configured === undefined) return CONTROL_SIZES;
  const names = configured.split(",");
  if (!names.length || names.some((name) => !CONTROL_SIZES.some((entry) => entry.name === name)))
    throw new Error("Unknown or empty host controls fixture size selection");
  return CONTROL_SIZES.filter((entry) => names.includes(entry.name));
}

export const CONTROL_DIRECTORY = ["C", "D"].map((host) => ({
  backendOrigin: CONTROL_ORIGINS[host],
  displayName: "LongHostLabel".repeat(6),
}));
export function controlSession(data, host) {
  return {
    ...data.hostAccessSessions[host],
    backendBaseUrl: CONTROL_ORIGINS[host],
    websocketUrl: `${CONTROL_ORIGINS[host].replace("https:", "wss:")}/mobile-ws?token=${data.hostAccessSessions[host].sessionToken}`,
  };
}
export async function setupHostControlPage(
  browser,
  localOrigin,
  data,
  size,
  theme,
  { blocked = true, foreignOrigin = false } = {},
) {
  const appOrigin = foreignOrigin ? CONTROL_ORIGINS.A : HOSTED;
  const page = await browser.newPage({
    viewport: { width: size.width, height: size.height },
    colorScheme: theme,
    hasTouch: true,
  });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const state = await installHostAccessRoutes(page, {
    localOrigin,
    appOrigin,
    config: data.hostAccessConfig,
    descriptors: Object.fromEntries(
      ["A", "B"].map((host) => [
        host,
        { ...data.hostAccessDescriptors[host], mobileCapable: !blocked },
      ]),
    ),
    sessions: { A: controlSession(data, "A"), B: controlSession(data, "B") },
    hostOrigins: CONTROL_ORIGINS,
    ...(blocked ? { handshakeBarrier: () => barrier } : {}),
  });
  const entries = ["A", "B"].map((host) => ({
    backendOrigin: CONTROL_ORIGINS[host],
    pin: {
      authority: data.hostAccessDescriptors[host].authority,
      installationFingerprint: data.hostAccessDescriptors[host].installationFingerprint,
    },
    session: {
      sessionId: data.hostAccessSessions[host].sessionId,
      sessionToken: data.hostAccessSessions[host].sessionToken,
      backendBaseUrl: CONTROL_ORIGINS[host],
      scope: data.hostAccessSessions[host].scope,
      expiresAt: data.hostAccessSessions[host].expiresAt,
    },
  }));
  await page.addInitScript(
    ({ size, theme, entries, blocked, legacy, directory, authority }) => {
      localStorage.setItem("bigbud:theme", theme);
      localStorage.setItem(
        "bigbud:mobile-web:host-directory:v1",
        JSON.stringify({ version: 1, entries: directory }),
      );
      if (blocked)
        localStorage.setItem(
          "bigbud:mobile-web:hosts:v2",
          JSON.stringify({
            version: 2,
            entries,
            selectedAuthorityId: authority,
            legacySelected: false,
            legacySession: legacy,
          }),
        );
      else localStorage.setItem("bigbud:mobile-web:session:v1", JSON.stringify(legacy));
      const viewport = Object.assign(new EventTarget(), {
        height: size.visibleHeight ?? size.height,
        width: size.width,
        offsetTop: 0,
        offsetLeft: 0,
        pageTop: 0,
        pageLeft: 0,
        scale: 1,
      });
      Object.defineProperty(window, "visualViewport", { value: viewport });
    },
    {
      size,
      theme,
      entries,
      blocked,
      legacy: blocked
        ? {
            ...controlSession(data, "A"),
            backendBaseUrl: CONTROL_ORIGINS.C,
            websocketUrl: `${CONTROL_ORIGINS.C.replace("https:", "wss:")}/mobile-ws?token=unused-fixture`,
          }
        : controlSession(data, "A"),
      directory: CONTROL_DIRECTORY,
      authority: data.hostAccessDescriptors[foreignOrigin ? "B" : "A"].authority.authorityId,
    },
  );
  return { page, state, release, origin: appOrigin };
}
export async function controlGeometry(page, size, scope = "body") {
  return page.evaluate(
    ({ visibleHeight, height, scope }) => {
      const boxes = [...document.querySelectorAll("button, a[href], input, [role=menuitem]")]
        .filter((element) => element.getClientRects().length && element.closest(scope))
        .map((element) => ({
          text: element.getAttribute("aria-label") ?? element.textContent.trim(),
          tag: element.tagName,
          box: element.getBoundingClientRect().toJSON(),
          font: getComputedStyle(
            element.matches('input[type="checkbox"]') ? element.closest("label") : element,
          ).fontSize,
          checkboxLabel: element.matches('input[type="checkbox"]')
            ? element.closest("label")?.getBoundingClientRect().toJSON()
            : null,
          scroll: element.scrollWidth,
          client: element.clientWidth,
        }));
      const menu = document.querySelector('[role="menu"]');
      return {
        visibleHeight: visibleHeight ?? height,
        innerHeight,
        rootWidth: document.documentElement.clientWidth,
        rootScroll: document.documentElement.scrollWidth,
        menu: menu
          ? {
              box: menu.getBoundingClientRect().toJSON(),
              client: menu.clientWidth,
              scroll: menu.scrollWidth,
            }
          : null,
        boxes,
      };
    },
    { ...size, scope },
  );
}
export function inspectGeometry(result) {
  const issues = [];
  if (result.rootScroll > result.rootWidth + 1) issues.push("document-horizontal-overflow");
  if (
    result.menu &&
    (result.menu.scroll > result.menu.client + 1 ||
      result.menu.box.left < -1 ||
      result.menu.box.right > result.rootWidth + 1 ||
      result.menu.box.top < -1 ||
      result.menu.box.bottom > result.visibleHeight + 1)
  )
    issues.push("menu-outside-visible-viewport-or-overflow");
  for (const entry of result.boxes) {
    const target = entry.checkboxLabel ?? entry.box;
    if (target.height < 43.5 || target.width < 43.5) issues.push(`small-control:${entry.text}`);
    if (entry.font !== "14px") issues.push(`control-font:${entry.text}:${entry.font}`);
    if (entry.box.left < -1 || entry.box.right > result.rootWidth + 1)
      issues.push(`control-outside-horizontal-viewport:${entry.text}`);
    if (entry.scroll > entry.client + 1) issues.push(`control-horizontal-overflow:${entry.text}`);
  }
  return issues;
}

/** Base UI restores focus during close cleanup; allow bounded reduced-motion settlement. */
export async function controlFocusSettled(locator) {
  return locator.evaluate(
    (element) =>
      new Promise((resolve) => {
        const deadline = performance.now() + 500;
        const check = () => {
          if (element === document.activeElement) resolve(true);
          else if (performance.now() >= deadline) resolve(false);
          else requestAnimationFrame(check);
        };
        check();
      }),
  );
}
