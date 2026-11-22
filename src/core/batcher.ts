/**
 * Упаковка элементов и вопросов в батчи и исполнение плана с пулом
 * параллельности (docs/architecture/providers-and-models.md §4,
 * docs/architecture/system.md §3).
 *
 * Правила, которые здесь зашиты:
 * - `guide` попадает в `state` один раз, а не в каждый вопрос матрицы;
 * - вопрос адресуется ключом `${item_id}__${question_id}`; небезопасный
 *   `item_id` заменяется внутренним `i0001` (обратная таблица — в `refs`);
 * - 2D-бюджет: элементов в батче не больше `maxQuestionsPerRequest / вопросов`,
 *   а `state` + вопросы + overhead не выходят за 80% окна модели;
 * - элемент, который не влезает один, помечается `skipped_too_large`;
 * - при safety-блокировке батч делится пополам до изоляции элемента; ошибка
 *   `bad_request` (в том числе переполнение окна) не делится и не ретраится.
 */
import type { ResolvedModel } from "./registry.js";
import type { QuestionDef, Rubric } from "./schema.js";
import type { ModelAlias } from "./types.js";
import {
  ProviderError,
  primitiveTypeOf,
  type DecisionProvider,
  type NormalizedAnswer,
  type ProviderErrorKind,
  type ProviderUsage,
} from "./providers/types.js";
import { REQUEST_OVERHEAD_TOKENS, estimateTokens, safeRequestLimit } from "./tokenizer.js";

export const GUIDE_HEADER = "## Справочник правил оценки";
export const DATA_HEADER = "## Данные для оценки";

/** Безопасный `item_id`: буквы, цифры, `_`, `-`, длина 1..64. */
const SAFE_API_ITEM_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Потолок «state + один вопрос» ниже общего окна. По документации он вдвое
 * ниже только у jev (32 000 при окне 64 000), у остальных моделей совпадает.
 */
const PER_QUESTION_WINDOW_CAPS: Partial<Record<ModelAlias, number>> = {
  jev: 32_000,
};

export interface BatcherItem {
  id: string;
  content: string;
}

export interface BatchLimits {
  contextWindow: number;
  maxQuestionsPerRequest: number;
  perQuestionWindow: number;
}

/** Лимиты модели для планировщика: окно реестра плюс потолок одного вопроса. */
export function batchLimitsFor(model: ResolvedModel): BatchLimits {
  return {
    contextWindow: model.contextWindow,
    maxQuestionsPerRequest: model.maxQuestionsPerRequest,
    perQuestionWindow:
      PER_QUESTION_WINDOW_CAPS[model.alias] ?? model.contextWindow,
  };
}

export interface PlannedItem extends BatcherItem {
  /** Идентификатор в `state` и ключах вопросов. */
  apiId: string;
}

export interface BatchQuestionRef {
  itemId: string;
  questionId: string;
}

export interface PlannedBatch {
  index: number;
  modelAlias: ModelAlias;
  items: PlannedItem[];
  questionIds: string[];
  state: string;
  /** API-ключ → определение вопроса с якорем элемента. */
  questions: Record<string, QuestionDef>;
  /** API-ключ → исходные `item_id` и `question_id`. */
  refs: Record<string, BatchQuestionRef>;
  estimatedTokens: number;
}

export interface SkippedItem {
  itemId: string;
  /** Идентификатор элемента в `state`: дедуп идёт по нему, а не по `item_id`. */
  apiId: string;
  /** Группа вопросов, для которой элемент не поместился в окно. */
  questionIds: string[];
  reason: "skipped_too_large";
  estimatedTokens: number;
}

export interface BatchPlan {
  modelAlias: ModelAlias;
  /** Исходная рубрика: нужна для пересборки батча после деления. */
  rubric: Rubric;
  batches: PlannedBatch[];
  skipped: SkippedItem[];
  questionsPerItem: number;
  estimatedTokens: number;
}

export interface BatchPlanOptions {
  modelAlias: ModelAlias;
  limits: BatchLimits;
  rubric: Rubric;
  items: BatcherItem[];
}

/**
 * Назначает `apiId` каждому элементу: безопасный `item_id` используется как
 * есть, остальные (пути файлов, повторяющиеся id) получают `i0001`, `i0002`…
 */
