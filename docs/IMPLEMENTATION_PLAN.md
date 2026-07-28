# Pajara: architecture and implementation plan

Status: proposed plan; no application code has been written.

## 1. Repository audit

Audit date: 2026-07-28.

The repository is an empty, newly initialized Git repository:

- Branch: `main`
- Commits: none
- Tracked and untracked files: none before this document
- Application code, tests, schemas, migrations, assets, and documentation: none
- Dependency manifests and lockfiles: none
- Repository-specific agent guidance (`AGENTS.md`): none
- Existing features or architectural constraints: none

Therefore there is no existing functionality to preserve, duplicate, or migrate. The
first implementation milestone must establish the project skeleton, conventions, and
quality gates.

## 2. Product boundary and principles

Pajara is a private personal tracking and hypothesis-generation tool. It is not a
diagnostic device and must not claim that an exposure caused dermatitis, identify a
medical condition from a photo, or recommend starting, stopping, or changing a
medication without clinician involvement.

The design follows these principles:

1. **Capture first, structure second.** Logging must be quick even when extraction is
   unavailable. The original text, audio, image, document, receipt, or URL is retained.
2. **AI suggestions are untrusted.** Extracted fields remain proposed until a user
   accepts or edits them. Analyses use accepted data by default.
3. **Events, observations, and assertions are separate.** A meal or shower is an
   event; redness is an observation; an AI claim that a receipt contains milk is an
   assertion with provenance and confidence.
4. **Time is explicit.** Store event time, optional interval, capture time, timezone,
   and uncertainty. Do not silently substitute upload time for occurrence time.
5. **Extensibility is controlled.** Typed core columns support reliable queries while
   JSON attributes and versioned type definitions allow new fields without a migration
   for every new event kind.
6. **Associations are not causes.** Results include effect estimates, uncertainty,
   data coverage, model assumptions, confounders, and multiplicity warnings.
7. **Local-first, single-user first.** One deployable monolith, SQLite, local object
   storage, no microservices, and no mandatory cloud account.

## 3. Recommended architecture

### 3.1 Technology choices

| Area | Choice | Reason |
| --- | --- | --- |
| Application | Python 3.13 monolith with FastAPI | Typed API, simple local server, good testability, and direct access to Python statistics/ML libraries |
| UI | Server-rendered Jinja templates, HTMX, small TypeScript modules where browser APIs require them | Keeps the first version small while supporting camera, audio, previews, and dynamic review forms |
| Styling | Plain CSS with design tokens | Avoids framework churn and makes accessible components explicit |
| Persistence | SQLite in WAL mode via SQLAlchemy 2 and Alembic | Durable, portable, transactional, excellent for one user, and easy to back up/export |
| Structured flexibility | Relational core plus validated JSON attributes | Stable identity/time/provenance queries without an entity-attribute-value schema; new attributes do not always require migrations |
| Binary storage | Content-addressed files outside the database; metadata and hashes in SQLite | Keeps SQLite manageable, detects duplicates/corruption, and allows atomic backup |
| Validation | Pydantic schemas plus versioned event/observation type definitions | One validation boundary for manual entry, extraction, import, and API use |
| Background work | Durable `jobs` table and an in-process worker started separately | Extraction and thumbnails survive restarts without introducing a broker or service fleet |
| AI integration | Provider interfaces for transcription, document/image understanding, and structured extraction | Local/manual mode remains usable; remote providers are opt-in and replaceable |
| Statistics | pandas/Polars for feature tables, statsmodels for frequentist models, PyMC/ArviZ for later Bayesian models | Appropriate support for time series, mixed effects, uncertainty, diagnostics, and posterior summaries |
| Testing | pytest, Playwright, Hypothesis, and migration tests | Covers domain rules, property-based temporal cases, and real capture/review flows |
| Packaging | `pyproject.toml`, locked dependencies, Docker optional but not required | Reproducible local setup without making containers a prerequisite |

Use a responsive web application/PWA so a phone can capture photos and voice while the
data stays on a chosen local machine. A native mobile client and synchronization are
explicitly deferred.

### 3.2 Logical modules

```text
pajara/
  web/          routes, templates, static assets, accessibility
  domain/       event types, validation, review state, safety language
  persistence/  SQLAlchemy models, repositories, migrations
  artifacts/    hashing, atomic storage, thumbnails, export
  extraction/   provider adapters, prompts, schemas, normalization
  analysis/     cohorts, lag features, models, diagnostics, reports
  jobs/         durable queue and worker commands
  export/       manifest, JSONL/CSV, artifact archive
```

