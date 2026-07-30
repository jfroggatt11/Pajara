export type View =
  | "home"
  | "checkin"
  | "log"
  | "catalogue"
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

export type CatalogueItemType = "product" | "medication" | "treatment" | "recipe";

export interface CatalogueItem {
  id: string;
  user_id: string;
  concept_type: CatalogueItemType;
  canonical_name: string;
  attributes: {
    brand?: string;
    variant?: string;
    category?: string;
    form?: string;
    strength?: string;
    favorite?: boolean;
    last_used_at?: string;
    servings?: number;
    preparation_notes?: string;
  };
  archived_at: string | null;
  created_at: string;
}

export interface ConceptVersion {
  id: string;
  concept_id: string;
  version_number: number;
  effective_from: string;
  effective_to: string | null;
  attributes: Record<string, unknown>;
  review_state: string;
}

export interface CatalogueExtraction {
  id: string;
  concept_id: string;
  artifact_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  review_state: "proposed" | "accepted" | "corrected" | "rejected" | "superseded";
  provider: string;
  model: string;
  proposal: {
    product_name?: string | null;
    product_name_confidence?: number | null;
    product_name_evidence?: string | null;
    brand?: string | null;
    brand_confidence?: number | null;
    brand_evidence?: string | null;
    variant?: string | null;
    variant_confidence?: number | null;
    variant_evidence?: string | null;
    ingredients?: Array<{
      name: string;
      amount?: number | null;
      unit?: string | null;
      confidence: number;
      evidence: string;
    }>;
    warnings?: string[];
  } | null;
  error: string | null;
  created_at: string;
}
