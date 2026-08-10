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
    preparation_notes?: string;
    preparation_contact_notes?: string;
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
      confidence: number;
      evidence: string;
    }>;
    warnings?: string[];
  } | null;
  error: string | null;
  created_at: string;
}

export type FoodKind = "material" | "prepared_food" | "beverage" | "commercial_product";

export interface FoodItem {
  id: string;
  user_id: string | null;
  canonical_name: string;
  food_kind: FoodKind;
  attributes: Record<string, unknown>;
  archived_at: string | null;
}

export interface Recipe {
  id: string;
  user_id: string;
  name: string;
  output_food_item_id: string;
  derived_from_recipe_id: string | null;
  attributes: Record<string, unknown>;
  archived_at: string | null;
}

export interface RecipeVersion {
  id: string;
  user_id?: string;
  recipe_id: string;
  version_number: number;
  yield_amount: number | null;
  yield_unit: string | null;
  instructions: string | null;
  attributes?: Record<string, unknown>;
  source_method?: string;
  effective_to: string | null;
  review_state: string;
}

export interface RecipeComponent {
  id: string;
  recipe_version_id: string;
  component_food_item_id: string;
  source_recipe_version_id: string | null;
  amount: number | null;
  unit: string | null;
  quantity_text: string | null;
  component_order: number;
  optional: boolean;
  notes: string | null;
}

export interface FoodBatch {
  id: string;
  user_id: string;
  food_item_id: string;
  recipe_version_id: string | null;
  produced_by_event_id: string | null;
  amount: number | null;
  remaining_amount: number | null;
  unit: string | null;
  prepared_at: string;
  exhausted_at: string | null;
  attributes: Record<string, unknown>;
}

export interface CaptureSession {
  id: string;
  source_type: "photo" | "voice" | "text" | "manual" | "import" | "mixed";
  artifact_id: string | null;
  occurred_at: string;
  recorded_timezone: string;
  original_text: string | null;
  transcript: string | null;
  status: "draft" | "queued" | "processing" | "ready" | "confirmed" | "failed" | "discarded";
  error: string | null;
  attributes: Record<string, unknown>;
}

export interface CaptureReviewField {
  id: string;
  capture_session_id: string;
  field_key: string;
  proposed_value: unknown;
  confirmed_value: unknown | null;
  confirmation_state: "unconfirmed" | "confirmed";
  evidence: unknown[];
  provenance: Record<string, unknown>;
}

export interface CaptureIngredientGuess {
  name: string;
  confidence: number;
  evidence: string;
  basis: Array<"visible" | "spoken" | "matched_recipe" | "personal_pattern">;
}

export interface ActivityProposal {
  id: string;
  proposal_order: number;
  activity_type: string;
  label: string | null;
  generic_guess: {
    label?: string;
    ingredients?: CaptureIngredientGuess[];
    attributes?: Record<string, unknown>;
    warnings?: string[];
  };
  personalized_guess: {
    label?: string;
    ingredients?: CaptureIngredientGuess[];
    attributes?: Record<string, unknown>;
    warnings?: string[];
  };
  warnings: string[];
}

export interface ProposalCandidate {
  id: string;
  activity_proposal_id: string;
  candidate_order: number;
  candidate_kind: "recipe" | "food_item" | "concept" | "prior_event";
  recipe_id: string | null;
  food_item_id: string | null;
  concept_id: string | null;
  prior_event_id: string | null;
  score: number;
  explanation: string;
  snapshot: {
    recipe_id?: string;
    recipe_version_id?: string;
    recipe_version_number?: number;
    output_food_item_id?: string;
    concept_version_id?: string;
    concept_type?: string;
    name?: string;
    ingredients?: string[];
    ingredient_items?: Array<{id: string; name: string}>;
  };
}
