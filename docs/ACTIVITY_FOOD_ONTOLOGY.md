# Activity and food ontology

## Decision

Pajara uses PostgreSQL as a relational store with a knowledge-graph-shaped domain model.
The graph is represented by typed, constrained edges rather than by moving the primary
data into a graph database. This keeps transactions, row-level tenant isolation, temporal
queries, and reporting simple while still supporting recursive recipes and graph-assisted
retrieval.

The model draws on four established patterns:

- [FoodOn](https://foodon.org/) separates food identity and processing context instead of
  treating every ingredient string as a unique object.
- [W3C PROV-O](https://www.w3.org/TR/prov-o/) separates entities, activities, and the
  provenance that connects them.
- [GS1 EPCIS transformation events](https://ref.gs1.org/standards/epcis/) distinguish a
  transformation plan from the actual input/output instance.
- [PostgreSQL recursive queries](https://www.postgresql.org/docs/current/queries-with.html)
  provide bounded traversal for nested recipe components. Database triggers reject cycles.

`schema.org/Recipe` remains useful for import/export vocabulary, but its flat
`recipeIngredient` text list is not the internal source of truth because it cannot preserve
exact nested versions or actual preparation/contact events.

## Core distinctions

| Meaning | Storage | Example |
| --- | --- | --- |
| Canonical edible identity | `food_items` | tomato, tomato sauce, coffee |
| Reusable preparation plan | `recipes` | Jonah's tomato sauce |
| Immutable plan snapshot | `recipe_versions` | tomato sauce v3 |
| Ingredient role in a plan | `recipe_components` | 200 g tomato in v3 |
| Actual produced instance | `food_batches` | the jar made Tuesday |
| Actual occurrence | `events` | lunch, preparation, shower, run |
| Entity participating in an occurrence | `event_concepts` | sauce consumed; tomato contacted |
| Raw input awaiting review | `capture_sessions` | private photo or voice note |
| Untrusted interpretation | `activity_proposals` | “probably tomato pasta” |
| Ranked retrieval option | `proposal_candidates` | saved pasta v2, score 0.81 |

“Ingredient” is a role, not a permanent class. Tomato and tomato sauce are both food
items; each becomes an ingredient only when referenced by a recipe component.

## Nested recipes

A component always references a `food_item`. If that food was produced by a reusable
sub-recipe, the same component also stores `source_recipe_version_id`. If the user means
specific leftovers rather than the general recipe, the preparation event stores a `used`
participant whose `food_batch_id` identifies the actual produced instance.

For example:

```text
lasagne v4
├── pasta sheets
├── béchamel → béchamel v2
│   ├── milk
│   ├── butter
│   └── flour
└── ragù → ragù v5
    ├── tomato
    └── beef
```

The version pin is deliberate. Editing béchamel later creates v3; it does not rewrite
lasagne v4 or past meals. `flatten_recipe_components` recursively returns the leaf foods
for search and exposure review. The database checks that a sub-recipe's output food matches
the component food and rejects cycles between exact versions. A newer recipe version may
refer to a finite older version of the same recipe, which is necessary to represent a new
batch made with leftovers without creating a cycle.

`food_batches` are created by confirmed `prepared` or `produced` event participants. The
ingredient picker orders unexhausted batches by `prepared_at` so recent leftovers appear
before reusable recipe definitions. Choosing one adds its producing recipe version to the
new recipe plan and the exact batch to the actual preparation event. This preserves both
“which formulation?” and “which actual batch?” without putting a one-off batch inside a
reusable plan.

## Store-bought foods and label photos

A packaged food is stored as a `food_item` with kind `commercial_product`, plus a versioned
recipe/formulation whose components are the label ingredients. This reuses the same nested
composition machinery while keeping the commercial product distinct from raw ingredients.

An ingredient-label photo follows a proposal-and-review boundary:

```text
private label artifact → extracted name/ingredient proposal → editable review
                       → explicit confirmation → commercial product + formulation version
```

The source artifact, capture, extraction model, and per-component provenance are retained.
No OCR or model output becomes a trusted formulation until the user confirms the product
name and ingredient list. If a label says a product contains another preparation, that
preparation can itself be attached as a versioned sub-recipe later; the photographed label
remains the documentary source rather than being treated as proof of ingestion.

## Events and exposure semantics

One confirmed capture can create several sibling events at the same time. A meal prepared
by the user normally creates:

1. a `meal` event with a `consumed` food participant and explicit ingestion method; and
2. a `meal_preparation` event with the prepared output, any exact leftover batches used,
   and only the foods the user confirms actually contacted skin.

The events are linked with `event_relations`. Recipe membership never implies ingestion,
and ingestion never implies skin contact. Gloves, direct contact, body area, route, amount,
and duration belong to the event-participant edge because they describe a specific
occurrence, not the reusable food or product.

The same writer supports medication, topical treatment, product use, showering, sport,
drinking, and notes. Event `type_code` describes what happened; participants identify the
foods/products/medicines involved. This avoids creating graph entities for verbs that have
no reusable identity.

## Capture and matching boundary

Photo, voice, text, manual, and future imports use the same state machine:

```text
capture → generic proposal → private graph retrieval → ranked candidates
        → user choice → field correction → final confirmation → trusted events
```

The generic proposal is generated without the user's graph and retained separately. The
personalized proposal may use private saved recipes. Choosing “none of these” returns to
the generic result rather than pretending the graph matched. Choosing manual starts with
blank editable fields.

Candidates are retrieval suggestions, never facts. The system stores their score,
explanation, and snapshot. Only the user's final choices create trusted event history.
Visible/spoken evidence is marked separately from ingredients suggested by a matched recipe
or personal pattern.

## Retrieval and deduplication

Current retrieval combines a vision/language proposal with exact names, aliases, recursively
flattened recipe leaves, and ingredient overlap. Recently used recipe metadata is retained
for future ranking. `concept_search_documents` provides a versioned location for optional
semantic indexes without making embeddings authoritative data.

Identity resolution is intentionally conservative:

- an exact selected candidate remains that recipe only if the user-confirmed ingredients
  match its reviewed snapshot;
- changing ingredients creates a linked recipe variation rather than mutating the match;
- choosing no candidate creates a new recipe;
- aliases improve retrieval but do not silently merge canonical food rows;
- destructive merges require a separate reviewed operation and are not part of capture.

## Invariants enforced in the database

- Every private edge remains within one tenant; shared food reference rows are explicitly
  allowed where appropriate.
- A recipe output is a distinct food identity owned by the recipe owner.
- Recipe versions and logged participant links are retained when a recipe changes.
- A nested recipe's output must equal the component food.
- Nested recipe cycles are rejected, and recursive flattening is depth bounded.
- A leftover input is attached to an occurrence as a batch participant; reusable recipe
  components retain only food and recipe-version identity.
- A participant's recipe version must produce the same food it claims to represent.
- An event participant must reference at least one concept, food, or batch.
- Ingestion methods use a controlled vocabulary: eaten, drank, swallowed, sublingual,
  inhaled, enteral, or other.
- A capture is marked confirmed only in the same transaction that writes its events.

## Deliberate non-goals

- The model does not diagnose allergies or infer causation.
- A photograph does not establish hidden ingredients.
- A recipe does not establish what was eaten, touched, or prepared on a particular day.
- Similarity scores are not medical risk scores or confidence that a food caused symptoms.
- A dedicated graph database is not warranted until traversal becomes the dominant workload;
  the current graph fits transactional PostgreSQL and recursive CTEs well.
