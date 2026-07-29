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

await database.exec(`
  insert into auth.users (id) values ('${userA}'), ('${userB}');
  insert into public.profiles (user_id, display_name)
  values ('${userA}', 'User A'), ('${userB}', 'User B');
  insert into public.concepts (id, user_id, concept_type, canonical_name)
  values ('${userBConcept}', '${userB}', 'product', 'User B private product');
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
