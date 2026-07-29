# Pajara: hosted prototype architecture and implementation plan

Status: MVP code implemented and locally verified; hosted deployment and production
acceptance testing remain.

Last updated: 2026-07-29.

## 1. Repository audit and current baseline

The repository was inspected before this revision and was not empty. It contained:

- a Python 3.13 project with locked dependencies;
- a minimal FastAPI application factory and loopback-only CLI;
- a placeholder HTML page and health endpoint;
- Ruff, strict mypy, pytest, and three passing smoke tests;
- the original local-first architecture document.

No domain schema, database, capture workflow, artifact storage, authentication, AI
integration, analysis, reports, or deployment existed at the time of this revision.
The Python foundation was moved into `services/python` and expanded into the hosted
API/worker service. The rest of this document describes the implemented architecture
and distinguishes production acceptance work that must happen after deployment.

## 2. Product boundary

Pajara is a personal tracking and hypothesis-generation tool. It is not a diagnostic
system and must not:

- diagnose dermatitis or another disease from symptoms or photographs;
- claim an exposure caused a flare;
- tell a user to start, stop, substitute, or change medication;
- encourage intentional exposure to a suspected harmful substance;
- conceal uncertainty, missing data, failed diagnostics, or plausible confounding.

It may organize user-supplied information, describe within-person associations with
uncertainty, identify alternative explanations, and suggest low-risk data-collection
or personal-experiment designs that preserve clinical oversight.

## 3. Prototype outcome

The first deployable prototype must let one invited user:

1. sign in and create a profile with timezone;
2. record morning/evening skin check-ins;
3. attach photos to named body areas;
4. score redness, itching, dryness, cracking, swelling, and pain;
5. log meals, meal preparation, skin contacts, products, treatments, activities, and
   notes using structured controls or free text;
6. record and upload voice notes;
7. distinguish food consumed from food handled during preparation;
8. request AI extraction and review/edit/reject every proposed field;
9. view a timeline, symptom trends, and private photos;
10. request a cautious descriptive summary/report;
11. export original and structured data;
12. delete individual records and, after explicit confirmation, all profile data.

Manual logging remains fully usable when the AI service is disabled or unavailable.

## 4. Deployment architecture

```text
Phone / browser
    |
    v
React + TypeScript PWA (Netlify)
    |                         \
    | Supabase user JWT        \ authenticated API request
    v                           v
Supabase                    Python service (container host)
  Auth                        FastAPI API process
  Postgres                    Worker process
  private Storage                |
  durable jobs                   +-- OpenAI or another provider
    ^                            +-- feature construction
    |                            +-- statistical analysis
    +------- durable results ----+-- report/export generation
```

### 4.1 Netlify web application

Use a static React/Vite progressive web application. Server rendering is unnecessary
for an authenticated personal tracker and would duplicate the Python backend.

Responsibilities:

- authentication and session refresh through Supabase Auth;
- mobile-first capture, camera/file selection, audio recording, and review;
- direct authenticated upload to private Supabase Storage;
- user-scoped CRUD through the Supabase Data API and RLS;
- authenticated calls to the Python service for jobs;
- timeline, charts, photo comparison, reports, and export download;
- clear offline/error/pending states.

Netlify receives only public frontend configuration. It must never receive or bundle
the Supabase secret/admin key or the AI provider key.

### 4.2 Supabase data plane

Supabase is the authoritative durable store:

- Auth identifies the user;
- Postgres stores structured records, revisions, provenance, and results;
- private Storage buckets hold originals, derivatives, reports, and exports;
- a Postgres jobs table provides durable, retryable work claiming;
- Row Level Security enforces ownership independently of frontend behavior.

The prototype uses direct browser access only for user-owned CRUD that is protected by
RLS. Privileged operations use the Python backend.

### 4.3 Python service

One Python package has two process modes:

```text
pajara api
pajara worker
```

The API:

- exposes health/readiness endpoints;
- validates Supabase JWTs;
- creates extraction, analysis, report, and export jobs;
- provides job status without exposing service credentials;
- applies request size, ownership, and safety validation.

The worker:

- atomically claims durable jobs;
- retrieves user-owned originals through server credentials;
- transcribes audio;
- extracts versioned structured proposals;
- records model, prompt, schema, evidence, and confidence;
- constructs analysis snapshots from trusted records;
- generates descriptive results and cautious reports;
- assembles exports;
- retries transient failures and records terminal failures.

The package supports independently scalable API and worker processes. For the free
single-user deployment, `RUN_WORKER_IN_API=true` makes the API claim one durable job
as a post-response background task whenever a job is queued. This avoids a paid
always-on worker while preserving the Supabase queue. A later paid deployment turns
that mode off and runs `pajara worker` separately.

