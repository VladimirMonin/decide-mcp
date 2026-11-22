/**
 * Замеры на реальных обезличенных данных: пропускная способность, токены,
 * стоимость, расхождение моделей и пороги гейтинга.
 *
 * Обезличиватель — точная копия исправленного sanitize()/scanLeaks() из
 * src/cli/funnel-check.ts (экранированные пути, домашние/проектные/абсолютные
 * корни, цитаты приватных указаний, независимый скан). В fixtures/bench/
 * попадает только обезличенная копия; исходная сессия не коммитится.
 *
 * Запуск:
 *   BENCH_SESSION_PATH=<jsonl-сессия Pi> [BENCH_PROJECT_NAME=<имя>] \
 *   node dist/cli/bench-check.js
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, projectRoot, type AppConfig } from "../core/config.js";
import { DecisionEngine, type RunDecisionOutput } from "../core/engine.js";
import { SystemOneProvider } from "../core/providers/systemone.js";
import type { FilterExpr, Rubric } from "../core/schema.js";

const SESSION_PATH = process.env["BENCH_SESSION_PATH"] ?? "";
const PROJECT_NAME = process.env["BENCH_PROJECT_NAME"] ?? "";
const SEGMENT_START = 1;
const SEGMENT_END = 100;
const CAPS = {
  reasoning: 500,
  text: 200,
  arguments: 300,
  result: 300,
  error: 150,
};

const BENCH_DIR = path.join(projectRoot(), "fixtures", "bench");
const DATASET_PATH = path.join(BENCH_DIR, "bench-session.jsonl");
const DB_PATH = path.join(BENCH_DIR, "runs.sqlite");
const C1_DB_PATH = path.join(BENCH_DIR, "runs-c1.sqlite");
const C4_DB_PATH = path.join(BENCH_DIR, "runs-c4.sqlite");
const REJECTED_ATTEMPTS_PATH = path.join(
  BENCH_DIR,
  "rejected-attempts.json",
);
const DATA_NOTE =
  "Все платные прогоны L10 (финальные 7 и отброшенные 9) шли на копиях " +
  "до финальной правки маркеров: в Polza (третьей стороне) уходили пути и фрагменты приватных " +
  "указаний. Опубликованные fixtures строже; метрики не пересчитывались.";

type RejectedAttempt = Record<string, unknown> & { costRub?: number };

function loadRejectedAttempts(): RejectedAttempt[] {
  try {
    const parsed = JSON.parse(
      readFileSync(REJECTED_ATTEMPTS_PATH, "utf8"),
    ) as { attempts?: RejectedAttempt[] };
    return Array.isArray(parsed.attempts) ? parsed.attempts : [];
  } catch {
    return [];
  }
}

interface PiToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: unknown;
}

interface PiMessage {
  role: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  content?: Array<{ type: string; text?: string; thinking?: string }>;
}

interface PiEntry {
  type?: string;
  message?: PiMessage;
}

interface ExtractedStep {
  step_id: string;
  role: "assistant";
  content: string;
  reasoning: string;
  tool_name: string;
  arguments: string;
  status: "ok" | "error";
  error: string | null;
  result: string;
  original_step: number;
}

interface LeakScan {
  apiKeys: number;
  bearer: number;
  envKeys: number;
  emails: number;
  phones: number;
  homePaths: number;
  homeDirs: number;
  projectRoots: number;
  projectNames: number;
  absolutePaths: number;
  quotes: number;
  uuids: number;
}

interface SanitizeStats {
  homePaths: number;
  homeDirs: number;
  projectPaths: number;
  projectNames: number;
  absolutePaths: number;
  quotes: number;
  quoteLines: number;
  secrets: number;
  emails: number;
  phones: number;
  uuids: number;
}

function limit(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}…[truncated ${text.length - cap} chars]`;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(pza_[A-Za-z0-9]+)/g, "[REDACTED_API_KEY]"],
  [/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED_API_KEY]"],
  [/(ghp_[A-Za-z0-9]{20,})/g, "[REDACTED_TOKEN]"],
  [/(AKIA[0-9A-Z]{16})/g, "[REDACTED_AWS_KEY]"],
  [/(xox[baprs]-[A-Za-z0-9-]+)/g, "[REDACTED_SLACK_TOKEN]"],
  [/(Bearer\s+[A-Za-z0-9._-]{6,})/gi, "Bearer [REDACTED]"],
  [/((?:POLZA|OPENROUTER)_API_KEY\s*=\s*[^\s"']+)/g, "[REDACTED_ENV_SECRET]"],
];

const REDACTION_MARKER = "[фрагмент удалён по приватности]";

/** Системные POSIX-пути: не приватные, но по требованию маскируются целиком. */
const POSIX_ABS_RE =
  /(?<![\w.])\/(?:c|mnt|tmp|var|opt|usr|etc|home|Users)\/[A-Za-z0-9._@%+~-]+(?:\/[A-Za-z0-9._@%+~-]+)*/g;

