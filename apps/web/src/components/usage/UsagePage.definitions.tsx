// Also carries the token-type caveats, which no longer sit under the donut.
const USAGE_DEFINITIONS: ReadonlyArray<readonly [term: string, definition: string]> = [
  ["Cached", "Input tokens reused from a provider cache."],
  [
    "Input",
    "Tokens sent to the model, including your prompt and context. May include cache usage a provider did not report separately.",
  ],
  ["Output", "Tokens generated in the model response, including reasoning."],
  [
    "Reasoning",
    "Tokens some models use for internal reasoning before answering. Counted within Output.",
  ],
  ["Unsplit usage", "Usage with no reliable category breakdown."],
];

export function UsageDefinitions() {
  return (
    <dl className="space-y-2">
      {USAGE_DEFINITIONS.map(([term, definition]) => (
        <div key={term} className="flex flex-wrap gap-x-2 gap-y-0.5">
          <dt className="font-medium text-foreground">{term}:</dt>
          <dd>{definition}</dd>
        </div>
      ))}
    </dl>
  );
}
