# 02. Контракты данных, JSON-схемы и интерфейсы MCP (`decide-mcp`)

Этот документ — единый источник правды для `zod`-валидации в `src/core/schema.ts` и описаний инструментов в `src/servers/mcp.ts`.

---

## 1. Единый внутренний стандарт рубрики (`Rubric`)

Агент всегда описывает рубрики во внутреннем нейтральном формате. Адаптер провайдера сам переводит имена примитивов под конкретный API (`bool -> noul` для `/api/v1/systemone`; в будущем `bool -> predicate` для прямого OpenAI).

```ts
export interface Rubric {
  /** Необязательное имя/версия для логов и сохранённых пресетов */
  name?: string;

  /**
   * Общий справочник правил и определений.
   * Движок вставляет его ОДИН РАЗ в шапку state/input, а не дублирует
   * в каждый вопрос матрицы N×M — это экономит тысячи входных токенов.
   */
  guide?: string;

  /** Словарь атомарных вопросов. Ключ = стабильный question_id (snake_case). */
  questions: Record<string, QuestionDef>;
}

export type QuestionDef =
  | BoolQuestion
  | ChoiceQuestion
  | ScoreQuestion
  | BoxQuestion; // зарезервирован, в текстовом MVP отклоняется с понятной ошибкой

export interface BoolQuestion {
  type: "bool";
  instructions: string;
  true_description?: string;
  false_description?: string;
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /**
   * Словарь { key: description }.
   * Минимум 2 варианта. Рекомендуется <= 50 вариантов (после ~50 калибровка падает).
   * Заглушку рекомендуется называть строго "other" (алфавитная сортировка в Gemini).
   */
  options: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /**
   * Упорядоченный массив ступеней от минимума (индекс 0) к максимуму (индекс N-1).
   * Минимум 2, жёстко рекомендовано <= 10 ступеней.
   * ВАЖНО: итоговый дробный балл score всегда усредняет индексы 0..N-1,
   * а не числа, написанные в строках levels.
   */
  levels: string[];
}

export interface BoxQuestion {
  type: "box";
  instructions: string;
  /** Требует поддержки медиа и Jev 1.14; в MVP v1 возвращает ошибку unsupported_in_mvp */
}
```

> Внутренние имена примитивов не равны провайдерским. Адаптер `/api/v1/systemone` переводит `bool` → `noul`, `choice.options` → `criteria` и `score.levels` → `criteria`. Внутренний контракт выше остаётся нейтральным; в запрос к провайдеру `options` и `levels` не уходят. Проверено 2026-11-22: запрос с `options`/`levels` получил `HTTP 400 BAD_REQUEST` по пути `questions.<id>.criteria`.

### Жёсткие правила валидации рубрики (`zod` + линтер)
* **Ошибки (блокируют запуск):**
  * пустой словарь `questions`;
  * некорректный `question_id` (разрешены `[a-zA-Z0-9_-]`, длина `1..64`);
  * `choice` с `< 2` или `> 255` опциями;
  * `score` с `< 2` ступенями или `> 10` ступенями для `jev` (у Jev потолок 10);
  * `type: "box"` в текстовом MVP.
* **Предупреждения (возвращаются в поле `warnings` ответа, не блокируют запуск):**
  * `choice` с `> 50` вариантами — предупреждение о деградации калибровки;
  * `score` с `> 10` ступенями на `gemini` — рекомендация Google держать `2..10`;
  * в `choice` на модели `gemini` присутствует ключ `none_of_the_above` или `none` (и нет `other`) — предупреждение об алфавитной сортировке ключей.

---

## 2. Формат источников данных (`Source`)

```ts
export type Source =
  | TextSource
  | FileSource
  | GlobSource
  | JsonlSource
  | FromRunSource;

export interface TextSource {
  type: "text";
  /** Один текст или массив поименованных фрагментов */
  items: Array<{ id: string; content: string; meta?: Record<string, unknown> }>;
}

export interface FileSource {
  type: "file";
  path: string;
  /** Опционально: разбить файл по строкам или оставить целиком */
  mode?: "whole" | "lines";
  max_lines?: number;
}

export interface GlobSource {
  type: "glob";
  pattern: string;              // например, "src/**/*.ts"
  ignore?: string[];            // дополняет базовый список (.git, node_modules, dist)
  max_files?: number;           // страховка по умолчанию: 500
}

export interface JsonlSource {
  type: "jsonl";
  path: string;
  /** Имя поля для стабильного item_id (если не указано — line_0001, line_0002...) */
  id_field?: string;
  /**
   * Проекция для сжатия длинных агентских сессий:
   * - "raw": исходная JSON-строка целиком
   * - "skeleton": step_id, роль, запрос/ответ, tool_name, аргументы, статус,
   *   метаданные reasoning (длина + первые/последние предложения + маркеры разворотов)
   * - "full": полный текст включая полное поле reasoning и выводы инструментов
   */
  projection?: "raw" | "skeleton" | "full";
  /** Включить Этап 0 (детерминированные теги повторов и длины reasoning) */
  prefilter_tags?: boolean;
  limit?: number;
  offset?: number;
}

export interface FromRunSource {
  type: "from_run";
  run_id: string;
  /** Структурированный фильтр по результатам родительского прогона */
  where: FilterExpr;
  /**
   * Подтянуть по N соседних элементов до и после каждого отобранного
   * (по seq_index). Пересекающиеся окна склеиваются в непрерывный эпизод,
   * но вопросы вешаются строго на целевые item_id.
   */
  context_window?: number;
  /** Проекция при догрузке исходных данных из файла (например, "full" на Этапе 2) */
  projection?: "raw" | "skeleton" | "full";
  limit?: number;
}
```

