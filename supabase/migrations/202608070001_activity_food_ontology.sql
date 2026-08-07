-- A unified activity and food ontology.
--
-- The model deliberately separates reusable identities (food_items), plans
-- (recipes/recipe_versions), actual transformations (preparation events and
-- food_batches), and observations of use/contact (events/event_concepts).

create table public.food_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  canonical_name text not null check (btrim(canonical_name) <> ''),
  food_kind text not null default 'material'
    check (food_kind in ('material', 'prepared_food', 'beverage', 'commercial_product')),
  legacy_concept_id uuid unique references public.concepts(id) on delete set null,
  external_identifiers jsonb not null default '{}'::jsonb,
  attributes jsonb not null default '{}'::jsonb,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.food_item_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  food_item_id uuid not null references public.food_items(id) on delete cascade,
  normalized_alias text not null check (btrim(normalized_alias) <> ''),
  language text,
  source text not null default 'user'
    check (source in ('user', 'import', 'ai_reviewed', 'external')),
  created_at timestamptz not null default now(),
  unique (food_item_id, normalized_alias),
  foreign key (food_item_id) references public.food_items(id) on delete cascade
);

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  output_food_item_id uuid not null references public.food_items(id) on delete restrict,
  legacy_concept_id uuid unique references public.concepts(id) on delete set null,
  derived_from_recipe_id uuid references public.recipes(id) on delete set null,
  attributes jsonb not null default '{}'::jsonb,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  check (derived_from_recipe_id is null or derived_from_recipe_id <> id),
  foreign key (output_food_item_id, user_id)
    references public.food_items(id, user_id) on delete restrict,
  foreign key (derived_from_recipe_id, user_id)
    references public.recipes(id, user_id) on delete set null
);

create table public.recipe_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  yield_amount double precision check (yield_amount is null or yield_amount > 0),
  yield_unit text,
  instructions text,
  attributes jsonb not null default '{}'::jsonb,
  review_state text not null default 'accepted'
    check (review_state in ('proposed', 'accepted', 'corrected', 'rejected', 'superseded')),
  source_method text not null default 'manual'
    check (source_method in ('manual', 'photo', 'voice', 'document', 'url', 'import', 'ai')),
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  legacy_concept_version_id uuid unique references public.concept_versions(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (recipe_id, version_number),
  unique (id, user_id),
  check (effective_to is null or effective_to >= effective_from),
  foreign key (recipe_id, user_id)
    references public.recipes(id, user_id) on delete cascade
);

-- Each row is an ingredient role in a recipe. Every component is a food item.
-- source_recipe_version_id is populated when that food item was itself produced
-- by a reusable sub-recipe, preserving the exact nested version.
create table public.recipe_components (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  recipe_version_id uuid not null references public.recipe_versions(id) on delete cascade,
  component_food_item_id uuid not null references public.food_items(id) on delete restrict,
  source_recipe_version_id uuid references public.recipe_versions(id) on delete restrict,
  amount double precision check (amount is null or amount > 0),
  unit text,
  quantity_text text,
  component_order integer not null check (component_order > 0),
  optional boolean not null default false,
  notes text,
  certainty double precision check (certainty is null or certainty between 0 and 1),
  provenance jsonb not null default '{}'::jsonb,
  review_state text not null default 'accepted'
    check (review_state in ('proposed', 'accepted', 'corrected', 'rejected', 'superseded')),
  created_at timestamptz not null default now(),
  unique (recipe_version_id, component_order),
  unique (id, user_id),
  foreign key (recipe_version_id, user_id)
    references public.recipe_versions(id, user_id) on delete cascade,
  foreign key (source_recipe_version_id, user_id)
    references public.recipe_versions(id, user_id) on delete restrict
);

create table public.food_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  food_item_id uuid not null references public.food_items(id) on delete restrict,
  recipe_version_id uuid references public.recipe_versions(id) on delete restrict,
  produced_by_event_id uuid,
  amount double precision check (amount is null or amount >= 0),
  remaining_amount double precision check (remaining_amount is null or remaining_amount >= 0),
  unit text,
  prepared_at timestamptz not null,
  exhausted_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  check (amount is null or remaining_amount is null or remaining_amount <= amount),
  foreign key (recipe_version_id, user_id)
    references public.recipe_versions(id, user_id) on delete restrict,
  foreign key (produced_by_event_id, user_id)
    references public.events(id, user_id) on delete set null
);

create table public.capture_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id uuid,
  source_type text not null
    check (source_type in ('photo', 'voice', 'text', 'manual', 'import')),
  artifact_id uuid,
  occurred_at timestamptz not null,
  recorded_timezone text not null,
  original_text text,
  transcript text,
  status text not null default 'draft'
    check (status in ('draft', 'queued', 'processing', 'ready', 'confirmed', 'failed', 'discarded')),
  provider text,
  model text,
  prompt_version text,
  error text,
  attributes jsonb not null default '{}'::jsonb,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (profile_id, user_id) references public.profiles(id, user_id) on delete cascade,
  foreign key (artifact_id, user_id) references public.artifacts(id, user_id) on delete set null
);