All modules run from one codebase and share one database. The worker is a second
process mode of the same application, not a network service.

### 3.3 Data flow

1. Capture creates an immutable source artifact and a draft event.
2. Manual fields may be accepted immediately; unstructured input creates an extraction
   job.
3. The extractor emits a versioned proposal containing field-level assertions.
4. Normalization resolves ingredients/products to candidates but does not silently
   merge uncertain identities.
5. The review screen shows source and proposal side by side.
6. Accepting or correcting writes a new revision and field decisions; it never
   overwrites provenance.
7. A derived analysis snapshot includes accepted fields, records its query and code
   version, and produces cautious, reproducible results.

## 4. Core data model

Identifiers are UUIDv7. Timestamps are ISO 8601 in UTC, accompanied by the recorded
IANA timezone where relevant. Scores use documented scales and retain the scale
version.

### 4.1 Identity, vocabulary, and capture

#### `profiles`

- `id`, `display_name`, `timezone`, `locale`
- optional non-diagnostic context in `attributes_json`
- `created_at`, `updated_at`

The first version has one profile, but every record carries `profile_id` to avoid a
future destructive redesign.

#### `type_definitions`

- `id`, `kind` (`event`, `observation`, `relation`)
- stable `code` such as `meal`, `skin_check`, `shower`, `stress`
- `version`, human label, JSON Schema, UI hints, active flag

Schemas are application-owned and versioned. Historical records retain the definition
version under which they were validated.

#### `body_areas`

- `id`, optional `parent_id`, canonical `code`, label, laterality, active flag

This supports hierarchies such as `hand > left hand > left index finger`.

#### `source_artifacts`

- `id`, `profile_id`, media type and source kind
- original filename, relative storage key, byte size, SHA-256
- `captured_at`, `ingested_at`, optional source URL
- optional duration/image dimensions and `metadata_json`
- encryption/version fields for future encrypted storage
- soft lifecycle state; actual deletion is handled by an audited deletion workflow

Originals are immutable. Derived thumbnails, transcripts, and redacted copies link to
their parent artifact.

### 4.2 Events, observations, and relationships

#### `events`

- `id`, `profile_id`, `type_code`, `type_version`
- `occurred_start`, optional `occurred_end`, `recorded_timezone`
- `time_precision` (`exact`, `minute`, `hour`, `part_of_day`, `day`, `range`,
  `unknown`) and optional uncertainty interval
- `status` (`draft`, `pending_review`, `trusted`, `rejected`)
- short label, `attributes_json`
- `created_at`, `updated_at`

Examples: meal, treatment application, medication dose, shower, handwash, exercise,
skin contact, sleep interval, travel, illness, alcohol, swimming, or check-in.

#### `observations`

- `id`, `profile_id`, optional `event_id`, `type_code`, `type_version`
- `observed_at`, optional `body_area_id`
- one typed value family: numeric, text, boolean, categorical, or JSON
- `unit`, `scale_code`, `scale_min`, `scale_max`
- `status`, `attributes_json`, timestamps

Examples: redness score, itch score, hours slept, stress score, local weather, or a
photo observation. Constraints ensure exactly one value family is populated.

#### `event_relations`

- `id`, `from_event_id`, `to_event_id`, `relation_type`
- attributes and provenance

Examples: a treatment targets a skin check/body area; a recipe was used in a meal; a
product was involved in a handwash; a meal-preparation event produced both a consumed
meal and one or more direct skin-contact exposures.

#### `record_artifacts`

- event or observation ID, artifact ID, role (`original_input`, `skin_photo`,
  `receipt`, `voice_note`, `transcript`, `thumbnail`)
- optional body area, view/pose, and sequence number

### 4.3 Trust, provenance, extraction, and corrections

#### `extraction_runs`

- `id`, artifact/event IDs, provider and model identifier
- prompt/schema versions, parameters, started/completed timestamps
- status, error category, token/cost metadata where available
- raw provider response stored as a protected artifact or JSON

#### `record_revisions`

- `id`, target record type/ID, revision number
- full validated snapshot, author type (`user`, `extractor`, `import`, `system`)
- author/model identifier, parent revision, reason, timestamp

#### `field_assertions`

