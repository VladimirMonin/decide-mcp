/**
 * Тонкий MCP-сервер поверх `DecisionEngine` (stdio).
 *
 * Приоритет №1 MVP: три инструмента `decide_run`, `decide_query`,
 * `decide_models` (docs/architecture/contracts.md §3). Логики здесь нет:
 * сервер только валидирует параметры, вызывает фасад и упаковывает ответ.
 *
 * stdout зарезервирован под JSON-RPC: никаких `console.log`/`console.info`
 * в этом файле и в том, что он импортирует. Диагностика — только `console.error`.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { DecisionEngine, EngineError, type ModelsOutput } from "../core/engine.js";
import { QueryError } from "../core/query.js";
import { SourceError } from "../core/sources.js";
import { SystemOneProvider } from "../core/providers/systemone.js";
import {
  FILTER_FIELDS,
  PROJECTIONS,
  questionIdSchema,
  filterExprSchema,
  rubricSchema,
  sourceSchema,
} from "../core/schema.js";
import { MODEL_ALIASES, PROVIDER_NAMES } from "../core/types.js";

export const SERVER_NAME = "decide-mcp";
export const SERVER_VERSION = "0.1.0";

const MODEL_CHEATSHEET = [
  "Выбор модели:",
  "• gemini — широкий скрининг до 1000 элементов за вызов, окно 262K, ступени score до 255;",
  "• ms — короткие шаги и выбор инструмента, окно 32K, мягкий лимит ~150 вопросов;",
  "• jev — код и тексты, лучшая калибровка вероятностей, окно 64K, жёстко 2–10 ступеней score;",
  "• luna — длинные истории диалогов и крупные модули, окно 1.05M.",
].join(" ");

const RUN_DESCRIPTION = [
  "Оценивает источник decision-моделью, сохраняет все ответы в SQLite и возвращает",
  "компактную сводку и top_items (сырые данные агенту не отдаются).",
  "rubric — inline JSON-рубрика или путь к пресету внутри rubrics/.",
  "dry_run=true считает план батчей и токены, не вызывая API и не записывая прогон.",
  MODEL_CHEATSHEET,
].join(" ");

const QUERY_DESCRIPTION = [
  "Бесплатные запросы к сохранённому прогону:",
  "filter — элементы по FilterExpr с сортировкой и пагинацией;",
  "aggregate — распределения score/prob, счётчики choice и доли статусов;",
  "inspect — полные тексты до 20 item_id с context_window;",
  "compare — сравнение двух прогонов по общим item_id и question_id.",
  "where/sort_by/limit/offset применяются только к filter; для aggregate и compare они отклоняются, а не игнорируются молча.",
].join(" ");

const MODELS_DESCRIPTION = [
  "Паспорт доступных decision-моделей, активный шлюз, лимиты и пресеты рубрик.",
  "refresh_catalog пока не обновляет каталог: ядро отдаёт статический реестр моделей.",
  MODEL_CHEATSHEET,
].join(" ");

const sortBySchema = z.strictObject({
  question_id: questionIdSchema,
  field: z.enum(FILTER_FIELDS),
  order: z.enum(["asc", "desc"]).optional(),
});

export interface CreateDecideServerOptions {
  engine: DecisionEngine;
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown): CallToolResult {
  const known =
    error instanceof EngineError ||
    error instanceof SourceError ||
    error instanceof QueryError;
  const code = known ? error.code : "internal_error";
  const message = error instanceof Error ? error.message : String(error);
  if (!known) {
    // stderr разрешён для диагностики; stdout зарезервирован под JSON-RPC.
    // Ключи и тела запросов сюда не попадают — только текст исключения.
    console.error(`decide-mcp: internal_error: ${message.slice(0, 500)}`);
  }
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { code, message } }, null, 2),
      },
    ],
  };
}

/** Инструменты и их обработчики: единственный слой, который знает про engine. */
export function createDecideServer(
  options: CreateDecideServerOptions,
): McpServer {
  const { engine } = options;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "decide_run",
    {
      title: "Оценить источник decision-моделью",
      description: RUN_DESCRIPTION,
      inputSchema: {
        model: z.enum(MODEL_ALIASES).optional(),
        provider: z.enum(PROVIDER_NAMES).optional(),
        source: sourceSchema,
        scope: z.enum(["per_item", "whole"]).optional(),
        rubric: z.union([z.string().min(1), rubricSchema]),
        dry_run: z.boolean().optional(),
        return_top: z.number().int().min(1).max(50).optional(),
        sort_by: sortBySchema.optional(),
      },
    },
    async (args) => {
      try {
        return jsonResult(
          await engine.runDecision({
            model: args.model,
            provider: args.provider,
            source: args.source,
            scope: args.scope,
            rubric: args.rubric,
            dry_run: args.dry_run,
            return_top: args.return_top,
            sort_by:
              args.sort_by === undefined
                ? undefined
                : {
                    questionId: args.sort_by.question_id,
                    field: args.sort_by.field,
                    order: args.sort_by.order,
                  },
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "decide_query",
    {
      title: "Запросить сохранённый прогон",
      description: QUERY_DESCRIPTION,
      annotations: { readOnlyHint: true },
      inputSchema: {
        run_id: z.string().min(1),
        action: z.enum(["filter", "aggregate", "inspect", "compare"]),
        where: filterExprSchema.optional(),
        sort_by: sortBySchema.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
        compare_run_id: z.string().min(1).optional(),
        item_ids: z.array(z.string().min(1)).max(20).optional(),
        context_window: z.number().int().min(0).max(10).optional(),
        projection: z.enum(PROJECTIONS).optional(),
      },
    },
    async (args) => {
      try {
        if (args.action === "aggregate" || args.action === "compare") {
          const ignored = [
            args.where === undefined ? null : "where",
            args.sort_by === undefined ? null : "sort_by",
            args.limit === undefined ? null : "limit",
            args.offset === undefined ? null : "offset",
          ].filter((field): field is string => field !== null);
          if (ignored.length > 0) {
            throw new EngineError(
              "invalid_request",
              `Параметры ${ignored.join(", ")} не применяются к action=${args.action}`,
            );
          }
        }

        return jsonResult(
          await engine.queryRun({
            action: args.action,
            run_id: args.run_id,
            where: args.where,
            sort_by:
              args.sort_by === undefined
                ? undefined
                : {
                    questionId: args.sort_by.question_id,
                    field: args.sort_by.field,
                    order: args.sort_by.order,
                  },
            limit: args.limit,
            offset: args.offset,
            compare_run_id: args.compare_run_id,
            item_ids: args.item_ids,
            context_window: args.context_window,
            projection: args.projection,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "decide_models",
    {
      title: "Паспорт моделей и пресетов",
      description: MODELS_DESCRIPTION,
      annotations: { readOnlyHint: true },
      inputSchema: {
        refresh_catalog: z.boolean().optional().default(false),
      },
    },
    async (args) => {
      try {
        const models: ModelsOutput = engine.listModels();
        if (args.refresh_catalog) {
          return jsonResult({
            ...models,
            warnings: [
              "refresh_catalog пока не обновляет каталог: ядро отдаёт статический реестр моделей.",
            ],
          });
        }
        return jsonResult(models);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

/**
 * Боевой запуск: конфиг из `.env` (или `DECIDE_ENV_FILE`), провайдер Polza/
 * OpenRouter и stdio-транспорт. `DECIDE_ENV_FILE` позволяет подставить
 * тестовый env-файл, не читая рабочий `.env`.
 */
export async function main(): Promise<void> {
  const envFile = process.env["DECIDE_ENV_FILE"];
  const config = loadConfig(envFile === undefined ? {} : { envFile });

  const provider = new SystemOneProvider({
    name: config.provider.name,
    apiKey: config.provider.apiKey,
    decisionsUrl: config.provider.decisionsUrl,
    catalogUrl: config.provider.catalogUrl,
    timeoutMs: config.timeoutMs,
  });
  const engine = new DecisionEngine({ config, provider });
  const server = createDecideServer({ engine });

  server.server.onclose = () => {
    engine.close();
  };

  await server.connect(new StdioServerTransport());
  console.error(
    `decide-mcp: stdio готов, provider=${config.provider.name}, model=${config.defaultModel}`,
  );
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
