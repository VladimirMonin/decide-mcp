# 03. Провайдеры (Polza AI / OpenRouter), 4 модели и батчинг

## 1. Единый интерфейс провайдера (`DecisionProvider`)

Чтобы в будущем можно было подключить прямые API (OpenAI `/v1/decisions`, Google GenAI, TypeSafe AI) или локальные модели (`Clef-flash`, `Strands Decider 2B`) без переписывания ядра, все сетевые вызовы скрыты за одним интерфейсом:

```ts
export interface ProviderBatchRequest {
  modelAlias: ModelAlias;
  state: string;
  questions: Record<string, InternalQuestionPayload>;
  extraHeaders?: Record<string, string>;
}

export interface ProviderBatchResponse {
  answers: Record<string, NormalizedAnswer>;
  rawAnswers: Record<string, unknown>;
  usage: {
    inputTokens: number;
    outputTokens: number; // всегда 0 для decision-моделей
    costRub?: number;
    costUsd?: number;
  };
  latencyMs: number;
}

export interface DecisionProvider {
  readonly name: "polza" | "openrouter" | string;
  decide(req: ProviderBatchRequest): Promise<ProviderBatchResponse>;
  fetchCatalog(): Promise<CatalogModelInfo[]>;
}
```

В MVP оба стартовых шлюза (**Polza AI** и **OpenRouter**) обслуживает **один класс `SystemOneProvider`**, параметризованный профилем шлюза.

---

## 2. Сравнение и совместимость Polza AI и OpenRouter

Оба шлюза поддерживают единый протокол **System One** (`POST /api/v1/systemone`), что позволяет переключаться между ними сменой одной переменной окружения `DECIDE_PROVIDER`.

| Параметр | Polza AI (основной шлюз MVP) | OpenRouter (совместимый шлюз) |
| :--- | :--- | :--- |
| **Endpoint принятия решений** | `POST https://polza.ai/api/v1/systemone` | `POST https://openrouter.ai/api/v1/systemone` (также существует `POST /api/alpha/decisions`) |
| **Endpoint каталога моделей** | `GET https://polza.ai/api/v1/models/catalog` | `GET https://openrouter.ai/api/v1/models?output_modalities=decisions` |
| **Авторизация** | `Authorization: Bearer ${POLZA_API_KEY}` | `Authorization: Bearer ${OPENROUTER_API_KEY}` |
| **Дополнительные заголовки** | Не требуются (опционально `User-Agent`) | Опционально `HTTP-Referer`, `X-Title` |
| **Учёт стоимости в ответе** | `usage.cost_rub` (рубли) | `usage.cost` / расчёт по тарифу USD за 1M входных токенов |
| **Служебный overhead токенов** | **+280 токенов** к каждому запросу (документировано провайдером) | Учитывается единым резервом (`+280` безопасно оставлять для обоих) |
| **Типичная задержка прокси** | ~1 сек (закладывать таймаут `30s`) | ~0.3–1.0 сек |
| **Мультимодальность в MVP** | Отключена (в карточках Polza указан текстовый режим; проверяется на Шаге 0) | Доступна у части моделей, но в MVP v1 отключена флагом `supportsMedia: false` |

### Важный нюанс по формату `/api/v1/systemone`
* На входе передаются поля: `model`, `state` (текст/JSON), `questions` (словарь `{ question_id: { type, instructions, ... } }`).
* Внутренний тип `bool` адаптер `SystemOneProvider` всегда переводит в `"type": "noul"`.
* **`choice` и `score` на входе используют `criteria`, а не `options` / `levels`.** Адаптер переводит `choice.options` → `criteria` (словарь) и `score.levels` → `criteria` (массив). Запрос с внутренними именами отклоняется `HTTP 400 BAD_REQUEST` с путём `questions.<id>.criteria`.
* Ответ: `{ model, answers: { <question_id>: { type, noul | choice | score, confidence?, probabilities?, legend? } }, usage: { input_tokens, output_tokens, cost_rub } }`.
* `output_tokens` **не всегда 0**: в smoke 2026-11-22 `ms` вернула 3, `jev` — 69, `gemini` и `luna` — 0. `cost_rub` учитывает и выходные токены.
* `model` в ответе — версия с патчем или датой (`jev-1.14.0`, `google/gemini-decision-1-20261111`). Сохраняй ответившую строку как есть.

Фактический срез и стоимость: [Шаг 0 — smoke-тест](../verification/step0-smoke-2026-11-22.md).

---

## 3. Паспорт 4 стартовых моделей (`MODEL_REGISTRY`)

Все значения лимитов сверяются с живым каталогом Polza AI на Шаге 0 и при необходимости корректируются в конфиге без правки кода батчера.

