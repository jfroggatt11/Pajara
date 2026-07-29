import {useEffect, useState} from "react";
import type {Session} from "@supabase/supabase-js";
import {apiPost} from "../lib/api";
import {supabase} from "../lib/supabase";
import type {EventRecord, Observation} from "../types";

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

  useEffect(() => {
    void Promise.all([
      supabase.from("events").select("*").order("occurred_start", {ascending: false}).limit(100),
      supabase.from("observations").select("*").order("observed_at", {ascending: false}).limit(500),
    ]).then(([eventResult, observationResult]) => {
      setEvents((eventResult.data || []) as EventRecord[]);
      setObservations((observationResult.data || []) as Observation[]);
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
