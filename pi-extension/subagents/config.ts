import { readFileSync, writeFileSync } from "node:fs";
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
 */

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const SUBAGENT_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
export const SUBAGENT_CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");

/**
 * The literal that means "run this sub-agent on the parent session's active
 * model". Stored as-is in the loadout snapshot so a resume re-resolves it
 * against the parent session at resume time instead of freezing a model id.
 */
export const INHERIT_TOKEN = "inherit";

/** pi thinking levels, in ascending order. */
export const THINKING_LEVELS = [
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

function invalidConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent config in ${source}: ${message}`);
}

function requireObject(value: unknown, source: string, fieldName: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    invalidConfig(source, `${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnsupportedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  source: string,
  fieldName: string,
): void {
  const unsupported = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unsupported.length > 0) {
    invalidConfig(source, `${fieldName} has unsupported key(s): ${unsupported.join(", ")}`);
  }
}

function requireNonEmptyString(value: unknown, source: string, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidConfig(source, `${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function requireThinkingLevel(value: unknown, source: string, fieldName: string): ThinkingLevelName {
  if (typeof value !== "string" || !THINKING_LEVEL_SET.has(value)) {
    invalidConfig(
      source,
      `${fieldName} must be one of: ${THINKING_LEVELS.join(", ")}`,
    );
  }
  return value as ThinkingLevelName;
}

function parseAgentModelConfig(
  value: unknown,
  source: string,
  fieldName: string,
): AgentModelConfig {
  const entry = requireObject(value, source, fieldName);
  rejectUnsupportedKeys(entry, ["model", "thinking"], source, fieldName);

  const parsed: AgentModelConfig = {};
  if (entry.model !== undefined) {
    parsed.model = requireNonEmptyString(entry.model, source, `${fieldName}.model`);
  }
  if (entry.thinking !== undefined) {
    parsed.thinking = requireThinkingLevel(entry.thinking, source, `${fieldName}.thinking`);
  }
  return parsed;
}

/**
 * Parse the `models` section. Returns null when the key is absent, which is the
 * signal that no model configuration exists and resolution must stay inert.
 */
export function parseSubagentConfig(rawConfig: unknown, source = "config.json"): SubagentConfig {
  const config = requireObject(rawConfig, source, "root");
  if (config.models === undefined) return { models: null };

  const models = requireObject(config.models, source, "models");
  rejectUnsupportedKeys(
    models,
    ["default", "thinking", "agents", "validate", "fallback"],
    source,
    "models",
  );

  const parsed: ModelsConfig = {
    agents: {},
    validate: true,
    fallback: "inherit",
  };

  if (models.default !== undefined) {
    parsed.default = requireNonEmptyString(models.default, source, "models.default");
  }
  if (models.thinking !== undefined) {
    parsed.thinking = requireThinkingLevel(models.thinking, source, "models.thinking");
  }
  if (models.validate !== undefined) {
    if (typeof models.validate !== "boolean") {
      invalidConfig(source, "models.validate must be a boolean");
    }
    parsed.validate = models.validate;
  }
  if (models.fallback !== undefined) {
    if (models.fallback !== "default" && models.fallback !== "inherit" && models.fallback !== "fail") {
      invalidConfig(source, "models.fallback must be one of: default, inherit, fail");
    }
    parsed.fallback = models.fallback;
  }
  if (models.agents !== undefined) {
    const agents = requireObject(models.agents, source, "models.agents");
    for (const [name, entry] of Object.entries(agents)) {
      if (name === "__proto__" || name === "constructor") {
        invalidConfig(source, `models.agents has unsupported key: ${name}`);
      }
      parsed.agents[name] = parseAgentModelConfig(entry, source, `models.agents.${name}`);
    }
  }

  return { models: parsed };
}

/** Read the raw config text, preferring `config.json` over the shipped example. */
export function readSubagentConfigText(
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

/**
 * Load the sub-agent config. A missing file is not an error — it just means no
 * model configuration, which is the default state for every installation.
 */
export function loadSubagentConfig(
  configPath = SUBAGENT_CONFIG_PATH,
  examplePath = SUBAGENT_CONFIG_EXAMPLE_PATH,
): SubagentConfig {
  const read = readSubagentConfigText(configPath, examplePath);
  if (!read) return { models: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${read.sourcePath}: ${detail}`);
  }

  return parseSubagentConfig(parsed, read.sourcePath);
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
  switch (source) {
    case "param":
      return "spawn param";
    case "config-agent":
      return "config agent";
    case "config-default":
      return "config default";
    case "agent":
      return "agent file";
    case "snapshot":
      return "snapshot";
    case "fallback":
      return "fallback";
    case "unset":
      return "unset";
  }
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
export function resolveModelToken(input: ResolveInput): ResolvedModel {
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
 */
export function writeModelSelection(opts: {
  agentName: string | null;
  value: string | null;
  configPath?: string;
  examplePath?: string;
}): { path: string } {
  const configPath = opts.configPath ?? SUBAGENT_CONFIG_PATH;
  const examplePath = opts.examplePath ?? SUBAGENT_CONFIG_EXAMPLE_PATH;

  if (opts.agentName && !/^[A-Za-z0-9._-]+$/.test(opts.agentName)) {
    throw new Error(`Refusing to write model selection for unsafe agent name "${opts.agentName}"`);
  }

  const read = readSubagentConfigText(configPath, examplePath);
  let root: Record<string, unknown> = {};
  if (read) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.rawConfig) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot update ${read.sourcePath}: ${detail}`);
    }
    root = requireObject(parsed, read.sourcePath, "root");
  }

  const existingModels = root.models;
  if (existingModels !== undefined) {
    requireObject(existingModels, "config", "models");
  }
  const models = (existingModels as Record<string, unknown> | undefined) ?? {};
  root.models = models;

  if (opts.agentName) {
    const existingAgents = models.agents;
    if (existingAgents !== undefined) {
      requireObject(existingAgents, "config", "models.agents");
    }
    const agents = (existingAgents as Record<string, unknown> | undefined) ?? {};
    models.agents = agents;

    if (opts.value === null) {
      delete agents[opts.agentName];
    } else {
      const entry = (agents[opts.agentName] as Record<string, unknown> | undefined) ?? {};
      entry.model = opts.value;
      agents[opts.agentName] = entry;
    }
  } else if (opts.value === null) {
    delete models.default;
  } else {
    models.default = opts.value;
  }

  writeFileSync(configPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  return { path: configPath };
}
