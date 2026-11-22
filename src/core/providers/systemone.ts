/**
 * Единый адаптер протокола System One (`POST /api/v1/systemone`) для Polza AI
 * и OpenRouter (docs/architecture/providers-and-models.md §1–4).
 *
 * Фактическое поведение шлюза зафиксировано пробами 2026-11-22
 * (`docs/verification/probes-safety-overflow-2026-11-22.md`):
 * - переполнение окна приходит как `HTTP 400 BAD_REQUEST` / `detail.error_type`
 *   `bad_request`, а не как safety: такой ответ не ретраится и не делится;
 * - safety-блокировка токсичного ввода не воспроизведена, поэтому ветка
 *   `content_blocked` / `safety` остаётся защитной и включается только по коду;
 * - ключи `item_id__question_id` возвращаются дословно;
 * - `probabilities` приходят словарём и для `choice`, и для `score`.
 */
import { getModel } from "../registry.js";
import {
  toProviderQuestion,
  type ProviderQuestion,
  type QuestionDef,
} from "../schema.js";
import type { ProviderName } from "../types.js";
import {
  ProviderError,
  primitiveTypeOf,
  type CatalogModelInfo,
  type ConfidenceSource,
  type DecisionProvider,
  type NormalizedAnswer,
  type NormalizedAnswerType,
  type ProviderBatchRequest,
  type ProviderBatchResponse,
  type ProviderUsage,
} from "./types.js";

/** Задержки документированной политики повторов: 1s, 3s, 7s + джиттер. */
export const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000, 7_000] as const;
const DEFAULT_JITTER_RATIO = 0.3;

/** Коды, которые ретраятся: 429 и транзиентные 5xx. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/** Коды safety-блокировки, при которых батч можно делить. */
const SAFETY_ERROR_MARKERS = new Set(["content_blocked", "safety"]);

const MAX_CATALOG_PAGES = 50;