create table public.activity_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  capture_session_id uuid not null references public.capture_sessions(id) on delete cascade,
  proposal_order integer not null check (proposal_order > 0),
  activity_type text not null,
  label text,
  generic_guess jsonb not null default '{}'::jsonb,
  personalized_guess jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  review_state text not null default 'proposed'
    check (review_state in ('proposed', 'accepted', 'corrected', 'rejected')),
  confirmed_event_id uuid,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (capture_session_id, proposal_order),
  unique (id, user_id),
  foreign key (confirmed_event_id, user_id)
    references public.events(id, user_id) on delete set null
);

create table public.proposal_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_proposal_id uuid not null references public.activity_proposals(id) on delete cascade,
  candidate_order integer not null check (candidate_order > 0),
  candidate_kind text not null
    check (candidate_kind in ('recipe', 'food_item', 'concept', 'prior_event')),
  recipe_id uuid references public.recipes(id) on delete cascade,
  food_item_id uuid references public.food_items(id) on delete cascade,
  concept_id uuid references public.concepts(id) on delete cascade,
  prior_event_id uuid references public.events(id) on delete cascade,
  score double precision not null check (score between 0 and 1),
  score_breakdown jsonb not null default '{}'::jsonb,
  explanation text not null,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (activity_proposal_id, candidate_order),
  check (num_nonnulls(recipe_id, food_item_id, concept_id, prior_event_id) = 1),
  foreign key (recipe_id, user_id)
    references public.recipes(id, user_id) on delete cascade,
  foreign key (concept_id, user_id)
    references public.concepts(id, user_id) on delete cascade,
  foreign key (prior_event_id, user_id)
    references public.events(id, user_id) on delete cascade
);

create table public.concept_search_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  target_kind text not null check (target_kind in ('recipe_version', 'concept_version')),
  recipe_version_id uuid references public.recipe_versions(id) on delete cascade,
  concept_version_id uuid references public.concept_versions(id) on delete cascade,
  search_text text not null,
  embedding jsonb,
  embedding_model text,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(recipe_version_id, concept_version_id) = 1),
  unique (target_kind, recipe_version_id, concept_version_id),
  foreign key (recipe_version_id, user_id)
    references public.recipe_versions(id, user_id) on delete cascade,
  foreign key (concept_version_id, user_id)
    references public.concept_versions(id, user_id) on delete cascade
);

alter table public.events
  add column capture_session_id uuid references public.capture_sessions(id) on delete set null,
  add foreign key (capture_session_id, user_id)
    references public.capture_sessions(id, user_id) on delete set null;

alter table public.event_concepts
  alter column concept_id drop not null,
  add column food_item_id uuid references public.food_items(id) on delete restrict,
  add column food_batch_id uuid references public.food_batches(id) on delete restrict,
  add column recipe_version_id uuid references public.recipe_versions(id) on delete restrict,
  add column ingestion_method text
    check (ingestion_method is null or ingestion_method in (
      'eaten', 'drank', 'swallowed', 'sublingual', 'inhaled', 'enteral', 'other'
    )),
  add check (num_nonnulls(concept_id, food_item_id, food_batch_id) >= 1),
  add foreign key (food_batch_id, user_id)
    references public.food_batches(id, user_id) on delete restrict,
  add foreign key (recipe_version_id, user_id)
    references public.recipe_versions(id, user_id) on delete restrict;

alter table public.event_concepts drop constraint event_concepts_role_check;
alter table public.event_concepts add constraint event_concepts_role_check
  check (role in (
    'consumed', 'contacted', 'used', 'applied', 'taken', 'present',
    'prepared', 'produced', 'performed'
  ));

alter table public.jobs drop constraint jobs_job_type_check;
alter table public.jobs add constraint jobs_job_type_check check (job_type in (
  'extraction', 'catalogue_extraction', 'capture_extraction', 'search_index',
  'analysis', 'report', 'export', 'deletion'
));

alter table public.concept_artifacts drop constraint concept_artifacts_role_check;
alter table public.concept_artifacts add constraint concept_artifacts_role_check
  check (role in (
    'product_front', 'ingredient_label', 'barcode', 'instructions', 'meal_photo', 'other'
  ));

create index food_items_user_name_idx
  on public.food_items (user_id, lower(canonical_name));
create index food_item_aliases_lookup_idx
  on public.food_item_aliases (user_id, lower(normalized_alias));
create index recipes_user_name_idx on public.recipes (user_id, lower(name));
create index recipe_versions_current_idx
  on public.recipe_versions (user_id, recipe_id, effective_from desc);
create index recipe_components_owner_idx
  on public.recipe_components (recipe_version_id, component_order);
create index recipe_components_subrecipe_idx
  on public.recipe_components (source_recipe_version_id);
create index food_batches_food_idx on public.food_batches (user_id, food_item_id, prepared_at desc);
create index capture_sessions_status_idx on public.capture_sessions (user_id, status, created_at desc);
create index activity_proposals_capture_idx
  on public.activity_proposals (capture_session_id, proposal_order);
