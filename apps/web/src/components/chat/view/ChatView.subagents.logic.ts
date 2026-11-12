// Keep the composer's Stop authority and notification work ownership in one shared module.
export {
  hasOwnedV2DescendantWork,
  countRunningBackgroundSubagents,
  describeThreadBackgroundWork,
  getThreadInterruptTurnId,
} from "../../../logic/thread/threadBackgroundWork.logic";
