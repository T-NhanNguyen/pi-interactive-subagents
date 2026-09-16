import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Subagent config file (`config.json` at the package root).
 *
 * The file holds two independent sections:
 *   - `status` — status-line rendering (parsed by status.ts);
 *   - `models` — optional model selection for sub-agents (parsed here).
 *
 * The `models` section is opt-in. When the key is absent, sub-agent models come
 * from the agent frontmatter exactly as before, so existing installations are
 * unaffected.
 *
 * This module also owns the shared config-file primitives — the validation
 * guard, the raw JSON reader, and the file paths — so status.ts and the models
 * parser cannot drift apart.
 */

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const SUBAGENT_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
export const SUBAGENT_CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");

/** Default source label used when a caller has no file path at hand. */
const DEFAULT_CONFIG_SOURCE = "config.json";

/** Indent width for the config file this extension writes back. */
const CONFIG_JSON_INDENT = 2;

/** Agent names this extension accepts as config keys. */
const AGENT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Keys that must never be written as agent names. */
const FORBIDDEN_AGENT_NAMES = ["__proto__", "constructor"];

/**
 * The literal that means "run this sub-agent on the parent session's active
 * model". Stored as-is in the loadout snapshot so a resume re-resolves it
 * against the parent session at resume time instead of freezing a model id.
 */
export const INHERIT_TOKEN = "inherit";

/** pi thinking levels, in ascending order. */
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVELS);

/** What to do when a configured model is not available in this pi install. */
export type ModelFallback = "default" | "inherit" | "fail";

export interface AgentModelConfig {
  /** A `provider/modelId` string, a bare `modelId`, or the inherit token. */
  model?: string;
  thinking?: ThinkingLevelName;
}

export interface ModelsConfig {
  /** Fallback model for every agent that has no per-agent entry. */
  default?: string;
  /** Fallback thinking level for every agent. */
  thinking?: ThinkingLevelName;
  /** Per-agent overrides, keyed by agent name. */
  agents: Record<string, AgentModelConfig>;
  /** Check the resolved model against the local catalogue. Defaults to true. */
  validate: boolean;
  /** What to do when validation fails. Defaults to `inherit`. */
  fallback: ModelFallback;
}

export interface SubagentConfig {
  /**
   * The parsed `models` section, or null when the key is absent. Null means
   * "no model configuration" — the resolution chain then behaves exactly as it
   * did before this section existed.
   */
  models: ModelsConfig | null;
}

/** One model the user can run, reduced to what resolution needs. */
export interface CatalogModel {
  provider: string;
  id: string;
  name?: string;
}

/** The live model environment of the session that is spawning a sub-agent. */
export interface ModelCatalog {
  /** Parent session's active model as `provider/id`, or null when unknown. */
  parentModel: string | null;
  /** Parent session's effective thinking level, or null when unknown. */
  parentThinking: string | null;
  /** Every model with resolved credentials, from the pi model registry. */
  available: readonly CatalogModel[];
}

export type ModelSource =
  | "param"
  | "config-agent"
  | "config-default"
  | "agent"
  | "snapshot"
  | "fallback"
  | "unset";

/** Display label per resolution source, used by `subagents_list` and warnings. */
const MODEL_SOURCE_LABELS: Record<ModelSource, string> = {
  param: "spawn param",
  "config-agent": "config agent",
  "config-default": "config default",
  agent: "agent file",
  snapshot: "snapshot",
  fallback: "fallback",
  unset: "unset",
};

