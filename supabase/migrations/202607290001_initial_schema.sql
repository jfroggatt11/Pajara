create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 120),
  timezone text not null default 'UTC',
  locale text not null default 'en',
  consent_at timestamptz,
  ai_enabled boolean not null default false,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.type_definitions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('event', 'observation', 'relation')),
  code text not null,
  version integer not null check (version > 0),
  label text not null,
  json_schema jsonb not null default '{}'::jsonb,
  ui_hints jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (kind, code, version)
);

create table public.body_areas (
  code text primary key,
  parent_code text references public.body_areas(code),
  label text not null,
  laterality text check (laterality in ('left', 'right', 'bilateral', 'midline')),
  display_order integer not null default 0,
  active boolean not null default true
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id uuid,
  type_code text not null,
  type_version integer not null default 1 check (type_version > 0),
  occurred_start timestamptz not null,
  occurred_end timestamptz,
  recorded_timezone text not null,
  time_precision text not null default 'minute'
    check (time_precision in ('exact', 'minute', 'hour', 'part_of_day', 'day', 'range', 'unknown')),
  label text check (label is null or char_length(label) <= 240),
  attributes jsonb not null default '{}'::jsonb,
  trust_status text not null default 'draft'
    check (trust_status in ('draft', 'pending_review', 'trusted', 'rejected')),
  source_method text not null default 'manual'
    check (source_method in ('manual', 'text', 'voice', 'photo', 'document', 'import', 'ai')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (occurred_end is null or occurred_end >= occurred_start),
  unique (id, user_id),
  foreign key (profile_id, user_id) references public.profiles(id, user_id) on delete cascade
);

create table public.observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid,
  body_area_code text references public.body_areas(code),
  type_code text not null,
  type_version integer not null default 1 check (type_version > 0),
  observed_at timestamptz not null,
  numeric_value double precision,
  text_value text,
  boolean_value boolean,
  categorical_value text,
  json_value jsonb,
  unit text,
  scale_code text,
  scale_min double precision,
  scale_max double precision,
  trust_status text not null default 'trusted'
    check (trust_status in ('draft', 'pending_review', 'trusted', 'rejected')),
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    num_nonnulls(numeric_value, text_value, boolean_value, categorical_value, json_value) = 1
  ),
  check (
    type_code not in ('redness', 'itching', 'dryness', 'cracking', 'swelling', 'pain')
    or (
      numeric_value between 0 and 10
      and scale_code = 'symptom_0_10_v1'
      and scale_min = 0
      and scale_max = 10
    )
  ),
  unique (id, user_id),
  foreign key (event_id, user_id) references public.events(id, user_id) on delete cascade
);

create table public.event_relations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  from_event_id uuid not null,
  to_event_id uuid not null,
  relation_type text not null,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (from_event_id, to_event_id, relation_type),
  check (from_event_id <> to_event_id),
  foreign key (from_event_id, user_id) references public.events(id, user_id) on delete cascade,
  foreign key (to_event_id, user_id) references public.events(id, user_id) on delete cascade
);

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket text not null,
  object_path text not null,
  sha256 text check (sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
  media_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  original_filename text,
  artifact_kind text not null,
  captured_at timestamptz,
  ingested_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (bucket, object_path),
  unique (id, user_id)
);

create table public.record_artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid,
  observation_id uuid,
  artifact_id uuid not null,
  role text not null,
  body_area_code text references public.body_areas(code),
  view_code text,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  check (num_nonnulls(event_id, observation_id) = 1),
  unique (event_id, observation_id, artifact_id, role),
  foreign key (event_id, user_id) references public.events(id, user_id) on delete cascade,
  foreign key (observation_id, user_id)
    references public.observations(id, user_id) on delete cascade,
  foreign key (artifact_id, user_id) references public.artifacts(id, user_id) on delete cascade
);

