import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  describeConfig,
  loadEnvFile,
  parseConfig,
  type AppConfig,
} from "../core/config.js";
import { getModel, listModels } from "../core/registry.js";
import {
  MODEL_ALIASES,
  PROVIDER_NAMES,
  type ModelAlias,
  type ProviderName,
} from "../core/types.js";

export const SMOKE_STATE = [
  "## Данные",
  '[ITEM id="i1"]function add(a, b) { return a + b; }[/ITEM]',
].join("\n");

/**
 * Поля провайдера /api/v1/systemone: choice и score принимают `criteria`,
 * а не внутренние `options` / `levels`. Адаптер ядра будет переводить их.
 */
export const SMOKE_QUESTIONS = {
  has_function: {
    type: "noul",
    instructions: "Содержит ли фрагмент объявление функции?",
  },
  language: {
    type: "choice",
    instructions: "На каком языке написан фрагмент?",
    criteria: { js: "JavaScript", python: "Python", other: "Другой язык" },
  },
  quality: {
    type: "score",
    instructions: "Насколько код понятен?",
    criteria: ["плохо", "средне", "хорошо"],
  },
} as const;

export function buildSmokeRequest(model: string): {
  model: string;
  state: string;
  questions: typeof SMOKE_QUESTIONS;
} {
  return { model, state: SMOKE_STATE, questions: SMOKE_QUESTIONS };
}

export interface SmokeChecks {
  shape: boolean;
  noul: boolean;
  choice: boolean;
  score: boolean;
  usage: boolean;
}

export interface SmokeUsage {
  inputTokens: number;
  outputTokens: number;
  costRub: number | null;
}

export interface SmokeValidation {
  ok: boolean;
  checks: SmokeChecks;
  responseModel: string | null;
  usage: SmokeUsage | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function validateSmokeResponse(raw: unknown): SmokeValidation {
  const root = asRecord(raw);
  const answers = root ? asRecord(root.answers) : null;
  const usage = root ? asRecord(root.usage) : null;
  const hasFunction = answers ? asRecord(answers["has_function"]) : null;
  const language = answers ? asRecord(answers["language"]) : null;
  const quality = answers ? asRecord(answers["quality"]) : null;

  const noul = hasFunction ? asNumber(hasFunction["noul"]) : null;
  const choice =
    language && typeof language["choice"] === "string"
      ? language["choice"]
      : null;
  const languageProbabilities = language
    ? asRecord(language["probabilities"])
    : null;
  const score = quality ? asNumber(quality["score"]) : null;
  const qualityProbabilities = quality
    ? asRecord(quality["probabilities"])
    : null;

  const inputTokens = usage ? asNumber(usage["input_tokens"]) : null;
  const outputTokens = usage ? asNumber(usage["output_tokens"]) : null;
  const costRub = usage ? asNumber(usage["cost_rub"]) : null;

  const checks: SmokeChecks = {
    shape:
      root !== null &&
      typeof root["model"] === "string" &&
      answers !== null &&
      usage !== null,
    noul:
      hasFunction?.["type"] === "noul" &&
      noul !== null &&
      noul >= 0 &&
      noul <= 1,
    choice:
      language?.["type"] === "choice" &&
      choice !== null &&
      languageProbabilities !== null &&
      choice in languageProbabilities,
    score:
      quality?.["type"] === "score" &&
      score !== null &&
      score >= 0 &&
      score <= 2 &&
      qualityProbabilities !== null,
    usage: inputTokens !== null && outputTokens !== null,
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    responseModel:
      root && typeof root["model"] === "string" ? root["model"] : null,
    usage:
      inputTokens !== null && outputTokens !== null
        ? { inputTokens, outputTokens, costRub }
        : null,
  };
}

async function fetchJson(
  url: string,
  apiKey: string,
  timeoutMs: number,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(url, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, text: await response.text() };
}

function errorSnippet(text: string): string {
  try {
    const root = asRecord(JSON.parse(text));
    const error = root ? asRecord(root["error"]) : null;
    if (error) {
      const code = typeof error["code"] === "string" ? error["code"] : "ERROR";
      const message =
        typeof error["message"] === "string" ? error["message"] : "";
      return `${code}: ${message}`.trim();
    }
  } catch {
    // not JSON
  }
  return text.slice(0, 300);
}

function failedChecks(checks: SmokeChecks): string {
  return Object.entries(checks)
    .filter(([, value]) => !value)
    .map(([name]) => name)
    .join(", ");
}

interface CatalogModel {
  id: string | null;
  contextLength: number | null;
  type: string | null;
}

function toCatalogModels(items: unknown[]): CatalogModel[] {
  return items.map((item) => {
    const record = asRecord(item);
    return {
      id: record && typeof record["id"] === "string" ? record["id"] : null,
      contextLength:
        record && typeof record["context_length"] === "number"
          ? record["context_length"]
          : null,
      type: record && typeof record["type"] === "string" ? record["type"] : null,
    };
  });
}

function isDecisionModel(item: unknown): boolean {
  const record = asRecord(item);
  if (!record) return false;
  if (record["type"] === "classification") return true;
  const endpoints = record["endpoints"];
  return Array.isArray(endpoints) && endpoints.includes("/api/v1/systemone");
}

/**
 * Polza отдаёт каталог страницами; поиск по имени не находит typesafe/jev,
 * поэтому тянем весь каталог и фильтруем по decision-эндпоинту.
 */
async function fetchDecisionCatalog(
  config: AppConfig,
): Promise<{ models: CatalogModel[]; raw: unknown; url: string }> {
  if (config.provider.name === "openrouter") {
    const url = config.provider.catalogUrl;
    const response = await fetchJson(
      url,
      config.provider.apiKey,
      config.timeoutMs,
      { method: "GET" },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `catalog_http_${response.status}: ${errorSnippet(response.text)}`,
      );
    }
    const parsed = asRecord(JSON.parse(response.text));
    const items =
      parsed && Array.isArray(parsed["data"]) ? parsed["data"] : [];
    const decisionItems = items.filter(isDecisionModel);
    return {
      models: toCatalogModels(decisionItems),
      raw: {
        source: url,
        total: items.length,
        decisionModels: decisionItems.length,
        data: decisionItems,
      },
      url,
    };
  }

