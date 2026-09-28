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

export default router;