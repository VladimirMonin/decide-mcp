/**
 * Полная воронка from_run (Этапы 0–3) на реальной агентской сессии.
 *
 * Источник — JSONL-сессия Pi (assistant steps с reasoning и tool_calls).
 * Перед использованием сессия обезличивается: домашние пути, UUID сессий,
 * ключи/токены, email и телефоны заменяются плейсхолдерами; в fixtures кладётся
 * только обезличенная техническая копия. Прогон идёт через `DecisionEngine`
 * (тот же фасад, что у MCP), платные вызовы помечены `[PAID]`.
 *
 * Запуск:
 *   FUNNEL_SESSION_PATH=<путь к JSONL-сессии Pi>  *   [FUNNEL_STAGE2_MODEL=gemini|jev|luna]  *   node dist/cli/funnel-check.js [--extract-only]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, projectRoot, type AppConfig } from "../core/config.js";
import { DecisionEngine, type RunDecisionOutput } from "../core/engine.js";
import { SystemOneProvider } from "../core/providers/systemone.js";
import { RunStore } from "../core/store.js";
import { readSource } from "../core/sources.js";
import type {
  CatalogModelInfo,
  DecisionProvider,
  ProviderBatchRequest,
  ProviderBatchResponse,
} from "../core/providers/types.js";
import type { FilterExpr } from "../core/schema.js";

const SESSION_PATH = process.env["FUNNEL_SESSION_PATH"] ?? "";
const PROJECT_NAME = process.env["FUNNEL_PROJECT_NAME"] ?? "";
const SEGMENT_START = 41;
const SEGMENT_END = 80;

const CAPS = {
  reasoning: 400,
  text: 150,
  arguments: 250,
  result: 250,
  error: 120,
};

const FUNNEL_DIR = path.join(projectRoot(), "fixtures", "funnel");
const DATASET_PATH = path.join(FUNNEL_DIR, "session-sanitized.jsonl");
const DB_PATH = path.join(FUNNEL_DIR, "runs.sqlite");

const STAGE1_WHERE: FilterExpr = {
  conditions: [
    { question_id: "problem_score", field: "score", op: ">=", value: 1.5 },
  ],
};

const SEVERITY_WHERE: FilterExpr = {
  conditions: [
    { question_id: "impact_severity", field: "score", op: ">=", value: 1.5 },
  ],
};

const STAGE2_MODEL: "gemini" | "jev" | "luna" =
  process.env["FUNNEL_STAGE2_MODEL"] === "jev"
    ? "jev"
    : process.env["FUNNEL_STAGE2_MODEL"] === "luna"
      ? "luna"
      : "gemini";

const STAGE2_BOOLS = [
  "reasoning_logic_fail",
  "overthinking_loop",
  "bad_tool_call",
  "prompt_violation",
] as const;

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

class CountingProvider implements DecisionProvider {
  readonly name: string;
  calls = 0;

  constructor(private readonly inner: DecisionProvider) {
    this.name = inner.name;
  }

  async decide(request: ProviderBatchRequest): Promise<ProviderBatchResponse> {
    this.calls += 1;
    return this.inner.decide(request);
  }

  async fetchCatalog(): Promise<CatalogModelInfo[]> {
    this.calls += 1;
    return this.inner.fetchCatalog();
  }
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

/**
 * Windows-путь целиком, включая пробелы (`Program Files`): режет до конца
 * токена, но не съедает ` 2>`, ` &&` и ` ||`.
 */
