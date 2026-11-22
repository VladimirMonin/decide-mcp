import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DecisionEngine,
  EngineError,
  loadRubric,
  resolveItemStatus,
} from "./engine.js";
import type { AppConfig } from "./config.js";
import { ProviderError } from "./providers/types.js";
import type {
  CatalogModelInfo,
  DecisionProvider,
  NormalizedAnswer,
  ProviderBatchRequest,
  ProviderBatchResponse,
} from "./providers/types.js";
import { SourceError } from "./sources.js";
import { RunStore } from "./store.js";
import type { QuestionDef } from "./schema.js";

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "decide-engine-"));
}

function makeConfig(root: string): AppConfig {
  return {
    provider: {
      name: "polza",
      apiKey: "stub-key",
      baseUrl: "https://example.test/api/v1",
      decisionsUrl: "https://example.test/api/v1/systemone",
      catalogUrl: "https://example.test/api/v1/models/catalog",
    },
    defaultModel: "ms",
    dbPath: path.join(root, "runs.sqlite"),
    allowedRoot: root,
    maxConcurrency: 2,
    timeoutMs: 5_000,
  };
}

const RUBRIC = {
  name: "engine_test",
  questions: {
    quality: {
      type: "score",
      instructions: "Насколько фрагмент понятен?",
      levels: ["плохо", "средне", "хорошо"],
    },
    is_code: { type: "bool", instructions: "Это программный код?" },
  },
};

function answerFor(question: QuestionDef): NormalizedAnswer {
  if (question.type === "score") {
    return {
      type: "score",
      status: "ok",
      score: 1.5,
      confidence: 0.9,
      confidenceSource: "provider",
      probabilities: [0.1, 0.2, 0.7],
    };
  }
  if (question.type === "bool") {
    return {
      type: "bool",
      status: "ok",
      prob: 0.8,
      confidence: 0.8,
      confidenceSource: "max_prob",
    };
  }
  throw new Error(`Неожиданный вопрос: ${question.type}`);
}

function okayResponse(
  request: ProviderBatchRequest,
  usage = { inputTokens: 100, outputTokens: 2, costRub: 0.001 },
): ProviderBatchResponse {
  const answers: Record<string, NormalizedAnswer> = {};
  for (const [key, question] of Object.entries(request.questions)) {
    answers[key] = answerFor(question);
  }
  return {
    answers,
    rawAnswers: {},
    usage,
    latencyMs: 1,
    responseModel: "stub-1.0",
  };
}

class StubProvider implements DecisionProvider {
  readonly name = "polza";
  readonly calls: ProviderBatchRequest[] = [];

  constructor(
    private readonly handler: (
      request: ProviderBatchRequest,
    ) => Promise<ProviderBatchResponse> | ProviderBatchResponse,
  ) {}

  async decide(request: ProviderBatchRequest): Promise<ProviderBatchResponse> {
    this.calls.push(request);
    return this.handler(request);
  }

  async fetchCatalog(): Promise<CatalogModelInfo[]> {
    return [];
  }
}

function makeEngine(config: AppConfig, provider?: DecisionProvider): DecisionEngine {
  let counter = 0;
  return new DecisionEngine({
    config,
    provider,
    now: () => new Date("2026-11-22T10:00:00Z"),
    runIdSuffix: () => String((counter += 1)).padStart(4, "0"),
  });
}