| Параметр | `gemini` | `ms` | `jev` | `luna` |
| :--- | :--- | :--- | :--- | :--- |
| **ID на Polza AI** | `google/gemini-decision-1` | `microsoft/microsoft-decision-1` | `typesafe/jev` | `openai/gpt-6-luna-decisions` |
| **ID на OpenRouter** | `google/gemini-decision-1` | `microsoft/microsoft-decision-1` | `typesafe/jev-1.14` | `openai/gpt-6-luna-decisions` |
| **Окно на запрос (`per_request`)** | 262 144 токенов | 32 768 токенов | 64 000 токенов (до 262K с danger-заголовком) | 1 050 000 токенов* |
| **Окно на 1 вопрос (`per_question`)** | 262 144 токенов | 32 768 токенов | **32 000 токенов** (двойной лимит!) | 1 050 000 токенов* |
| **Макс. вопросов на запрос** | 256 (замер 2026-11-22; документация обещала 1 000) | Нет жёсткого числа (мягкий лимит в коде: 150) | 256 на Polza AI (в прямом API — по окну) | 200 (замер 2026-11-22; документация обещала 400) |
| **Лимит опций `choice`** | 2–255 (рек. ≤ 50) | По окну (рек. ≤ 50) | 2–255 (рек. ≤ 50) | До 64–255* (рек. ≤ 50) |
| **Лимит ступеней `score`** | 2–255 (рек. 2–10) | 2–10 | **Жёстко 2–10** | 2–10 |
| **Диапазон `noul` / `confidence`** | `noul` зажат в `[0.01, 0.99]`; `confidence` есть везде (`max(p, 1-p)` для `noul`) | `noul` `[0..1]`; обучена на явный отказ `cannot tell` | У `noul` нет отдельного `confidence` (считаем в адаптере); у `choice`/`score` есть | Нет поля `confidence` в нативном API (считаем в адаптере) |
| **Поведение safety-фильтра** | HTTP 400 валит весь батч | Зависит от шлюза (готовимся к HTTP 400) | HTTP 400 валит весь батч | В прямом API частичный `refusal`; через прокси проверяем на Шаге 0 |
| **Ориентир цены (вход / 1M)** | $0.10 (OR) | $0.042 (OR) | ~17 ₽ (Polza) / $0.042 (OR) | $0.10 (OR) |

*\*Обязательно проверить фактические `context_length` и потолок опций `choice` для `luna` на Polza AI в Шаге 0: на сторонних шлюзах иногда выставляется урезанный лимит (например, 65.5K контекста или 64 опции).

> Сверено с каталогом 2026-11-22: окна `gemini` 262144, `ms` 32768, `jev` 64000, `luna` 1050000 — совпали. Максимум опций `choice` и ступеней `score` каталог не отдаёт.
>
> **Фактический лимит вопросов (замеры 2026-11-22).** Шлюз отклоняет `HTTP 400 BAD_REQUEST` запросы с 400 вопросами у `gemini` («до 256 вопросов и 400 000 символов») и с 240 у `luna` («at most 200 questions»). Для одного вопроса на элемент это ≤256/≤200 элементов на запрос, для двух — ≤128/≤100. `MODEL_REGISTRY` синхронизирован 2026-11-23: **256** у `gemini` и **200** у `luna`; тест `registry.test.ts` проверяет, что план батча не превышает лимит. Детали: [benchmarks](../verification/benchmarks-2026-11-22.md).

### Специфические особенности моделей, которые учитывает ядро
1. **Алфавитная сортировка ключей `choice` в `gemini`:** перед отправкой в модель Google сортирует ключи вариантов по алфавиту. Заглушка `none_of_the_above` окажется первой и перетянет вероятности. Линтер рубрик предупреждает об этом и рекомендует ключ `other`.
2. **Обрезка `noul` в `gemini` до `[0.01, 0.99]`:** условия в фильтрах вида `prob > 0.99` или `prob < 0.01` никогда не сработают — пороги нужно держать внутри `(0.01, 0.99)`.
3. **Двойной потолок `jev`:** батчер проверяет оба ограничения — `tokens(state) + tokens(single_question) <= 32K` и `tokens(state) + sum(tokens(all_questions)) <= 64K`. Заголовок `TypeSafe-Danger-Zone-Long-Context: true` в MVP по умолчанию выключен (чуть снижает скорость и точность).
4. **Несопоставимость порогов между моделями:** вероятность `0.80` в `jev` и `0.80` в `gemini` или `ms` могут соответствовать разной строгости. При смене модели пороги отсечения нужно перекалибровывать через `decide_query` (`action: "compare"`).

---

## 4. Подсчёт токенов, упаковка батчей и отказоустойчивость