create table public.record_revisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  target_kind text not null check (target_kind in ('event', 'observation')),
  target_id uuid not null,
  revision_number integer not null check (revision_number > 0),
  snapshot jsonb not null,
  author_type text not null check (author_type in ('user', 'extractor', 'import', 'system')),
  author_identifier text,
  parent_revision_id uuid references public.record_revisions(id),
  reason text,
  created_at timestamptz not null default now(),
  unique (target_kind, target_id, revision_number)
);

create table public.extraction_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid,
  artifact_id uuid,
  provider text not null,
  model text not null,
  prompt_version text not null,
  schema_version integer not null default 1,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  raw_response jsonb,
  usage jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check (event_id is not null or artifact_id is not null),
  unique (id, user_id),
  foreign key (event_id, user_id) references public.events(id, user_id) on delete cascade,
  foreign key (artifact_id, user_id) references public.artifacts(id, user_id) on delete cascade
);

create table public.field_assertions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  extraction_run_id uuid not null references public.extraction_runs(id) on delete cascade,
  target_kind text not null check (target_kind in ('event', 'observation')),
  target_id uuid not null,
  field_path text not null check (field_path ~ '^/(attributes/[A-Za-z0-9_-]+|label)$'),
  proposed_value jsonb not null,
  confidence double precision not null check (confidence between 0 and 1),
  evidence jsonb not null default '{}'::jsonb,
  provenance_method text not null,
  review_state text not null default 'proposed'
    check (review_state in ('proposed', 'accepted', 'corrected', 'rejected', 'superseded')),
  corrected_value jsonb,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.concepts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  concept_type text not null
    check (concept_type in ('ingredient', 'product', 'category', 'material', 'activity')),
  canonical_name text not null,
  parent_id uuid references public.concepts(id),
  external_identifiers jsonb not null default '{}'::jsonb,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.concept_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  concept_id uuid not null references public.concepts(id) on delete cascade,
  normalized_alias text not null,
  language text,
  source text not null default 'user',
  match_mode text not null default 'exact',
  created_at timestamptz not null default now()
);

create table public.concept_relations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  subject_id uuid not null references public.concepts(id) on delete cascade,
  predicate text not null check (predicate in ('is_a', 'part_of', 'derived_from', 'may_contain')),
  object_id uuid not null references public.concepts(id) on delete cascade,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (subject_id, predicate, object_id)
);

create table public.compositions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  owner_concept_id uuid not null references public.concepts(id) on delete cascade,
  component_concept_id uuid not null references public.concepts(id) on delete cascade,
  amount double precision,
  unit text,
  concentration text,
  component_order integer,
  valid_from date,
  valid_to date,
  certainty double precision check (certainty is null or certainty between 0 and 1),
  source_artifact_id uuid references public.artifacts(id) on delete set null,
  review_state text not null default 'proposed',
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create table public.event_concepts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid not null,
  concept_id uuid not null references public.concepts(id) on delete restrict,
  role text not null check (role in ('consumed', 'contacted', 'used', 'applied', 'taken', 'present')),
  amount double precision,
  unit text,
  body_area_code text references public.body_areas(code),
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  route text,
  contact_state text,
  gloves_used boolean,
  glove_material text,
  direct_contact text check (direct_contact is null or direct_contact in ('yes', 'no', 'unknown')),
  confidence double precision check (confidence is null or confidence between 0 and 1),
  review_state text not null default 'accepted',
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (event_id, user_id) references public.events(id, user_id) on delete cascade
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_type text not null check (job_type in ('extraction', 'analysis', 'report', 'export', 'deletion')),
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'queued'
    check (state in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority integer not null default 100,
  attempts integer not null default 0,
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  idempotency_key text,
  progress integer not null default 0 check (progress between 0 and 100),
  error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create table public.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  question text,
  specification jsonb not null,
  data_cutoff timestamptz not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'insufficient_data')),
  method text not null default 'descriptive_lag_summary',
  result jsonb,
  diagnostics jsonb not null default '{}'::jsonb,
  limitations jsonb not null default '[]'::jsonb,
  evidence_strength text
    check (evidence_strength is null or evidence_strength in (
      'insufficient', 'weak', 'suggestive', 'stronger_within_person_association'
    )),
  code_version text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (id, user_id)
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  analysis_run_id uuid,
  report_kind text not null default 'descriptive',
  report_version integer not null default 1,
  artifact_id uuid,
  summary text,
  created_at timestamptz not null default now(),
  foreign key (analysis_run_id, user_id)
    references public.analysis_runs(id, user_id) on delete cascade,
  foreign key (artifact_id, user_id) references public.artifacts(id, user_id) on delete cascade
);