/** Фразы, которыми reasoning/текст цитирует приватные инструкции и переписку. */
const QUOTE_MARKERS =
  /(Key corrections|The follow-up|follow-up says|the orchestrator|orchestrator is asking|The user says|The user asked|user asked|\bthe task\b|task description|task says|\bthe plan\b|plan says|\bS\d{2}(?:-[A-Z0-9]+)?\b|\bprompt\b|\binstructions?\b|\bowner\b|\breviewer\b|\bsubagent\b|владелец|оркестратор|переписк|задани|инструкц|план|пользовател)/i;

/**
 * Раскрывает экранированные git-bash пути: `C\:\\Users\\User` → `C:\Users\User`.
 * Нужно и для маски, и для независимого скана — иначе один узкий regex
 * не видит утечку в экранированном виде.
 */
function normalizePathEscapes(text: string): string {
  return text
    .replace(/\\+:/g, ":")
    .replace(/\\{2,}/g, "\\")
    .replace(/\\\//g, "/");
}

function replaceCounted(
  text: string,
  pattern: RegExp,
  replacement: string,
  add: (count: number) => void,
): string {
  return text.replace(pattern, () => {
    add(1);
    return replacement;
  });
}

/**
 * Обезличивает текст. `redactQuotes` включается для reasoning/текста ассистента:
 * если там есть цитата инструкций, поле целиком заменяется маркером.
 * Пути режутся вместе с корнем: от домашнего корня и от `C:\PY` не остаётся
 * ни сегментов, ни имени пользователя.
 */
function sanitize(
  text: string,
  stats: SanitizeStats,
  redactQuotes: boolean,
): string {
  if (redactQuotes && QUOTE_MARKERS.test(text)) {
    stats.quotes += 1;
    return REDACTION_MARKER;
  }

  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = replaceCounted(result, pattern, replacement, (count) => {
      stats.secrets += count;
    });
  }

  // Раскрываем экранированные git-bash пути до применения масок.
  result = normalizePathEscapes(result);

  // Всё от домашнего корня целиком, включая имена файлов и каталогов.
  result = replaceCounted(
    result,
    /(?:[A-Za-z]:|[\\/][A-Za-z])?[\\/]*Users[\\/]+User[^\s"'`<>|)]*/gi,
    "<HOME_PATH>",
    (count) => {
      stats.homePaths += count;
    },
  );
  // Структура домашнего каталога, даже без самого корня.
  result = replaceCounted(
    result,
    /\b(?:\.rustup|\.cargo|AppData|toolchains)(?:[\\/][^\s"'`<>|)]*)?/gi,
    "<HOME_DIR>",
    (count) => {
      stats.homeDirs += count;
    },
  );
  // Корень проектов C:\PY\…, \PY\…, /c/PY/… — целиком.
  result = replaceCounted(
    result,
    /(?:[A-Za-z]:|[\\/][A-Za-z])?[\\/]+PY(?:[\\/][^\s"'`<>|)]*)?/gi,
    "<PROJECT_PATH>",
    (count) => {
      stats.projectPaths += count;
    },
  );
  // Остатки после старой маски проекта: PY<PROJECT_NAME>, PY\…, PY/….
  result = replaceCounted(
    result,
    /\bPY(?:<[^>\s]+>|[\\/][^\s"'`<>|)]*)/g,
    "<PROJECT_PATH>",
    (count) => {
      stats.projectPaths += count;
    },
  );
  if (PROJECT_NAME.length > 0) {
    const parts = result.split(PROJECT_NAME);
    if (parts.length > 1) {
      stats.projectNames += parts.length - 1;
      result = parts.join("<PROJECT_NAME>");
    }
  }
  // Имя проекта могло стоять сразу после корня `PY` без разделителя:
  // `PYScreenMemory` уже стало `PY<PROJECT_NAME>` — добираем этот остаток.
  result = replaceCounted(
    result,
    /\bPY<[^>\s]+>/g,
    "<PROJECT_PATH>",
    (count) => {
      stats.projectPaths += count;
    },
  );

  // Последний рубеж по путям: любые оставшиеся абсолютные Windows-пути
  // (системные каталоги и т.п.) тоже не нужны для оценки.
  result = replaceCounted(
    result,
    /(?<![\w])[A-Za-z]:[\\/](?![nrt"'\\])[^\s"'`<>|)]*/g,
    "<ABS_PATH>",
    (count) => {
      stats.absolutePaths += count;
    },
  );

  // Системные POSIX-пути (`/tmp/...`, `/var/...`) — тоже абсолютные.
  result = replaceCounted(result, POSIX_ABS_RE, "<ABS_PATH>", (count) => {
    stats.absolutePaths += count;
  });

  result = replaceCounted(
    result,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "<UUID>",
    (count) => {
      stats.uuids += count;
    },
  );
  result = replaceCounted(
    result,
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    "<EMAIL>",
    (count) => {
      stats.emails += count;
    },
  );
  result = replaceCounted(
    result,
    /(?:\+7|\b8)[\s(-]?\d{3}[\s)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/g,
    "<PHONE>",
    (count) => {
      stats.phones += count;
    },
  );

  // В результатах/аргументах не рушим всё поле: вырезаем строки с цитатами
  // заданий и следующий за ними список, остальной технический текст сохраняем.
  if (!redactQuotes && QUOTE_MARKERS.test(result)) {
    const kept: string[] = [];
    let skippingBullets = false;
    for (const line of result.split("\n")) {
      if (QUOTE_MARKERS.test(line)) {
        stats.quoteLines += 1;
        skippingBullets = true;
        continue;
      }
      if (skippingBullets && /^\s*(?:[-*•]|\d+\.)\s+/.test(line)) {
        stats.quoteLines += 1;
        continue;
      }
      skippingBullets = false;
      kept.push(line);
    }
    result = kept.join("\n").trimEnd();
    if (result.trim().length === 0) result = REDACTION_MARKER;
  }
  return result;
}

/**
 * Независимый скан утечек: отдельные паттерны для домашних/проектных путей,
 * структуры домашнего каталога, цитат переписки, ключей и PII. Работает по
 * исходному тексту и по нормализованным путям, чтобы экранирование не прятало
 * утечку. Не использует regex из sanitize().
 */
function scanLeaks(text: string): LeakScan {
  const normalized = normalizePathEscapes(text);
  const count = (pattern: RegExp): number => {
    const raw = text.match(pattern)?.length ?? 0;
    const escaped = normalized.match(pattern)?.length ?? 0;
    return Math.max(raw, escaped);
  };
  return {
    apiKeys: count(
      /(pza_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,})/g,
    ),
    bearer: count(/Bearer\s+[A-Za-z0-9._-]{6,}/gi),
    envKeys: count(/\b(?:POLZA|OPENROUTER)_API_KEY\s*=\s*\S+/g),
    emails: count(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g),
    phones: count(
      /(?:\+7|\b8)[\s(-]?\d{3}[\s)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/g,
    ),
    homePaths: count(
      /(?:[A-Za-z]:|[\\/][A-Za-z])?[\\/]*Users[\\/]+User/gi,
    ),
    homeDirs: count(/\.rustup|\.cargo|AppData[\\/]|toolchains/gi),
    projectRoots:
      count(/(?:[A-Za-z]:|[\\/][A-Za-z])?[\\/]+PY(?:[\\/]|$)/gi) +
      count(/\bPY<[^>\s]+>|\bPY[\\/][A-Za-z0-9_-]+/g),
    projectNames:
      PROJECT_NAME.length === 0 ? 0 : text.split(PROJECT_NAME).length - 1,
    absolutePaths:
      count(/(?<![\w])[A-Za-z]:[\\/](?![nrt"'\\])/g) + count(POSIX_ABS_RE),
    quotes: count(
      /Key corrections|The follow-up|follow-up says|the orchestrator|orchestrator is asking|The user says|The user asked|user asked|\bthe task\b|task description|task says|\bthe plan\b|plan says|\bS\d{2}(?:-[A-Z0-9]+)?\b|\bprompt\b|\binstructions?\b|\bowner\b|\breviewer\b|\bsubagent\b|владелец|оркестратор|переписк|задани|инструкц|план|пользовател/gi,
    ),
    uuids: count(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    ),
  };
}

function parseEntries(): PiEntry[] {
  return readFileSync(SESSION_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as PiEntry;
      } catch {
        return {};
      }
    });
}

function textOf(message: PiMessage | undefined): string {
  if (message === undefined || !Array.isArray(message.content)) return "";
  return message.content
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .filter((part) => part.length > 0)
    .join("\n");
}

function thinkingOf(message: PiMessage | undefined): string {
  if (message === undefined || !Array.isArray(message.content)) return "";
  return message.content
    .map((block) => (block.type === "thinking" ? (block.thinking ?? "") : ""))
    .filter((part) => part.length > 0)
    .join("\n");
}

function buildDataset(): {
  steps: ExtractedStep[];
  rawScan: LeakScan;
  sanitizedScan: LeakScan;
  replacements: SanitizeStats;
  sourceSha256: string;
  sourceEntries: number;
} {
  const sourceText = readFileSync(SESSION_PATH, "utf8");
  const sourceSha256 = createHash("sha256").update(sourceText).digest("hex");
  const entries = parseEntries();
  const messages = entries
    .filter(
      (entry): entry is PiEntry & { message: PiMessage } =>
        entry.type === "message" && entry.message !== undefined,
    )
    .map((entry) => entry.message);

  const resultsByCall = new Map<string, PiMessage>();
  for (const message of messages) {
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      resultsByCall.set(message.toolCallId, message);
    }
  }

  const rawChunks: string[] = [];
  const steps: ExtractedStep[] = [];
  const replacements: SanitizeStats = {
    homePaths: 0,
    homeDirs: 0,
    projectPaths: 0,
    projectNames: 0,
    absolutePaths: 0,
    quotes: 0,
    quoteLines: 0,
    secrets: 0, 
    emails: 0,
    phones: 0,
    uuids: 0,
  };
  let toolStep = 0;

  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const calls = message.content.filter(
      (block): block is PiToolCall => block.type === "toolCall",
    );
    if (calls.length === 0) continue;
    toolStep += 1;
    if (toolStep < SEGMENT_START || toolStep > SEGMENT_END) continue;

    const results = calls
      .map((call) => resultsByCall.get(call.id))
      .filter((result): result is PiMessage => result !== undefined);
    const resultText = results.map((result) => textOf(result)).join("\n");
    // Ошибкой считаем только явный флаг инструмента или строгую строку ошибки:
    // слово "error" внутри вывода тестов/кода — ещё не сбой шага.
    const strictError =
      /^(✖|not ok\b|FAIL\b|FAILED\b|AssertionError|Assertion failed|error TS\d+|npm ERR!|Error:|ERROR\b|Traceback|fatal:|Command failed|Permission denied|No such file|EPERM|ERR_[A-Z])/;
    const errorText =
      results
        .flatMap((result) => textOf(result).split("\n"))
        .map((line) => line.trim())
        .find((line) => strictError.test(line)) ?? null;
    const isError =
      results.some((result) => result.isError === true) || errorText !== null;

    const step: ExtractedStep = {
      step_id: `bench_${String(toolStep).padStart(4, "0")}`,
      role: "assistant",
      content: limit(sanitize(textOf(message), replacements, true), CAPS.text),
      reasoning: limit(
        sanitize(thinkingOf(message), replacements, true),
        CAPS.reasoning,
      ),
      tool_name: calls.map((call) => call.name).join("+"),
      arguments: JSON.stringify(
        calls.map((call) => ({
          tool: call.name,
          arguments: limit(
            sanitize(
              JSON.stringify(call.arguments ?? {}),
              replacements,
              false,
            ),
            CAPS.arguments,
          ),
        })),
      ),
      status: isError ? "error" : "ok",
      error:
        errorText === null
          ? null
          : limit(sanitize(errorText, replacements, false), CAPS.error),
      result: limit(sanitize(resultText, replacements, false), CAPS.result),
      original_step: toolStep,
    };
    steps.push(step);
    rawChunks.push(
      JSON.stringify({
        content: textOf(message),
        reasoning: thinkingOf(message),
        result: resultText,
        arguments: calls.map((call) => call.arguments ?? {}),
      }),
    );
  }

  const sanitizedText = steps.map((step) => JSON.stringify(step)).join("\n");
  return {
    steps,
    rawScan: scanLeaks(rawChunks.join("\n")),
    sanitizedScan: scanLeaks(sanitizedText),
    replacements,
    sourceSha256,
    sourceEntries: entries.length,
  };
}

type BenchAlias = "gemini" | "ms" | "jev" | "luna";

const BENCH_SOURCE = {
  type: "jsonl" as const,
  path: "fixtures/bench/bench-session.jsonl",
  id_field: "step_id",
  projection: "skeleton" as const,
  prefilter_tags: true,
};

const BENCH_RUBRIC: Rubric = {
  name: "bench_screening",
  guide:
    "Оценивай шаг агентской сессии: ошибки инструментов, зацикливание, тупик, игнорирование требований. Большинство шагов штатные — не завышай оценку без явного сигнала.",
  questions: {
    is_problem: {
      type: "bool",
      instructions: "Есть ли на этом шаге признак сбоя или риска?",
      true_description: "Ошибка, повтор, тупик или нарушение требования.",
      false_description: "Штатный шаг без проблем.",
    },
    problem_score: {
      type: "score",
      instructions: "Насколько серьезна проблема на шаге?",
      levels: ["нет", "мелкая", "существенная", "критичная"],
    },
  },
};

const DEEP_RUBRIC: Rubric = {
  name: "bench_deep",
  questions: {
    reasoning_logic_fail: {
      type: "bool",
      instructions: "Противоречит ли reasoning фактам из контекста?",
    },
    overthinking_loop: {
      type: "bool",
      instructions: "Есть ли в reasoning хождение по кругу?",
    },
    bad_tool_call: {
      type: "bool",
      instructions: "Допущена ли ошибка выбора или вызова инструмента?",
    },
    impact_severity: {
      type: "score",
      instructions: "Какова цена ошибки для сессии?",
      levels: ["нулевая", "низкая", "средняя", "высокая"],
    },
    root_cause: {
      type: "choice",
      instructions: "Какова наиболее вероятная первопричина?",
      options: {
        permissions: "права доступа",
        tool: "ошибка инструмента",
        reasoning: "логика агента",
        other: "другое или не определить",
      },
    },
  },
};

const DEEP_WHERE: FilterExpr = {
  conditions: [
    { question_id: "problem_score", field: "score", op: ">=", value: 1.0 },
  ],
};

interface GreyZones {
  red: number;
  green: number;
  grey: number;
}

interface ModelBench {
  alias: BenchAlias;
  runId: string;
  status: RunDecisionOutput["status"];
  warnings: string[];
  stats: RunDecisionOutput["stats"];
  summary: RunDecisionOutput["summary"];
  planBatches: number;
  estimatedTokens: number;
  itemsPerSec: number;
  secPerBatch: number;
  tokensPerItem: number;
  costPer1000: number;
  estimateErrorPct: number | null;
  boolZones: GreyZones;
  scoreAtLeast15: number;
  scoreAtLeast25: number;
}

interface CompareRow {
  left: BenchAlias;
  right: BenchAlias;
  bool: {
    matched: number;
    meanAbsDiff: number | null;
    agreement: number | null;
    contrasts: number;
  } | null;
  score: {
    matched: number;
    meanAbsDiff: number | null;
    contrasts: number;
  } | null;
}

function resetSqlite(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

function providerFor(config: AppConfig): SystemOneProvider {
  return new SystemOneProvider({
    name: config.provider.name,
    apiKey: config.provider.apiKey,
    decisionsUrl: config.provider.decisionsUrl,
    catalogUrl: config.provider.catalogUrl,
    timeoutMs: config.timeoutMs,
  });
}

async function collectZones(
  engine: DecisionEngine,
  runId: string,
): Promise<{ zones: GreyZones; atLeast15: number; atLeast25: number }> {
  const items = await engine.queryRun({
    action: "filter",
    run_id: runId,
    limit: 200,
  });
  if (items.action !== "filter") throw new Error("ожидался filter");
  const zones: GreyZones = { red: 0, green: 0, grey: 0 };
  let atLeast15 = 0;
  let atLeast25 = 0;
  for (const item of items.result.items) {
    const prob = item.answers["is_problem"]?.prob;
    if (typeof prob === "number") {
      if (prob <= 0.1) zones.red += 1;
      else if (prob >= 0.9) zones.green += 1;
      else zones.grey += 1;
    }
    const score = item.answers["problem_score"]?.score;
    if (typeof score === "number") {
      if (score >= 1.5) atLeast15 += 1;
      if (score >= 2.5) atLeast25 += 1;
    }
  }
  return { zones, atLeast15, atLeast25 };
}

async function runModel(
  engine: DecisionEngine,
  alias: BenchAlias,
): Promise<ModelBench> {
  console.log(`[FREE] dry_run ${alias}: план без сети`);
  const dry = await engine.runDecision({
    model: alias,
    source: BENCH_SOURCE,
    rubric: BENCH_RUBRIC,
    dry_run: true,
  });
  const estimatedTokens = dry.plan?.estimated_tokens ?? 0;
  const planBatches = dry.plan?.batches ?? 0;

  console.log(`[PAID] ${alias}: ${dry.stats.items_total} элементов, 2 вопроса`);
  const live = await engine.runDecision({
    model: alias,
    source: BENCH_SOURCE,
    rubric: BENCH_RUBRIC,
    return_top: 5,
  });
  const stats = live.stats;
  const items = stats.items_total > 0 ? stats.items_total : 1;
  const seconds = stats.duration_ms / 1000;
  const zones = await collectZones(engine, live.run_id ?? "");
  console.log(
    `[PAID] ${alias}: run=${live.run_id} status=${live.status} items=${stats.items_total} batches=${stats.batches_total} in=${stats.input_tokens} out=${stats.output_tokens} cost=${stats.cost_rub ?? "?"} ₽ dur=${stats.duration_ms}ms`,
  );

  return {
    alias,
    runId: live.run_id ?? "",
    status: live.status,
    warnings: live.warnings,
    stats,
    summary: live.summary,
    planBatches,
    estimatedTokens,
    itemsPerSec: seconds > 0 ? items / seconds : 0,
    secPerBatch:
      stats.batches_total > 0 ? seconds / stats.batches_total : 0,
    tokensPerItem: stats.input_tokens / items,
    costPer1000: ((stats.cost_rub ?? 0) / items) * 1000,
    estimateErrorPct:
      stats.input_tokens > 0
        ? ((estimatedTokens - stats.input_tokens) / stats.input_tokens) * 100
        : null,
    boolZones: zones.zones,
    scoreAtLeast15: zones.atLeast15,
    scoreAtLeast25: zones.atLeast25,
  };
}

async function compareModels(
  engine: DecisionEngine,
  runs: Record<BenchAlias, ModelBench>,
): Promise<CompareRow[]> {
  const pairs: Array<[BenchAlias, BenchAlias]> = [
    ["gemini", "ms"],
    ["gemini", "jev"],
    ["gemini", "luna"],
    ["ms", "jev"],
    ["ms", "luna"],
    ["jev", "luna"],
  ];
  const rows: CompareRow[] = [];
  for (const [left, right] of pairs) {
    const result = await engine.queryRun({
      action: "compare",
      run_id: runs[left].runId,
      compare_run_id: runs[right].runId,
    });
    if (result.action !== "compare") throw new Error("ожидался compare");
    const bool = result.result.questions["is_problem"];
    const score = result.result.questions["problem_score"];
    rows.push({
      left,
      right,
      bool: bool
        ? {
            matched: bool.matched,
            meanAbsDiff: bool.meanAbsDiff,
            agreement: bool.agreement,
            contrasts: bool.contrasts.length,
          }
        : null,
      score: score
        ? {
            matched: score.matched,
            meanAbsDiff: score.meanAbsDiff,
            contrasts: score.contrasts.length,
          }
        : null,
    });
  }
  return rows;
}

async function main(): Promise<void> {
  if (SESSION_PATH.length === 0) {
    console.error(
      "Задайте BENCH_SESSION_PATH — путь к JSONL-сессии Pi (assistant steps с tool_calls и reasoning)",
    );
    process.exitCode = 1;
    return;
  }

  mkdirSync(BENCH_DIR, { recursive: true });
  resetSqlite(DB_PATH);
  resetSqlite(C1_DB_PATH);
  resetSqlite(C4_DB_PATH);

  // --- Данные и обезличивание ---------------------------------------------
  const dataset = buildDataset();
  const leakTotal = Object.values(dataset.sanitizedScan).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (leakTotal > 0) {
    throw new Error(
      `После обезличивания остались утечки: ${JSON.stringify(dataset.sanitizedScan)}`,
    );
  }
  writeFileSync(
    DATASET_PATH,
    `${dataset.steps.map((step) => JSON.stringify(step)).join("\n")}\n`,
    "utf8",
  );
  const dataSummary = {
    source: "Pi agent session (2026-11-22), assistant steps; user messages excluded",
    sourceSha256: dataset.sourceSha256,
    sourceEntries: dataset.sourceEntries,
    segment: `${SEGMENT_START}..${SEGMENT_END} tool-call steps`,
    steps: dataset.steps.length,
    errorSteps: dataset.steps.filter((step) => step.status === "error").length,
    caps: CAPS,
    rawScan: dataset.rawScan,
    sanitizedScan: dataset.sanitizedScan,
    replacements: dataset.replacements,
    sanitizationNote:
      "Экранированные пути нормализуются; домашний/проектный/абсолютный корни режутся целиком; " +
      "публичные схемы URL/file:// сохраняются; reasoning/текст с приватными указаниями " +
      "заменяется маркером, в результатах и аргументах строки с такими указаниями вырезаются. " +
      "Скан утечек — отдельными паттернами.",
  };
  writeFileSync(
    path.join(BENCH_DIR, "data-provenance.json"),
    JSON.stringify(dataSummary, null, 2),
    "utf8",
  );
  console.log(
    `[FREE] dataset: steps=${dataset.steps.length} errors=${dataSummary.errorSteps} sanitized=${JSON.stringify(dataset.sanitizedScan)} replacements=${JSON.stringify(dataset.replacements)}`,
  );

  if (process.argv.includes("--extract-only")) {
    console.log("extract-only: данные обезличены, платные замеры пропущены");
    return;
  }

  const baseConfig = loadConfig();
  const config: AppConfig = {
    ...baseConfig,
    dbPath: DB_PATH,
    maxConcurrency: 4,
  };
  const engine = new DecisionEngine({ config, provider: providerFor(config) });
  const runs: Partial<Record<BenchAlias, ModelBench>> = {};
  const paidRuns: Array<Record<string, unknown>> = [];
  let totalCost = 0;

  try {
    for (const alias of ["gemini", "ms", "jev", "luna"] as const) {
      const result = await runModel(engine, alias);
      runs[alias] = result;
      totalCost += result.stats.cost_rub ?? 0;
      paidRuns.push({
        label: `model/${alias}`,
        alias,
        runId: result.runId,
        costRub: result.stats.cost_rub,
        inputTokens: result.stats.input_tokens,
        outputTokens: result.stats.output_tokens,
        batches: result.stats.batches_total,
        durationMs: result.stats.duration_ms,
      });
    }

    const completeRuns = runs as Record<BenchAlias, ModelBench>;
    const comparisons = await compareModels(engine, completeRuns);

    // --- Параллельность на узком окне ms ----------------------------------
    const concurrencyRuns: Array<Record<string, unknown>> = [];
    for (const limit of [1, 4] as const) {
      const dbPath = limit === 1 ? C1_DB_PATH : C4_DB_PATH;
      const cfg: AppConfig = { ...config, dbPath, maxConcurrency: limit };
      const concurrentEngine = new DecisionEngine({
        config: cfg,
        provider: providerFor(cfg),
      });
      try {
        const dry = await concurrentEngine.runDecision({
          model: "ms",
          source: BENCH_SOURCE,
          rubric: BENCH_RUBRIC,
          dry_run: true,
        });
        console.log(`[PAID] concurrency/${limit}: ms, ${dry.stats.items_total} элементов`);
        const live = await concurrentEngine.runDecision({
          model: "ms",
          source: BENCH_SOURCE,
          rubric: BENCH_RUBRIC,
          return_top: 5,
        });
        const seconds = live.stats.duration_ms / 1000;
        concurrencyRuns.push({
          concurrency: limit,
          planBatches: dry.plan?.batches ?? 0,
          runId: live.run_id,
          batches: live.stats.batches_total,
          items: live.stats.items_total,
          durationMs: live.stats.duration_ms,
          itemsPerSec:
            seconds > 0 ? live.stats.items_total / seconds : 0,
          secPerBatch:
            live.stats.batches_total > 0
              ? seconds / live.stats.batches_total
              : 0,
          costRub: live.stats.cost_rub,
        });
        totalCost += live.stats.cost_rub ?? 0;
        paidRuns.push({
          label: `concurrency/${limit}`,
          alias: "ms",
          runId: live.run_id,
          costRub: live.stats.cost_rub,
          inputTokens: live.stats.input_tokens,
          outputTokens: live.stats.output_tokens,
          batches: live.stats.batches_total,
          durationMs: live.stats.duration_ms,
        });
        console.log(
          `[PAID] concurrency/${limit}: batches=${live.stats.batches_total} dur=${live.stats.duration_ms}ms cost=${live.stats.cost_rub ?? "?"} ₽`,
        );
      } finally {
        concurrentEngine.close();
      }
    }

    // --- Глубокий разбор jev на отобранных элементах ----------------------
    let deepRun: Record<string, unknown> | null = null;
    const selected = await engine.queryRun({
      action: "filter",
      run_id: completeRuns.gemini.runId,
      where: DEEP_WHERE,
      limit: 20,
    });
    if (selected.action !== "filter") throw new Error("ожидался filter");
    if (selected.result.total > 0) {
      console.log(
        `[PAID] deep/jev: ${selected.result.total} отобранных элементов, 5 вопросов`,
      );
      const deep = await engine.runDecision({
        model: "jev",
        source: {
          type: "from_run",
          run_id: completeRuns.gemini.runId,
          where: DEEP_WHERE,
          context_window: 0,
          projection: "full",
          limit: 20,
        },
        rubric: DEEP_RUBRIC,
        return_top: 5,
      });
      const seconds = deep.stats.duration_ms / 1000;
      deepRun = {
        runId: deep.run_id,
        selected: selected.result.total,
        stats: deep.stats,
        summary: deep.summary,
        itemsPerSec: seconds > 0 ? deep.stats.items_total / seconds : 0,
        secPerBatch:
          deep.stats.batches_total > 0
            ? seconds / deep.stats.batches_total
            : 0,
        costPer1000:
          deep.stats.items_total > 0
            ? ((deep.stats.cost_rub ?? 0) / deep.stats.items_total) * 1000
            : null,
      };
      totalCost += deep.stats.cost_rub ?? 0;
      paidRuns.push({
        label: "deep/jev",
        alias: "jev",
        runId: deep.run_id,
        costRub: deep.stats.cost_rub,
        inputTokens: deep.stats.input_tokens,
        outputTokens: deep.stats.output_tokens,
        batches: deep.stats.batches_total,
        durationMs: deep.stats.duration_ms,
      });
      console.log(
        `[PAID] deep/jev: run=${deep.run_id} items=${deep.stats.items_total} batches=${deep.stats.batches_total} in=${deep.stats.input_tokens} cost=${deep.stats.cost_rub ?? "?"} ₽`,
      );
    } else {
      console.log("[FREE] deep/jev: нет элементов с problem_score >= 1.5, пропуск");
    }

    const rejectedAttempts = loadRejectedAttempts();
    const rejectedTotal = rejectedAttempts.reduce(
      (sum, attempt) =>
        sum + (typeof attempt.costRub === "number" ? attempt.costRub : 0),
      0,
    );
    const summary = {
      generatedAt: new Date().toISOString(),
      provider: config.provider.name,
      data: dataSummary,
      models: Object.values(completeRuns),
      comparisons,
      concurrency: concurrencyRuns,
      deep: deepRun,
      paidRuns,
      rejectedAttempts,
      totalCostRub: Number(totalCost.toFixed(8)),
      rejectedTotalRub: Number(rejectedTotal.toFixed(8)),
      lotTotalRub: Number((totalCost + rejectedTotal).toFixed(8)),
      dataNote: DATA_NOTE,
    };
    writeFileSync(
      path.join(BENCH_DIR, "summary.json"),
      JSON.stringify(summary, null, 2),
      "utf8",
    );

    console.log("\n=== Bench summary ===");
    for (const model of Object.values(completeRuns)) {
      console.log(
        `${model.alias}: status=${model.status} items/s=${model.itemsPerSec.toFixed(2)} batches=${model.stats.batches_total} cost/1000=${model.costPer1000.toFixed(4)} ₽ est_err=${model.estimateErrorPct?.toFixed(1) ?? "?"}% grey=${model.boolZones.grey}/${model.boolZones.red}/${model.boolZones.green}`,
      );
    }
    console.log(`[PAID] total: ${summary.totalCostRub} ₽`);
    console.log(`Сводка: ${path.join(BENCH_DIR, "summary.json")}`);
  } finally {
    engine.close();
    resetSqlite(DB_PATH);
    resetSqlite(C1_DB_PATH);
    resetSqlite(C4_DB_PATH);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
