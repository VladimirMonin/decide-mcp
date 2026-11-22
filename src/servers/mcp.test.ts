import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createDecideServer, SERVER_NAME } from "./mcp.js";
import type { AppConfig } from "../core/config.js";
import { DecisionEngine } from "../core/engine.js";
import type {
  CatalogModelInfo,
  DecisionProvider,
  NormalizedAnswer,
  ProviderBatchRequest,
  ProviderBatchResponse,
} from "../core/providers/types.js";
import type { QuestionDef } from "../core/schema.js";

interface ToolContent {
  type: string;
  text?: string;
}

interface ToolResponse {
  content: ToolContent[];
  isError?: boolean;
}

function textOf(result: ToolResponse): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function jsonOf(result: ToolResponse): unknown {
  return JSON.parse(textOf(result));
}

function makeConfig(root: string): AppConfig {
  return {
    provider: {
      name: "polza",
      apiKey: "stub-key",
      baseUrl: "https://example.test/api/v1",
      decisionsUrl: "https://example.test/api/v1/systemone",
      catalogUrl: "https://example.test/api/v1/models/catalog",
    },
    defaultModel: "ms",
    dbPath: path.join(root, "runs.sqlite"),
    allowedRoot: root,
    maxConcurrency: 2,
    timeoutMs: 5_000,
  };
}

const RUBRIC = {
  name: "mcp_test",
  questions: {
    quality: {
      type: "score",
      instructions: "Насколько фрагмент понятен?",
      levels: ["плохо", "средне", "хорошо"],
    },
    is_code: { type: "bool", instructions: "Это программный код?" },
  },
};

function answerFor(question: QuestionDef): NormalizedAnswer {
  if (question.type === "score") {
    return {
      type: "score",
      status: "ok",
      score: 1.5,
      confidence: 0.9,
      confidenceSource: "provider",
      probabilities: [0.1, 0.2, 0.7],
    };
  }
  return {
    type: "bool",
    status: "ok",
    prob: 0.8,
    confidence: 0.8,
    confidenceSource: "max_prob",
  };
}

function okayResponse(request: ProviderBatchRequest): ProviderBatchResponse {
  const answers: Record<string, NormalizedAnswer> = {};
  for (const [key, question] of Object.entries(request.questions)) {
    answers[key] = answerFor(question);
  }
  return {
    answers,
    rawAnswers: {},
    usage: { inputTokens: 100, outputTokens: 2, costRub: 0.001 },
    latencyMs: 1,
    responseModel: "stub-1.0",
  };
}

class StubProvider implements DecisionProvider {
  readonly name = "polza";
  readonly calls: ProviderBatchRequest[] = [];

  constructor(
    private readonly handler: (
      request: ProviderBatchRequest,
    ) => Promise<ProviderBatchResponse> | ProviderBatchResponse = okayResponse,
  ) {}

  async decide(request: ProviderBatchRequest): Promise<ProviderBatchResponse> {
    this.calls.push(request);
    return this.handler(request);
  }

  async fetchCatalog(): Promise<CatalogModelInfo[]> {
    return [];
  }
}

interface Harness {
  client: Client;
  engine: DecisionEngine;
  provider: StubProvider;
  config: AppConfig;
  root: string;
  close(): Promise<void>;
}

