/**
 * Локальное хранилище прогонов на встроенном `node:sqlite`
 * (docs/architecture/system.md §4).
 *
 * Прогресс пишется потоково: движок сохраняет ответы после каждого батча и
 * обновляет счётчики, поэтому сетевой обрыв не теряет уже полученные оценки.
 * `PRAGMA journal_mode = WAL` включён для безопасной конкурентной записи.
 *
 * `raw_answer_json` пока всегда `NULL`: батчер отдаёт только нормализованные
 * ответы, поэтому рядом лежит `answer_json` с нормализованным объектом. Колонка
 * сохранена под будущий проброс сырых ответов провайдера без миграции схемы.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  ConfidenceSource,
  NormalizedAnswer,
  NormalizedAnswerType,
} from "./providers/types.js";
import type { ModelAlias } from "./types.js";

export type RunStatus = "running" | "completed" | "partial" | "failed";
export type RunScope = "whole" | "per_item";
export type ItemStatus =
  | "pending"
  | "ok"
  | "skipped_too_large"
  | "safety_blocked"
  | "error";
export type AnswerStatus = "ok" | "refusal" | "safety_blocked" | "error";

export interface CreateRunInput {
  runId: string;
  createdAt: string;
  provider: string;
  modelAlias: ModelAlias;
  modelId: string;
  scope: RunScope;
  sourceJson: string;
  rubricJson: string;
  parentRunId?: string | null;
  itemsTotal: number;
}

export interface StoreItemInput {
  itemId: string;
  seqIndex: number;
  sourceRef: string | null;
  meta: Record<string, unknown> | null;
  preview: string;
  contentHash: string;
  status: ItemStatus;
  errorCode?: string | null;
}

export interface StoreAnswerInput {
  itemId: string;
  questionId: string;
  answer: NormalizedAnswer;
  traceId?: string | null;
}

export interface RunTotals {
  itemsProcessed: number;
  itemsSkipped: number;
  itemsBlocked: number;
  batchesTotal: number;
  inputTokens: number;
  outputTokens: number;
  costRub?: number;
  costUsd?: number;
}

export interface FinishRunInput extends RunTotals {
  status: RunStatus;
  durationMs: number;
  responseModel?: string | null;
  errorSummary?: string | null;
}

export interface RunRecord {
  runId: string;
  createdAt: string;
  finishedAt: string | null;
  status: RunStatus;
  provider: string;
  modelAlias: ModelAlias;
  modelId: string;
  responseModel: string | null;
  scope: RunScope;
  sourceJson: string;
  rubricJson: string;
  parentRunId: string | null;
  itemsTotal: number;
  itemsProcessed: number;
  itemsSkipped: number;
  itemsBlocked: number;
  batchesTotal: number;
  inputTokens: number;
  outputTokens: number;
  costRub: number | null;
  costUsd: number | null;
  durationMs: number;
  errorSummary: string | null;
}

export interface ItemRecord {
  runId: string;
  itemId: string;
  seqIndex: number;
  sourceRef: string | null;
  metaJson: string | null;
  preview: string | null;
  contentHash: string;
  status: ItemStatus;
  errorCode: string | null;
}

export interface AnswerRecord {
  runId: string;
  itemId: string;
  questionId: string;
  primitiveType: NormalizedAnswerType;
  prob: number | null;
  scoreValue: number | null;
  choiceValue: string | null;
  confidence: number;
  confidenceSource: ConfidenceSource;
  probabilitiesJson: string | null;
  answerJson: string;
  rawAnswerJson: string | null;
  status: AnswerStatus;
  traceId: string | null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  run_id            TEXT PRIMARY KEY,
  created_at        TEXT NOT NULL,
  finished_at       TEXT,
  status            TEXT NOT NULL,
  provider          TEXT NOT NULL,
  model_alias       TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  response_model    TEXT,
  scope             TEXT NOT NULL,
  source_json       TEXT NOT NULL,
  rubric_json       TEXT NOT NULL,
  parent_run_id     TEXT,
  items_total       INTEGER NOT NULL DEFAULT 0,
  items_processed   INTEGER NOT NULL DEFAULT 0,
  items_skipped     INTEGER NOT NULL DEFAULT 0,
  items_blocked     INTEGER NOT NULL DEFAULT 0,
  batches_total     INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_rub          REAL,
  cost_usd          REAL,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  error_summary     TEXT
);

CREATE TABLE IF NOT EXISTS items (
  run_id            TEXT NOT NULL,
  item_id           TEXT NOT NULL,
  seq_index         INTEGER NOT NULL,
  source_ref        TEXT,
  meta_json         TEXT,
  preview           TEXT,
  content_hash      TEXT NOT NULL,
  status            TEXT NOT NULL,
  error_code        TEXT,
  PRIMARY KEY (run_id, item_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS answers (
  run_id            TEXT NOT NULL,
  item_id           TEXT NOT NULL,
  question_id       TEXT NOT NULL,
  primitive_type    TEXT NOT NULL,
  prob              REAL,
  score_value       REAL,
  choice_value      TEXT,
  confidence        REAL NOT NULL,
  confidence_source TEXT NOT NULL,
  probabilities_json TEXT,
  answer_json       TEXT NOT NULL,
  raw_answer_json   TEXT,
  status            TEXT NOT NULL DEFAULT 'ok',
  trace_id          TEXT,
  PRIMARY KEY (run_id, item_id, question_id),
  FOREIGN KEY (run_id, item_id) REFERENCES items(run_id, item_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_run_seq ON items(run_id, seq_index);
CREATE INDEX IF NOT EXISTS idx_answers_run_q_score ON answers(run_id, question_id, score_value);
CREATE INDEX IF NOT EXISTS idx_answers_run_q_prob ON answers(run_id, question_id, prob);
CREATE INDEX IF NOT EXISTS idx_answers_run_q_choice ON answers(run_id, question_id, choice_value);
`;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toNumber(value: unknown): number {
  return toNumberOrNull(value) ?? 0;
}

function toModelAlias(value: unknown): ModelAlias {
  return value as ModelAlias;
}

/** Идентификатор прогона: `run_20261122_221500_7f3a` (UTC + 4 hex). */
export function createRunId(
  now: Date = new Date(),
  suffix: string = Math.random().toString(16).slice(2, 6).padEnd(4, "0"),
): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    "_",
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join("");
  return `run_${stamp}_${suffix}`;
}

