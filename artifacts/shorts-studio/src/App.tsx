import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useCreateJob, useGetJob, useGetTranscript, useHealthCheck, useListJobs, getGetJobQueryKey, getGetTranscriptQueryKey, getListJobsQueryKey, type Job, type JobStatus, type TranscriptSegment, type TranscriptWord } from '@workspace/api-client-react';
import { Activity, AlertCircle, AudioLines, Check, ChevronDown, Clock3, FileVideo, Film, HardDrive, Inbox, Languages, Loader2, LockKeyhole, MoreHorizontal, RefreshCw, RotateCcw, Sparkles, UploadCloud, Video, X } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();
const runningStatuses: JobStatus[] = ['queued', 'validating', 'extracting_audio', 'transcribing'];

function formatTime(seconds?: number | null) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function titleForStatus(status: JobStatus) {
  const labels: Record<JobStatus, string> = {
    queued: 'Queued',
    validating: 'Validating media',
    extracting_audio: 'Extracting audio',
    transcribing: 'Writing transcript',
    completed: 'Ready to review',
    failed: 'Processing stopped',
  };
  return labels[status];
}

function statusDetail(status: JobStatus) {
  const details: Record<JobStatus, string> = {
    queued: 'Your file is next in line.',
    validating: 'Checking the media stream and duration.',
    extracting_audio: 'Separating a clean local audio track.',
    transcribing: 'Matching words to their exact moments.',
    completed: 'Everything is ready on this device.',
    failed: 'This file could not be processed.',
  };
  return details[status];
}

function StatusDot({ status }: { status: JobStatus }) {
  const tone = status === 'completed' ? 'bg-emerald-500' : status === 'failed' ? 'bg-red-500' : 'bg-[hsl(var(--primary))]';
  return <span className={`relative inline-flex h-2 w-2 shrink-0 rounded-full ${tone}`}><span className={`absolute inset-0 rounded-full ${status === 'completed' || status === 'failed' ? '' : 'animate-ping bg-inherit opacity-70'}`} /></span>;
}

function JobRow({ job, selected, onSelect }: { job: Job; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} data-testid={`button-select-job-${job.id}`} className={`group flex w-full items-center gap-3 border-b border-sidebar-border px-4 py-3.5 text-left transition-colors ${selected ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60'}`}>
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${selected ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'bg-sidebar-accent text-sidebar-foreground/75'}`}>
        <FileVideo size={17} strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold text-sidebar-foreground" data-testid={`text-job-filename-${job.id}`}>{job.filename}</p>
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-sidebar-foreground/55">
          <StatusDot status={job.status} />
          <span>{titleForStatus(job.status)}</span>
          {job.durationSeconds ? <><span className="opacity-40">·</span><span>{formatTime(job.durationSeconds)}</span></> : null}
        </div>
      </div>
      {selected ? <ChevronDown size={14} className="-rotate-90 text-[hsl(var(--primary))]" /> : <MoreHorizontal size={15} className="text-sidebar-foreground/30 opacity-0 transition-opacity group-hover:opacity-100" />}
    </button>
  );
}

function DropZone({ file, onFile, onClear, onInvalid }: { file: File | null; onFile: (file: File) => void; onClear: () => void; onInvalid: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const acceptFile = (nextFile?: File) => {
    if (nextFile && (nextFile.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|avi)$/i.test(nextFile.name))) onFile(nextFile);
    else if (nextFile) onInvalid();
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    acceptFile(event.dataTransfer.files[0]);
  };
  return (
    <div className={`relative overflow-hidden rounded-2xl border border-dashed transition-all ${dragging ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/.09)]' : 'border-[hsl(var(--foreground)/.16)] bg-[hsl(var(--card))] hover:border-[hsl(var(--primary)/.65)]'}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} data-testid="dropzone-video">
      <input ref={inputRef} type="file" accept="video/*,.mp4,.mov,.webm" className="hidden" data-testid="input-video-file" onChange={(event) => acceptFile(event.target.files?.[0])} />
      {file ? (
        <div className="flex items-center gap-4 px-5 py-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[hsl(var(--primary)/.16)] text-[hsl(var(--primary-foreground))]"><Film size={22} className="text-[hsl(var(--primary))]" /></div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold" data-testid="text-selected-filename">{file.name}</p>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">{formatBytes(file.size)} · {file.type || 'video file'} · local only</p>
          </div>
          <button type="button" onClick={onClear} aria-label="Remove selected video" data-testid="button-clear-file" className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><X size={17} /></button>
        </div>
      ) : (
        <button type="button" onClick={() => inputRef.current?.click()} data-testid="button-browse-video" className="flex w-full flex-col items-center justify-center px-6 py-12 text-center">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[hsl(var(--primary)/.15)] text-[hsl(var(--primary))] transition-transform duration-300 group-hover:scale-105"><UploadCloud size={25} strokeWidth={1.7} /></span>
          <span className="text-sm font-bold">Drop a video here</span>
          <span className="mt-1.5 text-xs text-muted-foreground">or <span className="text-[hsl(var(--accent))] underline underline-offset-2">browse your files</span></span>
          <span className="mt-5 font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground/75">MP4 · MOV · WEBM · up to 2 GB</span>
        </button>
      )}
    </div>
  );
}