create index proposal_candidates_proposal_idx
  on public.proposal_candidates (activity_proposal_id, candidate_order);
create index events_capture_session_idx on public.events (capture_session_id);
create index event_concepts_food_idx
  on public.event_concepts (user_id, food_item_id, created_at desc);
create unique index concept_search_documents_recipe_unique
  on public.concept_search_documents (recipe_version_id)
  where recipe_version_id is not null;
create unique index concept_search_documents_concept_unique
  on public.concept_search_documents (concept_version_id)
  where concept_version_id is not null;

create trigger food_items_set_updated_at before update on public.food_items
for each row execute function public.set_updated_at();
create trigger recipes_set_updated_at before update on public.recipes
for each row execute function public.set_updated_at();
create trigger capture_sessions_set_updated_at before update on public.capture_sessions
for each row execute function public.set_updated_at();
create trigger concept_search_documents_set_updated_at
before update on public.concept_search_documents
for each row execute function public.set_updated_at();

-- Food materials may be shared reference rows (user_id is null) or private.
-- Every table that can point at one checks that the row is either shared or
-- belongs to the same tenant. PostgreSQL foreign keys alone cannot express
-- this shared-or-owned rule.
create or replace function public.validate_food_item_reference()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  referenced_food_id uuid;
begin
  referenced_food_id := nullif(
    to_jsonb(new) ->> case
      when tg_table_name = 'recipe_components' then 'component_food_item_id'
      else 'food_item_id'
    end,
    ''
  )::uuid;
  if referenced_food_id is null then return new; end if;
  perform 1 from public.food_items food
  where food.id = referenced_food_id
    and (food.user_id is null or food.user_id = new.user_id);
  if not found then raise exception 'food item is not shared or owned by this user'; end if;
  return new;
end;
$$;

create trigger food_item_aliases_validate_food
before insert or update on public.food_item_aliases
for each row execute function public.validate_food_item_reference();
create trigger recipe_components_validate_food
before insert or update on public.recipe_components
for each row execute function public.validate_food_item_reference();
create trigger food_batches_validate_food
before insert or update on public.food_batches
for each row execute function public.validate_food_item_reference();
create trigger proposal_candidates_validate_food
before insert or update on public.proposal_candidates
for each row execute function public.validate_food_item_reference();
create trigger event_concepts_validate_food
before insert or update on public.event_concepts
for each row execute function public.validate_food_item_reference();

create or replace function public.validate_recipe_output_reference()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  version_id uuid := nullif(to_jsonb(new) ->> 'recipe_version_id', '')::uuid;
  referenced_food_id uuid := nullif(to_jsonb(new) ->> 'food_item_id', '')::uuid;
  referenced_batch_id uuid := nullif(to_jsonb(new) ->> 'food_batch_id', '')::uuid;
  batch_food_id uuid;
  recipe_output_id uuid;
begin
  if referenced_batch_id is not null then
    select food_item_id into batch_food_id from public.food_batches
    where id = referenced_batch_id and user_id = new.user_id;
    if not found then raise exception 'food batch not found for recipe validation'; end if;
    if referenced_food_id is not null and referenced_food_id <> batch_food_id then
      raise exception 'food batch does not match the food participant';
    end if;
    referenced_food_id := coalesce(referenced_food_id, batch_food_id);
  end if;
  if version_id is null then return new; end if;
  select recipe.output_food_item_id into recipe_output_id
  from public.recipe_versions version
  join public.recipes recipe on recipe.id = version.recipe_id
  where version.id = version_id and version.user_id = new.user_id;
  if not found then raise exception 'recipe version not found for output validation'; end if;
  if referenced_food_id is distinct from recipe_output_id then
    raise exception 'recipe version output does not match the referenced food';
  end if;
  return new;
end;
$$;

create trigger food_batches_validate_recipe_output
before insert or update on public.food_batches
for each row execute function public.validate_recipe_output_reference();
create trigger event_concepts_validate_recipe_output
before insert or update on public.event_concepts
for each row execute function public.validate_recipe_output_reference();

-- Validate both the sub-recipe output identity and acyclic nesting.
create or replace function public.validate_recipe_component()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  owner_version_id uuid;
  source_output_id uuid;
begin
  if new.source_recipe_version_id is null then
    return new;
  end if;

  owner_version_id := new.recipe_version_id;

  select recipe.output_food_item_id
  into source_output_id
  from public.recipe_versions version
  join public.recipes recipe on recipe.id = version.recipe_id
  where version.id = new.source_recipe_version_id;

  if source_output_id is distinct from new.component_food_item_id then
    raise exception 'sub-recipe output must match the component food item';
  end if;
  if new.source_recipe_version_id = owner_version_id then
    raise exception 'a recipe version cannot contain itself';
  end if;

  if exists (
    with recursive descendants(version_id, path, cycle) as (
      select
        new.source_recipe_version_id,
        array[new.source_recipe_version_id],
        false
      union all
      select
        component.source_recipe_version_id,
        descendants.path || component.source_recipe_version_id,
        component.source_recipe_version_id = any(descendants.path)
      from descendants
      join public.recipe_components component
        on component.recipe_version_id = descendants.version_id
      where component.source_recipe_version_id is not null and not descendants.cycle
    )
    select 1 from descendants where version_id = owner_version_id or cycle
  ) then
    raise exception 'nested recipe cycle detected';
  end if;

  return new;
