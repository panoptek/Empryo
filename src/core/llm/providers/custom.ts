import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getProviderApiKey } from "../../secrets.js";
import {
  buildOpenAICompatReasoningBody,
  createSessionFetchWrapper,
  type ReasoningFetchFn,
} from "./reasoning-fetch.js";
import type {
  CustomProviderConfig,
  CustomReasoningConfig,
  MaxTokensParam,
  ProviderDefinition,
  ProviderModelInfo,
} from "./types.js";

interface OpenAIModelListEntry {
  id: string;
  owned_by?: string;
  /** Anthropic `/v1/models` returns the input context window here. */
  max_input_tokens?: number;
  /** OpenRouter returns top-level `context_length`. */
  context_length?: number;
  /** LM Studio `/api/v0/models` returns `max_context_length`. */
  max_context_length?: number;
  /** LiteLLM nests context length under model_info (number or stringified number). */
  model_info?: {
    max_input_tokens?: number | string;
  };
  /** llama.cpp nests training context under `meta.n_ctx_train`. */
  meta?: {
    n_ctx_train?: number;
  };
}

/**
 * Normalize a baseURL path by stripping a trailing `/v1` segment so that
 * appending `/models` does not produce `/v1/v1/models`.
 *
 * Examples:
 *   "https://api.example.com/v1"         → "https://api.example.com"
 *   "https://api.example.com/v1/"        → "https://api.example.com"
 *   "https://api.example.com"            → "https://api.example.com"
 *   "https://api.example.com/api/v1"     → "https://api.example.com/api"
 *   "https://api.example.com/"           → "https://api.example.com/"
 */
function normalizeBaseURLPath(baseURL: string): string {
  return baseURL.replace(/\/v1(?:\/)?$/i, "").replace(/\/+$/, "");
}

/**
 * Build the models-api endpoint for a custom provider.
 *
 * Resolution order:
 *   1. Explicit `modelsAPI` from config — user-configured endpoint, used as-is.
 *   2. Native APIs append `/models` to `baseURL`; the legacy OpenAI-compatible
 *      route strips trailing `/v1` first to preserve existing configurations.
 *      Returns null only when `baseURL` itself is absent (should not happen in practice).
 */
function resolveModelsAPIUrl(config: CustomProviderConfig): string | null {
  if (config.modelsAPI === false) return null;
  if (config.modelsAPI) return config.modelsAPI;
  const normalized =
    config.api && config.api !== "openai-compatible"
      ? config.baseURL.replace(/\/+$/, "")
      : normalizeBaseURLPath(config.baseURL);
  return `${normalized}/models`;
}

function normalizeModels(models?: (string | ProviderModelInfo)[]): ProviderModelInfo[] {
  if (!models || models.length === 0) return [];
  return models.map((m) => (typeof m === "string" ? { id: m, name: m } : m));
}

function buildReasoningBody(reasoning?: CustomReasoningConfig): Record<string, unknown> {
  if (!reasoning) return {};
  return buildOpenAICompatReasoningBody(reasoning.effort, {
    enabled: reasoning.enabled,
    budget: reasoning.budget,
    extraParams: reasoning.extraParams,
  });
}

const OPENAI_REASONING_MODEL = /^(o\d|gpt-5)/i;

/** Resolve which output-token field a chat/completions request should carry. */
export function resolveMaxTokensParam(
  modelId: string,
  setting: MaxTokensParam = "auto",
): "max_tokens" | "max_completion_tokens" {
  if (setting !== "auto") return setting;
  const base = modelId.slice(modelId.lastIndexOf("/") + 1);
  return OPENAI_REASONING_MODEL.test(base) ? "max_completion_tokens" : "max_tokens";
}

/** Rename `max_tokens` → `max_completion_tokens` in JSON request bodies.
 *  OpenAI reasoning models reject `max_tokens` on chat/completions. */
