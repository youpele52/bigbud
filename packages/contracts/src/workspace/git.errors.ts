import { Schema } from "effect";
import { ExecutionTargetId } from "../core/baseSchemas";

export class GitCommandError extends Schema.TaggedErrorClass<GitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Git command failed in ${this.operation}: ${this.command} (${this.cwd}) - ${this.detail}`;
  }
}

export class GitExecutionTargetError extends Schema.TaggedErrorClass<GitExecutionTargetError>()(
  "GitExecutionTargetError",
  {
    operation: Schema.String,
    executionTargetId: ExecutionTargetId,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Git execution target failed in ${this.operation}: ${this.executionTargetId} - ${this.detail}`;
  }
}

export class GitHubCliError extends Schema.TaggedErrorClass<GitHubCliError>()("GitHubCliError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `GitHub CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class TextGenerationError extends Schema.TaggedErrorClass<TextGenerationError>()(
  "TextGenerationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Text generation failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitManagerError extends Schema.TaggedErrorClass<GitManagerError>()("GitManagerError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Git manager failed in ${this.operation}: ${this.detail}`;
  }
}

export const GitServiceError = Schema.Union([GitCommandError, GitExecutionTargetError]);
export type GitServiceError = typeof GitServiceError.Type;

export const GitManagerServiceError = Schema.Union([
  GitManagerError,
  GitCommandError,
  GitExecutionTargetError,
  GitHubCliError,
  TextGenerationError,
]);
export type GitManagerServiceError = typeof GitManagerServiceError.Type;