end;
$$;

create trigger recipe_components_validate
before insert or update on public.recipe_components
for each row execute function public.validate_recipe_component();

-- Migrate the existing flat catalogue without rewriting its historical rows.
insert into public.food_items (
  id, user_id, canonical_name, food_kind, legacy_concept_id,
  external_identifiers, attributes, archived_at, created_at
)
select
  concept.id,
  concept.user_id,
  concept.canonical_name,
  case concept.concept_type
    when 'recipe' then 'prepared_food'
    when 'product' then 'commercial_product'
    else 'material'
  end,
  concept.id,
  concept.external_identifiers,
  concept.attributes,
  concept.archived_at,
  concept.created_at
from public.concepts concept
where concept.concept_type = 'ingredient'
on conflict (id) do nothing;

-- Recipe identities deliberately receive a distinct output food identity.
insert into public.food_items (
  user_id, canonical_name, food_kind, external_identifiers, attributes, archived_at, created_at
)
select
  concept.user_id,
  concept.canonical_name,
  'prepared_food',
  concept.external_identifiers,
  concept.attributes || jsonb_build_object('migrated_recipe_concept_id', concept.id),
  concept.archived_at,
  concept.created_at
from public.concepts concept
where concept.concept_type = 'recipe';

insert into public.recipes (
  id, user_id, name, output_food_item_id, legacy_concept_id,
  derived_from_recipe_id, attributes, archived_at, created_at, updated_at
)
select
  concept.id,
  concept.user_id,
  concept.canonical_name,
  output.id,
  concept.id,
  relation.object_id,
  concept.attributes,
  concept.archived_at,
  concept.created_at,
  concept.updated_at
from public.concepts concept
join public.food_items output
  on output.attributes ->> 'migrated_recipe_concept_id' = concept.id::text
left join public.concept_relations relation
  on relation.subject_id = concept.id and relation.predicate = 'derived_from'
where concept.concept_type = 'recipe'
on conflict (id) do nothing;

insert into public.recipe_versions (
  id, user_id, recipe_id, version_number, instructions, attributes,
  review_state, source_method, effective_from, effective_to,
  legacy_concept_version_id, created_at
)
select
  version.id,
  version.user_id,
  version.concept_id,
  version.version_number,
  nullif(version.attributes ->> 'preparation_notes', ''),
  version.attributes,
  version.review_state,
  version.source_method,
  version.effective_from,
  version.effective_to,
  version.id,
  version.created_at
from public.concept_versions version
join public.recipes recipe on recipe.id = version.concept_id
on conflict (id) do nothing;

insert into public.recipe_components (
  user_id, recipe_version_id, component_food_item_id, amount, unit,
  quantity_text, component_order, certainty, review_state, provenance, created_at
)
select
  composition.user_id,
  composition.owner_version_id,
  food.id,
  composition.amount,
  composition.unit,
  composition.concentration,
  composition.component_order,
  composition.certainty,
  composition.review_state,
  jsonb_build_object(
    'migration', 'legacy_composition',
    'composition_id', composition.id,
    'source_artifact_id', composition.source_artifact_id
  ),
  composition.created_at
from public.compositions composition
join public.recipe_versions version on version.id = composition.owner_version_id
join public.food_items food on food.legacy_concept_id = composition.component_concept_id
where composition.component_order is not null
on conflict (recipe_version_id, component_order) do nothing;

-- Keep legacy meal links queryable through the new food identity.
update public.event_concepts link
set
  food_item_id = recipe.output_food_item_id,
  recipe_version_id = (
    select version.id
    from public.recipe_versions version
    where version.legacy_concept_version_id = link.concept_version_id
    limit 1
  )
from public.recipes recipe
where link.concept_id = recipe.legacy_concept_id and link.role = 'consumed';

-- Generic save operation for canonical foods. Ingredient is a role in a
-- recipe_components row, not a permanently exclusive food kind.
create or replace function public.save_food_item(
  item_name text,
  item_kind text default 'material',
  item_attributes jsonb default '{}'::jsonb,
  aliases jsonb default '[]'::jsonb,
  existing_item_id uuid default null
)
returns public.food_items
language plpgsql
security invoker
set search_path = ''
as $$
declare
  saved public.food_items;
  alias_value jsonb;
  alias_text text;
