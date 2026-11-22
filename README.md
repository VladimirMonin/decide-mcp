# decide-mcp — Универсальный MCP-инструмент анализа на Decision-моделях (MVP)

Универсальный движок на TypeScript для массового анализа кода, логов, тестов и многошаговых агентских сессий с помощью моделей принятия решений (**System One / Decision Models**).

Работает через единый стандартный протокол `POST /api/v1/systemone` с поддержкой двух шлюзов:
* **Polza AI** (основной шлюз MVP для работы из РФ);
* **OpenRouter** (полная совместимость переключением конфигурации).

Главная идея архитектуры: **данные с диска не проходят через контекст основного агента**. Агент передаёт путь к файлам (или `run_id` прошлого прогона), имя модели и JSON-рубрику. Ядро само читает данные, режет их на безопасные батчи, запрашивает decision-модель, сохраняет сырые вероятности в локальный файл SQLite и возвращает агенту только короткую сводку и топ находок.

---

## Стартовые модели MVP

| Алиас | ID на Polza AI | ID на OpenRouter | Окно контекста | Лимит вопросов | Основное применение |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `gemini` | `google/gemini-decision-1` | `google/gemini-decision-1` | 262K | до 1 000 | Широкий скрининг (до 1 000 элементов за 1 вызов), первый этап воронок |
| `ms` | `microsoft/microsoft-decision-1` | `microsoft/microsoft-decision-1` | 33K (32 768) | в рамках окна (мягкий лимит ~150) | Локальная проверка коротких шагов, вызовы инструментов (When2Call) |
| `jev` | `typesafe/jev` | `typesafe/jev-1.14` | 64K (до 262K) | до 256 на Polza AI | Базовая рабочая модель для кода и текстов, лучшая калибровка вероятностей |
| `luna` | `openai/gpt-6-luna-decisions` | `openai/gpt-6-luna-decisions` | до 1,05M* | до 400 | Длинные истории диалогов и крупные модули |

*\*Точный `context_length` на прокси Polza AI проверяется и фиксируется на Шаге 0 через `GET /api/v1/models/catalog`.*

---

## Структура пакета документации

```text
decide-core/
├── README.md                          # Быстрый старт, .env и подключение MCP
├── AGENTS.md                          # Инженерный вход для coding-агента
├── docs/
│   ├── README.md                      # Навигация по документации
│   ├── architecture/
│   │   ├── system.md                  # Слои системы, потоки данных, SQLite, безопасность
│   │   ├── contracts.md               # Единый формат рубрик, источники, контракты MCP
│   │   └── providers-and-models.md    # Polza AI, OpenRouter, реестр моделей, батчинг
│   ├── foundation/
│   │   ├── observability-policy.md    # Политика логирования и наблюдаемости
│   │   └── testing-strategy.md        # Стратегия тестирования
│   ├── instructions/
│   │   ├── logging.md                 # Как добавить и проверить событие диагностики
│   │   └── testing.md                 # Как выбрать, изолировать и запустить проверку
│   ├── plans/
│   │   └── mvp-scope.md               # План реализации от Шага 0 до готовности MVP
│   └── guides/ru/
│       ├── rubrics-and-funnels.md     # Правила составления рубрик и 4-этапная воронка
│       └── cookbook-use-cases.md      # Базовые и продвинутые кейсы по гайдам разработчиков
└── rubrics/
    ├── code_review_and_logs.json      # Аудит кода, логирования и тестов
    ├── logs_triage.json               # Быстрый триаж логов и ошибок
    ├── agent_funnel_stage1.json       # Этап 1 воронки: скрининг скелета сессии
    ├── agent_funnel_stage2.json       # Этап 2 воронки: диагностика с полным reasoning
    └── agent_funnel_stage3.json       # Этап 3 воронки: кластеризация первопричин
```

---

## Требования и установка

* **Node.js 22.5+** (используется встроенный `fetch` и встроенный `node:sqlite`, внешние C++ драйверы БД не требуются).
* **TypeScript 5.x**
* Минимальный набор зависимостей: `@modelcontextprotocol/sdk`, `zod`, `fast-glob` (для чтения масок файлов).

```powershell
# Установка зависимостей
npm install

# Сборка TypeScript
npm run build
```

---

## Конфигурация (`.env`)

Создайте файл `.env` в корне проекта (не коммитить в Git):

```env
# Активный провайдер по умолчанию: polza | openrouter
DECIDE_PROVIDER=polza

# Ключи доступа
POLZA_API_KEY=your_polza_api_key_here
OPENROUTER_API_KEY=your_openrouter_api_key_here

# Опционально: переопределение базовых URL
POLZA_BASE_URL=https://polza.ai/api/v1
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# Модель по умолчанию (алиас из MODEL_REGISTRY: jev | gemini | ms | luna)
DECIDE_DEFAULT_MODEL=jev

# Ограничения и хранение
DECIDE_DB_PATH=.decide-mcp/runs.sqlite
DECIDE_ALLOWED_ROOT=.
DECIDE_MAX_CONCURRENCY=4
DECIDE_TIMEOUT_MS=30000
```

---

## Запуск и проверка

### 1. Разведка боем (Шаг 0 — smoke-test)
Перед первым запуском MCP-сервера проверьте живые ответы всех четырёх моделей и актуальный каталог лимитов:

```powershell
# Проверка через Polza AI
$env:DECIDE_PROVIDER="polza"
npm run smoke

# Проверка через OpenRouter
$env:DECIDE_PROVIDER="openrouter"
npm run smoke
```

### 2. Запуск MCP-сервера (stdio)

```powershell
npm run start:mcp
```

### 3. Подключение в MCP-клиенте

Пример секции `mcpServers` (путь укажите под вашу машину на Windows):

```json
{
  "mcpServers": {
    "decide-mcp": {
      "command": "node",
      "args": ["C:/projects/decide-mcp/dist/servers/mcp.js"],
      "env": {
        "DECIDE_PROVIDER": "polza",
        "POLZA_API_KEY": "your_polza_api_key_here",
        "DECIDE_DB_PATH": "C:/projects/decide-mcp/.decide-mcp/runs.sqlite",
        "DECIDE_ALLOWED_ROOT": "C:/projects"
      }
    }
  }
}
```

---

## Порядок чтения документации

1. **Понять границы системы и схему БД:** `docs/architecture/system.md`
2. **Посмотреть точные JSON-схемы и MCP-инструменты:** `docs/architecture/contracts.md`
3. **Настроить Polza AI / OpenRouter, лимиты и батчер:** `docs/architecture/providers-and-models.md`
4. **Научиться писать точные рубрики и собирать воронки:** `docs/guides/ru/rubrics-and-funnels.md`
5. **Изучить проверенные паттерны и кукбуки вендоров:** `docs/guides/ru/cookbook-use-cases.md`
6. **Свериться с чек-листом реализации MVP:** `docs/plans/mvp-scope.md`
7. **Понять правила логирования и тестирования:** `docs/foundation/observability-policy.md`, `docs/foundation/testing-strategy.md`
8. **Добавить событие диагностики или проверку:** `docs/instructions/logging.md`, `docs/instructions/testing.md`
