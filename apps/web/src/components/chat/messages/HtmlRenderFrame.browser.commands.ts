import "@vitest/browser-playwright";
import type { BrowserCommand } from "vitest/node";

/** Observe requests outside the untrusted document, including failed network attempts. */
export const checkHtmlRenderNavigation: BrowserCommand<
  [document: string, clickLink: boolean]
> = async ({ context }, document, clickLink) => {
  const page = await context.newPage();
  const requests: string[] = [];
  try {
    page.on("request", (request) => requests.push(request.url()));
    await page.route("https://render-leak.invalid/**", (route) =>
      route.fulfill({ body: "Leaked" }),
    );
    await page.setContent('<iframe title="Guard" sandbox="allow-scripts"></iframe>');
    await page.locator("iframe").evaluate((frame, srcdoc) => {
      (frame as HTMLIFrameElement).srcdoc = srcdoc;
    }, document);
    const guard = page.frameLocator('iframe[title="Guard"]');
    if (clickLink) await guard.frameLocator("iframe").getByRole("link").click();
    await guard
      .getByText("This visual attempted a blocked navigation.", { exact: false })
      .waitFor();
    return {
      remainingFrames: await guard.locator("iframe").count(),
      requests: requests.filter((url) => url.startsWith("https://render-leak.invalid/")),
    };
  } finally {
    await page.close();
  }
};
