import assert from "node:assert/strict";
import test from "node:test";
import { batchLimitsFor, planBatches } from "./batcher.js";
import { MODEL_REGISTRY, getModel, listModels } from "./registry.js";
import { MODEL_ALIASES } from "./types.js";

test("реестр содержит четыре стартовые модели", () => {
  assert.deepEqual(Object.keys(MODEL_REGISTRY).sort(), [...MODEL_ALIASES].sort());
  assert.equal(listModels("polza").length, 4);
});

test("окна контекста совпадают с каталогом Polza на 2026-11-22", () => {
  assert.equal(MODEL_REGISTRY.gemini.contextWindow, 262_144);
  assert.equal(MODEL_REGISTRY.ms.contextWindow, 32_768);
  assert.equal(MODEL_REGISTRY.jev.contextWindow, 64_000);
  assert.equal(MODEL_REGISTRY.luna.contextWindow, 1_050_000);
});

test("ID моделей различаются для Jev на Polza и OpenRouter", () => {
  assert.equal(getModel("jev", "polza").modelId, "typesafe/jev");
  assert.equal(getModel("jev", "openrouter").modelId, "typesafe/jev-1.14");
  assert.equal(
    getModel("luna", "polza").modelId,
    "openai/gpt-6-luna-decisions",
  );
});

test("мультимодальность в MVP выключена", () => {
  for (const model of listModels("polza")) {
    assert.equal(model.supportsMedia, false);
  }
});

test("план батча не превышает maxQuestionsPerRequest модели", () => {
  const questionIds = ["first", "second"];
  const rubric = {
    questions: {
      first: { type: "bool" as const, instructions: "Первый вопрос?" },
      second: { type: "bool" as const, instructions: "Второй вопрос?" },
    },
  };
  const items = Array.from({ length: 300 }, (_unused, index) => ({
    id: `step_${String(index + 1).padStart(3, "0")}`,
    content: "небольшой фрагмент",
  }));

  for (const alias of MODEL_ALIASES) {
    const model = getModel(alias, "polza");
    const plan = planBatches({
      modelAlias: alias,
      limits: batchLimitsFor(model),
      rubric,
      items,
    });
    assert.ok(plan.batches.length > 0, `${alias}: план пуст`);
    for (const batch of plan.batches) {
      assert.ok(
        batch.items.length * batch.questionIds.length <=
          model.maxQuestionsPerRequest,
        `${alias}: ${batch.items.length} элементов × ${batch.questionIds.length} вопросов > ${model.maxQuestionsPerRequest}`,
      );
    }
    assert.equal(plan.questionsPerItem, questionIds.length);
  }
});

test("лимиты вопросов gemini/luna соответствуют живым HTTP 400", () => {
  assert.equal(MODEL_REGISTRY.gemini.maxQuestionsPerRequest, 256);
  assert.equal(MODEL_REGISTRY.luna.maxQuestionsPerRequest, 200);
  assert.equal(
    MODEL_REGISTRY.gemini.maxQuestionsSource,
    "measured-2026-11-22",
  );
  assert.equal(
    MODEL_REGISTRY.luna.maxQuestionsSource,
    "measured-2026-11-22",
  );
});

test("тарифы Polza за 1M входных токенов", () => {
  assert.equal(MODEL_REGISTRY.gemini.polzaInputPriceRubPerMillion, 11.72);
  assert.equal(MODEL_REGISTRY.ms.polzaInputPriceRubPerMillion, 4.92);
  assert.equal(MODEL_REGISTRY.jev.polzaInputPriceRubPerMillion, 17.09);
  assert.equal(MODEL_REGISTRY.luna.polzaInputPriceRubPerMillion, 11.72);
});
