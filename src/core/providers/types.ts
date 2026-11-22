/**
 * Контракт провайдера decision-моделей.
 *
 * Ядро отдаёт внутренние примитивы (`QuestionDef` из `schema.ts`) и получает
 * нормализованные ответы; сетевой формат каждого шлюза скрыт за
 * `DecisionProvider` (docs/architecture/providers-and-models.md §1).
 */
import type { QuestionDef } from "../schema.js";
import type { ModelAlias, ProviderName } from "../types.js";

export interface ProviderBatchRequest {
  modelAlias: ModelAlias;
  /** Текст состояния: справочник `guide` и элементы с якорями `[ITEM id="…"]`. */
  state: string;
  /** Внутренние вопросы; адаптер сам переводит `bool → noul`, `options/levels → criteria`. */
  questions: Record<string, QuestionDef>;
  extraHeaders?: Record<string, string>;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /** Стоимость в рублях (Polza AI). */
  costRub?: number;
  /** Стоимость в долларах (OpenRouter). */
  costUsd?: number;
}

export type NormalizedAnswerType = "bool" | "choice" | "score";
export type NormalizedAnswerStatus =
  | "ok"
  | "refusal"
  | "safety_blocked"
  | "error";

/** Откуда взялась уверенность: поле провайдера или fallback адаптера. */
export type ConfidenceSource = "provider" | "max_prob" | "margin" | "top1" | "none";

export interface NormalizedAnswer {
  type: NormalizedAnswerType;
  status: NormalizedAnswerStatus;
  /** Для `bool`: вероятность истинности [0..1]. */
  prob?: number;
  /** Для `score`: взвешенное среднее индексов уровней. */
  score?: number;
  /** Для `choice`: ключ победившего варианта. */
  choice?: string;
  /** Нормализованная уверенность [0..1]. */
  confidence: number;
  /** `choice`: словарь ключей; `score`: массив по возрастанию индекса уровня. */
  probabilities?: Record<string, number> | number[];
  confidenceSource: ConfidenceSource;
}

export interface ProviderBatchResponse {
  answers: Record<string, NormalizedAnswer>;
  rawAnswers: Record<string, unknown>;
  usage: ProviderUsage;
  latencyMs: number;
  /** Ответившая версия модели (`jev-1.14.0`, `…-20261111`); нужна для аудита. */
  responseModel: string | null;
}

export interface CatalogModelInfo {
  id: string;
  contextLength: number | null;
  type: string | null;
}

export interface DecisionProvider {
  readonly name: ProviderName | string;
  decide(request: ProviderBatchRequest): Promise<ProviderBatchResponse>;
  fetchCatalog(): Promise<CatalogModelInfo[]>;
}

/** Внутренний примитив вопроса в терминах нормализованного ответа. */
export function primitiveTypeOf(question: QuestionDef): NormalizedAnswerType {
  switch (question.type) {
    case "bool":
      return "bool";
    case "choice":
      return "choice";
    case "score":
      return "score";
    case "box":
      throw new Error(
        "Примитив box не поддерживается в MVP и не уходит провайдеру",
      );
  }
}

export const PROVIDER_ERROR_KINDS = [
  "safety_blocked",
  "bad_request",
  "rate_limited",
  "provider_error",
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

export interface ProviderErrorDetails {
  status: number | null;
  retryable: boolean;
  /** Разобранное тело ошибки или сырой текст; нужен для аудита. */
  body?: unknown;
  traceId?: string | null;
}

/** Ошибка провайдера с признаком «можно ли делить батч». */
export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly status: number | null;
  readonly retryable: boolean;
  readonly body: unknown;
  readonly traceId: string | null;

  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    details: ProviderErrorDetails,
  ) {
    super(message);
    this.status = details.status;
    this.retryable = details.retryable;
    this.body = details.body;
    this.traceId = details.traceId ?? null;
  }

  /**
   * Изолировать делением батча можно только safety-блокировку.
   * `bad_request` (в том числе переполнение окна) — дефект запроса,
   * его не делят и не ретраят: пробы 2026-11-22.
   */
  get splittable(): boolean {
    return this.kind === "safety_blocked";
  }
}
