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

const backfillUser = "00000000-0000-4000-8000-000000000099";
const backfillCapture = "60000000-0000-4000-8000-000000000099";
const backfillArtifact = "30000000-0000-4000-8000-000000000099";
for (const [index, migration] of migrations.entries()) {
  if (migrationFiles[index] === "202608100001_quick_log_conversation.sql") {
    await database.exec(`
      insert into auth.users (id) values ('${backfillUser}');
      insert into public.artifacts (
        id, user_id, bucket, object_path, media_type, byte_size, artifact_kind
      ) values (
        '${backfillArtifact}', '${backfillUser}', 'input-originals',
        '${backfillUser}/legacy/photo.jpg', 'image/jpeg', 1, 'meal_photo'
      );
      insert into public.capture_sessions (
        id, user_id, source_type, artifact_id, occurred_at, recorded_timezone
      ) values (
        '${backfillCapture}', '${backfillUser}', 'photo', '${backfillArtifact}',
        '2026-08-09T10:00:00Z', 'Europe/Rome'
      );
    `);
  }
  await database.exec(migration);
}
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
  ["meal-to-food-recipe function", await scalar("select count(*) from pg_proc where proname = 'save_meal_event_as_food_recipe'"), 1],
  ["food save function", await scalar("select count(*) from pg_proc where proname = 'save_food_item'"), 1],
  ["versioned recipe save function", await scalar("select count(*) from pg_proc where proname = 'save_recipe_definition'"), 1],
  ["recipe flatten function", await scalar("select count(*) from pg_proc where proname = 'flatten_recipe_components'"), 1],
  ["activity bundle function", await scalar("select count(*) from pg_proc where proname = 'log_activity_bundle'"), 1],
  ["Quick Log artifact table", await scalar("select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'capture_artifacts'"), 1],
  ["Quick Log message table", await scalar("select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'capture_messages'"), 1],
  ["Quick Log review table", await scalar("select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'capture_review_fields'"), 1],
  ["atomic Quick Log function", await scalar("select count(*) from pg_proc where proname = 'confirm_quick_log_capture'"), 1],
  ["existing capture artifact backfill", await scalar(`select count(*) from public.capture_artifacts where capture_session_id = '${backfillCapture}' and artifact_id = '${backfillArtifact}'`), 1],
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
const userBFood = "50000000-0000-4000-8000-000000000002";
const userBMealEvent = "10000000-0000-4000-8000-000000000002";
const userBCapture = "60000000-0000-4000-8000-000000000002";
const userBArtifact = "30000000-0000-4000-8000-000000000002";