## 5. Repository layout

```text
apps/
  web/                       React/Vite PWA deployed to Netlify
services/
  python/
    src/pajara/
      app.py                 HTTP routes
      auth.py                Supabase JWT verification
      domain.py              request/extraction/result models
      supabase.py            Data API and private Storage client
      providers.py           fake/OpenAI extraction and transcription
      analysis.py            cautious descriptive analysis
      reports.py             private reports and portable exports
      worker.py              job claiming, dispatch, and retry
    tests/
packages/
  schemas/                   versioned JSON Schemas and fixtures
supabase/
  migrations/               schema, functions, RLS, Storage policies
  seed.sql                   body areas and vocabulary
docs/
  IMPLEMENTATION_PLAN.md
  DEPLOYMENT.md
netlify.toml
Dockerfile
```

## 6. Data design

UUIDs are generated in Postgres. Every user-owned record includes `user_id`.
Occurrence timestamps use `timestamptz`; the original IANA timezone and time
precision are preserved. JSON attributes are validated by versioned schemas before
becoming trusted.

### 6.1 Profiles and vocabulary

#### `profiles`

- `id`, `user_id`, `display_name`, `timezone`, `locale`;
- `attributes`, `created_at`, `updated_at`;
- one prototype profile per authenticated user.

#### `type_definitions`

- `kind`, stable `code`, `version`, label;
- JSON Schema and UI hints;
- active flag and timestamps.

#### `body_areas`

- stable code, label, optional parent, laterality, display order;
- shared system rows readable by authenticated users.

Initial hierarchy includes whole body, head/face/neck, torso, arms, elbows, wrists,
hands, fingers, legs, knees, ankles, and feet with left/right variants where useful.

### 6.2 Events and observations

#### `events`

- `id`, `user_id`, optional `profile_id`;
- `type_code`, `type_version`;
- `occurred_start`, optional `occurred_end`, recorded timezone;
- `time_precision`, label, attributes;
- `trust_status`: `draft`, `pending_review`, `trusted`, `rejected`;
- source method and timestamps.

Initial event types:

- `skin_check`;
- `meal`;
- `meal_preparation`;
- `skin_contact`;
- `product_use`;
- `topical_treatment`;
- `medication`;
- `activity`;
- `note`;
- `sleep`;
- `stress`;
- `illness`;
- `environmental_exposure`.

#### `observations`

- user/event/body-area references;
- type and version;
- observed time;
- exactly one numeric, text, boolean, categorical, or JSON value;
- optional unit and scale metadata;
- trust status and attributes.

Initial symptom observations are redness, itching, dryness, cracking, swelling, and
pain on a documented 0–10 scale. Missing is never encoded as zero.

#### `event_relations`

Links preparation to the resulting meal, cleanup to preparation, a treatment to body
areas, or another semantically related event.

### 6.3 Artifacts

#### `artifacts`

- user, bucket, object path, SHA-256, media type, bytes;
- original filename, capture and ingestion timestamps;
- image dimensions/audio duration when available;
- artifact kind and immutable metadata.

#### `record_artifacts`

Links an artifact to an event/observation with:

- role such as `original_input`, `skin_photo`, `voice_note`, `transcript`,
  `thumbnail`, `receipt`, `report`, or `export`;
- optional body area, view, and display order.

Storage buckets:

- `skin-originals`;
- `voice-originals`;
- `input-originals`;
- `derived-private`.

All buckets are private. Object paths start with the authenticated user's UUID.

### 6.4 Ingredients, products, ingestion, and contact

#### `concepts`, `concept_aliases`, `concept_relations`

Represent canonical ingredients, products, categories, materials, activities, and
aliases. Hierarchical relations support categories and components.

#### `compositions`

Versioned product/recipe composition:

- owner and component concepts;
- amount/unit/concentration/order where known;
- validity interval;
- certainty, source, and review state.

#### `event_concepts`

Associates an event with a concept and role:

- `consumed`, `contacted`, `used`, `applied`, `taken`, or `present`;
- amount/unit;
- body area and duration;
- route;
- contact state such as raw/wet/dry/cooked/diluted;
- glove use/material and direct-contact certainty;
- provenance and review state.

A recipe ingredient is not automatically considered skin contact. For a meal prepared
by the user:

- the `meal` event records what was consumed;
- a linked `meal_preparation` event records what was actually handled;
- preparation records affected body areas, state, duration, gloves, splashes, and
  cleanup;
- a linked cleanup/handwashing contact may record soap, detergent, or gloves.