function ProcessingRail({ job }: { job: Job }) {
  const steps: Array<{ key: JobStatus; label: string; icon: ReactNode }> = [
    { key: 'validating', label: 'Validate media', icon: <Video size={15} /> },
    { key: 'extracting_audio', label: 'Extract audio', icon: <AudioLines size={15} /> },
    { key: 'transcribing', label: 'Word-level transcript', icon: <Languages size={15} /> },
  ];
  const order = ['queued', 'validating', 'extracting_audio', 'transcribing', 'completed'];
  const current = order.indexOf(job.status);
  return (
    <div className="mt-7 rounded-2xl border border-border bg-card p-5 shadow-[0_12px_35px_hsl(var(--foreground)/.04)] animate-rise-in" data-testid="panel-processing-status">
      <div className="flex items-start justify-between gap-3">
        <div><div className="flex items-center gap-2"><StatusDot status={job.status} /><p className="text-sm font-bold">{titleForStatus(job.status)}</p></div><p className="mt-1 pl-4 text-xs text-muted-foreground">{statusDetail(job.status)}</p></div>
        <span className="font-mono text-sm font-medium text-[hsl(var(--primary-foreground))]">{Math.round(job.progress)}%</span>
      </div>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-[hsl(var(--primary))] transition-[width] duration-700 ease-out" style={{ width: `${job.progress}%` }} data-testid="progress-job" /></div>
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {steps.map((step, index) => {
          const stepIndex = order.indexOf(step.key);
          const complete = job.status === 'completed' || current > stepIndex;
          const active = job.status === step.key;
          return <div key={step.key} className={`flex items-center gap-2.5 text-xs ${complete ? 'text-emerald-700 dark:text-emerald-400' : active ? 'font-semibold text-foreground' : 'text-muted-foreground/55'}`}><span className={`flex h-7 w-7 items-center justify-center rounded-full border ${complete ? 'border-emerald-500/40 bg-emerald-500/10' : active ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/.14)]' : 'border-border'}`}>{complete ? <Check size={14} /> : active ? <Loader2 size={14} className="animate-spin" /> : step.icon}</span><span>{step.label}</span>{index < steps.length - 1 ? <span className="hidden h-px flex-1 bg-border sm:block" /> : null}</div>;
        })}
      </div>
    </div>
  );
}

