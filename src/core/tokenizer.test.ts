import assert from "node:assert/strict";
import test from "node:test";
import {
  REQUEST_OVERHEAD_TOKENS,
  estimateRequestTokens,
  estimateTokens,
  safeRequestLimit,
} from "./tokenizer.js";

test("латиница оценивается как chars / 3.0", () => {
  const text = "a".repeat(300);

  assert.equal(estimateTokens(text), 100);
  assert.equal(estimateTokens(""), 0);
});

test("кириллица оценивается как chars / 2.2", () => {
  assert.equal(estimateTokens("ж".repeat(220)), 100);
});

test("порог тяжёлых символов — строго больше 20%", () => {
  const exactly20 = `${"ж".repeat(20)}${"a".repeat(80)}`;
  const over20 = `${"ж".repeat(21)}${"a".repeat(79)}`;

  assert.equal(estimateTokens(exactly20), Math.ceil(100 / 3.0));
  assert.equal(estimateTokens(over20), Math.ceil(100 / 2.2));
});

test("код считается тяжёлым, когда пунктуации больше 20%", () => {
  const code = "if (x[i] > 0) { return f(x); }";

  assert.ok(code.length > 0);
  assert.equal(estimateTokens(code), Math.ceil(code.length / 2.2));
});

test("не недооценивает токены пробы переполнения", () => {
  // Проба overflow-ms 2026-11-22: 150 145 символов state шлюз насчитал
  // как 67 074 токена (~2.24 символа на токен).
  const probeState = "ж".repeat(150_145);

  assert.ok(estimateTokens(probeState) >= 67_074);
});

test("длина измеряется в UTF-16 единицах, как text.length", () => {
  const emoji = "😀".repeat(10);

  assert.equal(emoji.length, 20);
  assert.equal(estimateTokens(emoji), Math.ceil(emoji.length / 3.0));
});

test("к каждому запросу добавляется overhead провайдера", () => {
  assert.equal(REQUEST_OVERHEAD_TOKENS, 280);
  assert.equal(estimateRequestTokens(""), 280);
  assert.equal(estimateRequestTokens("a".repeat(300)), 380);
});

test("безопасный потолок окна — 80% контекста", () => {
  assert.equal(safeRequestLimit(32_768), 26_214);
  assert.equal(safeRequestLimit(64_000), 51_200);
  assert.equal(safeRequestLimit(1_050_000), 840_000);
  assert.equal(safeRequestLimit(0), 0);
});