create index events_user_time_idx on public.events (user_id, occurred_start desc);
create index events_user_type_time_idx on public.events (user_id, type_code, occurred_start desc);
create index observations_user_type_time_idx
  on public.observations (user_id, type_code, observed_at desc);
create index observations_event_idx on public.observations (event_id);
create index assertions_user_review_idx on public.field_assertions (user_id, review_state, created_at);
create index jobs_claim_idx on public.jobs (state, available_at, priority, created_at);
create index artifacts_user_idx on public.artifacts (user_id, created_at desc);
create index event_concepts_event_idx on public.event_concepts (event_id);

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger events_set_updated_at before update on public.events
for each row execute function public.set_updated_at();
create trigger observations_set_updated_at before update on public.observations
for each row execute function public.set_updated_at();
create trigger jobs_set_updated_at before update on public.jobs
for each row execute function public.set_updated_at();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'profiles', 'events', 'observations', 'event_relations', 'artifacts',
    'record_artifacts', 'record_revisions', 'extraction_runs', 'field_assertions',
    'event_concepts', 'jobs', 'analysis_runs', 'reports'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format(
      'create policy %I on public.%I for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      table_name || '_owner_all',
      table_name
    );
  end loop;
end;
$$;

alter table public.type_definitions enable row level security;
alter table public.type_definitions force row level security;
create policy type_definitions_read on public.type_definitions
for select to authenticated using (true);

alter table public.body_areas enable row level security;
alter table public.body_areas force row level security;
create policy body_areas_read on public.body_areas
for select to authenticated using (true);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'concepts', 'concept_aliases', 'concept_relations', 'compositions'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id is null or (select auth.uid()) = user_id)',
      table_name || '_read',
      table_name
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)',
      table_name || '_insert',
      table_name
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      table_name || '_update',
      table_name
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)',
      table_name || '_delete',
      table_name
    );
  end loop;
end;
$$;

create or replace function public.claim_jobs(worker_name text, claim_limit integer default 1)
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if claim_limit < 1 or claim_limit > 20 then
    raise exception 'claim_limit must be between 1 and 20';
  end if;

  return query
  update public.jobs j
  set
    state = 'running',
    attempts = j.attempts + 1,
    lease_owner = worker_name,
    lease_expires_at = now() + interval '5 minutes',
    progress = greatest(j.progress, 1),
    updated_at = now()
  where j.id in (
    select candidate.id
    from public.jobs candidate
    where
      candidate.state = 'queued'
      and candidate.available_at <= now()
      and candidate.attempts < candidate.max_attempts
    order by candidate.priority asc, candidate.created_at asc
    for update skip locked
    limit claim_limit
  )
  returning j.*;
end;
$$;

revoke all on function public.claim_jobs(text, integer) from public, anon, authenticated;
grant execute on function public.claim_jobs(text, integer) to service_role;

create or replace function public.review_field_assertion(
  assertion_id uuid,
  decision text,
  replacement_value jsonb default null
)
returns public.field_assertions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  assertion public.field_assertions;
  applied_value jsonb;
  next_revision integer;
