# 01. Архитектура системы и схема хранения (`decide-mcp`)

## 1. Назначение и базовый принцип

`decide-mcp` — это универсальный движок оценки и фильтрации произвольных данных (исходный код, тесты, логи приложений, многошаговые траектории агентов) с использованием **System One (decision) моделей**.

Главный архитектурный принцип: **данные не проходят через контекст основного рассуждающего агента (System Two)**.
* Основной агент формулирует только задачу: указывает путь к источнику данных на диске (или `run_id` предыдущего прогона), выбирает модель и передаёт JSON-рубрику.
* Ядро самостоятельно читает данные, нормализует их, режет на батчи, опрашивает decision-модель, сохраняет все сырые вероятности в локальный файл SQLite и возвращает агенту компактную сводку + ограниченный список топ-находок.
* Для повторной фильтрации, смены порогов и выгрузки конкретных фрагментов агент использует бесплатные локальные запросы к SQLite (`decide_query`), не расходуя контекст и не повторяя сетевые вызовы.

---

## 2. Слоистая архитектура и структура проекта

Проект разделён на независимое ядро на TypeScript и тонкие обёртки. Бизнес-логика не должна протекать в слой MCP или будущего расширения для Pi.

```text
decide-mcp/
├── src/
│   ├── core/                        # Независимое ядро (0 импортов из MCP / Pi)
│   │   ├── schema.ts                # Zod-схемы рубрик, источников, запросов и ответов
│   │   ├── registry.ts              # MODEL_REGISTRY: 4 стартовые модели, лимиты, алиасы
│   │   ├── sources.ts               # Читалки: text, file, glob, jsonl, from_run
│   │   ├── prefilter.ts             # Этап 0: детерминированные метрики для jsonl/кода
│   │   ├── tokenizer.ts             # Быстрая оценка токенов + служебный overhead (+280) + запас 20%
│   │   ├── batcher.ts               # Упаковка N×M матриц, параллелизм, бинарное деление при HTTP 400
│   │   ├── store.ts                 # Работа с SQLite через встроенный node:sqlite
│   │   ├── query.ts                 # Безопасный движок срезов/фильтров/агрегаций поверх SQLite
│   │   ├── engine.ts                # Фасад: runDecision(), queryRun(), listModels()
│   │   └── providers/
│   │       ├── types.ts             # Интерфейс DecisionProvider
│   │       └── systemone.ts         # Единая реализация для Polza AI и OpenRouter
│   ├── servers/
│   │   └── mcp.ts                   # Приоритет 1: тонкий MCP-сервер (stdio, 3 инструмента)
│   ├── cli/
│   │   ├── smoke.ts                 # Шаг 0: проверка 4 моделей и каталога
│   │   └── decide.ts                # Опциональный тонкий CLI для ручного запуска
│   └── pi-extension/                # Приоритет 2 (после MVP): обёртка под Pi с UI прогресса
├── rubrics/                         # Готовые JSON-примеры рубрик для агента
├── fixtures/                        # Сохранённые реальные ответы API с Шага 0
└── docs/                            # Архитектурная документация
```

### Границы ответственности модулей `core/`

| Модуль | Ответственность |
| :--- | :--- |
| `schema.ts` | Валидация всех входных JSON-контрактов, нормализация внутренних примитивов (`bool`, `choice`, `score`, резерв `box`), выдача предупреждений (например, `> 50` опций в `choice`, `> 10` ступеней в `score`). |
| `registry.ts` | Хранение паспортов моделей (`gemini`, `ms`, `jev`, `luna`), маппинг алиасов на ID конкретных шлюзов (`polza` / `openrouter`), лимиты окон и количества вопросов. |
| `sources.ts` | Безопасное чтение данных с диска в единый массив `SourceItem[]`. Поддерживает проекции для JSONL (`skeleton` и `full`), а также подтягивание соседних шагов (`context_window`) при работе с `from_run`. |
| `prefilter.ts` | Опциональный детерминированный проход до API: подсчёт длины `reasoning`, детекция самоповторов по n-граммам, подсчёт повторных вызовов одного инструмента с одинаковыми аргументами, невалидного JSON. Добавляет короткие теги в `skeleton`. |
| `batcher.ts` | Разбиение элементов и вопросов по 2D-бюджету (`Элементы × Вопросы <= Лимит` и `Токены <= Окно`). Вынос общего `guide` в `state` один раз. Управление пулом параллельных запросов (`DECIDE_MAX_CONCURRENCY`) и бинарное деление батча пополам при `HTTP 400`. |
| `providers/systemone.ts` | HTTP-клиент к `POST /api/v1/systemone` и каталогу моделей. Маппинг внутреннего `bool -> noul`, ретраи с экспоненциальной задержкой на `429 / 502 / 504`, нормализация `confidence` и учёт стоимости (`cost_rub` / USD). |
| `store.ts` | Инициализация схемы БД, потоковая запись результатов по мере завершения батчей (чтобы не терять прогресс при сетевом обрыве), чтение для `query.ts` и `from_run`. |
| `engine.ts` | Единый программный API ядра. MCP-сервер и будущий Pi-плагин вызывают только методы `engine.ts`. |

