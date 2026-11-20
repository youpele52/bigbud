import {
  handleMarketingRequest,
  type MarketingWorkerContext,
  type MarketingWorkerEnv,
} from "./marketingWorker";

/**
 * Entry of the Cloudflare Pages advanced-mode worker. `bun run build` bundles it into
 * `dist/_worker.js`, so Pages deploys it whatever the project's root directory is.
 * `public/_routes.json` limits invocations to `/download/*`.
 */
export default {
  fetch: (request: Request, env: MarketingWorkerEnv, context: MarketingWorkerContext) =>
    handleMarketingRequest(request, env, context),
};