### Формат безопасных фильтров (`FilterExpr`)
Никакого сырого SQL — фильтры задаются декларативно и компилируются в параметризованный запрос:

```ts
export interface FilterCondition {
  question_id: string;
  field: "prob" | "score" | "choice" | "confidence";
  op: ">=" | ">" | "<=" | "<" | "=" | "!=" | "in";
  value: number | string | string[];
}

export interface FilterExpr {
  /** По умолчанию "and" */
  logic?: "and" | "or";
  conditions: FilterCondition[];
}
```

---

## 3. Контракты трёх MCP-инструментов

### Инструмент 1: `decide_run`
Выполняет оценку данных через выбранную decision-модель, сохраняет сырые вероятности в SQLite и возвращает компактную сводку.

**Вход (`DecideRunInput`):**
```json
{
  "model": "gemini",
  "provider": "polza",
  "source": {
    "type": "jsonl",
    "path": "logs/session_01.jsonl",
    "id_field": "step_id",
    "projection": "skeleton",
    "prefilter_tags": true
  },
  "scope": "per_item",
  "rubric": "rubrics/agent_funnel_stage1.json",
  "dry_run": false,
  "return_top": 15,
  "sort_by": {
    "question_id": "problem_score",
    "field": "score",
    "order": "desc"
  }
}
```
* `model`: алиас (`gemini` | `ms` | `jev` | `luna`) или явный ID модели (опционально — берётся `DECIDE_DEFAULT_MODEL`).
* `provider`: опционально (`polza` | `openrouter`), по умолчанию из `DECIDE_PROVIDER`.
* `scope`:
  * `"whole"` — все элементы источника склеиваются в один общий контекст, и вопросы рубрики задаются 1 раз к целому (например, аудит одного PR или сравнение набора файлов).
  * `"per_item"` — каждый элемент оценивается по всем вопросам рубрики. Если элементы помещаются вместе в общий `state` (как шаги одной сессии), движок упаковывает их в матрицу `N × M` с явными якорями `item_id` (экономия сетевых раундов и сохранение контекста соседних шагов); если элементы независимы и крупны (например, отдельные файлы кода), каждый файл оценивается в своём батче.
* `rubric`: либо inline-объект `Rubric`, либо относительный путь к JSON-файлу пресета в папке `rubrics/`.
* `dry_run`: если `true`, API не вызывается; возвращается точный план (число элементов, примерные токены, количество батчей, предупреждения).
* `return_top`: сколько лучших/худших записей вернуть агенту (по умолчанию `15`, максимум `50`, чтобы не забивать контекст агента).

**Выход (`DecideRunOutput`):**
```json
{
  "run_id": "run_20261122_221500_7f3a",
  "status": "completed",
  "dry_run": false,
  "provider": "polza",
  "model_alias": "gemini",
  "model_id": "google/gemini-decision-1",
  "stats": {
    "items_total": 1000,
    "items_processed": 998,
    "items_skipped": 1,
    "items_blocked": 1,
    "batches_total": 1,
    "input_tokens": 84320,
    "cost_rub": 7.12,
    "cost_usd": null,
    "duration_ms": 2340
  },
  "warnings": [],
  "summary": {
    "problem_score": {
      "type": "score",
      "min": 0.04,
      "avg": 0.62,
      "max": 3.88,
      "buckets": { "0..1": 740, "1..1.5": 115, "1.5..2.5": 98, "2.5..4": 45 }
    }
  },
  "top_items": [
    {
      "item_id": "step_0421",
      "preview": "tool=write_file error=PermissionError [repeat_tool=3, reasoning_toks=4200]",
      "answers": {
        "problem_score": {
          "type": "score",
          "score": 3.88,
          "confidence": 0.91,
          "probabilities": [0.0, 0.0, 0.02, 0.08, 0.90]
        }
      }
    }
  ]
}
```

---

### Инструмент 2: `decide_query`
Бесплатный просмотр, перефильтрация, агрегация и сравнение уже сохранённых прогонов в SQLite.