test("dry_run считает план без сети и без создания БД", async () => {
  const root = makeRoot();
  try {
    const config = makeConfig(root);
    const provider = new StubProvider(() => {
      throw new Error("dry_run не должен ходить в сеть");
    });
    const engine = makeEngine(config, provider);
    try {
      const result = await engine.runDecision({
        source: {
          type: "text",
          items: [
            { id: "a", content: "функция add" },
            { id: "b", content: "обычный текст" },
          ],
        },
        rubric: RUBRIC,
        dry_run: true,
      });

      assert.equal(result.status, "dry_run");
      assert.equal(result.run_id, null);
      assert.equal(result.stats.items_total, 2);
      assert.equal(result.stats.items_processed, 0);
      assert.equal(result.stats.batches_total, 1);
      assert.equal(result.plan?.batches, 1);
      assert.ok((result.plan?.estimated_tokens ?? 0) > 0);
      assert.equal(provider.calls.length, 0);
      assert.equal(existsSync(config.dbPath), false);
      assert.deepEqual(result.summary, {});
      assert.deepEqual(result.top_items, []);
    } finally {
      engine.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("живой прогон сохраняет прогон, ответы и компактную сводку", async () => {
  const root = makeRoot();
  try {
    const config = makeConfig(root);
    const provider = new StubProvider((request) => okayResponse(request));
    const engine = makeEngine(config, provider);
    const source = {
      type: "text" as const,
      items: [
        { id: "item_a", content: "function add(a, b) { return a + b; }" },
        { id: "item_b", content: "просто текст без кода" },
      ],
    };

    let runId: string | null = null;
    try {
      const result = await engine.runDecision({ source, rubric: RUBRIC });
      runId = result.run_id;

      assert.ok(result.run_id);
      assert.equal(result.status, "completed");
      assert.equal(result.dry_run, false);
      assert.equal(result.stats.items_total, 2);
      assert.equal(result.stats.items_processed, 2);
      assert.equal(result.stats.items_skipped, 0);
      assert.equal(result.stats.batches_total, 1);
      assert.equal(result.stats.input_tokens, 100);
      assert.equal(result.stats.output_tokens, 2);
      assert.equal(result.stats.cost_rub, 0.001);
      assert.equal(provider.calls.length, 1);

      assert.equal(result.summary["quality"]?.type, "score");
      const scoreSummary = result.summary["quality"];
      assert.ok(scoreSummary?.type === "score");
      assert.equal(scoreSummary.avg, 1.5);
      assert.equal(scoreSummary.count, 2);
      // Бакеты score считаются по индексу уровня из probabilities (0.7 → уровень 2).
      assert.deepEqual(scoreSummary.buckets, { "2": 2 });

      assert.equal(result.top_items.length, 2);
      assert.equal(result.top_items[0]?.item_id, "item_a");
      assert.equal(result.top_items[0]?.answers["quality"]?.score, 1.5);
    } finally {
      engine.close();
    }

    const store = new RunStore(config.dbPath);
    try {
      const run = store.getRun(runId ?? "");
      assert.ok(run);
      assert.equal(run.status, "completed");
      assert.equal(run.itemsProcessed, 2);
      assert.equal(run.inputTokens, 100);
      assert.equal(run.provider, "polza");
      assert.equal(run.modelAlias, "ms");
      // Версия ответившей модели доходит из провайдера до хранилища.
      assert.equal(run.responseModel, "stub-1.0");

      const items = store.listItems(runId ?? "");
      assert.deepEqual(
        items.map((item) => [item.itemId, item.status]),
        [
          ["item_a", "ok"],
          ["item_b", "ok"],
        ],
      );
      assert.equal(store.listAnswers(runId ?? "").length, 4);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("safety-блокировка даёт partial: элемент изолирован, остальные сохранены", async () => {
  const root = makeRoot();
  try {
    const config = makeConfig(root);
    const provider = new StubProvider((request) => {
      if (request.state.includes("токсичный")) {
        throw new ProviderError("safety_blocked", "content_blocked", {
          status: 400,
          retryable: false,
        });
      }
      return okayResponse(request);
    });
    const engine = makeEngine(config, provider);
    let runId: string | null = null;

    try {
      const result = await engine.runDecision({
        source: {
          type: "text",
          items: [
            { id: "good", content: "обычный фрагмент" },
            { id: "toxic", content: "токсичный фрагмент" },
          ],
        },
        rubric: RUBRIC,
      });
      runId = result.run_id;

      assert.equal(result.status, "partial");
      assert.equal(result.stats.items_processed, 1);
      assert.equal(result.stats.items_blocked, 1);
      assert.equal(provider.calls.length, 3);
    } finally {
      engine.close();
    }

    const store = new RunStore(config.dbPath);
    try {
      const items = store.listItems(runId ?? "");
      assert.deepEqual(
        items.map((item) => [item.itemId, item.status]),
        [
          ["good", "ok"],
          ["toxic", "safety_blocked"],
        ],
      );
      const blocked = store
        .listAnswers(runId ?? "", ["toxic"])
        .map((answer) => answer.status);
      assert.deepEqual(blocked, ["safety_blocked", "safety_blocked"]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ошибка bad_request помечает прогон failed и сохраняет summary ошибки", async () => {
  const root = makeRoot();
  try {
    const config = makeConfig(root);
    const provider = new StubProvider(() => {
      throw new ProviderError("bad_request", "BAD_REQUEST: переполнение", {
        status: 400,
        retryable: false,
        traceId: "trace-failed",
      });
    });
    const engine = makeEngine(config, provider);
    let runId: string | null = null;
    try {
      const result = await engine.runDecision({
        source: { type: "text", items: [{ id: "i1", content: "x" }] },
        rubric: RUBRIC,
      });
      runId = result.run_id;

      assert.equal(result.status, "failed");
      assert.equal(result.stats.items_processed, 0);
    } finally {
      engine.close();
    }

    const store = new RunStore(config.dbPath);
    try {
      const run = store.getRun(runId ?? "");
      assert.ok(run);
      assert.equal(run.status, "failed");
      assert.match(run.errorSummary ?? "", /bad_request/);
      assert.match(run.errorSummary ?? "", /trace-failed/);
      assert.equal(store.listItems(runId ?? "")[0]?.status, "error");
      assert.equal(store.listItems(runId ?? "")[0]?.errorCode, "bad_request");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope=whole склеивает источник в один элемент и один запрос", async () => {
  const root = makeRoot();
  try {
    const config = makeConfig(root);
    const provider = new StubProvider((request) => okayResponse(request));
    const engine = makeEngine(config, provider);
    try {
      const result = await engine.runDecision({
        source: {
          type: "text",
          items: [
            { id: "a", content: "первый" },
            { id: "b", content: "второй" },
          ],
        },
        rubric: RUBRIC,
        scope: "whole",
      });

      assert.equal(result.stats.items_total, 1);
      assert.equal(result.stats.items_processed, 1);
      assert.equal(provider.calls.length, 1);
      assert.match(provider.calls[0]?.state ?? "", /--- a \(seq 0\) ---/);
      assert.match(provider.calls[0]?.state ?? "", /--- b \(seq 1\) ---/);
    } finally {
      engine.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("пустой источник даёт пустой completed-прогон без вызовов провайдера", async () => {
  const root = makeRoot();
  try {
    const config = makeConfig(root);
    const provider = new StubProvider((request) => okayResponse(request));
    const engine = makeEngine(config, provider);
    try {
      const result = await engine.runDecision({
        source: { type: "glob", pattern: "**/*.nomatch" },
        rubric: RUBRIC,
      });

      assert.equal(result.status, "completed");
      assert.equal(result.stats.items_total, 0);
      assert.equal(result.stats.items_processed, 0);
      assert.equal(result.stats.batches_total, 0);
      assert.equal(provider.calls.length, 0);
      assert.deepEqual(result.top_items, []);
    } finally {
      engine.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("from_run второго этапа берёт цели из прошлого прогона и соседей", async () => {
  const root = makeRoot();
  try {
    const config = makeConfig(root);
    const provider = new StubProvider((request) => {
      const answers: Record<string, NormalizedAnswer> = {};
      for (const key of Object.keys(request.questions)) {
        // Ключ вопроса — `item_id__question_id`, поэтому оценка своя у каждого шага.
        const score = key.startsWith("item_bad") ? 2.5 : 0.2;
        answers[key] = {
          type: "score",
          status: "ok",
          score,
          confidence: 0.9,
          confidenceSource: "provider",
          probabilities: score > 1 ? [0, 0.1, 0.9] : [0.9, 0.1, 0],
        };
      }
      return {
        answers,
        rawAnswers: {},
        usage: { inputTokens: 50, outputTokens: 1, costRub: 0.0005 },
        latencyMs: 1,
        responseModel: "stub-1.0",
      };
    });
    const rubric = {
      questions: {
        problem: {
          type: "score",
          instructions: "Насколько серьезна проблема?",
          levels: ["нет", "мелкая", "серьёзная"],
        },
      },
    };
    const engine = makeEngine(config, provider);
    let firstRunId: string | null = null;
    let secondRun: Awaited<ReturnType<DecisionEngine["runDecision"]>> | null = null;

    try {
      const first = await engine.runDecision({
        source: {
          type: "text",
          items: [
            { id: "item_a", content: "обычный шаг" },
            { id: "item_bad", content: "bad: сломанный шаг" },
            { id: "item_c", content: "ещё один обычный шаг" },
          ],
        },
        rubric,
      });
      firstRunId = first.run_id;
      assert.equal(first.status, "completed");

      secondRun = await engine.runDecision({
        source: {
          type: "from_run",
          run_id: first.run_id ?? "",
          where: {
            conditions: [
              { question_id: "problem", field: "score", op: ">=", value: 1 },
            ],
          },
          context_window: 1,
        },
        rubric,
      });

      assert.equal(secondRun.stats.items_total, 1);
      assert.equal(secondRun.stats.items_processed, 1);
      assert.equal(secondRun.top_items[0]?.item_id, "item_bad");
      const secondState = provider.calls[1]?.state ?? "";
      assert.match(secondState, /--- item_a \(seq 0\) ---/);
      assert.match(secondState, /--- item_bad \(seq 1\) \[target\] ---/);
      assert.match(secondState, /--- item_c \(seq 2\) ---/);
    } finally {
      engine.close();
    }

    const store = new RunStore(config.dbPath);
    try {
      const parent = store.getRun(firstRunId ?? "");
      assert.ok(parent);
      const run = store.getRun(secondRun?.run_id ?? "");
      assert.ok(run);
      assert.equal(run.parentRunId, firstRunId);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queryRun и listModels работают поверх сохранённого прогона", async () => {
  const root = makeRoot();
  try {
    const config = makeConfig(root);
    const provider = new StubProvider((request) => okayResponse(request));
    const engine = makeEngine(config, provider);
    try {
      const run = await engine.runDecision({
        source: {
          type: "text",
          items: [
            { id: "item_a", content: "function add(a, b) { return a + b; }" },
            { id: "item_b", content: "просто текст" },
          ],
        },
        rubric: RUBRIC,
      });
      assert.ok(run.run_id);

      const filtered = await engine.queryRun({
        action: "filter",
        run_id: run.run_id,
        where: {
          conditions: [{ question_id: "quality", field: "score", op: ">=", value: 1 }],
        },
      });
      assert.equal(filtered.action, "filter");
      assert.equal(filtered.result.items.length, 2);

      const aggregated = await engine.queryRun({
        action: "aggregate",
        run_id: run.run_id,
      });
      assert.equal(aggregated.action, "aggregate");
      assert.equal(aggregated.result.itemsTotal, 2);

      const inspected = await engine.queryRun({
        action: "inspect",
        run_id: run.run_id,
        item_ids: ["item_a"],
      });
      assert.equal(inspected.action, "inspect");
      assert.equal(inspected.result.contentTruncated, false);
      assert.equal(
        inspected.result.items[0]?.content,
        "function add(a, b) { return a + b; }",
      );

      const compared = await engine.queryRun({
        action: "compare",
        run_id: run.run_id,
        compare_run_id: run.run_id,
      });
      assert.equal(compared.action, "compare");
      assert.equal(compared.result.questions["quality"]?.agreement, 1);

      const models = engine.listModels();
      assert.equal(models.active_provider, "polza");
      assert.equal(models.default_model, "ms");
      assert.equal(models.models.length, 4);
      assert.equal(
        models.models.find((model) => model.alias === "gemini")?.max_score_levels,
        255,
      );
      assert.ok(models.presets.includes("rubrics/logs_triage.json"));
    } finally {
      engine.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("движок отвергает плохую рубрику, чужого провайдера и отсутствие провайдера", async () => {
  const root = makeRoot();
  try {
    const config = makeConfig(root);
    const engine = makeEngine(config);
    try {
      await assert.rejects(
        engine.runDecision({
          source: { type: "text", items: [{ id: "a", content: "x" }] },
          rubric: { questions: {} },
        }),
        (error: unknown) =>
          error instanceof EngineError && error.code === "invalid_rubric",
      );

      await assert.rejects(
        engine.runDecision({
          source: { type: "text", items: [{ id: "a", content: "x" }] },
          rubric: RUBRIC,
          provider: "openrouter",
        }),
        (error: unknown) =>
          error instanceof EngineError && error.code === "provider_mismatch",
      );

      await assert.rejects(
        engine.runDecision({
          source: { type: "text", items: [{ id: "a", content: "x" }] },
          rubric: RUBRIC,
        }),
        (error: unknown) =>
          error instanceof EngineError && error.code === "provider_required",
      );
      assert.equal(existsSync(config.dbPath), false);
    } finally {
      engine.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("движок не читает файл за пределами DECIDE_ALLOWED_ROOT", async () => {
  const base = makeRoot();
  const root = path.join(base, "root");
  try {
    mkdirSync(root);
    writeFileSync(path.join(base, "secret.txt"), "secret");
    const config = makeConfig(root);
    const provider = new StubProvider((request) => okayResponse(request));
    const engine = makeEngine(config, provider);

    try {
      await assert.rejects(
        engine.runDecision({
          source: { type: "file", path: "../secret.txt" },
          rubric: RUBRIC,
        }),
        (error: unknown) =>
          error instanceof SourceError && error.code === "path_outside_root",
      );
    } finally {
      engine.close();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("сбой сохранения ответов не оставляет прогон в running", async () => {
  const root = makeRoot();
  const store = new RunStore(path.join(root, "runs.sqlite"));
  try {
    const config = makeConfig(root);
    const provider = new StubProvider((request) => okayResponse(request));

    // Имитируем отказ хранилища ровно на записи ответов.
    store.saveAnswers = () => {
      throw new Error("store down");
    };

    const engine = new DecisionEngine({ config, provider, store });
    let runId: string | null = null;
    try {
      const result = await engine.runDecision({
        source: { type: "text", items: [{ id: "a", content: "x" }] },
        rubric: RUBRIC,
      });
      runId = result.run_id;
      assert.equal(result.status, "failed");
      assert.equal(result.stats.items_processed, 0);
    } finally {
      engine.close();
    }

    const run = store.getRun(runId ?? "");
    assert.ok(run);
    assert.notEqual(run.status, "running");
    assert.equal(run.status, "failed");
    assert.match(run.errorSummary ?? "", /store down/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("приоритет статусов элемента: error > safety_blocked > ok", () => {
  assert.equal(resolveItemStatus("pending", "ok"), "ok");
  assert.equal(resolveItemStatus("skipped_too_large", "ok"), "ok");
  assert.equal(resolveItemStatus("ok", "safety_blocked"), "safety_blocked");
  assert.equal(resolveItemStatus("safety_blocked", "ok"), "safety_blocked");
  assert.equal(resolveItemStatus("safety_blocked", "error"), "error");
  assert.equal(resolveItemStatus("error", "ok"), "error");
  assert.equal(resolveItemStatus("error", "error"), "error");
});

test("счётчики исключающие: skipped и ok не превышают items_total", async () => {
  const root = makeRoot();
  try {
    const config = makeConfig(root);
    const provider = new StubProvider((request) => okayResponse(request));
    const engine = makeEngine(config, provider);
    let runId: string | null = null;
    try {
      const result = await engine.runDecision({
        source: {
          type: "text",
          items: [
            { id: "huge", content: "ж".repeat(150_000) },
            { id: "small", content: "короткий фрагмент" },
          ],
        },
        rubric: RUBRIC,
      });
      runId = result.run_id;

      assert.equal(result.status, "partial");
      assert.equal(result.stats.items_total, 2);
      assert.equal(result.stats.items_processed, 1);
      assert.equal(result.stats.items_skipped, 1);
      assert.equal(result.stats.items_blocked, 0);
      assert.ok(
        result.stats.items_processed +
          result.stats.items_skipped +
          result.stats.items_blocked <=
          result.stats.items_total,
      );
      assert.equal(provider.calls.length, 1);
    } finally {
      engine.close();
    }

    const store = new RunStore(config.dbPath);
    try {
      assert.deepEqual(
        store.listItems(runId ?? "").map((item) => [item.itemId, item.status]),
        [
          ["huge", "skipped_too_large"],
          ["small", "ok"],
        ],
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("пресет рубрики не читается через ссылку за пределы rubrics/", async (t) => {
  const base = makeRoot();
  const root = path.join(base, "rubrics");
  const outside = path.join(base, "outside");
  const link = path.join(root, "link");
  try {
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(path.join(root, "preset.json"), JSON.stringify(RUBRIC));
    writeFileSync(path.join(outside, "evil.json"), JSON.stringify(RUBRIC));

    assert.deepEqual(loadRubric("preset.json", root), RUBRIC);
    assert.throws(
      () => loadRubric("../evil.json", root),
      (error: unknown) =>
        error instanceof EngineError && error.code === "invalid_rubric",
    );

    let linked = false;
    try {
      symlinkSync(outside, link, "junction");
      linked = true;
    } catch {
      linked = false;
    }
    if (!linked) {
      t.skip("junction недоступен в этой среде");
      return;
    }

    assert.throws(
      () => loadRubric("link/evil.json", root),
      (error: unknown) =>
        error instanceof EngineError && error.code === "invalid_rubric",
    );
  } finally {
    // Снимаем ссылку как ссылку, не заходя внутрь неё.
    try {
      rmdirSync(link);
    } catch {
      // ссылки уже нет
    }
    rmSync(base, { recursive: true, force: true });
  }
});