---

## 3. Три основных потока данных

### Поток A: Прогон оценки (`decide_run`)
1. Агент передаёт `model`, `source`, `scope`, `rubric` (inline JSON или путь к пресету), `dry_run`, `return_top`.
2. `sources.ts` материализует `SourceItem[]` и проверяет безопасность путей.
3. `batcher.ts` рассчитывает план батчей (количество элементов, примерные токены, число HTTP-вызовов). Если `dry_run: true` — план возвращается сразу без сетевых запросов и записи в БД.
4. `store.ts` создаёт запись в таблице `runs` со статусом `running` и сохраняет `items`.
5. `batcher.ts` прогоняет батчи через `DecisionProvider`, сохраняя ответы в `answers` после каждого батча.
6. При `HTTP 400` (`safety` / `content_blocked`) батч автоматически делится пополам до изоляции проблемного элемента, которому ставится статус `safety_blocked`.
7. `store.ts` обновляет статус прогона (`completed` / `partial`), суммирует токены и стоимость.
8. `engine.ts` возвращает агенту компактную сводку: `run_id`, статистику, распределения и `return_top` лучших/худших записей.

### Поток B: Бесплатный анализ результатов (`decide_query`)
1. Агент передаёт `run_id` и режим запроса (`filter`, `aggregate`, `inspect`, `compare`).
2. `query.ts` выполняет параметризованный SQL-запрос к локальному SQLite (без произвольного сырого SQL от агента).
3. Агент получает пересчитанный срез, новые пороги отсечения, распределение категорий или полные тексты выбранных элементов вместе с соседними шагами.

### Поток C: Многоэтапная воронка (`from_run`)
1. На Этапе 1 `decide_run` прогоняет 1 000 записей JSONL в проекции `skeleton` (сжатый вид + теги префильтра) с 1 вопросом `score`.
2. На Этапе 2 `decide_run` получает `source: { type: "from_run", run_id: "...", where: { conditions: [{ question_id: "problem_score", field: "score", op: ">=", value: 1.5 }] }, context_window: 2, projection: "full" }`.
3. `sources.ts` забирает отфильтрованные `item_id` из SQLite, догружает для них полные записи (включая полный `reasoning`) и склеивает пересекающиеся окна соседей в непрерывные эпизоды, вешая вопросы только на целевые `item_id`.
4. На Этапе 3 аналогично отбираются подтверждённые сбои для таксономической классификации первопричин.
5. На Этапе 4 сам агент через `decide_query` забирает агрегированную статистику и 3–5 показательных примеров на каждую категорию.

---

## 4. Схема локальной БД SQLite (`node:sqlite`)

База хранится в одном файле (по умолчанию `.decide-mcp/runs.sqlite`) с включённым режимом `PRAGMA journal_mode = WAL;` для безопасной конкурентной записи батчей.

```sql
CREATE TABLE IF NOT EXISTS runs (
  run_id            TEXT PRIMARY KEY,          -- например, run_20261122_184500_a1b2
  created_at        TEXT NOT NULL,             -- ISO 8601 UTC
  finished_at       TEXT,                      -- ISO 8601 UTC, когда прогон получил терминальный статус
  status            TEXT NOT NULL,             -- running | completed | partial | failed
  provider          TEXT NOT NULL,             -- polza | openrouter
  model_alias       TEXT NOT NULL,             -- gemini | ms | jev | luna
  model_id          TEXT NOT NULL,             -- фактический ID модели на шлюзе
  response_model    TEXT,                      -- версия ответившей модели (jev-1.14.0, …-20261111) для аудита
  scope             TEXT NOT NULL,             -- whole | per_item
  source_json       TEXT NOT NULL,             -- исходное описание source
  rubric_json       TEXT NOT NULL,             -- валидированная рубрика
  parent_run_id     TEXT,                      -- ссылка на родительский прогон (для from_run)
  items_total       INTEGER NOT NULL DEFAULT 0,
  items_processed   INTEGER NOT NULL DEFAULT 0,
  items_skipped     INTEGER NOT NULL DEFAULT 0,
  items_blocked     INTEGER NOT NULL DEFAULT 0,
  batches_total     INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_rub          REAL,                      -- заполняется для Polza AI
  cost_usd          REAL,                      -- заполняется для OpenRouter
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  error_summary     TEXT
);

CREATE TABLE IF NOT EXISTS items (
  run_id            TEXT NOT NULL,
  item_id           TEXT NOT NULL,             -- путь файла, step_042, line_105 и т.д.
  seq_index         INTEGER NOT NULL,          -- порядковый номер (нужен для context_window)
  source_ref        TEXT,                      -- путь к исходному файлу / смещение
  meta_json         TEXT,                      -- метаданные (токены reasoning, repeat_tool и т.д.)
  preview           TEXT,                      -- короткий сниппет до 300 символов для сводки
  content_hash      TEXT NOT NULL,             -- SHA-256 контента
  status            TEXT NOT NULL,             -- pending | ok | skipped_too_large | safety_blocked | error
  error_code        TEXT,
  PRIMARY KEY (run_id, item_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS answers (
  run_id            TEXT NOT NULL,
  item_id           TEXT NOT NULL,
  question_id       TEXT NOT NULL,             -- ключ вопроса из рубрики
  primitive_type    TEXT NOT NULL,             -- bool | choice | score | box
  prob              REAL,                      -- для bool: вероятность [0..1]
  score_value       REAL,                      -- для score: взвешенное среднее индексов
  choice_value      TEXT,                      -- для choice: ключ-победитель
  confidence        REAL NOT NULL,             -- нормализованная уверенность [0..1] всегда есть
  confidence_source TEXT NOT NULL,             -- provider | max_prob | margin | top1 | none
  probabilities_json TEXT,                     -- сырой словарь/массив вероятностей
  answer_json       TEXT NOT NULL,             -- нормализованный ответ целиком (NormalizedAnswer)
  raw_answer_json   TEXT,                      -- пока всегда NULL: батчер отдаёт только нормализованные ответы
  status            TEXT NOT NULL DEFAULT 'ok',-- ok | refusal | safety_blocked | error
  trace_id          TEXT,                      -- trace_id шлюза из тела ошибки (аудит)
  PRIMARY KEY (run_id, item_id, question_id),
  FOREIGN KEY (run_id, item_id) REFERENCES items(run_id, item_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_run_seq ON items(run_id, seq_index);
CREATE INDEX IF NOT EXISTS idx_answers_run_q_score ON answers(run_id, question_id, score_value);
CREATE INDEX IF NOT EXISTS idx_answers_run_q_prob ON answers(run_id, question_id, prob);
CREATE INDEX IF NOT EXISTS idx_answers_run_q_choice ON answers(run_id, question_id, choice_value);
```

