alter table public.concepts
  drop constraint concepts_concept_type_check;

alter table public.concepts
  add constraint concepts_concept_type_check
  check (
    concept_type in (
      'ingredient',
      'product',
      'medication',
      'treatment',
      'recipe',
      'category',
      'material',
      'activity'
    )
  ),
  add column updated_at timestamptz not null default now(),
  add column archived_at timestamptz,
  add unique (id, user_id);

create table public.concept_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  concept_id uuid not null references public.concepts(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  review_state text not null default 'accepted'
    check (review_state in ('proposed', 'accepted', 'corrected', 'rejected', 'superseded')),
  source_method text not null default 'manual'
    check (source_method in ('manual', 'photo', 'document', 'url', 'import', 'ai')),
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (concept_id, version_number),
  unique (id, user_id),
  foreign key (concept_id, user_id)
    references public.concepts(id, user_id) on delete cascade
);

alter table public.compositions
  add column owner_version_id uuid references public.concept_versions(id) on delete cascade,
  add foreign key (owner_version_id, user_id)
    references public.concept_versions(id, user_id) on delete cascade;

alter table public.event_concepts
  add column concept_version_id uuid references public.concept_versions(id) on delete restrict,
  add foreign key (concept_version_id, user_id)
    references public.concept_versions(id, user_id) on delete restrict;

create table public.concept_artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  concept_id uuid not null references public.concepts(id) on delete cascade,
  concept_version_id uuid references public.concept_versions(id) on delete cascade,
  artifact_id uuid not null,
  role text not null
    check (role in ('product_front', 'ingredient_label', 'barcode', 'instructions', 'other')),
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (concept_id, artifact_id, role),
  foreign key (concept_id, user_id)
    references public.concepts(id, user_id) on delete cascade,
  foreign key (concept_version_id, user_id)
    references public.concept_versions(id, user_id) on delete cascade,
  foreign key (artifact_id, user_id)
    references public.artifacts(id, user_id) on delete cascade
);

create table public.catalogue_extractions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  concept_id uuid not null references public.concepts(id) on delete cascade,
  artifact_id uuid not null,
  provider text not null,
  model text not null,
  prompt_version text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  review_state text not null default 'proposed'
    check (review_state in ('proposed', 'accepted', 'corrected', 'rejected', 'superseded')),
  proposal jsonb,
  raw_response jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (concept_id, user_id)
    references public.concepts(id, user_id) on delete cascade,
  foreign key (artifact_id, user_id)
    references public.artifacts(id, user_id) on delete cascade
);

alter table public.jobs
  drop constraint jobs_job_type_check;

alter table public.jobs
  add constraint jobs_job_type_check
  check (
    job_type in (
      'extraction',
      'catalogue_extraction',
      'analysis',
      'report',
      'export',
      'deletion'
    )
  );

create index concepts_user_type_name_idx
  on public.concepts (user_id, concept_type, lower(canonical_name));
create index concept_versions_current_idx
  on public.concept_versions (user_id, concept_id, effective_from desc);
create index compositions_owner_version_idx
  on public.compositions (owner_version_id, component_order);
create index event_concepts_concept_idx
  on public.event_concepts (user_id, concept_id, created_at desc);
create index concept_artifacts_concept_idx
  on public.concept_artifacts (user_id, concept_id, display_order);
create index catalogue_extractions_review_idx
  on public.catalogue_extractions (user_id, review_state, created_at);

create trigger concepts_set_updated_at before update on public.concepts
for each row execute function public.set_updated_at();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'concept_versions', 'concept_artifacts', 'catalogue_extractions'
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

create or replace function public.review_catalogue_extraction(
  extraction_id uuid,
  decision text,
  reviewed_name text default null,
  reviewed_brand text default null,
  reviewed_variant text default null,
  reviewed_ingredients jsonb default '[]'::jsonb
)
returns public.catalogue_extractions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  extraction public.catalogue_extractions;
  next_version integer;
  version_id uuid;
  ingredient jsonb;
  ingredient_name text;
  ingredient_id uuid;
  ingredient_order integer := 0;
