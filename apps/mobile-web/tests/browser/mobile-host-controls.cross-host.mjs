import {
  CONTROL_ORIGINS,
  controlGeometry,
  inspectGeometry,
} from "./mobile-host-controls.fixture.mjs";

export async function captureCrossHostControls({ page, state, size, capture, check }) {
  await page
    .getByRole("heading", { name: "Open the host's own mobile app", exact: true })
    .waitFor();
  const geometry = await controlGeometry(page, size);
  for (const issue of inspectGeometry(geometry)) check(issue, false);
  const target = page.getByText(CONTROL_ORIGINS.B, { exact: true });
  const destinationBox = await target.boundingBox();
  check(
    "cross-host-full-destination-fits",
    destinationBox.x >= -1 && destinationBox.x + destinationBox.width <= size.width + 1,
    destinationBox,
  );
  check(
    "foreign-host-no-credential-transport",
    state.sockets.length === 0 && state.http.length === 0,
  );
  await page.evaluate(() => {
    globalThis.__crossHostOriginalCollection = localStorage.getItem("bigbud:mobile-web:hosts:v2");
  });
  await capture("destination");
  await page.getByRole("button", { name: "Remember host link", exact: true }).click();
  await page.getByText("Host link remembered without credentials.", { exact: true }).waitFor();
  check(
    "cross-host-remember-preserves-credential-collection",
    await page.evaluate(
      () =>
        localStorage.getItem("bigbud:mobile-web:hosts:v2") ===
        globalThis.__crossHostOriginalCollection,
    ),
  );
  check(
    "cross-host-remembers-public-target-only",
    await page.evaluate((origin) => {
      const value = JSON.parse(localStorage.getItem("bigbud:mobile-web:host-directory:v1"));
      const entry = value.entries.find((item) => item.backendOrigin === origin);
      return (
        !!entry &&
        Object.keys(entry).every((key) => key === "backendOrigin" || key === "authorityId")
      );
    }, CONTROL_ORIGINS.B),
  );
  const link = page.getByRole("link", { name: "Open host mobile app", exact: true });
  check(
    "cross-host-clean-top-navigation",
    (await link.getAttribute("href")) === `${CONTROL_ORIGINS.B}/mobile/` &&
      (await link.getAttribute("referrerpolicy")) === "no-referrer",
  );
  await link.click();
  await page.getByRole("heading", { name: "Destination host fixture", exact: true }).waitFor();
  check("cross-host-navigation-has-no-secret", page.url() === `${CONTROL_ORIGINS.B}/mobile/`);
  check(
    "cross-host-no-credential-forwarding",
    state.sockets.length === 0 && state.http.length === 0,
  );
  return {
    geometry,
    destinationBox,
    credentialSockets: state.sockets.length,
    credentialRequests: state.http.length,
  };
}
