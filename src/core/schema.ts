/**
 * Входные контракты ядра: рубрика, источники, фильтры и перевод внутренних
 * примитивов в формат провайдера `POST /api/v1/systemone`.
 *
 * `zod` проверяет форму и типы полей, а правила домена (число опций `choice`,
 * ступеней `score`, запрет `box` в MVP) собраны в `lintRubric`, чтобы ошибки
 * блокировки и предупреждения линтера возвращались одним объектом
 * `RubricValidation`. Значения по умолчанию (`max_files: 500`,
 * `logic: "and"`, проекции) схемы не подставляют — их применяют потребители
 * (`sources.ts`, `query.ts`).
 *
 * Источник правды: docs/architecture/contracts.md §1–2; фактический формат
 * провайдера — docs/verification/step0-smoke-2026-11-22.md.
 */
import { z } from "zod";
import { MODEL_REGISTRY } from "./registry.js";
import type { ModelAlias } from "./types.js";

// --- Идентификаторы и лимиты контракта --------------------------------------

/** Разрешённые имена вопросов: буквы, цифры, `_`, `-`; длина 1..64. */
export const QUESTION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export const CHOICE_OPTIONS_MIN = 2;
export const CHOICE_OPTIONS_MAX = 255;
/** После ~50 вариантов калибровка `choice` заметно падает — предупреждение. */
export const CHOICE_OPTIONS_WARN_MAX = 50;

export const SCORE_LEVELS_MIN = 2;

// --- Ошибки и предупреждения ------------------------------------------------

export const RUBRIC_ERROR_CODES = ["invalid_rubric", "unsupported_in_mvp"] as const;
export type RubricErrorCode = (typeof RUBRIC_ERROR_CODES)[number];

export const RUBRIC_WARNING_CODES = [
  "choice_calibration_degradation",
  "score_levels_degradation",
  "choice_gemini_key_order",
] as const;
export type RubricWarningCode = (typeof RUBRIC_WARNING_CODES)[number];

/** Заглушка-плейсхолдер: только ключ `other` не всплывает в начало списка у gemini. */
const CHOICE_PLACEHOLDER_KEY = "other";
const CHOICE_PLACEHOLDER_ALIASES = ["none_of_the_above", "none"] as const;

/** Ошибка, блокирующая запуск; `path` указывает поле контракта. */
export interface RubricError {
  code: RubricErrorCode;
  path: string;
  message: string;
}

/** Предупреждение линтера: запуск не блокирует. */
export interface RubricWarning {
  code: RubricWarningCode;
  path: string;
  message: string;
}

export class SchemaError extends Error {
  override readonly name = "SchemaError";

