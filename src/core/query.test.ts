import assert from "node:assert/strict";
import test from "node:test";
import {
  QueryError,
  aggregateRun,
  compareRuns,
  filterRun,
  inspectRun,
  selectItemIds,
} from "./query.js";
import { RunStore } from "./store.js";
import type { NormalizedAnswer } from "./providers/types.js";
import type { FilterField, FilterOp } from "./schema.js";

function scoreAnswer(value: number, probabilities: number[]): NormalizedAnswer {
  return {
    type: "score",
    status: "ok",
    score: value,
    confidence: 0.9,
    confidenceSource: "provider",
    probabilities,
  };
}

function boolAnswer(prob: number): NormalizedAnswer {
  return {
    type: "bool",
    status: "ok",
    prob,
    confidence: Math.max(prob, 1 - prob),
    confidenceSource: "max_prob",
  };
}

function choiceAnswer(choice: string): NormalizedAnswer {
  return {
    type: "choice",
    status: "ok",
    choice,
    confidence: 0.8,
    confidenceSource: "provider",
  };
}

interface Seeded {
  store: RunStore;
  runId: string;
  compareRunId: string;
}

function seed(): Seeded {
  const store = new RunStore(":memory:");
  const runId = "run_left";
  const compareRunId = "run_right";

  for (const id of [runId, compareRunId]) {
    store.createRun({
      runId: id,
      createdAt: "2026-11-22T10:00:00.000Z",
      provider: "polza",
      modelAlias: "jev",
      modelId: "typesafe/jev",
      scope: "per_item",
      sourceJson: JSON.stringify({ type: "text", items: [{ id: "i1", content: "x" }] }),
      rubricJson: "{}",
      itemsTotal: 5,
    });
    store.addItems(id, [
      {
        itemId: "i1",
        seqIndex: 0,
        sourceRef: "a.jsonl#L1",
        meta: { line: 1 },
        preview: "первый",
        contentHash: "h1",
        status: "ok",
      },
      {
        itemId: "i2",
        seqIndex: 1,
        sourceRef: "a.jsonl#L2",
        meta: null,
        preview: "второй",
        contentHash: "h2",
        status: "ok",
      },
      {
        itemId: "i3",
        seqIndex: 2,
        sourceRef: "a.jsonl#L3",
        meta: null,
        preview: "третий",
        contentHash: "h3",
        status: "ok",
      },
      {
        itemId: "i4",
        seqIndex: 3,
        sourceRef: null,
        meta: null,
        preview: "слишком большой",
        contentHash: "h4",
        status: "skipped_too_large",
      },
      {
        itemId: "i5",
        seqIndex: 4,
        sourceRef: null,
        meta: null,
        preview: "заблокирован",
        contentHash: "h5",
        status: "safety_blocked",
      },
    ]);
  }

  store.saveAnswers(runId, [
    { itemId: "i1", questionId: "q_score", answer: scoreAnswer(1.8, [0.1, 0.2, 0.7]) },
    { itemId: "i1", questionId: "q_code", answer: boolAnswer(0.9) },
    { itemId: "i1", questionId: "q_lang", answer: choiceAnswer("js") },
    { itemId: "i2", questionId: "q_score", answer: scoreAnswer(0.4, [0.5, 0.4, 0.1]) },
    { itemId: "i2", questionId: "q_code", answer: boolAnswer(0.2) },
    { itemId: "i2", questionId: "q_lang", answer: choiceAnswer("python") },
    { itemId: "i3", questionId: "q_score", answer: scoreAnswer(2.6, [0, 0, 1]) },
    { itemId: "i3", questionId: "q_code", answer: boolAnswer(0.99) },
    { itemId: "i3", questionId: "q_lang", answer: choiceAnswer("js") },
    {
      itemId: "i5",
      questionId: "q_score",
      answer: {
        type: "score",
        status: "safety_blocked",
        confidence: 0,
        confidenceSource: "none",
      },
    },
  ]);

  store.saveAnswers(compareRunId, [
    { itemId: "i1", questionId: "q_score", answer: scoreAnswer(1.2, [0.4, 0.4, 0.2]) },
    { itemId: "i1", questionId: "q_code", answer: boolAnswer(0.6) },
    { itemId: "i1", questionId: "q_lang", answer: choiceAnswer("python") },
    { itemId: "i2", questionId: "q_score", answer: scoreAnswer(0.4, [0.5, 0.4, 0.1]) },
    { itemId: "i2", questionId: "q_code", answer: boolAnswer(0.2) },
    { itemId: "i2", questionId: "q_lang", answer: choiceAnswer("python") },
    { itemId: "i3", questionId: "q_score", answer: scoreAnswer(2.0, [0.1, 0.1, 0.8]) },
    { itemId: "i3", questionId: "q_code", answer: boolAnswer(0.3) },
    { itemId: "i3", questionId: "q_lang", answer: choiceAnswer("js") },
  ]);

  return { store, runId, compareRunId };
}

