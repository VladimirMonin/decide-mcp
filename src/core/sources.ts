/**
 * Безопасное чтение источников в `SourceItem[]`
 * (docs/architecture/system.md §2–3, §5; docs/architecture/contracts.md §2).
 *
 * Жёсткие правила:
 * - `file`, `glob`, `jsonl` не выходят за `DECIDE_ALLOWED_ROOT`: сначала
 *   лексическая проверка `..`, затем `realpathSync`, чтобы junction и symlink
 *   наружу не проскочили;
 * - `glob` всегда исключает `.git`, `node_modules`, `dist`, `build`, `.venv`,
 *   `*.lock` и бинарные файлы;
 * - `item_id` в результате уникальны: дубликаты получают суффикс `#2`.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import {
  sourceSchema,
  type FileSource,
  type FromRunSource,
  type GlobSource,
  type JsonlSource,
  type Projection,
  type Source,
  type TextSource,
} from "./schema.js";
import type { RunRecord, RunStore } from "./store.js";
import { INSPECT_MAX_CONTEXT, selectItemIds } from "./query.js";
import {
  computePrefilterTags,
  formatPrefilterTags,
  reasoningSummary,
  type PrefilterStep,
} from "./prefilter.js";

export type SourceErrorCode =
  | "path_outside_root"
  | "source_not_found"
  | "source_read_failed"
  | "invalid_source"
  | "unsupported_source"
  | "run_not_found"
  | "source_item_missing"
  | "store_required";

export class SourceError extends Error {
  override readonly name = "SourceError";

  constructor(
    readonly code: SourceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SourceItem {
  id: string;
  content: string;
  /** Порядковый номер в источнике: нужен для `context_window`. */
  seqIndex: number;
  /** Путь к файлу и/или номер строки; `null` для inline-текста. */
  sourceRef: string | null;
  meta: Record<string, unknown>;
}

export interface ReadSourceOptions {
  allowedRoot: string;
  /** Нужен для `from_run` и перезагрузки содержимого прошлых прогонов. */
  store?: RunStore;
  /** Переопределение проекции (например, `inspect` с `projection: "full"`). */
  projection?: Projection;
  /** Защита от бесконечной цепочки `from_run` → `from_run`. */
  depth?: number;
}

const MAX_SOURCE_DEPTH = 3;
const GLOB_MAX_FILES_DEFAULT = 500;
const BINARY_SNIFF_BYTES = 8 * 1024;

const BASE_IGNORE = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.venv/**",
  "**/*.lock",
];

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function assertInside(root: string, candidate: string, what: string): void {
  if (!isInside(root, candidate)) {
    throw new SourceError(
      "path_outside_root",
      `${what} вне DECIDE_ALLOWED_ROOT: ${candidate} (корень ${root})`,
    );
  }
}

/**
 * Нормализует путь и проверяет, что он (вместе с раскрытыми ссылками) лежит
 * строго внутри `allowedRoot`. Относительные пути считаются от корня.
 */
export function resolveInsideRoot(
  inputPath: string,
  allowedRoot: string,
): string {
  const root = path.resolve(allowedRoot);
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(root, inputPath);

  assertInside(root, candidate, `Путь "${inputPath}"`);

  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new SourceError("source_not_found", `DECIDE_ALLOWED_ROOT не найден: ${root}`);
  }
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    throw new SourceError("source_not_found", `Файл не найден: ${inputPath}`);
  }
  assertInside(realRoot, realCandidate, `Путь "${inputPath}"`);
  return realCandidate;
}

/** Путь относительно корня с прямыми слэшами: годится в `item_id` и `source_ref`. */
export function relativeRef(allowedRoot: string, absolutePath: string): string {
  return path
    .relative(path.resolve(allowedRoot), absolutePath)
    .split(path.sep)
    .join("/");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let counter = 2;
  while (used.has(`${base}#${counter}`)) counter += 1;
  const id = `${base}#${counter}`;
  used.add(id);
  return id;
}

function readTextFile(absolutePath: string): string {
  let buffer: Buffer;
  try {
    buffer = readFileSync(absolutePath);
  } catch (error) {
    throw new SourceError(
      "source_read_failed",
      `Не удалось прочитать ${absolutePath}: ${(error as Error).message}`,
    );
  }
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new SourceError(
      "source_read_failed",
      `Файл выглядит бинарным: ${absolutePath}`,
    );
  }
  return buffer.toString("utf8");
}

