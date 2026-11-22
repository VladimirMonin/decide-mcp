import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SourceError,
  loadRunContent,
  readSource,
  resolveInsideRoot,
} from "./sources.js";
import { RunStore, createRunId } from "./store.js";

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "decide-sources-"));
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function cleanup(target: string): void {
  rmSync(target, { recursive: true, force: true });
}

function write(root: string, relativePath: string, content: string | Buffer): string {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
}

function isSourceError(code: string) {
  return (error: unknown): boolean =>
    error instanceof SourceError && error.code === code;
}

test("читает text и делает item_id уникальными", async () => {
  const root = makeRoot();
  try {
    const items = await readSource(
      {
        type: "text",
        items: [
          { id: "same", content: "первый", meta: { tag: 1 } },
          { id: "same", content: "второй" },
        ],
      },
      { allowedRoot: root },
    );

    assert.deepEqual(
      items.map((item) => item.id),
      ["same", "same#2"],
    );
    assert.deepEqual(
      items.map((item) => item.seqIndex),
      [0, 1],
    );
    assert.equal(items[0]?.content, "первый");
    assert.deepEqual(items[0]?.meta, { tag: 1 });
  } finally {
    cleanup(root);
  }
});

test("читает файл целиком и не выпускает путь за корень", async () => {
  const base = makeRoot();
  const root = path.join(base, "root");
  mkdirSync(root);
  write(base, "secret.txt", "secret");
  write(root, "code.ts", "const a = 1;");

  try {
    const items = await readSource(
      { type: "file", path: "code.ts" },
      { allowedRoot: root },
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, "code.ts");
    assert.equal(items[0]?.content, "const a = 1;");
    assert.equal(items[0]?.sourceRef, "code.ts");

    await assert.rejects(
      readSource({ type: "file", path: "../secret.txt" }, { allowedRoot: root }),
      isSourceError("path_outside_root"),
    );
    await assert.rejects(
      readSource(
        { type: "file", path: path.join(base, "secret.txt") },
        { allowedRoot: root },
      ),
      isSourceError("path_outside_root"),
    );
    await assert.rejects(
      readSource({ type: "file", path: "missing.ts" }, { allowedRoot: root }),
      isSourceError("source_not_found"),
    );

    assert.throws(
      () => resolveInsideRoot("../secret.txt", root),
      isSourceError("path_outside_root"),
    );
  } finally {
    cleanup(base);
  }
});

test("делит файл по строкам и применяет max_lines", async () => {
  const root = makeRoot();
  write(root, "notes.txt", "one\n\n two \nthree\n");
  try {
    const items = await readSource(
      { type: "file", path: "notes.txt", mode: "lines" },
      { allowedRoot: root },
    );

    assert.deepEqual(
      items.map((item) => item.id),
      ["notes.txt#L1", "notes.txt#L3", "notes.txt#L4"],
    );
    assert.deepEqual(
      items.map((item) => item.content),
      ["one", " two ", "three"],
    );

    const limited = await readSource(
      { type: "file", path: "notes.txt", mode: "lines", max_lines: 2 },
      { allowedRoot: root },
    );
    assert.equal(limited.length, 2);
  } finally {
    cleanup(root);
  }
});

test("glob исключает мусор, бинарные файлы и уважает max_files", async () => {
  const root = makeRoot();
  write(root, "src/a.ts", "alpha");
  write(root, "src/nested/e.ts", "extra");
  write(root, "node_modules/b.ts", "vendored");
  write(root, "dist/c.ts", "built");
  write(root, ".git/d.ts", "git");
  write(root, "bin.dat", Buffer.from([0, 1, 2, 3]));

  try {
    const items = await readSource(
      { type: "glob", pattern: "**/*" },
      { allowedRoot: root },
    );
    assert.deepEqual(
      items.map((item) => item.id),
      ["src/a.ts", "src/nested/e.ts"],
    );

    const ignored = await readSource(
      { type: "glob", pattern: "**/*.ts", ignore: ["**/nested/**"] },
      { allowedRoot: root },
    );
    assert.deepEqual(
      ignored.map((item) => item.id),
      ["src/a.ts"],
    );

    const limited = await readSource(
      { type: "glob", pattern: "**/*.ts", max_files: 1 },
      { allowedRoot: root },
    );
    assert.equal(limited.length, 1);
  } finally {
    cleanup(root);
  }
});

