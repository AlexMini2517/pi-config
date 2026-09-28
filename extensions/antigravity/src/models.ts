/**
 * Dynamic model discovery for Google Antigravity.
 *
 * Runs `agy models` to discover available models, then consolidates
 * reasoning-level variants (e.g. gemini-3.8-flash-{high,medium,low})
 * into a single base model with a thinkingLevelMap for Pi's picker.
 *
 * Model capabilities (contextWindow, maxTokens) are inferred from the
 * model ID pattern since agy's CLI output doesn't include them.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AntigravityModelConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_ANTIGRAVITY_MODEL = "gemini-3.8-flash";

// Reasoning levels that agy uses as model ID suffixes
const REASONING_SUFFIXES = ["-high", "-medium", "-low"] as const;

const FALLBACK_REASONING_BASES = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.1-pro",
];

/**
 * Tracks which base model IDs were consolidated from reasoning variants.
 * Updated by discoverModelsFromAgy(); used by resolveAgyModelId() to
 * map Pi's base ID back to the actual agy model ID at spawn time.
 */
const reasoningBases = new Set<string>(FALLBACK_REASONING_BASES);

function resolveDefaultBinary(): string {
  if (process.env.AGY_PATH && fs.existsSync(process.env.AGY_PATH)) {
    return process.env.AGY_PATH;
  }
  const userHome = os.homedir();
  const defaultWin = path.join(userHome, ".gemini", "bin", "agy.exe");
  if (process.platform === "win32" && fs.existsSync(defaultWin)) {
    return defaultWin;
  }
  const defaultUnix = path.join(userHome, ".gemini", "bin", "agy");
  if (process.platform !== "win32" && fs.existsSync(defaultUnix)) {
    return defaultUnix;
  }
  return "agy";
}

/**
 * Resolves the actual agy CLI model ID from Pi's base model ID + reasoning level.
 * For consolidated models: "gemini-3.8-flash" + "high" → "gemini-3.8-flash-high"
 * For everything else: returns as-is.
 */
export function resolveAgyModelId(modelId: string, reasoning?: string): string {
  if (reasoningBases.has(modelId)) {
    const level = reasoning && reasoning !== "off" ? reasoning : "low";
    return `${modelId}-${level}`;
  }
  return modelId;
}

// ── Capability inference from model ID patterns ─────────────────────

function inferContextWindow(id: string): number {
  if (id.includes("pro")) return 2_097_152;
  if (id.includes("claude")) return 200_000;
  if (id.includes("gpt")) return 128_000;
  return 1_048_576;
}

function inferMaxTokens(id: string): number {
  if (id.includes("claude")) return 32_768;
  if (id.includes("gpt")) return 16_384;
  return 65_536;
}

// ── Parsing and consolidation ───────────────────────────────────────

interface RawAgyModel {
  id: string;
  displayName: string;
}

function parseAgyModelsOutput(stdout: string): RawAgyModel[] {
  return stdout
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0 && !l.startsWith("Fetching"))
    .map((line) => {
      const parts = line.split(/\t+|\s{2,}/);
      const id = parts[0]?.trim();
      const displayName = parts[1]?.trim() || id || "";
      return id ? { id, displayName } : null;
    })
    .filter((m): m is RawAgyModel => m !== null);
}

function extractReasoningLevel(id: string): { base: string; level: string } | null {
  for (const suffix of REASONING_SUFFIXES) {
    if (id.endsWith(suffix)) {
      return { base: id.slice(0, -suffix.length), level: suffix.slice(1) };
    }
  }
  return null;
}

/**
 * Consolidates raw agy models into Pi-compatible entries.
 * - Groups models sharing a base with ≥2 reasoning-level suffixes into one
 *   entry with a thinkingLevelMap (e.g. gemini-3.8-flash).
 * - Single-variant or non-suffixed models are registered standalone with
 *   reasoning: false (no thinking picker — they always-think or don't).
 */
