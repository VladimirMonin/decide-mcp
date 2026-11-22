/**
 * Подтверждение Definition of Done MVP (docs/plans/mvp-scope.md §3).
 *
 * Скрипт идёт через тот же фасад `DecisionEngine`, что и MCP-сервер:
 * источники → префильтр → батчер → провайдер → SQLite → сводка. Живые вызовы
 * помечены `[PAID]`, стоимость берётся из `usage.cost_rub`. Все данные
 * синтетические; рабочий `.env` читается только ради ключа, который не
 * печатается.
 *
 * Запуск: node dist/cli/dod-check.js
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, projectRoot, type AppConfig } from "../core/config.js";
import { DecisionEngine, type RunDecisionOutput } from "../core/engine.js";
import { SystemOneProvider } from "../core/providers/systemone.js";
import {
  readSource,
  SourceError,
} from "../core/sources.js";
import { RunStore } from "../core/store.js";
import { ProviderError } from "../core/providers/types.js";
import type {
  CatalogModelInfo,
  DecisionProvider,
  NormalizedAnswer,
  ProviderBatchRequest,
  ProviderBatchResponse,
} from "../core/providers/types.js";
import type { FilterExpr, Rubric } from "../core/schema.js";

const PROJECT_ROOT = projectRoot();
const DOD_DIR = path.join(PROJECT_ROOT, "fixtures", "dod");
const DATA_DIR = path.join(DOD_DIR, "data");
const DB_PATH = path.join(DOD_DIR, "runs.sqlite");
const SAFETY_DB_PATH = path.join(DOD_DIR, "safety-split.sqlite");
const GLOB_TREE = path.join(DOD_DIR, "glob-tree");

const MODEL_RUBRIC: Rubric = {
  name: "dod_models",
  questions: {
    has_error: {
      type: "bool",
      instructions: "Содержит ли фрагмент ошибку или сбой?",
      true_description: "Ошибка, исключение, отказ доступа.",
      false_description: "Штатный фрагмент без ошибок.",
    },
    language: {
      type: "choice",
      instructions: "На каком языке написан фрагмент?",
      options: { js: "JavaScript", python: "Python", other: "другой язык" },
    },
    quality: {
      type: "score",
      instructions: "Насколько фрагмент понятен?",
      levels: ["плохо", "средне", "хорошо"],
    },
  },
};

const STAGE1_RUBRIC: Rubric = {
  name: "dod_stage1",
  guide:
    "Оценивай шаг агентской сессии: ищи ошибки инструментов, повторы и тупики в рассуждении. Нормальный шаг без сбоев получает низкую оценку.",
  questions: {
    problem_score: {
      type: "score",
      instructions: "Насколько серьёзна проблема на этом шаге?",
      levels: ["нет проблем", "мелкая", "существенная", "критичная"],
    },
  },
};

const STAGE2_RUBRIC: Rubric = {
  name: "dod_stage2",
  questions: {
    root_cause: {
      type: "choice",
      instructions: "Что вероятнее всего вызвало проблему на целевом шаге?",
      options: {
        permissions: "права доступа к файлам",
        tool: "ошибка инструмента",
        reasoning: "логика агента",
        other: "другое или не определить",
      },
    },
  },
};

const STAGE1_WHERE: FilterExpr = {
  conditions: [
    { question_id: "problem_score", field: "score", op: ">=", value: 1.5 },
  ],
};

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

class SafetyStubProvider implements DecisionProvider {
  readonly name = "polza";
  calls = 0;

  async decide(request: ProviderBatchRequest): Promise<ProviderBatchResponse> {
    this.calls += 1;
    if (request.state.includes("ТОКСИЧНЫЙ")) {
      throw new ProviderError("safety_blocked", "content_blocked", {
        status: 400,
        retryable: false,
      });
    }
    const answers: Record<string, NormalizedAnswer> = {};
    for (const key of Object.keys(request.questions)) {
      answers[key] = {
        type: "bool",
        status: "ok",
        prob: 0.9,
        confidence: 0.9,
        confidenceSource: "max_prob",
      };
    }
    return {
      answers,
      rawAnswers: {},
      usage: { inputTokens: 10, outputTokens: 1, costRub: 0 },
      latencyMs: 1,
      responseModel: "stub-safety",
    };
  }

  async fetchCatalog(): Promise<CatalogModelInfo[]> {
    return [];
  }
}

function resetSqlite(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

function syntheticLine(index: number, repeat: number, severe: boolean): string {
  const prefix = severe
    ? `Шаг ${index}: инструмент вернул PermissionError, повторяю тот же вызов снова и снова. `
    : `Шаг ${index}: читаю файл, вывод выглядит нормально. `;
  return JSON.stringify({
    step_id: `step_${String(index).padStart(3, "0")}`,
    role: "assistant",
    tool_name: severe ? "write_file" : "read_file",
    arguments: { path: `synthetic_${index}.txt` },
    status: severe ? "error" : "ok",
    error: severe ? "PermissionError: access denied" : null,
    reasoning:
      prefix.repeat(repeat) +
      "Проверяю результат и сравниваю с ожиданием. ".repeat(repeat),
    content: `Синтетический фрагмент ${index} для проверки батчинга. `.repeat(repeat),
  });
}

function writeJsonl(file: string, lines: string[]): number {
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return Buffer.byteLength(`${lines.join("\n")}\n`, "utf8");
}

interface PaidRunRecord {
  label: string;
  alias: string;
  output: RunDecisionOutput;
}

const paidRuns: PaidRunRecord[] = [];
let paidBatches = 0;

function recordPaid(label: string, alias: string, output: RunDecisionOutput): void {
  paidRuns.push({ label, alias, output });
  paidBatches += output.stats.batches_total;
  console.log(
    `[PAID] ${label}: run=${output.run_id} status=${output.status} items=${output.stats.items_total} processed=${output.stats.items_processed} batches=${output.stats.batches_total} cost=${output.stats.cost_rub ?? "?"} ₽`,
  );
}

function totalCostRub(): number {
  return paidRuns.reduce(
    (sum, run) => sum + (run.output.stats.cost_rub ?? 0),
    0,
  );
}

function ensureDirs(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

async function main(): Promise<void> {
  ensureDirs();
  resetSqlite(DB_PATH);
  resetSqlite(SAFETY_DB_PATH);
  rmSync(GLOB_TREE, { recursive: true, force: true });

  const baseConfig = loadConfig();
  const config: AppConfig = {
    ...baseConfig,
    dbPath: DB_PATH,
    maxConcurrency: 4,
  };
  const inner = new SystemOneProvider({
    name: config.provider.name,
    apiKey: config.provider.apiKey,
    decisionsUrl: config.provider.decisionsUrl,
    catalogUrl: config.provider.catalogUrl,
    timeoutMs: config.timeoutMs,
  });
  const provider = new CountingProvider(inner);
  const engine = new DecisionEngine({ config, provider });

  const tinySource = {
    type: "text" as const,
    items: [
      {
        id: "snippet",
        content:
          "function add(a, b) { return a + b; } // простая функция сложения",
      },
    ],
  };

  // --- Критерий 3: dry_run без сети и без записи --------------------------
  const drySourceFile = path.join(DATA_DIR, "dry-run-20.jsonl");
  writeJsonl(
    drySourceFile,
    Array.from({ length: 20 }, (_unused, index) =>
      syntheticLine(index + 1, 2, index % 5 === 0),
    ),
  );
  const callsBeforeDry = provider.calls;
  const dry = await engine.runDecision({
    model: "ms",
    source: {
      type: "jsonl",
      path: "fixtures/dod/data/dry-run-20.jsonl",
      id_field: "step_id",
      projection: "skeleton",
      prefilter_tags: true,
    },
    rubric: MODEL_RUBRIC,
    dry_run: true,
    return_top: 5,
  });
  const dryCalls = provider.calls - callsBeforeDry;
  const dryDbExists = existsSync(DB_PATH);
  console.log(
    `[FREE] dry_run: items=${dry.stats.items_total} batches=${dry.stats.batches_total} est_tokens=${dry.plan?.estimated_tokens ?? "?"} calls=${dryCalls} db_created=${dryDbExists}`,
  );

  // --- Критерий 7: безопасность путей -------------------------------------
  let pathErrorCode: string | null = null;
  let pathErrorMessage = "";
  try {
    await engine.runDecision({
      model: "ms",
      source: { type: "file", path: "../outside-dod-check.txt" },
      rubric: MODEL_RUBRIC,
      dry_run: true,
    });
  } catch (error) {
    if (error instanceof SourceError) {
      pathErrorCode = error.code;
      pathErrorMessage = error.message;
    } else {
      pathErrorMessage = (error as Error).message;
    }
  }

  mkdirSync(path.join(GLOB_TREE, "src"), { recursive: true });
  writeFileSync(path.join(GLOB_TREE, "src", "ok.ts"), "export const ok = 1;");
  mkdirSync(path.join(GLOB_TREE, "node_modules"), { recursive: true });
  mkdirSync(path.join(GLOB_TREE, "dist"), { recursive: true });
  mkdirSync(path.join(GLOB_TREE, ".git"), { recursive: true });
  writeFileSync(path.join(GLOB_TREE, "node_modules", "x.ts"), "export const x = 1;");
  writeFileSync(path.join(GLOB_TREE, "dist", "y.ts"), "export const y = 1;");
  writeFileSync(path.join(GLOB_TREE, ".git", "z.ts"), "export const z = 1;");

  const globItems = await readSource(
    { type: "glob", pattern: "fixtures/dod/glob-tree/**/*.ts" },
    { allowedRoot: config.allowedRoot },
  );
  const globDry = await engine.runDecision({
    model: "ms",
    source: { type: "glob", pattern: "fixtures/dod/glob-tree/**/*.ts" },
    rubric: MODEL_RUBRIC,
    dry_run: true,
  });
  console.log(
    `[FREE] path_safety: code=${pathErrorCode ?? "none"} glob_ids=${globItems.map((item) => item.id).join(",")} glob_items=${globDry.stats.items_total}`,
  );

  // --- Критерий 2: все четыре модели --------------------------------------
  type ModelAnswers = RunDecisionOutput["top_items"][number]["answers"];
  const modelResults: Array<{
    alias: string;
    runId: string | null;
    status: string;
    stats: RunDecisionOutput["stats"];
    answers: ModelAnswers | undefined;
    answersTotal: number;
    answersWithConfidence: number;
    primitiveTypes: string[];
    summary: Record<string, unknown>;
  }> = [];

  for (const alias of ["gemini", "ms", "jev", "luna"] as const) {
    console.log(`[PAID] models/${alias}: одна задача bool+choice+score`);
    const output = await engine.runDecision({
      model: alias,
      source: tinySource,
      rubric: MODEL_RUBRIC,
      return_top: 1,
    });
    recordPaid(`models/${alias}`, alias, output);
    const answers = output.top_items[0]?.answers;
    const answerValues = answers === undefined ? [] : Object.values(answers);
    modelResults.push({
      alias,
      runId: output.run_id,
      status: output.status,
      stats: output.stats,
      answers,
      answersTotal: answerValues.length,
      answersWithConfidence: answerValues.filter(
        (answer) => typeof answer.confidence === "number",
      ).length,
      primitiveTypes: [
        ...new Set(answerValues.map((answer) => answer.type)),
      ].sort(),
      summary: output.summary,
    });
  }

  // --- Критерий 4: батчинг 300+ на ms -------------------------------------
  const batchSourceFile = path.join(DATA_DIR, "synthetic-320.jsonl");
  let repeat = 2;
  let planBatches = 0;
  let sourceBytes = 0;
  for (; repeat <= 8; repeat += 1) {
    sourceBytes = writeJsonl(
      batchSourceFile,
      Array.from({ length: 320 }, (_unused, index) =>
        syntheticLine(index + 1, repeat, index % 11 === 0),
      ),
    );
    const plan = await engine.runDecision({
      model: "ms",
      source: {
        type: "jsonl",
        path: "fixtures/dod/data/synthetic-320.jsonl",
        id_field: "step_id",
        projection: "raw",
      },
      rubric: {
        questions: {
          severity: {
            type: "score",
            instructions: "Насколько серьёзна проблема в записи?",
            levels: ["нет", "мелкая", "серьёзная", "критичная"],
          },
        },
      },
      dry_run: true,
    });
    planBatches = plan.stats.batches_total;
    if (planBatches >= 2) break;
  }
  const batchRubric: Rubric = {
    questions: {
      severity: {
        type: "score",
        instructions: "Насколько серьёзна проблема в записи?",
        levels: ["нет", "мелкая", "серьёзная", "критичная"],
      },
    },
  };
  console.log(`[PAID] batching/ms: 320 элементов, план ${planBatches} батчей`);
  const batchRun = await engine.runDecision({
    model: "ms",
    source: {
      type: "jsonl",
      path: "fixtures/dod/data/synthetic-320.jsonl",
      id_field: "step_id",
      projection: "raw",
    },
    rubric: batchRubric,
    return_top: 5,
  });
  recordPaid("batching/ms", "ms", batchRun);
  const outputBytes = Buffer.byteLength(JSON.stringify(batchRun), "utf8");

  // --- Критерий 6: воронка from_run ---------------------------------------
  const stage1File = path.join(DATA_DIR, "session-stage1.jsonl");
  writeJsonl(
    stage1File,
    Array.from({ length: 12 }, (_unused, index) =>
      syntheticLine(index + 1, 2, index % 2 === 1),
    ),
  );
  console.log("[PAID] funnel/stage1: 12 шагов, проблема score ≥ 1.5 задаётся дальше");
  const stage1 = await engine.runDecision({
    model: "ms",
    source: {
      type: "jsonl",
      path: "fixtures/dod/data/session-stage1.jsonl",
      id_field: "step_id",
      projection: "skeleton",
      prefilter_tags: true,
    },
    rubric: STAGE1_RUBRIC,
    return_top: 12,
  });
  recordPaid("funnel/stage1", "ms", stage1);

  const selectedStage1 = await engine.queryRun({
    action: "filter",
    run_id: stage1.run_id ?? "",
    where: STAGE1_WHERE,
    limit: 50,
  });
  if (selectedStage1.action !== "filter") throw new Error("ожидался filter");
  const targetCount = selectedStage1.result.total;
  const targetIds = selectedStage1.result.items.map((item) => item.itemId);
  console.log(
    `[FREE] funnel/select: targets=${targetCount} ids=${targetIds.join(",")}`,
  );

  const stage2Source = {
    context_window: 2,
    projection: "full" as const,
    where: STAGE1_WHERE,
  };
  console.log(
    `[PAID] funnel/stage2: from_run, context_window=${stage2Source.context_window}, projection=${stage2Source.projection}`,
  );
  const stage2 = await engine.runDecision({
    model: "ms",
    source: {
      type: "from_run",
      run_id: stage1.run_id ?? "",
      ...stage2Source,
    },
    rubric: STAGE2_RUBRIC,
    return_top: 5,
  });
  recordPaid("funnel/stage2", "ms", stage2);

  const inspect = await engine.queryRun({
    action: "inspect",
    run_id: stage2.run_id ?? "",
    item_ids: targetIds.slice(0, 3),
    context_window: 2,
  });
  if (inspect.action !== "inspect") throw new Error("ожидался inspect");
  const inspectMarkers = inspect.result.items.map((item) => ({
    itemId: item.itemId,
    target: item.target,
    markers: (item.content ?? "").split("--- ").length - 1,
    hasTargetMarker: (item.content ?? "").includes("[target]"),
    truncated: item.content === null,
  }));

  // --- Критерий 5: safety-блокировка и бинарное деление (офлайн) ---------
  const safetyProvider = new SafetyStubProvider();
  const safetyConfig: AppConfig = {
    ...config,
    dbPath: SAFETY_DB_PATH,
  };
  const safetyEngine = new DecisionEngine({
    config: safetyConfig,
    provider: safetyProvider,
  });
  let safetyRunId: string | null = null;
  let safetyResult: RunDecisionOutput | null = null;
  try {
    safetyResult = await safetyEngine.runDecision({
      model: "ms",
      source: {
        type: "text",
        items: [
          { id: "ok1", content: "обычный шаг 1" },
          { id: "toxic", content: "ТОКСИЧНЫЙ шаг" },
          { id: "ok2", content: "обычный шаг 2" },
          { id: "ok3", content: "обычный шаг 3" },
        ],
      },
      rubric: {
        questions: {
          is_problem: { type: "bool", instructions: "Есть ли проблема?" },
        },
      },
    });
    safetyRunId = safetyResult.run_id;
  } finally {
    safetyEngine.close();
  }
  const safetyStore = new RunStore(SAFETY_DB_PATH);
  let safetyItems: Array<[string, string]> = [];
  let safetyAnswers: Array<{
    itemId: string;
    questionId: string;
    status: string;
  }> = [];
  try {
    safetyItems = safetyStore
      .listItems(safetyRunId ?? "")
      .map((item) => [item.itemId, item.status]);
    safetyAnswers = safetyStore
      .listAnswers(safetyRunId ?? "")
      .map((answer) => ({
        itemId: answer.itemId,
        questionId: answer.questionId,
        status: answer.status,
      }));
  } finally {
    safetyStore.close();
  }
  console.log(
    `[TEST] safety_split: status=${safetyResult?.status} processed=${safetyResult?.stats.items_processed} blocked=${safetyResult?.stats.items_blocked} calls=${safetyProvider.calls} items=${JSON.stringify(safetyItems)}`,
  );
  writeFileSync(
    path.join(DOD_DIR, "safety-evidence.json"),
    JSON.stringify(
      {
        criterion: 5,
        method: "офлайн-симуляция SafetyStubProvider (не живой прогон)",
        generatedAt: new Date().toISOString(),
        runId: safetyRunId,
        status: safetyResult?.status ?? null,
        stats: safetyResult?.stats ?? null,
        providerCalls: safetyProvider.calls,
        itemStatuses: safetyItems,
        answers: safetyAnswers,
      },
      null,
      2,
    ),
    "utf8",
  );

  // --- Закрываем движок и снимаем доказательства из SQLite ----------------
  engine.close();

  const store = new RunStore(DB_PATH);
  const runIds = paidRuns
    .map((run) => run.output.run_id)
    .filter((runId): runId is string => runId !== null);
  let batchAnswersWithoutProbabilities: number | null = null;
  const dbEvidence: Record<string, unknown> = { runs: [], answers: {} };
  const runsEvidence: Array<Record<string, unknown>> = [];
  const answersEvidence: Record<string, Record<string, unknown>> = {};

  for (const runId of runIds) {
    const run = store.getRun(runId);
    const items = store.listItems(runId);
    const answers = store.listAnswers(runId);
    const answersWithoutProbabilities = answers.filter(
      (answer) => answer.probabilitiesJson === null,
    ).length;
    if (runId === batchRun.run_id) {
      batchAnswersWithoutProbabilities = answersWithoutProbabilities;
    }
    runsEvidence.push({
      runId,
      status: run?.status ?? null,
      provider: run?.provider ?? null,
      modelAlias: run?.modelAlias ?? null,
      responseModel: run?.responseModel ?? null,
      parentRunId: run?.parentRunId ?? null,
      itemsTotal: run?.itemsTotal ?? null,
      itemsProcessed: run?.itemsProcessed ?? null,
      itemsSkipped: run?.itemsSkipped ?? null,
      itemsBlocked: run?.itemsBlocked ?? null,
      batchesTotal: run?.batchesTotal ?? null,
      inputTokens: run?.inputTokens ?? null,
      outputTokens: run?.outputTokens ?? null,
      costRub: run?.costRub ?? null,
      durationMs: run?.durationMs ?? null,
      answerCount: answers.length,
      answersWithoutProbabilities,
      itemStatuses: items.reduce<Record<string, number>>((acc, item) => {
        acc[item.status] = (acc[item.status] ?? 0) + 1;
        return acc;
      }, {}),
    });
    answersEvidence[runId] = {
      total: answers.length,
      confidenceSources: answers.reduce<Record<string, number>>((acc, answer) => {
        acc[answer.confidenceSource] = (acc[answer.confidenceSource] ?? 0) + 1;
        return acc;
      }, {}),
      sample: answers.slice(0, 3).map((answer) => ({
        itemId: answer.itemId,
        questionId: answer.questionId,
        type: answer.primitiveType,
        prob: answer.prob,
        score: answer.scoreValue,
        choice: answer.choiceValue,
        confidence: answer.confidence,
        confidenceSource: answer.confidenceSource,
        probabilities: answer.probabilitiesJson,
        status: answer.status,
      })),
    };
  }
  store.close();
  dbEvidence["runs"] = runsEvidence;
  dbEvidence["answers"] = answersEvidence;

  writeFileSync(
    path.join(DOD_DIR, "db-evidence.json"),
    JSON.stringify(dbEvidence, null, 2),
    "utf8",
  );
  writeFileSync(
    path.join(DOD_DIR, "runs.json"),
    JSON.stringify(
      paidRuns.map((run) => ({
        label: run.label,
        alias: run.alias,
        runId: run.output.run_id,
        status: run.output.status,
        stats: run.output.stats,
        plan: run.output.plan ?? null,
        warnings: run.output.warnings,
        summary: run.output.summary,
        topItems: run.output.top_items.map((item) => ({
          item_id: item.item_id,
          preview: item.preview,
          answers: item.answers,
        })),
      })),
      null,
      2,
    ),
    "utf8",
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    provider: config.provider.name,
    model: config.defaultModel,
    criteria: {
      c1: {
        status: "partial",
        method: "живой прогон polza",
        note: "OpenRouter NOT RUN: ключ не задан, решение владельца",
      },
      c2: {
        status: modelResults.every(
          (model) =>
            model.status === "completed" &&
            model.answersTotal === 3 &&
            model.answersWithConfidence === model.answersTotal &&
            model.primitiveTypes.includes("bool") &&
            model.primitiveTypes.includes("choice") &&
            model.primitiveTypes.includes("score") &&
            model.stats.input_tokens > 0 &&
            model.stats.cost_rub !== null,
        )
          ? "confirmed"
          : "not_confirmed",
        method: "живой прогон 4 моделей",
        models: modelResults,
      },
      c3: {
        status:
          dryCalls === 0 &&
          !dryDbExists &&
          dry.stats.items_total === 20 &&
          (dry.plan?.batches ?? 0) >= 1
            ? "confirmed"
            : "not_confirmed",
        method: "dry_run + счётчик вызовов + проверка отсутствия файла БД",
        plan: dry.plan,
        providerCalls: dryCalls,
        dbCreated: dryDbExists,
      },
      c4: {
        status:
          batchRun.status === "completed" &&
          batchRun.stats.items_total === 320 &&
          batchRun.stats.items_processed === 320 &&
          batchRun.stats.batches_total >= 2 &&
          batchAnswersWithoutProbabilities === 0 &&
          outputBytes < sourceBytes
            ? "confirmed"
            : "not_confirmed",
        method: "живой прогон ms на 320 синтетических записях",
        runId: batchRun.run_id,
        stats: batchRun.stats,
        answersWithoutProbabilities: batchAnswersWithoutProbabilities,
        compact: outputBytes < sourceBytes,
        sourceBytes,
        outputBytes,
        topItems: batchRun.top_items.length,
      },
      c5: {
        status:
          safetyResult?.status === "partial" &&
          safetyResult.stats.items_blocked === 1 &&
          safetyResult.stats.items_processed === 3
            ? "confirmed"
            : "not_confirmed",
        method: "офлайн-симуляция стаба (не живой прогон)",
        runId: safetyRunId,
        stats: safetyResult?.stats ?? null,
        providerCalls: safetyProvider.calls,
        itemStatuses: safetyItems,
      },
      c6: {
        status:
          targetCount > 0 &&
          stage2.status === "completed" &&
          stage2.stats.items_total === targetCount &&
          stage2Source.context_window === 2 &&
          stage2Source.projection === "full" &&
          inspectMarkers.some(
            (marker) =>
              marker.hasTargetMarker === true && Number(marker.markers) > 0,
          )
            ? "confirmed"
            : "not_confirmed",
        method: "живой прогон двух этапов + inspect",
        source: stage2Source,
        inspectHasTargetMarker: inspectMarkers.some(
          (marker) =>
            marker.hasTargetMarker === true && Number(marker.markers) > 0,
        ),
        stage1: {
          runId: stage1.run_id,
          stats: stage1.stats,
          summary: stage1.summary,
        },
        selectedTargets: targetCount,
        targetIds,
        stage2: {
          runId: stage2.run_id,
          stats: stage2.stats,
          summary: stage2.summary,
        },
        inspect: inspectMarkers,
      },
      c7: {
        status:
          pathErrorCode === "path_outside_root" &&
          globItems.length === 1 &&
          globDry.stats.items_total === 1
            ? "confirmed"
            : "not_confirmed",
        method: "живой отказ пути + glob dry_run + readSource",
        pathErrorCode,
        pathErrorMessage,
        globIds: globItems.map((item) => item.id),
        globDryItems: globDry.stats.items_total,
      },
    },
    paidRuns: paidRuns.map((run) => ({
      label: run.label,
      alias: run.alias,
      runId: run.output.run_id,
      costRub: run.output.stats.cost_rub,
      inputTokens: run.output.stats.input_tokens,
      outputTokens: run.output.stats.output_tokens,
    })),
    paidBatches,
    totalCostRub: Number(totalCostRub().toFixed(8)),
  };
  writeFileSync(
    path.join(DOD_DIR, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  );

  console.log("\n=== DoD summary ===");
  for (const [key, value] of Object.entries(summary.criteria)) {
    console.log(`${key}: ${(value as { status: string }).status}`);
  }
  console.log(
    `[PAID] total: ${summary.totalCostRub} ₽, batches=${paidBatches}, runs=${paidRuns.length}`,
  );
  console.log(`Сводка: ${path.join(DOD_DIR, "summary.json")}`);

  // Временные БД и дерево glob не оставляем в репозитории.
  resetSqlite(SAFETY_DB_PATH);
  resetSqlite(DB_PATH);
  rmSync(GLOB_TREE, { recursive: true, force: true });

  const failed = Object.values(summary.criteria).filter(
    (criterion) => (criterion as { status: string }).status !== "confirmed",
  ).length;
  if (failed > 1) {
    console.error(`Не подтверждено критериев: ${failed}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