### Быстрая оценка токенов (`tokenizer.ts`)
Для MVP не подключаются тяжёлые бинарные токенизаторы. Используется консервативная оценка с запасом:
* Для текста с долей кириллицы/кода `> 20%`: `Math.ceil(chars / 2.2)`.
* Для преимущественно латиницы: `Math.ceil(chars / 3.0)`.
* К каждому запросу прибавляется служебный overhead **`+280` токенов**.
* Безопасный потолок окна для планировщика: **`Math.floor(context_window * 0.80)`** (20% буфер на JSON-обёртку и погрешность оценки).
* После ответа API в SQLite записываются реальные цифры из `usage.input_tokens`.
* Замеры 2026-11-22 на 100 реальных шагах (skeleton, кириллица/код, коэффициент 2.2): оценка выше фактического `input` на **+0.2%** (`luna`) … **+46.8%** (`ms`); латинский путь 3.0 не измерялся. Буфер 0.80 и overhead +280 остаются страховкой. Детали: [benchmarks](../verification/benchmarks-2026-11-22.md).

### Вынос общих правил (`guide`) в `state`
В матрице `100 элементов × 10 вопросов = 1 000 вопросов` повторение описания критерия на 150 токенов внутри каждого вопроса сожжёт 150 000 лишних токенов.
Поэтому батчер собирает `state` по шаблону:
```text
## Справочник правил оценки
<rubric.guide>

## Данные для оценки
[ITEM id="step_001"]
...
[/ITEM]
[ITEM id="step_002"]
...
[/ITEM]
```
А в `questions` генерируются короткие формулировки со ссылкой на конкретный `id`:
* Ключ вопроса в API: `${item_id}__${question_id}` (если `item_id` содержит спецсимволы, используется внутренний безопасный индекс `i0001__q01` с обратной таблицей соответствия).
* Текст `instructions`: `"Для элемента [step_001]: <question.instructions>"`.

### Алгоритм нарезки батчей (`batcher.ts`)
Для режима `scope: "per_item"`:
1. Вычисляем `questionsPerItem = Object.keys(rubric.questions).length`.
2. Вычисляем потолок элементов по числу вопросов: `maxItemsByCount = Math.floor(model.maxQuestions / questionsPerItem)`. Если `questionsPerItem > model.maxQuestions` — один элемент дробится по группам вопросов.
3. Жадно набираем элементы в текущий батч, пока выполняются три условия:
   * `batchItems.length < maxItemsByCount`;
   * `estTokens(guide + batchItems) + estTokens(allBatchQuestions) + 280 <= safeRequestLimit`;
   * `estTokens(guide + batchItems) + estTokens(maxSingleQuestion) + 280 <= safePerQuestionLimit`.
4. Если один одиночный элемент сам по себе не помещается в `safePerQuestionLimit`, он не добавляется в батч, а помечается в БД как `skipped_too_large`.
5. Батчи выполняются с ограниченным параллелизмом (`DECIDE_MAX_CONCURRENCY`, по умолчанию `4`).

### Политика повторов и бинарное деление при `HTTP 400`
* **`HTTP 429`, `502`, `503`, `504`, сетевой таймаут:** до 3 повторов с экспоненциальной задержкой (`1s`, `3s`, `7s` + случайный джиттер).
* **`HTTP 400` (`content_blocked` / `safety`):**
  * Если в батче `> 1` элемента — батч рекурсивно делится на две равные половины, и обе половины запускаются заново.
  * Когда в упавшем батче остаётся ровно `1` элемент — он записывается в SQLite со статусом `safety_blocked` (и никогда не подменяется вероятностью `0.01`).
  * Остальные элементы прогона завершаются штатно.

> Ошибка схемы приходит как `error.code=BAD_REQUEST`, `detail.error_type=bad_request`, а не как safety-блокировка. Такой 400 не делится и не ретраится: это ошибка контракта. Проверено 2026-11-22.

---

## 5. План расширения провайдеров и моделей (после MVP)

Благодаря интерфейсу `DecisionProvider` расширение не затрагивает ни MCP, ни SQLite, ни рубрики:
1. **Добавление новой модели на Polza AI / OpenRouter** (например, `liquid/d1`, `perplexity/pplx-decider-v1.2`, `cloudflare/clef-flash`, `parallel/decisions-fast`): достаточно дописать одну запись в `MODEL_REGISTRY`.
2. **Добавление прямого OpenAI (`POST /v1/decisions`):** новый класс `OpenAIDecisionsProvider`, который переводит `bool -> predicate`, словарь `questions` в массив с полем `name`, подключает `prompt_cache_key` (TTL 30 мин) и нативную передачу `function_call` / `function_call_output`.
3. **Добавление прямого Google GenAI (`gemini-decision-1`):** новый класс `GoogleDecisionProvider` с поддержкой нативных аудио, видео, PDF и параметра `media_resolution`.
4. **Добавление локального инференса (`Clef-flash`, `Strands Decider 2B`):** новый класс `LocalSystemOneProvider`, указывающий на локальный сервер (например, `http://localhost:8000/v1/systemone`).
