/**
 * Normalizes raw sub-provider IDs / names to user-friendly display names for UI
 * grouping (e.g. model selector sections).
 *
 * Lookup is case-insensitive so provider APIs that return varying casing
 * ("openai", "OpenAI", etc.) all resolve to the same canonical label.
 * Unknown providers are title-cased with basic acronym heuristics.
 */

const SUB_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  "github-copilot": "GitHub Copilot",
  anthropic: "Anthropic",
  openai: "OpenAI",
  "open-ai": "OpenAI",
  openai_chatgpt: "OpenAI",
  "openai-chatgpt": "OpenAI",
  google: "Google",
  gemini: "Google",
  "google-gemini": "Google",
  google_gemini: "Google",
  groq: "Groq",
  "groq-cloud": "Groq",
  groq_cloud: "Groq",
  openrouter: "OpenRouter",
  xai: "xAI",
  "x.ai": "xAI",
  grok: "xAI",
  xai_grok: "xAI",
  "xai-grok": "xAI",
  deepseek: "DeepSeek",
  "deep-seek": "DeepSeek",
  deep_seek: "DeepSeek",
  cohere: "Cohere",
  "cohere-chat": "Cohere",
  cohere_chat: "Cohere",
  ai21: "AI21",
  ai21labs: "AI21",
  "ai21-labs": "AI21",
  perplexity: "Perplexity",
  "perplexity-ai": "Perplexity",
  perplexity_ai: "Perplexity",
  mistral: "Mistral",
  "mistral-ai": "Mistral",
  mistral_ai: "Mistral",
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  "openai-codex": "OpenAI",
  azure_openai: "Azure",
  "azure-openai": "Azure",
  "amazon-bedrock": "Amazon Bedrock",
  amazon_bedrock: "Amazon Bedrock",
  togetherai: "Together AI",
  "together-ai": "Together AI",
  together_ai: "Together AI",
  "nvidia-nim": "NVIDIA",
  nvidia_nim: "NVIDIA",
  "fireworks-ai": "Fireworks",
  fireworks_ai: "Fireworks",
};

function titleCaseUnknownProvider(raw: string): string {
  return raw
    .split(/[-_\s]+/)
    .map((word) => {
      if (word.length === 0) return word;
      const upper = word.toUpperCase();
      // Preserve common acronyms
      if (
        upper === "AI" ||
        upper === "AWS" ||
        upper === "NVIDIA" ||
        upper === "API" ||
        upper === "UI" ||
        upper === "URL" ||
        upper === "ID" ||
        upper === "HTTP" ||
        upper === "JSON" ||
        upper === "XML" ||
        upper === "HTML" ||
        upper === "CSS" ||
        upper === "JS" ||
        upper === "TS" ||
        upper === "SDK" ||
        upper === "CLI" ||
        upper === "RPC" ||
        upper === "SSH" ||
        upper === "GPU" ||
        upper === "CPU" ||
        upper === "RAM" ||
        upper === "SSD" ||
        upper === "HDD"
      ) {
        return upper;
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

export function getSubProviderDisplayName(rawProvider: string): string {
  const trimmed = rawProvider.trim();
  if (trimmed.length === 0) return trimmed;
  const normalized = trimmed.toLowerCase().replace(/_/g, "-");
  return SUB_PROVIDER_DISPLAY_NAMES[normalized] ?? titleCaseUnknownProvider(normalized);
}
