import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const inputFiles = process.env.SHORTS_BATCH_E2E_FILES?.split(";").filter(Boolean) ?? [];

test("real multi-video batch transcribes each source and generates QA-passing vertical clips", { skip: inputFiles.length < 2 ? "Set SHORTS_BATCH_E2E_FILES to two semicolon-separated synthetic MP4 paths." : false, timeout: 360_000 }, async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "shorts-batch-e2e-"));
  process.env.SHORTS_WORKSPACE_DIR = workspace;
  process.env.WHISPER_MODEL ??= "tiny.en";
  const [{ JobStore }, { readAnalysis }, { createClip, readClips, clipFilePath }, { promises: fs }] = await Promise.all([
    import("./pipeline"), import("./highlights"), import("./clips"), import("node:fs"),
  ]);
  const store = new JobStore(workspace);
  const summaries: Array<Record<string, unknown>> = [];
  try {
    await store.ready;
    const submitted = await Promise.all(inputFiles.map(async (file) => {
      const body = await readFile(file);
      const request = new PassThrough() as PassThrough & { header: (name: string) => string | undefined };
      request.header = (name) => name.toLowerCase() === "content-length" ? String(body.length) : undefined;
      queueMicrotask(() => request.end(body));
      return store.create(path.basename(file), request as never);
    }));
    await store.waitForIdle();
    assert.equal(submitted.length, inputFiles.length);
    for (const submittedJob of submitted) {
      const job = store.getRecord(submittedJob.id)!;
      assert.equal(job.status, "completed", `${job.filename} failed: ${job.error}`);
      const transcript = JSON.parse(await fs.readFile(job.paths.transcript, "utf8"));
      assert.ok(transcript.segments.length > 0, `${job.filename} produced no speech transcript`);
      const analysis = await readAnalysis(job.paths.highlights);
      assert.ok(analysis.candidates.length > 0, `${job.filename} produced no highlight candidate`);
      const clip = await createClip(job.id, job.paths.directory, job.paths.input, analysis.candidates[0]!, job.durationSeconds, transcript, true);
      let finalClip = clip;
      const deadline = Date.now() + 180_000;
      while (["queued", "extracting", "tracking_subject", "preparing_vertical", "rendering_captions", "validating_output"].includes(finalClip.status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        finalClip = (await readClips(job.paths.directory)).find((item) => item.id === clip.id) ?? finalClip;
      }
      assert.equal(finalClip.status, "ready", `${job.filename} clip failed: ${finalClip.error}`);
      assert.equal(finalClip.qa?.status, "passed", `${job.filename} final media QA failed`);
      assert.equal(finalClip.width, 1080);
      assert.equal(finalClip.height, 1920);
      assert.ok(finalClip.captionCueCount > 0);
      const artifact = clipFilePath(job.paths.directory, finalClip.id, "final");
      const stat = await fs.stat(artifact);
      assert.ok(stat.size > 0);
      summaries.push({ filename: job.filename, jobStatus: job.status, transcriptSegments: transcript.segments.length, candidateCount: analysis.candidates.length, clipStatus: finalClip.status, resolution: `${finalClip.width}x${finalClip.height}`, duration: finalClip.qa?.media?.formatDurationSeconds, captions: finalClip.captionCueCount, qaChecks: finalClip.qa?.checks.map((check) => `${check.id}:${check.status}`) });
      t.diagnostic(`Batch item QA: ${JSON.stringify(summaries.at(-1))}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  assert.equal(summaries.length, inputFiles.length);
});
