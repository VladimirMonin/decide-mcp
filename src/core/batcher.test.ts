import assert from "node:assert/strict";
import test from "node:test";
import type { QuestionDef } from "./schema.js";
import {
  ProviderError,
  type CatalogModelInfo,
  type DecisionProvider,
  type NormalizedAnswer,
  type ProviderBatchRequest,
  type ProviderBatchResponse,
} from "./providers/types.js";
import {
  batchLimitsFor,
  planBatches,
  runPlan,
  type BatchLimits,
  type BatcherItem,
} from "./batcher.js";
import { getModel } from "./registry.js";

const ONE_BOOL: Record<string, QuestionDef> = {
  is_code: { type: "bool", instructions: "Это код?" },
};

function limits(overrides: Partial<BatchLimits> = {}): BatchLimits {
  return {
    contextWindow: 100_000,
    maxQuestionsPerRequest: 100,
    perQuestionWindow: 100_000,
    ...overrides,
  };
}

function items(count: number, content = "фрагмент"): BatcherItem[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `step_${String(index + 1).padStart(3, "0")}`,
    content,
  }));
}

function noulAnswer(prob = 0.9): NormalizedAnswer {
  return {
    type: "bool",
    status: "ok",
    prob,
    confidence: Math.max(prob, 1 - prob),
    confidenceSource: "max_prob",
  };
}

function okResponse(
  request: ProviderBatchRequest,
  make: (key: string) => NormalizedAnswer = () => noulAnswer(),
): ProviderBatchResponse {
  const answers: Record<string, NormalizedAnswer> = {};
  for (const key of Object.keys(request.questions)) answers[key] = make(key);
  return {
    answers,
    rawAnswers: {},
    usage: { inputTokens: 10, outputTokens: 1, costRub: 0.001 },
    latencyMs: 1,
    responseModel: "test-model",
  };
}

class StubProvider implements DecisionProvider {
  readonly name = "polza";
  readonly calls: ProviderBatchRequest[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    private readonly handler: (
      request: ProviderBatchRequest,
    ) => Promise<ProviderBatchResponse>,
  ) {}

  async decide(request: ProviderBatchRequest): Promise<ProviderBatchResponse> {
    this.calls.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await this.handler(request);
    } finally {
      this.active -= 1;
    }
  }

  async fetchCatalog(): Promise<CatalogModelInfo[]> {
    return [];
  }
}

test("выносит guide в state один раз и ставит якоря элементов", () => {
  const plan = planBatches({
    modelAlias: "ms",
    limits: limits(),
    rubric: {
      guide: "Оценивай фрагменты кода.",
      questions: ONE_BOOL,
    },
    items: items(2),
  });

  assert.equal(plan.batches.length, 1);
  const batch = plan.batches[0];
  assert.ok(batch);
  assert.equal(batch.state.split("## Справочник правил оценки").length - 1, 1);
  assert.ok(batch.state.includes('[ITEM id="step_001"]'));
  assert.ok(batch.state.includes('[ITEM id="step_002"]'));
  assert.deepEqual(Object.keys(batch.questions), [
    "step_001__is_code",
    "step_002__is_code",
  ]);
  assert.equal(
    batch.questions["step_001__is_code"]?.instructions,
    "Для элемента [step_001]: Это код?",
  );
  assert.deepEqual(batch.refs["step_002__is_code"], {
    itemId: "step_002",
    questionId: "is_code",
  });
});

test("ограничивает число элементов двумя вопросами и лимитом модели", () => {
  const plan = planBatches({
    modelAlias: "ms",
    limits: limits({ maxQuestionsPerRequest: 4 }),
    rubric: {
      questions: {
        is_code: { type: "bool", instructions: "Это код?" },
        quality: { type: "score", instructions: "Насколько понятно?", levels: ["плохо", "хорошо"] },
      },
    },
    items: items(5),
  });

  assert.deepEqual(
    plan.batches.map((batch) => batch.items.length),
    [2, 2, 1],
  );
  assert.equal(plan.questionsPerItem, 2);
  assert.equal(plan.skipped.length, 0);
});

