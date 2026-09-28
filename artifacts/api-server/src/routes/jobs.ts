import { Router, type IRouter } from "express";
import {
  CreateJobHeader,
  GetJobParams,
  GetTranscriptParams,
  GetTranscriptResponse,
  GetJobResponse,
  ListJobsResponse,
  CreateJobResponse,
  AnalyzeHighlightsResponse,
  GetHighlightsParams,
  GetHighlightsResponse,
  UpdateHighlightCandidateBody,
  UpdateHighlightCandidateParams,
  UpdateHighlightCandidateResponse,
} from "@workspace/api-zod";
import { jobStore } from "../media/pipeline";
import {
  analyzeAndSave,
  readAnalysis,
  updateCandidate,
} from "../media/highlights";
import { clipFilePath, createClip, readClips } from "../media/clips";
import { promises as fs } from "node:fs";
import path from "node:path";

const router: IRouter = Router();

router.get("/jobs", async (_req, res) => {
  await jobStore.ready;
  res.json(ListJobsResponse.parse(jobStore.list()));
});

router.post("/jobs", async (req, res) => {
  await jobStore.ready;
  const header = CreateJobHeader.safeParse({
    "X-File-Name": req.header("X-File-Name"),
  });
  if (!header.success) {
    res.status(400).json({ error: "X-File-Name is required." });
    return;
  }
  if (!req.is("application/octet-stream")) {
    res.status(400).json({ error: "Upload the video as application/octet-stream." });
    return;
  }

  try {
    const job = await jobStore.create(header.data["X-File-Name"], req);
    res.status(202).json(CreateJobResponse.parse(job));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Upload failed.",
    });
  }
});

router.get("/jobs/:jobId", async (req, res) => {
  await jobStore.ready;
  const params = GetJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid job id." });
    return;
  }
  const job = jobStore.get(params.data.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }
  res.json(GetJobResponse.parse(job));
});

router.get("/jobs/:jobId/transcript", async (req, res) => {
  await jobStore.ready;
  const params = GetTranscriptParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid job id." });
    return;
  }
  const job = jobStore.getRecord(params.data.jobId);
  if (!job || job.status !== "completed") {
    res.status(404).json({ error: "Transcript is not available yet." });
    return;
  }
  try {
    const transcript = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(job.paths.transcript, "utf8"),
      ),
    );
    res.json(GetTranscriptResponse.parse({ ...transcript, jobId: job.id }));
  } catch {
    res.status(404).json({ error: "Saved transcript could not be read." });
  }
});

router.get("/jobs/:jobId/highlights", async (req, res) => {
  await jobStore.ready;
  const params = GetHighlightsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid job id." });
    return;
  }
  const job = jobStore.getRecord(params.data.jobId);
  if (!job || job.status !== "completed") {
    res.status(404).json({ error: "Completed transcript is not available yet." });
    return;
  }
  try {
    const analysis = await readAnalysis(job.paths.highlights);
    res.json(GetHighlightsResponse.parse(analysis));
  } catch {
    res.status(404).json({ error: "Highlight analysis is not available yet." });
  }
});

router.post("/jobs/:jobId/highlights", async (req, res) => {
  await jobStore.ready;
  const params = GetHighlightsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid job id." });
    return;
  }
  const job = jobStore.getRecord(params.data.jobId);
  if (!job || job.status !== "completed") {
    res.status(404).json({ error: "Completed transcript is not available yet." });
    return;
  }
  try {
    const transcript = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(job.paths.transcript, "utf8"),
      ),
    );
    const analysis = await analyzeAndSave(
      job.id,
      transcript,
      job.paths.highlights,
    );
    res.json(AnalyzeHighlightsResponse.parse(analysis));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Highlight analysis failed.",
    });
  }
});

router.patch("/jobs/:jobId/highlights/:candidateId", async (req, res) => {
  await jobStore.ready;
  const params = UpdateHighlightCandidateParams.safeParse(req.params);
  const body = UpdateHighlightCandidateBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Start and end timestamps are required." });
    return;
  }
  const job = jobStore.getRecord(params.data.jobId);
  if (!job || job.status !== "completed") {
    res.status(404).json({ error: "Completed highlight analysis is not available." });
    return;
  }
  try {
    const candidate = await updateCandidate(
      job.paths.highlights,
      params.data.candidateId,
      body.data.start,
      body.data.end,
      job.durationSeconds,
    );
    if (!candidate) {
      res.status(404).json({ error: "Highlight candidate not found." });
      return;
    }
    res.json(UpdateHighlightCandidateResponse.parse(candidate));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Candidate update failed.",
    });
  }
});

router.post("/jobs/:jobId/clips", async (req, res) => {
  await jobStore.ready;
  const job = jobStore.getRecord(req.params.jobId);
  const candidateId = req.body?.candidateId;
  if (!job || job.status !== "completed") {
    res.status(404).json({ error: "Completed job not found." });
    return;
  }
  if (typeof candidateId !== "string" || !candidateId) {
    res.status(400).json({ error: "candidateId is required." });
    return;
  }
  try {
    const analysis = await readAnalysis(job.paths.highlights);
    const candidate = analysis.candidates.find((item) => item.id === candidateId);
    if (!candidate) {
      res.status(404).json({ error: "Highlight candidate not found." });
      return;
    }
    const clip = await createClip(job.id, job.paths.directory, job.paths.input, candidate, job.durationSeconds);
    res.status(202).json(clip);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Clip generation could not start." });
  }
});

router.get("/jobs/:jobId/clips", async (req, res) => {
  await jobStore.ready;
  const job = jobStore.getRecord(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }
  try {
    res.json({ clips: await readClips(job.paths.directory) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Clip metadata could not be read." });
  }
});

router.get("/jobs/:jobId/clips/:clipId/:variant", async (req, res) => {
  await jobStore.ready;
  const job = jobStore.getRecord(req.params.jobId);
  const variant = req.params.variant;
  if (!job || (variant !== "preview" && variant !== "vertical")) {
    res.status(404).json({ error: "Clip file not found." });
    return;
  }
  try {
    const clips = await readClips(job.paths.directory);
    const clip = clips.find((item) => item.id === req.params.clipId && item.status === "ready");
    if (!clip) {
      res.status(404).json({ error: "Generated clip is not ready." });
      return;
    }
    const file = clipFilePath(job.paths.directory, clip.id, variant);
    await fs.access(file);
    res.type("video/mp4").sendFile(path.resolve(file));
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "Generated clip file is unavailable." });
  }
});

export default router;
