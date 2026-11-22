import assert from "node:assert/strict";
import test from "node:test";
import { buildSmokeRequest, validateSmokeResponse } from "./smoke.js";

const syntheticResponse = {
  model: "jev-1.14.0",
  answers: {
    has_function: { type: "noul", noul: 0.98 },
    language: {
      type: "choice",
      choice: "js",
      confidence: 1,
      probabilities: { js: 1, python: 0, other: 0 },
    },
    quality: {
      type: "score",
      score: 1.86,
      confidence: 0.79,
      probabilities: { "0": 0.02, "1": 0.1, "2": 0.88 },
    },
  },
  usage: { input_tokens: 471, output_tokens: 69, cost_rub: 0.008_050_28 },
};

test("запрос использует провайдерское поле criteria", () => {
  const request = buildSmokeRequest("typesafe/jev");

  assert.equal(request.model, "typesafe/jev");
  assert.equal(request.questions.language.criteria.js, "JavaScript");
  assert.equal(request.questions.quality.criteria[2], "хорошо");
  assert.equal("options" in request.questions.language, false);
  assert.equal("levels" in request.questions.quality, false);
});

test("валидирует реальный формат ответа systemone", () => {
  const result = validateSmokeResponse(syntheticResponse);

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, {
    shape: true,
    noul: true,
    choice: true,
    score: true,
    usage: true,
  });
  assert.equal(result.responseModel, "jev-1.14.0");
  assert.equal(result.usage?.inputTokens, 471);
  assert.equal(result.usage?.outputTokens, 69);
  assert.equal(result.usage?.costRub, 0.008_050_28);
});

test("отклоняет ответ без answers и usage", () => {
  const result = validateSmokeResponse({ model: "jev-1.14.0" });

  assert.equal(result.ok, false);
  assert.equal(result.checks.shape, false);
  assert.equal(result.checks.noul, false);
  assert.equal(result.checks.choice, false);
  assert.equal(result.checks.score, false);
  assert.equal(result.checks.usage, false);
});

test("не принимает score вне диапазона уровней", () => {
  const broken = structuredClone(syntheticResponse);
  broken.answers.quality.score = 99;

  const result = validateSmokeResponse(broken);
  assert.equal(result.checks.score, false);
  assert.equal(result.ok, false);
});