- `id`, extraction/revision ID, target record and JSON Pointer field path
- proposed value, confidence in `[0,1]`
- evidence references (artifact, page, time span, text span, or image region)
- provenance method (`manual`, `transcribed`, `vision`, `parsed_url`, `normalized`)
- review state (`proposed`, `accepted`, `corrected`, `rejected`, `superseded`)
- reviewer, reviewed timestamp, corrected value, optional correction reason

Confidence means model confidence in extraction, not probability that an exposure is a
medical trigger. The UI must label this distinction.

### 4.4 Ingredients, products, and composition

#### `concepts`

- `id`, `concept_type` (`ingredient`, `product`, `category`, `material`, `activity`)
- canonical name, optional parent concept, external identifiers, attributes

#### `concept_aliases`

- `id`, concept ID, normalized alias, language, source, match mode
- uniqueness rules prevent ambiguous automatic mappings from being treated as certain

#### `concept_relations`

- subject concept, predicate (`is_a`, `part_of`, `derived_from`, `may_contain`),
  object concept, attributes, provenance

#### `compositions`

- `id`, owner concept (recipe/product), component concept
- optional amount/unit/concentration/order
- validity interval, certainty, source artifact, review state

This represents a shampoo formula, packaged-food ingredients, detergent contents, or a
recipe without flattening them into text. Formula changes are represented by validity
intervals, not overwrites.

#### `event_concepts`

- event ID, concept ID, role (`consumed`, `contacted`, `used`, `applied`, `taken`)
- quantity/unit, body area, duration, route, contact state (`raw`, `wet`, `dry`,
  `cooked`, `diluted`), confidence/review provenance

Food preparation must preserve the difference between ingestion and skin contact.
Ingredients in a prepared meal can be recorded as `consumed` on the meal event and,
independently, as `contacted` on a linked `meal_preparation` event. The preparation
event records which ingredients were actually handled, body areas, approximate
duration, raw/cooked or wet/dry state, glove use and material, spills/splashes, and
handwashing or cleaning products used afterward. It must not infer that every recipe
ingredient touched the user's skin.

### 4.5 Analysis and operations

#### `analysis_specs`, `analysis_runs`, `analysis_results`

Store the outcome definition, exposure definition, lag windows, inclusion rules,
confounders, missing-data policy, multiplicity family, code/data snapshot hashes,
diagnostics, estimates, intervals/posterior summaries, evidence grade, and rendered
plain-language explanation.

#### `experiments`

Hypothesis, protocol, eligible dates, randomized schedule where appropriate, outcome,
stopping rule, adherence events, safety notes, analysis plan, and status. Pajara may
suggest low-risk tracking experiments but must require user confirmation and must not
suggest medication withdrawal or intentional exposure to a suspected harmful agent.

#### `jobs` and `audit_log`

Durable jobs have type, payload, state, attempts, lease, and error. The append-only
audit log records reviews, exports, settings changes, and deletion actions without
copying sensitive content unnecessarily.

## 5. Example structured records

These examples are conceptual API payloads. Each accepted record would also have a
revision and field-level provenance.

### Photo-backed morning skin check

```json
{
  "type": "skin_check",
  "occurred_start": "2026-07-28T06:45:00Z",
  "recorded_timezone": "Europe/Rome",
  "attributes": {"period": "morning", "capture_protocol_version": 1},
  "artifacts": [
    {
      "artifact_id": "0198-photo-1",
      "role": "skin_photo",
      "body_area": "left_hand_dorsal",
      "view": "standard_dorsal",
      "original_sha256": "..."
    }
  ],
  "observations": [
    {"type": "redness", "body_area": "left_hand_dorsal", "value": 3, "scale": "0_10_v1"},
    {"type": "itch", "body_area": "left_hand_dorsal", "value": 5, "scale": "0_10_v1"},
    {"type": "dryness", "body_area": "left_hand_dorsal", "value": 4, "scale": "0_10_v1"},
    {"type": "cracking", "body_area": "left_hand_dorsal", "value": 1, "scale": "0_10_v1"},
    {"type": "swelling", "body_area": "left_hand_dorsal", "value": 0, "scale": "0_10_v1"},
    {"type": "pain", "body_area": "left_hand_dorsal", "value": 2, "scale": "0_10_v1"}
  ]
}
```

Photo-derived redness must not become a clinical severity score. Initially, photos are
for aligned visual comparison; any later image metric is labeled an experimental
measurement with calibration and validation limits.

### Prepared meal, ingestion, and food-contact exposure extracted from voice plus receipt

