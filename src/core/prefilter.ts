/**
 * Этап 0: детерминированные бесплатные теги для JSONL-сессий
 * (docs/architecture/system.md §2, `prefilter.ts`).
 *
 * Теги не влияют на решение модели — они лишь добавляют в `skeleton` короткие
 * маркеры, по которым батчер и агент видят повторы, длину reasoning и ошибки
 * инструментов без чтения полного текста.
 */
import { estimateTokens } from "./tokenizer.js";

/** Маркеры разворота рассуждения: сначала думал одно, потом передумал. */
export const REVERSAL_MARKERS = [
  "wait",
  "actually",
  "hold on",
  "but no",
  "hmm",
  "подожди",
  "подождите",
  "на самом деле",
  "но нет",
  "стоп",
] as const;

/** Один шаг сессии в терминах, нужных префильтру. */
export interface PrefilterStep {
  stepId: string | null;
  toolName: string | null;
  /** Аргументы вызова как текст; нужны для детекции повторов одного вызова. */
  argsText: string | null;
  reasoning: string | null;
  /** Статус шага или инструмента (`ok`, `error`, `failed`, …). */
  status: string | null;
  /** Текст ошибки, если он есть отдельным полем. */
  error: string | null;
  /** Аргументы не разобрались как JSON. */
  invalidJson: boolean;
}

export interface PrefilterTags {
  /** Оценка длины reasoning в токенах (без overhead запроса). */
  reasoningToks: number;
  /** Длина серии одинаковых вызовов инструмента с теми же аргументами. */
  repeatTool: number;
  repeatReasoning: boolean;
  toolError: boolean;
  /** Сколько маркеров разворота встретилось в reasoning. */
  reversalMarkers: number;
  invalidJson: boolean;
}

export interface ReasoningSummary {
  chars: number;
  toks: number;
  first: string;
  last: string;
  reversals: number;
}

const REVERSAL_PATTERN = new RegExp(
  `(?:^|[\\s.,!?;:()\\[\\]"'])(${REVERSAL_MARKERS.join("|")})(?=$|[\\s.,!?;:()\\[\\]"'])`,
  "giu",
);

const TOOL_ERROR_STATUS = /error|fail|denied|exception|timeout|refused|ошибк|сбой/i;
const SHINGLE_WORDS = 6;
const MIN_REASONING_WORDS_FOR_REPEAT = 18;
const PREVIEW_CHARS = 200;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Сколько маркеров разворота (`Wait`, `Actually`, `Подождите`, `Но нет`…) в тексте. */
export function detectReversalMarkers(text: string): number {
  if (text.length === 0) return 0;
  return [...text.matchAll(REVERSAL_PATTERN)].length;
}

function firstSentence(text: string): string {
  const trimmed = collapse(text);
  const match = /^.*?[.!?…](?=\s|$)/u.exec(trimmed);
  const sentence = match?.[0] ?? trimmed;
  return sentence.length > PREVIEW_CHARS
    ? `${sentence.slice(0, PREVIEW_CHARS - 1)}…`
    : sentence;
}

function lastSentence(text: string): string {
  const trimmed = collapse(text);
  const parts = trimmed.split(/(?<=[.!?…])\s+/u).filter(Boolean);
  const sentence = parts.at(-1) ?? trimmed;
  return sentence.length > PREVIEW_CHARS
    ? `…${sentence.slice(-(PREVIEW_CHARS - 1))}`
    : sentence;
}

/** Короткая сводка reasoning: длина, первые/последние фразы, число разворотов. */
export function reasoningSummary(text: string): ReasoningSummary {
  if (text.length === 0) {
    return { chars: 0, toks: 0, first: "", last: "", reversals: 0 };
  }
  return {
    chars: text.length,
    toks: estimateTokens(text),
    first: firstSentence(text),
    last: lastSentence(text),
    reversals: detectReversalMarkers(text),
  };
}

