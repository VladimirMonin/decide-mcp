/**
 * Фасад ядра: `runDecision`, `queryRun`, `listModels`
 * (docs/architecture/system.md §3, docs/architecture/contracts.md §3).
 *
 * Движок не отдаёт агенту сырые данные: только компактную сводку, ограниченный
 * топ и сохранённый `run_id`. Все тяжёлые данные остаются в SQLite и читаются
 * через `queryRun`.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  batchLimitsFor,
  planBatches,
  runPlan,
  type BatchPlan,
  type BatcherItem,
} from "./batcher.js";
import { projectRoot, type AppConfig } from "./config.js";
import { getModel, listModels as listRegistryModels, type ResolvedModel } from "./registry.js";
import {
  sourceSchema,
  validateRubric,
  type FilterExpr,
  type Projection,
  type Rubric,
  type Source,
} from "./schema.js";
import {
  loadRunContent,
  readSource,
  resolveInsideRoot,
  type SourceItem,
} from "./sources.js";
import {
  aggregateRun,
  compareRuns,
  filterRun,
  inspectRun,
  type AggregateResult,
  type AnswerView,
  type CompareResult,
  type FilterResult,
  type InspectResult,
  type SortSpec,
} from "./query.js";
import {
  RunStore,
  createRunId,
  type ItemStatus,
  type RunStatus,
  type StoreItemInput,
} from "./store.js";
import type { DecisionProvider, ProviderUsage } from "./providers/types.js";
import type { ModelAlias, ProviderName } from "./types.js";

export type EngineErrorCode =
  | "invalid_rubric"
  | "invalid_source"
  | "invalid_request"
  | "provider_required"
  | "provider_mismatch";

export class EngineError extends Error {
  override readonly name = "EngineError";

  constructor(
    readonly code: EngineErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface RunDecisionInput {
  model?: ModelAlias;
  provider?: ProviderName;
  source: unknown;
  scope?: "whole" | "per_item";
  /** Inline-рубрика или путь к JSON-пресету внутри `rubrics/`. */
  rubric: unknown;
  dry_run?: boolean;
  return_top?: number;
  sort_by?: SortSpec;
}

export type SummaryEntry =
  | {
      type: "bool";
      count: number;
      avg_prob: number | null;
      buckets: Record<string, number>;
    }
  | { type: "choice"; count: number; counts: Record<string, number> }
  | {
      type: "score";
      count: number;
      min: number | null;
      avg: number | null;
      max: number | null;
      buckets: Record<string, number>;
    };

export interface RunStats {
  items_total: number;
  items_processed: number;
  items_skipped: number;
  items_blocked: number;
  batches_total: number;
  input_tokens: number;
  output_tokens: number;
  cost_rub: number | null;
  cost_usd: number | null;
  duration_ms: number;
}

export interface RunPlanSummary {
  batches: number;
  estimated_tokens: number;
  questions_per_item: number;
  items_skipped: number;
}

export interface TopItem {
  item_id: string;
  preview: string | null;
  answers: Record<string, AnswerView>;
}

export interface RunDecisionOutput {
  run_id: string | null;
  status: RunStatus | "dry_run";
  dry_run: boolean;
  provider: ProviderName;
  model_alias: ModelAlias;
  model_id: string;
  stats: RunStats;
  warnings: string[];
  summary: Record<string, SummaryEntry>;
  top_items: TopItem[];
  plan?: RunPlanSummary;
}

export interface DecisionQueryInput {
  action: "filter" | "aggregate" | "inspect" | "compare";
  run_id: string;
  compare_run_id?: string;
  where?: FilterExpr;
  sort_by?: SortSpec;
  limit?: number;
  offset?: number;
  item_ids?: string[];
  context_window?: number;
  projection?: Projection;
}

export type QueryRunOutput =
  | { action: "filter"; result: FilterResult }
  | { action: "aggregate"; result: AggregateResult }
  | { action: "inspect"; result: InspectResult }
  | { action: "compare"; result: CompareResult };

export interface ModelPassportView {
  alias: ModelAlias;
  provider_model_id: string;
  context_window: number;
  max_questions_per_request: number;
  max_score_levels: number;
  supports_media: false;
  recommended_for: string;
}

export interface ModelsOutput {
  active_provider: ProviderName;
  default_model: ModelAlias;
  models: ModelPassportView[];
  presets: string[];
}

export interface DecisionEngineOptions {
  config: AppConfig;
  provider?: DecisionProvider;
  /** Внешнее хранилище (тесты); иначе открывается по `config.dbPath`. */
  store?: RunStore;
  now?: () => Date;
  runIdSuffix?: () => string;
}