```json
[
  {
    "id": "0198-prep-1",
    "type": "meal_preparation",
    "occurred_start": "2026-07-28T11:05:00Z",
    "occurred_end": "2026-07-28T11:32:00Z",
    "source_artifact_ids": ["0198-audio-1", "0198-receipt-1"],
    "attributes": {
      "prepared_by_user": true,
      "gloves_used": false,
      "post_contact_handwash_event_id": "0198-wash-1"
    },
    "concepts": [
      {
        "concept": "raw_tomato",
        "role": "contacted",
        "body_area": "both_hands",
        "duration_seconds": 180,
        "contact_state": "raw_wet",
        "review_state": "accepted"
      },
      {
        "concept": "cow_milk_parmesan",
        "role": "used",
        "review_state": "accepted",
        "attributes": {"direct_skin_contact": "explicitly_none"}
      }
    ]
  },
  {
    "id": "0198-meal-1",
    "type": "meal",
    "occurred_start": "2026-07-28T11:35:00Z",
    "time_precision": "minute",
    "label": "Pasta lunch",
    "attributes": {"meal_kind": "lunch", "prepared_by_user": true},
    "relations": [
      {"to_event_id": "0198-prep-1", "relation_type": "prepared_by"}
    ],
    "concepts": [
      {"concept": "wheat_pasta", "role": "consumed", "review_state": "accepted"},
      {"concept": "tomato", "role": "consumed", "review_state": "accepted"},
      {"concept": "cow_milk_parmesan", "role": "consumed", "review_state": "corrected"}
    ]
  }
]
```

The extraction review asks separately “Did you prepare this?” and “Which ingredients
actually touched your skin?” It offers quick defaults such as both hands and no
gloves, but those remain proposed until confirmed. Cutting, peeling, kneading,
marinating, dishwashing, glove use, and cleanup can create contact exposures even when
the prepared food is not eaten by the user.

### Product contact and composition

```json
{
  "type": "skin_contact",
  "occurred_start": "2026-07-28T18:02:00Z",
  "occurred_end": "2026-07-28T18:04:00Z",
  "attributes": {"contact_kind": "handwashing"},
  "concepts": [
    {
      "concept": "example_brand_soap_batch_2026",
      "role": "used",
      "body_area": "both_hands",
      "composition_version": "2026-03",
      "review_state": "accepted"
    }
  ]
}
```

### Treatment

```json
{
  "type": "topical_treatment",
  "occurred_start": "2026-07-28T18:10:00Z",
  "concepts": [
    {
      "concept": "prescribed_topical_product",
      "role": "applied",
      "body_area": "left_hand_dorsal",
      "quantity": 1,
      "unit": "fingertip_unit"
    }
  ],
  "attributes": {"as_prescribed": true}
}
```

### Activity, environment, and note

```json
[
  {
    "type": "exercise",
    "occurred_start": "2026-07-28T16:00:00Z",
    "occurred_end": "2026-07-28T16:42:00Z",
    "attributes": {"activity": "running", "intensity": "moderate", "sweating": "high"}
  },
  {
    "type": "environmental_exposure",
    "occurred_start": "2026-07-28T16:00:00Z",
    "occurred_end": "2026-07-28T16:42:00Z",
    "attributes": {
      "setting": "outdoors",
      "temperature_c": 31.2,
      "relative_humidity_percent": 68,
      "measurement_source": "weather_import"
    }
  },
  {
    "type": "note",
    "occurred_start": "2026-07-28T18:20:00Z",
    "attributes": {"text": "Hands stung after washing."},
    "source_artifact_ids": ["0198-voice-note-2"]
  }
]
```

Weather imported for an approximate location must record provider, station/grid,
retrieval time, spatial resolution, and whether it was observed or forecast. Manual
environment entries remain valid without network access.

## 6. AI extraction and human review

### 6.1 Ingestion

- Accept text, camera/file images, audio, URLs, and later PDFs/documents.
- Hash and atomically store the original before processing.
- Collect occurrence time with a quick default of “now” and easy correction.
- URLs store the submitted URL and capture metadata; fetching remote content is
  opt-in and must defend against SSRF, oversized downloads, and unsupported content.
- Receipt, shopping-list, and recipe extraction are the same artifact-to-proposal
  pipeline with different schemas.

### 6.2 Extraction

1. Detect input role from the user-selected logging intent; do not rely solely on AI.
2. Transcribe audio while preserving timestamps and the original audio.
3. Extract against a narrow versioned JSON Schema.
4. Require evidence spans/regions and confidence for every proposed field.
5. Normalize dates relative to the user's timezone and flag inferred/ambiguous times.
6. Resolve ingredient/product aliases to candidate concepts with match scores.
7. Validate deterministically. Invalid output cannot enter review as trusted data.
8. Store the raw response, extraction metadata, and proposal revision.

