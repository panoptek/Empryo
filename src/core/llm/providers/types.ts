import type { LanguageModel } from "ai";

export interface ProviderModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
}

/** Reasoning/thinking configuration for custom OpenAI-compatible providers.
 *  Covers three API styles:
 *  - OpenAI-style: `reasoning.effort` (low/medium/high/xhigh/none)
 *  - DashScope-style: `enable_thinking` + `thinking_budget`
 *  - Raw extra params: forwarded verbatim to the request body */
export interface CustomReasoningConfig {
  /** OpenAI-style reasoning effort level */
  effort?: "low" | "medium" | "high" | "xhigh" | "none";
  /** DashScope-style: enable/disable thinking */
  enabled?: boolean;
  /** DashScope-style: thinking budget in tokens */
  budget?: number;
  /** Raw extra params forwarded verbatim to the request body.
   *  Useful for APIs with non-standard thinking schemas, e.g.:
   *  `{ thinking: { type: "enabled", budget_tokens: 8192 } }` */
  extraParams?: Record<string, unknown>;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  envVar: string;
  icon: string;
  /** Kebab-case key for the secrets store (e.g. "anthropic-api-key"). Derived from envVar if omitted. */
  secretKey?: string;
  /** URL where users can create/manage their API key (shown in /keys UI). */
  keyUrl?: string;
  /** ASCII fallback icon for terminals without nerd fonts. */
  asciiIcon?: string;
  /** Short description for wizard/UI (e.g. "Claude models"). */
  description?: string;
  /** Inline badge for provider selectors (e.g. "unofficial", "non-streaming"). */
  badge?: string;
  /** Custom label shown when the provider is unavailable and needs auth. */
  noAuthLabel?: string;
  /** Custom label shown when model loading fails after the provider is available. */
  authErrorLabel?: string;
  createModel(modelId: string): LanguageModel;
  fetchModels(): Promise<ProviderModelInfo[] | null>;
  fallbackModels: ProviderModelInfo[];
  contextWindows: [pattern: string, tokens: number][];
  /** Overrides for known-incorrect upstream API context window values.
   *  Checked BEFORE API/cache data. Only add entries here when a provider
   *  API reports a wrong value (e.g. OpenRouter lists GLM-5 as 80k). */
  contextWindowOverrides?: [pattern: string, tokens: number][];
  grouped?: boolean;
  custom?: boolean;
  checkAvailability?(): Promise<boolean>;
  onRequestAuth?(): Promise<void>;
  onActivate?(): Promise<void>;
  onDeactivate?(): void;
  /** Reasoning/thinking config for custom providers.
   *  Injected into every request body as OpenAI-style, DashScope-style, or raw params. */
  customReasoning?: CustomReasoningConfig;
  /** Wire API a custom provider speaks. Undefined for built-ins. */
  customAPI?: CustomProviderAPI;
}

/** Wire protocol spoken by a custom provider endpoint.
 *  - "openai-compatible": POST {baseURL}/chat/completions (default)
 *  - "anthropic":         POST {baseURL}/messages (Anthropic Messages API, prompt caching)
 *  - "openai-responses":  POST {baseURL}/responses (OpenAI Responses API) */
export type CustomProviderAPI = "openai-compatible" | "anthropic" | "openai-responses";

/** Name of the output-token limit field on chat/completions requests.
 *  "auto" sends `max_completion_tokens` for OpenAI reasoning models (o1/o3/o4/gpt-5)
 *  and `max_tokens` for everything else. */
export type MaxTokensParam = "auto" | "max_tokens" | "max_completion_tokens";

export interface CustomProviderConfig {
  id: string;
  name?: string;
  baseURL: string;
  envVar?: string;
  models?: (string | ProviderModelInfo)[];
  modelsAPI?: string | false;
  /** Reasoning/thinking configuration for this provider.
   *  Enables thinking control for models that support it via OpenAI-compatible APIs. */
  reasoning?: CustomReasoningConfig;
  /** Wire API to use. Defaults to "openai-compatible". */
  api?: CustomProviderAPI;
  /** Output-token limit field for "openai-compatible" requests. Defaults to "auto". */
  maxTokensParam?: MaxTokensParam;
  /** Auth header for the "anthropic" API: "x-api-key" (default) or "bearer" (Authorization: Bearer). */
  authHeader?: "x-api-key" | "bearer";
  /** Extra HTTP headers sent with every request. */
  headers?: Record<string, string>;
}
