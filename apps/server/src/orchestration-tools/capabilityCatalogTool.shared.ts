export const SEARCH_CAPABILITIES_TOOL_DESCRIPTION =
  "Search the read-only bigbud capability catalog by task or keyword.";

export const READ_CAPABILITY_GUIDE_TOOL_DESCRIPTION =
  "Read a bounded section of an authoritative bigbud capability Track.";

export const CAPABILITY_GUIDE_SECTIONS = [
  "summary",
  "workflow",
  "permissions",
  "examples",
  "full",
] as const;

export const SEARCH_CAPABILITIES_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Task or keywords to match; omit or use an empty string to list capabilities",
      maxLength: 500,
    },
  },
  required: [],
  additionalProperties: false,
} as const;

export const READ_CAPABILITY_GUIDE_PARAMETERS = {
  type: "object",
  properties: {
    capabilityId: {
      type: "string",
      description: "Capability ID or bigbud://capabilities URI",
      maxLength: 200,
    },
    section: {
      type: "string",
      enum: CAPABILITY_GUIDE_SECTIONS,
      description: "Bounded Track section; defaults to summary",
    },
  },
  required: ["capabilityId"],
  additionalProperties: false,
} as const;