begin
  if decision not in ('accepted', 'corrected', 'rejected') then
    raise exception 'invalid review decision';
  end if;
  if jsonb_typeof(reviewed_ingredients) <> 'array' then
    raise exception 'reviewed_ingredients must be an array';
  end if;

  select *
  into extraction
  from public.catalogue_extractions
  where
    id = extraction_id
    and user_id = (select auth.uid())
    and status = 'succeeded'
    and review_state = 'proposed'
  for update;

  if not found then
    raise exception 'catalogue extraction not found or already reviewed';
  end if;

  if decision <> 'rejected' then
    if reviewed_name is not null and btrim(reviewed_name) <> '' then
      update public.concepts
      set
        canonical_name = btrim(reviewed_name),
        attributes = attributes || jsonb_build_object(
          'brand', coalesce(btrim(reviewed_brand), ''),
          'variant', coalesce(btrim(reviewed_variant), '')
        )
      where id = extraction.concept_id and user_id = (select auth.uid());
    end if;

    update public.concept_versions
    set
      effective_to = now(),
      review_state = 'superseded'
    where
      concept_id = extraction.concept_id
      and user_id = (select auth.uid())
      and effective_to is null;

    select coalesce(max(version_number), 0) + 1
    into next_version
    from public.concept_versions
    where concept_id = extraction.concept_id;

    insert into public.concept_versions (
      user_id,
      concept_id,
      version_number,
      attributes,
      review_state,
      source_method
    )
    values (
      (select auth.uid()),
      extraction.concept_id,
      next_version,
      jsonb_build_object(
        'brand', coalesce(btrim(reviewed_brand), ''),
        'variant', coalesce(btrim(reviewed_variant), ''),
        'catalogue_extraction_id', extraction.id
      ),
      decision,
      'ai'
    )
    returning id into version_id;

    for ingredient in select value from jsonb_array_elements(reviewed_ingredients)
    loop
      ingredient_name := btrim(
        case
          when jsonb_typeof(ingredient) = 'string' then ingredient #>> '{}'
          else ingredient ->> 'name'
        end
      );
      if ingredient_name is null or ingredient_name = '' then
        continue;
      end if;

      select id
      into ingredient_id
      from public.concepts
      where
        concept_type = 'ingredient'
        and lower(canonical_name) = lower(ingredient_name)
        and (user_id is null or user_id = (select auth.uid()))
      order by user_id nulls last
      limit 1;

      if ingredient_id is null then
        insert into public.concepts (user_id, concept_type, canonical_name, attributes)
        values ((select auth.uid()), 'ingredient', ingredient_name, '{}'::jsonb)
        returning id into ingredient_id;
      end if;

      ingredient_order := ingredient_order + 1;
      insert into public.compositions (
        user_id,
        owner_concept_id,
        owner_version_id,
        component_concept_id,
        component_order,
        certainty,
        source_artifact_id,
        review_state
      )
      values (
        (select auth.uid()),
        extraction.concept_id,
        version_id,
        ingredient_id,
        ingredient_order,
        case
          when jsonb_typeof(ingredient) = 'object'
            then nullif(ingredient ->> 'confidence', '')::double precision
          else null
        end,
        extraction.artifact_id,
        decision
      );
    end loop;
  end if;

  update public.catalogue_extractions
  set review_state = decision, reviewed_at = now()
  where id = extraction.id
  returning * into extraction;

  return extraction;
end;
$$;

grant execute on function public.review_catalogue_extraction(
  uuid, text, text, text, text, jsonb
) to authenticated;

create or replace function public.create_catalogue_item(
  item_type text,
  item_name text,
  item_attributes jsonb default '{}'::jsonb,
  ingredients jsonb default '[]'::jsonb
)
returns public.concepts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  created_concept public.concepts;
  version_id uuid;
  ingredient jsonb;
  ingredient_name text;
  ingredient_id uuid;
  ingredient_order integer := 0;
begin
  if item_type not in ('product', 'medication', 'treatment') then
    raise exception 'unsupported catalogue item type';
  end if;
  if btrim(item_name) = '' then
    raise exception 'item name is required';
  end if;
  if jsonb_typeof(item_attributes) <> 'object' then
    raise exception 'item_attributes must be an object';
  end if;
  if jsonb_typeof(ingredients) <> 'array' then
    raise exception 'ingredients must be an array';
  end if;

  insert into public.concepts (
    user_id,
    concept_type,
    canonical_name,
    attributes
  )
  values (
    (select auth.uid()),
    item_type,
    btrim(item_name),
    item_attributes
  )
  returning * into created_concept;

  insert into public.concept_versions (
    user_id,
    concept_id,
    version_number,
    attributes,
    review_state,
    source_method
  )
  values (
    (select auth.uid()),
    created_concept.id,
    1,
    item_attributes,
    'accepted',
    'manual'
  )
  returning id into version_id;

  for ingredient in select value from jsonb_array_elements(ingredients)
  loop
    ingredient_name := btrim(
      case
        when jsonb_typeof(ingredient) = 'string' then ingredient #>> '{}'
        else ingredient ->> 'name'
      end
    );
    if ingredient_name is null or ingredient_name = '' then
      continue;
    end if;

    select id
    into ingredient_id
    from public.concepts
    where
      concept_type = 'ingredient'
      and lower(canonical_name) = lower(ingredient_name)
      and (user_id is null or user_id = (select auth.uid()))
    order by user_id nulls last
    limit 1;

    if ingredient_id is null then
      insert into public.concepts (user_id, concept_type, canonical_name, attributes)
      values ((select auth.uid()), 'ingredient', ingredient_name, '{}'::jsonb)
      returning id into ingredient_id;
    end if;

    ingredient_order := ingredient_order + 1;
    insert into public.compositions (
      user_id,
      owner_concept_id,
      owner_version_id,
      component_concept_id,
      component_order,
      certainty,
      review_state
    )
    values (
      (select auth.uid()),
      created_concept.id,
      version_id,
      ingredient_id,
      ingredient_order,
      1,
      'accepted'
    );
  end loop;

  return created_concept;
end;
$$;

grant execute on function public.create_catalogue_item(text, text, jsonb, jsonb)
to authenticated;

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
  delete from public.record_revisions where user_id = target_user;
  delete from public.record_artifacts where user_id = target_user;
  delete from public.concept_artifacts where user_id = target_user;
  delete from public.event_concepts where user_id = target_user;
  delete from public.event_relations where user_id = target_user;
  delete from public.observations where user_id = target_user;
  delete from public.events where user_id = target_user;
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