function tryReadTextFile(absolutePath: string): string | null {
  try {
    return readTextFile(absolutePath);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => toText(part))
      .filter((part): part is string => part !== null && part.length > 0);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

// --- text -----------------------------------------------------------------

function readTextSource(source: TextSource): SourceItem[] {
  const used = new Set<string>();
  return source.items.map((item, index) => ({
    id: uniqueId(item.id, used),
    content: item.content,
    seqIndex: index,
    sourceRef: null,
    meta: { ...(item.meta ?? {}) },
  }));
}

// --- file -----------------------------------------------------------------

function readFileSource(
  source: FileSource,
  options: ReadSourceOptions,
): SourceItem[] {
  const absolute = resolveInsideRoot(source.path, options.allowedRoot);
  const ref = relativeRef(options.allowedRoot, absolute);
  const content = readTextFile(absolute);

  if (source.mode !== "lines") {
    return [
      {
        id: ref,
        content,
        seqIndex: 0,
        sourceRef: ref,
        meta: { path: ref, mode: "whole" },
      },
    ];
  }

  const used = new Set<string>();
  const items: SourceItem[] = [];
  const maxLines = source.max_lines ?? Number.POSITIVE_INFINITY;
  const lines = content.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (items.length >= maxLines) break;
    if (line.trim().length === 0) continue;
    const lineNumber = index + 1;
    items.push({
      id: uniqueId(`${ref}#L${lineNumber}`, used),
      content: line,
      seqIndex: items.length,
      sourceRef: `${ref}#L${lineNumber}`,
      meta: { path: ref, line: lineNumber, mode: "lines" },
    });
  }
  return items;
}

// --- glob -----------------------------------------------------------------

function normalizeGlobPattern(pattern: string): string {
  const normalized = pattern.split(path.sep).join("/");
  const segments = normalized.split("/");
  if (path.isAbsolute(pattern) || segments.includes("..")) {
    throw new SourceError(
      "path_outside_root",
      `Шаблон glob не может выходить за DECIDE_ALLOWED_ROOT: ${pattern}`,
    );
  }
  return normalized;
}

async function readGlobSource(
  source: GlobSource,
  options: ReadSourceOptions,
): Promise<SourceItem[]> {
  const root = path.resolve(options.allowedRoot);
  const realRoot = realpathSync(root);
  const pattern = normalizeGlobPattern(source.pattern);
  const maxFiles = source.max_files ?? GLOB_MAX_FILES_DEFAULT;

  const matches = await fg(pattern, {
    cwd: root,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    unique: true,
    suppressErrors: true,
    ignore: [
      ...BASE_IGNORE,
      ...(source.ignore ?? []).map((pattern) =>
        pattern.split(path.sep).join("/"),
      ),
    ],
  });

  matches.sort((left, right) => left.localeCompare(right));

  const used = new Set<string>();
  const items: SourceItem[] = [];

  for (const match of matches) {
    if (items.length >= maxFiles) break;
    let absolute: string;
    try {
      absolute = realpathSync(path.resolve(root, match));
    } catch {
      continue;
    }
    // Ссылка наружу не должна просочиться даже как файл.
    if (!isInside(realRoot, absolute)) continue;
    const content = tryReadTextFile(absolute);
    if (content === null) continue;
    const ref = relativeRef(root, absolute);
    items.push({
      id: uniqueId(ref, used),
      content,
      seqIndex: items.length,
      sourceRef: ref,
      meta: { path: ref },
    });
  }

  return items;
}

// --- jsonl ----------------------------------------------------------------

interface SessionFields {
  stepId: string | null;
  role: string | null;
  request: string | null;
  response: string | null;
  toolName: string | null;
  argsText: string | null;
  status: string | null;
  error: string | null;
  reasoning: string | null;
  result: string | null;
}

