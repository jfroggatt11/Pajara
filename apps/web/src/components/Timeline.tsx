import {useEffect, useState} from "react";
import type {Session} from "@supabase/supabase-js";
import {apiPost} from "../lib/api";
import {supabase} from "../lib/supabase";
import type {EventRecord, Observation} from "../types";

interface EventConceptLink {
  id: string;
  event_id: string;
  role: string;
  amount: number | null;
  unit: string | null;
  body_area_code: string | null;
  route: string | null;
  concepts: {canonical_name: string; concept_type: string} | null;
}

export function Timeline({
  session,
  refreshKey,
  onDeleted,
}: {
  session: Session;
  refreshKey: number;
  onDeleted: () => void;
}) {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [conceptLinks, setConceptLinks] = useState<EventConceptLink[]>([]);

  useEffect(() => {
    void Promise.all([
      supabase.from("events").select("*").order("occurred_start", {ascending: false}).limit(100),
      supabase.from("observations").select("*").order("observed_at", {ascending: false}).limit(500),
      supabase
        .from("event_concepts")
        .select("id,event_id,role,amount,unit,body_area_code,route,concepts(canonical_name,concept_type)")
        .order("created_at", {ascending: false})
        .limit(500),
    ]).then(([eventResult, observationResult, conceptsResult]) => {
      setEvents((eventResult.data || []) as EventRecord[]);
      setObservations((observationResult.data || []) as Observation[]);
      setConceptLinks((conceptsResult.data || []) as unknown as EventConceptLink[]);
    });
  }, [refreshKey]);

  async function deleteEvent(eventId: string) {
    if (!window.confirm("Delete this event and its linked observations and private media?")) return;
    await apiPost("/v1/jobs/deletion", session, {
      scope: "event",
      event_id: eventId,
      confirmation: "DELETE EVENT",
    });
    onDeleted();
  }

  return (
    <section className="page">
      <header className="page-header">
        <div><span className="eyebrow">Your record</span><h1>Timeline</h1></div>
        <p>Pending AI data is marked and excluded from trends until reviewed.</p>
      </header>
      <div className="timeline">
        {events.map((event) => {
          const scores = observations.filter((item) => item.event_id === event.id);
          const linkedItems = conceptLinks.filter((item) => item.event_id === event.id);
          return (
            <article className="timeline-item" key={event.id}>
              <time>{new Date(event.occurred_start).toLocaleString()}</time>
              <div className="timeline-card">
                <div className="timeline-title">
                  <h2>{event.label || event.type_code.replaceAll("_", " ")}</h2>
                  <span className={`trust ${event.trust_status}`}>{event.trust_status.replace("_", " ")}</span>
                </div>
                {typeof event.attributes.original_text === "string" && <p>{event.attributes.original_text}</p>}
                {scores.length > 0 && (
                  <div className="score-chips">
                    {scores.map((score) => <span key={score.id}>{score.type_code} {score.numeric_value}/10</span>)}
                  </div>
                )}
                {linkedItems.length > 0 && (
                  <div className="linked-items">
                    {linkedItems.map((item) => (
                      <span key={item.id}>
                        {item.concepts?.canonical_name || "Saved item"} · {item.role}
                        {item.amount !== null
                          ? ` · ${item.amount}${item.unit ? ` ${item.unit}` : ""}`
                          : ""}
                        {item.body_area_code
                          ? ` · ${item.body_area_code.replaceAll("_", " ")}`
                          : ""}
                        {item.route ? ` · ${item.route}` : ""}
                      </span>
                    ))}
                  </div>
                )}
                <button className="text-button small" onClick={() => void deleteEvent(event.id)}>Delete entry</button>
              </div>
            </article>
          );
        })}
        {events.length === 0 && <div className="empty"><h2>No entries yet</h2><p>Your check-ins and logs will appear here.</p></div>}
      </div>
    </section>
  );
}
