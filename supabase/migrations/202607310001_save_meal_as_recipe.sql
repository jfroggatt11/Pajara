create or replace function public.save_meal_event_as_recipe(
  meal_event_id uuid,
  recipe_name text,
  recipe_ingredients jsonb default '[]'::jsonb,
  preparation_method text default null,
  preparation_contact_notes text default null
)
returns public.concepts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  meal_event public.events;
  saved_recipe public.concepts;
  recipe_version public.concept_versions;
begin
  if btrim(recipe_name) = '' then
    raise exception 'recipe name is required';
  end if;
  if jsonb_typeof(recipe_ingredients) <> 'array' then
    raise exception 'recipe_ingredients must be an array';
  end if;

  select *
  into meal_event
  from public.events
  where
    id = meal_event_id
    and user_id = (select auth.uid())
    and type_code = 'meal'
  for update;

  if not found then
    raise exception 'meal event not found';
  end if;

  if exists (
    select 1
    from public.event_concepts event_concept
    join public.concepts concept on concept.id = event_concept.concept_id
    where
      event_concept.event_id = meal_event.id
      and event_concept.user_id = (select auth.uid())
      and event_concept.role = 'consumed'
      and concept.concept_type = 'recipe'
  ) then
    raise exception 'meal event is already linked to a saved recipe';
  end if;

  select *
  into saved_recipe
  from public.save_catalogue_item(
    'recipe',
    recipe_name,
    jsonb_build_object(
      'preparation_notes', coalesce(btrim(preparation_method), ''),
      'preparation_contact_notes', coalesce(btrim(preparation_contact_notes), ''),
      'created_from_event_id', meal_event.id
    ),
    recipe_ingredients,
    null,
    null
  );

  select *
  into recipe_version
  from public.concept_versions
  where
    concept_id = saved_recipe.id
    and user_id = (select auth.uid())
    and effective_to is null
  order by version_number desc
  limit 1;

  insert into public.event_concepts (
    user_id,
    event_id,
    concept_id,
    concept_version_id,
    role,
    confidence,
    review_state,
    provenance
  )
  values (
    (select auth.uid()),
    meal_event.id,
    saved_recipe.id,
    recipe_version.id,
    'consumed',
    1,
    'accepted',
    jsonb_build_object(
      'method', 'saved_from_meal_event',
      'concept_version', recipe_version.version_number
    )
  );

  update public.events
  set label = coalesce(nullif(btrim(label), ''), saved_recipe.canonical_name)
  where id = meal_event.id and user_id = (select auth.uid());

  return saved_recipe;
end;
$$;

grant execute on function public.save_meal_event_as_recipe(
  uuid, text, jsonb, text, text
) to authenticated;
