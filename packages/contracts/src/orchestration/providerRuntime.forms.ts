import { Schema } from "effect";

/** Optional native form constraints; absent metadata preserves legacy provider question behavior. */
export const UserInputField = Schema.Struct({
  type: Schema.Literals(["string", "number", "integer", "boolean", "multiselect"]),
  required: Schema.Boolean,
  allowCustom: Schema.Boolean,
  minLength: Schema.optional(Schema.Number),
  maxLength: Schema.optional(Schema.Number),
  minimum: Schema.optional(Schema.Number),
  maximum: Schema.optional(Schema.Number),
  minItems: Schema.optional(Schema.Number),
  maxItems: Schema.optional(Schema.Number),
  format: Schema.optional(Schema.Literals(["email", "uri", "date", "date-time"])),
});