  const baseUrl = new URL(config.provider.catalogUrl);
  baseUrl.searchParams.set("limit", "100");
  const items: unknown[] = [];
  let totalPages = 1;
  let total = 0;

  for (let page = 1; page <= totalPages; page += 1) {
    const url = new URL(baseUrl);
    url.searchParams.set("page", String(page));
    console.error(
      `[FREE] catalog page ${page}${page === 1 ? "" : `/${totalPages}`}`,
    );
    const response = await fetchJson(
      url.toString(),
      config.provider.apiKey,
      config.timeoutMs,
      { method: "GET" },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `catalog_http_${response.status}: ${errorSnippet(response.text)}`,
      );
    }
    const parsed = asRecord(JSON.parse(response.text));
    const pageItems =
      parsed && Array.isArray(parsed["data"]) ? parsed["data"] : [];
    items.push(...pageItems);
    if (page === 1 && parsed) {
      const meta = asRecord(parsed["meta"]);
      if (meta && typeof meta["totalPages"] === "number") {
        totalPages = meta["totalPages"];
      }
      if (meta && typeof meta["total"] === "number") total = meta["total"];
    }
  }

  const decisionItems = items.filter(isDecisionModel);
  return {
    models: toCatalogModels(decisionItems),
    raw: {
      source: baseUrl.toString(),
      pages: totalPages,
      total,
      decisionModels: decisionItems.length,
      data: decisionItems,
    },
    url: baseUrl.toString(),
  };
}

function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

function isModelAlias(value: string): value is ModelAlias {
  return (MODEL_ALIASES as readonly string[]).includes(value);
}

export interface SmokeResult {
  alias: ModelAlias;
  modelId: string;
  httpStatus: number | null;
  ok: boolean;
  checks: SmokeChecks | null;
  responseModel: string | null;
  usage: SmokeUsage | null;
  error: string | null;
  file: string | null;
  durationMs: number | null;
}