export function assignApiItemIds(items: BatcherItem[]): string[] {
  const used = new Set<string>();
  const assigned: string[] = new Array(items.length);
  const generated: number[] = [];

  items.forEach((item, index) => {
    if (SAFE_API_ITEM_ID.test(item.id) && !used.has(item.id)) {
      used.add(item.id);
      assigned[index] = item.id;
    } else {
      generated.push(index);
    }
  });

  let counter = 1;
  for (const index of generated) {
    let candidate = `i${String(counter).padStart(4, "0")}`;
    while (used.has(candidate)) {
      counter += 1;
      candidate = `i${String(counter).padStart(4, "0")}`;
    }
    used.add(candidate);
    assigned[index] = candidate;
    counter += 1;
  }

  return assigned;
}

function buildState(guide: string | undefined, items: PlannedItem[]): string {
  const sections: string[] = [];
  if (guide !== undefined && guide.length > 0) {
    sections.push(`${GUIDE_HEADER}\n${guide}`);
  }
  const blocks = items.map(
    (item) => `[ITEM id="${item.apiId}"]\n${item.content}\n[/ITEM]`,
  );
  sections.push(`${DATA_HEADER}\n${blocks.join("\n")}`);
  return sections.join("\n\n");
}

function anchoredQuestion(
  apiId: string,
  question: QuestionDef,
): QuestionDef {
  const instructions = `Для элемента [${apiId}]: ${question.instructions}`;
  switch (question.type) {
    case "bool":
      return { ...question, instructions };
    case "choice":
      return { ...question, instructions };
    case "score":
      return { ...question, instructions };
    case "box":
      return { ...question, instructions };
  }
}

interface MeasuredBatch {
  state: string;
  questions: Record<string, QuestionDef>;
  refs: Record<string, BatchQuestionRef>;
  estimatedTokens: number;
  perQuestionTokens: number;
}

function measureBatch(
  guide: string | undefined,
  items: PlannedItem[],
  questionIds: string[],
  rubric: Rubric,
): MeasuredBatch {
  const state = buildState(guide, items);
  const questions: Record<string, QuestionDef> = {};
  const refs: Record<string, BatchQuestionRef> = {};

  for (const item of items) {
    for (const questionId of questionIds) {
      const question = rubric.questions[questionId];
      if (question === undefined) continue;
      const apiKey = `${item.apiId}__${questionId}`;
      questions[apiKey] = anchoredQuestion(item.apiId, question);
      refs[apiKey] = { itemId: item.id, questionId };
    }
  }

  const stateTokens = estimateTokens(state);
  const questionsTokens = estimateTokens(JSON.stringify(questions));
  let maxQuestionTokens = 0;
  for (const question of Object.values(questions)) {
    maxQuestionTokens = Math.max(
      maxQuestionTokens,
      estimateTokens(JSON.stringify(question)),
    );
  }

  return {
    state,
    questions,
    refs,
    estimatedTokens:
      stateTokens + questionsTokens + REQUEST_OVERHEAD_TOKENS,
    perQuestionTokens:
      stateTokens + maxQuestionTokens + REQUEST_OVERHEAD_TOKENS,
  };
}

function questionChunks(
  questionIds: string[],
  maxQuestions: number,
): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < questionIds.length; start += maxQuestions) {
    chunks.push(questionIds.slice(start, start + maxQuestions));
  }
  return chunks;
}

function toBatch(
  index: number,
  modelAlias: ModelAlias,
  items: PlannedItem[],
  questionIds: string[],
  measured: MeasuredBatch,
): PlannedBatch {
  return {
    index,
    modelAlias,
    items,
    questionIds,
    state: measured.state,
    questions: measured.questions,
    refs: measured.refs,
    estimatedTokens: measured.estimatedTokens,
  };
}