begin
  if btrim(item_name) = '' then raise exception 'food item name is required'; end if;
  if item_kind not in ('material', 'prepared_food', 'beverage', 'commercial_product') then
    raise exception 'invalid food kind';
  end if;
  if jsonb_typeof(item_attributes) <> 'object' or jsonb_typeof(aliases) <> 'array' then
    raise exception 'invalid food item payload';
  end if;

  if existing_item_id is null then
    insert into public.food_items (user_id, canonical_name, food_kind, attributes)
    values ((select auth.uid()), btrim(item_name), item_kind, item_attributes)
    returning * into saved;
  else
    update public.food_items
    set canonical_name = btrim(item_name), food_kind = item_kind,
        attributes = attributes || item_attributes
    where id = existing_item_id and user_id = (select auth.uid())
    returning * into saved;
    if not found then raise exception 'food item not found'; end if;
  end if;

  for alias_value in select value from jsonb_array_elements(aliases)
  loop
    alias_text := lower(btrim(alias_value #>> '{}'));
    if alias_text <> '' then
      insert into public.food_item_aliases (user_id, food_item_id, normalized_alias)
      values ((select auth.uid()), saved.id, alias_text)
      on conflict (food_item_id, normalized_alias) do nothing;
    end if;
  end loop;
  return saved;
end;
$$;

grant execute on function public.save_food_item(text, text, jsonb, jsonb, uuid)
to authenticated;

create or replace function public.save_recipe_definition(
  recipe_name text,
  components jsonb default '[]'::jsonb,
  instructions text default null,
  yield_amount double precision default null,
  yield_unit text default null,
  existing_recipe_id uuid default null,
  derived_from_id uuid default null,
  recipe_attributes jsonb default '{}'::jsonb
)
returns public.recipes
language plpgsql
security invoker
set search_path = ''
as $$
declare
  saved_recipe public.recipes;
  output_food public.food_items;
  source_recipe public.recipes;
  version_id uuid;
  next_version integer := 1;
  component jsonb;
  component_name text;
  component_food public.food_items;
  nested_version public.recipe_versions;
  component_order integer := 0;
  output_kind text := nullif(recipe_attributes ->> 'output_food_kind', '');
begin
  if btrim(recipe_name) = '' then raise exception 'recipe name is required'; end if;
  if jsonb_typeof(components) <> 'array' or jsonb_typeof(recipe_attributes) <> 'object' then
    raise exception 'invalid recipe payload';
  end if;
  if existing_recipe_id is not null and derived_from_id is not null then
    raise exception 'an edit cannot also create a variation';
  end if;
  if output_kind is not null
    and output_kind not in ('prepared_food', 'beverage', 'commercial_product') then
    raise exception 'invalid recipe output food kind';
  end if;

  if existing_recipe_id is null then
    if derived_from_id is not null then
      select * into source_recipe from public.recipes
      where id = derived_from_id and user_id = (select auth.uid());
      if not found then raise exception 'source recipe not found'; end if;
    end if;
    insert into public.food_items (user_id, canonical_name, food_kind, attributes)
    values (
      (select auth.uid()), btrim(recipe_name), coalesce(output_kind, 'prepared_food'),
      recipe_attributes
    )
    returning * into output_food;
    insert into public.recipes (
      user_id, name, output_food_item_id, derived_from_recipe_id, attributes
    ) values (
      (select auth.uid()), btrim(recipe_name), output_food.id, source_recipe.id,
      recipe_attributes
    ) returning * into saved_recipe;
  else
    select * into saved_recipe from public.recipes
    where id = existing_recipe_id and user_id = (select auth.uid()) for update;
    if not found then raise exception 'recipe not found'; end if;
    update public.recipe_versions set effective_to = now(), review_state = 'superseded'
    where recipe_id = saved_recipe.id and user_id = (select auth.uid()) and effective_to is null;
    select coalesce(max(version_number), 0) + 1 into next_version
    from public.recipe_versions where recipe_id = saved_recipe.id;
    update public.recipes set name = btrim(recipe_name), attributes = attributes || recipe_attributes
    where id = saved_recipe.id returning * into saved_recipe;
    update public.food_items set canonical_name = btrim(recipe_name),
      food_kind = coalesce(output_kind, food_kind), attributes = attributes || recipe_attributes
    where id = saved_recipe.output_food_item_id;
  end if;

  insert into public.recipe_versions (
    user_id, recipe_id, version_number, yield_amount, yield_unit, instructions,
    attributes, review_state, source_method
  ) values (
    (select auth.uid()), saved_recipe.id, next_version, yield_amount,
    nullif(btrim(yield_unit), ''), nullif(btrim(instructions), ''), recipe_attributes,
    'accepted', 'manual'
  ) returning id into version_id;

  for component in select value from jsonb_array_elements(components)
  loop
    component_order := component_order + 1;
    component_name := btrim(coalesce(
      case
        when jsonb_typeof(component) = 'string' then component #>> '{}'
        else component ->> 'name'
      end,
      ''
    ));
    nested_version := null;
    if component ->> 'source_recipe_version_id' is not null then
      select version.* into nested_version
      from public.recipe_versions version
      join public.recipes recipe on recipe.id = version.recipe_id
      where version.id = (component ->> 'source_recipe_version_id')::uuid
        and recipe.user_id = (select auth.uid());
      if not found then raise exception 'sub-recipe version not found'; end if;
      select food.* into component_food
      from public.recipes recipe join public.food_items food on food.id = recipe.output_food_item_id
      where recipe.id = nested_version.recipe_id;
    elsif nullif(component ->> 'food_item_id', '') is not null then
      select * into component_food from public.food_items
      where id = (component ->> 'food_item_id')::uuid
        and (user_id is null or user_id = (select auth.uid()));
      if not found then raise exception 'component food item not found'; end if;
    else
      if component_name = '' then continue; end if;
      select food.* into component_food
      from public.food_items food
      where lower(food.canonical_name) = lower(component_name)
        and (food.user_id is null or food.user_id = (select auth.uid()))
      order by food.user_id nulls last limit 1;
      if not found then
        insert into public.food_items (user_id, canonical_name, food_kind)
        values ((select auth.uid()), component_name, 'material') returning * into component_food;
      end if;
    end if;

    insert into public.recipe_components (
      user_id, recipe_version_id, component_food_item_id, source_recipe_version_id,
      amount, unit, quantity_text, component_order, optional, notes, certainty,
      provenance, review_state
    ) values (
      (select auth.uid()), version_id, component_food.id, nested_version.id,
      nullif(component ->> 'amount', '')::double precision,
      nullif(btrim(component ->> 'unit'), ''),
      nullif(btrim(component ->> 'quantity_text'), ''), component_order,
      coalesce((component ->> 'optional')::boolean, false),
      nullif(btrim(component ->> 'notes'), ''),
      coalesce(nullif(component ->> 'certainty', '')::double precision, 1),
      coalesce(component -> 'provenance', '{}'::jsonb), 'accepted'
    );
  end loop;
  return saved_recipe;
end;
$$;

grant execute on function public.save_recipe_definition(
  text, jsonb, text, double precision, text, uuid, uuid, jsonb
) to authenticated;

create or replace function public.flatten_recipe_components(target_version_id uuid)
returns table (
  component_food_item_id uuid,
  component_name text,
  depth integer,
  path uuid[],
  amount double precision,
  unit text,
  optional boolean
)
language sql
security invoker
set search_path = ''
as $$
  with recursive tree as (
    select
      component.component_food_item_id,
      food.canonical_name,
      component.source_recipe_version_id,
      1 as depth,
      array[component.recipe_version_id, coalesce(component.source_recipe_version_id, component.id)] as path,
      component.amount,
      component.unit,
      component.optional
    from public.recipe_components component
    join public.food_items food on food.id = component.component_food_item_id
    where component.recipe_version_id = target_version_id
      and component.user_id = (select auth.uid())
    union all
    select
      nested.component_food_item_id,
      food.canonical_name,
      nested.source_recipe_version_id,
      tree.depth + 1,
      tree.path || coalesce(nested.source_recipe_version_id, nested.id),
      nested.amount,
      nested.unit,
      tree.optional or nested.optional
    from tree
    join public.recipe_components nested
      on nested.recipe_version_id = tree.source_recipe_version_id
    join public.food_items food on food.id = nested.component_food_item_id
    where tree.depth < 32
      and not coalesce(nested.source_recipe_version_id, nested.id) = any(tree.path)
  )
  select
    tree.component_food_item_id, tree.canonical_name, tree.depth, tree.path,
    tree.amount, tree.unit, tree.optional
  from tree
  where tree.source_recipe_version_id is null
  order by tree.path;
$$;

grant execute on function public.flatten_recipe_components(uuid) to authenticated;

-- A generic transactional writer used by photo, voice, text and manual capture.
-- parent_order links a secondary activity (for example preparation) to an
-- earlier activity in the same bundle without exposing temporary client UUIDs.
create or replace function public.log_activity_bundle(
  target_profile_id uuid,
  occurred_at timestamptz,
  timezone text,
  capture_id uuid,
  activities jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  capture public.capture_sessions;
  activity jsonb;
  participant jsonb;
  created_ids uuid[] := '{}'::uuid[];
  created_batch_ids uuid[] := '{}'::uuid[];
  created_event public.events;
  current_order integer := 0;
  parent_order integer;
  created_batch_id uuid;
  selected_food public.food_items;
  selected_batch public.food_batches;
  selected_recipe_version public.recipe_versions;
  selected_recipe public.recipes;
begin
  if jsonb_typeof(activities) <> 'array' or jsonb_array_length(activities) = 0 then
    raise exception 'at least one activity is required';
  end if;
  if capture_id is not null then
    select * into capture from public.capture_sessions
    where id = capture_id and user_id = (select auth.uid()) for update;
    if not found then raise exception 'capture session not found'; end if;
    if capture.status <> 'ready' then
      raise exception 'capture session is not ready for confirmation';
    end if;
  end if;

  for activity in select value from jsonb_array_elements(activities)
  loop
    current_order := current_order + 1;
    insert into public.events (
      user_id, profile_id, capture_session_id, type_code, occurred_start,
      recorded_timezone, label, attributes, trust_status, source_method
    ) values (
      (select auth.uid()), target_profile_id, capture_id,
      coalesce(nullif(activity ->> 'type_code', ''), 'note'), occurred_at, timezone,
      nullif(btrim(activity ->> 'label'), ''), coalesce(activity -> 'attributes', '{}'::jsonb),
      'trusted', coalesce(nullif(activity ->> 'source_method', ''), 'manual')
    ) returning * into created_event;
    created_ids := array_append(created_ids, created_event.id);

    for participant in
      select value from jsonb_array_elements(coalesce(activity -> 'participants', '[]'::jsonb))
    loop
      selected_food := null;
      selected_batch := null;
      selected_recipe_version := null;
      selected_recipe := null;
      if nullif(participant ->> 'food_item_id', '') is not null then
        select * into selected_food from public.food_items
        where id = (participant ->> 'food_item_id')::uuid
          and (user_id is null or user_id = (select auth.uid()));
        if not found then raise exception 'food participant not found'; end if;
      end if;
      if nullif(participant ->> 'food_batch_id', '') is not null then
        select * into selected_batch from public.food_batches
        where id = (participant ->> 'food_batch_id')::uuid
          and user_id = (select auth.uid());
        if not found then raise exception 'food batch not found'; end if;
      end if;
      if nullif(participant ->> 'recipe_version_id', '') is not null then
        select version.* into selected_recipe_version
        from public.recipe_versions version
        where version.id = (participant ->> 'recipe_version_id')::uuid
          and version.user_id = (select auth.uid());
        if not found then raise exception 'recipe version not found'; end if;
        select recipe.* into selected_recipe from public.recipes recipe
        where recipe.id = selected_recipe_version.recipe_id
          and recipe.user_id = (select auth.uid());
        if not found then raise exception 'recipe not found'; end if;
        if coalesce(selected_food.id, selected_batch.food_item_id)
          is distinct from selected_recipe.output_food_item_id then
          raise exception 'recipe version output does not match the food participant';
        end if;
        update public.recipes
        set attributes = attributes || jsonb_build_object('last_used_at', occurred_at)
        where id = selected_recipe.id and user_id = (select auth.uid());
      end if;

      insert into public.event_concepts (
        user_id, event_id, concept_id, concept_version_id, food_item_id,
        food_batch_id, recipe_version_id, role, amount, unit, body_area_code,
        duration_seconds, route, contact_state, gloves_used, glove_material,
        direct_contact, ingestion_method, confidence, review_state, provenance
      ) values (
        (select auth.uid()), created_event.id,
        nullif(participant ->> 'concept_id', '')::uuid,
        nullif(participant ->> 'concept_version_id', '')::uuid,
        coalesce(selected_food.id, selected_batch.food_item_id), selected_batch.id,
        selected_recipe_version.id,
        participant ->> 'role', nullif(participant ->> 'amount', '')::double precision,
        nullif(btrim(participant ->> 'unit'), ''),
        nullif(participant ->> 'body_area_code', ''),
        nullif(participant ->> 'duration_seconds', '')::integer,
        nullif(btrim(participant ->> 'route'), ''),
        nullif(btrim(participant ->> 'contact_state'), ''),
        nullif(participant ->> 'gloves_used', '')::boolean,
        nullif(btrim(participant ->> 'glove_material'), ''),
        nullif(participant ->> 'direct_contact', ''),
        nullif(participant ->> 'ingestion_method', ''), 1, 'accepted',
        coalesce(participant -> 'provenance', '{}'::jsonb) ||
          jsonb_build_object('capture_session_id', capture_id)
      );
      if (participant ->> 'role') in ('prepared', 'produced')
        and selected_recipe_version.id is not null then
        insert into public.food_batches (
          user_id, food_item_id, recipe_version_id, produced_by_event_id,
          amount, remaining_amount, unit, prepared_at, attributes
        ) values (
          (select auth.uid()), selected_recipe.output_food_item_id,
          selected_recipe_version.id, created_event.id,
          nullif(participant ->> 'amount', '')::double precision,
          nullif(participant ->> 'remaining_amount', '')::double precision,
          nullif(btrim(participant ->> 'unit'), ''), occurred_at,
          jsonb_build_object(
            'capture_session_id', capture_id,
            'availability', 'unknown'
          )
        ) returning id into created_batch_id;
        created_batch_ids := array_append(created_batch_ids, created_batch_id);
      end if;
    end loop;

    parent_order := nullif(activity ->> 'parent_order', '')::integer;
    if parent_order is not null then
      if parent_order < 1 or parent_order >= current_order then
        raise exception 'invalid parent activity order';
      end if;
      insert into public.event_relations (
        user_id, from_event_id, to_event_id, relation_type, attributes
      ) values (
        (select auth.uid()), created_ids[parent_order], created_event.id,
        coalesce(nullif(activity ->> 'relation_type', ''), 'related_to'), '{}'::jsonb
      );
    end if;
  end loop;

  if capture_id is not null then
    update public.capture_sessions
    set status = 'confirmed', confirmed_at = now()
    where id = capture_id and user_id = (select auth.uid());
    update public.activity_proposals
    set review_state = 'accepted', reviewed_at = now()
    where capture_session_id = capture_id and user_id = (select auth.uid())
      and review_state = 'proposed';
  end if;
  return jsonb_build_object(
    'event_ids', to_jsonb(created_ids),
    'food_batch_ids', to_jsonb(created_batch_ids)
  );
end;
$$;

grant execute on function public.log_activity_bundle(
  uuid, timestamptz, text, uuid, jsonb
) to authenticated;

-- Compatibility workflow for a manually logged meal that is promoted to a
-- reusable recipe after the fact. New clients use this graph-native operation;
-- the older save_meal_event_as_recipe function remains available for old builds.
create or replace function public.save_meal_event_as_food_recipe(
  meal_event_id uuid,
  recipe_name text,
  recipe_ingredients jsonb default '[]'::jsonb,
  preparation_method text default null,
  preparation_contact_notes text default null
)
returns public.recipes
language plpgsql
security invoker
set search_path = ''
as $$
declare
  meal_event public.events;
  saved_recipe public.recipes;
  saved_version public.recipe_versions;
begin
  select * into meal_event from public.events
  where id = meal_event_id and user_id = (select auth.uid()) and type_code = 'meal'
  for update;
  if not found then raise exception 'meal event not found'; end if;
  if exists (
    select 1 from public.event_concepts link
    where link.event_id = meal_event.id and link.user_id = (select auth.uid())
      and link.role = 'consumed' and link.recipe_version_id is not null
  ) then
    raise exception 'meal event is already linked to a saved recipe';
  end if;

  select * into saved_recipe from public.save_recipe_definition(
    recipe_name,
    recipe_ingredients,
    preparation_method,
    null,
    null,
    null,
    null,
    jsonb_build_object(
      'created_from_event_id', meal_event.id,
      'preparation_contact_prompt', coalesce(btrim(preparation_contact_notes), '')
    )
  );
  select * into saved_version from public.recipe_versions
  where recipe_id = saved_recipe.id and user_id = (select auth.uid())
    and effective_to is null
  order by version_number desc limit 1;

  insert into public.event_concepts (
    user_id, event_id, food_item_id, recipe_version_id, role,
    ingestion_method, route, confidence, review_state, provenance
  ) values (
    (select auth.uid()), meal_event.id, saved_recipe.output_food_item_id,
    saved_version.id, 'consumed',
    case
      when meal_event.attributes ->> 'ingestion_method' in (
        'eaten', 'drank', 'swallowed', 'sublingual', 'inhaled', 'enteral', 'other'
      ) then meal_event.attributes ->> 'ingestion_method'
      else 'eaten'
    end,
    'oral', 1, 'accepted',
    jsonb_build_object(
      'method', 'saved_from_meal_event',
      'recipe_id', saved_recipe.id,
      'recipe_version', saved_version.version_number
    )
  );
  update public.events set
    label = coalesce(nullif(label, ''), saved_recipe.name),
    attributes = attributes || jsonb_build_object(
      'saved_recipe_id', saved_recipe.id,
      'saved_recipe_version_id', saved_version.id
    )
  where id = meal_event.id and user_id = (select auth.uid());
  return saved_recipe;
end;
$$;

grant execute on function public.save_meal_event_as_food_recipe(
  uuid, text, jsonb, text, text
) to authenticated;

-- Tenant isolation for the new domain tables.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'recipes', 'recipe_versions', 'recipe_components', 'food_batches',
    'capture_sessions', 'activity_proposals', 'proposal_candidates',
    'concept_search_documents'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format(
      'create policy %I on public.%I for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      table_name || '_owner_all', table_name
    );
  end loop;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['food_items', 'food_item_aliases']
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id is null or (select auth.uid()) = user_id)',
      table_name || '_read', table_name
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)',
      table_name || '_insert', table_name
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      table_name || '_update', table_name
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)',
      table_name || '_delete', table_name
    );
  end loop;
end;
$$;

-- Replace deletion with a version aware of the new dependency graph.
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
  delete from public.catalogue_extractions where user_id = target_user;
  delete from public.proposal_candidates where user_id = target_user;
  delete from public.activity_proposals where user_id = target_user;
  update public.events set capture_session_id = null where user_id = target_user;
  delete from public.capture_sessions where user_id = target_user;
  delete from public.record_revisions where user_id = target_user;
  delete from public.record_artifacts where user_id = target_user;
  delete from public.concept_artifacts where user_id = target_user;
  delete from public.event_concepts where user_id = target_user;
  delete from public.event_relations where user_id = target_user;
  delete from public.observations where user_id = target_user;
  update public.food_batches set produced_by_event_id = null where user_id = target_user;
  delete from public.events where user_id = target_user;
  delete from public.food_batches where user_id = target_user;
  delete from public.concept_search_documents where user_id = target_user;
  delete from public.recipe_components where user_id = target_user;
  delete from public.recipe_versions where user_id = target_user;
  delete from public.recipes where user_id = target_user;
  delete from public.food_item_aliases where user_id = target_user;
  delete from public.food_items where user_id = target_user;
  delete from public.compositions where user_id = target_user;
  delete from public.concept_versions where user_id = target_user;
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