### 6.5 AI proposals and revisions

#### `extraction_runs`

- target event/artifact;
- provider/model, prompt version, schema version;
- status, start/end, usage/cost metadata, error;
- raw response in protected JSON.

#### `field_assertions`

- target record and JSON Pointer path;
- proposed value;
- confidence from 0 to 1;
- evidence such as text span, transcript interval, artifact, or image region;
- provenance method;
- review state: proposed, accepted, corrected, rejected, or superseded;
- corrected value and reviewer timestamp.

Confidence is extraction confidence, not the probability of a medical trigger.

#### `record_revisions`

Append-only validated snapshots with author type, parent revision, reason, and time.
Accepting/correcting proposals creates a user-authored trusted revision. Analyses use
trusted revisions only.

### 6.6 Jobs, analysis, and reports

#### `jobs`

- user, job type, payload;
- state: queued, running, succeeded, failed, cancelled;
- priority, attempts, maximum attempts;
- `available_at`, lease owner/expiry;
- progress, error, result reference, timestamps.

A security-definer Postgres function atomically claims work using
`FOR UPDATE SKIP LOCKED`. Job payloads contain identifiers, not large health data.

#### `analysis_runs`

- user question and versioned analysis specification;
- immutable data cutoff/snapshot metadata;
- status and method;
- result JSON, diagnostics, limitations, evidence strength;
- code version and timestamps.

#### `reports`

- analysis reference, report kind/version;
- artifact reference;
- safety-reviewed summary and timestamps.

## 7. Shared structured schemas

`packages/schemas` contains versioned JSON Schemas for:

- event envelope and temporal precision;
- observations and symptom scales;
- meal preparation and its distinct ingestion/contact fields;
- extraction proposal;
- export manifest.

Python validates representative schema fixtures, while the frontend and API use
explicit strict types for their current projections. Generating both language models
from released schemas is a later consistency improvement. Schema versions are
immutable after release.

## 8. Capture workflows

### 8.1 Skin check

1. Choose morning/evening and occurrence time.
2. Choose the body area used for symptom scores.
3. Score each symptom or deliberately mark it unobserved.
4. Add up to twelve photo slots, each with its own named body area and view.
5. Show pose, lighting, distance, blur, and exposure guidance.
6. Save immediately; photo processing can continue asynchronously.

Originals are never modified. Photo comparison supports side-by-side viewing and an
opacity overlay, labels area/view, and initially pairs matching views where available.
A four-slot hand preset captures left palm, left back, right palm, and right back.
Derived thumbnails, automatic alignment, and synchronized zoom are later
enhancements. No automated diagnosis or clinical image score is included.

### 8.2 Quick log

The user selects meal, product/contact, treatment, activity, or note and can:

- type free text;
- record audio;
- optionally fill structured shortcuts;
- set or correct occurrence time;
- save without waiting for AI.

Prepared meals ask separately:

- Did you prepare it?
- What was eaten?
- Which ingredients were actually handled or touched skin?
- Which body areas?
- Were gloves worn?

The schema can already represent raw/wet/cooked/dry state, duration, glove material,
spills/splashes, and cleanup/handwashing. Dedicated shortcuts for those fields follow
after the prototype is used enough to establish which controls reduce friction.

### 8.3 AI review

The implemented review screen shows structured proposals, evidence excerpts, and
provider/model provenance and:

- highlights low extraction confidence;
- allows accept/edit/reject per field;
- displays evidence and the extraction model;
- never offers automatic trust for medical interpretations;
- records every decision and correction.

Displaying the complete original/transcript alongside every assertion and requiring
explicit time/body-area confirmation are next review-UX improvements.

## 9. AI integration

AI is optional and provider-isolated. The initial OpenAI adapter:

- uses a current Responses API model configured by environment;
- defaults to a cost-balanced model rather than hard-coding a flagship dependency;
- uses versioned structured output validated by Pydantic/JSON Schema;
- uses a dedicated transcription model for audio;
- requests organization/transcription only, never diagnosis;
- records provider, model, prompt/schema version, and raw response;
- returns field-level evidence and confidence;
- never trusts a failed extraction; the user-authored original remains available as
  manual data.

No photos, audio, or text are sent to a remote provider unless remote AI is enabled.
API keys are held only by the Python service. Representative extraction fixtures are
tested with a deterministic fake provider; real API tests are opt-in.

## 10. Analysis and report architecture

### 10.1 Prototype analysis

The implemented MVP analysis is deliberately limited and transparent:

- trusted symptom means and latest values;
- distinct symptom-observation days as a simple completeness indicator;
- recent seven-day symptoms compared with the preceding 23-day baseline;
- counts of repeated exposures;
- explicit limitations and alternative explanations.

