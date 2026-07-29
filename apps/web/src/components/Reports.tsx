import {useEffect, useState} from "react";
import type {Session} from "@supabase/supabase-js";
import {apiPost} from "../lib/api";
import {supabase} from "../lib/supabase";
import {StatusMessage} from "./StatusMessage";

interface AnalysisRun {
  id: string;
  question: string;
  status: string;
  evidence_strength: string | null;
  result: {limitations?: string[]; symptom_observation_count?: number} | null;
  created_at: string;
}

interface GeneratedReport {
  id: string;
  artifact_id: string | null;
  summary: string | null;
  created_at: string;
  artifact?: {bucket: string; object_path: string};
}

export function Reports({session, refreshKey}: {session: Session; refreshKey: number}) {
  const [runs, setRuns] = useState<AnalysisRun[]>([]);
  const [reports, setReports] = useState<GeneratedReport[]>([]);
  const [question, setQuestion] = useState("What changed before recent symptom worsening?");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function load() {
    const [runResult, reportResult] = await Promise.all([
      supabase.from("analysis_runs").select("*").order("created_at", {ascending: false}),
      supabase.from("reports").select("id,artifact_id,summary,created_at").order("created_at", {ascending: false}),
    ]);
    setRuns((runResult.data || []) as AnalysisRun[]);

    const generated = (reportResult.data || []) as GeneratedReport[];
    const artifactIds = generated.flatMap((report) => report.artifact_id ? [report.artifact_id] : []);
    if (artifactIds.length === 0) {
      setReports(generated);
      return;
    }
    const {data: artifacts} = await supabase
      .from("artifacts")
      .select("id,bucket,object_path")
      .in("id", artifactIds);
    const byId = new Map((artifacts || []).map((artifact) => [artifact.id, artifact]));
    setReports(generated.map((report) => ({
      ...report,
      artifact: report.artifact_id ? byId.get(report.artifact_id) : undefined,
    })));
  }
  useEffect(() => { void load(); }, [refreshKey]);

  async function requestAnalysis() {
    try {
      await apiPost("/v1/jobs/analysis", session, {question, window_days: 30});
      setSuccess("Analysis queued. Refresh shortly to see the result.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not queue analysis.");
    }
  }

  async function requestReport(analysisRunId: string) {
    try {
      await apiPost("/v1/jobs/report", session, {analysis_run_id: analysisRunId});
      setSuccess("Private HTML report queued.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not queue report.");
    }
  }

  async function openReport(report: GeneratedReport) {
    if (!report.artifact) return;
    const {data, error: signedError} = await supabase.storage
      .from(report.artifact.bucket)
      .createSignedUrl(report.artifact.object_path, 60);
    if (signedError) setError(signedError.message);
    else window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <section className="page">
      <header className="page-header">
        <div><span className="eyebrow">Uncertainty first</span><h1>Analysis & reports</h1></div>
        <p>The prototype uses trusted data for descriptive summaries, not causal claims.</p>
      </header>
      <div className="card stack">
        <label>Question<input value={question} onChange={(event) => setQuestion(event.target.value)} /></label>
        <button className="primary" onClick={() => void requestAnalysis()}>Run descriptive analysis</button>
        <StatusMessage error={error} success={success} />
      </div>
      <div className="stack">
        {runs.map((run) => (
          <article className="card" key={run.id}>
            <div className="timeline-title"><h2>{run.question}</h2><span className={`trust ${run.status}`}>{run.status.replace("_", " ")}</span></div>
            <p>Evidence: <strong>{run.evidence_strength?.replaceAll("_", " ") || "waiting"}</strong></p>
            {run.result?.symptom_observation_count !== undefined && <p>{run.result.symptom_observation_count} trusted symptom observations included.</p>}
            {run.result?.limitations?.slice(0, 2).map((limitation) => <p className="evidence" key={limitation}>{limitation}</p>)}
            {run.result && <button className="secondary small" onClick={() => void requestReport(run.id)}>Generate private report</button>}
          </article>
        ))}
      </div>
      <div className="section-heading">
        <div><span className="eyebrow">Private output</span><h2>Generated reports</h2></div>
        <button className="text-button" onClick={() => void load()}>Refresh</button>
      </div>
      <div className="stack">
        {reports.map((report) => (
          <article className="card" key={report.id}>
            <p>{report.summary || "Descriptive personal tracking report"}</p>
            <small>{new Date(report.created_at).toLocaleString()}</small>
            {report.artifact && (
              <button className="secondary small" onClick={() => void openReport(report)}>
                Open private HTML report
              </button>
            )}
          </article>
        ))}
        {reports.length === 0 && <p className="evidence">No completed reports yet.</p>}
      </div>
    </section>
  );
}