async function startHarness(
  provider?: StubProvider,
  engineOverride?: DecisionEngine,
): Promise<Harness> {
  const root = mkdtempSync(path.join(tmpdir(), "decide-mcp-"));
  const config = makeConfig(root);
  const stub = provider ?? new StubProvider();
  const engine = engineOverride ?? new DecisionEngine({ config, provider: stub });
  const server = createDecideServer({ engine });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "decide-mcp-test", version: "0.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    engine,
    provider: stub,
    config,
    root,
    async close() {
      await client.close();
      await server.close();
      engine.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("tools/list отдаёт три инструмента с описаниями и схемами", async () => {
  const harness = await startHarness();
  try {
    const listed = await harness.client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["decide_models", "decide_query", "decide_run"],
    );

    const run = listed.tools.find((tool) => tool.name === "decide_run");
    assert.ok(run);
    assert.match(run.description ?? "", /gemini/);
    assert.match(run.description ?? "", /luna/);
    const runProperties = (run.inputSchema as {
      properties?: Record<string, unknown>;
    }).properties;
    for (const field of [
      "model",
      "source",
      "rubric",
      "dry_run",
      "return_top",
      "sort_by",
    ]) {
      assert.ok(runProperties?.[field], `нет поля ${field}`);
    }

    const query = listed.tools.find((tool) => tool.name === "decide_query");
    assert.ok(query);
    const queryProperties = (query.inputSchema as {
      properties?: Record<string, unknown>;
    }).properties;
    for (const field of ["run_id", "action", "where", "compare_run_id", "item_ids"]) {
      assert.ok(queryProperties?.[field], `нет поля ${field}`);
    }

    const models = listed.tools.find((tool) => tool.name === "decide_models");
    assert.ok(models);
    assert.match(models.description ?? "", /пресет/i);
  } finally {
    await harness.close();
  }
});

test("decide_run с dry_run не зовёт провайдера и не создаёт БД", async () => {
  const provider = new StubProvider(() => {
    throw new Error("dry_run не должен ходить в сеть");
  });
  const harness = await startHarness(provider);
  try {
    const response = (await harness.client.callTool({
      name: "decide_run",
      arguments: {
        source: {
          type: "text",
          items: [
            { id: "a", content: "function add(a, b) { return a + b; }" },
            { id: "b", content: "просто текст" },
          ],
        },
        rubric: RUBRIC,
        dry_run: true,
        return_top: 5,
      },
    })) as unknown as ToolResponse;

    assert.ok(!response.isError);
    const result = jsonOf(response) as {
      status: string;
      dry_run: boolean;
      run_id: string | null;
      plan?: { batches: number; estimated_tokens: number };
      stats: { items_total: number; batches_total: number };
    };
    assert.equal(result.status, "dry_run");
    assert.equal(result.dry_run, true);
    assert.equal(result.run_id, null);
    assert.equal(result.stats.items_total, 2);
    assert.equal(result.plan?.batches, 1);
    assert.ok((result.plan?.estimated_tokens ?? 0) > 0);
    assert.equal(provider.calls.length, 0);
    assert.equal(existsSync(harness.config.dbPath), false);

    // Пресет по имени файла тоже проходит через сервер.
    const preset = (await harness.client.callTool({
      name: "decide_run",
      arguments: {
        source: { type: "text", items: [{ id: "a", content: "x" }] },
        rubric: "logs_triage.json",
        dry_run: true,
      },
    })) as unknown as ToolResponse;
    assert.ok(!preset.isError);
    assert.equal((jsonOf(preset) as { status: string }).status, "dry_run");
  } finally {
    await harness.close();
  }
});

test("decide_run и все четыре режима decide_query работают через сервер", async () => {
  const harness = await startHarness(new StubProvider((request) => okayResponse(request)));
  try {
    const runResponse = (await harness.client.callTool({
      name: "decide_run",
      arguments: {
        source: {
          type: "text",
          items: [
            { id: "item_a", content: "function add(a, b) { return a + b; }" },
            { id: "item_b", content: "просто текст без кода" },
          ],
        },
        rubric: RUBRIC,
      },
    })) as unknown as ToolResponse;
    assert.ok(!runResponse.isError);
    const run = jsonOf(runResponse) as {
      run_id: string | null;
      status: string;
      stats: { items_processed: number };
    };
    assert.equal(run.status, "completed");
    assert.equal(run.stats.items_processed, 2);
    assert.ok(run.run_id);

    const filterResponse = (await harness.client.callTool({
      name: "decide_query",
      arguments: {
        run_id: run.run_id,
        action: "filter",
        where: {
          conditions: [
            { question_id: "quality", field: "score", op: ">=", value: 1 },
          ],
        },
      },
    })) as unknown as ToolResponse;
    assert.ok(!filterResponse.isError);
    const filtered = jsonOf(filterResponse) as {
      action: string;
      result: { total: number; items: Array<{ itemId: string }> };
    };
    assert.equal(filtered.action, "filter");
    assert.equal(filtered.result.total, 2);

    const aggregateResponse = (await harness.client.callTool({
      name: "decide_query",
      arguments: { run_id: run.run_id, action: "aggregate" },
    })) as unknown as ToolResponse;
    assert.ok(!aggregateResponse.isError);
    const aggregate = jsonOf(aggregateResponse) as {
      action: string;
      result: { itemsTotal: number };
    };
    assert.equal(aggregate.result.itemsTotal, 2);

    const inspectResponse = (await harness.client.callTool({
      name: "decide_query",
      arguments: {
        run_id: run.run_id,
        action: "inspect",
        item_ids: ["item_a"],
      },
    })) as unknown as ToolResponse;
    assert.ok(!inspectResponse.isError);
    const inspected = jsonOf(inspectResponse) as {
      action: string;
      result: {
        contentTruncated: boolean;
        items: Array<{ itemId: string; content: string | null; target: boolean }>;
      };
    };
    assert.equal(inspected.result.contentTruncated, false);
    assert.equal(
      inspected.result.items[0]?.content,
      "function add(a, b) { return a + b; }",
    );
    assert.equal(inspected.result.items[0]?.target, true);

    const compareResponse = (await harness.client.callTool({
      name: "decide_query",
      arguments: {
        run_id: run.run_id,
        action: "compare",
        compare_run_id: run.run_id,
      },
    })) as unknown as ToolResponse;
    assert.ok(!compareResponse.isError);
    const compared = jsonOf(compareResponse) as {
      action: string;
      result: { questions: Record<string, { agreement: number | null }> };
    };
    assert.equal(compared.result.questions["quality"]?.agreement, 1);
  } finally {
    await harness.close();
  }
});

test("decide_models отдаёт паспорт и пресеты без сети", async () => {
  const provider = new StubProvider(() => {
    throw new Error("decide_models не должен ходить в сеть");
  });
  const harness = await startHarness(provider);
  try {
    const response = (await harness.client.callTool({
      name: "decide_models",
      arguments: { refresh_catalog: false },
    })) as unknown as ToolResponse;
    assert.ok(!response.isError);
    const models = jsonOf(response) as {
      active_provider: string;
      default_model: string;
      models: Array<{ alias: string; max_score_levels: number }>;
      presets: string[];
    };
    assert.equal(models.active_provider, "polza");
    assert.equal(models.default_model, "ms");
    assert.equal(models.models.length, 4);
    assert.equal(
      models.models.find((model) => model.alias === "gemini")?.max_score_levels,
      255,
    );
    assert.ok(models.presets.includes("rubrics/logs_triage.json"));

    const refreshed = (await harness.client.callTool({
      name: "decide_models",
      arguments: { refresh_catalog: true },
    })) as unknown as ToolResponse;
    const withRefresh = jsonOf(refreshed) as { warnings?: string[] };
    assert.ok((withRefresh.warnings ?? []).length > 0);
    assert.equal(provider.calls.length, 0);
  } finally {
    await harness.close();
  }
});

test("ошибки валидации и ошибки ядра приходят как isError, сервер живёт", async () => {
  const harness = await startHarness();
  try {
    const missingRunId = (await harness.client.callTool({
      name: "decide_query",
      arguments: { action: "filter" },
    })) as unknown as ToolResponse;
    assert.equal(missingRunId.isError, true);
    assert.match(textOf(missingRunId), /run_id/i);

    const badSource = (await harness.client.callTool({
      name: "decide_run",
      arguments: {
        source: { type: "unknown-source" },
        rubric: RUBRIC,
      },
    })) as unknown as ToolResponse;
    assert.equal(badSource.isError, true);

    const invalidRubric = (await harness.client.callTool({
      name: "decide_run",
      arguments: {
        source: { type: "text", items: [{ id: "a", content: "x" }] },
        rubric: { questions: {} },
      },
    })) as unknown as ToolResponse;
    assert.equal(invalidRubric.isError, true);
    const rubricError = jsonOf(invalidRubric) as { error: { code: string } };
    assert.equal(rubricError.error.code, "invalid_rubric");

    const outside = (await harness.client.callTool({
      name: "decide_run",
      arguments: {
        source: { type: "file", path: "../secret.txt" },
        rubric: RUBRIC,
      },
    })) as unknown as ToolResponse;
    assert.equal(outside.isError, true);
    const pathError = jsonOf(outside) as { error: { code: string } };
    assert.equal(pathError.error.code, "path_outside_root");

    const unknownRun = (await harness.client.callTool({
      name: "decide_query",
      arguments: { run_id: "run_missing", action: "aggregate" },
    })) as unknown as ToolResponse;
    assert.equal(unknownRun.isError, true);
    const runError = jsonOf(unknownRun) as { error: { code: string } };
    assert.equal(runError.error.code, "run_not_found");

    // После всех ошибок сервер продолжает отвечать.
    const listed = await harness.client.listTools();
    assert.equal(listed.tools.length, 3);
  } finally {
    await harness.close();
  }
});

test("неизвестное исключение — internal_error в ответе и строка в stderr", async () => {
  const failingEngine = {
    runDecision: async () => {
      throw new Error("boom");
    },
    queryRun: async () => {
      throw new Error("boom");
    },
    listModels: () => {
      throw new Error("boom");
    },
    close: () => {},
  } as unknown as DecisionEngine;
  const harness = await startHarness(undefined, failingEngine);
  const original = console.error;
  const logged: string[] = [];
  console.error = (...parts: unknown[]) => {
    logged.push(parts.map((part) => String(part)).join(" "));
  };
  try {
    const response = (await harness.client.callTool({
      name: "decide_models",
      arguments: { refresh_catalog: false },
    })) as unknown as ToolResponse;

    assert.equal(response.isError, true);
    const error = jsonOf(response) as { error: { code: string } };
    assert.equal(error.error.code, "internal_error");
    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? "", /internal_error: boom/);
    assert.equal((logged[0] ?? "").includes("stub-key"), false);
  } finally {
    console.error = original;
    await harness.close();
  }
});