function withMaxCompletionTokens(baseFetch: ReasoningFetchFn = fetch): ReasoningFetchFn {
  return async (input, init): Promise<Response> => {
    if (typeof init?.body !== "string") return baseFetch(input, init);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return baseFetch(input, init);
    }
    if (!("max_tokens" in parsed)) return baseFetch(input, init);
    const { max_tokens, ...rest } = parsed;
    const body = { ...rest, max_completion_tokens: rest.max_completion_tokens ?? max_tokens };
    return baseFetch(input, { ...init, body: JSON.stringify(body) });
  };
}

export function buildCustomProvider(config: CustomProviderConfig): ProviderDefinition {
  const envVar = config.envVar ?? "";
  const api = config.api ?? "openai-compatible";
  const reasoningBody =
    api === "openai-compatible"
      ? buildReasoningBody(config.reasoning)
      : { ...config.reasoning?.extraParams };

  return {
    id: config.id,
    name: config.name ?? config.id,
    envVar,
    icon: "\uF29F", // nf-fa-diamond U+F29F
    asciiIcon: "◇",
    custom: true,
    customReasoning: config.reasoning,
    customAPI: api,

    createModel(modelId: string) {
      const apiKey = envVar ? (getProviderApiKey(envVar) ?? "") : "custom";
      const headers = config.headers;

      if (api === "anthropic") {
        const auth = config.authHeader === "bearer" ? { authToken: apiKey } : { apiKey };
        return createAnthropic({
          baseURL: config.baseURL,
          ...auth,
          headers,
          fetch: createSessionFetchWrapper(reasoningBody) as typeof fetch,
        })(modelId);
      }

      if (api === "openai-responses") {
        return createOpenAI({
          baseURL: config.baseURL,
          apiKey,
          headers,
          fetch: createSessionFetchWrapper(reasoningBody) as typeof fetch,
        }).responses(modelId);
      }

      const renameMaxTokens =
        resolveMaxTokensParam(modelId, config.maxTokensParam) === "max_completion_tokens";
      const client = createOpenAICompatible({
        name: config.id,
        baseURL: config.baseURL,
        apiKey,
        headers,
        fetch: createSessionFetchWrapper(
          reasoningBody,
          renameMaxTokens ? withMaxCompletionTokens() : fetch,
        ) as typeof fetch,
      });
      return client.chatModel(modelId);
    },

    async fetchModels(): Promise<ProviderModelInfo[] | null> {
      const modelsUrl = resolveModelsAPIUrl(config);
      if (!modelsUrl) return null;

      const apiKey = envVar ? (getProviderApiKey(envVar) ?? "") : "";
      const headers: Record<string, string> = {
        ...config.headers,
        "Content-Type": "application/json",
      };
      if (api === "anthropic") headers["anthropic-version"] = "2023-06-01";
      if (apiKey) {
        if (api === "anthropic" && config.authHeader !== "bearer") headers["x-api-key"] = apiKey;
        else headers.Authorization = `Bearer ${apiKey}`;
      }

      let res: Response;
      try {
        res = await fetch(modelsUrl, {
          headers,
          signal: AbortSignal.timeout(2000),
        });
      } catch {
        return null;
      }
      if (!res.ok) return null;

      let parsed: { data?: OpenAIModelListEntry[] };
      try {
        parsed = (await res.json()) as { data?: OpenAIModelListEntry[] };
      } catch {
        return null;
      }
      if (!Array.isArray(parsed.data)) return null;

      return parsed.data.map((m) => {
        const rawContext =
          m.context_length ??
          m.max_input_tokens ??
          m.max_context_length ??
          m.model_info?.max_input_tokens ??
          m.meta?.n_ctx_train;
        const contextWindow =
          typeof rawContext === "number"
            ? rawContext
            : typeof rawContext === "string"
              ? Number(rawContext)
              : undefined;
        return {
          id: m.id,
          name: m.id,
          ...(contextWindow !== undefined && !Number.isNaN(contextWindow) ? { contextWindow } : {}),
        };
      });
    },

    fallbackModels: normalizeModels(config.models),
    contextWindows: [],

    async checkAvailability() {
      if (envVar) return Boolean(getProviderApiKey(envVar));
      try {
        const res = await fetch(config.baseURL, { signal: AbortSignal.timeout(2000) });
        return res.ok || res.status === 401 || res.status === 403;
      } catch {
        return false;
      }
    },
  };
}
