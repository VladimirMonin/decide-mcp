import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfigError,
  describeConfig,
  parseConfig,
} from "./config.js";

const polzaEnv = {
  DECIDE_PROVIDER: "polza",
  POLZA_API_KEY: "pza_test_key",
};

test("подставляет безопасные значения по умолчанию", () => {
  const config = parseConfig(polzaEnv);

  assert.equal(config.provider.name, "polza");
  assert.equal(config.provider.decisionsUrl, "https://polza.ai/api/v1/systemone");
  assert.equal(
    config.provider.catalogUrl,
    "https://polza.ai/api/v1/models/catalog",
  );
  assert.equal(config.defaultModel, "jev");
  assert.equal(config.dbPath, ".decide-mcp/runs.sqlite");
  assert.equal(config.allowedRoot, ".");
  assert.equal(config.maxConcurrency, 4);
  assert.equal(config.timeoutMs, 30_000);
});

test("требует ключ активного провайдера", () => {
  assert.throws(
    () => parseConfig({ DECIDE_PROVIDER: "polza" }),
    (error: unknown) =>
      error instanceof ConfigError && error.message.includes("POLZA_API_KEY"),
  );
});

test("строит URL OpenRouter из общего base URL", () => {
  const config = parseConfig({
    DECIDE_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
  });

  assert.equal(
    config.provider.decisionsUrl,
    "https://openrouter.ai/api/v1/systemone",
  );
  assert.equal(
    config.provider.catalogUrl,
    "https://openrouter.ai/api/v1/models?output_modalities=decisions",
  );
});

test("отклоняет неизвестного провайдера и модель", () => {
  assert.throws(
    () => parseConfig({ DECIDE_PROVIDER: "unknown", POLZA_API_KEY: "x" }),
    ConfigError,
  );
  assert.throws(
    () =>
      parseConfig({
        ...polzaEnv,
        DECIDE_DEFAULT_MODEL: "gpt",
      }),
    ConfigError,
  );
});

test("сводка конфигурации не содержит ключ", () => {
  const config = parseConfig({
    ...polzaEnv,
    POLZA_API_KEY: "pza_super_secret",
  });
  const summary = JSON.stringify(describeConfig(config));

  assert.equal(summary.includes("pza_super_secret"), false);
  assert.equal(summary.includes("apiKey"), false);
  assert.match(summary, /"provider":"polza"/);
});