test("aggregate/compare отклоняют неприменимые фильтровые параметры", async () => {
  const harness = await startHarness(new StubProvider());
  try {
    const cases = [
      {
        run_id: "run_x",
        action: "aggregate",
        where: {
          conditions: [{ question_id: "q", field: "score", op: ">=", value: 1 }],
        },
      },
      { run_id: "run_x", action: "compare", compare_run_id: "run_y", limit: 5 },
      {
        run_id: "run_x",
        action: "compare",
        compare_run_id: "run_y",
        sort_by: { question_id: "q", field: "score" },
      },
      { run_id: "run_x", action: "aggregate", offset: 0 },
    ];

    for (const args of cases) {
      const response = (await harness.client.callTool({
        name: "decide_query",
        arguments: args,
      })) as unknown as ToolResponse;
      assert.equal(response.isError, true, JSON.stringify(args));
      const error = jsonOf(response) as {
        error: { code: string; message: string };
      };
      assert.equal(error.error.code, "invalid_request");
      assert.match(error.error.message, /не применяются/);
    }
  } finally {
    await harness.close();
  }
});

test("лимиты контракта отсекаются схемой", async () => {
  const harness = await startHarness(new StubProvider());
  try {
    const runArguments = {
      source: { type: "text", items: [{ id: "a", content: "x" }] },
      rubric: RUBRIC,
    };
    const cases = [
      { name: "decide_run", arguments: { ...runArguments, return_top: 51 } },
      {
        name: "decide_query",
        arguments: {
          run_id: "run_x",
          action: "inspect",
          item_ids: Array.from({ length: 21 }, (_unused, index) => `i${index}`),
        },
      },
      {
        name: "decide_query",
        arguments: {
          run_id: "run_x",
          action: "inspect",
          item_ids: ["i1"],
          context_window: 11,
        },
      },
      {
        name: "decide_query",
        arguments: { run_id: "run_x", action: "filter", limit: 201 },
      },
    ];

    for (const entry of cases) {
      const response = (await harness.client.callTool(entry)) as unknown as ToolResponse;
      assert.equal(response.isError, true, `${entry.name}: ${JSON.stringify(entry.arguments)}`);
    }
  } finally {
    await harness.close();
  }
});

