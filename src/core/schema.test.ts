import assert from "node:assert/strict";
import test from "node:test";
import {
  SchemaError,
  filterExprSchema,
  sourceSchema,
  toProviderQuestion,
  toProviderQuestions,
  validateRubric,
  type Rubric,
} from "./schema.js";

const validRubric: Rubric = {
  name: "logs_triage_v1",
  guide: "Оценивай запись прикладного лога с точки зрения разбора инцидента.",
  questions: {
    is_actionable: {
      type: "bool",
      instructions: "Требует ли запись вмешательства разработчика?",
      true_description: "Явный баг или потеря данных.",
      false_description: "Штатное событие.",
    },
    severity: {
      type: "score",
      instructions: "Оцени серьёзность события по шкале от 0 до 3.",
      levels: ["Норма", "Незначительный сбой", "Существенная ошибка", "Критичный сбой"],
    },
    subsystem: {
      type: "choice",
      instructions: "К какой подсистеме относится источник проблемы?",
      options: {
        auth: "авторизация и ключи",
        network: "внешние HTTP API",
        other: "не определить",
      },
    },
  },
};

function optionsOf(count: number): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    options[`option_${index}`] = `вариант ${index}`;
  }
  return options;
}

function levelsOf(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `ступень ${index}`);
}

test("принимает валидную рубрику без ошибок и предупреждений", () => {
  const result = validateRubric(validRubric);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.rubric?.questions.severity.type, "score");
});

test("блокирует рубрику без вопросов", () => {
  const result = validateRubric({ questions: {} });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.code, "invalid_rubric");
  assert.equal(result.errors[0]?.path, "questions");
});

test("блокирует question_id вне [a-zA-Z0-9_-] и длиннее 64 символов", () => {
  for (const questionId of ["has space", "bad!", "a".repeat(65)]) {
    const result = validateRubric({
      questions: { [questionId]: { type: "bool", instructions: "Есть ли баг?" } },
    });

    assert.equal(result.ok, false, questionId);
    assert.equal(result.rubric, null);
    assert.deepEqual(
      result.errors.map((error) => error.code),
      ["invalid_rubric"],
    );
    assert.match(result.errors[0]?.path ?? "", /^questions\./);
  }
});

