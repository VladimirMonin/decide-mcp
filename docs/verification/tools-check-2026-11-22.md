---
id: "decide-mcp.verification.tools-check-2026-11-22"
title: "Проверка инструментов анализа кода на decide-core"
kind: verification
status: draft
created: "2026-11-22"
updated: "2026-11-22"
areas: [tools, verification, mcp]
summary: "Базовые прогоны decide-mcp и codebase-memory на коде decide-core: что умеет каждый, чем различаются, стоимость."
---

# Проверка инструментов анализа кода

Живой прогон 2026-11-22. Сравнены два инструмента на коде этого же проекта (decide-core) на разные задачи. `decide-mcp` — наш MCP-сервер (установлен для Pi-агента); `codebase-memory` — структурный навигатор кода. Команды прогона — см. ниже, независимая приёмка не проводилась.

## decide-mcp (наш decision-движок)

Установлен как MCP-сервер для Pi (`pi mcp add decide-mcp -- node dist/servers/mcp.js`), `pi mcp list` показывает `connected, 3 tools` (`decide_run`, `decide_query`, `decide_models`).

| Проверка | Результат |
|---|---|
| `decide_models` | Паспорт 4 моделей и пресеты, без сети |
| `decide_run` dry_run | План батчей/токенов, ноль вызовов |
| `decide_run` (живой, `jev`) | 6 файлов `src/core/*.ts`, 2 вопроса (bool + score) |
| `decide_query` aggregate | Статусы, доли, распределения по вопросам |

Живой прогон: `run_20261122_185443_3709`, статус `completed`, 2 батча, `input_tokens` 29 142, `output_tokens` 272, **стоимость 0.49809215 ₽** `[PAID]`. Сводка: `error_handling` (bool) `avg_prob` 0.96 — обработка ошибок есть во всех 6 файлах; `size` (score) `avg` 1.25. Агенту отдана компактная сводка + `top_items`, без сырых данных.

## codebase-memory (структура кода)

| Проверка | Результат |
|---|---|
| `search_graph` по секциям | Находит разделы документации с путями и строками |
| `search_graph` по именам символов | `classifyHttpError`, `resolveInsideRoot`, `toProviderQuestion` и др. с путями/строками |
| `trace_path` (двунаправленно) | `resolveInsideRoot` ← `loadRubric`, `readFileSource`, `readJsonlSource`, `runDecision`, `readSource`; → `assertInside`, `isInside`, `SourceError` |

## Чем различаются (когда что брать)

- **decide-mcp** — семантическая оценка содержимого: вероятности, классификация, грейды по рубрике на больших выборках. Компактно для контекста, сырые данные остаются в SQLite, срезы (`decide_query`) бесплатны после прогона. Хорош для массового скрининга и воронок.
- **codebase-memory** — структурный анализ: символы, точные строки, связи callers/callees, трассировка. Детерминированно и мгновенно, без сети и токенов. Хорош для навигации «где это и кто вызывает».

Они дополняют друг друга: `codebase-memory` находит и локализует, `decide-mcp` оценивает содержимое массово по заданному критерию.

## Замечание по вызову

Первый `decide_run` упал валидацией: `glob`-источник требует поле `pattern`, а не `path`. Это была ошибка вызова (не баг): `mcp.ts` переиспользует единую `sourceSchema` из `core/schema.ts`. Валидация и сообщение об ошибке отработали корректно.

## NOT RUN

- `decide_query` режимы `filter` / `inspect` / `compare` — не прогонялись (хватило `aggregate`).
- `from_run`-воронка и полный аудит по `rubrics/code_review_and_logs.json` — отдельный прогон.
- OpenRouter-паритет — не проверялся (ключ не задан).

## Стоимость

| Прогон | Вызовов | Стоимость, ₽ |
|---|---|---|
| `decide_models` + `dry_run` | 0 сетевых | 0 |
| `decide_run` живой (`jev`, 6 файлов) | 1 | 0.49809215 |
| **Итого проверки инструментов** | | **0.49809215** `[PAID]` |
