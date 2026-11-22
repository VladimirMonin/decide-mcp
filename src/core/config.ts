import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  MODEL_ALIASES,
  PROVIDER_NAMES,
  type ModelAlias,
  type ProviderName,
} from "./types.js";

const DEFAULT_POLZA_BASE_URL = "https://polza.ai/api/v1";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const rawConfigSchema = z.object({
  DECIDE_PROVIDER: z.enum(PROVIDER_NAMES).default("polza"),
  POLZA_API_KEY: z.string().trim().min(1).optional(),
  OPENROUTER_API_KEY: z.string().trim().min(1).optional(),
  POLZA_BASE_URL: z.string().url().default(DEFAULT_POLZA_BASE_URL),
  OPENROUTER_BASE_URL: z.string().url().default(DEFAULT_OPENROUTER_BASE_URL),
  DECIDE_DEFAULT_MODEL: z.enum(MODEL_ALIASES).default("jev"),
  DECIDE_DB_PATH: z.string().trim().min(1).default(".decide-mcp/runs.sqlite"),
  DECIDE_ALLOWED_ROOT: z.string().trim().min(1).default("."),
  DECIDE_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  DECIDE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
});

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export interface ProviderConfig {
  name: ProviderName;
  apiKey: string;
  baseUrl: string;
  decisionsUrl: string;
  catalogUrl: string;
}

export interface AppConfig {
  provider: ProviderConfig;
  defaultModel: ModelAlias;
  dbPath: string;
  allowedRoot: string;
  maxConcurrency: number;
  timeoutMs: number;
}

export interface ConfigSummary {
  provider: ProviderName;
  baseUrl: string;
  defaultModel: ModelAlias;
  dbPath: string;
  allowedRoot: string;
  maxConcurrency: number;
  timeoutMs: number;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "env";
      return `${field}: ${issue.message}`;
    })
    .join("; ");
}

function joinUrl(baseUrl: string, suffix: string): string {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(suffix, normalized).toString();
}

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = rawConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Некорректная конфигурация: ${formatIssues(parsed.error)}`);
  }

  const data = parsed.data;
  const providerName = data.DECIDE_PROVIDER;
  const apiKey =
    providerName === "polza" ? data.POLZA_API_KEY : data.OPENROUTER_API_KEY;
  if (!apiKey) {
    const keyName = providerName === "polza" ? "POLZA_API_KEY" : "OPENROUTER_API_KEY";
    throw new ConfigError(
      `Для DECIDE_PROVIDER=${providerName} не задан ${keyName}. Добавьте ключ в .env.`,
    );
  }

  const baseUrl =
    providerName === "polza" ? data.POLZA_BASE_URL : data.OPENROUTER_BASE_URL;
  const catalogUrl =
    providerName === "polza"
      ? joinUrl(baseUrl, "models/catalog")
      : joinUrl(baseUrl, "models?output_modalities=decisions");

  return {
    provider: {
      name: providerName,
      apiKey,
      baseUrl,
      decisionsUrl: joinUrl(baseUrl, "systemone"),
      catalogUrl,
    },
    defaultModel: data.DECIDE_DEFAULT_MODEL,
    dbPath: data.DECIDE_DB_PATH,
    allowedRoot: data.DECIDE_ALLOWED_ROOT,
    maxConcurrency: data.DECIDE_MAX_CONCURRENCY,
    timeoutMs: data.DECIDE_TIMEOUT_MS,
  };
}

/** Summary without the API key; safe to print and log. */
export function describeConfig(config: AppConfig): ConfigSummary {
  return {
    provider: config.provider.name,
    baseUrl: config.provider.baseUrl,
    defaultModel: config.defaultModel,
    dbPath: config.dbPath,
    allowedRoot: config.allowedRoot,
    maxConcurrency: config.maxConcurrency,
    timeoutMs: config.timeoutMs,
  };
}

export function projectRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

export function defaultEnvPath(): string {
  return path.join(projectRoot(), ".env");
}

/** Loads .env without overriding variables that are already set. */
export function loadEnvFile(envFile: string = defaultEnvPath()): boolean {
  if (!existsSync(envFile)) return false;
  try {
    process.loadEnvFile(envFile);
    return true;
  } catch (error) {
    throw new ConfigError(
      `Не удалось прочитать ${envFile}: ${(error as Error).message}`,
    );
  }
}

export interface LoadConfigOptions {
  envFile?: string;
  env?: NodeJS.ProcessEnv;
  loadEnv?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  if (options.loadEnv !== false) loadEnvFile(options.envFile);
  return parseConfig(options.env ?? process.env);
}