test("glob не принимает шаблон, выходящий за корень", async () => {
  const root = makeRoot();
  try {
    await assert.rejects(
      readSource({ type: "glob", pattern: "../*" }, { allowedRoot: root }),
      isSourceError("path_outside_root"),
    );
    await assert.rejects(
      readSource(
        { type: "glob", pattern: path.join(root, "**/*.ts") },
        { allowedRoot: root },
      ),
      isSourceError("path_outside_root"),
    );
  } finally {
    cleanup(root);
  }
});

test("junction за пределы корня не читается ни файлом, ни glob", async (t) => {
  const base = makeRoot();
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  const link = path.join(root, "link");

  try {
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      t.skip("junction недоступен в этой среде");
      return;
    }

    await assert.rejects(
      readSource({ type: "file", path: "link/secret.txt" }, { allowedRoot: root }),
      isSourceError("path_outside_root"),
    );

    const items = await readSource(
      { type: "glob", pattern: "**/*.txt" },
      { allowedRoot: root },
    );
    assert.deepEqual(items, []);
  } finally {
    // Снимаем ссылку как ссылку, не заходя внутрь неё.
    try {
      rmdirSync(link);
    } catch {
      // ссылки уже нет
    }
    cleanup(base);
  }
});

test("jsonl читает строки, id_field, offset/limit и битый JSON", async () => {
  const root = makeRoot();
  write(
    root,
    "session.jsonl",
    [
      '{"step_id":"s1","role":"assistant","content":"a"}',
      "not json",
      '{"step_id":"s1","role":"user","content":"b"}',
      '{"step_id":"s3","content":"c"}',
    ].join("\n"),
  );

  try {
    const items = await readSource(
      { type: "jsonl", path: "session.jsonl", id_field: "step_id" },
      { allowedRoot: root },
    );

    assert.deepEqual(
      items.map((item) => item.id),
      ["s1", "line_0002", "s1#2", "s3"],
    );
    assert.equal(items[1]?.meta["invalidJson"], true);
    assert.equal(items[0]?.meta["invalidJson"], false);

    const sliced = await readSource(
      { type: "jsonl", path: "session.jsonl", offset: 1, limit: 2 },
      { allowedRoot: root },
    );
    assert.deepEqual(
      sliced.map((item) => item.id),
      ["line_0002", "line_0003"],
    );
  } finally {
    cleanup(root);
  }
});

test("jsonl строит skeleton, full и добавляет теги префильтра в skeleton", async () => {
  const root = makeRoot();
  const rows = [
    {
      step_id: "step_001",
      role: "assistant",
      tool_name: "read_file",
      arguments: { path: "a" },
      status: "error",
      error: "PermissionError",
      reasoning: "Wait, файл недоступен. На самом деле нужно проверить путь.",
    },
    {
      step_id: "step_002",
      role: "assistant",
      tool_name: "read_file",
      arguments: { path: "a" },
      status: "ok",
      reasoning: "Повторяю вызов, чтобы убедиться.",
    },
  ];
  write(root, "session.jsonl", rows.map((row) => JSON.stringify(row)).join("\n"));

  try {
    const skeleton = await readSource(
      {
        type: "jsonl",
        path: "session.jsonl",
        id_field: "step_id",
        projection: "skeleton",
        prefilter_tags: true,
      },
      { allowedRoot: root },
    );

    const first = skeleton[0]?.content ?? "";
    assert.match(first, /step_id: step_001/);
    assert.match(first, /tool: read_file/);
    assert.match(first, /arguments: \{"path":"a"\}/);
    assert.match(first, /status: error/);
    assert.match(first, /error: PermissionError/);
    assert.match(first, /reasoning: \d+ toks/);
    assert.match(first, /reversals: 2/);
    assert.match(first, /\[reasoning_toks=\d+, tool_error, reversals=2\]/);
    // Второй такой же вызов подряд получает repeat_tool=2.
    assert.match(skeleton[1]?.content ?? "", /repeat_tool=2/);

    const full = await readSource(
      {
        type: "jsonl",
        path: "session.jsonl",
        id_field: "step_id",
        projection: "full",
        prefilter_tags: true,
      },
      { allowedRoot: root },
    );
    // `full` остаётся валидным JSON: теги префильтра идут только в skeleton.
    assert.deepEqual(JSON.parse(full[0]?.content ?? ""), rows[0]);
  } finally {
    cleanup(root);
  }
});