const RETURN_TOP_DEFAULT = 15;
const RETURN_TOP_MAX = 50;
const PREVIEW_CHARS = 300;

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function previewOf(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
}

function parseSource(input: unknown): Source {
  const parsed = sourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new EngineError(
      "invalid_source",
      `Некорректный source: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "source"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * Читает пресет рубрики. Путь проверяется как путь источника: лексически и
 * через `realpath`, поэтому symlink/junction из `rubrics/` наружу не уводит.
 */
export function loadRubric(
  input: unknown,
  rubricsDir: string = path.join(projectRoot(), "rubrics"),
): unknown {
  if (typeof input !== "string") return input;

  let absolute: string;
  try {
    absolute = resolveInsideRoot(input, rubricsDir);
  } catch (error) {
    throw new EngineError(
      "invalid_rubric",
      `Путь к рубрике должен быть внутри rubrics/: ${input} (${(error as Error).message})`,
    );
  }

  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new EngineError(
      "invalid_rubric",
      `Не удалось прочитать рубрику ${input}: ${(error as Error).message}`,
    );
  }
}

const ITEM_STATUS_PRIORITY: Record<ItemStatus, number> = {
  pending: 0,
  skipped_too_large: 1,
  ok: 2,
  safety_blocked: 3,
  error: 4,
};

/**
 * Приоритет статусов элемента: error > safety_blocked > ok > skipped_too_large.
 * Один элемент может получить несколько наблюдений (чанки вопросов, ошибка
 * батча), и «последний писатель» не должен понижать статус.
 */
export function resolveItemStatus(
  current: ItemStatus,
  observed: ItemStatus,
): ItemStatus {
  return ITEM_STATUS_PRIORITY[observed] > ITEM_STATUS_PRIORITY[current]
    ? observed
    : current;
}

function defaultSortBy(rubric: Rubric): SortSpec | undefined {
  for (const [questionId, question] of Object.entries(rubric.questions)) {
    if (question.type === "score") {
      return { questionId, field: "score", order: "desc" };
    }
  }
  for (const [questionId, question] of Object.entries(rubric.questions)) {
    if (question.type === "bool") {
      return { questionId, field: "prob", order: "desc" };
    }
  }
  return undefined;
}

function toSummary(aggregate: AggregateResult): Record<string, SummaryEntry> {
  const summary: Record<string, SummaryEntry> = {};
  for (const [questionId, question] of Object.entries(aggregate.questions)) {
    if (question.type === "bool") {
      summary[questionId] = {
        type: "bool",
        count: question.statusCounts.ok,
        avg_prob: question.avgProb,
        buckets: question.buckets,
      };
    } else if (question.type === "choice") {
      summary[questionId] = {
        type: "choice",
        count: question.statusCounts.ok,
        counts: question.counts,
      };
    } else {
      summary[questionId] = {
        type: "score",
        count: question.statusCounts.ok,
        min: question.minScore,
        avg: question.avgScore,
        max: question.maxScore,
        buckets: question.buckets,
      };
    }
  }
  return summary;
}

function mergeWholeItems(items: SourceItem[]): BatcherItem {
  const content = items
    .map((item) => `--- ${item.id} (seq ${item.seqIndex}) ---\n${item.content}`)
    .join("\n\n");
  return { id: "whole", content };
}

async function forEachWithConcurrency<T>(
  values: T[],
  limit: number,
  worker: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, values.length)) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        const value = values[index];
        if (value === undefined) return;
        await worker(value, index);
      }
    },
  );
  await Promise.all(workers);
}

export class DecisionEngine {
  private readonly config: AppConfig;
  private readonly provider: DecisionProvider | undefined;
  private readonly now: () => Date;
  private readonly runIdSuffix: () => string;
  private store: RunStore | null;
  private readonly ownsStore: boolean;

  constructor(options: DecisionEngineOptions) {
    this.config = options.config;
    this.provider = options.provider;
    this.now = options.now ?? (() => new Date());
    this.runIdSuffix =
      options.runIdSuffix ?? (() => Math.random().toString(16).slice(2, 6).padEnd(4, "0"));
    this.store = options.store ?? null;
    this.ownsStore = options.store === undefined;
  }

  /** Закрывает хранилище, открытое самим движком. */
  close(): void {
    if (this.ownsStore) this.store?.close();
    this.store = null;
  }

  private getStore(): RunStore {
    if (this.store === null) this.store = new RunStore(this.config.dbPath);
    return this.store;
  }

  private requireProvider(): DecisionProvider {
    if (this.provider === undefined) {
      throw new EngineError(
        "provider_required",
        "Для живого прогона нужен DecisionProvider",
      );
    }
    return this.provider;
  }

  async runDecision(input: RunDecisionInput): Promise<RunDecisionOutput> {
    if (input.provider !== undefined && input.provider !== this.config.provider.name) {
      throw new EngineError(
        "provider_mismatch",
        `Движок настроен на провайдера ${this.config.provider.name}, а запрошен ${input.provider}`,
      );
    }

    const modelAlias = input.model ?? this.config.defaultModel;
    const model = getModel(modelAlias, this.config.provider.name);
    const scope = input.scope ?? "per_item";
    if (scope !== "per_item" && scope !== "whole") {
      throw new EngineError("invalid_request", `Неизвестный scope: ${String(scope)}`);
    }

    const source = parseSource(input.source);
    const validation = validateRubric(loadRubric(input.rubric), { model: modelAlias });
    if (!validation.ok || validation.rubric === null) {
      throw new EngineError(
        "invalid_rubric",
        validation.errors.map((error) => `${error.path}: ${error.message}`).join("; "),
      );
    }
    const rubric = validation.rubric;

    // Живой прогон без провайдера должен падать до чтения источника.
    const liveProvider = input.dry_run === true ? null : this.requireProvider();

    const sourceItems = await readSource(source, {
      allowedRoot: this.config.allowedRoot,
      // from_run читает родительский прогон; для остальных типов хранилище не нужно.
      store: source.type === "from_run" ? this.getStore() : undefined,
    });

    const batcherItems: BatcherItem[] =
      sourceItems.length === 0
        ? []
        : scope === "whole"
          ? [mergeWholeItems(sourceItems)]
          : sourceItems.map((item) => ({ id: item.id, content: item.content }));

    const plan = planBatches({
      modelAlias,
      limits: batchLimitsFor(model),
      rubric,
      items: batcherItems,
    });

    const warnings = validation.warnings.map(
      (warning) => `${warning.path}: ${warning.message}`,
    );
    for (const skipped of plan.skipped) {
      warnings.push(
        `Элемент ${skipped.itemId} не помещается в окно модели (${skipped.estimatedTokens} токенов) и будет пропущен.`,
      );
    }

    const returnTop = Math.min(
      input.return_top ?? RETURN_TOP_DEFAULT,
      RETURN_TOP_MAX,
    );

    if (input.dry_run === true) {
      return {
        run_id: null,
        status: "dry_run",
        dry_run: true,
        provider: this.config.provider.name,
        model_alias: modelAlias,
        model_id: model.modelId,
        stats: {
          items_total: batcherItems.length,
          items_processed: 0,
          items_skipped: plan.skipped.length,
          items_blocked: 0,
          batches_total: plan.batches.length,
          input_tokens: 0,
          output_tokens: 0,
          cost_rub: null,
          cost_usd: null,
          duration_ms: 0,
        },
        warnings,
        summary: {},
        top_items: [],
        plan: {
          batches: plan.batches.length,
          estimated_tokens: plan.estimatedTokens,
          questions_per_item: plan.questionsPerItem,
          items_skipped: plan.skipped.length,
        },
      };
    }

    const provider = liveProvider;
    if (provider === null) {
      throw new EngineError("provider_required", "Для живого прогона нужен DecisionProvider");
    }
    const store = this.getStore();
    const startedMs = Date.now();
    const runId = createRunId(this.now(), this.runIdSuffix());

    let storeItems: StoreItemInput[] = [];
    const wholeItem = batcherItems[0];
    if (scope === "whole" && wholeItem !== undefined) {
      storeItems = [
        {
          itemId: wholeItem.id,
          seqIndex: 0,
          sourceRef: null,
          meta: { source_items: sourceItems.map((item) => item.id) },
          preview: previewOf(wholeItem.content),
          contentHash: hashContent(wholeItem.content),
          status: "pending",
        },
      ];
    } else if (scope === "per_item") {
      storeItems = sourceItems.map((item) => ({
        itemId: item.id,
        seqIndex: item.seqIndex,
        sourceRef: item.sourceRef,
        meta: item.meta,
        preview: previewOf(item.content),
        contentHash: hashContent(item.content),
        status: "pending",
      }));
    }

    const parentRunId = source.type === "from_run" ? source.run_id : null;
    store.createRun({
      runId,
      createdAt: this.now().toISOString(),
      provider: this.config.provider.name,
      modelAlias,
      modelId: model.modelId,
      scope,
      sourceJson: JSON.stringify(source),
      rubricJson: JSON.stringify(rubric),
      parentRunId,
      itemsTotal: batcherItems.length,
    });
    store.addItems(runId, storeItems);

    const skippedIds = new Set(plan.skipped.map((skipped) => skipped.itemId));
    const itemStatuses = new Map<string, ItemStatus>();
    for (const itemId of skippedIds) {
      itemStatuses.set(itemId, "skipped_too_large");
      store.markItemStatus(runId, itemId, "skipped_too_large", "skipped_too_large");
    }

    const failureMessages: string[] = [];
    const noteProblem = (message: string): void => {
      if (!failureMessages.includes(message)) failureMessages.push(message);
    };
    const usage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };
    const responseModels = new Set<string>();
    let batchesTotal = 0;

    /** Повышает статус элемента по приоритету и пишет его в SQLite. */
    const markItem = (
      itemId: string,
      observed: ItemStatus,
      errorCode: string | null = null,
    ): void => {
      const current = itemStatuses.get(itemId) ?? "pending";
      const next = resolveItemStatus(current, observed);
      if (next === current) return;
      itemStatuses.set(itemId, next);
      try {
        store.markItemStatus(runId, itemId, next, errorCode);
      } catch (error) {
        noteProblem(
          `Не удалось обновить статус ${itemId}: ${(error as Error).message}`,
        );
      }
    };

    const countStatuses = (): {
      processed: number;
      skipped: number;
      blocked: number;
    } => {
      let processed = 0;
      let skipped = 0;
      let blocked = 0;
      for (const status of itemStatuses.values()) {
        if (status === "ok") processed += 1;
        else if (status === "skipped_too_large") skipped += 1;
        else if (status === "safety_blocked") blocked += 1;
      }
      return { processed, skipped, blocked };
    };

    // Счётчики исключающие: processed + skipped + blocked не больше items_total.
    const persistTotals = (): void => {
      const counts = countStatuses();
      try {
        store.updateProgress(runId, {
          itemsProcessed: counts.processed,
          itemsSkipped: counts.skipped,
          itemsBlocked: counts.blocked,
          batchesTotal,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costRub: usage.costRub,
          costUsd: usage.costUsd,
        });
      } catch (error) {
        noteProblem(
          `Не удалось обновить счётчики прогона: ${(error as Error).message}`,
        );
      }
    };

    const batchPlans: BatchPlan[] = plan.batches.map((batch) => ({
      ...plan,
      batches: [batch],
    }));

    try {
      await forEachWithConcurrency(
        batchPlans,
        this.config.maxConcurrency,
        async (singleBatchPlan) => {
          const batch = singleBatchPlan.batches[0];
          try {
            const result = await runPlan(singleBatchPlan, provider, {
              concurrency: 1,
            });
            batchesTotal += result.batchesTotal;
            usage.inputTokens += result.usage.inputTokens;
            usage.outputTokens += result.usage.outputTokens;
            if (result.usage.costRub !== undefined) {
              usage.costRub = (usage.costRub ?? 0) + result.usage.costRub;
            }
            if (result.usage.costUsd !== undefined) {
              usage.costUsd = (usage.costUsd ?? 0) + result.usage.costUsd;
            }
            if (result.responseModel !== null) {
              responseModels.add(result.responseModel);
            }

            store.saveAnswers(
              runId,
              [...result.answers, ...result.blocked].map((entry) => ({
                itemId: entry.itemId,
                questionId: entry.questionId,
                answer: entry.answer,
                traceId: null,
              })),
            );

            for (const entry of result.answers) {
              if (entry.answer.status === "safety_blocked") {
                markItem(entry.itemId, "safety_blocked", "safety_blocked");
              } else {
                markItem(entry.itemId, "ok", null);
              }
            }
            for (const entry of result.blocked) {
              markItem(entry.itemId, "safety_blocked", "safety_blocked");
            }
            for (const failure of result.failures) {
              noteProblem(
                `batch ${failure.batchIndex}: ${failure.kind}${failure.traceId ? ` (trace ${failure.traceId})` : ""}: ${failure.message}`,
              );
              for (const itemId of failure.itemIds) {
                markItem(itemId, "error", failure.kind);
              }
            }

            persistTotals();
          } catch (error) {
            // Сбой сохранения/исполнения не должен ронять весь прогон:
            // фиксируем проблему и помечаем элементы батча ошибкой.
            noteProblem(
              `batch ${batch?.index ?? -1}: internal_error: ${(error as Error).message}`,
            );
            for (const item of batch?.items ?? []) {
              markItem(item.id, "error", "internal_error");
            }
            persistTotals();
          }
        },
      );
    } catch (error) {
      // Последний рубеж: даже неожиданный сбой не отменяет finishRun ниже.
      noteProblem(`execution: internal_error: ${(error as Error).message}`);
    }

    const total = batcherItems.length;
    const counts = countStatuses();
    const cleanRun = counts.processed === total && failureMessages.length === 0;
    const status: RunStatus = cleanRun
      ? "completed"
      : counts.processed === 0 && failureMessages.length > 0
        ? "failed"
        : "partial";

    // finishRun вызывается всегда: иначе при сбое батча прогон навсегда
    // остался бы в статусе running.
    store.finishRun(runId, {
      status,
      itemsProcessed: counts.processed,
      itemsSkipped: counts.skipped,
      itemsBlocked: counts.blocked,
      batchesTotal,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costRub: usage.costRub,
      costUsd: usage.costUsd,
      durationMs: Date.now() - startedMs,
      // Обычно версия одна; если шлюз ответил разными, сохраняем обе через запятую.
      responseModel:
        responseModels.size === 0 ? null : [...responseModels].join(", "),
      errorSummary: failureMessages.length === 0 ? null : failureMessages.join("; "),
    });

    const aggregate = aggregateRun(store, { runId });
    const sortBy = input.sort_by ?? defaultSortBy(rubric);
    const top = filterRun(store, {
      runId,
      sortBy,
      limit: returnTop,
    });

    return {
      run_id: runId,
      status,
      dry_run: false,
      provider: this.config.provider.name,
      model_alias: modelAlias,
      model_id: model.modelId,
      stats: {
        items_total: total,
        items_processed: counts.processed,
        items_skipped: counts.skipped,
        items_blocked: counts.blocked,
        batches_total: batchesTotal,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cost_rub: usage.costRub ?? null,
        cost_usd: usage.costUsd ?? null,
        duration_ms: Date.now() - startedMs,
      },
      warnings,
      summary: toSummary(aggregate),
      top_items: top.items.map((item) => ({
        item_id: item.itemId,
        preview: item.preview,
        answers: item.answers,
      })),
    };
  }

  async queryRun(input: DecisionQueryInput): Promise<QueryRunOutput> {
    const store = this.getStore();
    switch (input.action) {
      case "filter":
        return {
          action: "filter",
          result: filterRun(store, {
            runId: input.run_id,
            where: input.where,
            sortBy: input.sort_by,
            limit: input.limit,
            offset: input.offset,
          }),
        };
      case "aggregate":
        return { action: "aggregate", result: aggregateRun(store, { runId: input.run_id }) };
      case "compare":
        if (input.compare_run_id === undefined) {
          throw new EngineError(
            "invalid_request",
            "Для action=compare нужен compare_run_id",
          );
        }
        return {
          action: "compare",
          result: compareRuns(store, {
            runId: input.run_id,
            compareRunId: input.compare_run_id,
          }),
        };
      case "inspect":
        return {
          action: "inspect",
          result: await inspectRun(
            store,
            {
              runId: input.run_id,
              itemIds: input.item_ids ?? [],
              contextWindow: input.context_window,
              projection: input.projection,
            },
            {
              loadContent: async (run, itemIds, projection) => {
                const loaded = await loadRunContent(run, itemIds, projection, {
                  allowedRoot: this.config.allowedRoot,
                  store,
                });
                return {
                  content: loaded.content,
                  warnings: loaded.changed.map(
                    (itemId) => `Источник изменился после прогона: ${itemId}`,
                  ),
                };
              },
            },
          ),
        };
      default:
        throw new EngineError(
          "invalid_request",
          `Неизвестный action: ${String((input as { action?: unknown }).action)}`,
        );
    }
  }

  listModels(): ModelsOutput {
    const models: ModelPassportView[] = listRegistryModels(
      this.config.provider.name,
    ).map((model: ResolvedModel) => ({
      alias: model.alias,
      provider_model_id: model.modelId,
      context_window: model.contextWindow,
      max_questions_per_request: model.maxQuestionsPerRequest,
      max_score_levels: model.maxScoreLevels,
      supports_media: model.supportsMedia,
      recommended_for: model.recommendedFor,
    }));

    let presets: string[] = [];
    try {
      presets = readdirSync(path.join(projectRoot(), "rubrics"))
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => `rubrics/${file}`);
    } catch {
      presets = [];
    }

    return {
      active_provider: this.config.provider.name,
      default_model: this.config.defaultModel,
      models,
      presets,
    };
  }
}