**Режимы (`action`):**
1. `"filter"` — вернуть список `item_id` и оценок по новому `FilterExpr` (с `sort_by`, `limit`, `offset`). Позволяет мгновенно подбирать пороги отсечения.
2. `"aggregate"` — вернуть распределения по вопросам (гистограммы `score`/`prob`, счётчики категорий `choice`, доли статусов `safety_blocked` / `skipped_too_large`).
3. `"inspect"` — вернуть полные исходные тексты (с диска или из кэша) для конкретного списка `item_ids` (максимум 20 за вызов) с опциональным `context_window: N`, чтобы агент-System-Two мог прочитать конкретные кейсы перед написанием правок.
4. `"compare"` — сравнить два прогона (`run_id` и `compare_run_id`) по общим `item_id` и `question_id`: показать среднее расхождение, количество совпадений и самые контрастные элементы (для калибровки моделей или сравнения до/после правки промпта).

**Пример вызова `decide_query`:**
```json
{
  "run_id": "run_20261122_221500_7f3a",
  "action": "filter",
  "where": {
    "logic": "and",
    "conditions": [
      { "question_id": "problem_score", "field": "score", "op": ">=", "value": 1.2 }
    ]
  },
  "sort_by": { "question_id": "problem_score", "field": "score", "order": "desc" },
  "limit": 20
}
```

---

### Инструмент 3: `decide_models`
Возвращает агенту актуальный паспорт доступных моделей, активный шлюз, лимиты окон и вопросов, а также список готовых JSON-рубрик из папки `rubrics/`.

**Вход:** `{ "refresh_catalog": false }` (при `true` делает живой запрос к каталогу активного провайдера).

**Выход:**
```json
{
  "active_provider": "polza",
  "default_model": "jev",
  "models": [
    {
      "alias": "gemini",
      "provider_model_id": "google/gemini-decision-1",
      "context_window": 262144,
      "max_questions_per_request": 1000,
      "max_score_levels": 10,
      "supports_media": false,
      "recommended_for": "Широкий скрининг до 1000 элементов за 1 вызов, Этап 1 воронки"
    }
  ],
  "presets": [
    "rubrics/code_review_and_logs.json",
    "rubrics/logs_triage.json",
    "rubrics/agent_funnel_stage1.json",
    "rubrics/agent_funnel_stage2.json",
    "rubrics/agent_funnel_stage3.json"
  ]
}
```

---

## 4. Нормализованный формат ответа и коды ошибок

Независимо от того, какая модель и какой шлюз ответили, ядро нормализует каждый ответ в единый вид:

```ts
export interface NormalizedAnswer {
  type: "bool" | "choice" | "score";
  status: "ok" | "refusal" | "safety_blocked" | "error";
  /** Для bool: вероятность истинности [0..1] */
  prob?: number;
  /** Для score: взвешенное среднее индексов уровней */
  score?: number;
  /** Для choice: ключ победившего варианта */
  choice?: string;
  /**
   * Нормализованная уверенность [0..1]:
   * - Если модель вернула confidence — используется оно.
   * - Для bool без поля confidence (Jev, MS): max(prob, 1 - prob).
   * - Для choice/score без поля confidence: разница между top-1 и top-2 вероятностью (margin) или top-1 prob (помечается в meta).
   * - Smoke 2026-11-22: confidence был у всех типов Gemini и Luna; у MS и Jev — у choice/score, но не у noul.
   */
  confidence: number;
  probabilities?: Record<string, number> | number[];
}
```

### Стандартные коды ошибок ядра
| Код | Значение | Реакция движка |
| :--- | :--- | :--- |
| `invalid_rubric` | Ошибка `zod`-валидации рубрики | Немедленный возврат ошибки с указанием поля |
| `path_outside_root` | Попытка чтения за пределами `DECIDE_ALLOWED_ROOT` | Блокировка запроса |
| `unsupported_in_mvp` | Попытка использовать `box` или медиа-вложения в v1 | Понятная ошибка без вызова API |
| `skipped_too_large` | Один элемент + вопросы не влезает в `per_question_context` | Элемент пропускается, остальные обрабатываются |
| `safety_blocked` | `HTTP 400` (`content_blocked` / `safety`) на элементе после бинарного деления | Изолируется конкретный элемент; не путается с `prob = 0.01` |
| `refusal` | Частичный отказ модели по одному вопросу (`type: "refusal"`) | Сохраняется на уровне конкретного ответа |
| `rate_limited` | `HTTP 429` после исчерпания ретраев | Статус прогона `partial`, уже полученные батчи сохранены в SQLite |
| `provider_error` | Сетевой сбой / `5xx` после ретраев | Статус прогона `partial` или `failed`, детали в `error_summary` |

> **HTTP 400 бывает двух видов.** Ошибка схемы или контракта приходит как `error.code=BAD_REQUEST` / `detail.error_type=bad_request`; её нельзя делить и ретраить как токсичный элемент — это дефект запроса. Бинарное деление и статус `safety_blocked` применяются только к `content_blocked` / `safety`. Ответ `model` содержит версию с датой или патчем (`jev-1.14.0`), её нужно сохранять для аудита.