test("filter отбирает по числовому порогу, сортирует и ограничивает", () => {
  const { store, runId } = seed();
  try {
    const filtered = filterRun(store, {
      runId,
      where: {
        conditions: [{ question_id: "q_score", field: "score", op: ">=", value: 1.5 }],
      },
      sortBy: { questionId: "q_score", field: "score", order: "desc" },
    });

    assert.equal(filtered.total, 2);
    assert.deepEqual(
      filtered.items.map((item) => item.itemId),
      ["i3", "i1"],
    );
    assert.equal(filtered.items[0]?.answers["q_score"]?.score, 2.6);
    assert.equal(filtered.items[0]?.preview, "третий");

    const page = filterRun(store, {
      runId,
      sortBy: { questionId: "q_score", field: "score", order: "asc" },
      limit: 1,
      offset: 1,
    });
    assert.deepEqual(
      page.items.map((item) => item.itemId),
      ["i1"],
    );
  } finally {
    store.close();
  }
});

test("filter понимает choice, in и логику or", () => {
  const { store, runId } = seed();
  try {
    const byChoice = filterRun(store, {
      runId,
      where: { conditions: [{ question_id: "q_lang", field: "choice", op: "=", value: "js" }] },
    });
    assert.deepEqual(
      byChoice.items.map((item) => item.itemId),
      ["i1", "i3"],
    );

    const byIn = filterRun(store, {
      runId,
      where: { conditions: [{ question_id: "q_lang", field: "choice", op: "in", value: ["python"] }] },
    });
    assert.deepEqual(
      byIn.items.map((item) => item.itemId),
      ["i2"],
    );

    const byOr = filterRun(store, {
      runId,
      where: {
        logic: "or",
        conditions: [
          { question_id: "q_score", field: "score", op: ">=", value: 2.5 },
          { question_id: "q_lang", field: "choice", op: "=", value: "python" },
        ],
      },
    });
    assert.deepEqual(
      byOr.items.map((item) => item.itemId),
      ["i2", "i3"],
    );
  } finally {
    store.close();
  }
});

test("filter без where отдаёт все элементы и отвергает мусор", () => {
  const { store, runId } = seed();
  try {
    const all = filterRun(store, { runId, limit: 10 });
    assert.equal(all.total, 5);
    assert.equal(all.items.length, 5);

    assert.throws(
      () =>
        filterRun(store, {
          runId,
          where: {
            conditions: [
              {
                question_id: "q_score",
                // Намеренно невалидное поле: проверяем отказ компилятора фильтра.
                field: "probability" as FilterField,
                op: ">",
                value: 1,
              },
            ],
          },
        }),
      (error: unknown) => error instanceof QueryError && error.code === "invalid_query",
    );
    assert.throws(
      () => filterRun(store, { runId: "run_missing" }),
      (error: unknown) => error instanceof QueryError && error.code === "run_not_found",
    );

    const ids = selectItemIds(store, runId, {
      where: { conditions: [{ question_id: "q_score", field: "score", op: ">", value: 2 }] },
    });
    assert.deepEqual(ids, ["i3"]);
  } finally {
    store.close();
  }
});