Provider prompts must state that image analysis is for transcription/organization, not
diagnosis. Sensitive artifacts are never sent to a remote provider until the user has
enabled it and understands which data leaves the device.

### 6.3 Review

The review screen displays:

- original image/audio waveform/transcript/text beside the proposed structured record;
- highlighted low-confidence, inferred, novel, or conflicting fields first;
- canonical ingredient/product candidates and their source aliases;
- “accept all high-confidence,” per-field accept/edit/reject, and add-missing controls;
- an explicit event time and body-area check;
- a before/after summary before committing.

Commit creates an accepted user revision and retains all rejected/corrected assertions.
Undo creates another revision. Pending proposals are excluded from analysis by default
and visibly counted as incomplete data.

## 7. Photo capture, storage, and comparison

### 7.1 Capture protocol

For each named body area, provide a translucent pose silhouette and concise prompts:

- same area and view;
- same approximate distance, orientation, and camera;
- neutral background;
- diffuse, consistent lighting;
- optional reference marker/color card, never required for quick logging;
- retake warnings for blur, underexposure, or missing area, with an override.

Record camera metadata when available, but strip GPS from display/export by default.
Do not modify the original. Generate oriented display derivatives and thumbnails.

### 7.2 Storage

Use:

```text
data/
  pajara.sqlite3
  artifacts/sha256/ab/cd/<full-hash>
  derivatives/<source-hash>/<recipe-version>/<hash>
```

Writes use a temporary file, hash verification, fsync where supported, and atomic
rename. Content Security Policy and authenticated media routes prevent arbitrary file
serving. Validate content signatures, dimensions, and limits rather than trusting file
extensions.

### 7.3 Comparison

Version one offers date/body-area filtering, side-by-side comparison, synchronized
zoom, and an opacity slider. It reports capture-quality differences.

Later, optional deterministic alignment can use landmarks/features and store the
transform plus algorithm version. Color normalization or segmentation must be
experimental, reproducible, and never presented as a diagnosis. Comparisons should
warn when lighting, view, or scale makes interpretation unreliable.

## 8. Analysis architecture and statistical methodology

### 8.1 Analysis-ready snapshots

A reproducible feature builder converts accepted records into interval-aware tables:

- outcome trajectories by symptom, body area, and scale;
- exposure onset, duration, amount, composition, and repeated episodes;
- observation opportunities and missingness indicators;
- covariates such as baseline severity, treatment, sleep, stress, illness, season,
  travel, weather, day of week, and logging intensity;
- predeclared lag windows, initially 0–6 h, 6–24 h, 1–3 d, and 3–7 d, configurable by
  exposure class and biological plausibility.

Snapshots record the database revision/high-water mark, query, vocabulary version,
feature code version, timezone rules, and inclusion/exclusion counts.

Missing is not zero or absent. “Not logged,” “asked and none,” and “unknown” are
distinct states.

### 8.2 Descriptive first

The initial product provides:

- symptom time series with raw observations, not interpolated certainty;
- exposure overlays;
- logging completeness and missing-data plots;
- flare-window summaries comparing each person's recent baseline;
- candidate changes ranked by coverage and temporal consistency, not causal language.

No trigger ranking should appear until minimum data/support thresholds are met.

### 8.3 Models

Add methods only after simulation and diagnostic tests:

1. **Self-controlled case-crossover:** define flare hazard windows and matched control
   windows within the same person. Match on time trends/day-of-week/season where data
   allow; use conditional logistic regression. Guard against exposure time trends and
   overlapping windows.
2. **Distributed lag models:** represent an exposure across predeclared lag basis
   functions rather than testing dozens of unrelated lags. Include baseline trend and
   autoregressive terms.
3. **Mixed-effects models:** useful only when there are repeated body areas, exposure
   episodes, or eventually multiple profiles. Random intercepts/slopes must reflect
   the actual hierarchy; one user's repeated dates alone do not justify population
   claims.
4. **Bayesian time-series/hierarchical models:** regularizing priors, latent baseline
   trend, autoregressive residuals, measurement error, and partial pooling across
   related ingredients/lags. Report posterior intervals and probabilities tied to a
   meaningful effect threshold, not “probability of causation.”