export interface SystemOneProviderOptions {
  name: ProviderName;
  apiKey: string;
  decisionsUrl: string;
  catalogUrl: string;
  timeoutMs: number;
  /** Переопределение задержек повторов (тесты). */
  retryDelaysMs?: readonly number[];
  /** Доля случайной добавки к задержке, 0..1. */
  jitterRatio?: number;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Классифицирует HTTP-ошибку шлюза. `safety_blocked` — только по явному коду
 * (`content_blocked` / `safety`); всё остальное 400 — дефект запроса.
 */
export function classifyHttpError(status: number, text: string): ProviderError {
  const parsed = parseJson(text);
  const root = asRecord(parsed);
  const errorBody = root ? asRecord(root["error"]) : null;
  const detail = root ? asRecord(root["detail"]) : null;

  const code = asString(errorBody?.["code"]);
  const errorType = asString(detail?.["error_type"]);
  const metadata = errorBody ? asRecord(errorBody["metadata"]) : null;
  const rawDetail = asString(metadata?.["raw"]);
  const traceId =
    asString(root?.["trace_id"]) ?? asString(errorBody?.["trace_id"]);
  const message =
    asString(errorBody?.["message"]) ??
    asString(detail?.["message"]) ??
    text.slice(0, 300);

  const summary = [code ?? `HTTP ${status}`, message, rawDetail]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(": ");

  const isSafety =
    (code !== null && SAFETY_ERROR_MARKERS.has(code.toLowerCase())) ||
    (errorType !== null && SAFETY_ERROR_MARKERS.has(errorType.toLowerCase()));

  if (isSafety) {
    return new ProviderError("safety_blocked", summary, {
      status,
      retryable: false,
      body: parsed ?? text,
      traceId,
    });
  }
  if (status === 429) {
    return new ProviderError("rate_limited", summary, {
      status,
      retryable: true,
      body: parsed ?? text,
      traceId,
    });
  }
  if (status === 400) {
    return new ProviderError("bad_request", summary, {
      status,
      retryable: false,
      body: parsed ?? text,
      traceId,
    });
  }
  return new ProviderError("provider_error", summary, {
    status,
    retryable: RETRYABLE_STATUSES.has(status),
    body: parsed ?? text,
    traceId,
  });
}

interface FallbackConfidence {
  value: number;
  source: ConfidenceSource;
}

function fallbackConfidence(
  probabilities: Record<string, number> | number[] | undefined,
): FallbackConfidence {
  if (probabilities === undefined) return { value: 0, source: "none" };
  const values = Array.isArray(probabilities)
    ? probabilities
    : Object.values(probabilities);
  if (values.length === 0) return { value: 0, source: "none" };

  const sorted = [...values].sort((left, right) => right - left);
  const top = sorted[0] ?? 0;
  if (sorted.length === 1) return { value: top, source: "top1" };
  return { value: Math.max(0, top - (sorted[1] ?? 0)), source: "margin" };
}

/** Словарь вероятностей `choice`: только конечные числа, ключи по алфавиту. */
function probabilityRecord(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record)
    .filter((entry): entry is [string, number] => asNumber(entry[1]) !== null)
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

/**
 * Вероятности `score` приходят словарём `{"0": …}`: нормализуем в массив по
 * возрастанию индекса уровня. Требуем непрерывные индексы `0..n-1`: иначе
 * массив потерял бы позицию уровня (например, `{"0": …, "2": …}`), и
 * вероятности честнее не отдавать вовсе. Нечисловые ключи не распознаём.
 */
function scoreProbabilities(value: unknown): number[] | undefined {
  if (Array.isArray(value)) {
    const numbers = value.filter((item) => asNumber(item) !== null);
    return numbers.length === value.length && numbers.length > 0
      ? (numbers as number[])
      : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const entries: Array<[number, number]> = [];
  for (const [key, item] of Object.entries(record)) {
    const index = Number(key);
    const probability = asNumber(item);
    if (!Number.isInteger(index) || index < 0 || probability === null) return undefined;
    entries.push([index, probability]);
  }
  if (entries.length === 0) return undefined;
  entries.sort(([left], [right]) => left - right);
  const contiguous = entries.every(([index], position) => index === position);
  if (!contiguous) return undefined;
  return entries.map(([, probability]) => probability);
}

function errorAnswer(
  type: NormalizedAnswerType,
  status: NormalizedAnswer["status"] = "error",
): NormalizedAnswer {
  return { type, status, confidence: 0, confidenceSource: "none" };
}

/** Переводит сырой ответ одного вопроса в нормализованный вид. */
export function normalizeAnswer(
  raw: unknown,
  question: QuestionDef,
): NormalizedAnswer {
  const type = primitiveTypeOf(question);
  const record = asRecord(raw);
  if (!record) return errorAnswer(type);

  const rawType = asString(record["type"]);
  if (rawType === "refusal") return errorAnswer(type, "refusal");

  const providerConfidence = asNumber(record["confidence"]);
  const confidenceSource: ConfidenceSource =
    providerConfidence === null ? "none" : "provider";

  if (rawType === "noul" && type === "bool") {
    const prob = asNumber(record["noul"]);
    if (prob === null) return errorAnswer(type);
    return {
      type,
      status: "ok",
      prob,
      confidence:
        providerConfidence ?? Math.max(prob, 1 - prob),
      confidenceSource:
        providerConfidence === null ? "max_prob" : confidenceSource,
    };
  }

  if (rawType === "choice" && type === "choice") {
    const choice = asString(record["choice"]);
    if (choice === null) return errorAnswer(type);
    const probabilities = probabilityRecord(record["probabilities"]);
    const fallback = fallbackConfidence(probabilities);
    const answer: NormalizedAnswer = {
      type,
      status: "ok",
      choice,
      confidence: providerConfidence ?? fallback.value,
      confidenceSource:
        providerConfidence === null ? fallback.source : confidenceSource,
    };
    if (probabilities !== undefined) answer.probabilities = probabilities;
    return answer;
  }

  if (rawType === "score" && type === "score") {
    const score = asNumber(record["score"]);
    if (score === null) return errorAnswer(type);
    const probabilities = scoreProbabilities(record["probabilities"]);
    const fallback = fallbackConfidence(probabilities);
    const answer: NormalizedAnswer = {
      type,
      status: "ok",
      score,
      confidence: providerConfidence ?? fallback.value,
      confidenceSource:
        providerConfidence === null ? fallback.source : confidenceSource,
    };
    if (probabilities !== undefined) answer.probabilities = probabilities;
    return answer;
  }

  // Тип ответа не совпал с вопросом (или пришёл незнакомый): значение не пишем.
  return {
    type,
    status: "error",
    confidence: providerConfidence ?? 0,
    confidenceSource,
  };
}

function parseUsage(value: unknown): ProviderUsage {
  const usage = asRecord(value) ?? {};
  const inputTokens = asNumber(usage["input_tokens"]) ?? 0;
  const outputTokens = asNumber(usage["output_tokens"]) ?? 0;
  const costRub = asNumber(usage["cost_rub"]);
  const costUsd = asNumber(usage["cost_usd"]) ?? asNumber(usage["cost"]);
  const parsed: ProviderUsage = { inputTokens, outputTokens };
  if (costRub !== null) parsed.costRub = costRub;
  if (costUsd !== null) parsed.costUsd = costUsd;
  return parsed;
}

function parseSuccess(
  text: string,
  questions: Record<string, QuestionDef>,
  latencyMs: number,
): ProviderBatchResponse {
  const parsed = parseJson(text);
  const root = asRecord(parsed);
  const rawAnswerMap = root ? asRecord(root["answers"]) : null;
  if (!root || !rawAnswerMap) {
    throw new ProviderError(
      "provider_error",
      "В ответе провайдера нет поля answers",
      { status: 200, retryable: false, body: parsed ?? text.slice(0, 500) },
    );
  }

  const answers: Record<string, NormalizedAnswer> = {};
  const rawAnswers: Record<string, unknown> = { ...rawAnswerMap };
  for (const [key, question] of Object.entries(questions)) {
    if (!(key in rawAnswers)) rawAnswers[key] = null;
    answers[key] = normalizeAnswer(rawAnswerMap[key], question);
  }

  return {
    answers,
    rawAnswers,
    usage: parseUsage(root["usage"]),
    latencyMs,
    responseModel: asString(root["model"]),
  };
}

function mapQuestions(
  questions: Record<string, QuestionDef>,
): Record<string, ProviderQuestion> {
  const mapped: Record<string, ProviderQuestion> = {};
  for (const [key, question] of Object.entries(questions)) {
    mapped[key] = toProviderQuestion(question);
  }
  return mapped;
}

function isDecisionModel(item: unknown): boolean {
  const record = asRecord(item);
  if (!record) return false;
  if (record["type"] === "classification") return true;
  const endpoints = record["endpoints"];
  return (
    Array.isArray(endpoints) && endpoints.includes("/api/v1/systemone")
  );
}

function toCatalogModels(items: unknown[]): CatalogModelInfo[] {
  const models: CatalogModelInfo[] = [];
  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;
    const id = asString(record["id"]);
    if (id === null) continue;
    models.push({
      id,
      contextLength: asNumber(record["context_length"]),
      type: asString(record["type"]),
    });
  }
  return models;
}

export class SystemOneProvider implements DecisionProvider {
  readonly name: ProviderName;

