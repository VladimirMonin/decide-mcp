/**
 * Быстрая оценка токенов без бинарных токенизаторов
 * (docs/architecture/providers-and-models.md §4).
 *
 * Калибровка 2026-11-22 по пробе переполнения (`fixtures/probes/overflow-ms.json`):
 * state на 150 145 символов шлюз насчитал как 67 074 токена, то есть ~2.24
 * символа на токен для кириллицы. Прежняя оценка 2.8 недооценивала такие
 * запросы на ~25% и пропускала батч, который получал `HTTP 400` целиком.
 * Поэтому тяжёлый текст (кириллица, код) считается как 2.2 символа на токен,
 * латиница и проза — как 3.0 (пропорционально прежним 2.8 / 3.8).
 * К каждому запросу провайдер добавляет служебный overhead 280 токенов.
 * Длина везде измеряется в UTF-16 единицах (`text.length`).
 */

/** Служебный overhead провайдера на каждый запрос (задокументирован Polza AI). */
export const REQUEST_OVERHEAD_TOKENS = 280;

/**
 * Доля окна, которую планировщик считает безопасной. Оставлена 0.80 из
 * docs/architecture/providers-and-models.md §4: после калибровки оценка выше
 * факта (150 145 символов → 68 248 против 67 074 токенов шлюза), поэтому
 * 20% буфера дают ~21% реального запаса к лимиту. Уменьшать долю не нужно:
 * систематическая недооценка была в коэффициенте, а не в буфере.
 */
export const SAFE_WINDOW_RATIO = 0.8;

/** Порог доли «тяжёлых» символов, после которого берётся оценка 2.2. */
export const HEAVY_CHAR_SHARE_THRESHOLD = 0.2;

/**
 * Проба `overflow-ms` 2026-11-22: 150 145 символов кириллицы → 67 074 токена
 * у шлюза (~2.24 символа/токен). 2.2 даёт 68 248 — на 1.7% строже факта.
 */
const HEAVY_CHARS_PER_TOKEN = 2.2;
const LIGHT_CHARS_PER_TOKEN = 3.0;

const CYRILLIC_CHAR = /[\u0400-\u04FF]/;
const CODE_CHAR = /[{}()[\];=<>"'`\\/+*&|!?:.#$%^~]/;

function isHeavyChar(char: string): boolean {
  return CYRILLIC_CHAR.test(char) || CODE_CHAR.test(char);
}

/**
 * Консервативная оценка числа токенов текста.
 * Для пустой строки — 0. Для смеси кириллицы/кода выше 20% — `chars / 2.2`,
 * иначе `chars / 3.0` (округление вверх).
 *
 * Доля и делитель считаются в одних и тех же UTF-16 единицах: цикл идёт по
 * индексам `text.length`, поэтому суррогатная пара — это два символа, и
 * размерности не расходятся (раньше доля считалась по code points, а деление
 * по `text.length`).
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  let heavy = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (isHeavyChar(text[index])) heavy += 1;
  }
  const heavyShare = heavy / text.length;
  const charsPerToken =
    heavyShare > HEAVY_CHAR_SHARE_THRESHOLD
      ? HEAVY_CHARS_PER_TOKEN
      : LIGHT_CHARS_PER_TOKEN;
  return Math.ceil(text.length / charsPerToken);
}

/** Полная оценка запроса: текст плюс служебный overhead провайдера. */
export function estimateRequestTokens(text: string): number {
  return estimateTokens(text) + REQUEST_OVERHEAD_TOKENS;
}

/** Безопасный потолок окна: 80% контекста модели, округление вниз. */
export function safeRequestLimit(contextWindow: number): number {
  return Math.floor(contextWindow * SAFE_WINDOW_RATIO);
}