function pickField(
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function extractSessionFields(record: Record<string, unknown>): SessionFields {
  const message = asRecord(record["message"]);
  const tool = asRecord(record["tool"]);

  const role = toText(pickField(record, ["role", "speaker", "author"])) ??
    (message ? toText(message["role"]) : null);
  const content = toText(pickField(record, ["content"])) ??
    (message ? toText(message["content"]) : null);

  return {
    stepId: toText(pickField(record, ["step_id", "stepId", "id", "index"])),
    role,
    request: toText(pickField(record, ["request", "prompt", "query", "user"])),
    response: toText(pickField(record, ["response", "answer", "assistant"])) ?? content,
    toolName:
      toText(pickField(record, ["tool_name", "toolName", "tool"])) ??
      (tool ? toText(tool["name"]) : null),
    argsText: toText(
      pickField(record, ["arguments", "args", "tool_input", "tool_arguments"]),
    ),
    status: toText(pickField(record, ["status", "tool_status", "result_status"])),
    error: toText(pickField(record, ["error", "tool_error", "error_message"])),
    reasoning: toText(
      pickField(record, ["reasoning", "thinking", "thought", "reasoning_content"]),
    ),
    result: toText(pickField(record, ["result", "tool_output", "output", "observation"])),
  };
}

/** Компактный `skeleton` для длинных агентских сессий. */
function buildSkeleton(fields: SessionFields): string {
  const lines: string[] = [];
  if (fields.stepId !== null) lines.push(`step_id: ${fields.stepId}`);
  if (fields.role !== null) lines.push(`role: ${fields.role}`);
  if (fields.toolName !== null) lines.push(`tool: ${fields.toolName}`);
  if (fields.argsText !== null) {
    lines.push(`arguments: ${truncate(fields.argsText, 300)}`);
  }
  if (fields.status !== null) lines.push(`status: ${fields.status}`);
  if (fields.request !== null) lines.push(`request: ${truncate(fields.request, 200)}`);
  if (fields.response !== null) {
    lines.push(`response: ${truncate(fields.response, 200)}`);
  }
  if (fields.result !== null) lines.push(`result: ${truncate(fields.result, 200)}`);
  if (fields.error !== null) lines.push(`error: ${truncate(fields.error, 200)}`);
  if (fields.reasoning !== null) {
    const summary = reasoningSummary(fields.reasoning);
    lines.push(
      `reasoning: ${summary.toks} toks, ${summary.chars} chars; first: "${truncate(summary.first, 200)}"; last: "${truncate(summary.last, 200)}"; reversals: ${summary.reversals}`,
    );
  }
  return lines.join("\n");
}

interface JsonlRow {
  lineNumber: number;
  rawLine: string;
  record: Record<string, unknown> | null;
  fields: SessionFields;
  baseId: string;
  invalidJson: boolean;
}

function parseJsonlRows(source: JsonlSource): JsonlRow[] {
  const absolutePath = source.path;
  const offset = source.offset ?? 0;
  const limit = source.limit ?? Number.POSITIVE_INFINITY;
  const text = readTextFile(absolutePath);
  const lines = text.split(/\r?\n/);
  const rows: JsonlRow[] = [];

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.trim().length === 0) continue;
    if (lineNumber <= offset) continue;
    if (rows.length >= limit) break;

    let parsed: unknown = null;
    let record: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(line);
      record = asRecord(parsed);
    } catch {
      parsed = null;
    }

    const fields = record === null
      ? {
          stepId: null,
          role: null,
          request: null,
          response: null,
          toolName: null,
          argsText: null,
          status: null,
          error: null,
          reasoning: null,
          result: null,
        }
      : extractSessionFields(record);

    const idValue =
      source.id_field !== undefined && record !== null
        ? toText(record[source.id_field])
        : null;

    rows.push({
      lineNumber,
      rawLine: line,
      record,
      fields,
      baseId: idValue ?? `line_${String(lineNumber).padStart(4, "0")}`,
      invalidJson: parsed === null,
    });
  }

  return rows;
}

