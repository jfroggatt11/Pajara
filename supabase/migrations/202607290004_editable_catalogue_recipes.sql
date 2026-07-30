create or replace function public.save_catalogue_item(
  item_type text,
  item_name text,
  item_attributes jsonb default '{}'::jsonb,
  ingredients jsonb default '[]'::jsonb,
  catalogue_item_id uuid default null,
  derived_from_id uuid default null
)
returns public.concepts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  saved_concept public.concepts;
  source_recipe public.concepts;
  current_version_id uuid;
  next_version integer := 1;
  version_id uuid;
  ingredient jsonb;
  ingredient_name text;
  ingredient_id uuid;
  ingredient_order integer := 0;
  ingredient_amount double precision;
  ingredient_unit text;
  ingredient_concentration text;
begin
  if item_type not in ('product', 'medication', 'treatment', 'recipe') then
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
  if catalogue_item_id is not null and derived_from_id is not null then
    raise exception 'an edit cannot also create a variation';
  end if;

  if catalogue_item_id is null then
    if derived_from_id is not null then
      select *
      into source_recipe
      from public.concepts
      where
        id = derived_from_id
        and user_id = (select auth.uid())
        and concept_type = 'recipe';
      if not found or item_type <> 'recipe' then
        raise exception 'source recipe not found';
      end if;
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
    returning * into saved_concept;
  else
    select *
    into saved_concept
    from public.concepts
    where
      id = catalogue_item_id
      and user_id = (select auth.uid())
      and concept_type = item_type
    for update;

    if not found then
      raise exception 'catalogue item not found';
    end if;

    select id
    into current_version_id
    from public.concept_versions
    where
      concept_id = saved_concept.id
      and user_id = (select auth.uid())
      and effective_to is null
    order by version_number desc
    limit 1;

    update public.concepts
    set
      canonical_name = btrim(item_name),
      attributes = attributes || item_attributes
    where id = saved_concept.id and user_id = (select auth.uid())
    returning * into saved_concept;

    update public.concept_versions
    set
      effective_to = now(),
      review_state = 'superseded'
    where
      concept_id = saved_concept.id
      and user_id = (select auth.uid())
      and effective_to is null;

    select coalesce(max(version_number), 0) + 1
    into next_version
    from public.concept_versions
    where concept_id = saved_concept.id;
  end if;

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
    saved_concept.id,
    next_version,
    saved_concept.attributes,
    case when catalogue_item_id is null then 'accepted' else 'corrected' end,
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
    ingredient_amount := case
      when jsonb_typeof(ingredient) = 'object'
        then nullif(ingredient ->> 'amount', '')::double precision
      else null
    end;
    ingredient_unit := case
      when jsonb_typeof(ingredient) = 'object'
        then nullif(btrim(ingredient ->> 'unit'), '')
      else null
    end;
    ingredient_concentration := case
      when jsonb_typeof(ingredient) = 'object'
        then nullif(btrim(ingredient ->> 'concentration'), '')
      else null
    end;

    insert into public.compositions (
      user_id,
      owner_concept_id,
      owner_version_id,
      component_concept_id,
      amount,
      unit,
      concentration,
      component_order,
      certainty,
      review_state
    )
    values (
      (select auth.uid()),
      saved_concept.id,
      version_id,
      ingredient_id,
      ingredient_amount,
      ingredient_unit,
      ingredient_concentration,
      ingredient_order,
      1,
      case when catalogue_item_id is null then 'accepted' else 'corrected' end
    );
  end loop;

  if derived_from_id is not null then
    insert into public.concept_relations (
      user_id,
      subject_id,
      predicate,
      object_id,
      attributes
    )
    values (
      (select auth.uid()),
      saved_concept.id,
      'derived_from',
      source_recipe.id,
      jsonb_build_object(
        'created_as_variation_at', now(),
        'source_version_id', (
          select id
          from public.concept_versions
          where concept_id = source_recipe.id
          order by version_number desc
          limit 1
        )
      )
    );
  end if;

  return saved_concept;
end;
$$;

grant execute on function public.save_catalogue_item(
  text, text, jsonb, jsonb, uuid, uuid
) to authenticated;

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
  saved_concept public.concepts;
  active_version_id uuid;
  effective_ingredients jsonb;
  resolved_name text;
  resolved_brand text;
  resolved_variant text;
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
    where id = extraction.concept_id and user_id = (select auth.uid())
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

    effective_ingredients := reviewed_ingredients;
    if jsonb_array_length(effective_ingredients) = 0 then
      select coalesce(
        jsonb_agg(
          jsonb_strip_nulls(
            jsonb_build_object(
              'name', component.canonical_name,
              'amount', composition.amount,
              'unit', composition.unit,
              'concentration', composition.concentration,
              'confidence', composition.certainty
            )
          )
          order by composition.component_order
        ),
        '[]'::jsonb
      )
      into effective_ingredients
      from public.compositions composition
      join public.concepts component on component.id = composition.component_concept_id
      join public.concept_versions version on version.id = composition.owner_version_id
      where
        composition.owner_concept_id = current_concept.id
        and composition.user_id = (select auth.uid())
        and version.effective_to is null;
    end if;

    select *
    into saved_concept
    from public.save_catalogue_item(
      current_concept.concept_type,
      resolved_name,
      current_concept.attributes || jsonb_build_object(
        'brand', resolved_brand,
        'variant', resolved_variant
      ),
      effective_ingredients,
      current_concept.id,
      null
    );

    select id
    into active_version_id
    from public.concept_versions
    where
      concept_id = saved_concept.id
      and user_id = (select auth.uid())
      and effective_to is null
    order by version_number desc
    limit 1;

    update public.concept_versions
    set
      source_method = 'ai',
      review_state = decision,
      attributes = attributes || jsonb_build_object(
        'catalogue_extraction_id', extraction.id
      )
    where id = active_version_id and user_id = (select auth.uid());

    update public.compositions composition
    set
      source_artifact_id = extraction.artifact_id,
      certainty = coalesce(
        nullif(
          effective_ingredients -> (composition.component_order - 1) ->> 'confidence',
          ''
        )::double precision,
        composition.certainty
      ),
      review_state = decision
    where
      composition.owner_version_id = active_version_id
      and composition.user_id = (select auth.uid());
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
