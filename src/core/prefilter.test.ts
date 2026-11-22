import assert from "node:assert/strict";
import test from "node:test";
import {
  computePrefilterTags,
  detectRepeatReasoning,
  detectReversalMarkers,
  formatPrefilterTags,
  hasInvalidArgsJson,
  isToolError,
  reasoningSummary,
  type PrefilterStep,
} from "./prefilter.js";
import { estimateTokens } from "./tokenizer.js";

function step(overrides: Partial<PrefilterStep> = {}): PrefilterStep {
  return {
    stepId: null,
    toolName: null,
    argsText: null,
    reasoning: null,
    status: null,
    error: null,
    invalidJson: false,
    ...overrides,
  };
}

test("сводка reasoning считает символы, токены и первые/последние фразы", () => {
  const text = "Первое предложение. Второе предложение с хвостом.";
  const summary = reasoningSummary(text);

  assert.equal(summary.chars, text.length);
  assert.equal(summary.toks, estimateTokens(text));
  assert.equal(summary.first, "Первое предложение.");
  assert.equal(summary.last, "Второе предложение с хвостом.");
  assert.equal(summary.reversals, 0);
  assert.deepEqual(reasoningSummary(""), {
    chars: 0,
    toks: 0,
    first: "",
    last: "",
    reversals: 0,
  });
});

test("находит маркеры разворота на английском и русском", () => {
  const text = "Wait, это неверно. Actually, подождите. Но нет, стоп.";

  assert.equal(detectReversalMarkers(text), 5);
  assert.equal(detectReversalMarkers("обычное рассуждение без разворотов"), 0);
});

test("самоповтор reasoning ловится по повторённому шинглу", () => {
  const repeated = "alpha beta gamma delta epsilon zeta ".repeat(4);
  const single = "alpha beta gamma delta epsilon zeta omega sigma tau";

  assert.equal(detectRepeatReasoning(repeated), true);
  assert.equal(detectRepeatReasoning(single), false);
  assert.equal(detectRepeatReasoning("слишком короткий текст"), false);
});

test("ошибка инструмента определяется по статусу или полю error", () => {
  assert.equal(isToolError("error", null), true);
  assert.equal(isToolError("failed", null), true);
  assert.equal(isToolError("ok", "timeout"), true);
  assert.equal(isToolError("ok", null), false);
  assert.equal(isToolError(null, null), false);
});

test("серия повторных вызовов считается по соседним шагам", () => {
  const tags = computePrefilterTags([
    step({ toolName: "read_file", argsText: '{"path":"a"}' }),
    step({ toolName: "read_file", argsText: '{ "path": "a" }' }),
    step({ toolName: "read_file", argsText: '{"path":"a"}' }),
    step({ toolName: "write_file", argsText: '{"path":"a"}' }),
  ]);

  assert.deepEqual(
    tags.map((entry) => entry.repeatTool),
    [1, 2, 3, 1],
  );
});

test("теги reasoning, ошибки и невалидного JSON попадают в строку", () => {
  const tags = computePrefilterTags([
    step({
      reasoning: "думаю одно и то же снова и снова ".repeat(4),
      status: "error",
    }),
    step({ invalidJson: true }),
  ]);

  assert.ok((tags[0]?.reasoningToks ?? 0) > 0);
  assert.equal(tags[0]?.repeatReasoning, true);
  assert.equal(tags[0]?.toolError, true);
  assert.equal(tags[1]?.invalidJson, true);

  const second = tags[1];
  assert.ok(second);
  assert.equal(formatPrefilterTags(second), "[invalid_json]");

  const full = formatPrefilterTags({
    reasoningToks: 4200,
    repeatTool: 3,
    repeatReasoning: true,
    toolError: true,
    reversalMarkers: 2,
    invalidJson: true,
  });
  assert.equal(
    full,
    "[reasoning_toks=4200, repeat_tool=3, repeat_reasoning, tool_error, reversals=2, invalid_json]",
  );
});

test("битый JSON аргументов помечается как invalid_json", () => {
  assert.equal(hasInvalidArgsJson('{"path":'), true);
  assert.equal(hasInvalidArgsJson("[1, 2"), true);
  assert.equal(hasInvalidArgsJson('{"path":"a"}'), false);
  assert.equal(hasInvalidArgsJson("обычная строка"), false);
  assert.equal(hasInvalidArgsJson(null), false);

  const tags = computePrefilterTags([
    step({ toolName: "read_file", argsText: '{"path":' }),
  ]);
  assert.equal(tags[0]?.invalidJson, true);
  assert.equal(tags[0]?.repeatTool, 1);
});

test("без тегов строка не формируется", () => {
  assert.equal(
    formatPrefilterTags({
      reasoningToks: 0,
      repeatTool: 1,
      repeatReasoning: false,
      toolError: false,
      reversalMarkers: 0,
      invalidJson: false,
    }),
    null,
  );
});
