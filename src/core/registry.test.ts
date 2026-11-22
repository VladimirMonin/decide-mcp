import assert from "node:assert/strict";
import test from "node:test";
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