function readJsonlSource(
  source: JsonlSource,
  options: ReadSourceOptions,
): SourceItem[] {
  const absolute = resolveInsideRoot(source.path, options.allowedRoot);
  const ref = relativeRef(options.allowedRoot, absolute);
  const projection = options.projection ?? source.projection ?? "raw";
  const rows = parseJsonlRows({ ...source, path: absolute });

  const steps: PrefilterStep[] = rows.map((row) => ({
    stepId: row.fields.stepId,
    toolName: row.fields.toolName,
    argsText: row.fields.argsText,
    reasoning: row.fields.reasoning,
    status: row.fields.status,
    error: row.fields.error,
    invalidJson: row.invalidJson,
  }));
  const tags = source.prefilter_tags ? computePrefilterTags(steps) : null;

  const used = new Set<string>();
  return rows.map((row, index) => {
    let content: string;
    if (projection === "skeleton") {
      content = row.record === null
        ? row.rawLine
        : buildSkeleton(row.fields);
    } else if (projection === "full") {
      content = row.record === null
        ? row.rawLine
        : JSON.stringify(row.record, null, 2);
    } else {
      content = row.rawLine;
    }

    // Теги префильтра добавляются только в skeleton: `raw` остаётся исходной
    // строкой, а `full` — валидным JSON для повторного разбора.
    const tagLine = tags?.[index] ? formatPrefilterTags(tags[index]) : null;
    if (tagLine !== null && projection === "skeleton") {
      content = `${content}\n${tagLine}`;
    }

    return {
      id: uniqueId(row.baseId, used),
      content,
      seqIndex: index,
      sourceRef: `${ref}#L${row.lineNumber}`,
      meta: {
        path: ref,
        line: row.lineNumber,
        projection,
        invalidJson: row.invalidJson,
      },
    };
  });
}

// --- from_run -------------------------------------------------------------