5. **N-of-1 experiments:** preregister outcome, schedule, wash-in/wash-out assumptions,
   analysis, adherence, stopping rule, and safety constraints. Randomized crossover is
   used only for low-risk exposures; treatment changes require clinician agreement.

### 8.4 Bias, confounding, and multiplicity

- Use causal diagrams/explicit adjustment sets per question; do not mechanically
  adjust for mediators or colliders.
- Treatment is often time-varying confounding by indication: worsening skin causes
  treatment, which can make treatment look harmful. Reports must call this out.
- Control baseline drift with splines/state-space trends and seasonality only when
  supported by enough data.
- Model autocorrelation and use block/bootstrap or appropriate robust uncertainty
  where applicable.
- Represent dose, duration, and cumulative/repeated exposure rather than a single
  present/absent flag.
- Use sensitivity analyses for alternate flare definitions, lag windows, and missing
  data. Multiple imputation is considered only when its assumptions are defensible.
- Pre-group related hypotheses. Use false discovery rate control for exploratory
  frequentist screens or hierarchical shrinkage for Bayesian models.
- Avoid post-hoc selection disguised as confirmation. Mark exploratory findings and
  validate prospectively on later data.

### 8.5 Evidence presentation

Every result includes:

- direction and magnitude on an understandable scale;
- confidence/credible interval and sample/exposure counts;
- data coverage and missingness;
- lag window and comparison used;
- model diagnostics and sensitivity consistency;
- plausible confounders and alternative explanations;
- whether the analysis was exploratory or preregistered;
- evidence label: `insufficient`, `weak`, `suggestive`, or `stronger within-person
  association`.

Even the strongest label remains “association.” Never output “X causes your
dermatitis.” The AI question interface retrieves structured analysis results and their
limitations; it does not calculate ad hoc medical conclusions from raw notes.

### 8.6 AI question interface

For questions such as “what changed before recent flare-ups?”:

1. classify the question into an approved analysis template;
2. show the outcome, period, comparison, and lag definition;
3. execute deterministic, versioned analysis code;
4. provide the AI only the aggregate result, diagnostics, and relevant provenance;
5. render an answer with uncertainty, confounders, alternatives, and links back to
   source records;
6. refuse diagnosis and unsafe experiment/treatment requests.

Natural-language generation must not invent an analysis, omit a failed diagnostic, or
upgrade the evidence label.

## 9. Safety safeguards

- Persistent product copy: “Pajara tracks patterns; it does not diagnose conditions
  or establish causes.”
- Emergency/worsening-symptom guidance is static, clinician-reviewed content rather
  than AI diagnosis. It should advise seeking appropriate medical care without
  interpreting a photo.
- Medication/treatment records are observational. No dose changes, discontinuation,
  substitution, or intentional re-exposure recommendations.
- Experiment suggestions pass a rules-based safety filter and require confirmation.
- Photo models, if introduced, cannot label diseases or infection.
- Analysis language is generated from constrained templates with snapshot links.
- A safety test suite checks prohibited causal, diagnostic, and treatment language.

## 10. Privacy, security, export, deletion, and backup

### Privacy and security

- No telemetry or remote AI by default.
- First-run choice explains local storage, remote extraction, and retention.
- Bind the local server to loopback by default; remote/LAN exposure requires
  authentication, TLS, and an explicit setting.
- Protect sessions against CSRF, set secure cookie policies, enforce CSP, and escape
  user/AI content.
- Validate uploads by signature; impose byte/pixel/duration limits and isolate media
  decoding.
- Prevent URL ingestion from reaching loopback, private networks, cloud metadata, or
  unsupported schemes.
- Secrets live in the OS keychain or environment, never SQLite, logs, exports, or Git.
- Redact artifact contents and AI payloads from logs.
- Optional at-rest encryption can follow the first slice. Until then, clearly state
  that device/full-disk encryption is the protection boundary.

### Export

Produce a versioned ZIP containing:

- `manifest.json` with schema/app versions, hashes, timezone, and export time;
- records and revision history as JSONL;
- convenient CSV tables for events, observations, concepts, and assertions;
- originals in a documented artifact tree;
- checksums and a human-readable data dictionary.

Export defaults to the full-fidelity original plus structured data. A separate
shareable export can omit photos/audio, precise timestamps, and metadata.

### Deletion

- Preview affected records, revisions, derivatives, and shared/deduplicated artifacts.
- Require explicit confirmation for profile-wide deletion.
- Delete database references transactionally, then garbage-collect unreferenced files.
- Record a content-free audit event. Explain that independent backups/exports are not
  remotely erasable by the application.