test("дробит один элемент по группам вопросов", () => {
  const plan = planBatches({
    modelAlias: "ms",
    limits: limits({ maxQuestionsPerRequest: 2 }),
    rubric: {
      questions: {
        q1: { type: "bool", instructions: "Первый?" },
        q2: { type: "bool", instructions: "Второй?" },
        q3: { type: "bool", instructions: "Третий?" },
        q4: { type: "bool", instructions: "Четвёртый?" },
        q5: { type: "bool", instructions: "Пятый?" },
      },
    },
    items: items(1),
  });

  assert.deepEqual(
    plan.batches.map((batch) => Object.keys(batch.questions).length),
    [2, 2, 1],
  );
  assert.equal(plan.questionsPerItem, 5);
  for (const batch of plan.batches) {
    assert.equal(batch.items.length, 1);
  }
});

test("пропускает элемент, который не влезает в окно один", () => {
  const plan = planBatches({
    modelAlias: "ms",
    limits: limits({ contextWindow: 1_200, perQuestionWindow: 1_200 }),
    rubric: { questions: ONE_BOOL },
    items: [
      { id: "small", content: "x" },
      { id: "huge", content: "ж".repeat(5_000) },
    ],
  });

  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0]?.itemId, "huge");
  assert.equal(plan.skipped[0]?.apiId, "huge");
  assert.deepEqual(plan.skipped[0]?.questionIds, ["is_code"]);
  assert.equal(plan.skipped[0]?.reason, "skipped_too_large");
  assert.ok((plan.skipped[0]?.estimatedTokens ?? 0) > 960);
  assert.deepEqual(
    plan.batches.flatMap((batch) => batch.items.map((item) => item.id)),
    ["small"],
  );
});

test("замечает небезопасный item_id и заменяет его внутренним", () => {
  const plan = planBatches({
    modelAlias: "ms",
    limits: limits(),
    rubric: { questions: ONE_BOOL },
    items: [{ id: "logs/session 01.jsonl", content: "текст" }],
  });

  const batch = plan.batches[0];
  assert.ok(batch);
  assert.equal(batch.items[0]?.apiId, "i0001");
  assert.deepEqual(Object.keys(batch.questions), ["i0001__is_code"]);
  assert.ok(batch.state.includes('[ITEM id="i0001"]'));
  assert.deepEqual(batch.refs["i0001__is_code"], {
    itemId: "logs/session 01.jsonl",
    questionId: "is_code",
  });
});

test("не схлопывает в skipped два элемента с одинаковым item_id", () => {
  const plan = planBatches({
    modelAlias: "ms",
    limits: limits({ contextWindow: 1_200, perQuestionWindow: 1_200 }),
    rubric: { questions: ONE_BOOL },
    items: [
      { id: "same", content: "ж".repeat(5_000) },
      { id: "same", content: "ж".repeat(5_000) },
    ],
  });

  assert.deepEqual(
    plan.skipped.map((entry) => entry.apiId),
    ["same", "i0001"],
  );
  assert.deepEqual(
    plan.skipped.map((entry) => entry.itemId),
    ["same", "same"],
  );
  for (const entry of plan.skipped) {
    assert.deepEqual(entry.questionIds, ["is_code"]);
  }
});

test("разводит повторяющиеся item_id по внутренним идентификаторам", () => {
  const plan = planBatches({
    modelAlias: "ms",
    limits: limits(),
    rubric: { questions: ONE_BOOL },
    items: [
      { id: "same", content: "первый" },
      { id: "same", content: "второй" },
      { id: "i0001", content: "третий" },
    ],
  });

  // "i0001" занят явным item_id, поэтому дубликат уходит на i0002.
  assert.deepEqual(
    plan.batches[0]?.items.map((item) => item.apiId),
    ["same", "i0002", "i0001"],
  );
});

