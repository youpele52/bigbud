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

/** Click a real link and report what the embedding page received, without a host app. */
export const checkHtmlRenderLinkClick: BrowserCommand<
  [document: string, selector: string]
> = async ({ context }, document, selector) => {
  const page = await context.newPage();
  const requests: string[] = [];
  try {
    page.on("request", (request) => requests.push(request.url()));
    await page.route("https://render-leak.invalid/**", (route) =>
      route.fulfill({ body: "Leaked" }),
    );
    await page.setContent('<iframe title="Guard" sandbox="allow-scripts"></iframe>');
    await page.evaluate(() => {
      const messages: unknown[] = [];
      Object.assign(window, { renderMessages: messages });
      addEventListener("message", (event) => {
        if (event.data?.type === "bigbud:open-link") messages.push(event.data);
      });
    });
    await page.locator("iframe").evaluate((frame, srcdoc) => {
      (frame as HTMLIFrameElement).srcdoc = srcdoc;
    }, document);
    const guard = page.frameLocator('iframe[title="Guard"]');
    await guard.frameLocator("iframe").locator(selector).click();
    // Give the relay time to arrive, and a would-be navigation time to raise its CSP violation.
    await page.waitForTimeout(300);
    return {
      messages: await page.evaluate(
        () => (window as { renderMessages?: unknown[] }).renderMessages,
      ),
      remainingFrames: await guard.locator("iframe").count(),
      notices: await guard.getByText("This visual attempted a blocked navigation.").count(),
      requests: requests.filter((url) => url.startsWith("https://render-leak.invalid/")),
    };
  } finally {
    await page.close();
  }
};

/** Real user clicks inside a rendered visual in the test page, so user activation is genuine. */
export const clickHtmlRenderLinks: BrowserCommand<[title: string, selectors: string[]]> = async (
  context,
  title,
  selectors,
) => {
  const visual = context.iframe.frameLocator(`iframe[title="${title}"]`).frameLocator("iframe");
  for (const selector of selectors) await visual.locator(selector).click();
};
