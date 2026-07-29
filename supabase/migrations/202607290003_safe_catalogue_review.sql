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
  current_concept public.concepts;
  updated_concept public.concepts;
  current_version_id uuid;
  next_version integer;
  version_id uuid;
  resolved_name text;
  resolved_brand text;
  resolved_variant text;
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
    select *
    into current_concept
    from public.concepts
    where
      id = extraction.concept_id
      and user_id = (select auth.uid())
    for update;

    if not found then
      raise exception 'catalogue item not found';
    end if;

    resolved_name := coalesce(
      nullif(btrim(reviewed_name), ''),
      current_concept.canonical_name
    );
    resolved_brand := coalesce(
      nullif(btrim(reviewed_brand), ''),
      nullif(btrim(current_concept.attributes ->> 'brand'), ''),
      ''
    );
    resolved_variant := coalesce(
      nullif(btrim(reviewed_variant), ''),
      nullif(btrim(current_concept.attributes ->> 'variant'), ''),
      ''
    );

    select id
    into current_version_id
    from public.concept_versions
    where
      concept_id = extraction.concept_id
      and user_id = (select auth.uid())
      and effective_to is null
    order by version_number desc
    limit 1;

    update public.concepts
    set
      canonical_name = resolved_name,
      attributes = attributes || jsonb_build_object(
        'brand', resolved_brand,
        'variant', resolved_variant
      )
    where id = extraction.concept_id and user_id = (select auth.uid())
    returning * into updated_concept;

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
      updated_concept.attributes || jsonb_build_object(
        'catalogue_extraction_id', extraction.id
      ),
      decision,
      'ai'
    )
    returning id into version_id;

    if jsonb_array_length(reviewed_ingredients) = 0 and current_version_id is not null then
      insert into public.compositions (
        user_id,
        owner_concept_id,
        owner_version_id,
        component_concept_id,
        amount,
        unit,
        concentration,
        component_order,
        valid_from,
        valid_to,
        certainty,
        source_artifact_id,
        review_state
      )
      select
        user_id,
        owner_concept_id,
        version_id,
        component_concept_id,
        amount,
        unit,
        concentration,
        component_order,
        valid_from,
        valid_to,
        certainty,
        source_artifact_id,
        review_state
      from public.compositions
      where
        owner_version_id = current_version_id
        and user_id = (select auth.uid());
    else
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

-- Repair catalogue identity fields that the earlier review function could replace
-- with an empty AI value. Only blank current fields are filled from history.
update public.concepts concept
set attributes = concept.attributes || jsonb_strip_nulls(
  jsonb_build_object(
    'brand',
    case
      when nullif(btrim(concept.attributes ->> 'brand'), '') is null then (
        select nullif(btrim(version.attributes ->> 'brand'), '')
        from public.concept_versions version
        where
          version.concept_id = concept.id
          and nullif(btrim(version.attributes ->> 'brand'), '') is not null
        order by version.version_number desc
        limit 1
      )
      else concept.attributes ->> 'brand'
    end,
    'variant',
    case
      when nullif(btrim(concept.attributes ->> 'variant'), '') is null then (
        select nullif(btrim(version.attributes ->> 'variant'), '')
        from public.concept_versions version
        where
          version.concept_id = concept.id
          and nullif(btrim(version.attributes ->> 'variant'), '') is not null
        order by version.version_number desc
        limit 1
      )
      else concept.attributes ->> 'variant'
    end
  )
)
where
  concept.user_id is not null
  and concept.concept_type in ('product', 'medication', 'treatment')
  and (
    nullif(btrim(concept.attributes ->> 'brand'), '') is null
    or nullif(btrim(concept.attributes ->> 'variant'), '') is null
  );

-- Restore the complete catalogue snapshot on active versions while preserving
-- extraction-specific metadata such as catalogue_extraction_id.
update public.concept_versions version
set attributes = version.attributes || concept.attributes
from public.concepts concept
where
  version.concept_id = concept.id
  and version.user_id = concept.user_id
  and version.effective_to is null;

-- If the earlier review produced an empty active composition, copy the most recent
-- non-empty formulation. Existing active ingredients are never changed.
insert into public.compositions (
  user_id,
  owner_concept_id,
  owner_version_id,
  component_concept_id,
  amount,
  unit,
  concentration,
  component_order,
  valid_from,
  valid_to,
  certainty,
  source_artifact_id,
  review_state
)
select
  previous_component.user_id,
  previous_component.owner_concept_id,
  active_version.id,
  previous_component.component_concept_id,
  previous_component.amount,
  previous_component.unit,
  previous_component.concentration,
  previous_component.component_order,
  previous_component.valid_from,
  previous_component.valid_to,
  previous_component.certainty,
  previous_component.source_artifact_id,
  previous_component.review_state
from public.concept_versions active_version
join lateral (
  select previous_version.id
  from public.concept_versions previous_version
  where
    previous_version.concept_id = active_version.concept_id
    and previous_version.version_number < active_version.version_number
    and exists (
      select 1
      from public.compositions candidate
      where candidate.owner_version_id = previous_version.id
    )
  order by previous_version.version_number desc
  limit 1
) previous_version on true
join public.compositions previous_component
  on previous_component.owner_version_id = previous_version.id
where
  active_version.effective_to is null
  and not exists (
    select 1
    from public.compositions current_component
    where current_component.owner_version_id = active_version.id
  );