test("from_run берёт только цели, подтягивает соседей и склеивает окна", async () => {
  const root = makeRoot();
  const store = new RunStore(":memory:");
  try {
    const parentRunId = createRunId(new Date("2026-11-22T10:00:00Z"), "0001");
    const source = {
      type: "text",
      items: ["c0", "c1", "c2", "c3", "c4"].map((content, index) => ({
        id: `i${index}`,
        content,
      })),
    };
    store.createRun({
      runId: parentRunId,
      createdAt: "2026-11-22T10:00:00.000Z",
      provider: "polza",
      modelAlias: "jev",
      modelId: "typesafe/jev",
      scope: "per_item",
      sourceJson: JSON.stringify(source),
      rubricJson: "{}",
      itemsTotal: 5,
    });
    store.addItems(
      parentRunId,
      source.items.map((item, index) => ({
        itemId: item.id,
        seqIndex: index,
        sourceRef: null,
        meta: { index },
        preview: item.content,
        contentHash: hashContent(item.content),
        status: "ok" as const,
      })),
    );
    store.saveAnswers(parentRunId, [
      {
        itemId: "i1",
        questionId: "problem_score",
        answer: {
          type: "score",
          status: "ok",
          score: 1.8,
          confidence: 0.9,
          confidenceSource: "provider",
        },
      },
      {
        itemId: "i3",
        questionId: "problem_score",
        answer: {
          type: "score",
          status: "ok",
          score: 0.5,
          confidence: 0.9,
          confidenceSource: "provider",
        },
      },
    ]);

    const items = await readSource(
      {
        type: "from_run",
        run_id: parentRunId,
        where: {
          conditions: [
            { question_id: "problem_score", field: "score", op: ">=", value: 1.5 },
          ],
        },
        context_window: 1,
      },
      { allowedRoot: root, store },
    );

    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, "i1");
    assert.match(items[0]?.content ?? "", /--- i0 \(seq 0\) ---/);
    assert.match(items[0]?.content ?? "", /--- i1 \(seq 1\) \[target\] ---/);
    assert.match(items[0]?.content ?? "", /--- i2 \(seq 2\) ---/);
    assert.deepEqual(items[0]?.meta["episode"], ["i0", "i1", "i2"]);

    const all = await readSource(
      { type: "from_run", run_id: parentRunId, limit: 2 },
      { allowedRoot: root, store },
    );
    assert.deepEqual(
      all.map((item) => item.id),
      ["i0", "i1"],
    );

    const parent = store.getRun(parentRunId);
    assert.ok(parent);
    const loaded = await loadRunContent(parent, ["i3"], undefined, {
      allowedRoot: root,
      store,
    });
    assert.equal(loaded.content.get("i3"), "c3");
    assert.deepEqual(loaded.changed, []);

    await assert.rejects(
      readSource(
        { type: "from_run", run_id: "run_missing" },
        { allowedRoot: root, store },
      ),
      isSourceError("run_not_found"),
    );
    await assert.rejects(
      readSource(
        { type: "from_run", run_id: parentRunId },
        { allowedRoot: root },
      ),
      isSourceError("store_required"),
    );
  } finally {
    store.close();
    cleanup(root);
  }
});