test("SQL-инъекции в значениях и мусор в полях не ломают таблицы", () => {
  const { store, runId } = seed();
  try {
    const injected = "'; DROP TABLE runs; --";
    const runsBefore = store.countRuns();

    const byValue = filterRun(store, {
      runId,
      where: {
        conditions: [
          { question_id: "q_lang", field: "choice", op: "=", value: injected },
        ],
      },
    });
    assert.equal(byValue.total, 0);

    // Таблицы и данные целы после попытки инъекции значением.
    assert.equal(store.countRuns(), runsBefore);
    assert.ok(store.getRun(runId));
    assert.equal(store.listItems(runId).length, 5);
    assert.equal(aggregateRun(store, { runId }).itemsTotal, 5);

    // Мусор в question_id/op отсекается валидацией до SQL.
    assert.throws(
      () =>
        filterRun(store, {
          runId,
          where: {
            conditions: [
              { question_id: injected, field: "score", op: ">=", value: 1 },
            ],
          },
        }),
      (error: unknown) => error instanceof QueryError && error.code === "invalid_query",
    );
    assert.throws(
      () =>
        filterRun(store, {
          runId,
          where: {
            conditions: [
              {
                question_id: "q_score",
                field: "score",
                op: injected as FilterOp,
                value: 1,
              },
            ],
          },
        }),
      (error: unknown) => error instanceof QueryError && error.code === "invalid_query",
    );

    // Имя вопроса в sort_by уходит параметром JOIN, а не в текст SQL.
    const sorted = filterRun(store, {
      runId,
      sortBy: { questionId: injected, field: "score" },
    });
    assert.equal(sorted.items.length, 5);
    assert.equal(store.countRuns(), runsBefore);

    const numericInjection = filterRun(store, {
      runId,
      where: {
        conditions: [
          { question_id: "q_score", field: "score", op: ">=", value: injected },
        ],
      },
    });
    assert.equal(typeof numericInjection.total, "number");
    assert.equal(store.countRuns(), runsBefore);
  } finally {
    store.close();
  }
});

test("aggregate считает распределения и доли статусов", () => {
  const { store, runId } = seed();
  try {
    const aggregate = aggregateRun(store, { runId });

    assert.equal(aggregate.itemsTotal, 5);
    assert.equal(aggregate.itemStatusCounts.ok, 3);
    assert.equal(aggregate.itemStatusCounts.skipped_too_large, 1);
    assert.equal(aggregate.itemStatusCounts.safety_blocked, 1);
    assert.equal(aggregate.itemStatusShares.ok, 3 / 5);
    assert.equal(aggregate.itemStatusShares.safety_blocked, 1 / 5);
    assert.equal(aggregate.itemStatusShares.skipped_too_large, 1 / 5);

    const score = aggregate.questions["q_score"];
    assert.ok(score?.type === "score");
    assert.equal(score.count, 4);
    assert.equal(score.statusCounts.ok, 3);
    assert.equal(score.statusCounts.safety_blocked, 1);
    assert.ok(Math.abs((score.avgScore ?? 0) - 1.6) < 1e-9);
    assert.equal(score.minScore, 0.4);
    assert.equal(score.maxScore, 2.6);
    assert.deepEqual(score.buckets, { "2": 2, "0": 1 });

    const bool = aggregate.questions["q_code"];
    assert.ok(bool?.type === "bool");
    assert.ok(Math.abs((bool.avgProb ?? 0) - (0.9 + 0.2 + 0.99) / 3) < 1e-9);
    assert.deepEqual(bool.buckets, { "0.9..1.0": 2, "0.2..0.3": 1 });

    const choice = aggregate.questions["q_lang"];
    assert.ok(choice?.type === "choice");
    assert.deepEqual(choice.counts, { js: 2, python: 1 });
  } finally {
    store.close();
  }
});

