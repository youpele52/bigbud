import { Metric } from "effect";

export const orchestrationDomainEventReplayPagesTotal = Metric.counter(
  "bigbud_orchestration_domain_event_replay_pages_total",
  {
    description: "Canonical replay pages read to catch domain-event reactors up after wake-up.",
  },
);

export const orchestrationCommandDigestConflictsTotal = Metric.counter(
  "bigbud_orchestration_command_digest_conflicts_total",
  { description: "Command IDs rejected because their canonical payload digest changed." },
);

export const orchestrationCommandUnknownOutcomesTotal = Metric.counter(
  "bigbud_orchestration_command_unknown_outcomes_total",
  { description: "Commands whose terminal canonical outcome could not be proven." },
);