Lag buckets are preserved in the result contract but the MVP does not estimate
trigger-specific lag effects or rank triggers. The next analysis milestone adds
coverage-aware exposure overlays and preregistered 0–6 h, 6–24 h, 1–3 d, and 3–7 d
comparisons only after enough repeated observations exist.

### 10.2 Reproducible snapshots

The MVP stores:

- the user question and requested window;
- an accepted-data cutoff;
- the default lag-window contract;
- code version;
- inclusion/exclusion counts;
- limitations and basic diagnostics.

Later inferential runs must additionally persist outcome/exposure definitions,
timezone and interval rules, missing-data policy, covariates, schema/vocabulary
versions, and the exact inclusion query.

### 10.3 Later methods

After simulation validation and enough data:

- self-controlled case-crossover with matched control windows;
- distributed lag models instead of unrestricted lag fishing;
- mixed-effects models only where a real hierarchy exists;
- Bayesian time-series/hierarchical models with regularizing priors;
- preregistered, low-risk N-of-1 experiments.

Models must address baseline trend, autocorrelation, repeated exposure, dose/duration,
time-varying treatment and confounding by indication, missingness, and multiple
testing. Exploratory findings remain labeled exploratory and are validated on later
data.

### 10.4 Evidence language

Results include effect direction/magnitude, interval, support counts, coverage,
missingness, lag, diagnostics, sensitivity, confounders, alternative explanations,
and one of:

- insufficient;
- weak;
- suggestive;
- stronger within-person association.

Even the strongest label is not causal. The LLM summarizes stored deterministic
results and cannot upgrade the evidence label or omit a failed diagnostic.

## 11. API surface

Initial authenticated endpoints:

```text
GET  /health
GET  /ready
POST /v1/jobs/extraction
POST /v1/jobs/analysis
POST /v1/jobs/report
POST /v1/jobs/export
POST /v1/jobs/deletion
GET  /v1/jobs/{job_id}
```

The frontend uses Supabase directly for normal RLS-protected CRUD and Storage. The
Python API is reserved for privileged or long-running operations.

All job-creation endpoints:

- validate the Supabase bearer JWT;
- check ownership of referenced records;
- create an idempotency key;
- return `202 Accepted`;
- validate bounded request fields through typed request models.

Host-level rate limiting is a production hardening item, not an implemented
application feature.

## 12. Security and privacy

- RLS is enabled and forced on every user-owned table.
- The browser receives only Supabase URL/publishable key and Python API URL.
- Service-role and AI keys remain server-only.
- Storage is private with user-prefix policies.
- Auth signup is restricted to the invited prototype user.
- CORS permits only configured Netlify/local origins.
- JWT issuer/audience/signature/expiry are validated.
- Uploaded content is constrained by bucket MIME/size rules and checked again before
  processing.
- Raw health data and provider payloads are excluded from application logs.
- URLs are not fetched in the prototype, avoiding an early SSRF surface.
- User/AI text is rendered as text, not trusted HTML.
- Exports use short-lived private downloads.
- Static safety copy is used for urgent-care signposting; AI does not triage photos.

This hosted design is not local-first. The first-run consent text must explicitly say
that structured data and originals are stored with Supabase and that enabled AI inputs
may be sent to the selected provider.

## 13. Export, deletion, and backup

### Export

A versioned ZIP contains:

- `manifest.json` with export format version and per-file hashes;
- JSONL for all exported user tables and the shared vocabulary needed to interpret
  user references;
- convenient CSV copies of non-empty structured tables;
- original artifacts;
- a short format README.

### Deletion

- Individual event deletion requires browser confirmation and removes linked
  observations, relations, assertions, and event-linked artifacts.
- Full tracking-data deletion requires the exact typed confirmation phrase.
- Full database deletion is performed by a privileged database function after private
  Storage objects are removed.
- The invited authentication account is intentionally retained so the user can start
  a fresh profile.
- Audit entries avoid copying deleted sensitive content.
- Existing external exports/backups cannot be remotely erased and this is disclosed.

### Backup

Supabase database backups do not include Storage objects. Operations must therefore:

- create regular logical database dumps;
- separately mirror all private buckets;
- verify both against a combined manifest;
- test restoration into a fresh project;
- keep at least one encrypted backup outside the live Supabase project.

## 14. Testing

The repository currently runs schema-fixture validation, migration execution,
behavioral two-user RLS/storage checks, TypeScript compilation, a production web
build, frontend smoke tests, strict Python typing/linting, and Python unit tests.
The following list is the full testing target; browser and deployed-service items are
completed during M3.4.