- Test interrupted deletion and orphan cleanup.

### Backup and recovery

- Use SQLite's online backup API, not a raw copy of a live WAL database.
- Snapshot the database and content-addressed artifacts into one versioned backup,
  then verify hashes.
- Support encrypted backup archives with a user-held recovery key.
- Implement and routinely test restore into a fresh data directory.
- Retention is configurable; never silently upload backups.

## 11. Testing strategy

### Unit and property tests

- timezone/DST, partial times, intervals, lag assignment, overlapping events;
- type-schema validation and exactly-one observation value;
- revisions, acceptance/correction/rejection, and trusted-data filtering;
- ingredient alias ambiguity, hierarchy traversal, and formula validity intervals;
- content hashing, deduplication, atomic writes, and garbage collection;
- safety-language/template constraints.

Use Hypothesis to generate event timelines, missingness patterns, and revision
sequences.

### Integration tests

- database migrations forward from every released schema and backup restore;
- artifact ingestion through extraction proposal and review;
- provider contract tests with recorded/synthetic responses, with no real health data;
- job retry/idempotency and restart recovery;
- full export validation and round-trip import into a fresh instance;
- deletion with shared artifacts and failed/interrupted cleanup.

### End-to-end and accessibility tests

Playwright covers profile creation, phone-size check-in, camera/file fallback, symptom
entry, text/voice proposal, review corrections, timeline, trends, export, and offline
failure states. Test keyboard use, focus, labels, contrast, reduced motion, and screen
reader semantics.

### Statistical tests

- simulated data with known null/effect, confounding, autocorrelation, trends, missing
  data, and time-varying treatment;
- false-positive behavior across lag searches and multiple exposures;
- interval/coverage properties where appropriate;
- frozen reference datasets and deterministic snapshot hashes;
- diagnostics that deliberately fail and suppress evidence claims;
- prospective/exploratory separation and evidence-label rules.

### Security and privacy tests

- malicious files, decompression/pixel bombs, MIME confusion, and stored XSS;
- CSRF/session boundaries and unauthorized artifact access;
- SSRF including redirects and DNS rebinding defenses;
- secrets/health data absent from logs;
- export redaction and metadata stripping.

## 12. Smallest genuinely useful vertical slice

The first slice is a single-user local web app that can:

- create one profile with timezone;
- create a morning/evening skin check;
- upload one or more original photos assigned to named body areas;
- score redness, itching, dryness, cracking, swelling, and pain on documented 0–10
  scales;
- add free text or a recorded voice note for a meal, product/contact, treatment,
  activity, or general note;
- when the user prepared a meal, review separately what was consumed and what directly
  contacted named body areas, including contact state, duration, gloves, and cleanup;
- transcribe/extract through an optional configured provider, or enter fields manually
  when no AI is configured;
- review and correct every proposed field before it is trusted;
- persist artifacts, structured events, observations, revisions, confidence, and
  provenance;
- view a chronological timeline and basic symptom trends by body area;
- export JSONL/CSV plus originals and a manifest.

The slice deliberately excludes trigger ranking, image diagnosis/scoring, URL/receipt
ingestion, automatic weather, cloud sync, multi-user accounts, and advanced models.
Those features would be misleading or premature before capture quality and review
behavior are validated.

## 13. Phased roadmap and independently testable milestones

### Phase 0 — foundation

**M0.1 Project skeleton**

- Add Python project, lockfile, formatting/lint/type checks, pytest, app factory, and
  documented local commands.
- Acceptance: clean install; one command starts the app; CI-equivalent checks pass.

**M0.2 Domain vocabulary**

- Define versioned JSON Schemas, symptom scales, initial event types, and body-area
  seed data.
- Acceptance: schema fixtures validate; incompatible changes require a new version.

**M0.3 Persistence**

- Implement profile, event, observation, artifact, revision, assertion, job, and audit
  tables with Alembic.
- Acceptance: migrations round-trip on a temporary database; constraints reject
  invalid records.

### Phase 1 — useful vertical slice

**M1.1 Profile and manual check-in**

- Create profile and morning/evening check-ins with body-area symptom scores.
- Acceptance: create/edit/revise flows persist UTC plus timezone and pass E2E tests.

**M1.2 Photo capture and storage**

- Camera/file upload, body-area assignment, guidance overlay, quality warnings,
  immutable originals, safe thumbnails.