test("sort_by маппится в questionId, compare сравнивает разные прогоны", async () => {
  let highItem = "item_bad";
  const provider = new StubProvider((request) => {
    const answers: Record<string, NormalizedAnswer> = {};
    for (const key of Object.keys(request.questions)) {
      const score = key.startsWith(highItem) ? 2.5 : 0.5;
      answers[key] = {
        type: "score",
        status: "ok",
        score,
        confidence: 0.9,
        confidenceSource: "provider",
        probabilities: score > 1 ? [0, 0.1, 0.9] : [0.9, 0.1, 0],
      };
    }
    return {
      answers,
      rawAnswers: {},
      usage: { inputTokens: 20, outputTokens: 1, costRub: 0.0002 },
      latencyMs: 1,
      responseModel: "stub-1.0",
    };
  });
  const qualityRubric = {
    questions: {
      quality: {
        type: "score",
        instructions: "Насколько фрагмент понятен?",
        levels: ["плохо", "хорошо"],
      },
    },
  };
  const source = {
    type: "text",
    items: [
      { id: "item_good", content: "понятный фрагмент" },
      { id: "item_bad", content: "запутанный фрагмент" },
    ],
  };
  const harness = await startHarness(provider);
  try {
    const runWithSort = async (order: "asc" | "desc") =>
      (await harness.client.callTool({
        name: "decide_run",
        arguments: {
          source,
          rubric: qualityRubric,
          sort_by: { question_id: "quality", field: "score", order },
        },
      })) as unknown as ToolResponse;

    const descRun = jsonOf(await runWithSort("desc")) as {
      run_id: string;
      top_items: Array<{ item_id: string }>;
    };
    assert.equal(descRun.top_items[0]?.item_id, "item_bad");

    const ascRun = jsonOf(await runWithSort("asc")) as {
      top_items: Array<{ item_id: string }>;
    };
    assert.equal(ascRun.top_items[0]?.item_id, "item_good");

    const queryWithSort = async (order: "asc" | "desc") =>
      (await harness.client.callTool({
        name: "decide_query",
        arguments: {
          run_id: descRun.run_id,
          action: "filter",
          sort_by: { question_id: "quality", field: "score", order },
        },
      })) as unknown as ToolResponse;

    const descFilter = jsonOf(await queryWithSort("desc")) as {
      result: { items: Array<{ itemId: string }> };
    };
    assert.equal(descFilter.result.items[0]?.itemId, "item_bad");

    const ascFilter = jsonOf(await queryWithSort("asc")) as {
      result: { items: Array<{ itemId: string }> };
    };
    assert.equal(ascFilter.result.items[0]?.itemId, "item_good");

    // Второй прогон с инвертированными оценками — compare не self-compare.
    highItem = "item_good";
    const second = jsonOf(
      (await harness.client.callTool({
        name: "decide_run",
        arguments: { source, rubric: qualityRubric },
      })) as unknown as ToolResponse,
    ) as { run_id: string };

    const compare = jsonOf(
      (await harness.client.callTool({
        name: "decide_query",
        arguments: {
          run_id: descRun.run_id,
          action: "compare",
          compare_run_id: second.run_id,
        },
      })) as unknown as ToolResponse,
    ) as {
      result: {
        commonQuestions: number;
        questions: Record<
          string,
          { meanAbsDiff: number | null; contrasts: Array<{ item_id?: string }> }
        >;
      };
    };

    assert.equal(compare.result.commonQuestions, 1);
    assert.equal(compare.result.questions["quality"]?.meanAbsDiff, 2);
    assert.equal(compare.result.questions["quality"]?.contrasts.length, 2);
  } finally {
    await harness.close();
  }
});