const USAGE = `Usage: node dist/cli/smoke.js [options]

  --provider=polza|openrouter   активный шлюз (по умолчанию из .env)
  --model=jev                   проверяемая модель; можно повторять
  --catalog-only                только каталог, без платных вызовов
  --out-dir=fixtures            каталог для сырых ответов
  --help                        эта справка

[PAID] перед каждым живым вызовом; стоимость берётся из usage.cost_rub.`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let values: {
    provider?: string;
    model?: string[];
    "catalog-only"?: boolean;
    "out-dir"?: string;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        provider: { type: "string" },
        model: { type: "string", multiple: true },
        "catalog-only": { type: "boolean", default: false },
        "out-dir": { type: "string", default: "fixtures" },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    console.error((error as Error).message);
    console.error(USAGE);
    return 2;
  }

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const providerOverride = values.provider;
  if (providerOverride !== undefined && !isProviderName(providerOverride)) {
    console.error(`Неизвестный провайдер: ${providerOverride}`);
    return 2;
  }

  const requestedAliases = values.model ?? [];
  for (const alias of requestedAliases) {
    if (!isModelAlias(alias)) {
      console.error(`Неизвестная модель: ${alias}`);
      return 2;
    }
  }
  const aliases: ModelAlias[] =
    requestedAliases.length > 0
      ? (requestedAliases as ModelAlias[])
      : [...MODEL_ALIASES];

  loadEnvFile();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (providerOverride) env["DECIDE_PROVIDER"] = providerOverride;
  const config: AppConfig = parseConfig(env);

  const outDir = path.resolve(values["out-dir"] ?? "fixtures");
  mkdirSync(outDir, { recursive: true });

  console.log(
    `decide-mcp smoke · provider=${config.provider.name} · models=${aliases.join(",")}`,
  );
  console.log(JSON.stringify(describeConfig(config), null, 2));

  let catalog: Awaited<ReturnType<typeof fetchDecisionCatalog>>;
  try {
    catalog = await fetchDecisionCatalog(config);
  } catch (error) {
    console.error(`Каталог: ${(error as Error).message}`);
    return 1;
  }

  const catalogFile = path.join(
    outDir,
    `${config.provider.name}-catalog-decisions.json`,
  );
  writeFileSync(catalogFile, JSON.stringify(catalog.raw, null, 2), "utf8");
  const catalogModels = catalog.models;

  const registered = listModels(config.provider.name);
  const presence = registered.map((model) => {
    const entry = catalogModels.find((item) => item.id === model.modelId);
    return {
      alias: model.alias,
      modelId: model.modelId,
      found: entry !== undefined,
      catalogContextWindow: entry?.contextLength ?? null,
      registryContextWindow: model.contextWindow,
    };
  });

  console.log(
    `\nКаталог: decision-моделей ${catalogModels.length}, источник ${catalog.url}`,
  );
  for (const item of presence) {
    console.log(
      `  ${item.found ? "OK  " : "MISS"} ${item.alias}: ${item.modelId} · ctx ${item.registryContextWindow}${item.found && item.catalogContextWindow !== item.registryContextWindow ? ` (каталог: ${item.catalogContextWindow})` : ""}`,
    );
  }
  console.log(`  срез каталога: ${catalogFile}`);

  if (values["catalog-only"]) {
    return presence.every((item) => item.found) ? 0 : 1;
  }

  const results: SmokeResult[] = [];
  let totalCostRub = 0;

  for (const [index, alias] of aliases.entries()) {
    const model = getModel(alias, config.provider.name);
    const catalogEntry = catalogModels.find((item) => item.id === model.modelId);
    if (!catalogEntry) {
      results.push({
        alias,
        modelId: model.modelId,
        httpStatus: null,
        ok: false,
        checks: null,
        responseModel: null,
        usage: null,
        error: "model_not_in_catalog",
        file: null,
        durationMs: null,
      });
      console.log(`${alias}: SKIP · модель отсутствует в каталоге`);
      continue;
    }

    const file = path.join(
      outDir,
      `${config.provider.name}-${alias}-smoke.json`,
    );
    console.error(`[PAID] ${config.provider.name}/${alias} ${model.modelId}`);
    const startedAt = Date.now();

    try {
      const response = await fetchJson(
        config.provider.decisionsUrl,
        config.provider.apiKey,
        config.timeoutMs,
        { method: "POST", body: buildSmokeRequest(model.modelId) },
      );
      writeFileSync(file, response.text, "utf8");

      if (response.status < 200 || response.status >= 300) {
        results.push({
          alias,
          modelId: model.modelId,
          httpStatus: response.status,
          ok: false,
          checks: null,
          responseModel: null,
          usage: null,
          error: errorSnippet(response.text),
          file,
          durationMs: Date.now() - startedAt,
        });
        console.log(
          `${alias}: HTTP ${response.status} FAIL · ${errorSnippet(response.text)}`,
        );
      } else {
        let raw: unknown;
        try {
          raw = JSON.parse(response.text);
        } catch {
          results.push({
            alias,
            modelId: model.modelId,
            httpStatus: response.status,
            ok: false,
            checks: null,
            responseModel: null,
            usage: null,
            error: "invalid_json",
            file,
            durationMs: Date.now() - startedAt,
          });
          console.log(`${alias}: HTTP ${response.status} FAIL · invalid JSON`);
          continue;
        }

        const validation = validateSmokeResponse(raw);
        if (validation.usage?.costRub) totalCostRub += validation.usage.costRub;
        results.push({
          alias,
          modelId: model.modelId,
          httpStatus: response.status,
          ok: validation.ok,
          checks: validation.checks,
          responseModel: validation.responseModel,
          usage: validation.usage,
          error: validation.ok ? null : failedChecks(validation.checks),
          file,
          durationMs: Date.now() - startedAt,
        });
        console.log(
          `${alias}: HTTP ${response.status} ${validation.ok ? "OK" : "FAIL"} · model=${validation.responseModel ?? "?"} · in=${validation.usage?.inputTokens ?? "?"} out=${validation.usage?.outputTokens ?? "?"} · cost=${validation.usage?.costRub ?? "?"} ₽ · ${validation.ok ? "checks ok" : failedChecks(validation.checks)}`,
        );
      }
    } catch (error) {
      results.push({
        alias,
        modelId: model.modelId,
        httpStatus: null,
        ok: false,
        checks: null,
        responseModel: null,
        usage: null,
        error: (error as Error).message,
        file,
        durationMs: Date.now() - startedAt,
      });
      console.log(`${alias}: FAIL · ${(error as Error).message}`);
    }

    if (index < aliases.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    provider: config.provider.name,
    baseUrl: config.provider.baseUrl,
    catalogFile,
    models: results,
    totalCostRub: Number(totalCostRub.toFixed(8)),
    paid: true,
  };
  const summaryFile = path.join(
    outDir,
    `${config.provider.name}-smoke-summary.json`,
  );
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2), "utf8");

  console.log(`\n[PAID] total: ${summary.totalCostRub} ₽`);
  console.log(`Сводка: ${summaryFile}`);
  return results.every((result) => result.ok) ? 0 : 1;
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
