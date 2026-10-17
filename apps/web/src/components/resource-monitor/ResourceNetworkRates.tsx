import { ResourceTransferRates } from "./ResourceTransferRates";

export interface NetworkRates {
  download: string;
  upload: string;
}

/** Pair each transfer rate with its direction and matching history color. */
export function ResourceNetworkRates({ rates }: { rates: NetworkRates }) {
  return <ResourceTransferRates incoming={rates.download} outgoing={rates.upload} kind="network" />;
}