test("inspect отдаёт тексты через загрузчик и соседей по context_window", async () => {
  const { store, runId } = seed();
  try {
    const loaded = await inspectRun(
      store,
      { runId, itemIds: ["i2"], contextWindow: 1 },
      {
        loadContent: async (_run, itemIds) => ({
          content: new Map(itemIds.map((itemId) => [itemId, `content:${itemId}`])),
        }),
      },
    );

    assert.deepEqual(
      loaded.items.map((item) => [item.itemId, item.target]),
      [
        ["i1", false],
        ["i2", true],
        ["i3", false],
      ],
    );
    assert.equal(loaded.items[1]?.content, "content:i2");
    assert.equal(loaded.contentTruncated, false);
    assert.deepEqual(loaded.missing, []);

    const withoutLoader = await inspectRun(store, { runId, itemIds: ["i1"] });
    assert.equal(withoutLoader.items[0]?.content, null);
    assert.equal(withoutLoader.contentTruncated, true);

    const withMissing = await inspectRun(store, {
      runId,
      itemIds: ["i1", "nope"],
    });
    assert.deepEqual(withMissing.missing, ["nope"]);

    await assert.rejects(
      inspectRun(store, {
        runId,
        itemIds: Array.from({ length: 21 }, (_unused, index) => `i${index}`),
      }),
      (error: unknown) => error instanceof QueryError && error.code === "too_many_items",
    );
  } finally {
    store.close();
  }
});

test("inspect передаёт предупреждения загрузчика", async () => {
  const { store, runId } = seed();
  try {
    const result = await inspectRun(
      store,
      { runId, itemIds: ["i1"] },
      {
        loadContent: async () => ({
          content: new Map([["i1", "текст"]]),
          warnings: ["Источник изменился после прогона: i1"],
        }),
      },
    );

    assert.equal(result.items[0]?.content, "текст");
    assert.equal(result.contentTruncated, false);
    assert.deepEqual(result.warnings, [
      "Источник изменился после прогона: i1",
    ]);
  } finally {
    store.close();
  }
});

test("inspect не падает, если источник исчез: отдаёт preview и предупреждение", async () => {
  const { store, runId } = seed();
  try {
    const result = await inspectRun(
      store,
      { runId, itemIds: ["i1"] },
      {
        loadContent: async () => {
          throw new Error("файл исчез");
        },
      },
    );

    assert.equal(result.items[0]?.content, null);
    assert.equal(result.contentTruncated, true);
    assert.deepEqual(result.warnings, ["файл исчез"]);
  } finally {
    store.close();
  }
});

test("compare считает расхождение, совпадения и контрасты", () => {
  const { store, runId, compareRunId } = seed();
  try {
    const compare = compareRuns(store, { runId, compareRunId });

    assert.equal(compare.commonQuestions, 3);

    const score = compare.questions["q_score"];
    assert.ok(score);
    assert.equal(score.type, "score");
    assert.equal(score.matched, 3);
    assert.ok(Math.abs((score.meanAbsDiff ?? 0) - 0.4) < 1e-9);
    assert.equal(score.contrasts.length, 2);
    assert.equal(score.contrasts[0]?.itemId, "i1");
    assert.ok(Math.abs((score.contrasts[0]?.diff ?? 0) - 0.6) < 1e-9);

    const bool = compare.questions["q_code"];
    assert.ok(bool);
    assert.ok(Math.abs((bool.agreement ?? 0) - 2 / 3) < 1e-9);

    const choice = compare.questions["q_lang"];
    assert.ok(choice);
    assert.equal(choice.meanAbsDiff, null);
    assert.ok(Math.abs((choice.agreement ?? 0) - 2 / 3) < 1e-9);
    assert.equal(choice.contrasts.length, 1);
    assert.equal(choice.contrasts[0]?.itemId, "i1");
  } finally {
    store.close();
  }
});