await database.exec(`
  insert into auth.users (id) values ('${userA}'), ('${userB}');
  insert into public.profiles (user_id, display_name)
  values ('${userA}', 'User A'), ('${userB}', 'User B');
  insert into public.concepts (id, user_id, concept_type, canonical_name)
  values ('${userBConcept}', '${userB}', 'product', 'User B private product');
  insert into public.food_items (id, user_id, canonical_name)
  values ('${userBFood}', '${userB}', 'User B private food');
  insert into public.events (
    id, user_id, type_code, occurred_start, recorded_timezone, trust_status
  ) values (
    '${userBMealEvent}', '${userB}', 'meal',
    '2026-07-29T07:00:00Z', 'Europe/Rome', 'trusted'
  );
  insert into public.artifacts (
    id, user_id, bucket, object_path, media_type, byte_size, artifact_kind
  ) values (
    '${userBArtifact}', '${userB}', 'input-originals',
    '${userB}/private/photo.jpg', 'image/jpeg', 1, 'capture_input'
  );
  insert into public.capture_sessions (
    id, user_id, profile_id, source_type, occurred_at, recorded_timezone
  ) values (
    '${userBCapture}', '${userB}',
    (select id from public.profiles where user_id = '${userB}'),
    'mixed', '2026-08-10T10:00:00Z', 'Europe/Rome'
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

const graphMealEvent = "10000000-0000-4000-8000-000000000004";
await database.exec(`
  insert into public.events (
    id, user_id, type_code, occurred_start, recorded_timezone, trust_status,
    attributes
  ) values (
    '${graphMealEvent}', '${userA}', 'meal',
    '2026-07-29T12:30:00Z', 'Europe/Rome', 'trusted',
    '{"ingestion_method":"drank"}'::jsonb
  );
  select public.save_meal_event_as_food_recipe(
    '${graphMealEvent}',
    'Saved smoothie',
    '["Banana","Oat milk"]'::jsonb,
    'Blend until smooth',
    'Peeled the banana with both hands'
  );
`);
const graphMealRecipeLinks = await scalar(`
  select count(*) from public.event_concepts link
  join public.recipe_versions version on version.id = link.recipe_version_id
  join public.recipes recipe on recipe.id = version.recipe_id
  where link.event_id = '${graphMealEvent}' and link.role = 'consumed'
    and link.ingestion_method = 'drank' and recipe.name = 'Saved smoothie'
`);
const graphMealRecipeIngredients = await scalar(`
  select count(*) from public.recipe_components component
  join public.recipe_versions version on version.id = component.recipe_version_id
  join public.recipes recipe on recipe.id = version.recipe_id
  where recipe.user_id = '${userA}' and recipe.name = 'Saved smoothie'
`);
if (graphMealRecipeLinks === 1 && graphMealRecipeIngredients === 2) {
  console.log("PASS historical meal promoted into the food recipe graph: 1");
} else {
  failed = true;
  console.error(
    `FAIL graph-native meal recipe save/link (${graphMealRecipeLinks}/${graphMealRecipeIngredients})`,
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

await database.exec(`
  select public.save_recipe_definition(
    'Tomato sauce',
    '[{"name":"Tomato"},{"name":"Onion"}]'::jsonb,
    'Simmer until reduced',
    2,
    'portions',
    null,
    null,
    '{}'::jsonb
  );

  select public.save_recipe_definition(
    'Pasta with tomato sauce',
    jsonb_build_array(
      jsonb_build_object('name', 'Pasta'),
      jsonb_build_object(
        'source_recipe_version_id',
        (
          select version.id
          from public.recipe_versions version
          join public.recipes recipe on recipe.id = version.recipe_id
          where recipe.user_id = '${userA}' and recipe.name = 'Tomato sauce'
            and version.effective_to is null
        )
      )
    ),
    'Cook pasta and add sauce',
    1,
    'portion',
    null,
    null,
    '{}'::jsonb
  );
`);

const flattenedNestedIngredients = await scalar(`
  select count(*)
  from public.flatten_recipe_components((
    select version.id
    from public.recipe_versions version
    join public.recipes recipe on recipe.id = version.recipe_id
    where recipe.user_id = '${userA}' and recipe.name = 'Pasta with tomato sauce'
      and version.effective_to is null
  ))
`);
const nestedDepth = await scalar(`
  select max(depth)
  from public.flatten_recipe_components((
    select version.id
    from public.recipe_versions version
    join public.recipes recipe on recipe.id = version.recipe_id
    where recipe.user_id = '${userA}' and recipe.name = 'Pasta with tomato sauce'
      and version.effective_to is null
  ))
`);
if (flattenedNestedIngredients === 3 && nestedDepth === 2) {
  console.log("PASS exact-version nested recipe flattening: 1");
} else {
  failed = true;
  console.error(
    `FAIL nested recipe flattening: expected 3 leaves/depth 2, found ${flattenedNestedIngredients}/${nestedDepth}`,
  );
}

await database.exec(`
  select public.save_recipe_definition(
    'Tomato sauce',
    jsonb_build_array(jsonb_build_object(
      'source_recipe_version_id',
      (
        select version.id
        from public.recipe_versions version
        join public.recipes recipe on recipe.id = version.recipe_id
        where recipe.user_id = '${userA}' and recipe.name = 'Pasta with tomato sauce'
          and version.effective_to is null
      )
    )),
    'Reuse a finite amount of the previous pasta batch',
    null,
    null,
    (
      select id from public.recipes
      where user_id = '${userA}' and name = 'Tomato sauce'
    ),
    null,
    '{}'::jsonb
  )
`);
console.log("PASS prior recipe versions can be reused without creating a graph cycle: 1");

await database.exec(`
  select public.save_recipe_definition(
    'Jarred pesto',
    jsonb_build_array(
      jsonb_build_object('name', 'Basil'),
      jsonb_build_object('name', 'Olive oil')
    ),
    null,
    null,
    null,
    null,
    null,
    jsonb_build_object(
      'output_food_kind', 'commercial_product',
      'created_from_capture_session_id', 'label-review'
    )
  )
`);
const commercialProductCount = await scalar(`
  select count(*) from public.recipes recipe
  join public.food_items food on food.id = recipe.output_food_item_id
  where recipe.user_id = '${userA}' and recipe.name = 'Jarred pesto'
    and food.food_kind = 'commercial_product'
`);
if (commercialProductCount === 1) {
  console.log("PASS reviewed ingredient label creates a commercial-food formulation: 1");
} else {
  failed = true;
  console.error(`FAIL commercial-food formulation: expected 1, found ${commercialProductCount}`);
}

if (
  !(await expectDenied(
    "exact recipe-version cycle",
    `
      insert into public.recipe_components (
        user_id, recipe_version_id, component_food_item_id,
        source_recipe_version_id, component_order
      )
      select
        '${userA}', version.id, recipe.output_food_item_id, version.id, 2
      from public.recipe_versions version
      join public.recipes recipe on recipe.id = version.recipe_id
      where recipe.user_id = '${userA}' and recipe.name = 'Tomato sauce'
        and version.effective_to is null
    `,
  ))
) {
  failed = true;
}

if (
  !(await expectDenied(
    "mismatched recipe output participant",
    `
      insert into public.event_concepts (
        user_id, event_id, food_item_id, recipe_version_id, role, review_state
      ) values (
        '${userA}',
        '${ownEventId}',
        (
          select id from public.food_items
          where user_id = '${userA}' and canonical_name = 'Tomato'
          limit 1
        ),
        (
          select version.id from public.recipe_versions version
          join public.recipes recipe on recipe.id = version.recipe_id
          where recipe.user_id = '${userA}' and recipe.name = 'Pasta with tomato sauce'
            and version.effective_to is null
        ),
        'present',
        'accepted'
      )
    `,
  ))
) {
  failed = true;
}

const captureId = "60000000-0000-4000-8000-000000000001";
await database.exec(`
  insert into public.capture_sessions (
    id, user_id, profile_id, source_type, occurred_at, recorded_timezone, status
  ) values (
    '${captureId}', '${userA}',
    (select id from public.profiles where user_id = '${userA}'),
    'photo', '2026-07-29T13:00:00Z', 'Europe/Rome', 'ready'
  );
  insert into public.activity_proposals (
    user_id, capture_session_id, proposal_order, activity_type, label
  ) values (
    '${userA}', '${captureId}', 1, 'meal', 'Pasta with tomato sauce'
  );

  select public.log_activity_bundle(
    (select id from public.profiles where user_id = '${userA}'),
    '2026-07-29T13:00:00Z',
    'Europe/Rome',
    '${captureId}',
    jsonb_build_array(
      jsonb_build_object(
        'type_code', 'meal',
        'label', 'Pasta with tomato sauce',
        'source_method', 'photo',
        'participants', jsonb_build_array(jsonb_build_object(
          'food_item_id', (
            select output_food_item_id from public.recipes
            where user_id = '${userA}' and name = 'Pasta with tomato sauce'
          ),
          'recipe_version_id', (
            select version.id from public.recipe_versions version
            join public.recipes recipe on recipe.id = version.recipe_id
            where recipe.user_id = '${userA}' and recipe.name = 'Pasta with tomato sauce'
              and version.effective_to is null
          ),
          'role', 'consumed',
          'ingestion_method', 'eaten',
          'route', 'oral'
        ))
      ),
      jsonb_build_object(
        'type_code', 'meal_preparation',
        'label', 'Pasta preparation',
        'source_method', 'photo',
        'parent_order', 1,
        'relation_type', 'prepared_by',
        'participants', jsonb_build_array(
          jsonb_build_object(
            'food_item_id', (
              select output_food_item_id from public.recipes
              where user_id = '${userA}' and name = 'Pasta with tomato sauce'
            ),
            'recipe_version_id', (
              select version.id from public.recipe_versions version
              join public.recipes recipe on recipe.id = version.recipe_id
              where recipe.user_id = '${userA}' and recipe.name = 'Pasta with tomato sauce'
                and version.effective_to is null
            ),
            'role', 'prepared'
          ),
          jsonb_build_object(
            'food_item_id', (
              select id from public.food_items
              where user_id = '${userA}' and canonical_name = 'Tomato'
              limit 1
            ),
            'role', 'contacted',
            'body_area_code', 'both_hands',
            'direct_contact', 'yes'
          )
        )
      )
    )
  );
`);
const captureEventCount = await scalar(`
  select count(*) from public.events where capture_session_id = '${captureId}'
`);
const captureRelationCount = await scalar(`
  select count(*) from public.event_relations relation
  join public.events parent on parent.id = relation.from_event_id
  join public.events child on child.id = relation.to_event_id
  where parent.capture_session_id = '${captureId}' and child.capture_session_id = '${captureId}'
`);
const confirmedCaptureCount = await scalar(`
  select count(*) from public.capture_sessions
  where id = '${captureId}' and status = 'confirmed' and confirmed_at is not null
`);
const acceptedCaptureProposals = await scalar(`
  select count(*) from public.activity_proposals
  where capture_session_id = '${captureId}' and review_state = 'accepted'
`);
const captureBatchCount = await scalar(`
  select count(*) from public.food_batches batch
  join public.events event on event.id = batch.produced_by_event_id
  where event.capture_session_id = '${captureId}'
`);
if (
  captureEventCount === 2
  && captureRelationCount === 1
  && confirmedCaptureCount === 1
  && acceptedCaptureProposals === 1
  && captureBatchCount === 1
) {
  console.log("PASS confirmed capture creates linked ingestion and preparation events: 1");
} else {
  failed = true;
  console.error(
    "FAIL capture activity bundle "
      + `(${captureEventCount}/${captureRelationCount}/${confirmedCaptureCount}/${acceptedCaptureProposals}/${captureBatchCount})`,
  );
}

await database.exec(`
  select public.save_recipe_definition(
    'Leftover pasta bake',
    jsonb_build_array(jsonb_build_object(
      'source_recipe_version_id',
      (
        select batch.recipe_version_id from public.food_batches batch
        join public.events event on event.id = batch.produced_by_event_id
        where event.capture_session_id = '${captureId}'
        order by batch.prepared_at desc limit 1
      )
    )),
    'Bake the remaining pasta',
    null,
    null,
    null,
    null,
    '{}'::jsonb
  )
`);
const leftoverComponentCount = await scalar(`
  select count(*) from public.recipe_components component
  join public.recipe_versions version on version.id = component.recipe_version_id
  join public.recipes recipe on recipe.id = version.recipe_id
  where recipe.user_id = '${userA}' and recipe.name = 'Leftover pasta bake'
    and component.source_recipe_version_id is not null
`);
await database.exec(`
  select public.log_activity_bundle(
    (select id from public.profiles where user_id = '${userA}'),
    '2026-07-30T13:00:00Z',
    'Europe/Rome',
    null,
    jsonb_build_array(jsonb_build_object(
      'type_code', 'meal_preparation',
      'label', 'Leftover pasta bake preparation',
      'participants', jsonb_build_array(jsonb_build_object(
        'food_batch_id', (
          select batch.id from public.food_batches batch
          join public.events event on event.id = batch.produced_by_event_id
          where event.capture_session_id = '${captureId}'
          order by batch.prepared_at desc limit 1
        ),
        'role', 'used'
      ))
    ))
  )
`);
const leftoverBatchUseCount = await scalar(`
  select count(*) from public.event_concepts participant
  join public.events event on event.id = participant.event_id
  where event.user_id = '${userA}' and event.label = 'Leftover pasta bake preparation'
    and participant.food_batch_id is not null and participant.role = 'used'
`);
if (leftoverComponentCount === 1 && leftoverBatchUseCount === 1) {
  console.log("PASS leftovers preserve reusable recipe version and actual batch use: 1");
} else {
  failed = true;
  console.error(`FAIL leftover plan/event identity: ${leftoverComponentCount}/${leftoverBatchUseCount}`);
}

const quickCaptureId = "60000000-0000-4000-8000-000000000010";
const quickArtifactId = "30000000-0000-4000-8000-000000000010";
await database.exec(`
  insert into public.artifacts (
    id, user_id, bucket, object_path, media_type, byte_size, artifact_kind
  ) values (
    '${quickArtifactId}', '${userA}', 'input-originals',
    '${userA}/${quickCaptureId}/meal.jpg', 'image/jpeg', 1, 'capture_input'
  );
  insert into public.capture_sessions (
    id, user_id, profile_id, source_type, artifact_id, occurred_at,
    recorded_timezone, status, attributes
  ) values (
    '${quickCaptureId}', '${userA}',
    (select id from public.profiles where user_id = '${userA}'),
    'mixed', '${quickArtifactId}', '2026-08-10T12:00:00Z', 'Europe/Rome', 'ready',
    '{"required_review_fields":["date_time","occurrence_type","identity","meal_contents","preparation_contact"]}'::jsonb
  );
  insert into public.capture_artifacts (
    user_id, capture_session_id, artifact_id, artifact_role, display_order
  ) values ('${userA}', '${quickCaptureId}', '${quickArtifactId}', 'meal_photo', 0);
  insert into public.capture_review_fields (
    user_id, capture_session_id, field_key, proposed_value, confirmed_value,
    confirmation_state
  ) values
    ('${userA}', '${quickCaptureId}', 'date_time', '{"occurred_at":"2026-08-10T12:00:00Z"}', '{"occurred_at":"2026-08-10T12:00:00Z"}', 'confirmed'),
    ('${userA}', '${quickCaptureId}', 'occurrence_type', '"meal"', '"meal"', 'confirmed'),
    ('${userA}', '${quickCaptureId}', 'identity', '{"name":"Quick soup","mode":"new"}', '{"name":"Quick soup","mode":"new"}', 'confirmed'),
    ('${userA}', '${quickCaptureId}', 'meal_contents', '{"ingredients":[{"name":"Tomato"}]}', '{"ingredients":[{"name":"Tomato"}]}', 'confirmed'),
    ('${userA}', '${quickCaptureId}', 'preparation_contact', '{"prepared_by_user":false,"skin_contact":{"mode":"none"}}', null, 'unconfirmed');
`);

if (
  !(await expectDenied(
    "Quick Log save before every card is confirmed",
    `select public.confirm_quick_log_capture(
      '${quickCaptureId}',
      '{"mode":"new","name":"Quick soup","components":[{"name":"Tomato"}]}'::jsonb,
      null,
      '[{"type_code":"meal","label":"Quick soup","participants":[{"food_item_id":"$resolved_food_item_id","recipe_version_id":"$resolved_recipe_version_id","role":"consumed"}]}]'::jsonb
    )`,
  ))
) {
  failed = true;
}

await database.exec(`
  update public.capture_review_fields
  set confirmation_state = 'confirmed', confirmed_value = proposed_value
  where capture_session_id = '${quickCaptureId}' and field_key = 'preparation_contact';
  select public.confirm_quick_log_capture(
    '${quickCaptureId}',
    '{"mode":"new","name":"Quick soup","components":[{"name":"Tomato"}]}'::jsonb,
    null,
    '[{"type_code":"meal","label":"Quick soup","source_method":"mixed","participants":[{"food_item_id":"$resolved_food_item_id","recipe_version_id":"$resolved_recipe_version_id","role":"consumed"}]}]'::jsonb
  );
  select public.confirm_quick_log_capture(
    '${quickCaptureId}', null, null,
    '[{"type_code":"note","label":"must not duplicate"}]'::jsonb
  );
`);
const quickLogAtomicCount = await scalar(`
  select count(*) from public.events where capture_session_id = '${quickCaptureId}'
`);
const quickLogRecipeCount = await scalar(`
  select count(*) from public.recipes where user_id = '${userA}' and name = 'Quick soup'
`);
const quickLogArtifactCount = await scalar(`
  select count(*) from public.record_artifacts record
  join public.events event on event.id = record.event_id
  where event.capture_session_id = '${quickCaptureId}' and record.artifact_id = '${quickArtifactId}'
`);
if (quickLogAtomicCount === 1 && quickLogRecipeCount === 1 && quickLogArtifactCount === 1) {
  console.log("PASS atomic and idempotent Quick Log confirmation: 1");
} else {
  failed = true;
  console.error(
    `FAIL atomic Quick Log confirmation: ${quickLogAtomicCount}/${quickLogRecipeCount}/${quickLogArtifactCount}`,
  );
}

const productCaptureId = "60000000-0000-4000-8000-000000000011";
await database.exec(`
  insert into public.capture_sessions (
    id, user_id, profile_id, source_type, occurred_at, recorded_timezone,
    status, attributes
  ) values (
    '${productCaptureId}', '${userA}',
    (select id from public.profiles where user_id = '${userA}'),
    'mixed', '2026-08-10T13:00:00Z', 'Europe/Rome', 'ready',
    '{"required_review_fields":["date_time","occurrence_type","identity","product_details","skin_contact"]}'::jsonb
  );
  insert into public.capture_review_fields (
    user_id, capture_session_id, field_key, proposed_value, confirmed_value,
    confirmation_state
  ) values
    ('${userA}', '${productCaptureId}', 'date_time', '{"occurred_at":"2026-08-10T13:00:00Z"}', '{"occurred_at":"2026-08-10T13:00:00Z"}', 'confirmed'),
    ('${userA}', '${productCaptureId}', 'occurrence_type', '"cream"', '"cream"', 'confirmed'),
    ('${userA}', '${productCaptureId}', 'identity', '{"name":"Quick cream","mode":"new"}', '{"name":"Quick cream","mode":"new"}', 'confirmed'),
    ('${userA}', '${productCaptureId}', 'product_details', '{"action":"applied","ingredients":[{"name":"Water"}]}', '{"action":"applied","ingredients":[{"name":"Water"}]}', 'confirmed'),
    ('${userA}', '${productCaptureId}', 'skin_contact', '{"mode":"direct","items":["Quick cream"],"body_areas":["both_hands"]}', '{"mode":"direct","items":["Quick cream"],"body_areas":["both_hands"]}', 'confirmed');
  select public.confirm_quick_log_capture(
    '${productCaptureId}', null,
    '{"mode":"new","concept_type":"treatment","name":"Quick cream","ingredients":[{"name":"Water"}]}'::jsonb,
    '[{"type_code":"topical_treatment","label":"Quick cream","source_method":"mixed","participants":[{"concept_id":"$resolved_concept_id","concept_version_id":"$resolved_concept_version_id","role":"applied"}]}]'::jsonb
  );
`);
const quickProductCount = await scalar(`
  select count(*) from public.event_concepts participant
  join public.events event on event.id = participant.event_id
  join public.concepts concept on concept.id = participant.concept_id
  where event.capture_session_id = '${productCaptureId}'
    and concept.canonical_name = 'Quick cream' and participant.role = 'applied'
`);
const quickProductContactCount = await scalar(`
  select count(*) from public.event_concepts participant
  join public.events event on event.id = participant.event_id
  where event.capture_session_id = '${productCaptureId}'
    and participant.role = 'contacted'
    and participant.body_area_code = 'both_hands'
    and participant.direct_contact = 'yes'
`);
if (quickProductCount === 1 && quickProductContactCount === 1) {
  console.log("PASS new labelled product is versioned and logged atomically: 1");
} else {
  failed = true;
  console.error(
    `FAIL atomic Quick Log product save: ${quickProductCount}/${quickProductContactCount}`,
  );
}

if (
  !(await expectDenied(
    "cross-tenant Quick Log artifact",
    `
      insert into public.capture_artifacts (
        user_id, capture_session_id, artifact_id, artifact_role, display_order
      ) values (
        '${userA}', '${userBCapture}', '${userBArtifact}', 'unclassified', 0
      )
    `,
  ))
) {
  failed = true;
}

if (
  !(await expectDenied(
    "cross-tenant recipe output",
    `
      insert into public.recipes (user_id, name, output_food_item_id)
      values ('${userA}', 'Invalid private food recipe', '${userBFood}')
    `,
  ))
) {
  failed = true;
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