begin
  if decision not in ('accepted', 'corrected', 'rejected') then
    raise exception 'invalid review decision';
  end if;

  select *
  into assertion
  from public.field_assertions
  where id = assertion_id and user_id = (select auth.uid())
  for update;

  if not found or assertion.review_state <> 'proposed' then
    raise exception 'assertion not found or already reviewed';
  end if;

  applied_value := case
    when decision = 'corrected' then replacement_value
    else assertion.proposed_value
  end;

  if decision <> 'rejected' and assertion.target_kind = 'event' then
    if assertion.field_path = '/label' then
      update public.events
      set label = trim(both '"' from applied_value::text), trust_status = 'trusted'
      where id = assertion.target_id and user_id = (select auth.uid());
    elsif assertion.field_path like '/attributes/%' then
      update public.events
      set
        attributes = jsonb_set(
          attributes,
          array[substring(assertion.field_path from 13)],
          applied_value,
          true
        ),
        trust_status = 'trusted'
      where id = assertion.target_id and user_id = (select auth.uid());
    end if;
  end if;

  update public.field_assertions
  set
    review_state = decision,
    corrected_value = case when decision = 'corrected' then replacement_value else null end,
    reviewed_at = now()
  where id = assertion.id
  returning * into assertion;

  select coalesce(max(revision_number), 0) + 1
  into next_revision
  from public.record_revisions
  where target_kind = assertion.target_kind and target_id = assertion.target_id;

  if assertion.target_kind = 'event' then
    insert into public.record_revisions (
      user_id, target_kind, target_id, revision_number, snapshot, author_type, reason
    )
    select
      e.user_id,
      'event',
      e.id,
      next_revision,
      to_jsonb(e),
      'user',
      'Reviewed AI assertion ' || assertion.id::text
    from public.events e
    where e.id = assertion.target_id and e.user_id = (select auth.uid());
  end if;

  return assertion;
end;
$$;

grant execute on function public.review_field_assertion(uuid, text, jsonb) to authenticated;

create or replace function public.delete_user_tracking_data(
  target_user uuid,
  preserve_job uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.reports where user_id = target_user;
  delete from public.analysis_runs where user_id = target_user;
  delete from public.field_assertions where user_id = target_user;
  delete from public.extraction_runs where user_id = target_user;
  delete from public.record_revisions where user_id = target_user;
  delete from public.record_artifacts where user_id = target_user;
  delete from public.event_concepts where user_id = target_user;
  delete from public.event_relations where user_id = target_user;
  delete from public.observations where user_id = target_user;
  delete from public.events where user_id = target_user;
  delete from public.compositions where user_id = target_user;
  delete from public.concept_relations where user_id = target_user;
  delete from public.concept_aliases where user_id = target_user;
  delete from public.concepts where user_id = target_user;
  delete from public.artifacts where user_id = target_user;
  delete from public.profiles where user_id = target_user;
  delete from public.jobs where user_id = target_user and id <> preserve_job;
end;
$$;

revoke all on function public.delete_user_tracking_data(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.delete_user_tracking_data(uuid, uuid) to service_role;

create or replace view public.trusted_events
with (security_invoker = true)
as
select * from public.events where trust_status = 'trusted';

create or replace view public.trusted_observations
with (security_invoker = true)
as
select * from public.observations where trust_status = 'trusted';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'skin-originals',
    'skin-originals',
    false,
    26214400,
    array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
  ),
  (
    'voice-originals',
    'voice-originals',
    false,
    26214400,
    array['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg']
  ),
  (
    'input-originals',
    'input-originals',
    false,
    26214400,
    array['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain']
  ),
  ('derived-private', 'derived-private', false, 52428800, null)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy user_private_objects_select
on storage.objects for select to authenticated
using (
  bucket_id in ('skin-originals', 'voice-originals', 'input-originals', 'derived-private')
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy user_private_objects_insert
on storage.objects for insert to authenticated
with check (
  bucket_id in ('skin-originals', 'voice-originals', 'input-originals')
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy user_private_objects_update
on storage.objects for update to authenticated
using (
  bucket_id in ('skin-originals', 'voice-originals', 'input-originals')
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id in ('skin-originals', 'voice-originals', 'input-originals')
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy user_private_objects_delete
on storage.objects for delete to authenticated
using (
  bucket_id in ('skin-originals', 'voice-originals', 'input-originals')
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