const WINDOWS_ABS_TOKEN_RE =
  /[A-Za-z]:[\\/](?:[^\\/:*?"<>|&\r\n]+[\\/])*[^\\/:*?"<>|&\r\n]+/g;

/** Системные POSIX-пути: не приватные, но по требованию маскируются целиком. */
const POSIX_ABS_RE =
  /(?<![\w.])\/(?:c|mnt|tmp|var|opt|usr|etc|home|Users)\/[A-Za-z0-9._@%+~-]+(?:\/[A-Za-z0-9._@%+~-]+)*/g;

/** Фразы, которыми reasoning/текст цитирует приватные инструкции и переписку. */
const QUOTE_MARKERS =
  /(Key corrections|The follow-up|follow-up says|the orchestrator|orchestrator is asking|The user says|The user asked|user asked|\bthe task\b|task description|task says|\bthe plan\b|plan says|\bS\d{2}(?:-[A-Z0-9]+)?\b|\bprompt\b|\binstructions?\b|\bowner\b|\breviewer\b|\bsubagent\b|владелец|оркестратор|переписк|задани|инструкц|\bплан|пользовател)/i;

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
    /\b(?:\.rustup|\.cargo|AppData)(?:[\\/][^\s"'`<>|)]*)?/gi,
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

  // Сначала весь Windows-путь, включая пробелы (`Program Files`), чтобы не
  // оставлять голый хвост `Files\Rust\...`; ` 2>` и ` &&` остаются снаружи.
  result = result.replace(WINDOWS_ABS_TOKEN_RE, (matched) => {
    stats.absolutePaths += 1;
    const trailing = matched.match(/\s*$/)?.[0] ?? "";
    const core = matched.slice(0, matched.length - trailing.length);
    const fd = core.match(/\s+\d+$/)?.[0] ?? "";
    return `<ABS_PATH>${fd}${trailing}`;
  });

  // Последний рубеж: оставшиеся абсолютные Windows-пути без пробелов
  // (системные каталоги и т.п.) тоже не нужны для оценки.
  result = replaceCounted(
    result,
    /[A-Za-z]:[\\/](?![nrt"'\\])[^\s"'`<>|)]*/g,
    "<ABS_PATH>",
    (count) => {
      stats.absolutePaths += count;
    },
  );

  // Системные POSIX-пути (`/usr/bin/bash` и т.п.) — тоже абсолютные.
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
    homeDirs: count(/\.rustup|\.cargo|AppData[\\/]/gi),
    projectRoots:
      count(/(?:[A-Za-z]:|[\\/][A-Za-z])?[\\/]+PY(?:[\\/]|$)/gi) +
      count(/\bPY<[^>\s]+>|\bPY[\\/][A-Za-z0-9_-]+/g),
    projectNames:
      PROJECT_NAME.length === 0 ? 0 : text.split(PROJECT_NAME).length - 1,
    absolutePaths:
      count(/[A-Za-z]:[\\/](?![nrt"'\\])/g) + count(POSIX_ABS_RE),
    quotes: count(
      /Key corrections|The follow-up|follow-up says|the orchestrator|orchestrator is asking|The user says|The user asked|user asked|\bthe task\b|task description|task says|\bthe plan\b|plan says|\bS\d{2}(?:-[A-Z0-9]+)?\b|\bprompt\b|\binstructions?\b|\bowner\b|\breviewer\b|\bsubagent\b|владелец|оркестратор|переписк|задани|инструкц|\bплан|пользовател/gi,
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
      step_id: `step_${String(toolStep).padStart(3, "0")}`,
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

interface Stage0Stats {
  items: number;
  totalReasoningToks: number;
  maxReasoningToks: number;
  avgReasoningToks: number;
  toolError: number;
  repeatReasoning: number;
  repeatTool: number;
  maxRepeatTool: number;
  reversals: number;
  stepsWithReversals: number;
  invalidJson: number;
  stepsWithTags: number;
}

function stage0Stats(contents: string[]): Stage0Stats {
  let totalReasoningToks = 0;
  let maxReasoningToks = 0;
  let toolError = 0;
  let repeatReasoning = 0;
  let repeatTool = 0;
  let maxRepeatTool = 0;
  let reversals = 0;
  let stepsWithReversals = 0;
  let invalidJson = 0;
  let stepsWithTags = 0;

  for (const content of contents) {
    const reasoningMatch = /reasoning_toks=(\d+)/.exec(content);
    const toks = reasoningMatch ? Number(reasoningMatch[1]) : 0;
    totalReasoningToks += toks;
    maxReasoningToks = Math.max(maxReasoningToks, toks);
    if (/tool_error/.test(content)) toolError += 1;
    if (/repeat_reasoning/.test(content)) repeatReasoning += 1;
    const repeatMatch = /repeat_tool=(\d+)/.exec(content);
    if (repeatMatch) {
      repeatTool += 1;
      maxRepeatTool = Math.max(maxRepeatTool, Number(repeatMatch[1]));
    }
    const reversalMatch = /reversals=(\d+)/.exec(content);
    if (reversalMatch) {
      reversals += Number(reversalMatch[1]);
      stepsWithReversals += 1;
    }
    if (/invalid_json/.test(content)) invalidJson += 1;
    if (/^\[[^\]]+\]$/m.test(content.split("\n").at(-1) ?? "")) stepsWithTags += 1;
  }

  return {
    items: contents.length,
    totalReasoningToks,
    maxReasoningToks,
    avgReasoningToks:
      contents.length === 0 ? 0 : totalReasoningToks / contents.length,
    toolError,
    repeatReasoning,
    repeatTool,
    maxRepeatTool,
    reversals,
    stepsWithReversals,
    invalidJson,
    stepsWithTags,
  };
}

interface PaidRun {
  label: string;
  model: string;
  output: RunDecisionOutput;
}

const paidRuns: PaidRun[] = [];

function recordPaid(label: string, model: string, output: RunDecisionOutput): void {
  paidRuns.push({ label, model, output });
  console.log(
    `[PAID] ${label}: run=${output.run_id} model=${model} status=${output.status} items=${output.stats.items_total} processed=${output.stats.items_processed} batches=${output.stats.batches_total} cost=${output.stats.cost_rub ?? "?"} ₽`,
  );
}

function totalCost(): number {
  return paidRuns.reduce(
    (sum, run) => sum + (run.output.stats.cost_rub ?? 0),
    0,
  );
}

function resetSqlite(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

async function main(): Promise<void> {
  if (SESSION_PATH.length === 0) {
    console.error(
      "Задайте FUNNEL_SESSION_PATH — путь к JSONL-сессии Pi (assistant steps с tool_calls и reasoning)",
    );
    process.exitCode = 1;
    return;
  }

  mkdirSync(FUNNEL_DIR, { recursive: true });
  resetSqlite(DB_PATH);

  // --- Данные и обезличивание --------------------------------------------
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
    source: "Pi agent session (2026-09-27), assistant steps; user messages excluded",
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
      "Экранированные git-bash пути нормализуются до масок; домашний корень и его структура, " +
      "а также корни проектов и абсолютные Windows- и системные POSIX-пути режутся целиком; reasoning/текст " +
      "с приватными указаниями заменяется маркером " + REDACTION_MARKER + ". " +
      "Скан утечек идёт отдельными паттернами, не regex из sanitize().",
  };
  writeFileSync(
    path.join(FUNNEL_DIR, "data-provenance.json"),
    JSON.stringify(dataSummary, null, 2),
    "utf8",
  );
  console.log(
    `[FREE] dataset: steps=${dataset.steps.length} errors=${dataSummary.errorSteps} sanitized_leaks=${JSON.stringify(dataset.sanitizedScan)} replacements=${JSON.stringify(dataset.replacements)}`,
  );

  const baseConfig = loadConfig();
  const config: AppConfig = {
    ...baseConfig,
    dbPath: DB_PATH,
    maxConcurrency: 4,
  };

  // --- Этап 0: префильтр --------------------------------------------------
  const skeletonItems = await readSource(
    {
      type: "jsonl",
      path: "fixtures/funnel/session-sanitized.jsonl",
      id_field: "step_id",
      projection: "skeleton",
      prefilter_tags: true,
    },
    { allowedRoot: config.allowedRoot },
  );
  const stage0 = stage0Stats(skeletonItems.map((item) => item.content));
  writeFileSync(
    path.join(FUNNEL_DIR, "stage0-prefilter.json"),
    JSON.stringify(stage0, null, 2),
    "utf8",
  );
  console.log(
    `[FREE] stage0: items=${stage0.items} tool_error=${stage0.toolError} repeat_reasoning=${stage0.repeatReasoning} repeat_tool=${stage0.repeatTool} max_repeat=${stage0.maxRepeatTool} reversals=${stage0.reversals} avg_reasoning_toks=${Math.round(stage0.avgReasoningToks)}`,
  );

  if (process.argv.includes("--extract-only")) {
    console.log("extract-only: данные обезличены, платные этапы пропущены");
    return;
  }

  const provider = new CountingProvider(
    new SystemOneProvider({
      name: config.provider.name,
      apiKey: config.provider.apiKey,
      decisionsUrl: config.provider.decisionsUrl,
      catalogUrl: config.provider.catalogUrl,
      timeoutMs: config.timeoutMs,
    }),
  );
  const engine = new DecisionEngine({ config, provider });

  try {
    // --- Этап 1: широкий скрининг skeleton --------------------------------
    console.log("[PAID] stage1: skeleton, problem_score, gemini");
    const stage1 = await engine.runDecision({
      model: "gemini",
      source: {
        type: "jsonl",
        path: "fixtures/funnel/session-sanitized.jsonl",
        id_field: "step_id",
        projection: "skeleton",
        prefilter_tags: true,
      },
      rubric: "agent_funnel_stage1.json",
      return_top: 10,
    });
    recordPaid("stage1", "gemini", stage1);
    const stage1RunId = stage1.run_id ?? "";

    const selected = await engine.queryRun({
      action: "filter",
      run_id: stage1RunId,
      where: STAGE1_WHERE,
      limit: 100,
    });
    if (selected.action !== "filter") throw new Error("ожидался filter");
    const targetIds = selected.result.items.map((item) => item.itemId);
    console.log(
      `[FREE] stage1/select: total=${selected.result.total} ids=${targetIds.join(",")}`,
    );
    writeFileSync(
      path.join(FUNNEL_DIR, "stage1-summary.json"),
      JSON.stringify(
        {
          runId: stage1.run_id,
          model: "gemini",
          stats: stage1.stats,
          summary: stage1.summary,
          selectedTotal: selected.result.total,
          selectedIds: targetIds,
        },
        null,
        2,
      ),
      "utf8",
    );

    // --- Этап 2: глубокая диагностика ------------------------------------
    let stage2: RunDecisionOutput | null = null;
    let inspectMarkers: Array<Record<string, unknown>> = [];
    if (targetIds.length > 0) {
      console.log(
        `[PAID] stage2: from_run, context_window=2, projection=full, ${STAGE2_MODEL}`,
      );
      stage2 = await engine.runDecision({
        model: STAGE2_MODEL,
        source: {
          type: "from_run",
          run_id: stage1RunId,
          where: STAGE1_WHERE,
          context_window: 2,
          projection: "full",
        },
        rubric: "agent_funnel_stage2.json",
        return_top: 10,
      });
      recordPaid("stage2", STAGE2_MODEL, stage2);

      const inspect = await engine.queryRun({
        action: "inspect",
        run_id: stage2.run_id ?? "",
        item_ids: targetIds.slice(0, 3),
        context_window: 2,
      });
      if (inspect.action !== "inspect") throw new Error("ожидался inspect");
      inspectMarkers = inspect.result.items.map((item) => ({
        itemId: item.itemId,
        target: item.target,
        markers: (item.content ?? "").split("--- ").length - 1,
        hasTargetMarker: (item.content ?? "").includes("[target]"),
        truncated: item.content === null,
      }));
    }
    let stage2Items: Array<Record<string, unknown>> = [];
    if (stage2 !== null) {
      const items = await engine.queryRun({
        action: "filter",
        run_id: stage2.run_id ?? "",
        limit: 200,
      });
      if (items.action !== "filter") throw new Error("ожидался filter");
      stage2Items = items.result.items.map((item) => ({
        itemId: item.itemId,
        answers: {
          reasoning_logic_fail: item.answers["reasoning_logic_fail"]?.prob ?? null,
          overthinking_loop: item.answers["overthinking_loop"]?.prob ?? null,
          bad_tool_call: item.answers["bad_tool_call"]?.prob ?? null,
          prompt_violation: item.answers["prompt_violation"]?.prob ?? null,
          impact_severity: item.answers["impact_severity"]?.score ?? null,
        },
      }));
    }
    writeFileSync(
      path.join(FUNNEL_DIR, "stage2-summary.json"),
      JSON.stringify(
        {
          runId: stage2?.run_id ?? null,
          model: STAGE2_MODEL,
          stats: stage2?.stats ?? null,
          summary: stage2?.summary ?? {},
          targets: targetIds.length,
          inspect: inspectMarkers,
          items: stage2Items,
        },
        null,
        2,
      ),
      "utf8",
    );

    // --- Подтверждённые точки отказа и Этап 3 -----------------------------
    const perBool: Record<string, number> = {};
    const boolIds = new Set<string>();
    if (stage2 !== null) {
      for (const bool of STAGE2_BOOLS) {
        const filtered = await engine.queryRun({
          action: "filter",
          run_id: stage2.run_id ?? "",
          where: {
            conditions: [
              { question_id: bool, field: "prob", op: ">=", value: 0.75 },
            ],
          },
          limit: 200,
        });
        if (filtered.action !== "filter") throw new Error("ожидался filter");
        perBool[bool] = filtered.result.total;
        for (const item of filtered.result.items) boolIds.add(item.itemId);
      }
    }

    const severity = stage2 === null
      ? null
      : await engine.queryRun({
          action: "filter",
          run_id: stage2.run_id ?? "",
          where: SEVERITY_WHERE,
          limit: 200,
        });
    if (severity !== null && severity.action !== "filter") {
      throw new Error("ожидался filter");
    }
    const severityIds = new Set(
      severity?.action === "filter"
        ? severity.result.items.map((item) => item.itemId)
        : [],
    );
    const confirmed = [...boolIds]
      .filter((itemId) => severityIds.has(itemId))
      .sort();
    console.log(
      `[FREE] stage2/confirm: bools=${JSON.stringify(perBool)} severity=${severityIds.size} confirmed=${confirmed.length} ids=${confirmed.join(",")}`,
    );

    let stage3: RunDecisionOutput | null = null;
    let stage3Aggregate: Record<string, unknown> | null = null;
    if (severityIds.size > 0 && stage2 !== null) {
      console.log("[PAID] stage3: from_run stage2, severity>=1.5, jev");
      stage3 = await engine.runDecision({
        model: "jev",
        source: {
          type: "from_run",
          run_id: stage2.run_id ?? "",
          where: SEVERITY_WHERE,
          projection: "full",
        },
        rubric: "agent_funnel_stage3.json",
        return_top: 10,
      });
      recordPaid("stage3", "jev", stage3);

      const stage3Items = await engine.queryRun({
        action: "filter",
        run_id: stage3.run_id ?? "",
        limit: 200,
      });
      if (stage3Items.action !== "filter") throw new Error("ожидался filter");

      const confirmedSet = new Set(confirmed);
      const clustersConfirmed: Record<string, Record<string, number>> = {
        root_cause: {},
        fix_target: {},
        is_instruction_defect: {},
      };
      const clustersAll: Record<string, Record<string, number>> = {
        root_cause: {},
        fix_target: {},
        is_instruction_defect: {},
      };

      for (const item of stage3Items.result.items) {
        const rootCause = item.answers["root_cause"]?.choice;
        const fixTarget = item.answers["fix_target"]?.choice;
        const instruction = item.answers["is_instruction_defect"]?.prob;
        if (rootCause !== undefined) {
          clustersAll.root_cause[rootCause] =
            (clustersAll.root_cause[rootCause] ?? 0) + 1;
          if (confirmedSet.has(item.itemId)) {
            clustersConfirmed.root_cause[rootCause] =
              (clustersConfirmed.root_cause[rootCause] ?? 0) + 1;
          }
        }
        if (fixTarget !== undefined) {
          clustersAll.fix_target[fixTarget] =
            (clustersAll.fix_target[fixTarget] ?? 0) + 1;
          if (confirmedSet.has(item.itemId)) {
            clustersConfirmed.fix_target[fixTarget] =
              (clustersConfirmed.fix_target[fixTarget] ?? 0) + 1;
          }
        }
        if (instruction !== undefined) {
          const key = instruction >= 0.5 ? "true" : "false";
          clustersAll.is_instruction_defect[key] =
            (clustersAll.is_instruction_defect[key] ?? 0) + 1;
          if (confirmedSet.has(item.itemId)) {
            clustersConfirmed.is_instruction_defect[key] =
              (clustersConfirmed.is_instruction_defect[key] ?? 0) + 1;
          }
        }
      }

      stage3Aggregate = {
        itemsClassified: stage3Items.result.total,
        confirmedCovered: stage3Items.result.items.filter((item) =>
          confirmedSet.has(item.itemId),
        ).length,
        clustersConfirmed,
        clustersAll,
        confirmedIds: confirmed,
      };
    }

    writeFileSync(
      path.join(FUNNEL_DIR, "stage3-summary.json"),
      JSON.stringify(
        {
          runId: stage3?.run_id ?? null,
          model: "jev",
          stats: stage3?.stats ?? null,
          summary: stage3?.summary ?? {},
          perBool,
          severityTotal: severityIds.size,
          confirmed,
          aggregate: stage3Aggregate,
        },
        null,
        2,
      ),
      "utf8",
    );

    const funnelSummary = {
      generatedAt: new Date().toISOString(),
      provider: config.provider.name,
      data: dataSummary,
      stage0,
      stage1: {
        runId: stage1.run_id,
        stats: stage1.stats,
        summary: stage1.summary,
        selectedTotal: selected.result.total,
        selectedIds: targetIds,
      },
      stage2: {
        runId: stage2?.run_id ?? null,
        stats: stage2?.stats ?? null,
        summary: stage2?.summary ?? {},
        targets: targetIds.length,
        inspect: inspectMarkers,
      },
      stage3: {
        runId: stage3?.run_id ?? null,
        stats: stage3?.stats ?? null,
        summary: stage3?.summary ?? {},
        perBool,
        severityTotal: severityIds.size,
        confirmed,
        aggregate: stage3Aggregate,
      },
      paidRuns: paidRuns.map((run) => ({
        label: run.label,
        model: run.model,
        runId: run.output.run_id,
        costRub: run.output.stats.cost_rub,
        inputTokens: run.output.stats.input_tokens,
        outputTokens: run.output.stats.output_tokens,
      })),
      totalCostRub: Number(totalCost().toFixed(8)),
    };
    writeFileSync(
      path.join(FUNNEL_DIR, "funnel-summary.json"),
      JSON.stringify(funnelSummary, null, 2),
      "utf8",
    );

    // Evidence из SQLite: статусы и ответы.
    const runIds = paidRuns
      .map((run) => run.output.run_id)
      .filter((runId): runId is string => runId !== null);
    const store = new RunStore(DB_PATH);
    try {
      const dbEvidence = runIds.map((runId) => {
        const run = store.getRun(runId);
        const items = store.listItems(runId);
        const answers = store.listAnswers(runId);
        return {
          runId,
          status: run?.status ?? null,
          modelAlias: run?.modelAlias ?? null,
          responseModel: run?.responseModel ?? null,
          parentRunId: run?.parentRunId ?? null,
          items: items.length,
          itemStatuses: items.reduce<Record<string, number>>((acc, item) => {
            acc[item.status] = (acc[item.status] ?? 0) + 1;
            return acc;
          }, {}),
          answers: answers.length,
          answersWithoutProbabilities: answers.filter(
            (answer) => answer.probabilitiesJson === null,
          ).length,
          errorSummary: run?.errorSummary ?? null,
        };
      });
      writeFileSync(
        path.join(FUNNEL_DIR, "db-evidence.json"),
        JSON.stringify(dbEvidence, null, 2),
        "utf8",
      );
    } finally {
      store.close();
    }

    console.log("\n=== Funnel summary ===");
    console.log(
      `stage1: selected=${selected.result.total}, stage2 targets=${targetIds.length}, confirmed=${confirmed.length}`,
    );
    console.log(
      `stage3 clusters (confirmed): ${JSON.stringify(
        (stage3Aggregate as { clustersConfirmed?: unknown } | null)?.clustersConfirmed ?? {},
      )}`,
    );
    console.log(`[PAID] total: ${funnelSummary.totalCostRub} ₽`);
  } finally {
    engine.close();
    // Бинарную БД в репозиторий не кладём: все факты — в JSON-сводках.
    resetSqlite(DB_PATH);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