  private readonly apiKey: string;
  private readonly decisionsUrl: string;
  private readonly catalogUrl: string;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly jitterRatio: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: SystemOneProviderOptions) {
    this.name = options.name;
    this.apiKey = options.apiKey;
    this.decisionsUrl = options.decisionsUrl;
    this.catalogUrl = options.catalogUrl;
    this.timeoutMs = options.timeoutMs;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  async decide(request: ProviderBatchRequest): Promise<ProviderBatchResponse> {
    const model = getModel(request.modelAlias, this.name);
    const body = {
      model: model.modelId,
      state: request.state,
      questions: mapQuestions(request.questions),
    };

    const startedMs = Date.now();
    let lastError: ProviderError | null = null;

    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      if (attempt > 0) await this.sleep(this.delayFor(attempt - 1));
      try {
        const response = await this.post(body, request.extraHeaders);
        if (response.status >= 200 && response.status < 300) {
          return parseSuccess(
            response.text,
            request.questions,
            Date.now() - startedMs,
          );
        }

        const error = classifyHttpError(response.status, response.text);
        if (!error.retryable || attempt === this.retryDelaysMs.length) throw error;
        lastError = error;
      } catch (thrown) {
        const error =
          thrown instanceof ProviderError
            ? thrown
            : new ProviderError(
                "provider_error",
                thrown instanceof Error ? thrown.message : String(thrown),
                { status: null, retryable: true },
              );
        if (!error.retryable || attempt === this.retryDelaysMs.length) {
          throw error;
        }
        lastError = error;
      }
    }

    throw (
      lastError ??
      new ProviderError("provider_error", "Провайдер не ответил", {
        status: null,
        retryable: false,
      })
    );
  }

  async fetchCatalog(): Promise<CatalogModelInfo[]> {
    if (this.name === "openrouter") {
      const payload = await this.getJson(this.catalogUrl);
      const data = asRecord(payload)?.["data"];
      return toCatalogModels(
        Array.isArray(data) ? data.filter(isDecisionModel) : [],
      );
    }

    const base = new URL(this.catalogUrl);
    base.searchParams.set("limit", "100");
    const collected: unknown[] = [];
    let totalPages = 1;

    for (
      let page = 1;
      page <= totalPages && page <= MAX_CATALOG_PAGES;
      page += 1
    ) {
      const url = new URL(base);
      url.searchParams.set("page", String(page));
      const payload = await this.getJson(url.toString());
      const record = asRecord(payload);
      const data = record?.["data"];
      if (Array.isArray(data)) collected.push(...data);
      if (page === 1) {
        const meta = asRecord(record?.["meta"]);
        const pages = meta ? asNumber(meta["totalPages"]) : null;
        if (pages !== null && pages > 0) totalPages = pages;
      }
    }

    return toCatalogModels(collected.filter(isDecisionModel));
  }

  private delayFor(index: number): number {
    const base = this.retryDelaysMs[index] ?? 0;
    return Math.round(base * (1 + this.random() * this.jitterRatio));
  }

  private async post(
    body: unknown,
    extraHeaders: Record<string, string> | undefined,
  ): Promise<{ status: number; text: string }> {
    const response = await this.fetchImpl(this.decisionsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return { status: response.status, text: await response.text() };
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw classifyHttpError(response.status, text);
    }
    const parsed = parseJson(text);
    if (parsed === null) {
      throw new ProviderError("provider_error", "Каталог вернул не-JSON ответ", {
        status: response.status,
        retryable: false,
        body: text.slice(0, 500),
      });
    }
    return parsed;
  }
}