/** Ошибка инструмента по статусу или отдельному полю ошибки. */
export function isToolError(status: string | null, error: string | null): boolean {
  if (error !== null && collapse(error).length > 0) return true;
  return status !== null && TOOL_ERROR_STATUS.test(status);
}

/**
 * Самоповтор в reasoning: шестисловный шингл встретился больше одного раза.
 * Порог в 18 слов отсекает короткие фразы, где совпадение случайно.
 */
export function detectRepeatReasoning(text: string): boolean {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (words.length < MIN_REASONING_WORDS_FOR_REPEAT) return false;
  const seen = new Set<string>();
  for (let start = 0; start + SHINGLE_WORDS <= words.length; start += 1) {
    const shingle = words
      .slice(start, start + SHINGLE_WORDS)
      .join(" ");
    if (seen.has(shingle)) return true;
    seen.add(shingle);
  }
  return false;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Аргументы сравниваются как JSON с сортировкой ключей: `{"a":1,"b":2}` и
 * `{ "b": 2, "a": 1 }` — один и тот же вызов. Не-JSON сравнивается как текст.
 */
/**
 * Аргументы, похожие на JSON (`{…}` или `[…]`), но не разбирающиеся: это
 * отдельный дефект шага, его помечаем тегом `invalid_json`. Обычная строка
 * аргументом не считается ошибкой.
 */
export function hasInvalidArgsJson(argsText: string | null): boolean {
  if (argsText === null) return false;
  const trimmed = argsText.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    return true;
  }
}

function normalizedArgs(argsText: string | null): string | null {
  if (argsText === null) return null;
  const trimmed = argsText.trim();
  if (trimmed.length === 0) return "";
  try {
    return canonicalJson(JSON.parse(trimmed));
  } catch {
    return collapse(trimmed);
  }
}

/**
 * Теги для всех шагов сразу: серия повторов считается по соседним шагам,
 * поэтому функция принимает массив, а не один элемент.
 */
export function computePrefilterTags(steps: PrefilterStep[]): PrefilterTags[] {
  const tags: PrefilterTags[] = [];
  let previous: PrefilterStep | null = null;
  let repeatTool = 1;

  for (const step of steps) {
    const sameTool =
      previous !== null &&
      step.toolName !== null &&
      previous.toolName === step.toolName &&
      normalizedArgs(step.argsText) !== null &&
      normalizedArgs(step.argsText) === normalizedArgs(previous.argsText);
    repeatTool = sameTool ? repeatTool + 1 : 1;

    tags.push({
      reasoningToks: step.reasoning === null ? 0 : estimateTokens(step.reasoning),
      repeatTool,
      repeatReasoning:
        step.reasoning !== null && detectRepeatReasoning(step.reasoning),
      toolError: isToolError(step.status, step.error),
      reversalMarkers: step.reasoning === null ? 0 : detectReversalMarkers(step.reasoning),
      invalidJson: step.invalidJson || hasInvalidArgsJson(step.argsText),
    });
    previous = step;
  }

  return tags;
}

/**
 * Строка тегов для `skeleton`: `[reasoning_toks=4200, repeat_tool=3, tool_error]`.
 * Пустых тегов не бывает: если отмечать нечего — `null`.
 */
export function formatPrefilterTags(tags: PrefilterTags): string | null {
  const parts: string[] = [];
  if (tags.reasoningToks > 0) parts.push(`reasoning_toks=${tags.reasoningToks}`);
  if (tags.repeatTool >= 2) parts.push(`repeat_tool=${tags.repeatTool}`);
  if (tags.repeatReasoning) parts.push("repeat_reasoning");
  if (tags.toolError) parts.push("tool_error");
  if (tags.reversalMarkers > 0) parts.push(`reversals=${tags.reversalMarkers}`);
  if (tags.invalidJson) parts.push("invalid_json");
  return parts.length === 0 ? null : `[${parts.join(", ")}]`;
}