/** Строит план батчей без сетевых вызовов (он же основа `dry_run`). */
export function planBatches(options: BatchPlanOptions): BatchPlan {
  const { modelAlias, limits, rubric, items } = options;
  const questionIds = Object.keys(rubric.questions);
  const apiIds = assignApiItemIds(items);
  const plannedItems: PlannedItem[] = items.map((item, index) => ({
    ...item,
    apiId: apiIds[index] ?? item.id,
  }));

  const safeRequest = safeRequestLimit(limits.contextWindow);
  const safePerQuestion = safeRequestLimit(limits.perQuestionWindow);
  const maxQuestionsPerRequest = Math.max(1, limits.maxQuestionsPerRequest);
  const chunks = questionChunks(questionIds, maxQuestionsPerRequest);

  const batches: PlannedBatch[] = [];
  // Дедуп по apiId: два элемента с одинаковым исходным item_id не схлопываются,
  // а один и тот же apiId в разных чанках дополняет список вопросов.
  const skippedByApiId = new Map<string, SkippedItem>();

  for (const chunk of chunks) {
    const maxItemsByCount = Math.max(
      1,
      Math.floor(maxQuestionsPerRequest / Math.max(1, chunk.length)),
    );
    let current: PlannedItem[] = [];
    let measured: MeasuredBatch | null = null;

    for (const item of plannedItems) {
      const candidateItems = [...current, item];
      const candidate = measureBatch(rubric.guide, candidateItems, chunk, rubric);
      const fits =
        candidateItems.length <= maxItemsByCount &&
        candidate.estimatedTokens <= safeRequest &&
        candidate.perQuestionTokens <= safePerQuestion;

      if (fits) {
        current = candidateItems;
        measured = candidate;
        continue;
      }

      if (current.length > 0 && measured !== null) {
        batches.push(
          toBatch(batches.length, modelAlias, current, chunk, measured),
        );
        current = [];
        measured = null;
      }

      const solo = measureBatch(rubric.guide, [item], chunk, rubric);
      const soloFits =
        solo.estimatedTokens <= safeRequest &&
        solo.perQuestionTokens <= safePerQuestion;
      if (soloFits) {
        current = [item];
        measured = solo;
      } else {
        const existing = skippedByApiId.get(item.apiId);
        if (existing === undefined) {
          skippedByApiId.set(item.apiId, {
            itemId: item.id,
            apiId: item.apiId,
            questionIds: [...chunk],
            reason: "skipped_too_large",
            estimatedTokens: solo.estimatedTokens,
          });
        } else {
          for (const questionId of chunk) {
            if (!existing.questionIds.includes(questionId)) {
              existing.questionIds.push(questionId);
            }
          }
          existing.estimatedTokens = Math.max(
            existing.estimatedTokens,
            solo.estimatedTokens,
          );
        }
      }
    }

    if (current.length > 0 && measured !== null) {
      batches.push(toBatch(batches.length, modelAlias, current, chunk, measured));
    }
  }

  return {
    modelAlias,
    rubric,
    batches,
    skipped: [...skippedByApiId.values()],
    questionsPerItem: questionIds.length,
    estimatedTokens: batches.reduce(
      (total, batch) => total + batch.estimatedTokens,
      0,
    ),
  };
}

// --- Исполнение плана ------------------------------------------------------

export interface BatchedAnswer {
  itemId: string;
  questionId: string;
  /** Ключ, под которым ответ пришёл в `answers` провайдера. */
  apiKey: string;
  answer: NormalizedAnswer;
}

export interface BatcherFailure {
  batchIndex: number;
  itemIds: string[];
  kind: ProviderErrorKind;
  status: number | null;
  /** `trace_id` шлюза из тела ошибки: нужен для аудита и обращения в поддержку. */
  traceId: string | null;
  message: string;
}

export interface BatcherRunResult {
  answers: BatchedAnswer[];
  /** Изолированные элементы со статусом `safety_blocked`. */
  blocked: BatchedAnswer[];
  failures: BatcherFailure[];
  /**
   * Число обращений к `decide`, включая деление при safety. Внутренние
   * ретраи провайдера (429/5xx) здесь не видны.
   */
  batchesTotal: number;
  usage: ProviderUsage;
}

export interface RunPlanOptions {
  /**
   * Одновременных HTTP-вызовов. По умолчанию 1: движок передаёт
   * `DECIDE_MAX_CONCURRENCY` из конфига.
   */
  concurrency?: number;
}

type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

