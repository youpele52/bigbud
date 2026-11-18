import type * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {
  RemoteMobileConsentJournal,
  RemoteMobileConsentJournalLive,
} from "./mobileConsentEnable.ts";
import { mobileOwnerActivationRoute } from "./mobileOwnerActivation.ts";

/**
 * The owner route with its request-scoped services. `HttpRouter` runs a handler with the request
 * fiber's services, so a service the handler reads at request time must come through
 * `provideRequest`; `Layer.provide` on the route layer reaches only route registration. The proof
 * inputs report is not provided here: the attach layer records its single read on the app-wide
 * activation state, which the handler reads.
 */
export const makeMobileOwnerActivationRoutes = <E, R>(
  journal: Layer.Layer<RemoteMobileConsentJournal, E, R>,
) => mobileOwnerActivationRoute.pipe(HttpRouter.provideRequest(journal));

export const mobileOwnerActivationRoutesLive = makeMobileOwnerActivationRoutes(
  RemoteMobileConsentJournalLive,
);