- Acceptance: mobile flow works; hashes verify; bad/oversized inputs fail safely.

**M1.3 Quick logging**

- Text and browser audio capture for meal, product/contact, treatment, activity, and
  note draft events.
- A prepared-meal flow links ingestion to preparation while keeping handled
  ingredients, body areas, glove use, and cleanup as distinct contact exposures.
- Acceptance: capture completes without AI; original inputs survive worker failure.

**M1.4 Extraction and review**

- Provider interface, one opt-in transcription/extraction adapter, mock/local-manual
  adapter, assertions, confidence/evidence, correction UI.
- Acceptance: no proposal enters trusted queries before review; correction history is
  reproducible.

**M1.5 Timeline and basic trends**

- Timeline filters, source/revision drill-down, symptom plots, missing-data indication,
  photo side-by-side comparison.
- Acceptance: pending data is visibly distinct and excluded from trends by default.

**M1.6 Export, backup, and deletion**

- Full-fidelity export, verified local backup/restore, record/profile deletion preview.
- Acceptance: export schema validation and fresh-instance restore tests pass.

At M1.6, the smallest useful slice is complete and should be tested in actual daily use
before broadening ingestion or analysis.

### Phase 2 — richer structured capture

**M2.1 Concepts and composition**

- Ingredient/product concepts, aliases, hierarchies, recipes, formula versions, and
  ambiguous-match review.

**M2.2 More input formats**

- Receipt/shopping-list/document images, recipes/ingredient lists, and safe URL
  capture. Each format has fixtures and evidence-linked extraction tests.

**M2.3 Broader events**

- Showers, handwashing, sleep, stress, illness, travel, exercise/sweat, swimming,
  alcohol, fabrics/gloves, cleaning, and environmental exposure.

**M2.4 Weather import**

- Optional location resolution and historical observed-weather adapter with explicit
  spatial/temporal provenance.

### Phase 3 — descriptive hypothesis generation

**M3.1 Analysis snapshots**

- Trusted-data feature builder, completeness metrics, baseline trends, exposure
  episodes, and predeclared lag windows.

**M3.2 Flare/change summaries**

- User-defined flare rules, matched descriptive windows, confounder inventory, and
  cautious evidence templates. No automated causal rank.

**M3.3 Constrained AI questions**

- Approved question templates backed only by reproducible analysis outputs and links.

### Phase 4 — validated statistical analysis

**M4.1 Simulation harness**

- Synthetic generators and calibration tests for trend, autocorrelation, missingness,
  confounding, repeated exposures, and multiplicity.

**M4.2 Case-crossover and distributed lags**

- Diagnostics, minimum support rules, sensitivity analyses, and FDR/shrinkage.

**M4.3 Mixed-effects and Bayesian models**

- Add only for questions with adequate hierarchy/sample size. Include posterior
  predictive checks and convergence/fit gating.

**M4.4 Personal experiment designer**

- Low-risk, preregistered N-of-1 protocols, randomized schedules where suitable,
  adherence tracking, safety rules, and clinician-change warnings.

### Phase 5 — hardening and optional expansion

- At-rest application encryption if threat modeling shows it is needed beyond device
  encryption.
- Installable PWA/offline capture queue with conflict-tested synchronization.
- Multi-device or multi-user support only after defining authentication, encrypted
  sync, conflict resolution, tenancy, and operational ownership.
- External clinical/research review of symptom scales, safety copy, and analysis
  interpretation before any broader release.

## 14. Initial implementation order for Codex

Codex should implement one milestone per change set:

1. M0.1 and its tests/documented commands.
2. M0.2, including the schemas and fixtures.
3. M0.3, including migrations and constraints.
4. M1.1 through M1.6 separately, maintaining a runnable product after each.
5. Pause for real-use feedback and schema review before Phase 2.

Each milestone should include migration impact, tests, privacy/safety impact, and an
updated short decision record. Substantial application implementation begins only
after this plan is accepted.

## 15. Decisions to validate before implementation

These do not block the architecture, but should be confirmed before the relevant
milestone:

- whether local access is only on one computer or also from a phone on the same LAN;
- which, if any, remote AI provider may receive photos/audio/text;
- whether voice notes must work fully offline in the first slice;
- desired backup destination and whether encrypted archives are required immediately;
- initial symptom scale wording and body-area vocabulary, ideally reviewed with a
  dermatologist or established patient-reported outcome guidance;
- whether data should be English-only initially or preserve multilingual aliases and
  transcripts from day one.