function TranscriptViewer({ segmentList, language, duration }: { segmentList: TranscriptSegment[]; language?: string; duration?: number | null }) {
  const [activeSegment, setActiveSegment] = useState<number | null>(null);
  const [showWords, setShowWords] = useState(false);
  return (
    <section className="mt-7 overflow-hidden rounded-2xl border border-border bg-card shadow-[0_12px_35px_hsl(var(--foreground)/.04)] animate-rise-in" data-testid="panel-transcript">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div><div className="flex items-center gap-2"><Sparkles size={16} className="text-[hsl(var(--accent))]" /><h2 className="text-sm font-extrabold tracking-tight">Transcript</h2></div><p className="mt-1 pl-6 text-xs text-muted-foreground">{language?.toUpperCase() || 'AUTO'} · {segmentList.length} segments · {formatTime(duration)}</p></div>
        <button type="button" onClick={() => setShowWords(!showWords)} data-testid="button-toggle-word-timing" className={`rounded-lg border px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] transition-colors ${showWords ? 'border-[hsl(var(--primary)/.5)] bg-[hsl(var(--primary)/.1)] text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`}>{showWords ? 'Hide word timing' : 'Show word timing'}</button>
      </div>
      <div className="divide-y divide-border">
        {segmentList.length === 0 ? <div className="px-5 py-12 text-center text-sm text-muted-foreground" data-testid="empty-transcript">Transcript has no segments yet.</div> : segmentList.map((segment, index) => (
          <button type="button" key={segment.id} onClick={() => setActiveSegment(activeSegment === segment.id ? null : segment.id)} data-testid={`button-transcript-segment-${segment.id}`} className={`block w-full px-5 py-4 text-left transition-colors hover:bg-muted/55 ${activeSegment === segment.id ? 'bg-[hsl(var(--primary)/.07)]' : ''}`}>
            <div className="flex gap-4"><span className="w-10 shrink-0 pt-0.5 font-mono text-[10px] text-muted-foreground">{formatTime(segment.start)}</span><div className="min-w-0 flex-1"><p className="text-[13px] leading-6 text-foreground">{showWords && segment.words?.length ? segment.words.map((word: TranscriptWord, wordIndex: number) => <span key={`${word.word}-${wordIndex}`} className={`mr-1 rounded px-0.5 transition-colors ${activeSegment === segment.id ? 'hover:bg-[hsl(var(--primary)/.3)]' : ''}`} title={`${word.start.toFixed(2)}s – ${word.end.toFixed(2)}s · ${Math.round((word.probability ?? 1) * 100)}%`}>{word.word}</span>) : segment.text}</p><div className="mt-2 flex items-center gap-2 font-mono text-[10px] text-muted-foreground"><Clock3 size={11} /> {formatTime(segment.end - segment.start)}{activeSegment === segment.id ? <span className="text-[hsl(var(--accent))]">selected locally</span> : null}</div></div></div>
          </button>
        ))}
      </div>
    </section>
  );
}