  constructor(
    readonly code: RubricErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// --- Вопросы рубрики --------------------------------------------------------

export const questionIdSchema = z
  .string()
  .regex(
    QUESTION_ID_PATTERN,
    "question_id: допустимы только [a-zA-Z0-9_-], длина 1..64",
  );

export const boolQuestionSchema = z.strictObject({
  type: z.literal("bool"),
  instructions: z.string().trim().min(1),
  true_description: z.string().trim().min(1).optional(),
  false_description: z.string().trim().min(1).optional(),
});

export const choiceQuestionSchema = z.strictObject({
  type: z.literal("choice"),
  instructions: z.string().trim().min(1),
  /** Словарь { key: description }; количество проверяет `lintRubric`. */
  options: z.record(z.string().trim().min(1), z.string().trim().min(1)),
});

export const scoreQuestionSchema = z.strictObject({
  type: z.literal("score"),
  instructions: z.string().trim().min(1),
  /** Упорядоченные ступени от минимума (индекс 0) к максимуму. */
  levels: z.array(z.string().trim().min(1)),
});

/** Зарезервирован под мультимодальность; в текстовом MVP отклоняется линтером. */
export const boxQuestionSchema = z.strictObject({
  type: z.literal("box"),
  instructions: z.string().trim().min(1),
});

export const questionDefSchema = z.discriminatedUnion("type", [
  boolQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
  boxQuestionSchema,
]);

export type BoolQuestion = z.infer<typeof boolQuestionSchema>;
export type ChoiceQuestion = z.infer<typeof choiceQuestionSchema>;
export type ScoreQuestion = z.infer<typeof scoreQuestionSchema>;
export type BoxQuestion = z.infer<typeof boxQuestionSchema>;
export type QuestionDef = z.infer<typeof questionDefSchema>;

// --- Рубрика ----------------------------------------------------------------

export const rubricSchema = z.strictObject({
  name: z.string().trim().min(1).optional(),
  /** Общие правила: движок вставляет их один раз в шапку state. */
  guide: z.string().trim().min(1).optional(),
  questions: z.record(questionIdSchema, questionDefSchema),
});

export type Rubric = z.infer<typeof rubricSchema>;

export interface RubricValidationOptions {
  /** Модель прогона: от неё зависит жёсткий потолок ступеней `score`. */
  model?: ModelAlias;
}

export interface RubricValidation {
  /** `true` только когда нет ни одной блокирующей ошибки. */
  ok: boolean;
  /** Разобранная рубрика либо `null`, если структура не прошла `zod`. */
  rubric: Rubric | null;
  errors: RubricError[];
  warnings: RubricWarning[];
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join(".") : "rubric";
}

function lintChoice(
  path: string,
  question: ChoiceQuestion,
): { errors: RubricError[]; warnings: RubricWarning[] } {
  const errors: RubricError[] = [];
  const warnings: RubricWarning[] = [];
  const keys = Object.keys(question.options);
  const count = keys.length;
  const optionsPath = `${path}.options`;

  if (count < CHOICE_OPTIONS_MIN) {
    errors.push({
      code: "invalid_rubric",
      path: optionsPath,
      message: `Опций ${count}: у choice минимум ${CHOICE_OPTIONS_MIN} варианта.`,
    });
  } else if (count > CHOICE_OPTIONS_MAX) {
    errors.push({
      code: "invalid_rubric",
      path: optionsPath,
      message: `Опций ${count}: у choice максимум ${CHOICE_OPTIONS_MAX}.`,
    });
  } else if (count > CHOICE_OPTIONS_WARN_MAX) {
    warnings.push({
      code: "choice_calibration_degradation",
      path: optionsPath,
      message: `Опций ${count}: после ~${CHOICE_OPTIONS_WARN_MAX} вариантов калибровка падает, сократите список.`,
    });
  }

  // gemini сортирует ключи по алфавиту: "none..." встанет первым и перетянет
  // вероятности, поэтому заглушку просят называть строго "other". Рубрика
  // переиспользуется между моделями, поэтому предупреждаем без привязки к модели.
  if (!keys.includes(CHOICE_PLACEHOLDER_KEY)) {
    const alias = CHOICE_PLACEHOLDER_ALIASES.find((key) => keys.includes(key));
    if (alias !== undefined) {
      warnings.push({
        code: "choice_gemini_key_order",
        path: optionsPath,
        message: `Ключ "${alias}" без ключа "${CHOICE_PLACEHOLDER_KEY}": gemini сортирует варианты по алфавиту, и заглушка встанет первой — назовите её "${CHOICE_PLACEHOLDER_KEY}".`,
      });
    }
  }

  return { errors, warnings };
}

function lintScore(
  path: string,
  question: ScoreQuestion,
  model: ModelAlias | undefined,
): { errors: RubricError[]; warnings: RubricWarning[] } {
  const errors: RubricError[] = [];
  const warnings: RubricWarning[] = [];
  const count = question.levels.length;
  const levelsPath = `${path}.levels`;
  // Потолки ступеней — из паспорта модели (docs/architecture/providers-and-models.md §3):
  // у gemini maxScoreLevels 255 при рекомендации 10, у ms/jev/luna оба значения 10.
  // Без явной модели действует паспорт jev (`DECIDE_DEFAULT_MODEL`).
  const passport =
    model === undefined ? MODEL_REGISTRY.jev : MODEL_REGISTRY[model];
  const hardCap = passport.maxScoreLevels;
  const recommendedMax = passport.recommendedScoreLevels;
  const capOwner =
    model === undefined ? "у модели по умолчанию jev" : `у модели ${model}`;

  if (count < SCORE_LEVELS_MIN) {
    errors.push({
      code: "invalid_rubric",
      path: levelsPath,
      message: `Ступеней ${count}: у score минимум ${SCORE_LEVELS_MIN}.`,
    });
  } else if (count > hardCap) {
    errors.push({
      code: "invalid_rubric",
      path: levelsPath,
      message: `Ступеней ${count}: ${capOwner} жёсткий потолок ${hardCap}.`,
    });
  } else if (count > recommendedMax) {
    warnings.push({
      code: "score_levels_degradation",
      path: levelsPath,
      message: `Ступеней ${count}: Google рекомендует держать score в диапазоне 2..${recommendedMax}.`,
    });
  }

  return { errors, warnings };
}

function lintRubric(
  rubric: Rubric,
  options: RubricValidationOptions,
): { errors: RubricError[]; warnings: RubricWarning[] } {
  const errors: RubricError[] = [];
  const warnings: RubricWarning[] = [];
  const entries = Object.entries(rubric.questions);

  if (entries.length === 0) {
    errors.push({
      code: "invalid_rubric",
      path: "questions",
      message: "Рубрика не содержит ни одного вопроса.",
    });
  }

  for (const [questionId, question] of entries) {
    const path = `questions.${questionId}`;
    switch (question.type) {
      case "box":
        errors.push({
          code: "unsupported_in_mvp",
          path,
          message:
            "Примитив box требует медиа и в текстовом MVP недоступен; используйте bool, choice или score.",
        });
        break;
      case "bool":
        break;
      case "choice": {
        const linted = lintChoice(path, question);
        errors.push(...linted.errors);
        warnings.push(...linted.warnings);
        break;
      }
      case "score": {
        const linted = lintScore(path, question, options.model);
        errors.push(...linted.errors);
        warnings.push(...linted.warnings);
        break;
      }
    }
  }

  return { errors, warnings };
}

/**
 * Проверяет рубрику целиком: структурные ошибки `zod`, затем правила домена.
 * Блокирующие ошибки — в `errors`, рекомендации — в `warnings`.
 */
export function validateRubric(
  input: unknown,
  options: RubricValidationOptions = {},
): RubricValidation {
  const parsed = rubricSchema.safeParse(input);
  if (!parsed.success) {
    const errors: RubricError[] = parsed.error.issues.map((issue) => ({
      code: "invalid_rubric",
      path: issuePath(issue.path),
      message: issue.message,
    }));
    return { ok: false, rubric: null, errors, warnings: [] };
  }

  const rubric = parsed.data;
  const { errors, warnings } = lintRubric(rubric, options);
  return { ok: errors.length === 0, rubric, errors, warnings };
}

// --- Безопасные фильтры -----------------------------------------------------

export const FILTER_FIELDS = ["prob", "score", "choice", "confidence"] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export const FILTER_OPS = [">=", ">", "<=", "<", "=", "!=", "in"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const filterConditionSchema = z.strictObject({
  question_id: questionIdSchema,
  field: z.enum(FILTER_FIELDS),
  op: z.enum(FILTER_OPS),
  value: z.union([z.number(), z.string(), z.array(z.string()).min(1)]),
});

export type FilterCondition = z.infer<typeof filterConditionSchema>;

export const filterExprSchema = z.strictObject({
  logic: z.enum(["and", "or"]).optional(),
  conditions: z.array(filterConditionSchema),
});

export type FilterExpr = z.infer<typeof filterExprSchema>;

// --- Источники данных -------------------------------------------------------

export const SOURCE_TYPES = ["text", "file", "glob", "jsonl", "from_run"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Проекция длинных агентских сессий в `jsonl` и `from_run`. */
export const PROJECTIONS = ["raw", "skeleton", "full"] as const;
export type Projection = (typeof PROJECTIONS)[number];

export const textSourceSchema = z.strictObject({
  type: z.literal("text"),
  items: z
    .array(
      z.strictObject({
        id: z.string().trim().min(1),
        content: z.string(),
        meta: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1),
});

export const fileSourceSchema = z.strictObject({
  type: z.literal("file"),
  path: z.string().trim().min(1),
  mode: z.enum(["whole", "lines"]).optional(),
  max_lines: z.number().int().positive().optional(),
});

export const globSourceSchema = z.strictObject({
  type: z.literal("glob"),
  pattern: z.string().trim().min(1),
  ignore: z.array(z.string().trim().min(1)).optional(),
  max_files: z.number().int().positive().optional(),
});

export const jsonlSourceSchema = z.strictObject({
  type: z.literal("jsonl"),
  path: z.string().trim().min(1),
  id_field: z.string().trim().min(1).optional(),
  projection: z.enum(PROJECTIONS).optional(),
  prefilter_tags: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export const fromRunSourceSchema = z.strictObject({
  type: z.literal("from_run"),
  run_id: z.string().trim().min(1),
  /** Необязателен: без фильтра берутся все элементы прогона. */
  where: filterExprSchema.optional(),
  context_window: z.number().int().nonnegative().optional(),
  projection: z.enum(PROJECTIONS).optional(),
  limit: z.number().int().positive().optional(),
});

export type TextSource = z.infer<typeof textSourceSchema>;
export type FileSource = z.infer<typeof fileSourceSchema>;
export type GlobSource = z.infer<typeof globSourceSchema>;
export type JsonlSource = z.infer<typeof jsonlSourceSchema>;
export type FromRunSource = z.infer<typeof fromRunSourceSchema>;

export const sourceSchema = z.discriminatedUnion("type", [
  textSourceSchema,
  fileSourceSchema,
  globSourceSchema,
  jsonlSourceSchema,
  fromRunSourceSchema,
]);

export type Source = z.infer<typeof sourceSchema>;

// --- Формат провайдера `/api/v1/systemone` ----------------------------------

export const PROVIDER_QUESTION_TYPES = ["noul", "choice", "score"] as const;
export type ProviderQuestionType = (typeof PROVIDER_QUESTION_TYPES)[number];

export interface ProviderNoulQuestion {
  type: "noul";
  instructions: string;
  true_description?: string;
  false_description?: string;
}

export interface ProviderChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Словарь { key: description } — провайдер ждёт `criteria`, а не `options`. */
  criteria: Record<string, string>;
}

export interface ProviderScoreQuestion {
  type: "score";
  instructions: string;
  /** Упорядоченный массив ступеней — провайдер ждёт `criteria`, а не `levels`. */
  criteria: string[];
}

export type ProviderQuestion =
  | ProviderNoulQuestion
  | ProviderChoiceQuestion
  | ProviderScoreQuestion;

/**
 * Переводит внутренний примитив в тело вопроса провайдера.
 * Проверено 2026-11-22: запрос с `options`/`levels` получил
 * `HTTP 400 BAD_REQUEST` по пути `questions.<id>.criteria`.
 */
export function toProviderQuestion(question: QuestionDef): ProviderQuestion {
  switch (question.type) {
    case "bool": {
      const mapped: ProviderNoulQuestion = {
        type: "noul",
        instructions: question.instructions,
      };
      if (question.true_description !== undefined) {
        mapped.true_description = question.true_description;
      }
      if (question.false_description !== undefined) {
        mapped.false_description = question.false_description;
      }
      return mapped;
    }
    case "choice":
      return {
        type: "choice",
        instructions: question.instructions,
        criteria: { ...question.options },
      };
    case "score":
      return {
        type: "score",
        instructions: question.instructions,
        criteria: [...question.levels],
      };
    case "box":
      throw new SchemaError(
        "unsupported_in_mvp",
        "Примитив box недоступен в текстовом MVP; используйте bool, choice или score.",
      );
  }
}

/** Переводит все вопросы рубрики в словарь `questions` для провайдера. */
export function toProviderQuestions(
  rubric: Rubric,
): Record<string, ProviderQuestion> {
  const mapped: Record<string, ProviderQuestion> = {};
  for (const [questionId, question] of Object.entries(rubric.questions)) {
    mapped[questionId] = toProviderQuestion(question);
  }
  return mapped;
}
