# Prototype deployment runbook

This runbook deploys the web app to Netlify, durable data to Supabase, and the Python
API/worker to a Docker-capable host. `render.yaml` is provided as a ready Blueprint,
but the Docker image is portable.

## 1. Preflight

From a clean checkout:

```sh
npm ci
cd services/python && uv sync --frozen --all-groups
cd ../..
make check
docker build -t pajara-python:local .
```

Do not put real secrets in `.env.example`, `netlify.toml`, `render.yaml`, Git, build
arguments, or the frontend.

## 2. Supabase

1. Create one project in the intended data region.
2. Install/login to the Supabase CLI.
3. Link the repository:

   ```sh
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   ```

4. Review pending changes and apply migrations:

   ```sh
   npx supabase db diff --linked
   npx supabase db push --include-seed
   ```

   For an existing Pajara project, confirm that the catalogue migrations
   `202607290002_catalogue.sql`, `202607290003_safe_catalogue_review.sql`, and
   `202607290004_editable_catalogue_recipes.sql` are present. Also confirm that
   `202607310001_save_meal_as_recipe.sql` is listed as pending before approving the push.
   They add versioned saved items, preserve manual data during image review, add editable
   recipes/variations, and transactionally convert a logged meal into a linked recipe;
   they do not replace existing logs.

5. In Authentication:
   - set the initial Site URL to the eventual Netlify production URL;
   - add `http://localhost:5173` only for local development;
   - disable open signup for the prototype;
   - invite/create the one prototype account;
   - configure production SMTP before relying on email login outside the project team.
6. Verify `skin-originals`, `voice-originals`, `input-originals`, and
   `derived-private` are all private.
7. Copy the Project URL, publishable key, and server-only secret key.
8. Run two-user RLS checks before storing real data.

The secret key bypasses RLS. It belongs only in the Python API/worker secret store.

## 3. Python API and job processing

### Render Blueprint

1. Create a Render Blueprint from this repository and `render.yaml`.
2. The prototype Blueprint creates one Free web service. Enter:
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SECRET_KEY` (`sb_secret_…`)
   - `SUPABASE_JWT_ISSUER` (`https://PROJECT.supabase.co/auth/v1`)
   - `CORS_ORIGINS` (the exact Netlify production origin)
   - `OPENAI_API_KEY` as a Render secret (`sk-…`); never expose it to Netlify
3. Keep the Blueprint defaults `EXTRACTION_PROVIDER=openai` and
   `RUN_WORKER_IN_API=true`. The low-cost model routing defaults are:
   - `OPENAI_EXTRACTION_MODEL=gpt-4.1-mini` for routine text extraction;
   - `OPENAI_PRODUCT_LABEL_MODEL=gpt-5.4-mini` for photographed labels;
   - `OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe` only when the user
     explicitly requests backend fallback.
4. Deploy and verify:

   ```sh
   curl --fail https://YOUR_API_HOST/health
   curl --fail https://YOUR_API_HOST/ready
   ```

5. Queue a job and confirm the API claims it after returning the response, without
   logging job payloads or health inputs.

The Blueprint enables remote extraction by default. Add the server-only
`OPENAI_API_KEY` in the Render service's **Environment** settings and redeploy. Render
passes the same environment to the inline worker. If the API and worker are later
split into separate Render services, add the secret to both services. To disable all
remote AI without changing the application, set `EXTRACTION_PROVIDER=fake`; catalogue
items, manual ingredients, images, and logging still work, but image extraction
returns an explicit warning rather than pretending to read the label.

The Free service spins down after inactivity and can take about one minute to wake.
This is acceptable for a single-user prototype, not production. Jobs remain durable
in Supabase. A later paid deployment sets `RUN_WORKER_IN_API=false` and runs the same
image twice:

```text
pajara api
pajara worker
```

Expose only the API process. The separate worker needs outbound network access but no
public port.

## 4. Netlify

1. Import the repository into Netlify. `netlify.toml` supplies the build and publish
   settings.
2. Add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
   - `VITE_API_BASE_URL`
3. Deploy.
4. Put the exact Netlify production URL into:
   - Supabase Auth Site URL and redirect allowlist;
   - Python `CORS_ORIGINS`.