> Схема — источник правды для `store.ts`. `answer_json` хранит нормализованный `NormalizedAnswer` (включая `confidenceSource`), `raw_answer_json` оставлена под будущий проброс сырых ответов и пока всегда `NULL`: батчер отдаёт только нормализованные ответы. `context_window` у `from_run` и `inspect` ограничен 10 соседями, а `from_run` сверяет `content_hash` перезагруженного текста с сохранённым и помечает изменившийся источник в `meta.sourceChanged`.

### Зачем хранить сырые вероятности (`prob`, `score_value`, `probabilities_json`)
* **Бесплатная калибровка порогов:** пересчитать, какие шаги попадут в отбор при пороге `1.2` вместо `1.5`, без повторного вызова API.
* **Обработка неровных шкал `score`:** всегда можно достать индекс с максимальной вероятностью из `probabilities_json`.
* **Воспроизводимость и сравнение моделей:** легко сравнить распределение ответов `jev` против `gemini` или `ms` на одном и том же наборе `items`.

---

## 5. Ограничения безопасности

1. **Изоляция файловой системы (`DECIDE_ALLOWED_ROOT`):** любой путь в `source` (`file`, `glob`, `jsonl`) нормализуется через `path.resolve()` и проверяется на нахождение строго внутри `DECIDE_ALLOWED_ROOT`. Попытка чтения `../../` или системных файлов отклоняется ошибкой `path_outside_root`.
2. **Автоисключение мусора:** при `glob` всегда применяются базовые исключения: `.git/**`, `node_modules/**`, `dist/**`, `build/**`, `.venv/**`, `*.lock`, бинарные файлы (проверка на null-байты в первых 8 КБ).
3. **Защита от переполнения одним файлом:** элемент, размер которого вместе с вопросами превышает `per_question_context` выбранной модели, не роняет весь прогон — он фиксируется со статусом `skipped_too_large` (в будущих версиях — опциональный чанкинг с перекрытием).
4. **Защита от Prompt Injection в недоверенных данных:** decision-модели работают за один прямой проход без цепочки рассуждений, поэтому враждебный текст внутри оцениваемого лога или кода может сместить логиты вероятностей. `decide-mcp` позиционируется строго как **инструмент анализа, фильтрации и маршрутизации** — его выходные вероятности никогда не должны автоматически запускать необратимые действия (удаление данных, финансовые списания, деплой) без подтверждения System Two или человека.
5. **Отсутствие сырого SQL в MCP:** `decide_query` принимает только структурированный объект фильтров (`where`), который компилируется в параметризованные SQL-запросы через белый список полей и операторов.

### Известные ограничения (осознанно отложено)

* **`from_run` дублирует текст эпизода** на каждый целевой `item_id` в окне: при плотных целях контент растёт квадратично. Лечится per-item набором вопросов в батчере.
* **`INSERT OR REPLACE` ответов** может каскадно переписывать связанные строки при повторной записи; побочный эффект ограничен ключом `(run_id, item_id, question_id)`.
* **Имена `sort_by`** различаются: снаружи MCP — `question_id`, внутри ядра — `questionId`; маппинг делает сервер.
* **Проверка путей не защищает от hardlink/TOCTOU**: между `realpath` и чтением файл может быть подменён; для MVP это принято.
* **Мелочи:** код `unsupported_source` объявлен, но не используется; суффикс `createRunId` — 4 случайных hex-символа без проверки коллизий.
