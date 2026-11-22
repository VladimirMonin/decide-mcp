/**
 * Безопасные запросы к сохранённым прогонам (`decide_query`).
 *
 * Никакого сырого SQL от агента: `FilterExpr` компилируется в параметризованный
 * запрос по белому списку полей и операторов, сортировка — по тем же колонкам.
 * Режимы: `filter`, `aggregate`, `inspect`, `compare`
 * (docs/architecture/contracts.md §3).
 */
import {
  filterExprSchema,
  type FilterCondition,
  type FilterExpr,
  type FilterField,
  type Projection,
} from "./schema.js";
import type {
  AnswerRecord,
  AnswerStatus,
  ItemStatus,
  RunRecord,
  RunStore,
  SqlValue,
} from "./store.js";
import type {
  ConfidenceSource,
  NormalizedAnswerType,
} from "./providers/types.js";

export type QueryErrorCode = "run_not_found" | "invalid_query" | "too_many_items";

export class QueryError extends Error {
  override readonly name = "QueryError";

  constructor(
    readonly code: QueryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type SortOrder = "asc" | "desc";

export interface SortSpec {
  questionId: string;
  field: FilterField;
  order?: SortOrder;
}

export interface FilterQueryInput {
  runId: string;
  where?: FilterExpr;
  sortBy?: SortSpec;
  limit?: number;
  offset?: number;
}

export interface AnswerView {
  type: NormalizedAnswerType;
  status: AnswerStatus;
  prob?: number;
  score?: number;
  choice?: string;
  confidence: number;
  confidenceSource: ConfidenceSource;
  probabilities?: Record<string, number> | number[];
}

export interface FilteredItem {
  itemId: string;
  seqIndex: number;
  status: ItemStatus;
  preview: string | null;
  answers: Record<string, AnswerView>;
}

export interface FilterResult {
  runId: string;
  /** Сколько элементов подходит под фильтр всего (до limit/offset). */
  total: number;
  items: FilteredItem[];
}

export const FILTER_LIMIT_DEFAULT = 20;
export const FILTER_LIMIT_MAX = 200;
export const INSPECT_MAX_ITEMS = 20;
export const INSPECT_MAX_CONTEXT = 10;

const FIELD_COLUMN: Record<FilterField, string> = {
  prob: "prob",
  score: "score_value",
  choice: "choice_value",
  confidence: "confidence",
};

const OP_SQL: Record<Exclude<FilterCondition["op"], "in">, string> = {
  ">=": ">=",
  ">": ">",
  "<=": "<=",
  "<": "<",
  "=": "=",
  "!=": "!=",
};

function assertRun(store: RunStore, runId: string): RunRecord {
  const run = store.getRun(runId);
  if (run === null) {
    throw new QueryError("run_not_found", `Прогон не найден: ${runId}`);
  }
  return run;
}

function parseWhere(input: unknown): FilterExpr | undefined {
  if (input === undefined) return undefined;
  const parsed = filterExprSchema.safeParse(input);
  if (!parsed.success) {
    throw new QueryError(
      "invalid_query",
      `Некорректный FilterExpr: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "where"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function compileCondition(
  runId: string,
  condition: FilterCondition,
): { sql: string; params: SqlValue[] } {
  const column = FIELD_COLUMN[condition.field];
  const base = `a.run_id = ? AND a.item_id = items.item_id AND a.question_id = ?`;

  if (condition.op === "in") {
    if (!Array.isArray(condition.value)) {
      throw new QueryError(
        "invalid_query",
        `Оператор "in" для ${condition.question_id} требует массив значений`,
      );
    }
    const placeholders = condition.value.map(() => "?").join(", ");
    return {
      sql: `EXISTS (SELECT 1 FROM answers a WHERE ${base} AND a.${column} IN (${placeholders}))`,
      params: [runId, condition.question_id, ...condition.value],
    };
  }

  if (Array.isArray(condition.value)) {
    throw new QueryError(
      "invalid_query",
      `Оператор "${condition.op}" для ${condition.question_id} не принимает массив`,
    );
  }
  return {
    sql: `EXISTS (SELECT 1 FROM answers a WHERE ${base} AND a.${column} ${OP_SQL[condition.op]} ?)`,
    params: [runId, condition.question_id, condition.value],
  };
}

/**
 * Компилирует `FilterExpr` в SQL-фрагмент с `?`-параметрами.
 * `runId` подставляется в каждый подзапрос — фильтр всегда в рамках прогона.
 */
function compileWhere(
  runId: string,
  where: FilterExpr | undefined,
): { sql: string; params: SqlValue[] } {
  if (where === undefined || where.conditions.length === 0) {
    return { sql: "", params: [] };
  }
  const logic = where.logic === "or" ? " OR " : " AND ";
  const parts = where.conditions.map((condition) => {
    const compiled = compileCondition(runId, condition);
    return { sql: `(${compiled.sql})`, params: compiled.params };
  });
  return {
    sql: ` AND (${parts.map((part) => part.sql).join(logic)})`,
    params: parts.flatMap((part) => part.params),
  };
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new QueryError("invalid_query", `limit должен быть положительным целым: ${value}`);
  }
  return Math.min(value, max);
}

function parseSort(sortBy: SortSpec | undefined): SortSpec | undefined {
  if (sortBy === undefined) return undefined;
  if (sortBy.field === undefined || FIELD_COLUMN[sortBy.field] === undefined) {
    throw new QueryError(
      "invalid_query",
      `Неизвестное поле сортировки: ${String(sortBy.field)}`,
    );
  }
  const order = sortBy.order ?? "desc";
  if (order !== "asc" && order !== "desc") {
    throw new QueryError("invalid_query", `Неизвестный порядок сортировки: ${order}`);
  }
  return { ...sortBy, order };
}

function parseProbabilities(record: AnswerRecord): AnswerView["probabilities"] {
  if (record.probabilitiesJson === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(record.probabilitiesJson);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "number")) {
      return parsed;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      );
      return Object.fromEntries(entries);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function toAnswerView(record: AnswerRecord): AnswerView {
  const view: AnswerView = {
    type: record.primitiveType,
    status: record.status,
    confidence: record.confidence,
    confidenceSource: record.confidenceSource,
  };
  if (record.prob !== null) view.prob = record.prob;
  if (record.scoreValue !== null) view.score = record.scoreValue;
  if (record.choiceValue !== null) view.choice = record.choiceValue;
  const probabilities = parseProbabilities(record);
  if (probabilities !== undefined) view.probabilities = probabilities;
  return view;
}

/**
 * Отбирает `item_id` по фильтру — используется `from_run`, чтобы не тащить
 * ответы целиком. Порядок — по `seq_index`.
 */
export function selectItemIds(
  store: RunStore,
  runId: string,
  options: { where?: FilterExpr; limit?: number } = {},
): string[] {
  assertRun(store, runId);
  const where = parseWhere(options.where);
  const compiled = compileWhere(runId, where);
  const params: SqlValue[] = [runId, ...compiled.params];
  const limitSql = options.limit === undefined ? "" : " LIMIT ?";
  if (options.limit !== undefined) params.push(options.limit);

  const rows = store.queryAll(
    `SELECT item_id FROM items WHERE run_id = ?${compiled.sql} ORDER BY seq_index, item_id${limitSql}`,
    params,
  );
  return rows.map((row) => String(row["item_id"]));
}

/** Режим `filter`: элементы и их ответы по декларативному фильтру. */
export function filterRun(store: RunStore, input: FilterQueryInput): FilterResult {
  assertRun(store, input.runId);
  const where = parseWhere(input.where);
  const sort = parseSort(input.sortBy);
  const limit = clampLimit(input.limit, FILTER_LIMIT_DEFAULT, FILTER_LIMIT_MAX);
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new QueryError("invalid_query", `offset должен быть >= 0: ${input.offset}`);
  }

  const compiled = compileWhere(input.runId, where);
  const countRow = store.queryOne(
    `SELECT COUNT(*) AS total FROM items WHERE run_id = ?${compiled.sql}`,
    [input.runId, ...compiled.params],
  );
  const total = typeof countRow?.["total"] === "number" ? countRow["total"] : 0;

  const params: SqlValue[] = [];
  let sql: string;
  if (sort === undefined) {
    sql = `SELECT items.* FROM items WHERE items.run_id = ?${compiled.sql}
      ORDER BY items.seq_index, items.item_id LIMIT ? OFFSET ?`;
    params.push(input.runId, ...compiled.params, limit, offset);
  } else {
    const column = FIELD_COLUMN[sort.field];
    sql = `SELECT items.* FROM items
      LEFT JOIN answers s ON s.run_id = items.run_id
        AND s.item_id = items.item_id AND s.question_id = ?
      WHERE items.run_id = ?${compiled.sql}
      ORDER BY (s.${column} IS NULL), s.${column} ${sort.order ?? "desc"}, items.seq_index, items.item_id
      LIMIT ? OFFSET ?`;
    params.push(sort.questionId, input.runId, ...compiled.params, limit, offset);
  }

  const itemRows = store.queryAll(sql, params);
  const itemIds = itemRows.map((row) => String(row["item_id"]));
  const answers = new Map<string, Record<string, AnswerView>>();
  for (const record of store.listAnswers(input.runId, itemIds)) {
    const perItem = answers.get(record.itemId) ?? {};
    perItem[record.questionId] = toAnswerView(record);
    answers.set(record.itemId, perItem);
  }

  return {
    runId: input.runId,
    total,
    items: itemRows.map((row) => ({
      itemId: String(row["item_id"]),
      seqIndex: Number(row["seq_index"]),
      status: row["status"] as ItemStatus,
      preview: typeof row["preview"] === "string" ? row["preview"] : null,
      answers: answers.get(String(row["item_id"])) ?? {},
    })),
  };
}

// --- aggregate ------------------------------------------------------------

export type ItemStatusCounts = Record<ItemStatus, number>;
export type AnswerStatusCounts = Record<AnswerStatus, number>;

export interface BoolAggregate {
  type: "bool";
  count: number;
  statusCounts: AnswerStatusCounts;
  avgProb: number | null;
  buckets: Record<string, number>;
}

export interface ChoiceAggregate {
  type: "choice";
  count: number;
  statusCounts: AnswerStatusCounts;
  counts: Record<string, number>;
}

export interface ScoreAggregate {
  type: "score";
  count: number;
  statusCounts: AnswerStatusCounts;
  avgScore: number | null;
  minScore: number | null;
  maxScore: number | null;
  buckets: Record<string, number>;
}

export type QuestionAggregate = BoolAggregate | ChoiceAggregate | ScoreAggregate;

export interface AggregateResult {
  runId: string;
  itemsTotal: number;
  itemStatusCounts: ItemStatusCounts;
  /** Доли статусов элементов (0..1): `safety_blocked`, `skipped_too_large` и т.д. */
  itemStatusShares: ItemStatusCounts;
  questions: Record<string, QuestionAggregate>;
}

const ITEM_STATUSES: ItemStatus[] = [
  "pending",
  "ok",
  "skipped_too_large",
  "safety_blocked",
  "error",
];

function emptyItemStatusCounts(): ItemStatusCounts {
  return {
    pending: 0,
    ok: 0,
    skipped_too_large: 0,
    safety_blocked: 0,
    error: 0,
  };
}

function emptyAnswerStatusCounts(): AnswerStatusCounts {
  return { ok: 0, refusal: 0, safety_blocked: 0, error: 0 };
}

function boolBucket(prob: number): string {
  const index = Math.min(9, Math.max(0, Math.floor(prob * 10)));
  return `${(index / 10).toFixed(1)}..${((index + 1) / 10).toFixed(1)}`;
}

function scoreBucket(record: AnswerRecord): string | null {
  if (record.probabilitiesJson !== null) {
    try {
      const parsed: unknown = JSON.parse(record.probabilitiesJson);
      if (Array.isArray(parsed) && parsed.length > 0) {
        let best = 0;
        for (let index = 1; index < parsed.length; index += 1) {
          if (Number(parsed[index]) > Number(parsed[best])) best = index;
        }
        return String(best);
      }
    } catch {
      // битый JSON вероятностей — падаем на округление score
    }
  }
  return record.scoreValue === null ? null : String(Math.floor(record.scoreValue));
}

/** Гистограммы и агрегаты по всем ответам прогона. */
export function aggregateRun(
  store: RunStore,
  input: { runId: string },
): AggregateResult {
  assertRun(store, input.runId);
  const items = store.listItems(input.runId);
  const itemStatusCounts = emptyItemStatusCounts();
  for (const item of items) itemStatusCounts[item.status] += 1;

  const itemStatusShares = emptyItemStatusCounts();
  if (items.length > 0) {
    for (const status of ITEM_STATUSES) {
      itemStatusShares[status] = itemStatusCounts[status] / items.length;
    }
  }

  const answers = store.listAnswers(input.runId);
  const questions: Record<string, QuestionAggregate> = {};

  for (const record of answers) {
    let aggregate = questions[record.questionId];
    if (aggregate === undefined) {
      aggregate =
        record.primitiveType === "bool"
          ? {
              type: "bool",
              count: 0,
              statusCounts: emptyAnswerStatusCounts(),
              avgProb: null,
              buckets: {},
            }
          : record.primitiveType === "choice"
            ? {
                type: "choice",
                count: 0,
                statusCounts: emptyAnswerStatusCounts(),
                counts: {},
              }
            : {
                type: "score",
                count: 0,
                statusCounts: emptyAnswerStatusCounts(),
                avgScore: null,
                minScore: null,
                maxScore: null,
                buckets: {},
              };
      questions[record.questionId] = aggregate;
    }

    aggregate.count += 1;
    aggregate.statusCounts[record.status] += 1;

    if (record.status !== "ok") continue;

    if (aggregate.type === "bool" && record.prob !== null) {
      aggregate.avgProb = (aggregate.avgProb ?? 0) + record.prob;
      const bucket = boolBucket(record.prob);
      aggregate.buckets[bucket] = (aggregate.buckets[bucket] ?? 0) + 1;
    } else if (aggregate.type === "choice" && record.choiceValue !== null) {
      aggregate.counts[record.choiceValue] =
        (aggregate.counts[record.choiceValue] ?? 0) + 1;
    } else if (aggregate.type === "score" && record.scoreValue !== null) {
      aggregate.avgScore = (aggregate.avgScore ?? 0) + record.scoreValue;
      aggregate.minScore = Math.min(aggregate.minScore ?? record.scoreValue, record.scoreValue);
      aggregate.maxScore = Math.max(aggregate.maxScore ?? record.scoreValue, record.scoreValue);
      const bucket = scoreBucket(record);
      if (bucket !== null) aggregate.buckets[bucket] = (aggregate.buckets[bucket] ?? 0) + 1;
    }
  }

  // Средние считаем после накопления сумм.
  for (const aggregate of Object.values(questions)) {
    const okCount = aggregate.statusCounts.ok;
    if (okCount === 0) continue;
    if (aggregate.type === "bool" && aggregate.avgProb !== null) {
      aggregate.avgProb /= okCount;
    } else if (aggregate.type === "score" && aggregate.avgScore !== null) {
      aggregate.avgScore /= okCount;
    }
  }

  return {
    runId: input.runId,
    itemsTotal: items.length,
    itemStatusCounts,
    itemStatusShares,
    questions,
  };
}

// --- inspect --------------------------------------------------------------

export type ContentLoader = (
  run: RunRecord,
  itemIds: string[],
  projection: Projection | undefined,
) => Promise<{ content: Map<string, string>; warnings?: string[] }>;

export interface InspectInput {
  runId: string;
  itemIds: string[];
  contextWindow?: number;
  projection?: Projection;
}

export interface InspectItem {
  itemId: string;
  seqIndex: number;
  status: ItemStatus;
  preview: string | null;
  /** Полный текст из источника; `null`, если перезагрузить не удалось. */
  content: string | null;
  /** `false` для соседей, подтянутых через `context_window`. */
  target: boolean;
}

export interface InspectResult {
  runId: string;
  items: InspectItem[];
  missing: string[];
  /** `true`, если полный текст недоступен и отдан только preview. */
  contentTruncated: boolean;
  warnings: string[];
}

/** Режим `inspect`: полные тексты выбранных элементов и их соседей. */
export async function inspectRun(
  store: RunStore,
  input: InspectInput,
  options: { loadContent?: ContentLoader } = {},
): Promise<InspectResult> {
  const run = assertRun(store, input.runId);
  if (input.itemIds.length > INSPECT_MAX_ITEMS) {
    throw new QueryError(
      "too_many_items",
      `inspect принимает не больше ${INSPECT_MAX_ITEMS} item_id за вызов`,
    );
  }
  const window = input.contextWindow ?? 0;
  if (!Number.isInteger(window) || window < 0) {
    throw new QueryError("invalid_query", `context_window должен быть >= 0: ${input.contextWindow}`);
  }
  const context = Math.min(window, INSPECT_MAX_CONTEXT);

  const items = store.listItems(input.runId);
  const byId = new Map(items.map((item) => [item.itemId, item]));
  const targets = input.itemIds.filter((id) => byId.has(id));
  const missing = input.itemIds.filter((id) => !byId.has(id));

  const seqIndexes = new Set<number>();
  for (const targetId of targets) {
    const target = byId.get(targetId);
    if (target === undefined) continue;
    for (let seq = target.seqIndex - context; seq <= target.seqIndex + context; seq += 1) {
      seqIndexes.add(seq);
    }
  }

  const selected = items
    .filter((item) => seqIndexes.has(item.seqIndex))
    .sort((left, right) => left.seqIndex - right.seqIndex);
  const selectedIds = selected.map((item) => item.itemId);
  const targetSet = new Set(targets);

  let contentById = new Map<string, string>();
  const warnings: string[] = [];
  if (options.loadContent !== undefined && selectedIds.length > 0) {
    try {
      const loaded = await options.loadContent(
        run,
        selectedIds,
        input.projection,
      );
      contentById = loaded.content;
      if (loaded.warnings !== undefined) warnings.push(...loaded.warnings);
    } catch (error) {
      warnings.push((error as Error).message);
    }
  }

  const contentTruncated =
    options.loadContent === undefined ||
    selectedIds.some((id) => !contentById.has(id));

  const result: InspectItem[] = selected.map((item) => ({
    itemId: item.itemId,
    seqIndex: item.seqIndex,
    status: item.status,
    preview: item.preview,
    content: contentById.get(item.itemId) ?? null,
    target: targetSet.has(item.itemId),
  }));

  return { runId: input.runId, items: result, missing, contentTruncated, warnings };
}

// --- compare --------------------------------------------------------------

export interface CompareInput {
  runId: string;
  compareRunId: string;
}

export interface CompareContrast {
  itemId: string;
  left: number | string | null;
  right: number | string | null;
  diff: number | null;
}

export interface CompareQuestion {
  questionId: string;
  type: NormalizedAnswerType;
  matched: number;
  /** Среднее |left − right| для bool/score; `null` для choice. */
  meanAbsDiff: number | null;
  /** Доля совпавших ответов: для choice — тот же ключ, для bool — та же сторона 0.5. */
  agreement: number | null;
  contrasts: CompareContrast[];
}

export interface CompareResult {
  runId: string;
  compareRunId: string;
  commonQuestions: number;
  questions: Record<string, CompareQuestion>;
}

const COMPARE_CONTRASTS = 5;

interface PairValue {
  type: NormalizedAnswerType;
  numeric: number | null;
  choice: string | null;
  agreementKey: string | number | null;
}

function pairValue(record: AnswerRecord): PairValue | null {
  if (record.status !== "ok") return null;
  if (record.primitiveType === "bool") {
    if (record.prob === null) return null;
    return {
      type: "bool",
      numeric: record.prob,
      choice: null,
      agreementKey: record.prob >= 0.5 ? "true" : "false",
    };
  }
  if (record.primitiveType === "score") {
    if (record.scoreValue === null) return null;
    return { type: "score", numeric: record.scoreValue, choice: null, agreementKey: null };
  }
  if (record.choiceValue === null) return null;
  return {
    type: "choice",
    numeric: null,
    choice: record.choiceValue,
    agreementKey: record.choiceValue,
  };
}

/** Режим `compare`: два прогона по общим item_id и question_id. */
export function compareRuns(store: RunStore, input: CompareInput): CompareResult {
  assertRun(store, input.runId);
  assertRun(store, input.compareRunId);

  const left = store.listAnswers(input.runId);
  const right = store.listAnswers(input.compareRunId);
  const rightIndex = new Map<string, AnswerRecord>();
  for (const record of right) {
    rightIndex.set(`${record.itemId}\u0000${record.questionId}`, record);
  }

  const questions: Record<string, CompareQuestion> = {};
  // Среднее расхождение считается по всем совпавшим парам, а не только по
  // контрастам: нулевые расхождения тоже часть статистики.
  const numericTotals = new Map<string, { sum: number; count: number }>();

  for (const leftRecord of left) {
    const rightRecord = rightIndex.get(
      `${leftRecord.itemId}\u0000${leftRecord.questionId}`,
    );
    if (rightRecord === undefined) continue;
    const leftValue = pairValue(leftRecord);
    const rightValue = pairValue(rightRecord);
    if (leftValue === null || rightValue === null) continue;
    if (leftValue.type !== rightValue.type) continue;

    let question = questions[leftRecord.questionId];
    if (question === undefined) {
      question = {
        questionId: leftRecord.questionId,
        type: leftValue.type,
        matched: 0,
        meanAbsDiff: null,
        agreement: null,
        contrasts: [],
      };
      questions[leftRecord.questionId] = question;
    }

    question.matched += 1;
    const diff =
      leftValue.numeric !== null && rightValue.numeric !== null
        ? Math.abs(leftValue.numeric - rightValue.numeric)
        : null;
    if (diff !== null) {
      const totals = numericTotals.get(leftRecord.questionId) ?? { sum: 0, count: 0 };
      totals.sum += diff;
      totals.count += 1;
      numericTotals.set(leftRecord.questionId, totals);
    }
    // В контрасты попадают только реальные расхождения: одинаковые ответы
    // не помогают калибровке и только шумят в выдаче.
    const isContrast =
      diff !== null ? diff > 0 : leftValue.choice !== rightValue.choice;
    if (!isContrast) continue;

    const pair: CompareContrast = {
      itemId: leftRecord.itemId,
      left: leftValue.numeric ?? leftValue.choice,
      right: rightValue.numeric ?? rightValue.choice,
      diff,
    };
    question.contrasts.push(pair);
  }

  for (const question of Object.values(questions)) {
    const totals = numericTotals.get(question.questionId);
    question.meanAbsDiff =
      totals !== undefined && totals.count > 0 ? totals.sum / totals.count : null;

    const leftIndex = new Map(
      left
        .filter((record) => record.questionId === question.questionId)
        .map((record) => [record.itemId, pairValue(record)]),
    );
    let agreements = 0;
    let comparable = 0;
    for (const rightRecord of right) {
      if (rightRecord.questionId !== question.questionId) continue;
      const leftValue = leftIndex.get(rightRecord.itemId);
      const rightValue = pairValue(rightRecord);
      if (leftValue === null || leftValue === undefined || rightValue === null) continue;
      if (leftValue.type !== rightValue.type) continue;
      comparable += 1;
      if (leftValue.agreementKey === rightValue.agreementKey) agreements += 1;
    }
    question.agreement = comparable === 0 ? null : agreements / comparable;

    const sorted = [...question.contrasts].sort((leftPair, rightPair) => {
      const leftDiff = leftPair.diff ?? (leftPair.left === leftPair.right ? 0 : 1);
      const rightDiff = rightPair.diff ?? (rightPair.left === rightPair.right ? 0 : 1);
      if (leftDiff !== rightDiff) return rightDiff - leftDiff;
      return leftPair.itemId < rightPair.itemId ? -1 : 1;
    });
    question.contrasts = sorted.slice(0, COMPARE_CONTRASTS);
  }

  return {
    runId: input.runId,
    compareRunId: input.compareRunId,
    commonQuestions: Object.keys(questions).length,
    questions,
  };
}