function createLimiter(max: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    }
  };
}

function accumulateUsage(target: ProviderUsage, usage: ProviderUsage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  if (usage.costRub !== undefined) {
    target.costRub = (target.costRub ?? 0) + usage.costRub;
  }
  if (usage.costUsd !== undefined) {
    target.costUsd = (target.costUsd ?? 0) + usage.costUsd;
  }
}

function rebuildBatch(
  plan: BatchPlan,
  batch: PlannedBatch,
  items: PlannedItem[],
): PlannedBatch {
  const measured = measureBatch(
    plan.rubric.guide,
    items,
    batch.questionIds,
    plan.rubric,
  );
  return {
    ...batch,
    items,
    state: measured.state,
    questions: measured.questions,
    refs: measured.refs,
    estimatedTokens: measured.estimatedTokens,
  };
}

interface RunContext {
  provider: DecisionProvider;
  limit: Limiter;
  answers: BatchedAnswer[];
  blocked: BatchedAnswer[];
  failures: BatcherFailure[];
  batchesTotal: number;
  usage: ProviderUsage;
}

async function runBatch(
  plan: BatchPlan,
  batch: PlannedBatch,
  context: RunContext,
): Promise<void> {
  context.batchesTotal += 1;
  try {
    const response = await context.limit(() =>
      context.provider.decide({
        modelAlias: batch.modelAlias,
        state: batch.state,
        questions: batch.questions,
      }),
    );
    accumulateUsage(context.usage, response.usage);

    for (const [apiKey, answer] of Object.entries(response.answers)) {
      const ref = batch.refs[apiKey];
      if (ref === undefined) continue;
      context.answers.push({
        itemId: ref.itemId,
        questionId: ref.questionId,
        apiKey,
        answer,
      });
    }
    return;
  } catch (thrown) {
    const error =
      thrown instanceof ProviderError
        ? thrown
        : new ProviderError(
            "provider_error",
            thrown instanceof Error ? thrown.message : String(thrown),
            { status: null, retryable: false },
          );

    if (error.splittable && batch.items.length > 1) {
      const middle = Math.ceil(batch.items.length / 2);
      for (const half of [batch.items.slice(0, middle), batch.items.slice(middle)]) {
        await runBatch(plan, rebuildBatch(plan, batch, half), context);
      }
      return;
    }

    if (error.splittable) {
      for (const [apiKey, ref] of Object.entries(batch.refs)) {
        const question = batch.questions[apiKey];
        if (question === undefined) continue;
        context.blocked.push({
          itemId: ref.itemId,
          questionId: ref.questionId,
          apiKey,
          answer: {
            type: primitiveTypeOf(question),
            status: "safety_blocked",
            confidence: 0,
            confidenceSource: "none",
          },
        });
      }
      return;
    }

    context.failures.push({
      batchIndex: batch.index,
      itemIds: batch.items.map((item) => item.id),
      kind: error.kind,
      status: error.status,
      traceId: error.traceId,
      message: error.message,
    });
  }
}

function compareAnswers(left: BatchedAnswer, right: BatchedAnswer): number {
  if (left.itemId !== right.itemId) return left.itemId < right.itemId ? -1 : 1;
  if (left.questionId !== right.questionId) {
    return left.questionId < right.questionId ? -1 : 1;
  }
  return 0;
}

/**
 * Исполняет план: пул параллельности, деление батча при safety-блокировке,
 * изоляция `safety_blocked` и фиксация остальных ошибок без повторов.
 */
export async function runPlan(
  plan: BatchPlan,
  provider: DecisionProvider,
  options: RunPlanOptions = {},
): Promise<BatcherRunResult> {
  const context: RunContext = {
    provider,
    limit: createLimiter(Math.max(1, options.concurrency ?? 1)),
    answers: [],
    blocked: [],
    failures: [],
    batchesTotal: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  await Promise.all(
    plan.batches.map((batch) => runBatch(plan, batch, context)),
  );

  context.answers.sort(compareAnswers);
  context.blocked.sort(compareAnswers);

  return {
    answers: context.answers,
    blocked: context.blocked,
    failures: context.failures,
    batchesTotal: context.batchesTotal,
    usage: context.usage,
  };
}
