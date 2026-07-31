import {readdir, readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";

const database = new PGlite();
const migrationsDirectory = new URL("../supabase/migrations/", import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((filename) => filename.endsWith(".sql"))
  .sort();
const migrations = await Promise.all(
  migrationFiles.map(async (filename) => {
    const source = await readFile(new URL(filename, migrationsDirectory), "utf8");
    // PGlite exposes gen_random_uuid() from core Postgres but does not bundle the
    // pgcrypto extension control file. Hosted Supabase includes pgcrypto.
    return source.replace("create extension if not exists pgcrypto;", "");
  }),
);
const seed = await readFile(new URL("../supabase/seed.sql", import.meta.url), "utf8");

await database.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (id uuid primary key);
  create or replace function auth.uid()
  returns uuid
  language sql
  stable
  as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;

  create schema storage;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text not null references storage.buckets(id),
    name text not null
  );
  alter table storage.objects enable row level security;
  alter table storage.objects force row level security;
  create or replace function storage.foldername(path text)
  returns text[]
  language sql
  immutable
  as $$
    select string_to_array(path, '/')
  $$;
`);

for (const migration of migrations) await database.exec(migration);
await database.exec(seed);

async function scalar(query) {
  const result = await database.query(query);
  return Number(Object.values(result.rows[0])[0]);
}

async function expectDenied(label, query) {
  try {
    await database.exec(query);
    console.error(`FAIL ${label}: operation unexpectedly succeeded`);
    return false;
  } catch {
    console.log(`PASS ${label}: denied`);
    return true;
  }
}

const assertions = [
  ["application tables", await scalar("select count(*) from information_schema.tables where table_schema = 'public'"), 21],
  ["RLS policies", await scalar("select count(*) from pg_policies where schemaname in ('public', 'storage')"), 33],
  ["private buckets", await scalar("select count(*) from storage.buckets where public = false"), 4],
  ["body areas", await scalar("select count(*) from public.body_areas"), 20],
  ["type definitions", await scalar("select count(*) from public.type_definitions"), 15],
  ["trusted views", await scalar("select count(*) from information_schema.views where table_schema = 'public' and table_name like 'trusted_%'"), 2],
  ["job claim function", await scalar("select count(*) from pg_proc where proname = 'claim_jobs'"), 1],
  ["review function", await scalar("select count(*) from pg_proc where proname = 'review_field_assertion'"), 1],
  ["deletion function", await scalar("select count(*) from pg_proc where proname = 'delete_user_tracking_data'"), 1],
  ["catalogue review function", await scalar("select count(*) from pg_proc where proname = 'review_catalogue_extraction'"), 1],
  ["catalogue create function", await scalar("select count(*) from pg_proc where proname = 'create_catalogue_item'"), 1],
  ["catalogue save function", await scalar("select count(*) from pg_proc where proname = 'save_catalogue_item'"), 1],
  ["meal-to-recipe function", await scalar("select count(*) from pg_proc where proname = 'save_meal_event_as_recipe'"), 1],
];

let failed = false;
for (const [label, actual, minimum] of assertions) {
  if (actual < minimum) {
    failed = true;
    console.error(`FAIL ${label}: expected at least ${minimum}, found ${actual}`);
  } else {
    console.log(`PASS ${label}: ${actual}`);
  }
}

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const userBConcept = "20000000-0000-4000-8000-000000000002";
const userBMealEvent = "10000000-0000-4000-8000-000000000002";

await database.exec(`
  insert into auth.users (id) values ('${userA}'), ('${userB}');
  insert into public.profiles (user_id, display_name)
  values ('${userA}', 'User A'), ('${userB}', 'User B');
  insert into public.concepts (id, user_id, concept_type, canonical_name)
  values ('${userBConcept}', '${userB}', 'product', 'User B private product');
  insert into public.events (
    id, user_id, type_code, occurred_start, recorded_timezone, trust_status
  ) values (
    '${userBMealEvent}', '${userB}', 'meal',
    '2026-07-29T07:00:00Z', 'Europe/Rome', 'trusted'
  );
  grant usage on schema public, storage, auth to authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant select, insert, update, delete on storage.objects to authenticated;
  set role authenticated;
  set request.jwt.claim.sub = '${userA}';
`);

const visibleProfiles = await scalar("select count(*) from public.profiles");
if (visibleProfiles === 1) {
  console.log("PASS profile tenant isolation: 1");
} else {
  failed = true;
  console.error(`FAIL profile tenant isolation: expected 1, found ${visibleProfiles}`);
}

const ownEventId = "10000000-0000-4000-8000-000000000001";
await database.exec(`
  insert into public.events (
    id, user_id, type_code, occurred_start, recorded_timezone, trust_status
  ) values (
    '${ownEventId}', '${userA}', 'note',
    '2026-07-29T08:00:00Z', 'Europe/Rome', 'trusted'
  );
`);
console.log("PASS owner event insert: 1");

await database.exec(`
  select public.create_catalogue_item(
    'treatment',
    'Test cream',
    '{"brand":"Test brand","form":"cream"}'::jsonb,
    '["Water","Glycerin"]'::jsonb
  );
`);
const ownCatalogueItems = await scalar(`
  select count(*) from public.concepts
  where user_id = '${userA}' and concept_type = 'treatment'
`);
const ownReviewedComponents = await scalar(`
  select count(*) from public.compositions
  where user_id = '${userA}' and review_state = 'accepted'
`);
if (ownCatalogueItems === 1 && ownReviewedComponents === 2) {
  console.log("PASS catalogue item and composition creation: 1");
} else {
  failed = true;
  console.error(
    `FAIL catalogue creation: expected 1 item/2 components, found ${ownCatalogueItems}/${ownReviewedComponents}`,
  );
}

const catalogueArtifact = "30000000-0000-4000-8000-000000000001";
const catalogueExtraction = "40000000-0000-4000-8000-000000000001";
await database.exec(`
  insert into public.artifacts (
    id, user_id, bucket, object_path, media_type, byte_size, artifact_kind
  ) values (
    '${catalogueArtifact}',
    '${userA}',
    'input-originals',
    '${userA}/test-cream/label.jpg',
    'image/jpeg',
    1,
    'ingredient_label'
  );
  insert into public.catalogue_extractions (
    id,
    user_id,
    concept_id,
    artifact_id,
    provider,
    model,
    prompt_version,
    status,
    proposal
  )
  select
    '${catalogueExtraction}',
    '${userA}',
    id,
    '${catalogueArtifact}',
    'fake',
    'deterministic-v1',
    'product-label-v1',
    'succeeded',
    '{"product_name":null,"brand":null,"variant":null,"ingredients":[]}'::jsonb
  from public.concepts
  where user_id = '${userA}' and canonical_name = 'Test cream';

  select public.review_catalogue_extraction(
    '${catalogueExtraction}',
    'corrected',
    null,
    '',
    '',
    '[]'::jsonb
  );
`);
const preservedCatalogueFields = await scalar(`
  select count(*)
  from public.concepts
  where
    user_id = '${userA}'
    and canonical_name = 'Test cream'
    and attributes ->> 'brand' = 'Test brand'
    and attributes ->> 'form' = 'cream'
`);
const preservedVersionSnapshot = await scalar(`
  select count(*)
  from public.concept_versions
  where
    user_id = '${userA}'
    and effective_to is null
    and attributes ->> 'brand' = 'Test brand'
    and attributes ->> 'form' = 'cream'
`);
const preservedCurrentComponents = await scalar(`
  select count(*)
  from public.compositions composition
  join public.concept_versions version
    on version.id = composition.owner_version_id
  where
    composition.user_id = '${userA}'
    and version.effective_to is null
`);
if (
  preservedCatalogueFields === 1
  && preservedVersionSnapshot === 1
  && preservedCurrentComponents === 2
) {
  console.log("PASS empty AI fields preserve manual catalogue data: 1");
} else {
  failed = true;
  console.error(
    "FAIL safe catalogue review: empty AI fields replaced manual data "
      + `(${preservedCatalogueFields}/${preservedVersionSnapshot}/${preservedCurrentComponents})`,
  );
}

const reusableMealEvent = "10000000-0000-4000-8000-000000000003";
await database.exec(`
  insert into public.events (
    id, user_id, type_code, occurred_start, recorded_timezone, trust_status
  ) values (
    '${reusableMealEvent}', '${userA}', 'meal',
    '2026-07-29T12:00:00Z', 'Europe/Rome', 'trusted'
  );

  select public.save_meal_event_as_recipe(
    '${reusableMealEvent}',
    'Saved lentil soup',
    '["Lentils","Carrot","Onion"]'::jsonb,
    'Chop vegetables and simmer',
    'Chop carrot and onion with bare hands'
  );
`);
const savedMealRecipeLinks = await scalar(`
  select count(*)
  from public.event_concepts event_concept
  join public.concepts recipe on recipe.id = event_concept.concept_id
  join public.concept_versions version on version.id = event_concept.concept_version_id
  where
    event_concept.event_id = '${reusableMealEvent}'
    and event_concept.user_id = '${userA}'
    and event_concept.role = 'consumed'
    and recipe.concept_type = 'recipe'
    and recipe.canonical_name = 'Saved lentil soup'
    and recipe.attributes ->> 'preparation_notes' = 'Chop vegetables and simmer'
    and recipe.attributes ->> 'preparation_contact_notes'
      = 'Chop carrot and onion with bare hands'
    and version.effective_to is null
`);
const savedMealRecipeIngredients = await scalar(`
  select count(*)
  from public.compositions composition
  join public.concepts recipe on recipe.id = composition.owner_concept_id
  where
    recipe.canonical_name = 'Saved lentil soup'
    and recipe.user_id = '${userA}'
`);
if (savedMealRecipeLinks === 1 && savedMealRecipeIngredients === 3) {
  console.log("PASS logged meal saved and linked as reusable recipe: 1");
} else {
  failed = true;
  console.error(
    "FAIL logged meal recipe save/link "
      + `(${savedMealRecipeLinks}/${savedMealRecipeIngredients})`,
  );
}
if (
  !(await expectDenied(
    "duplicate meal recipe conversion",
    `
      select public.save_meal_event_as_recipe(
        '${reusableMealEvent}',
        'Duplicate lentil soup',
        '[]'::jsonb,
        '',
        ''
      )
    `,
  ))
) {
  failed = true;
}

await database.exec(`
  insert into public.event_concepts (
    user_id,
    event_id,
    concept_id,
    concept_version_id,
    role,
    review_state
  )
  select
    '${userA}',
    '${ownEventId}',
    concept.id,
    version.id,
    'applied',
    'accepted'
  from public.concepts concept
  join public.concept_versions version on version.concept_id = concept.id
  where
    concept.user_id = '${userA}'
    and concept.canonical_name = 'Test cream'
    and version.effective_to is null;

  select public.save_catalogue_item(
    'treatment',
    'Updated test cream',
    '{"brand":"Test brand","form":"ointment","strength":"1%"}'::jsonb,
    '["Water","Petrolatum"]'::jsonb,
    (
      select id from public.concepts
      where user_id = '${userA}' and canonical_name = 'Test cream'
    ),
    null
  );

  select public.save_catalogue_item(
    'recipe',
    'Tomato pasta',
    '{"preparation_notes":"Chop tomatoes and simmer sauce","preparation_contact_notes":"Chop tomatoes with bare hands"}'::jsonb,
    '["Pasta","Tomato"]'::jsonb,
    null,
    null
  );

  select public.save_catalogue_item(
    'recipe',
    'Tomato pasta with spinach',
    '{"preparation_notes":"Chop tomatoes, add spinach, and simmer","preparation_contact_notes":"Chop tomatoes and spinach with bare hands"}'::jsonb,
    '["Pasta","Tomato","Spinach"]'::jsonb,
    null,
    (
      select id from public.concepts
      where user_id = '${userA}' and canonical_name = 'Tomato pasta'
    )
  );
`);
const editedItemCount = await scalar(`
  select count(*) from public.concepts
  where
    user_id = '${userA}'
    and concept_type = 'treatment'
    and canonical_name = 'Updated test cream'
    and attributes ->> 'form' = 'ointment'
    and attributes ->> 'strength' = '1%'
`);
const editedItemVersions = await scalar(`
  select count(*) from public.concept_versions version
  join public.concepts concept on concept.id = version.concept_id
  where
    concept.user_id = '${userA}'
    and concept.canonical_name = 'Updated test cream'
`);
const recipeCount = await scalar(`
  select count(*) from public.concepts
  where user_id = '${userA}' and concept_type = 'recipe'
`);
const recipeVariationRelations = await scalar(`
  select count(*) from public.concept_relations
  where user_id = '${userA}' and predicate = 'derived_from'
`);
const recipePreparationDetails = await scalar(`
  select count(*)
  from public.concepts recipe
  where
    recipe.user_id = '${userA}'
    and recipe.concept_type = 'recipe'
    and nullif(recipe.attributes ->> 'preparation_notes', '') is not null
    and nullif(recipe.attributes ->> 'preparation_contact_notes', '') is not null
`);
const retainedHistoricalVersionLinks = await scalar(`
  select count(*)
  from public.event_concepts event_concept
  join public.concept_versions version on version.id = event_concept.concept_version_id
  join public.concepts concept on concept.id = event_concept.concept_id
  where
    event_concept.user_id = '${userA}'
    and concept.canonical_name = 'Updated test cream'
    and version.version_number = 2
    and version.effective_to is not null
`);
if (
  editedItemCount === 1
  && editedItemVersions === 3
  && recipeCount === 3
  && recipeVariationRelations === 1
  && recipePreparationDetails === 3
  && retainedHistoricalVersionLinks === 1
) {
  console.log("PASS editable catalogue items and derived recipe variations: 1");
} else {
  failed = true;
  console.error(
    "FAIL editable catalogue/recipe variation "
      + `(${editedItemCount}/${editedItemVersions}/${recipeCount}/`
      + `${recipeVariationRelations}/${recipePreparationDetails}/`
      + `${retainedHistoricalVersionLinks})`,
  );
}

if (
  !(await expectDenied(
    "cross-tenant event insert",
    `
      insert into public.events (
        user_id, type_code, occurred_start, recorded_timezone, trust_status
      ) values (
        '${userB}', 'note', '2026-07-29T09:00:00Z', 'Europe/Rome', 'trusted'
      )
    `,
  ))
) {
  failed = true;
}

if (
  !(await expectDenied(
    "cross-tenant meal recipe save",
    `
      select public.save_meal_event_as_recipe(
        '${userBMealEvent}',
        'Stolen recipe',
        '[]'::jsonb,
        '',
        ''
      )
    `,
  ))
) {
  failed = true;
}

if (
  !(await expectDenied(
    "cross-tenant catalogue version",
    `
      insert into public.concept_versions (
        user_id, concept_id, version_number, attributes
      ) values (
        '${userA}', '${userBConcept}', 1, '{}'::jsonb
      )
    `,
  ))
) {
  failed = true;
}

if (
  !(await expectDenied(
    "cross-tenant relation integrity",
    `
      insert into public.observations (
        user_id, event_id, type_code, observed_at, text_value
      ) values (
        '${userB}', '${ownEventId}', 'note',
        '2026-07-29T09:00:00Z', 'cross-tenant attempt'
      )
    `,
  ))
) {
  failed = true;
}

await database.exec(`
  insert into storage.objects (bucket_id, name)
  values ('skin-originals', '${userA}/skin-check/allowed.jpg');
`);
console.log("PASS owner storage insert: 1");

if (
  !(await expectDenied(
    "cross-tenant storage insert",
    `
      insert into storage.objects (bucket_id, name)
      values ('skin-originals', '${userB}/skin-check/denied.jpg')
    `,
  ))
) {
  failed = true;
}

await database.exec("reset role; reset request.jwt.claim.sub;");
await database.close();
if (failed) process.exitCode = 1;
