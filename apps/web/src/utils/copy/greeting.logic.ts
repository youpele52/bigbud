// Compatibility facade; shared consumers use the explicit runtime subpath.
export {
  createGreetingSelector,
  getGreetingPeriod,
  greetingForChat,
  isGreetingEligibleOnLocalDate,
  renderGreeting,
  selectGreeting,
} from "@bigbud/shared/greeting";