class LineReader {
  readonly lines: string[] = [];
  private buffer = "";
  private readonly waiters: Array<{
    predicate: (line: string) => boolean;
    resolve: (line: string) => void;
  }> = [];

  constructor(stream: NodeJS.ReadableStream) {
    stream.on("data", (chunk: Buffer) => this.push(chunk.toString("utf8")));
  }

  private push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        this.lines.push(line);
        const waiterIndex = this.waiters.findIndex((waiter) =>
          waiter.predicate(line),
        );
        if (waiterIndex >= 0) {
          const [waiter] = this.waiters.splice(waiterIndex, 1);
          waiter?.resolve(line);
        }
      }
      index = this.buffer.indexOf("\n");
    }
  }

  waitFor(predicate: (line: string) => boolean, timeoutMs = 10_000): Promise<string> {
    const existing = this.lines.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Таймаут ожидания JSON-RPC ответа от сервера"));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      });
    });
  }
}

function jsonRpcId(line: string): number | null {
  try {
    const parsed = JSON.parse(line) as { id?: unknown };
    return typeof parsed.id === "number" ? parsed.id : null;
  } catch {
    return null;
  }
}

test("stdio-сервер пишет в stdout только кадры JSON-RPC", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "decide-mcp-stdio-"));
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const entry = path.join(projectRoot, "dist", "servers", "mcp.js");
  assert.equal(existsSync(entry), true, "сначала нужен npm run build");

  // Рабочий .env не читаем: подсовываем несуществующий DECIDE_ENV_FILE.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(POLZA|OPENROUTER|API_KEY|TOKEN|SECRET)/i.test(key)) continue;
    env[key] = value;
  }
  env["DECIDE_ENV_FILE"] = path.join(root, "missing.env");
  env["DECIDE_PROVIDER"] = "polza";
  env["POLZA_API_KEY"] = "stub-key";
  env["DECIDE_DEFAULT_MODEL"] = "ms";
  env["DECIDE_DB_PATH"] = path.join(root, "runs.sqlite");
  env["DECIDE_ALLOWED_ROOT"] = root;
  env["DECIDE_MAX_CONCURRENCY"] = "1";

  const child = spawn(process.execPath, [entry], {
    cwd: projectRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const reader = new LineReader(child.stdout);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const exited = new Promise<number | null | "timeout">((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve("timeout");
    }, 5_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "stdout-probe", version: "1.0.0" },
        },
      })}\n`,
    );
    const initLine = await reader.waitFor((line) => jsonRpcId(line) === 1);
    const init = JSON.parse(initLine) as {
      result?: { serverInfo?: { name?: string } };
    };
    assert.equal(init.result?.serverInfo?.name, SERVER_NAME);

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
    );
    const listLine = await reader.waitFor((line) => jsonRpcId(line) === 2);
    const list = JSON.parse(listLine) as {
      result?: { tools?: Array<{ name: string }> };
    };
    assert.deepEqual(
      (list.result?.tools ?? []).map((tool) => tool.name).sort(),
      ["decide_models", "decide_query", "decide_run"],
    );

    // Реальный вызов инструмента через stdio: каталог моделей без сети.
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "decide_models",
          arguments: { refresh_catalog: false },
        },
      })}
`,
    );
    const modelsLine = await reader.waitFor((line) => jsonRpcId(line) === 3);
    const modelsResponse = JSON.parse(modelsLine) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    assert.ok(!modelsResponse.result?.isError);
    const models = JSON.parse(
      modelsResponse.result?.content?.[0]?.text ?? "{}",
    ) as { models?: unknown[]; presets?: string[] };
    assert.equal(models.models?.length, 4);
    assert.ok((models.presets ?? []).includes("rubrics/logs_triage.json"));

    // И dry_run через stdio: план без сети и без записи.
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "decide_run",
          arguments: {
            source: { type: "text", items: [{ id: "a", content: "x" }] },
            rubric: {
              questions: {
                quality: {
                  type: "score",
                  instructions: "Насколько понятно?",
                  levels: ["плохо", "хорошо"],
                },
              },
            },
            dry_run: true,
          },
        },
      })}