export interface ResolvedModel {
  /**
   * Value persisted in the loadout snapshot: a literal `provider/id`, the
   * inherit token, or null when no model is configured.
   */
  token: string | null;
  /** Effective model for `--model` (no thinking suffix), or null to omit it. */
  command: string | null;
  /** Effective thinking level for the `model:level` suffix, or null. */
  thinking: string | null;
  /** Which source produced the token. */
  source: ModelSource;
  /** True when the token is the inherit token. */
  inherited: boolean;
  /** Set when the value had to be replaced or adjusted. */
  warning: string | null;
  /** Set when the model is unusable and the spawn must not continue. */
  error: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validation primitives bound to one config file and one config label, so
 * every section of the file rejects the same shapes and names the same file.
 */
export interface SubagentConfigGuard {
  invalid(message: string): never;
  isPlainObject(value: unknown): value is Record<string, unknown>;
  requireObject(value: unknown, fieldName: string): Record<string, unknown>;
  requireBoolean(value: unknown, fieldName: string): boolean;
  requireNonEmptyString(value: unknown, fieldName: string): string;
  rejectUnsupportedKeys(
    value: Record<string, unknown>,
    allowedKeys: readonly string[],
    fieldName: string,
  ): void;
}

/** Build the guard for one config file. `configLabel` names the section owner. */
export function createSubagentConfigGuard(
  source = DEFAULT_CONFIG_SOURCE,
  configLabel = "subagent",
): SubagentConfigGuard {
  const invalid = (message: string): never => {
    throw new Error(`Invalid ${configLabel} config in ${source}: ${message}`);
  };

  return {
    invalid,
    isPlainObject,
    requireObject(value, fieldName) {
      if (!isPlainObject(value)) invalid(`${fieldName} must be an object`);
      return value;
    },
    requireBoolean(value, fieldName) {
      if (typeof value !== "boolean") invalid(`${fieldName} must be a boolean`);
      return value;
    },
    requireNonEmptyString(value, fieldName) {
      if (typeof value !== "string" || value.trim().length === 0) {
        invalid(`${fieldName} must be a non-empty string`);
      }
      return value.trim();
    },
    rejectUnsupportedKeys(value, allowedKeys, fieldName) {
      const unsupported = Object.keys(value).filter((key) => !allowedKeys.includes(key));
      if (unsupported.length > 0) {
        invalid(`${fieldName} has unsupported key(s): ${unsupported.join(", ")}`);
      }
    },
  };
}

/** Parse config JSON, naming the offending file on failure. */
export function parseSubagentConfigJson(rawConfig: string, sourcePath: string): unknown {
  try {
    return JSON.parse(rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
  }
}

/**
 * Read the raw config text, preferring `config.json` over the shipped example.
 * Returns null when neither file exists.
 */
export function readSubagentConfigFile(
  configPath = SUBAGENT_CONFIG_PATH,
  examplePath = SUBAGENT_CONFIG_EXAMPLE_PATH,
): { sourcePath: string; rawConfig: string } | null {
  try {
    return { sourcePath: configPath, rawConfig: readFileSync(configPath, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    return { sourcePath: examplePath, rawConfig: readFileSync(examplePath, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseThinkingLevel(
  guard: SubagentConfigGuard,
  value: unknown,
  fieldName: string,
): ThinkingLevelName {
  if (typeof value !== "string" || !THINKING_LEVEL_SET.has(value)) {
    guard.invalid(`${fieldName} must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return value as ThinkingLevelName;
}

function parseAgentModelConfig(
  guard: SubagentConfigGuard,
  value: unknown,
  fieldName: string,
): AgentModelConfig {
  const entry = guard.requireObject(value, fieldName);
  guard.rejectUnsupportedKeys(entry, ["model", "thinking"], fieldName);

  const parsed: AgentModelConfig = {};
  if (entry.model !== undefined) {
    parsed.model = guard.requireNonEmptyString(entry.model, `${fieldName}.model`);
  }
  if (entry.thinking !== undefined) {
    parsed.thinking = parseThinkingLevel(guard, entry.thinking, `${fieldName}.thinking`);
  }
  return parsed;
}

/**
 * Parse the `models` section. Returns null when the key is absent, which is the
 * signal that no model configuration exists and resolution must stay inert.
 */
export function parseSubagentConfig(rawConfig: unknown, source = DEFAULT_CONFIG_SOURCE): SubagentConfig {
  const guard = createSubagentConfigGuard(source);
  const config = guard.requireObject(rawConfig, "root");
  if (config.models === undefined) return { models: null };

  const models = guard.requireObject(config.models, "models");
  guard.rejectUnsupportedKeys(
    models,
    ["default", "thinking", "agents", "validate", "fallback"],
    "models",
  );

  const parsed: ModelsConfig = {
    agents: {},
    validate: true,
    fallback: "inherit",
  };

  if (models.default !== undefined) {
    parsed.default = guard.requireNonEmptyString(models.default, "models.default");
  }
  if (models.thinking !== undefined) {
    parsed.thinking = parseThinkingLevel(guard, models.thinking, "models.thinking");
  }
  if (models.validate !== undefined) {
    parsed.validate = guard.requireBoolean(models.validate, "models.validate");
  }
  if (models.fallback !== undefined) {
    if (models.fallback !== "default" && models.fallback !== "inherit" && models.fallback !== "fail") {
      guard.invalid("models.fallback must be one of: default, inherit, fail");
    }
    parsed.fallback = models.fallback;
  }
  if (models.agents !== undefined) {
    const agents = guard.requireObject(models.agents, "models.agents");
    for (const [name, entry] of Object.entries(agents)) {
      if (FORBIDDEN_AGENT_NAMES.includes(name)) {
        guard.invalid(`models.agents has unsupported key: ${name}`);
      }
      parsed.agents[name] = parseAgentModelConfig(guard, entry, `models.agents.${name}`);
    }
  }

  return { models: parsed };
}

/**
 * Load the sub-agent config. A missing file is not an error — it just means no
 * model configuration, which is the default state for every installation.
 */
export function loadSubagentConfig(
  configPath = SUBAGENT_CONFIG_PATH,
  examplePath = SUBAGENT_CONFIG_EXAMPLE_PATH,
): SubagentConfig {
  const read = readSubagentConfigFile(configPath, examplePath);
  if (!read) return { models: null };
  return parseSubagentConfig(
    parseSubagentConfigJson(read.rawConfig, read.sourcePath),
    read.sourcePath,
  );
}

/**
 * Split a `provider/modelId:level` string into its model part and its optional
 * thinking level. Only a recognised thinking level is treated as a suffix, so
 * model ids that contain a colon (e.g. OpenRouter `:batch` variants) survive.
 */
export function parseModelToken(token: string): {
  base: string;
  thinking: ThinkingLevelName | null;
} {
  const trimmed = token.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0) {
    const suffix = trimmed.slice(colon + 1);
    if (THINKING_LEVEL_SET.has(suffix)) {
      return { base: trimmed.slice(0, colon), thinking: suffix as ThinkingLevelName };
    }
  }
  return { base: trimmed, thinking: null };
}

/** True when `base` matches an available model by `provider/id` or bare id. */
export function isModelAvailable(base: string, available: readonly CatalogModel[]): boolean {
  const needle = base.toLowerCase();
  return available.some(
    (model) => model.id.toLowerCase() === needle || `${model.provider}/${model.id}`.toLowerCase() === needle,
  );
}

/** Human label for a resolution source, for `subagents_list` and warnings. */
export function formatModelSource(source: ModelSource): string {
  return MODEL_SOURCE_LABELS[source];
}

interface ResolveInput {
  token: string | null;
  source: ModelSource;
  agentName: string | null;
  thinking: string | null;
  config: SubagentConfig;
  catalog: ModelCatalog;
}

/**
 * Turn a model token into an effective model, applying validation and the
 * fallback ladder when the token is not available in this pi installation.
 */
function resolveModelToken(input: ResolveInput): ResolvedModel {
  const models = input.config.models;
  const baseThinking = input.thinking;

  const attempt = (token: string | null, source: ModelSource): ResolvedModel | null => {
    if (!token) {
      return {
        token: null,
        command: null,
        thinking: baseThinking,
        source: "unset",
        inherited: false,
        warning: null,
        error: null,
      };
    }

    const parsed = parseModelToken(token);
    const thinking = parsed.thinking ?? baseThinking;

    if (token === INHERIT_TOKEN) {
      if (!input.catalog.parentModel) return null;
      return {
        token,
        command: input.catalog.parentModel,
        thinking: thinking ?? input.catalog.parentThinking,
        source,
        inherited: true,
        warning: null,
        error: null,
      };
    }

    // An empty catalogue means the model environment is unknown (no registry
    // available), not that nothing is installed. Skip validation rather than
    // rejecting every configured model.
    const validating = models?.validate === true && input.catalog.available.length > 0;
    if (!validating || isModelAvailable(parsed.base, input.catalog.available)) {
      return {
        token,
        command: parsed.base,
        thinking,
        source,
        inherited: false,
        warning: null,
        error: null,
      };
    }

    return null;
  };

  const primary = attempt(input.token, input.source);
  if (primary) return primary;

  const label = formatModelSource(input.source);
  const reason =
    input.token === INHERIT_TOKEN
      ? `No active model to inherit from (source: ${label}).`
      : `Model "${input.token}" (source: ${label}) is not available in this pi installation.`;

  if (!models) {
    return {
      token: input.token,
      command: null,
      thinking: baseThinking,
      source: input.source,
      inherited: false,
      warning: reason,
      error: null,
    };
  }

  if (models.fallback === "fail") {
    return {
      token: input.token,
      command: null,
      thinking: baseThinking,
      source: input.source,
      inherited: false,
      warning: null,
      error: `${reason} Set "models.fallback" to "default" or "inherit", or pick an available model with /subagent-model.`,
    };
  }

  const ladder: Array<string | undefined> =
    models.fallback === "default" ? [models.default, INHERIT_TOKEN] : [INHERIT_TOKEN];

  for (const candidate of ladder) {
    if (!candidate || candidate === input.token) continue;
    const resolved = attempt(candidate, "fallback");
    if (resolved) {
      resolved.warning = `${reason} Falling back to "${candidate}".`;
      return resolved;
    }
  }

  return {
    token: input.token,
    command: null,
    thinking: baseThinking,
    source: input.source,
    inherited: false,
    warning: null,
    error: `${reason} No fallback model was usable.`,
  };
}

/** Pick the configured token and thinking level by precedence, then resolve. */
export function resolveSubagentModel(input: {
  param: string | null;
  agentName: string | null;
  agentModel: string | null;
  agentThinking: string | null;
  config: SubagentConfig;
  catalog: ModelCatalog;
}): ResolvedModel {
  const models = input.config.models;
  const agentEntry = input.agentName ? models?.agents[input.agentName] : undefined;

  const thinking = agentEntry?.thinking ?? models?.thinking ?? input.agentThinking ?? null;

  if (input.param) {
    return resolveModelToken({ ...input, token: input.param, source: "param", thinking });
  }
  if (agentEntry?.model) {
    return resolveModelToken({ ...input, token: agentEntry.model, source: "config-agent", thinking });
  }
  if (models?.default) {
    return resolveModelToken({ ...input, token: models.default, source: "config-default", thinking });
  }
  if (input.agentModel) {
    return resolveModelToken({ ...input, token: input.agentModel, source: "agent", thinking });
  }
  return resolveModelToken({ ...input, token: null, source: "unset", thinking });
}

/**
 * Re-resolve a model recorded in a loadout snapshot.
 *
 * A literal model is replayed as-is (subject to validation). The inherit token
 * is resolved against the parent session that is resuming the sub-agent, which
 * is the whole point of storing the token rather than a frozen model id.
 */
export function resolveLoadoutModel(input: {
  loadout: { model: string | null; thinking: string | null; agent: string | null };
  config: SubagentConfig;
  catalog: ModelCatalog;
}): ResolvedModel {
  return resolveModelToken({
    token: input.loadout.model,
    source: "snapshot",
    agentName: input.loadout.agent,
    thinking: input.loadout.thinking,
    config: input.config,
    catalog: input.catalog,
  });
}

/**
 * Write one model selection into `config.json`, preserving every other key.
 * Passing a null value removes the entry, which restores the agent's own
 * frontmatter model.
 *
 * Creates `config.json` from `config.json.example` when it does not exist yet.
 * An existing entry of the wrong shape is replaced rather than rejected, so a
 * shorthand value such as `"scout": "inherit"` can be repaired from the picker.
 * Returns `changed: false` when the request would not alter the file, so a
 * reset never creates or rewrites a config that has nothing to remove.
 */
export function writeModelSelection(opts: {
  agentName: string | null;
  value: string | null;
  configPath?: string;
  examplePath?: string;
}): { path: string; changed: boolean } {
  const configPath = opts.configPath ?? SUBAGENT_CONFIG_PATH;
  const examplePath = opts.examplePath ?? SUBAGENT_CONFIG_EXAMPLE_PATH;

  if (opts.agentName && !AGENT_NAME_PATTERN.test(opts.agentName)) {
    throw new Error(`Refusing to write model selection for unsafe agent name "${opts.agentName}"`);
  }

  if (opts.value === null && !existsSync(configPath)) {
    return { path: configPath, changed: false };
  }

  const read = readSubagentConfigFile(configPath, examplePath);
  const guard = createSubagentConfigGuard(read?.sourcePath ?? configPath);

  let root: Record<string, unknown> = {};
  if (read) {
    root = guard.requireObject(parseSubagentConfigJson(read.rawConfig, read.sourcePath), "root");
  }

  const models =
    root.models === undefined ? {} : guard.requireObject(root.models, "models");

  if (opts.agentName) {
    const agents =
      models.agents === undefined ? {} : guard.requireObject(models.agents, "models.agents");
    const currentEntry = agents[opts.agentName];

    if (opts.value === null && currentEntry === undefined) {
      return { path: configPath, changed: false };
    }

    if (opts.value === null) {
      delete agents[opts.agentName];
    } else {
      const entry = guard.isPlainObject(currentEntry) ? { ...currentEntry } : {};
      entry.model = opts.value;
      agents[opts.agentName] = entry;
    }
    models.agents = agents;
  } else if (opts.value === null) {
    if (models.default === undefined) return { path: configPath, changed: false };
    delete models.default;
  } else {
    models.default = opts.value;
  }

  root.models = models;
  writeFileSync(configPath, `${JSON.stringify(root, null, CONFIG_JSON_INDENT)}\n`, "utf8");
  return { path: configPath, changed: true };
}
