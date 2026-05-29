import { describe, expect, it } from "vitest";

import { getSubProviderDisplayName } from "./subProviderDisplayNames.ts";

describe("getSubProviderDisplayName", () => {
  it("returns exact match for known providers", () => {
    expect(getSubProviderDisplayName("openai")).toBe("OpenAI");
    expect(getSubProviderDisplayName("anthropic")).toBe("Anthropic");
    expect(getSubProviderDisplayName("github-copilot")).toBe("GitHub Copilot");
  });

  it("is case-insensitive", () => {
    expect(getSubProviderDisplayName("OpenAI")).toBe("OpenAI");
    expect(getSubProviderDisplayName("OPENAI")).toBe("OpenAI");
    expect(getSubProviderDisplayName("Anthropic")).toBe("Anthropic");
    expect(getSubProviderDisplayName("ANTHROPIC")).toBe("Anthropic");
    expect(getSubProviderDisplayName("GitHub-Copilot")).toBe("GitHub Copilot");
  });

  it("trims whitespace before matching", () => {
    expect(getSubProviderDisplayName("  openai  ")).toBe("OpenAI");
    expect(getSubProviderDisplayName("\tanthropic\n")).toBe("Anthropic");
  });

  it("resolves aliases with hyphens and underscores", () => {
    expect(getSubProviderDisplayName("open-ai")).toBe("OpenAI");
    expect(getSubProviderDisplayName("openai_chatgpt")).toBe("OpenAI");
    expect(getSubProviderDisplayName("azure_openai")).toBe("Azure");
    expect(getSubProviderDisplayName("amazon-bedrock")).toBe("Amazon Bedrock");
    expect(getSubProviderDisplayName("amazon_bedrock")).toBe("Amazon Bedrock");
    expect(getSubProviderDisplayName("togetherai")).toBe("Together AI");
    expect(getSubProviderDisplayName("together_ai")).toBe("Together AI");
    expect(getSubProviderDisplayName("nvidia_nim")).toBe("NVIDIA");
    expect(getSubProviderDisplayName("nvidia-nim")).toBe("NVIDIA");
    expect(getSubProviderDisplayName("fireworks_ai")).toBe("Fireworks");
    expect(getSubProviderDisplayName("fireworks-ai")).toBe("Fireworks");
    expect(getSubProviderDisplayName("ai21labs")).toBe("AI21");
    expect(getSubProviderDisplayName("ai21-labs")).toBe("AI21");
    expect(getSubProviderDisplayName("perplexity_ai")).toBe("Perplexity");
    expect(getSubProviderDisplayName("perplexity-ai")).toBe("Perplexity");
    expect(getSubProviderDisplayName("cohere_chat")).toBe("Cohere");
    expect(getSubProviderDisplayName("cohere-chat")).toBe("Cohere");
    expect(getSubProviderDisplayName("deep_seek")).toBe("DeepSeek");
    expect(getSubProviderDisplayName("deep-seek")).toBe("DeepSeek");
    expect(getSubProviderDisplayName("grok")).toBe("xAI");
    expect(getSubProviderDisplayName("xai_grok")).toBe("xAI");
    expect(getSubProviderDisplayName("mistral_ai")).toBe("Mistral");
    expect(getSubProviderDisplayName("mistral-ai")).toBe("Mistral");
    expect(getSubProviderDisplayName("google_gemini")).toBe("Google");
    expect(getSubProviderDisplayName("google-gemini")).toBe("Google");
    expect(getSubProviderDisplayName("groq_cloud")).toBe("Groq");
    expect(getSubProviderDisplayName("groq-cloud")).toBe("Groq");
    expect(getSubProviderDisplayName("openai-codex")).toBe("OpenAI");
  });

  it("title-cases unknown providers", () => {
    expect(getSubProviderDisplayName("some-provider")).toBe("Some Provider");
    expect(getSubProviderDisplayName("another_provider")).toBe("Another Provider");
    expect(getSubProviderDisplayName("foo bar")).toBe("Foo Bar");
  });

  it("preserves acronyms in fallback", () => {
    expect(getSubProviderDisplayName("my-ai")).toBe("My AI");
    expect(getSubProviderDisplayName("aws-bedrock")).toBe("AWS Bedrock");
  });

  it("handles edge cases", () => {
    expect(getSubProviderDisplayName("")).toBe("");
    expect(getSubProviderDisplayName("  ")).toBe("");
    expect(getSubProviderDisplayName("a")).toBe("A");
  });
});