5. Redeploy the Python API after changing CORS.
6. Inspect the production JavaScript bundle and confirm it contains no secret/admin or
   AI key.

### Local voice transcription

Voice notes use the pinned beta package `@moonshine-ai/moonshine-js` and its English
Tiny model. The package is loaded only when a recording needs transcription. On first
use, the browser downloads model and ONNX runtime assets from
`download.moonshine.ai` and `cdn.jsdelivr.net`; the current Content Security Policy
allows those HTTPS requests. The currently referenced encoder, decoder, and WASM
runtime total roughly 50 MB, so perform the first phone test on a reliable connection.

No Moonshine key or Netlify environment variable is required. Test the deployed app
on each intended phone/browser because model download, audio decoding, memory, and
browser cache eviction vary by device. The current browser package does not require
cross-origin isolation headers, so do not add COOP/COEP without separately
regression-testing Supabase Auth and signed Storage URLs.

The exact official 0.1.29 browser bundle and licence are checked into
`vendor/moonshine-js`. This avoids an invalid repository-local dependency in the
upstream npm manifest and prevents unused Node-only packages from entering the
Netlify build. Verify its documented SHA-256 before intentional replacement. CSP
includes the narrow `wasm-unsafe-eval` permission required for browser WASM; it does
not enable general JavaScript `unsafe-eval`. It also allows scripts and workers only
from jsDelivr in addition to Pajara itself because ONNX Runtime dynamically imports
its pinned runtime module from that CDN.

If local transcription fails, the user must either enter and confirm the transcript
manually or explicitly select the backend fallback. Backend fallback requires
`EXTRACTION_PROVIDER=openai` and `OPENAI_API_KEY`; its proposed transcript remains
draft data until reviewed.

## 5. Acceptance test

On the intended phone:

1. Sign in through the invited email.
2. Accept the hosted-data disclosure and create a profile.
3. Save a morning skin check with one photo.
4. Confirm the Storage object is private.
5. Log a prepared meal:
   - save or select a recipe with its ingredient list, preparation method, and usual
     preparation-contact prompt;
   - confirm or correct the method and actual contact for this occurrence;
   - choose body area, glove state, and glove material where applicable;
   - verify consumption and preparation/contact appear as linked events.
   - for a meal that did not use a saved recipe, use **Save as a recipe**, review the
     reusable fields, and confirm the timeline now shows the linked recipe;
6. Add a saved cream or household product:
   - enter any known ingredients;
   - attach a front and ingredient-label photo;
   - if remote AI is enabled, review/correct the proposed ordered ingredient list;
   - log the saved item and verify the event references its formulation version.
7. Log a shower and washing-up activity, including all products used, water
   temperature, duration, gloves, and direct contact where applicable.
8. Record an English voice note of no more than 30 seconds:
   - allow the first-use Moonshine download to complete;
   - correct and confirm the local transcript;
   - verify the event retains transcription provenance and the private original audio.
9. Queue fake extraction, let the worker process it, then accept/correct/reject fields.
10. Confirm pending data is absent from trusted trends until review.
11. Run a descriptive analysis and generate a report.
12. Queue an export and validate its manifest checksums.
13. Turn off the AI/backend and confirm manual capture still saves.

Only after that test should `EXTRACTION_PROVIDER=openai` be enabled for one consented
sample.

## 6. Backup before daily use

Supabase database backups exclude Storage objects. Configure both:

- a regular logical database dump;
- a separate mirror of all four private buckets;
- a combined checksum manifest;
- an encrypted copy outside the live project.

Perform a restore into a disposable Supabase project before calling the prototype
ready for daily use.

## 7. Known prototype limits

- Generated full exports include original media available at export time. Operational
  backups must still mirror Storage independently.
- Photo comparison supports side-by-side review and an opacity overlay. Automatic
  alignment and synchronized zoom remain later enhancements.
- Saved meals and recipe variations are available. Recipe-image extraction is still
  transcription assistance and must be reviewed. Saved preparation/contact notes are
  only editable prompts; they do not establish what touched skin on a particular
  occasion until confirmed in that meal's preparation log.
- Analysis is deliberately descriptive until enough repeated observations exist.
- Moonshine browser transcription is currently English-only in this prototype and
  uses a beta package pinned to an exact version.
