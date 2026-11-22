import assert from "node:assert/strict";
import test from "node:test";
import type { QuestionDef } from "../schema.js";
import { ProviderError } from "./types.js";
import {
  DEFAULT_RETRY_DELAYS_MS,
  SystemOneProvider,
  classifyHttpError,
  type SystemOneProviderOptions,
} from "./systemone.js";

interface StubCall {
  url: string;
  body: unknown;
}

interface StubReply {
  status?: number;
  body: unknown;
}

function stubFetch(replies: StubReply[] | ((call: StubCall) => StubReply)): {
  fetchImpl: typeof fetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const call: StubCall = {
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const reply =
      typeof replies === "function"
        ? replies(call)
        : (replies[Math.min(calls.length - 1, replies.length - 1)] ?? {
            status: 500,
            body: {},
          });
    const text =
      typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const QUESTIONS: Record<string, QuestionDef> = {
  is_code: {
    type: "bool",
    instructions: "Это код?",
    true_description: "Есть код.",
    false_description: "Кода нет.",
  },
  language: {
    type: "choice",
    instructions: "Какой язык?",
    options: { js: "JavaScript", python: "Python", other: "другой" },
  },
  quality: {
    type: "score",
    instructions: "Насколько понятно?",
    levels: ["плохо", "средне", "хорошо"],
  },
};

const RESPONSE = {
  model: "microsoft/microsoft-decision-1-20261009",
  answers: {
    is_code: { type: "noul", noul: 0.8 },
    language: {
      type: "choice",
      choice: "js",
      probabilities: { js: 0.7, python: 0.2, other: 0.1 },
    },
    quality: {
      type: "score",
      score: 1.8,
      probabilities: { "0": 0.05, "1": 0.15, "2": 0.8 },
      confidence: 0.91,
    },
  },
  usage: { input_tokens: 168, output_tokens: 4, cost_rub: 0.00082697 },
};

function createProvider(
  overrides: Partial<SystemOneProviderOptions> = {},
): SystemOneProvider {
  return new SystemOneProvider({
    name: "polza",
    apiKey: "stub-key",
    decisionsUrl: "https://example.test/api/v1/systemone",
    catalogUrl: "https://example.test/api/v1/models/catalog",
    timeoutMs: 5_000,
    retryDelaysMs: [1, 2, 3],
    jitterRatio: 0,
    sleep: async () => {},
    random: () => 0,
    ...overrides,
  });
}

interface CapturedBody {
  model?: string;
  state?: string;
  questions?: Record<string, Record<string, unknown>>;
}

test("берёт ID модели из реестра для активного шлюза", async () => {
  const polza = stubFetch([{ body: RESPONSE }]);
  await createProvider({ fetchImpl: polza.fetchImpl }).decide({
    modelAlias: "jev",
    state: "state",
    questions: { is_code: QUESTIONS.is_code },
  });
  const openrouter = stubFetch([{ body: RESPONSE }]);
  await createProvider({
    name: "openrouter",
    decisionsUrl: "https://openrouter.test/api/v1/systemone",
    fetchImpl: openrouter.fetchImpl,
  }).decide({
    modelAlias: "jev",
    state: "state",
    questions: { is_code: QUESTIONS.is_code },
  });

  assert.equal((polza.calls[0]?.body as CapturedBody).model, "typesafe/jev");
  assert.equal(
    (openrouter.calls[0]?.body as CapturedBody).model,
    "typesafe/jev-1.14",
  );
});

test("переводит внутренние примитивы в noul и criteria", async () => {
  const { fetchImpl, calls } = stubFetch([{ body: RESPONSE }]);

  await createProvider({ fetchImpl }).decide({
    modelAlias: "ms",
    state: "state",
    questions: QUESTIONS,
  });

  const body = calls[0]?.body as CapturedBody;
  assert.equal(body.model, "microsoft/microsoft-decision-1");
  assert.equal(body.state, "state");
  const isCode = body.questions?.["is_code"];
  assert.equal(isCode?.["type"], "noul");
  assert.equal(isCode?.["instructions"], "Это код?");
  assert.equal(isCode?.["true_description"], "Есть код.");
  assert.equal(isCode?.["false_description"], "Кода нет.");

  // language: options → criteria; language: criteria → dict
  const language = body.questions?.["language"];
  assert.equal(language?.["type"], "choice");
  assert.deepEqual(language?.["criteria"], {
    js: "JavaScript",
    python: "Python",
    other: "другой",
  });
  assert.equal("options" in (language ?? {}), false);

  // quality: levels → criteria
  const quality = body.questions?.["quality"];
  assert.equal(quality?.["type"], "score");
  assert.deepEqual(quality?.["criteria"], ["плохо", "средне", "хорошо"]);
  assert.equal("levels" in (quality ?? {}), false);
});

test("нормализует вероятности, уверенность и usage", async () => {
  const { fetchImpl } = stubFetch([{ body: RESPONSE }]);

  const response = await createProvider({ fetchImpl }).decide({
    modelAlias: "ms",
    state: "state",
    questions: QUESTIONS,
  });

  const isCode = response.answers["is_code"];
  assert.equal(isCode?.type, "bool");
  assert.equal(isCode?.status, "ok");
  assert.equal(isCode?.prob, 0.8);
  assert.equal(isCode?.confidence, 0.8);
  assert.equal(isCode?.confidenceSource, "max_prob");

  const language = response.answers["language"];
  assert.equal(language?.choice, "js");
  assert.ok(Math.abs((language?.confidence ?? 0) - 0.5) < 1e-9);
  assert.equal(language?.confidenceSource, "margin");
  assert.deepEqual(language?.probabilities, { js: 0.7, python: 0.2, other: 0.1 });

  const quality = response.answers["quality"];
  assert.equal(quality?.score, 1.8);
  assert.equal(quality?.confidence, 0.91);
  assert.equal(quality?.confidenceSource, "provider");
  assert.deepEqual(quality?.probabilities, [0.05, 0.15, 0.8]);

  assert.deepEqual(response.usage, {
    inputTokens: 168,
    outputTokens: 4,
    costRub: 0.00082697,
  });
  assert.equal(response.responseModel, "microsoft/microsoft-decision-1-20261009");
  assert.equal(typeof response.latencyMs, "number");
});

test("не отдаёт вероятности score с разреженными индексами", async () => {
  const { fetchImpl } = stubFetch([
    {
      body: {
        model: "m",
        answers: {
          quality: {
            type: "score",
            score: 1,
            probabilities: { "0": 0.5, "2": 0.5 },
          },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
  ]);

  const response = await createProvider({ fetchImpl }).decide({
    modelAlias: "ms",
    state: "state",
    questions: { quality: QUESTIONS.quality },
  });

  assert.equal(response.answers["quality"]?.score, 1);
  assert.equal(response.answers["quality"]?.probabilities, undefined);
  assert.equal(response.answers["quality"]?.confidence, 0);
  assert.equal(response.answers["quality"]?.confidenceSource, "none");
});

test("сохраняет отказ модели и несовпадение типа как статус", async () => {
  const { fetchImpl } = stubFetch([
    {
      body: {
        model: "m",
        answers: {
          is_code: { type: "refusal" },
          language: { type: "score", score: 2 },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
  ]);

  const response = await createProvider({ fetchImpl }).decide({
    modelAlias: "ms",
    state: "state",
    questions: { is_code: QUESTIONS.is_code, language: QUESTIONS.language },
  });

  assert.equal(response.answers["is_code"]?.status, "refusal");
  assert.equal(response.answers["is_code"]?.confidence, 0);
  assert.equal(response.answers["language"]?.status, "error");
  assert.equal(response.answers["language"]?.choice, undefined);
});

test("помечает ответ error, если провайдер пропустил вопрос", async () => {
  const { fetchImpl } = stubFetch([{ body: { model: "m", answers: {} } }]);

  const response = await createProvider({ fetchImpl }).decide({
    modelAlias: "ms",
    state: "state",
    questions: { is_code: QUESTIONS.is_code },
  });

  assert.equal(response.answers["is_code"]?.status, "error");
  assert.equal(response.answers["is_code"]?.prob, undefined);
});

test("ретраит 429 и транзиентные 5xx по документированным задержкам", async () => {
  assert.deepEqual([...DEFAULT_RETRY_DELAYS_MS], [1_000, 3_000, 7_000]);

  const sleeps: number[] = [];
  const { fetchImpl, calls } = stubFetch([
    { status: 429, body: { error: { code: "RATE_LIMITED" } } },
    { status: 502, body: {} },
    { status: 200, body: RESPONSE },
  ]);
  const provider = createProvider({
    fetchImpl,
    retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
    },
  });

  const response = await provider.decide({
    modelAlias: "ms",
    state: "state",
    questions: { is_code: QUESTIONS.is_code },
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1_000, 3_000]);
  assert.equal(response.answers["is_code"]?.status, "ok");
});

test("сдаётся после трёх повторов на 503", async () => {
  const { fetchImpl, calls } = stubFetch([{ status: 503, body: {} }]);

  await assert.rejects(
    createProvider({ fetchImpl }).decide({
      modelAlias: "ms",
      state: "state",
      questions: { is_code: QUESTIONS.is_code },
    }),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.kind === "provider_error" &&
      error.retryable &&
      error.status === 503,
  );

  assert.equal(calls.length, 4);
});

test("не ретраит 400 BAD_REQUEST (переполнение окна)", async () => {
  const overflow = {
    error: {
      code: "BAD_REQUEST",
      message: "Некорректный запрос.",
      metadata: {
        raw: "request is about 67074 tokens; the limit for the state plus all questions is 64000",
      },
    },
    trace_id: "trace-1",
    detail: { error_type: "bad_request", message: "Некорректный запрос." },
  };
  const { fetchImpl, calls } = stubFetch([{ status: 400, body: overflow }]);

  await assert.rejects(
    createProvider({ fetchImpl }).decide({
      modelAlias: "ms",
      state: "state",
      questions: { is_code: QUESTIONS.is_code },
    }),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.kind === "bad_request" &&
      error.splittable === false &&
      error.retryable === false &&
      error.traceId === "trace-1" &&
      error.message.includes("64000"),
  );

  assert.equal(calls.length, 1);
});

test("отличает safety-блокировку от дефекта запроса", async () => {
  const safety = {
    error: { code: "content_blocked", message: "blocked" },
    detail: { error_type: "content_blocked" },
  };
  const { fetchImpl, calls } = stubFetch([{ status: 400, body: safety }]);

  await assert.rejects(
    createProvider({ fetchImpl }).decide({
      modelAlias: "ms",
      state: "state",
      questions: { is_code: QUESTIONS.is_code },
    }),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.kind === "safety_blocked" &&
      error.splittable === true &&
      error.retryable === false,
  );

  assert.equal(calls.length, 1);
});

test("распознаёт safety по detail.error_type без error.code", () => {
  const error = classifyHttpError(
    400,
    JSON.stringify({ detail: { error_type: "safety", message: "blocked" } }),
  );

  assert.equal(error.kind, "safety_blocked");
});

test("не принимает не-JSON успешный ответ", async () => {
  const { fetchImpl, calls } = stubFetch([{ status: 200, body: "not-json" }]);

  await assert.rejects(
    createProvider({ fetchImpl }).decide({
      modelAlias: "ms",
      state: "state",
      questions: { is_code: QUESTIONS.is_code },
    }),
    (error: unknown) =>
      error instanceof ProviderError && error.kind === "provider_error",
  );

  assert.equal(calls.length, 1);
});

test("повторяет сетевой сбой и затем отдаёт provider_error", async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    throw new Error("timeout");
  }) as unknown as typeof fetch;

  await assert.rejects(
    createProvider({ fetchImpl }).decide({
      modelAlias: "ms",
      state: "state",
      questions: { is_code: QUESTIONS.is_code },
    }),
    (error: unknown) =>
      error instanceof ProviderError && error.kind === "provider_error",
  );

  assert.equal(attempts, 4);
});

test("обходит страницы каталога Polza и фильтрует decision-модели", async () => {
  const pageOne = {
    data: [
      {
        id: "google/gemini-decision-1",
        context_length: 262_144,
        type: "classification",
        endpoints: ["/api/v1/systemone"],
      },
      { id: "plain/chat-model", type: "chat", endpoints: ["/v1/chat"] },
    ],
    meta: { totalPages: 2, total: 3 },
  };
  const pageTwo = {
    data: [
      {
        id: "typesafe/jev",
        context_length: 64_000,
        endpoints: ["/api/v1/systemone"],
      },
    ],
    meta: { totalPages: 2, total: 3 },
  };
  const { fetchImpl, calls } = stubFetch([
    { body: pageOne },
    { body: pageTwo },
  ]);

  const models = await createProvider({ fetchImpl }).fetchCatalog();

  assert.deepEqual(
    models.map((model) => model.id),
    ["google/gemini-decision-1", "typesafe/jev"],
  );
  assert.equal(models[0]?.contextLength, 262_144);
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.url.includes("limit=100"));
  assert.ok(calls[0]?.url.includes("page=1"));
  assert.ok(calls[1]?.url.includes("page=2"));
});

test("читает каталог OpenRouter одним запросом", async () => {
  const payload = {
    data: [
      { id: "google/gemini-decision-1", endpoints: ["/api/v1/systemone"] },
      { id: "openai/chat", endpoints: ["/v1/chat"] },
    ],
  };
  const { fetchImpl, calls } = stubFetch([{ body: payload }]);

  const models = await createProvider({
    name: "openrouter",
    catalogUrl: "https://openrouter.test/api/v1/models?output_modalities=decisions",
    fetchImpl,
  }).fetchCatalog();

  assert.deepEqual(
    models.map((model) => model.id),
    ["google/gemini-decision-1"],
  );
  assert.equal(calls.length, 1);
});
