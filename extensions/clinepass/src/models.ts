/**
 * Dynamic model discovery for Cline Free Models.
 *
 * Exclusively discovers and registers 100% FREE models from Cline's API,
 * filtering out all paid/subscription-only models.
 *
 * @module clinepass-models
 */

import { isRecord, stringValue, numberValue, booleanValue } from "./utils.js";
import { resolveApiBase } from "./env.js";
import { buildClineCliHeaders } from "./headers.js";

// ─── Model Definitions & Types ─────────────────────────────────────────────

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ThinkingLevelMap = Readonly<Record<ThinkingLevel, string | null>>;

/** Standard 5-level thinking map: Off, Low, Medium, High, Extra High. */
export const COMMON_THINKING_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

/** No configurable thinking levels. */
export const NO_THINKING_MAP: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
};

export interface ClinePassOpenAICompat {
  readonly supportsDeveloperRole: boolean;
  readonly supportsReasoningEffort: boolean;
  readonly thinkingFormat?: string;
}

export const CLINEPASS_OPENAI_COMPAT: ClinePassOpenAICompat = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
};

export interface ModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly ["text"];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap: ThinkingLevelMap;
  compat: ClinePassOpenAICompat;
}

export function getModelThinkingConfig(id: string): { reasoning: boolean; thinkingLevelMap: ThinkingLevelMap } {
  const lower = id.toLowerCase();
  if (lower.includes("union-alpha") || lower.includes("longcat") || lower.includes("gemma")) {
    return { reasoning: false, thinkingLevelMap: NO_THINKING_MAP };
  }
  if (
    lower.includes("deepseek") ||
    lower.includes("glm") ||
    lower.includes("laguna") ||
    lower.includes("muse-spark") ||
    lower.includes("solar") ||
    lower.includes("reasoning") ||
    lower.includes("r1")
  ) {
    return { reasoning: true, thinkingLevelMap: COMMON_THINKING_MAP };
  }
  return { reasoning: false, thinkingLevelMap: NO_THINKING_MAP };
}

// ─── Known Free Fallback Models ────────────────────────────────────────────

export const KNOWN_FREE_MODELS: readonly ModelConfig[] = [
  {
    id: "cline-free/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 921_600,
    maxTokens: 131_072,
    thinkingLevelMap: COMMON_THINKING_MAP,
    compat: CLINEPASS_OPENAI_COMPAT,
  },
  {
    id: "stealth/union-alpha",
    name: "Union Alpha",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    thinkingLevelMap: NO_THINKING_MAP,
    compat: {
      ...CLINEPASS_OPENAI_COMPAT,
      supportsReasoningEffort: false,
    },
  },
  {
    id: "cline-free/muse-spark-1.3-contributor",
    name: "Muse Spark 1.3 Contributor",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 921_600,
    maxTokens: 131_072,
    thinkingLevelMap: COMMON_THINKING_MAP,
    compat: CLINEPASS_OPENAI_COMPAT,
  },
  {
    id: "z-ai/glm-5.3-flash",
    name: "GLM-5.3-Flash",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    thinkingLevelMap: COMMON_THINKING_MAP,
    compat: CLINEPASS_OPENAI_COMPAT,
  },
  {
    id: "cline-free/solar-pro4",
    name: "Solar Pro 4",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 524_288,
    maxTokens: 131_072,
    thinkingLevelMap: COMMON_THINKING_MAP,
    compat: CLINEPASS_OPENAI_COMPAT,
  },
  {
    id: "poolside/laguna-s-2.1:free",
    name: "Laguna S 2.1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 131_072,
    thinkingLevelMap: COMMON_THINKING_MAP,
    compat: CLINEPASS_OPENAI_COMPAT,
  },
];

// ─── Dynamic Model Discovery (Free Only) ───────────────────────────────────

export const MODELS_ENDPOINT = "/api/v1/models";
export const MODELS_FETCH_TIMEOUT_MS = 6_000;

interface RawModelEntry {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  max_output_tokens?: unknown;
  max_tokens?: unknown;
  pricing?: unknown;
  reasoning?: unknown;
  supportsReasoningEffort?: unknown;
  reasoningEffortOptions?: unknown;
  free?: unknown;
  is_free?: unknown;
  tier?: unknown;
}

