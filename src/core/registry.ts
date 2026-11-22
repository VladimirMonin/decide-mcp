import type { ModelAlias, ProviderName } from "./types.js";

export interface ModelPassport {
  alias: ModelAlias;
  providerModelIds: Record<ProviderName, string>;
  contextWindow: number;
  maxCompletionTokens: number | null;
  maxQuestionsPerRequest: number;
  /** Источник maxQuestionsPerRequest: живой HTTP 400 или документация. */
  maxQuestionsSource: "measured-2026-11-22" | "docs";
  /**
   * Жёсткий потолок ступеней `score`: выше — ошибка рубрики.
   * `gemini` по контракту принимает 2..255, у `ms`, `jev` и `luna` потолок 10.
   */
  maxScoreLevels: number;
  /**
   * Рекомендуемый потолок ступеней: выше него линтер выдаёт предупреждение,
   * но запуск не блокирует. У `gemini` рекомендация Google ниже жёсткого
   * потолка (2..10), у остальных стартовых моделей оба значения совпадают.
   */
  recommendedScoreLevels: number;
  supportsMedia: false;
  recommendedFor: string;
  /**
   * catalog-2026-11-22 — context window сверен с живым каталогом Polza AI.
   * Источник maxQuestionsPerRequest хранится отдельно в maxQuestionsSource.
   */
  limitsSource: "catalog-2026-11-22" | "docs";
}

export const MODEL_REGISTRY: Record<ModelAlias, ModelPassport> = {
  gemini: {
    alias: "gemini",
    providerModelIds: {
      polza: "google/gemini-decision-1",
      openrouter: "google/gemini-decision-1",
    },
    contextWindow: 262_144,
    maxCompletionTokens: 235_929,
    maxQuestionsPerRequest: 256,
    maxQuestionsSource: "measured-2026-11-22",
    maxScoreLevels: 255,
    recommendedScoreLevels: 10,
    supportsMedia: false,
    recommendedFor:
      "Широкий скрининг (до 256 вопросов за вызов; 1000 элементов — несколькими батчами), первый этап воронки",
    limitsSource: "catalog-2026-11-22",
  },
  ms: {
    alias: "ms",
    providerModelIds: {
      polza: "microsoft/microsoft-decision-1",
      openrouter: "microsoft/microsoft-decision-1",
    },
    contextWindow: 32_768,
    maxCompletionTokens: 29_491,
    maxQuestionsPerRequest: 150,
    maxQuestionsSource: "docs",
    maxScoreLevels: 10,
    recommendedScoreLevels: 10,
    supportsMedia: false,
    recommendedFor:
      "Короткие шаги, выбор инструмента (When2Call); мягкий лимит ~150 вопросов",
    limitsSource: "catalog-2026-11-22",
  },
  jev: {
    alias: "jev",
    providerModelIds: {
      polza: "typesafe/jev",
      openrouter: "typesafe/jev-1.14",
    },
    contextWindow: 64_000,
    maxCompletionTokens: null,
    maxQuestionsPerRequest: 256,
    maxQuestionsSource: "docs",
    maxScoreLevels: 10,
    recommendedScoreLevels: 10,
    supportsMedia: false,
    recommendedFor:
      "Базовая модель для кода и текстов, лучшая калибровка вероятностей",
    limitsSource: "catalog-2026-11-22",
  },
  luna: {
    alias: "luna",
    providerModelIds: {
      polza: "openai/gpt-6-luna-decisions",
      openrouter: "openai/gpt-6-luna-decisions",
    },
    contextWindow: 1_050_000,
    maxCompletionTokens: 945_000,
    maxQuestionsPerRequest: 200,
    maxQuestionsSource: "measured-2026-11-22",
    maxScoreLevels: 10,
    recommendedScoreLevels: 10,
    supportsMedia: false,
    recommendedFor: "Длинные истории диалогов и крупные модули",
    limitsSource: "catalog-2026-11-22",
  },
};

export interface ResolvedModel extends ModelPassport {
  modelId: string;
}

export function getModel(
  alias: ModelAlias,
  provider: ProviderName,
): ResolvedModel {
  const passport = MODEL_REGISTRY[alias];
  return { ...passport, modelId: passport.providerModelIds[provider] };
}

export function listModels(provider: ProviderName): ResolvedModel[] {
  return (Object.keys(MODEL_REGISTRY) as ModelAlias[]).map((alias) =>
    getModel(alias, provider),
  );
}