### Shared schemas

- valid and invalid fixtures for every schema version;
- compatibility checks preventing mutation of released schemas;
- TypeScript and Python representations checked against the same fixtures.

### Supabase

- migration from empty database;
- RLS tests proving user A cannot read/write user B data;
- private bucket and object-prefix policy tests;
- job claim/lease/retry/idempotency tests;
- trusted-data views exclude pending/rejected proposals.

### Python

- JWT validation and ownership checks;
- settings/secrets boundaries;
- deterministic fake extraction provider;
- malformed/refused AI output;
- proposal provenance and confidence;
- worker retry and lease behavior;
- lag/interval/timezone/missingness feature tests;
- safety language and report diagnostic gating;
- export manifest/checksum tests.

### Web

- component/unit tests for capture and review;
- browser tests for sign-in, profile, check-in, photo/audio upload, quick log, review,
  timeline, trends, report, export, and deletion;
- phone viewport, keyboard, accessible names, focus, contrast, and reduced motion;
- offline/API/AI failure states without data loss;
- no service secrets in the production bundle.

## 15. Implementation milestones

The code and configuration assets for M0–M3.3 are implemented in this repository.
M3.2 backup setup and all of M3.4 require the deployed Supabase, Netlify, and Python
environments and are the next operational work.

### M0 — hosted foundation

**M0.2 Revised domain schemas**

- versioned shared schemas, symptoms, body areas, and event vocabulary;
- ingestion/contact separation for prepared meals.

**M0.3 Supabase persistence/security**

- migrations, RLS, Storage buckets/policies, jobs, vocabulary seed;
- local Supabase instructions and migration validation.

**M0.4 Monorepo and continuous checks**

- web/Python/shared structure;
- root commands and CI-equivalent checks;
- environment examples.

### M1 — capture and trust

**M1.1 Authentication/profile**

- invited-user auth, consent, profile/timezone.

**M1.2 Skin checks/photos**

- morning/evening workflow, symptoms, body areas, private uploads, timeline.

**M1.3 Quick logging**

- meals/preparation/contact, products, treatments, activities, notes, audio.

**M1.4 AI extraction/review**

- extraction jobs, worker/provider, proposals, confidence/evidence, corrections.

### M2 — useful feedback and ownership

**M2.1 Trends/photo comparison**

- symptom charts, completeness, overlays, side-by-side photos.

**M2.2 Descriptive analysis/report**

- trusted snapshot, baseline comparison, alternatives/limitations, constrained report.

**M2.3 Export/deletion/backup**

- portable export, deletion jobs, documented and tested dual backup.

### M3 — deployment readiness

**M3.1 Netlify**

- production build, SPA routing, security headers, environment checklist.

**M3.2 Supabase**

- production migration, invited auth, private buckets, RLS smoke tests, backup setup.

**M3.3 Python host**

- multi-stage container, non-root runtime, API/worker commands, health/readiness,
  free inline-worker mode, and CORS/secrets checklist.

**M3.4 Prototype acceptance**

- end-to-end phone smoke test;
- export/restore drill;
- AI-disabled and provider-failure test;
- safety and privacy review.

## 16. Prototype deployment checklist

### Netlify

- configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and
  `VITE_API_BASE_URL`;
- deploy `apps/web`;
- set the production URL in Supabase Auth redirects and Python CORS;
- verify no secret values in the bundle.

### Supabase

- create a project in the intended data region;
- apply migrations and seed;
- create/invite only the prototype account;
- verify RLS with authenticated and unauthenticated requests;
- verify all buckets are private;
- configure database and separate Storage backups.

### Python container

- configure Supabase URL/service key/JWT issuer and AI key/model;
- run the API process and one worker process from the same image;
- allow CORS only from the Netlify production URL;
- verify `/health` and `/ready`;
- run a fake-provider job, then one consented live extraction;
- confirm logs contain no raw health inputs.

## 17. Prototype acceptance criteria

The prototype is ready for daily use when:

- the production phone flow can capture a complete skin check with private photos;
- a prepared meal records ingestion and direct skin contact independently;
- text/audio quick logs survive AI and network failures;
- AI output is never trusted before review;
- pending data is visibly distinct and excluded from analysis;
- timeline and trends render only the signed-in user's data;
- descriptive reports state uncertainty and alternatives without diagnosis;
- full export completes and its checksums validate;
- deletion and both database/Storage backup procedures are demonstrated;
- all automated checks pass from a clean checkout.

Advanced causal models, receipt/URL ingestion, automatic weather, image-derived
severity, public signup, multi-user product features, and cloud-to-cloud sync are
post-prototype work.