test("исполняет план, складывает usage и отдаёт ответы по item_id", async () => {
  const plan = planBatches({
    modelAlias: "ms",
    limits: limits({ maxQuestionsPerRequest: 1 }),
    rubric: { questions: ONE_BOOL },
    items: items(2),
  });
  const provider = new StubProvider(async (request) => okResponse(request));

  const result = await runPlan(plan, provider);

  assert.equal(result.answers.length, 2);
  assert.equal(result.answers[0]?.itemId, "step_001");
  assert.equal(result.answers[0]?.answer.status, "ok");
  assert.equal(result.batchesTotal, 2);
  assert.equal(result.usage.inputTokens, 20);
  assert.equal(result.usage.outputTokens, 2);
  assert.equal(result.usage.costRub, 0.002);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.blocked, []);
});

test("делит батч пополам при safety и изолирует проблемный элемент", async () => {
  const plan = planBatches({
    modelAlias: "ms",
    limits: limits({ maxQuestionsPerRequest: 10 }),
    rubric: { questions: ONE_BOOL },
    items: [
      { id: "step_001", content: "обычный текст" },
      { id: "step_002", content: "ТОКСИЧНЫЙ фрагмент" },
      { id: "step_003", content: "обычный текст" },
      { id: "step_004", content: "обычный текст" },
    ],
  });
  const provider = new StubProvider(async (request) => {
    if (request.state.includes("ТОКСИЧНЫЙ")) {
      throw new ProviderError("safety_blocked", "content_blocked", {
        status: 400,
        retryable: false,
      });
    }
    return okResponse(request);
  });

  const result = await runPlan(plan, provider);

  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0]?.itemId, "step_002");
  assert.equal(result.blocked[0]?.answer.status, "safety_blocked");
  assert.equal(result.blocked[0]?.answer.type, "bool");
  assert.deepEqual(
    result.answers.map((entry) => entry.itemId),
    ["step_001", "step_003", "step_004"],
  );
  assert.deepEqual(result.failures, []);
  // 1 батч + 2 половины + изоляция step_002 + успешная половина = 5 вызовов.
  assert.equal(result.batchesTotal, 5);
});

test("не делит батч при bad_request и фиксирует ошибку целиком", async () => {
  const plan = planBatches({
    modelAlias: "ms",
    limits: limits({ maxQuestionsPerRequest: 10 }),
    rubric: { questions: ONE_BOOL },
    items: items(3),
  });
  const provider = new StubProvider(async () => {
    throw new ProviderError("bad_request", "BAD_REQUEST: переполнение", {
      status: 400,
      retryable: false,
      traceId: "trace-batch-1",
    });
  });

  const result = await runPlan(plan, provider);

  assert.equal(result.batchesTotal, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.kind, "bad_request");
  assert.equal(result.failures[0]?.traceId, "trace-batch-1");
  assert.deepEqual(result.failures[0]?.itemIds, [
    "step_001",
    "step_002",
    "step_003",
  ]);
  assert.deepEqual(result.answers, []);
  assert.deepEqual(result.blocked, []);
});

test("держит потолок параллельности", async () => {
  const plan = planBatches({
    modelAlias: "ms",
    limits: limits({ maxQuestionsPerRequest: 1 }),
    rubric: { questions: ONE_BOOL },
    items: items(4),
  });
  const provider = new StubProvider(async (request) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return okResponse(request);
  });

  const result = await runPlan(plan, provider, { concurrency: 2 });

  assert.equal(result.answers.length, 4);
  assert.equal(provider.maxActive, 2);
});

test("лимиты jev учитывают двойной потолок одного вопроса", () => {
  const jev = batchLimitsFor(getModel("jev", "polza"));
  const ms = batchLimitsFor(getModel("ms", "polza"));

  assert.equal(jev.contextWindow, 64_000);
  assert.equal(jev.perQuestionWindow, 32_000);
  assert.equal(ms.perQuestionWindow, 32_768);
});