export type SqlValue = null | number | bigint | string;
export type SqlRow = Record<string, unknown>;

export class RunStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;

  constructor(readonly dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  createRun(input: CreateRunInput): void {
    this.statement(
      `INSERT INTO runs (
        run_id, created_at, status, provider, model_alias, model_id, scope,
        source_json, rubric_json, parent_run_id, items_total
      ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.runId,
      input.createdAt,
      input.provider,
      input.modelAlias,
      input.modelId,
      input.scope,
      input.sourceJson,
      input.rubricJson,
      input.parentRunId ?? null,
      input.itemsTotal,
    );
  }

  addItems(runId: string, items: StoreItemInput[]): void {
    if (items.length === 0) return;
    const statement = this.statement(
      `INSERT OR REPLACE INTO items (
        run_id, item_id, seq_index, source_ref, meta_json, preview,
        content_hash, status, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.transaction(() => {
      for (const item of items) {
        statement.run(
          runId,
          item.itemId,
          item.seqIndex,
          item.sourceRef,
          item.meta === null ? null : JSON.stringify(item.meta),
          item.preview,
          item.contentHash,
          item.status,
          item.errorCode ?? null,
        );
      }
    });
  }

  markItemStatus(
    runId: string,
    itemId: string,
    status: ItemStatus,
    errorCode: string | null = null,
  ): void {
    this.statement(
      "UPDATE items SET status = ?, error_code = ? WHERE run_id = ? AND item_id = ?",
    ).run(status, errorCode, runId, itemId);
  }

  saveAnswers(runId: string, answers: StoreAnswerInput[]): void {
    if (answers.length === 0) return;
    const statement = this.statement(
      `INSERT OR REPLACE INTO answers (
        run_id, item_id, question_id, primitive_type, prob, score_value,
        choice_value, confidence, confidence_source, probabilities_json,
        answer_json, raw_answer_json, status, trace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    );
    this.transaction(() => {
      for (const { itemId, questionId, answer, traceId } of answers) {
        statement.run(
          runId,
          itemId,
          questionId,
          answer.type,
          answer.prob ?? null,
          answer.score ?? null,
          answer.choice ?? null,
          answer.confidence,
          answer.confidenceSource,
          answer.probabilities === undefined
            ? null
            : JSON.stringify(answer.probabilities),
          JSON.stringify(answer),
          answer.status,
          traceId ?? null,
        );
      }
    });
  }

  updateProgress(runId: string, totals: RunTotals): void {
    this.statement(
      `UPDATE runs SET
        items_processed = ?, items_skipped = ?, items_blocked = ?,
        batches_total = ?, input_tokens = ?, output_tokens = ?,
        cost_rub = ?, cost_usd = ?
      WHERE run_id = ?`,
    ).run(
      totals.itemsProcessed,
      totals.itemsSkipped,
      totals.itemsBlocked,
      totals.batchesTotal,
      totals.inputTokens,
      totals.outputTokens,
      totals.costRub ?? null,
      totals.costUsd ?? null,
      runId,
    );
  }

  finishRun(runId: string, input: FinishRunInput): void {
    this.statement(
      `UPDATE runs SET
        status = ?, finished_at = ?, items_processed = ?, items_skipped = ?,
        items_blocked = ?, batches_total = ?, input_tokens = ?, output_tokens = ?,
        cost_rub = ?, cost_usd = ?, duration_ms = ?, response_model = ?,
        error_summary = ?
      WHERE run_id = ?`,
    ).run(
      input.status,
      new Date().toISOString(),
      input.itemsProcessed,
      input.itemsSkipped,
      input.itemsBlocked,
      input.batchesTotal,
      input.inputTokens,
      input.outputTokens,
      input.costRub ?? null,
      input.costUsd ?? null,
      input.durationMs,
      input.responseModel ?? null,
      input.errorSummary ?? null,
      runId,
    );
  }

  getRun(runId: string): RunRecord | null {
    const row = this.statement("SELECT * FROM runs WHERE run_id = ?").get(runId);
    return row === undefined ? null : toRunRecord(asRecord(row));
  }

  listItems(runId: string): ItemRecord[] {
    const rows = this.statement(
      "SELECT * FROM items WHERE run_id = ? ORDER BY seq_index, item_id",
    ).all(runId);
    return rows.map((row) => toItemRecord(asRecord(row)));
  }

  listAnswers(runId: string, itemIds?: string[]): AnswerRecord[] {
    if (itemIds !== undefined && itemIds.length === 0) return [];
    const rows =
      itemIds === undefined
        ? this.statement(
            "SELECT * FROM answers WHERE run_id = ? ORDER BY item_id, question_id",
          ).all(runId)
        : this.statement(
            `SELECT * FROM answers WHERE run_id = ? AND item_id IN (${itemIds
              .map(() => "?")
              .join(", ")}) ORDER BY item_id, question_id`,
          ).all(runId, ...itemIds);
    return rows.map((row) => toAnswerRecord(asRecord(row)));
  }

  /**
   * Только для `query.ts`: SQL собирается по белому списку полей, все значения
   * передаются параметрами. Агент сырой SQL сюда не передаёт.
   */
  queryAll(sql: string, params: SqlValue[] = []): SqlRow[] {
    // Динамический SQL не кешируем: фильтры собираются под каждый запрос.
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => asRecord(row));
  }

  queryOne(sql: string, params: SqlValue[] = []): SqlRow | null {
    const row = this.db.prepare(sql).get(...params);
    return row === undefined ? null : asRecord(row);
  }

  countRuns(): number {
    const row = asRecord(this.statement("SELECT COUNT(*) AS total FROM runs").get());
    return toNumber(row["total"]);
  }

  private statement(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  private transaction(run: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function toRunRecord(row: Record<string, unknown>): RunRecord {
  return {
    runId: String(row["run_id"]),
    createdAt: String(row["created_at"]),
    finishedAt: toStringOrNull(row["finished_at"]),
    status: row["status"] as RunStatus,
    provider: String(row["provider"]),
    modelAlias: toModelAlias(row["model_alias"]),
    modelId: String(row["model_id"]),
    responseModel: toStringOrNull(row["response_model"]),
    scope: row["scope"] as RunScope,
    sourceJson: String(row["source_json"]),
    rubricJson: String(row["rubric_json"]),
    parentRunId: toStringOrNull(row["parent_run_id"]),
    itemsTotal: toNumber(row["items_total"]),
    itemsProcessed: toNumber(row["items_processed"]),
    itemsSkipped: toNumber(row["items_skipped"]),
    itemsBlocked: toNumber(row["items_blocked"]),
    batchesTotal: toNumber(row["batches_total"]),
    inputTokens: toNumber(row["input_tokens"]),
    outputTokens: toNumber(row["output_tokens"]),
    costRub: toNumberOrNull(row["cost_rub"]),
    costUsd: toNumberOrNull(row["cost_usd"]),
    durationMs: toNumber(row["duration_ms"]),
    errorSummary: toStringOrNull(row["error_summary"]),
  };
}

function toItemRecord(row: Record<string, unknown>): ItemRecord {
  return {
    runId: String(row["run_id"]),
    itemId: String(row["item_id"]),
    seqIndex: toNumber(row["seq_index"]),
    sourceRef: toStringOrNull(row["source_ref"]),
    metaJson: toStringOrNull(row["meta_json"]),
    preview: toStringOrNull(row["preview"]),
    contentHash: String(row["content_hash"]),
    status: row["status"] as ItemStatus,
    errorCode: toStringOrNull(row["error_code"]),
  };
}

function toAnswerRecord(row: Record<string, unknown>): AnswerRecord {
  return {
    runId: String(row["run_id"]),
    itemId: String(row["item_id"]),
    questionId: String(row["question_id"]),
    primitiveType: row["primitive_type"] as NormalizedAnswerType,
    prob: toNumberOrNull(row["prob"]),
    scoreValue: toNumberOrNull(row["score_value"]),
    choiceValue: toStringOrNull(row["choice_value"]),
    confidence: toNumber(row["confidence"]),
    confidenceSource: row["confidence_source"] as ConfidenceSource,
    probabilitiesJson: toStringOrNull(row["probabilities_json"]),
    answerJson: String(row["answer_json"]),
    rawAnswerJson: toStringOrNull(row["raw_answer_json"]),
    status: row["status"] as AnswerStatus,
    traceId: toStringOrNull(row["trace_id"]),
  };
}