test("принимает question_id из букв, цифр, дефиса и подчёркивания", () => {
  const result = validateRubric({
    questions: {
      "is-actionable_v2": { type: "bool", instructions: "Есть ли баг?" },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.rubric?.questions["is-actionable_v2"], {
    type: "bool",
    instructions: "Есть ли баг?",
  });
});

test("блокирует choice с одной и с 256 опциями", () => {
  const tooFew = validateRubric({
    questions: {
      verdict: { type: "choice", instructions: "Чем закончилось?", options: { one: "только один" } },
    },
  });
  const tooMany = validateRubric({
    questions: {
      verdict: { type: "choice", instructions: "Чем закончилось?", options: optionsOf(256) },
    },
  });

  assert.equal(tooFew.ok, false);
  assert.equal(tooFew.errors[0]?.path, "questions.verdict.options");
  assert.match(tooFew.errors[0]?.message ?? "", /минимум 2/);
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.errors[0]?.path, "questions.verdict.options");
  assert.match(tooMany.errors[0]?.message ?? "", /максимум 255/);
});

test("блокирует score с одной ступенью", () => {
  const result = validateRubric({
    questions: {
      severity: { type: "score", instructions: "Насколько плохо?", levels: levelsOf(1) },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.path, "questions.severity.levels");
  assert.match(result.errors[0]?.message ?? "", /минимум 2/);
});

test("блокирует score с 11 ступенями по строгому потолку", () => {
  const result = validateRubric({
    questions: {
      severity: { type: "score", instructions: "Насколько плохо?", levels: levelsOf(11) },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "invalid_rubric");
  assert.match(result.errors[0]?.message ?? "", /потолок 10/);
});

test("для gemini 11 ступеней score — предупреждение, а не ошибка", () => {
  const result = validateRubric(
    {
      questions: {
        severity: { type: "score", instructions: "Насколько плохо?", levels: levelsOf(11) },
      },
    },
    { model: "gemini" },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ["score_levels_degradation"],
  );
});

test("предупреждает о деградации калибровки choice после 50 опций", () => {
  const result = validateRubric({
    questions: {
      category: { type: "choice", instructions: "Какая категория?", options: optionsOf(51) },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ["choice_calibration_degradation"],
  );
  assert.equal(result.warnings[0]?.path, "questions.category.options");
});

test("предупреждает о заглушке none без ключа other", () => {
  const withoutOther = validateRubric({
    questions: {
      verdict: {
        type: "choice",
        instructions: "Чем закончилось?",
        options: { none_of_the_above: "ничего не подошло", success: "успех" },
      },
    },
  });
  const withOther = validateRubric({
    questions: {
      verdict: {
        type: "choice",
        instructions: "Чем закончилось?",
        options: { other: "ничего не подошло", success: "успех" },
      },
    },
  });

  assert.equal(withoutOther.ok, true);
  assert.deepEqual(
    withoutOther.warnings.map((warning) => warning.code),
    ["choice_gemini_key_order"],
  );
  assert.deepEqual(withOther.warnings, []);
});

test("блокирует box как unsupported_in_mvp", () => {
  const result = validateRubric({
    questions: {
      screenshot_quality: { type: "box", instructions: "Оцени скриншот." },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ["unsupported_in_mvp"],
  );
  assert.equal(result.errors[0]?.path, "questions.screenshot_quality");
});

test("принимает from_run с фильтром и без необязательного where", () => {
  const withWhere = sourceSchema.safeParse({
    type: "from_run",
    run_id: "run_20261122_221500_7f3a",
    where: {
      logic: "and",
      conditions: [
        { question_id: "problem_score", field: "score", op: ">=", value: 1.2 },
      ],
    },
    context_window: 2,
    projection: "full",
  });
  assert.ok(withWhere.success);
  const source = withWhere.data;
  assert.ok(source.type === "from_run");
  assert.equal(source.where?.conditions[0]?.field, "score");
  assert.equal(source.context_window, 2);

  const withoutWhere = sourceSchema.safeParse({
    type: "from_run",
    run_id: "run_20261122_221500_7f3a",
  });
  assert.ok(withoutWhere.success);
  assert.ok(withoutWhere.data.type === "from_run");
  assert.equal(withoutWhere.data.where, undefined);
});

test("блокирует неизвестную проекцию источника", () => {
  const parsed = sourceSchema.safeParse({
    type: "jsonl",
    path: "logs/session_01.jsonl",
    projection: "summary",
  });

  assert.ok(!parsed.success);
  assert.equal(parsed.error.issues[0]?.code, "invalid_value");
  assert.deepEqual(parsed.error.issues[0]?.path, ["projection"]);
});

test("не отбрасывает молча опечатку в поле источника", () => {
  const parsed = sourceSchema.safeParse({
    type: "jsonl",
    path: "logs/session_01.jsonl",
    projectionn: "full",
  });

  assert.ok(!parsed.success);
  const issue = parsed.error.issues.find(
    (item) => item.code === "unrecognized_keys",
  );
  assert.ok(issue);
  assert.deepEqual(issue?.path, []);
  // Текст сообщения — информационный: он приходит от zod и не является контрактом.
  assert.match(issue?.message ?? "", /projectionn/);
});

test("блокирует невалидные field и op в условии фильтра", () => {
  const badField = filterExprSchema.safeParse({
    conditions: [
      { question_id: "problem_score", field: "probability", op: ">", value: 0.5 },
    ],
  });
  assert.ok(!badField.success);
  assert.deepEqual(badField.error.issues[0]?.path, ["conditions", 0, "field"]);

  const badOp = filterExprSchema.safeParse({
    conditions: [
      { question_id: "problem_score", field: "prob", op: "~", value: 0.5 },
    ],
  });
  assert.ok(!badOp.success);
  assert.deepEqual(badOp.error.issues[0]?.path, ["conditions", 0, "op"]);

  const valid = filterExprSchema.safeParse({
    conditions: [
      { question_id: "problem_score", field: "score", op: ">=", value: 1.2 },
    ],
  });
  assert.ok(valid.success);
});

test("блокирует опечатку в поле вопроса, а не отбрасывает её молча", () => {
  const result = validateRubric({
    questions: {
      verdict: {
        type: "choice",
        instructions: "Чем закончилось?",
        criterias: { success: "успех", failure: "провал" },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.code === "invalid_rubric" && error.path === "questions.verdict",
    ),
  );
  // Текст приходит от zod и не является контрактом: он только помогает найти опечатку.
  assert.ok(result.errors.some((error) => error.message.includes("criterias")));
});

test("принимает граничные значения линтера", () => {
  const minOptions = validateRubric({
    questions: {
      verdict: {
        type: "choice",
        instructions: "Чем закончилось?",
        options: optionsOf(2),
      },
    },
  });
  assert.equal(minOptions.ok, true);
  assert.deepEqual(minOptions.warnings, []);

  const maxOptions = validateRubric({
    questions: {
      verdict: {
        type: "choice",
        instructions: "Чем закончилось?",
        options: optionsOf(255),
      },
    },
  });
  assert.equal(maxOptions.ok, true);
  assert.deepEqual(
    maxOptions.warnings.map((warning) => warning.code),
    ["choice_calibration_degradation"],
  );

  const tenLevels = validateRubric({
    questions: {
      severity: {
        type: "score",
        instructions: "Насколько плохо?",
        levels: levelsOf(10),
      },
    },
  });
  assert.equal(tenLevels.ok, true);
  assert.deepEqual(tenLevels.warnings, []);
});

test("принимает question_id длиной ровно 1 и ровно 64", () => {
  for (const questionId of ["q", "a".repeat(64)]) {
    const result = validateRubric({
      questions: {
        [questionId]: { type: "bool", instructions: "Есть ли баг?" },
      },
    });

    assert.equal(result.ok, true, questionId);
  }
});

test("потолки score берутся из паспорта модели", () => {
  const rubricWithLevels = (count: number) => ({
    questions: {
      severity: {
        type: "score",
        instructions: "Насколько плохо?",
        levels: levelsOf(count),
      },
    },
  });

  const maxGemini = validateRubric(rubricWithLevels(255), { model: "gemini" });
  assert.equal(maxGemini.ok, true);
  assert.deepEqual(
    maxGemini.warnings.map((warning) => warning.code),
    ["score_levels_degradation"],
  );

  const overGemini = validateRubric(rubricWithLevels(256), { model: "gemini" });
  assert.equal(overGemini.ok, false);
  assert.match(overGemini.errors[0]?.message ?? "", /потолок 255/);

  for (const model of ["ms", "jev", "luna"] as const) {
    const result = validateRubric(rubricWithLevels(11), { model });
    assert.equal(result.ok, false, model);
    assert.match(result.errors[0]?.message ?? "", /потолок 10/);
  }
});

test("маппит bool в noul и передаёт описания сторон", () => {
  const mapped = toProviderQuestion({
    type: "bool",
    instructions: "Требует ли запись вмешательства?",
    true_description: "Явный баг.",
    false_description: "Штатное событие.",
  });

  assert.deepEqual(mapped, {
    type: "noul",
    instructions: "Требует ли запись вмешательства?",
    true_description: "Явный баг.",
    false_description: "Штатное событие.",
  });
  assert.equal("bool" in mapped, false);
});

test("маппит choice.options в criteria-словарь", () => {
  const mapped = toProviderQuestion({
    type: "choice",
    instructions: "К какой подсистеме относится проблема?",
    options: { auth: "авторизация", network: "сеть" },
  });

  assert.deepEqual(mapped, {
    type: "choice",
    instructions: "К какой подсистеме относится проблема?",
    criteria: { auth: "авторизация", network: "сеть" },
  });
  assert.equal("options" in mapped, false);
});

test("маппит score.levels в criteria-массив", () => {
  const mapped = toProviderQuestion({
    type: "score",
    instructions: "Насколько плохо?",
    levels: ["норма", "сбой", "падение"],
  });

  assert.deepEqual(mapped, {
    type: "score",
    instructions: "Насколько плохо?",
    criteria: ["норма", "сбой", "падение"],
  });
  assert.equal("levels" in mapped, false);
});

test("маппит всю рубрику и отклоняет box при маппинге", () => {
  const mapped = toProviderQuestions(validRubric);

  assert.deepEqual(Object.keys(mapped), ["is_actionable", "severity", "subsystem"]);
  assert.equal(mapped.is_actionable?.type, "noul");
  assert.equal(mapped.severity?.type, "score");
  assert.equal(mapped.subsystem?.type, "choice");
  assert.throws(
    () => toProviderQuestions({ questions: { shot: { type: "box", instructions: "Оцени." } } }),
    (error: unknown) =>
      error instanceof SchemaError && error.code === "unsupported_in_mvp",
  );
});