function Home() {
  const queryClient = useQueryClient();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const jobsQuery = useListJobs({ query: { queryKey: getListJobsQueryKey() } });
  const jobs = useMemo(() => jobsQuery.data ?? [], [jobsQuery.data]);
  const selectedFromList = jobs.find((job) => job.id === selectedJobId);
  const activeId = selectedJobId ?? jobs[0]?.id ?? '';
  const jobQuery = useGetJob(activeId, { query: { enabled: Boolean(activeId), queryKey: getGetJobQueryKey(activeId), refetchInterval: (query) => { const data = query.state.data as Job | undefined; return data && runningStatuses.includes(data.status) ? 1400 : false; } } });
  const selectedJob = jobQuery.data ?? selectedFromList;
  const transcriptQuery = useGetTranscript(activeId, { query: { enabled: Boolean(activeId) && selectedJob?.status === 'completed', queryKey: getGetTranscriptQueryKey(activeId), retry: 1 } });
  const healthQuery = useHealthCheck({ query: { queryKey: ['/api/healthz'], staleTime: 30_000 } });
  const createJob = useCreateJob({ request: { headers: selectedFile ? { 'X-File-Name': selectedFile.name } : undefined } });

  useEffect(() => {
    if (!selectedJobId && jobs[0]) setSelectedJobId(jobs[0].id);
  }, [jobs, selectedJobId]);

  const chooseFile = useCallback((file: File) => { setSelectedFile(file); setUploadError(null); }, []);
  const upload = () => {
    if (!selectedFile) return;
    setUploadError(null);
    createJob.mutate({ data: selectedFile }, {
      onSuccess: (job) => {
        setSelectedFile(null);
        setSelectedJobId(job.id);
        void queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      },
      onError: (error) => setUploadError(error instanceof Error ? error.message : 'Upload could not be started.'),
    });
  };
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
    if (activeId) void queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(activeId) });
  };
  const displayJob = selectedJob;
  const hasJobs = jobs.length > 0;
  return (
    <div className="noise min-h-[100dvh] bg-background text-foreground">
      <div className="flex min-h-[100dvh]">
        <aside className="hidden w-[272px] shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
          <div className="flex h-[76px] items-center gap-3 border-b border-sidebar-border px-5">
            <div className="relative flex h-9 w-9 items-center justify-center rounded-[11px] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"><Activity size={19} strokeWidth={2.4} /><span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-sidebar bg-[hsl(var(--accent))]" /></div>
            <div><p className="text-[15px] font-extrabold tracking-[-.02em]">Shorts Studio</p><p className="font-mono text-[9px] uppercase tracking-[.18em] text-sidebar-foreground/50">local workbench</p></div>
          </div>
          <div className="flex items-center justify-between px-5 pb-3 pt-6"><p className="font-mono text-[10px] uppercase tracking-[.18em] text-sidebar-foreground/45">Your sessions</p><span className="rounded-full bg-sidebar-accent px-2 py-0.5 font-mono text-[10px] text-sidebar-foreground/65" data-testid="text-job-count">{jobs.length}</span></div>
          <div className="flex-1 overflow-y-auto">{jobsQuery.isLoading ? <div className="space-y-2 px-4 py-2">{[1, 2, 3].map((item) => <div key={item} className="h-14 animate-pulse rounded-xl bg-sidebar-accent/70" />)}</div> : jobsQuery.isError ? <div className="px-5 py-6 text-xs text-sidebar-foreground/65"><AlertCircle size={18} className="mb-2 text-[hsl(var(--accent))]" /><p>Sessions could not be loaded.</p><button type="button" onClick={() => void jobsQuery.refetch()} data-testid="button-retry-jobs" className="mt-3 font-semibold text-[hsl(var(--primary))]">Try again</button></div> : hasJobs ? jobs.map((job) => <JobRow key={job.id} job={job} selected={job.id === activeId} onSelect={() => setSelectedJobId(job.id)} />) : <div className="px-5 py-8 text-center"><Inbox size={22} className="mx-auto mb-3 text-sidebar-foreground/35" /><p className="text-xs leading-5 text-sidebar-foreground/55">Your processed videos<br />will live here.</p></div>}</div>
          <div className="border-t border-sidebar-border p-4"><div className="flex items-center gap-2.5 rounded-xl bg-sidebar-accent/60 px-3 py-3"><LockKeyhole size={14} className="text-emerald-400" /><div className="min-w-0"><p className="text-[11px] font-semibold text-sidebar-foreground">Private by design</p><p className="truncate text-[10px] text-sidebar-foreground/45">Files never leave this machine</p></div></div></div>
        </aside>
        <main className="min-w-0 flex-1">
          <header className="flex h-[76px] items-center justify-between border-b border-border px-5 sm:px-8">
            <div className="flex items-center gap-3 md:hidden"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"><Activity size={16} /></div><span className="text-sm font-extrabold">Shorts Studio</span></div>
            <div className="hidden items-center gap-2 text-xs text-muted-foreground md:flex"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /><span>Local processing active</span></div>
            <div className="ml-auto flex items-center gap-3"><div className="hidden items-center gap-2 font-mono text-[10px] uppercase tracking-[.12em] text-muted-foreground sm:flex"><span className={`h-1.5 w-1.5 rounded-full ${healthQuery.isError ? 'bg-red-500' : 'bg-emerald-500'}`} />{healthQuery.isError ? 'Service unavailable' : 'Engine ready'}</div><button type="button" onClick={refresh} data-testid="button-refresh-workspace" aria-label="Refresh workspace" className="rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><RefreshCw size={15} /></button></div>
          </header>
          <div className="grid-paper min-h-[calc(100dvh-76px)] overflow-y-auto">
            <div className="mx-auto max-w-[1120px] px-5 py-8 sm:px-8 sm:py-12 lg:px-12">
              <div className="animate-rise-in"><p className="font-mono text-[10px] font-medium uppercase tracking-[.2em] text-[hsl(var(--accent))]">01 / Ingest</p><h1 className="mt-3 max-w-2xl text-3xl font-extrabold leading-[1.08] tracking-[-.05em] sm:text-5xl">Turn a clip into<br /><span className="text-[hsl(var(--muted-foreground))]">something searchable.</span></h1><p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">Bring in a short-form video. Shorts Studio validates the media, pulls its audio, and maps every spoken word — locally.</p></div>
              <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(310px,.75fr)]">
                <div>
                  <DropZone file={selectedFile} onFile={chooseFile} onClear={() => setSelectedFile(null)} onInvalid={() => setUploadError('Choose a supported video file: MP4, MOV, or WEBM.')} />
                  {uploadError ? <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-red-500/25 bg-red-500/7 px-4 py-3 text-xs text-red-700 dark:text-red-300" data-testid="error-upload"><AlertCircle size={16} className="mt-0.5 shrink-0" /><div><p className="font-semibold">Upload could not start</p><p className="mt-0.5 opacity-80">{uploadError}</p></div></div> : null}
                  <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground"><LockKeyhole size={13} className="text-emerald-600" /><span>Local-first: your original file stays in your browser and local API.</span></div>
                  <button type="button" disabled={!selectedFile || createJob.isPending} onClick={upload} data-testid="button-start-processing" className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-5 py-3.5 text-sm font-extrabold text-[hsl(var(--primary-foreground))] shadow-[0_8px_22px_hsl(var(--primary)/.22)] transition-all hover:-translate-y-0.5 hover:shadow-[0_11px_27px_hsl(var(--primary)/.28)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0">{createJob.isPending ? <><Loader2 size={17} className="animate-spin" /> Starting local job…</> : <><UploadCloud size={17} /> Start processing</>}</button>
                </div>
                <div className="rounded-2xl border border-border bg-card/75 p-5 backdrop-blur-sm"><div className="flex items-center justify-between"><p className="font-mono text-[10px] uppercase tracking-[.18em] text-muted-foreground">Pipeline</p><span className="font-mono text-[10px] text-emerald-700 dark:text-emerald-400">on-device</span></div><div className="mt-6 space-y-0">{[['01', 'Validate', 'Video stream + duration'], ['02', 'Extract', 'Clean audio track'], ['03', 'Transcribe', 'Word-level timestamps']].map(([number, title, sub], index) => <div key={number} className="relative flex gap-3 pb-7 last:pb-0"><div className="relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[hsl(var(--primary)/.45)] bg-[hsl(var(--primary)/.1)] font-mono text-[10px] text-[hsl(var(--primary-foreground))]">{index === 2 ? <Sparkles size={13} className="text-[hsl(var(--primary))]" /> : number}</div>{index < 2 ? <span className="absolute left-[13px] top-7 h-full w-px bg-border" /> : null}<div><p className="text-sm font-bold">{title}</p><p className="mt-1 text-xs text-muted-foreground">{sub}</p></div></div>)}</div><div className="mt-7 border-t border-border pt-4 text-[11px] leading-5 text-muted-foreground">Nothing is uploaded to a third party. You can close the tab after processing and the session remains in your local workspace.</div></div>
              </div>
              {displayJob ? <div className="mt-10 border-t border-border pt-8"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="font-mono text-[10px] uppercase tracking-[.2em] text-[hsl(var(--accent))]">02 / Active session</p><h2 className="mt-2 max-w-xl truncate text-xl font-extrabold tracking-[-.03em] sm:text-2xl" data-testid="text-active-job">{displayJob.filename}</h2></div><div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5"><StatusDot status={displayJob.status} /><span className="text-xs font-semibold">{titleForStatus(displayJob.status)}</span></div></div>{displayJob.status === 'failed' ? <div className="mt-5 flex items-start gap-3 rounded-2xl border border-red-500/25 bg-red-500/7 p-4 text-sm" data-testid="error-job"><AlertCircle className="mt-0.5 shrink-0 text-red-600" size={18} /><div><p className="font-bold text-red-800 dark:text-red-300">This job needs attention</p><p className="mt-1 text-xs leading-5 text-red-700/80 dark:text-red-300/80">{displayJob.error || 'The local processor returned an unknown error.'}</p><button type="button" onClick={() => { setSelectedFile(null); setUploadError(null); }} data-testid="button-dismiss-error" className="mt-3 flex items-center gap-1.5 text-xs font-bold text-red-800 dark:text-red-300"><RotateCcw size={13} /> Choose another file</button></div></div> : displayJob.status !== 'completed' ? <ProcessingRail job={displayJob} /> : transcriptQuery.isLoading ? <div className="mt-7 h-48 animate-pulse rounded-2xl bg-card" data-testid="skeleton-transcript" /> : transcriptQuery.isError ? <div className="mt-7 rounded-2xl border border-border bg-card p-8 text-center" data-testid="error-transcript"><AlertCircle size={22} className="mx-auto mb-2 text-[hsl(var(--accent))]" /><p className="text-sm font-bold">Transcript is not available yet</p><button type="button" onClick={() => void transcriptQuery.refetch()} data-testid="button-retry-transcript" className="mt-3 text-xs font-bold text-[hsl(var(--accent))]">Try again</button></div> : transcriptQuery.data ? <TranscriptViewer segmentList={transcriptQuery.data.segments} language={transcriptQuery.data.language} duration={transcriptQuery.data.durationSeconds} /> : null}</div> : <div className="mt-12 rounded-2xl border border-border bg-card/45 px-6 py-10 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground"><HardDrive size={20} /></div><p className="mt-4 text-sm font-bold" data-testid="empty-active-job">No session selected</p><p className="mt-1 text-xs text-muted-foreground">Upload a video above to start your first local processing run.</p></div>}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function Router() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={Home} /><Route component={Home} /></Switch></RoutedErrorBoundary>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