function parseMeta(metaJson: string | null): Record<string, unknown> {
  if (metaJson === null) return {};
  try {
    const parsed: unknown = JSON.parse(metaJson);
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function mergeEpisodes(seqIndexes: number[]): number[][] {
  const sorted = [...new Set(seqIndexes)].sort((left, right) => left - right);
  const episodes: number[][] = [];
  let current: number[] = [];

  for (const seq of sorted) {
    const last = current.at(-1);
    if (last === undefined || seq === last + 1) {
      current.push(seq);
    } else {
      episodes.push(current);
      current = [seq];
    }
  }
  if (current.length > 0) episodes.push(current);
  return episodes;
}

function formatEpisode(
  episode: SourceItem[],
  contentById: Map<string, string>,
  targetId: string,
): string {
  return episode
    .map((item) => {
      const marker = item.id === targetId ? " [target]" : "";
      const content = contentById.get(item.id);
      if (content === undefined) {
        throw new SourceError(
          "source_item_missing",
          `Не удалось перезагрузить элемент ${item.id} родительского прогона`,
        );
      }
      return `--- ${item.id} (seq ${item.seqIndex})${marker} ---\n${content}`;
    })
    .join("\n\n");
}

export interface LoadedRunContent {
  content: Map<string, string>;
  /**
   * `item_id`, у которых хэш перезагруженного текста не совпал с сохранённым:
   * источник изменился после прогона. Запрос при этом не падает.
   */
  changed: string[];
}

/**
 * Перечитать содержимое элементов прошлого прогона из его `source_json`.
 * Проекция переопределяет исходную (например, `full` на Этапе 2).
 *
 * При перезагрузке в исходной проекции сверяем SHA-256 с `content_hash`
 * прогона и возвращаем изменившиеся элементы отдельно: `from_run` пишет флаг
 * в `meta`, `inspect` — предупреждение.
 */
export async function loadRunContent(
  run: RunRecord,
  itemIds: string[],
  projection: Projection | undefined,
  options: { allowedRoot: string; store?: RunStore; depth?: number },
): Promise<LoadedRunContent> {
  let rawSource: unknown;
  try {
    rawSource = JSON.parse(run.sourceJson);
  } catch {
    throw new SourceError("invalid_source", `source_json прогона ${run.runId} не JSON`);
  }
  const parsed = sourceSchema.safeParse(rawSource);
  if (!parsed.success) {
    throw new SourceError(
      "invalid_source",
      `source_json прогона ${run.runId} не соответствует контракту`,
    );
  }

  const items = await readSource(parsed.data, {
    allowedRoot: options.allowedRoot,
    store: options.store,
    projection,
    depth: options.depth,
  });

  const storedHashes = new Map<string, string>();
  if (options.store !== undefined) {
    for (const item of options.store.listItems(run.runId)) {
      storedHashes.set(item.itemId, item.contentHash);
    }
  }
  // Смена проекции законно меняет текст, поэтому хэш сверяем только тогда,
  // когда перезагрузка идёт в исходной проекции источника.
  const compareHashes = projection === undefined && storedHashes.size > 0;

  const wanted = new Set(itemIds);
  const content = new Map<string, string>();
  const changed: string[] = [];
  for (const item of items) {
    if (!wanted.has(item.id)) continue;
    content.set(item.id, item.content);
    if (compareHashes) {
      const stored = storedHashes.get(item.id);
      if (stored !== undefined && stored !== hashContent(item.content)) {
        changed.push(item.id);
      }
    }
  }
  return { content, changed };
}

async function readFromRunSource(
  source: FromRunSource,
  options: ReadSourceOptions,
): Promise<SourceItem[]> {
  const store = options.store;
  if (store === undefined) {
    throw new SourceError(
      "store_required",
      "Источник from_run требует хранилище прогонов",
    );
  }
  const depth = options.depth ?? 0;
  if (depth >= MAX_SOURCE_DEPTH) {
    throw new SourceError(
      "invalid_source",
      `Слишком глубокая цепочка from_run: ${source.run_id}`,
    );
  }

  const parent = store.getRun(source.run_id);
  if (parent === null) {
    throw new SourceError("run_not_found", `Прогон не найден: ${source.run_id}`);
  }

  const targetIds = selectItemIds(store, source.run_id, {
    where: source.where,
    limit: source.limit,
  });
  if (targetIds.length === 0) return [];

  const parentItems = store.listItems(source.run_id);
  const byId = new Map(parentItems.map((item) => [item.itemId, item]));
  const targets = targetIds.map((id) => {
    const item = byId.get(id);
    if (item === undefined) {
      throw new SourceError(
        "source_item_missing",
        `Элемент ${id} не найден в прогоне ${source.run_id}`,
      );
    }
    return item;
  });

  // Тот же потолок окна, что у inspect: crafted-запрос не раздувает эпизод.
  const window = Math.min(source.context_window ?? 0, INSPECT_MAX_CONTEXT);
  const seqIndexes: number[] = [];
  for (const target of targets) {
    for (let seq = target.seqIndex - window; seq <= target.seqIndex + window; seq += 1) {
      seqIndexes.push(seq);
    }
  }
  const episodes = mergeEpisodes(seqIndexes).map((seqs) => ({
    seqs,
    items: parentItems
      .filter((item) => seqs.includes(item.seqIndex))
      .map<SourceItem>((item) => ({
        id: item.itemId,
        content: "",
        seqIndex: item.seqIndex,
        sourceRef: item.sourceRef,
        meta: parseMeta(item.metaJson),
      })),
  }));
  const allEpisodeIds = new Set(
    episodes.flatMap((episode) => episode.items.map((item) => item.id)),
  );

  const loaded = await loadRunContent(
    parent,
    [...allEpisodeIds],
    source.projection ?? options.projection,
    { allowedRoot: options.allowedRoot, store, depth: depth + 1 },
  );
  const contentById = loaded.content;
  const changedIds = new Set(loaded.changed);

  // Вопросы вешаются только на целевые item_id, поэтому на каждый таргет
  // отдаётся свой элемент с текстом всего эпизода (соседи — только контекст).
  return targets.map((target) => {
    const episode = episodes.find((candidate) =>
      candidate.seqs.includes(target.seqIndex),
    );
    const items = episode?.items ?? [];
    return {
      id: target.itemId,
      content: formatEpisode(items, contentById, target.itemId),
      seqIndex: target.seqIndex,
      sourceRef: target.sourceRef,
      meta: {
        ...parseMeta(target.metaJson),
        from_run: source.run_id,
        episode: items.map((item) => item.id),
        target: true,
        /** Исходный текст цели изменился после родительского прогона. */
        sourceChanged: changedIds.has(target.itemId),
        episodeChanged: items.some((item) => changedIds.has(item.id)),
      },
    };
  });
}

/**
 * Читает источник целиком. Для `from_run` нужен `store`; для остальных типов
 * хранилище не требуется.
 */
export async function readSource(
  source: Source,
  options: ReadSourceOptions,
): Promise<SourceItem[]> {
  switch (source.type) {
    case "text":
      return readTextSource(source);
    case "file":
      return readFileSource(source, options);
    case "glob":
      return readGlobSource(source, options);
    case "jsonl":
      return readJsonlSource(source, options);
    case "from_run":
      return readFromRunSource(source, options);
  }
}
