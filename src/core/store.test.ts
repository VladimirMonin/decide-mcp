import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunStore, createRunId } from "./store.js";

function tempDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "decide-store-"));
  return { dir, dbPath: path.join(dir, "runs.sqlite") };
}

const ANSWER = {
  type: "score" as const,
  status: "ok" as const,
  score: 1.8,
  confidence: 0.9,
  confidenceSource: "provider" as const,
  probabilities: [0.1, 0.2, 0.7],
};

test("пишет и перечитывает прогон, элементы и ответы после переоткрытия", () => {
  const { dir, dbPath } = tempDb();
  const runId = "run_20261122_100000_0001";
  try {
    const store = new RunStore(dbPath);
    store.createRun({
      runId,
      createdAt: "2026-11-22T10:00:00.000Z",
      provider: "polza",
      modelAlias: "jev",
      modelId: "typesafe/jev",
      scope: "per_item",
      sourceJson: JSON.stringify({ type: "text", items: [{ id: "a", content: "x" }] }),
      rubricJson: JSON.stringify({ questions: {} }),
      parentRunId: null,
      itemsTotal: 2,
    });
    store.addItems(runId, [
      {
        itemId: "step_001",
        seqIndex: 0,
        sourceRef: "logs/a.jsonl#L1",
        meta: { line: 1 },
        preview: "первый",
        contentHash: "hash-1",
        status: "pending",
      },
      {
        itemId: "step_002",
        seqIndex: 1,
        sourceRef: "logs/a.jsonl#L2",
        meta: null,
        preview: "второй",
        contentHash: "hash-2",
        status: "pending",
      },
    ]);
    store.saveAnswers(runId, [
      { itemId: "step_001", questionId: "quality", answer: ANSWER, traceId: "trace-1" },
      {
        itemId: "step_002",
        questionId: "quality",
        answer: {
          type: "bool",
          status: "ok",
          prob: 0.8,
          confidence: 0.8,
          confidenceSource: "max_prob",
        },
      },
    ]);
    store.markItemStatus(runId, "step_001", "ok");
    store.markItemStatus(runId, "step_002", "safety_blocked", "safety_blocked");
    store.finishRun(runId, {
      status: "partial",
      itemsProcessed: 1,
      itemsSkipped: 0,
      itemsBlocked: 1,
      batchesTotal: 2,
      inputTokens: 320,
      outputTokens: 4,
      costRub: 0.0012,
      durationMs: 42,
      responseModel: "jev-1.14.0",
      errorSummary: null,
    });
    assert.equal(store.countRuns(), 1);
    store.close();

    const reopened = new RunStore(dbPath);
    try {
      const run = reopened.getRun(runId);
      assert.ok(run);
      assert.equal(run.status, "partial");
      assert.equal(run.provider, "polza");
      assert.equal(run.modelAlias, "jev");
      assert.equal(run.modelId, "typesafe/jev");
      assert.equal(run.responseModel, "jev-1.14.0");
      assert.equal(run.itemsTotal, 2);
      assert.equal(run.itemsProcessed, 1);
      assert.equal(run.itemsBlocked, 1);
      assert.equal(run.inputTokens, 320);
      assert.equal(run.outputTokens, 4);
      assert.equal(run.costRub, 0.0012);
      assert.equal(run.durationMs, 42);
      assert.equal(run.scope, "per_item");

      const items = reopened.listItems(runId);
      assert.deepEqual(
        items.map((item) => [item.itemId, item.status, item.errorCode]),
        [
          ["step_001", "ok", null],
          ["step_002", "safety_blocked", "safety_blocked"],
        ],
      );
      assert.equal(items[0]?.metaJson, JSON.stringify({ line: 1 }));

      const answers = reopened.listAnswers(runId);
      assert.equal(answers.length, 2);
      const score = answers.find((answer) => answer.itemId === "step_001");
      assert.ok(score);
      assert.equal(score.primitiveType, "score");
      assert.equal(score.scoreValue, 1.8);
      assert.equal(score.confidence, 0.9);
      assert.equal(score.confidenceSource, "provider");
      assert.equal(score.traceId, "trace-1");
      assert.deepEqual(JSON.parse(score.probabilitiesJson ?? "null"), [0.1, 0.2, 0.7]);
      assert.deepEqual(JSON.parse(score.answerJson), ANSWER);

      const onlyFirst = reopened.listAnswers(runId, ["step_001"]);
      assert.equal(onlyFirst.length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("повторная запись ответа заменяет строку, а не дублирует", () => {
  const { dir, dbPath } = tempDb();
  const runId = "run_20261122_100001_0002";
  try {
    const store = new RunStore(dbPath);
    try {
      store.createRun({
        runId,
        createdAt: "2026-11-22T10:00:01.000Z",
        provider: "polza",
        modelAlias: "ms",
        modelId: "microsoft/microsoft-decision-1",
        scope: "per_item",
        sourceJson: "{}",
        rubricJson: "{}",
        itemsTotal: 1,
      });
      store.addItems(runId, [
        {
          itemId: "i1",
          seqIndex: 0,
          sourceRef: null,
          meta: null,
          preview: "x",
          contentHash: "h",
          status: "pending",
        },
      ]);
      store.saveAnswers(runId, [
        { itemId: "i1", questionId: "quality", answer: ANSWER },
      ]);
      store.saveAnswers(runId, [
        {
          itemId: "i1",
          questionId: "quality",
          answer: { ...ANSWER, score: 2.5, confidence: 0.5 },
        },
      ]);

      const answers = store.listAnswers(runId);
      assert.equal(answers.length, 1);
      assert.equal(answers[0]?.scoreValue, 2.5);
      assert.equal(answers[0]?.confidence, 0.5);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("хранилище работает в режиме WAL", () => {
  const { dir, dbPath } = tempDb();
  try {
    const store = new RunStore(dbPath);
    try {
      const row = store.queryOne("PRAGMA journal_mode");
      assert.equal(String(row?.["journal_mode"]).toLowerCase(), "wal");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createRunId собирает UTC-метку с суффиксом", () => {
  const runId = createRunId(new Date("2026-11-22T22:15:00Z"), "7f3a");

  assert.equal(runId, "run_20261122_221500_7f3a");
});