function consolidateModels(raw: RawAgyModel[]): AntigravityModelConfig[] {
  // 1. Attempt to group by reasoning suffix
  const groups = new Map<string, { levels: Map<string, string>; displayName: string }>();
  const standalone: RawAgyModel[] = [];

  for (const model of raw) {
    const extracted = extractReasoningLevel(model.id);
    if (extracted) {
      const existing = groups.get(extracted.base);
      if (existing) {
        existing.levels.set(extracted.level, model.id);
      } else {
        // Strip "(High)" / "(Medium)" / "(Low)" from display name to get base name
        const baseName = model.displayName.replace(/\s*\((?:High|Medium|Low)\)\s*$/i, "").trim();
        groups.set(extracted.base, {
          levels: new Map([[extracted.level, model.id]]),
          displayName: baseName || extracted.base,
        });
      }
    } else {
      standalone.push(model);
    }
  }

  const result: AntigravityModelConfig[] = [];

  // 2. Process grouped models — consolidate only when ≥2 variants exist
  for (const [base, group] of groups) {
    if (group.levels.size >= 2) {
      reasoningBases.add(base);
      const thinkingLevelMap: Record<string, string | null> = {
        off: null,
        minimal: null,
      };
      for (const level of ["low", "medium", "high"]) {
        thinkingLevelMap[level] = group.levels.has(level) ? level : null;
      }
      result.push({
        id: base,
        name: group.displayName,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: inferContextWindow(base),
        maxTokens: inferMaxTokens(base),
        thinkingLevelMap,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
      });
    } else {
      // Single variant — register with full agy ID as-is
      const [level] = [...group.levels.keys()];
      const cap = level.charAt(0).toUpperCase() + level.slice(1);
      standalone.push({
        id: [...group.levels.values()][0],
        displayName: `${group.displayName} (${cap})`,
      });
    }
  }

  // 3. Standalone models — no thinking level picker
  for (const model of standalone) {
    result.push({
      id: model.id,
      name: model.displayName,
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: inferContextWindow(model.id),
      maxTokens: inferMaxTokens(model.id),
      compat: { supportsDeveloperRole: false },
    });
  }

  return result;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Discovers models by running `agy models`.
 * Returns consolidated models ready for Pi's provider config.
 * Returns empty array on failure (caller decides fallback).
 */
export async function discoverModelsFromAgy(
  binaryPath?: string
): Promise<AntigravityModelConfig[]> {
  const binary = binaryPath || resolveDefaultBinary();
  try {
    const { stdout } = await execFileAsync(binary, ["models"], {
      timeout: 8000,
      windowsHide: true,
    });
    const raw = parseAgyModelsOutput(stdout);
    if (raw.length === 0) return [];

    // Clear stale bases before re-consolidating
    reasoningBases.clear();
    return consolidateModels(raw);
  } catch {
    return [];
  }
}

/**
 * Known fallback models in case `agy models` cannot be reached or fails.
 */
export const KNOWN_ANTIGRAVITY_MODELS: readonly AntigravityModelConfig[] = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
    },
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
    },
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
    },
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 2_097_152,
    maxTokens: 65_536,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
    },
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_768,
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_768,
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: { supportsDeveloperRole: false },
  },
];

/**
 * Resolves models for the Antigravity provider in Pi.
 * Tries dynamic discovery via `agy models`, falling back to KNOWN_ANTIGRAVITY_MODELS.
 */
export async function resolveAntigravityModels(
  binaryPath?: string
): Promise<AntigravityModelConfig[]> {
  const discovered = await discoverModelsFromAgy(binaryPath);
  if (discovered.length > 0) {
    return discovered;
  }

  // Populate reasoning bases for the static fallback models
  for (const base of FALLBACK_REASONING_BASES) {
    reasoningBases.add(base);
  }
  return [...KNOWN_ANTIGRAVITY_MODELS];
}

