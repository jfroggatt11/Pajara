import {useEffect, useState} from "react";
import {supabase} from "../lib/supabase";
import type {FieldAssertion} from "../types";
import {StatusMessage} from "./StatusMessage";

export function ReviewQueue({refreshKey}: {refreshKey: number}) {
  const [items, setItems] = useState<FieldAssertion[]>([]);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const {data, error: loadError} = await supabase
      .from("field_assertions")
      .select("*, extraction_runs(model,provider,event_id)")
      .eq("review_state", "proposed")
      .order("created_at");
    if (loadError) setError(loadError.message);
    else setItems((data || []) as FieldAssertion[]);
  }

  useEffect(() => { void load(); }, [refreshKey]);

  async function decide(item: FieldAssertion, decision: "accepted" | "corrected" | "rejected") {
    let replacement: unknown = null;
    if (decision === "corrected") {
      const raw = editing[item.id] ?? JSON.stringify(item.proposed_value);
      try { replacement = JSON.parse(raw); } catch { replacement = raw; }
    }
    const {error: reviewError} = await supabase.rpc("review_field_assertion", {
      assertion_id: item.id,
      decision,
      replacement_value: replacement,
    });
    if (reviewError) setError(reviewError.message);
    else await load();
  }

  return (
    <section className="page">
      <header className="page-header">
        <div><span className="eyebrow">Human confirmation</span><h1>Review AI fields</h1></div>
        <p>Confidence describes extraction certainty, not whether something is a trigger.</p>
      </header>
      <StatusMessage error={error} />
      {items.length === 0 ? (
        <div className="empty"><h2>Nothing waiting</h2><p>Queued extraction results will appear here.</p></div>
      ) : (
        <div className="stack">
          {items.map((item) => (
            <article className="card assertion" key={item.id}>
              <div className="assertion-meta">
                <span>{item.field_path.replace("/attributes/", "").replace("/", "")}</span>
                <span className={item.confidence < 0.7 ? "confidence low" : "confidence"}>
                  {item.provenance_method === "transcribed"
                    && item.field_path === "/attributes/original_text"
                    ? "confidence unavailable"
                    : `${Math.round(item.confidence * 100)}% extraction confidence`}
                </span>
              </div>
              <pre>{JSON.stringify(item.proposed_value, null, 2)}</pre>
              <p className="evidence">Evidence: {item.evidence?.text || "No excerpt supplied"}</p>
              <p className="evidence">
                Provenance: {item.provenance_method.replaceAll("_", " ")}
                {item.extraction_runs
                  ? ` · ${item.extraction_runs.provider}/${item.extraction_runs.model}`
                  : ""}
              </p>
              <details>
                <summary>Edit value</summary>
                <textarea
                  rows={3}
                  value={editing[item.id] ?? JSON.stringify(item.proposed_value)}
                  onChange={(event) => setEditing({...editing, [item.id]: event.target.value})}
                />
              </details>
              <div className="button-row">
                <button className="primary small" onClick={() => void decide(item, "accepted")}>Accept</button>
                <button className="secondary small" onClick={() => void decide(item, "corrected")}>Save correction</button>
                <button className="text-button small" onClick={() => void decide(item, "rejected")}>Reject</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
