import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { selectHostControlSizes, setupHostControlPage } from "./mobile-host-controls.fixture.mjs";
import { captureBlockedHostControls } from "./mobile-host-controls.blocked.mjs";
import { captureCrossHostControls } from "./mobile-host-controls.cross-host.mjs";
import { captureHostSettingsControls } from "./mobile-host-controls.settings.mjs";

/** Actual App and actual host controls, disposable long names only; no physical phone claim. */
export async function captureMobileHostControls(browser, localOrigin, data) {
  const directory = process.env.MOBILE_HOST_ACCESS_OUTPUT_DIR ?? "/parity/results/host-controls";
  await mkdir(directory, { recursive: true });
  const results = [];
  const surfaces = (process.env.MOBILE_HOST_CONTROL_CASES ?? "blocked,settings").split(",");
  const sizes = selectHostControlSizes(process.env.MOBILE_HOST_CONTROL_SIZES);
  let fatal = false;
  for (const surface of surfaces) {
    if (!["blocked", "settings", "cross-host"].includes(surface))
      throw new Error("Unknown host controls fixture case");
    for (const size of sizes) {
      for (const theme of ["light", "dark"]) {
        const name = `${surface}-${size.name}-${theme}`;
        const owned = await setupHostControlPage(browser, localOrigin, data, size, theme, {
          blocked: surface !== "settings",
          foreignOrigin: surface === "cross-host",
        });
        const { page, state, release, origin } = owned;
        const findings = [];
        const captures = [];
        const check = (claim, pass, detail) => {
          if (!pass) findings.push({ claim, ...(detail === undefined ? {} : { detail }) });
        };
        const capture = async (stage) => {
          const file = `${name}-${stage}.png`;
          await page.screenshot({
            path: join(directory, file),
            animations: "disabled",
            clip: { x: 0, y: 0, width: size.width, height: size.visibleHeight ?? size.height },
          });
          captures.push(file);
        };
        let checks;
        try {
          await page.goto(`${origin}/mobile?fixtureStrict=1`);
          checks = await (
            surface === "blocked"
              ? captureBlockedHostControls
              : surface === "cross-host"
                ? captureCrossHostControls
                : captureHostSettingsControls
          )({ ...owned, data, size, check, capture });
          check("no-page-console-errors", state.errors.length === 0, state.errors);
          check(
            "no-application-network-or-hmr",
            state.rejected.length === 0 && state.hmr.length === 0,
            { rejected: state.rejected, hmr: state.hmr },
          );
        } catch (error) {
          fatal = true;
          findings.push({
            claim: "fixture-workflow",
            detail: error instanceof Error ? error.message : String(error),
          });
          await capture("failure").catch(() => undefined);
          checks = {
            body: (
              await page
                .locator("body")
                .innerText()
                .catch(() => "")
            ).slice(0, 5000),
            http: state.http,
            rpc: state.rpc,
            errors: state.errors,
            rejected: state.rejected,
            hmr: state.hmr,
          };
        } finally {
          release();
          await page.close();
        }
        const result = {
          name,
          status: findings.length ? "failed" : "passed",
          size,
          theme,
          findings,
          captures,
          checks,
        };
        results.push(result);
        await writeFile(join(directory, `${name}.json`), JSON.stringify(result, null, 2));
        if (fatal) break;
      }
      if (fatal) break;
    }
    if (fatal) break;
  }
  const result = {
    directory,
    results,
    qualification:
      "Synthetic Linux Electron actual-App controls; mocked visualViewport at scale1, fictional host credentials/data, no real TLS/VPS/phone/AT qualification",
  };
  await writeFile(join(directory, "results.json"), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      cases: results.length,
      failures: results.filter((entry) => entry.status === "failed").length,
      findings: results.flatMap((entry) => entry.findings).length,
      captures: results.flatMap((entry) => entry.captures).length,
    }),
  );
  if (results.some((entry) => entry.status === "failed"))
    throw new Error("Host-control assertions failed; exact findings preserved in results.json");
  return result;
}
