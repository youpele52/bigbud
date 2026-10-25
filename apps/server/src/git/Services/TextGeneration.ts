/**
 * TextGeneration - Effect service contract for AI-generated Git content.
 *
 * Generates commit messages and pull request titles/bodies from repository
 * context prepared by Git services.
 *
 * @module TextGeneration
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ChatAttachment, ModelSelection, ProviderKind } from "@bigbud/contracts";

import type { TextGenerationError } from "@bigbud/contracts";

/** Providers that support git text generation (commit messages, PR content, branch names). */
export type TextGenerationProvider = ProviderKind;

/**
 * Only verified thread success authorizes a fallback. Routing ignores the legacy
 * `modelSelection` input as evidence; concrete provider adapters still consume it as their target.
 */
export interface InternalTextGenerationContext {
  readonly successfulModelSelection?: ModelSelection | null;
  /** Required metadata ownership is persisted by the router for its actual native candidate. */
  readonly beforeV2Dispatch?: (
    selection: ModelSelection,
  ) => Effect.Effect<void, TextGenerationError>;
}

export interface CommitMessageGenerationInput extends InternalTextGenerationContext {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  /** Optional skill content to use as the prompt instructions instead of the built-in prompt. */
  skillContent?: string;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput extends InternalTextGenerationContext {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput extends InternalTextGenerationContext {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput extends InternalTextGenerationContext {
  /** Staged recovery may use only this turn's verified pair, ignoring the global override. */
  verifiedThreadModelOnly?: boolean;
  cwd: string;
  titleSeed?: string | undefined;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export interface ThreadElevatorSummaryGenerationInput extends InternalTextGenerationContext {
  cwd: string;
  transcript: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadElevatorSummaryGenerationResult {
  summary: string;
}

export interface PromptSuggestionGenerationInput extends InternalTextGenerationContext {
  cwd: string;
  /** Bounded, redacted user and assistant message text (no tool output). */
  transcript: string;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PromptSuggestionGenerationResult {
  /** Raw suggestion; the attaching pipeline normalizes and bounds it. */
  suggestion: string;
  actualModelSelection?: ModelSelection;
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
  generateThreadElevatorSummary(
    input: ThreadElevatorSummaryGenerationInput,
  ): Promise<ThreadElevatorSummaryGenerationResult>;
}

/**
 * TextGenerationShape - Service API for commit/PR text generation.
 */
export interface TextGenerationShape {
  /**
   * Generate a commit message from staged change context.
   */
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  /**
   * Generate pull request title/body from branch and diff context.
   */
  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  /**
   * Generate a concise branch name from a user message.
   */
  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  /**
   * Generate a concise thread title from a user's first message.
   */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  /**
   * Generate a concise thread elevator summary from a thread transcript.
   */
  readonly generateThreadElevatorSummary: (
    input: ThreadElevatorSummaryGenerationInput,
  ) => Effect.Effect<ThreadElevatorSummaryGenerationResult, TextGenerationError>;

  /**
   * Generate the logical next user message after a settled turn (Phase 7).
   */
  readonly generatePromptSuggestion: (
    input: PromptSuggestionGenerationInput,
  ) => Effect.Effect<PromptSuggestionGenerationResult, TextGenerationError>;
}

/**
 * TextGeneration - Service tag for commit and PR text generation.
 */
export class TextGeneration extends ServiceMap.Service<TextGeneration, TextGenerationShape>()(
  "t3/git/Services/TextGeneration",
) {}
