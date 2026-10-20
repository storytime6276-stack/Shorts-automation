import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JobStore, readReusableArtifacts, type JobRecord } from "./pipeline";

function upload(body: Buffer, idempotencyKey?: string) {
  const request = new PassThrough() as PassThrough & { header: (name: string) => string | undefined };
  request.header = (name) => name.toLowerCase() === "content-length" ? String(body.length) : name.toLowerCase() === "idempotency-key" ? idempotencyKey : undefined;
  queueMicrotask(() => request.end(body));
  return request as never;
}

async function persist(job: JobRecord) {
  await writeFile(path.join(job.paths.directory, "job.json"), JSON.stringify(job));
}

test("batch uploads persist history, isolate failures, retry failed work, and limit concurrency to one", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "shorts-job-batch-"));
  const attempts = new Map<string, number>();
  let active = 0;
  let maxActive = 0;
  const store = new JobStore(workspace, async (job) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    attempts.set(job.filename, (attempts.get(job.filename) ?? 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (job.filename === "broken.mp4" && (attempts.get(job.filename) ?? 0) === 1) {
      job.status = "failed";
      job.progress = 100;
      job.error = "synthetic decode failure";
    } else {
      job.status = "completed";
      job.progress = 100;
      job.error = null;
    }
    await persist(job);
    active -= 1;
  });
  try {
    await store.ready;
    const submitted = await Promise.all([
      store.create("first.mp4", upload(Buffer.from("video-1"))),
      store.create("broken.mp4", upload(Buffer.from("video-2"))),
      store.create("third.mp4", upload(Buffer.from("video-3"))),
    ]);
    await store.waitForIdle();
    assert.equal(maxActive, 1);
    assert.deepEqual(submitted.map((item) => item.status), ["queued", "queued", "queued"]);
    assert.deepEqual(store.list().map((item) => item.status).sort(), ["completed", "completed", "failed"]);
    const failed = store.list().find((job) => job.filename === "broken.mp4")!;
    const retry = await store.retry(failed.id);
    assert.equal(retry?.status, "queued");
    await store.waitForIdle();
    assert.equal(store.get(failed.id)?.status, "completed");
    assert.equal(attempts.get("first.mp4"), 1, "completed batch items are not rerun when another item is retried");
    assert.equal(attempts.get("broken.mp4"), 2);

    const restarted = new JobStore(workspace, async () => { throw new Error("terminal history should not rerun"); });
    await restarted.ready;
    assert.equal(restarted.list().length, 3);
    assert.ok(restarted.list().every((job) => job.status === "completed"));
    const saved = JSON.parse(await readFile(path.join(workspace, failed.id, "job.json"), "utf8")) as JobRecord;
    assert.equal(saved.status, "completed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("duplicate file submissions return the original job instead of scheduling duplicate work", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "shorts-job-dedupe-"));
  let runs = 0;
  const store = new JobStore(workspace, async (job) => { runs += 1; job.status = "completed"; job.progress = 100; await persist(job); });
  try {
    await store.ready;
    const body = Buffer.from("identical-video-content");
    const [first, duplicate] = await Promise.all([
      store.create("same.mp4", upload(body)),
      store.create("same-copy.mp4", upload(body)),
    ]);
    await store.waitForIdle();
    assert.equal(duplicate.id, first.id);
    assert.equal(store.list().length, 1);
    assert.equal(runs, 1);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("a repeated idempotency key cannot enqueue a second job", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "shorts-job-idempotency-"));
  let runs = 0;
  const store = new JobStore(workspace, async (job) => { runs += 1; job.status = "completed"; job.progress = 100; await persist(job); });
  try {
    await store.ready;
    const [first, retry] = await Promise.all([
      store.create("first.mp4", upload(Buffer.from("original request"), "request-123")),
      store.create("renamed.mp4", upload(Buffer.from("retried request body"), "request-123")),
    ]);
    await store.waitForIdle();
    assert.equal(retry.id, first.id);
    assert.equal(store.list().length, 1);
    assert.equal(runs, 1);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("server restart requeues interrupted jobs and keeps valid completed artifacts available for resume", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "shorts-job-recovery-"));
  const id = randomUUID();
  const directory = path.join(workspace, id);
  await mkdir(path.join(directory, "input"), { recursive: true });
  const job: JobRecord = {
    id, filename: "interrupted.mp4", status: "transcribing", progress: 63, durationSeconds: 4,
    media: { duration: 4 }, transcript: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    paths: { directory, input: path.join(directory, "input", "interrupted.mp4"), audio: path.join(directory, "audio.wav"), transcript: path.join(directory, "transcript.json"), highlights: path.join(directory, "highlights.json") },
  };
  const transcript = { language: "en", durationSeconds: 4, segments: [{ id: 0, start: 0, end: 2, text: "A recovered sentence.", words: [] }] };
  await writeFile(job.paths.input, "source");
  await writeFile(job.paths.transcript, JSON.stringify(transcript));
  await writeFile(job.paths.highlights, JSON.stringify({ jobId: id, candidates: [] }));
  await writeFile(path.join(directory, "job.json"), JSON.stringify(job));
  let resumedArtifacts: Awaited<ReturnType<typeof readReusableArtifacts>> | undefined;
  const store = new JobStore(workspace, async (recovered) => {
    resumedArtifacts = await readReusableArtifacts(recovered);
    recovered.status = resumedArtifacts.transcript && resumedArtifacts.analysis ? "completed" : "failed";
    recovered.progress = 100;
    await persist(recovered);
  });
  try {
    await store.ready;
    await store.waitForIdle();
    assert.equal(resumedArtifacts?.transcript?.segments[0]?.text, "A recovered sentence.");
    assert.equal(resumedArtifacts?.analysis?.jobId, id);
    assert.equal(store.get(id)?.status, "completed");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