`,
    );
    const runLine = await reader.waitFor((line) => jsonRpcId(line) === 4);
    const runResponse = JSON.parse(runLine) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    assert.ok(!runResponse.result?.isError);
    const dryRun = JSON.parse(runResponse.result?.content?.[0]?.text ?? "{}") as {
      status?: string;
      plan?: { batches?: number };
    };
    assert.equal(dryRun.status, "dry_run");
    assert.equal(dryRun.plan?.batches, 1);

    child.stdin.end();
    const exitCode = await exited;
    if (exitCode === "timeout") {
      assert.fail("stdio-сервер не завершился после закрытия stdin");
    }
    assert.equal(exitCode, 0);

    // Главный инвариант: в stdout нет ни одной строки, кроме JSON-RPC кадров.
    assert.ok(reader.lines.length >= 2);
    for (const line of reader.lines) {
      const parsed = JSON.parse(line) as {
        jsonrpc?: string;
        result?: unknown;
        error?: unknown;
      };
      assert.equal(parsed.jsonrpc, "2.0", `посторонняя строка в stdout: ${line}`);
      assert.ok(parsed.result !== undefined || parsed.error !== undefined);
    }

    assert.match(stderr, /decide-mcp: stdio готов/);
    assert.equal(stderr.includes("stub-key"), false);
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