function toMicroPerToken(val: unknown, fallbackVal: number): number {
  const n = numberValue(val);
  return n != null ? n * 1_000_000 : fallbackVal;
}

/** The 6 official Cline Free tier models. */
export const CLINE_FREE_TARGET_IDS = new Set([
  "cline-free/deepseek-v4.1-flash",
  "stealth/union-alpha",
  "cline-free/muse-spark-1.3-contributor",
  "z-ai/glm-5.3-flash",
  "cline-free/solar-pro4",
  "poolside/laguna-s-2.1:free",
]);

export function isFreeModel(_raw: RawModelEntry, id: string): boolean {
  return CLINE_FREE_TARGET_IDS.has(id);
}

export function parseRemoteModel(raw: RawModelEntry): ModelConfig | undefined {
  const id = stringValue(raw.id);
  if (!id) return undefined;

  if (!isFreeModel(raw, id)) {
    return undefined;
  }

  const known = KNOWN_FREE_MODELS.find((m) => m.id === id);
  const thinkingConfig = known
    ? { reasoning: known.reasoning, thinkingLevelMap: known.thinkingLevelMap }
    : getModelThinkingConfig(id);

  const displayName = known?.name ?? stringValue(raw.display_name) ?? stringValue(raw.name) ?? id;
  const contextWindow =
    known?.contextWindow ??
    numberValue(raw.context_length) ??
    numberValue(raw.context_window) ??
    128_000;
  const maxTokens =
    known?.maxTokens ??
    numberValue(raw.max_output_tokens) ??
    numberValue(raw.max_tokens) ??
    8_192;

  const pricing = isRecord(raw.pricing) ? raw.pricing : undefined;
  const cost = known?.cost ?? {
    input: toMicroPerToken(pricing?.prompt, 0),
    output: toMicroPerToken(pricing?.completion, 0),
    cacheRead: toMicroPerToken(pricing?.cached_input, 0),
    cacheWrite: 0,
  };

  return {
    id,
    name: displayName,
    reasoning: thinkingConfig.reasoning,
    input: ["text"],
    cost,
    contextWindow,
    maxTokens,
    thinkingLevelMap: thinkingConfig.thinkingLevelMap,
    compat: {
      ...CLINEPASS_OPENAI_COMPAT,
      supportsReasoningEffort: thinkingConfig.reasoning,
    },
  };
}

export interface RemoteModelsOptions {
  apiBase?: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export async function fetchRemoteModels(
  options: RemoteModelsOptions = {},
): Promise<ModelConfig[] | undefined> {
  const apiBase = options.apiBase ?? resolveApiBase();
  const apiKey = options.apiKey;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? MODELS_FETCH_TIMEOUT_MS;

  if (!fetchFn) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      ...buildClineCliHeaders(),
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetchFn(`${apiBase}${MODELS_ENDPOINT}`, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) return undefined;

    const json: unknown = await response.json();
    const rawList: RawModelEntry[] = Array.isArray(json)
      ? json
      : isRecord(json) && Array.isArray(json.data)
        ? (json.data as RawModelEntry[])
        : [];

    if (rawList.length === 0) return undefined;

    const parsed = rawList.reduce<ModelConfig[]>((acc, raw) => {
      const model = parseRemoteModel(raw);
      if (model) acc.push(model);
      return acc;
    }, []);

    return parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveModels(
  apiKey?: string,
  options: RemoteModelsOptions = {},
): Promise<readonly ModelConfig[]> {
  try {
    const remote = await fetchRemoteModels({ ...options, apiKey });
    if (remote && remote.length > 0) {
      const map = new Map<string, ModelConfig>();
      for (const m of remote) {
        map.set(m.id, m);
      }
      for (const m of KNOWN_FREE_MODELS) {
        if (!map.has(m.id)) {
          map.set(m.id, m);
        }
      }
      return Array.from(map.values());
    }
  } catch {
    // ignore
  }
  return KNOWN_FREE_MODELS;
}