test("loadRunContent помечает изменившийся источник и не роняет запрос", async () => {
  const root = makeRoot();
  const store = new RunStore(":memory:");
  try {
    write(root, "data.txt", "old");
    const runId = createRunId(new Date("2026-11-22T10:00:00Z"), "0002");
    store.createRun({
      runId,
      createdAt: "2026-11-22T10:00:00.000Z",
      provider: "polza",
      modelAlias: "jev",
      modelId: "typesafe/jev",
      scope: "per_item",
      sourceJson: JSON.stringify({ type: "file", path: "data.txt" }),
      rubricJson: "{}",
      itemsTotal: 1,
    });
    store.addItems(runId, [
      {
        itemId: "data.txt",
        seqIndex: 0,
        sourceRef: "data.txt",
        meta: null,
        preview: "old",
        contentHash: hashContent("old"),
        status: "ok",
      },
    ]);
    store.saveAnswers(runId, [
      {
        itemId: "data.txt",
        questionId: "score",
        answer: {
          type: "score",
          status: "ok",
          score: 2,
          confidence: 0.9,
          confidenceSource: "provider",
        },
      },
    ]);

    // Источник изменился после прогона.
    write(root, "data.txt", "new");
    const run = store.getRun(runId);
    assert.ok(run);

    const loaded = await loadRunContent(run, ["data.txt"], undefined, {
      allowedRoot: root,
      store,
    });
    assert.equal(loaded.content.get("data.txt"), "new");
    assert.deepEqual(loaded.changed, ["data.txt"]);

    // Перезагрузка в другой проекции не сверяет хэш: текст законно другой.
    const projected = await loadRunContent(run, ["data.txt"], "full", {
      allowedRoot: root,
      store,
    });
    assert.deepEqual(projected.changed, []);

    const items = await readSource(
      { type: "from_run", run_id: runId },
      { allowedRoot: root, store },
    );
    assert.equal(items[0]?.meta["sourceChanged"], true);
    assert.equal(items[0]?.meta["episodeChanged"], true);
  } finally {
    store.close();
    cleanup(root);
  }
});

test("from_run клампит context_window тем же потолком, что inspect", async () => {
  const root = makeRoot();
  const store = new RunStore(":memory:");
  try {
    const runId = createRunId(new Date("2026-11-22T10:00:00Z"), "0003");
    const source = {
      type: "text",
      items: Array.from({ length: 31 }, (_unused, index) => ({
        id: `i${index}`,
        content: `c${index}`,
      })),
    };
    store.createRun({
      runId,
      createdAt: "2026-11-22T10:00:00.000Z",
      provider: "polza",
      modelAlias: "jev",
      modelId: "typesafe/jev",
      scope: "per_item",
      sourceJson: JSON.stringify(source),
      rubricJson: "{}",
      itemsTotal: 31,
    });
    store.addItems(
      runId,
      source.items.map((item, index) => ({
        itemId: item.id,
        seqIndex: index,
        sourceRef: null,
        meta: null,
        preview: item.content,
        contentHash: hashContent(item.content),
        status: "ok" as const,
      })),
    );
    store.saveAnswers(runId, [
      {
        itemId: "i15",
        questionId: "problem",
        answer: {
          type: "score",
          status: "ok",
          score: 2,
          confidence: 0.9,
          confidenceSource: "provider",
        },
      },
    ]);

    const items = await readSource(
      {
        type: "from_run",
        run_id: runId,
        where: {
          conditions: [
            { question_id: "problem", field: "score", op: ">=", value: 1 },
          ],
        },
        context_window: 100,
      },
      { allowedRoot: root, store },
    );

    const episode = items[0]?.meta["episode"] as string[];
    assert.equal(episode.length, 21);
    assert.equal(episode[0], "i5");
    assert.equal(episode.at(-1), "i25");
  } finally {
    store.close();
    cleanup(root);
  }
});
