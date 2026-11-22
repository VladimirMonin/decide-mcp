/**
 * Живой контроль собранного запроса: батчер + адаптер System One.
 * Одноразовый скрипт, [PAID]. Ключ берётся из .env и не печатается.
 *
 * Запуск: node fixtures/probes/live-batcher-check.mjs
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");
process.loadEnvFile(path.join(projectRoot, ".env"));

const moduleUrl = (relative) =>
  pathToFileURL(path.join(projectRoot, relative)).href;

const { SystemOneProvider } = await import(moduleUrl("dist/core/providers/systemone.js"));
const { batchLimitsFor, planBatches, runPlan } = await import(
  moduleUrl("dist/core/batcher.js")
);
const { getModel } = await import(moduleUrl("dist/core/registry.js"));

const apiKey = process.env.POLZA_API_KEY;
if (!apiKey) {
  console.error("POLZA_API_KEY не задан в .env");
  process.exit(2);
}
const baseUrl = process.env.POLZA_BASE_URL ?? "https://polza.ai/api/v1";

const model = getModel("ms", "polza");
const rubric = {
  guide: "Оценивай фрагменты кода и логов.",
  questions: {
    is_code: {
      type: "bool",
      instructions: "Это программный код?",
      true_description: "Есть объявление функции, класса или выражения языка.",
      false_description: "Обычный текст, лог или разметка без кода.",
    },
    language: {
      type: "choice",
      instructions: "На каком языке написан фрагмент?",
      options: { js: "JavaScript", python: "Python", other: "другой язык" },
    },
  },
};
const items = [
  { id: "i1", content: "function add(a, b) { return a + b; }" },
  {
    id: "i2",
    content: "2026-11-22T10:00:00Z INFO request completed in 42ms status=200",
  },
];

const plan = planBatches({
  modelAlias: "ms",
  limits: batchLimitsFor(model),
  rubric,
  items,
});
console.error(
  `[PAID] live batcher check: batches=${plan.batches.length} questions=${plan.questionsPerItem} est_tokens=${plan.estimatedTokens}`,
);

const provider = new SystemOneProvider({
  name: "polza",
  apiKey,
  decisionsUrl: new URL("systemone", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString(),
  catalogUrl: new URL("models/catalog", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString(),
  timeoutMs: 60_000,
});

const result = await runPlan(plan, provider, { concurrency: 1 });
const summary = {
  generatedAt: new Date().toISOString(),
  model: model.modelId,
  batchesPlanned: plan.batches.length,
  estimatedTokens: plan.estimatedTokens,
  batchesTotal: result.batchesTotal,
  usage: result.usage,
  failures: result.failures,
  blocked: result.blocked.map((entry) => entry.answer.status),
  answers: result.answers.map((entry) => ({
    itemId: entry.itemId,
    questionId: entry.questionId,
    status: entry.answer.status,
    prob: entry.answer.prob ?? null,
    choice: entry.answer.choice ?? null,
    score: entry.answer.score ?? null,
    confidence: entry.answer.confidence,
    confidenceSource: entry.answer.confidenceSource,
  })),
};
writeFileSync(
  path.join(here, "live-batcher-ms.json"),
  JSON.stringify(summary, null, 2),
  "utf8",
);
console.log(JSON.stringify(summary, null, 2));
console.log(`\n[PAID] cost: ${result.usage.costRub ?? "?"} ₽`);
