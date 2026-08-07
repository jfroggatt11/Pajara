import {useEffect, useState} from "react";
import type {Session} from "@supabase/supabase-js";
import {apiPost} from "../lib/api";
import {supabase} from "../lib/supabase";
import type {EventRecord, Observation} from "../types";
import {SaveMealAsRecipe} from "./SaveMealAsRecipe";

interface EventConceptLink {
  id: string;
  event_id: string;
  role: string;
  amount: number | null;
  unit: string | null;
  body_area_code: string | null;
  route: string | null;
  ingestion_method: string | null;
  recipe_version_id: string | null;
  concepts: {canonical_name: string; concept_type: string} | null;
  food_items: {canonical_name: string; food_kind: string} | null;
}

interface EventRelationLink {
  from_event_id: string;
  to_event_id: string;
  relation_type: string;
}

export function Timeline({
  session,
  refreshKey,
  onChanged,
}: {
  session: Session;
  refreshKey: number;
  onChanged: () => void;
}) {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [conceptLinks, setConceptLinks] = useState<EventConceptLink[]>([]);
  const [eventRelations, setEventRelations] = useState<EventRelationLink[]>([]);

  useEffect(() => {
    void Promise.all([
      supabase.from("events").select("*").order("occurred_start", {ascending: false}).limit(100),
      supabase.from("observations").select("*").order("observed_at", {ascending: false}).limit(500),
      supabase
        .from("event_concepts")
        .select("id,event_id,role,amount,unit,body_area_code,route,ingestion_method,recipe_version_id,concepts(canonical_name,concept_type),food_items(canonical_name,food_kind)")
        .order("created_at", {ascending: false})
        .limit(500),
      supabase
        .from("event_relations")
        .select("from_event_id,to_event_id,relation_type")
        .eq("relation_type", "prepared_by")
        .limit(500),
    ]).then(([eventResult, observationResult, conceptsResult, relationsResult]) => {
      setEvents((eventResult.data || []) as EventRecord[]);
      setObservations((observationResult.data || []) as Observation[]);
      setConceptLinks((conceptsResult.data || []) as unknown as EventConceptLink[]);
      setEventRelations((relationsResult.data || []) as EventRelationLink[]);
    });
  }, [refreshKey]);

  async function deleteEvent(eventId: string) {
    if (!window.confirm("Delete this event and its linked observations and private media?")) return;
    await apiPost("/v1/jobs/deletion", session, {
      scope: "event",
      event_id: eventId,
      confirmation: "DELETE EVENT",
    });
    onChanged();
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
          const hasSavedRecipe = linkedItems.some(
            (item) => item.role === "consumed" && Boolean(item.recipe_version_id),
          );
          const preparationRelation = eventRelations.find(
            (relation) =>
              relation.from_event_id === event.id
              && relation.relation_type === "prepared_by",
          );
          const preparationEvent = events.find(
            (candidate) => candidate.id === preparationRelation?.to_event_id,
          );
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
                        {item.food_items?.canonical_name
                          || item.concepts?.canonical_name
                          || "Saved item"} · {item.role}
                        {item.amount !== null
                          ? ` · ${item.amount}${item.unit ? ` ${item.unit}` : ""}`
                          : ""}
                        {item.body_area_code
                          ? ` · ${item.body_area_code.replaceAll("_", " ")}`
                          : ""}
                        {item.route ? ` · ${item.route}` : ""}
                        {item.ingestion_method
                          ? ` · ${item.ingestion_method.replaceAll("_", " ")}`
                          : ""}
                      </span>
                    ))}
                  </div>
                )}
                {event.type_code === "meal" && !hasSavedRecipe && (
                  <SaveMealAsRecipe
                    mealEventId={event.id}
                    defaultName={event.label || ""}
                    defaultMethod={
                      typeof preparationEvent?.attributes.preparation_method === "string"
                        ? preparationEvent.attributes.preparation_method
                        : ""
                    }
                    defaultContact={
                      typeof preparationEvent?.attributes.skin_contact_description === "string"
                        ? preparationEvent.attributes.skin_contact_description
                        : ""
                    }
                    onSaved={onChanged}
                  />
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
