export type View =
  | "home"
  | "checkin"
  | "log"
  | "review"
  | "timeline"
  | "photos"
  | "trends"
  | "reports"
  | "settings";

export interface Profile {
  id: string;
  user_id: string;
  display_name: string;
  timezone: string;
  locale: string;
  consent_at: string | null;
  ai_enabled: boolean;
}

export interface BodyArea {
  code: string;
  label: string;
  parent_code: string | null;
  display_order: number;
}

export interface EventRecord {
  id: string;
  user_id: string;
  type_code: string;
  occurred_start: string;
  occurred_end: string | null;
  label: string | null;
  attributes: Record<string, unknown>;
  trust_status: "draft" | "pending_review" | "trusted" | "rejected";
  source_method: string;
}

export interface Observation {
  id: string;
  event_id: string | null;
  body_area_code: string | null;
  type_code: string;
  observed_at: string;
  numeric_value: number | null;
  trust_status: string;
}

export interface FieldAssertion {
  id: string;
  target_id: string;
  field_path: string;
  proposed_value: unknown;
  confidence: number;
  evidence: {text?: string};
  provenance_method: string;
  review_state: string;
  extraction_runs?: {
    model: string;
    provider: string;
    event_id: string;
  };
}
