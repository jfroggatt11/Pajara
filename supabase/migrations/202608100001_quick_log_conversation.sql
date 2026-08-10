-- Additive conversational Quick Log storage. Existing capture_sessions.artifact_id
-- remains available for older clients and is backfilled into capture_artifacts.

alter table public.capture_sessions
  drop constraint if exists capture_sessions_source_type_check;
alter table public.capture_sessions
  add constraint capture_sessions_source_type_check
  check (source_type in ('photo', 'voice', 'text', 'manual', 'import', 'mixed'));

alter table public.events drop constraint if exists events_source_method_check;
alter table public.events add constraint events_source_method_check
  check (source_method in (
    'manual', 'text', 'voice', 'photo', 'document', 'import', 'ai', 'mixed'
  ));

create table public.capture_artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  capture_session_id uuid not null,
  artifact_id uuid not null,
  artifact_role text not null default 'unclassified'
    check (artifact_role in (
      'unclassified', 'meal_photo', 'ingredient_label', 'product_front',
      'recipe_document', 'activity_photo', 'voice_note', 'other'
    )),
  display_order integer not null check (display_order >= 0),
  interpretation jsonb not null default '{}'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (capture_session_id, artifact_id),
  unique (capture_session_id, display_order),
  foreign key (capture_session_id, user_id)
    references public.capture_sessions(id, user_id) on delete cascade,
  foreign key (artifact_id, user_id)
    references public.artifacts(id, user_id) on delete cascade
);

create table public.capture_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  capture_session_id uuid not null,
  author text not null check (author in ('user', 'assistant', 'system')),
  message_kind text not null
    check (message_kind in ('text', 'voice_transcript', 'correction', 'system_summary')),
  text_content text not null check (btrim(text_content) <> ''),
  artifact_id uuid,
  message_order integer not null check (message_order >= 0),
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (capture_session_id, message_order),
  foreign key (capture_session_id, user_id)
    references public.capture_sessions(id, user_id) on delete cascade,
  foreign key (artifact_id, user_id)
    references public.artifacts(id, user_id) on delete cascade
);

create table public.capture_review_fields (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  capture_session_id uuid not null,
  field_key text not null check (field_key ~ '^[a-z][a-z0-9_]*$'),
  proposed_value jsonb not null default 'null'::jsonb,
  confirmed_value jsonb,
  confirmation_state text not null default 'unconfirmed'
    check (confirmation_state in ('unconfirmed', 'confirmed')),
  evidence jsonb not null default '[]'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (capture_session_id, field_key),
  foreign key (capture_session_id, user_id)
    references public.capture_sessions(id, user_id) on delete cascade,
  check (
    (confirmation_state = 'unconfirmed' and confirmed_value is null)
    or confirmation_state = 'confirmed'
  )
);

create index capture_artifacts_capture_idx
  on public.capture_artifacts (capture_session_id, display_order);
create index capture_messages_capture_idx
  on public.capture_messages (capture_session_id, message_order);
create index capture_review_fields_capture_idx
  on public.capture_review_fields (capture_session_id, field_key);

insert into public.capture_artifacts (
  user_id, capture_session_id, artifact_id, artifact_role, display_order, provenance
)
select
  capture.user_id,
  capture.id,
  capture.artifact_id,
  case capture.source_type when 'voice' then 'voice_note' else 'unclassified' end,
  0,
  jsonb_build_object('backfilled_from', 'capture_sessions.artifact_id')
from public.capture_sessions capture
where capture.artifact_id is not null
on conflict (capture_session_id, artifact_id) do nothing;

alter table public.capture_artifacts enable row level security;
alter table public.capture_messages enable row level security;
alter table public.capture_review_fields enable row level security;

create policy capture_artifacts_owner_all on public.capture_artifacts
  for all using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy capture_messages_owner_all on public.capture_messages
  for all using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy capture_review_fields_owner_all on public.capture_review_fields
  for all using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create trigger capture_review_fields_set_updated_at
before update on public.capture_review_fields
for each row execute function public.set_updated_at();

-- Save a reviewed Quick Log in one transaction. New reusable knowledge, trusted
-- events and artifact links are committed together. Repeating a successful call
-- returns the existing result without creating duplicate events.
create or replace function public.confirm_quick_log_capture(
  target_capture_id uuid,
  recipe_definition jsonb default null,
  concept_definition jsonb default null,
  activities jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  capture public.capture_sessions;
  required_key text;
  saved_recipe public.recipes;
  recipe_version_id uuid;
  recipe_output_id uuid;
  saved_concept public.concepts;
  concept_version_id uuid;
  resolved_activities jsonb := activities;
  result jsonb;
  first_event_id uuid;
  reviewed_value jsonb;
  occurrence_kind text;
  required_keys text[];
  expected_event_type text;
  contact_value jsonb;
  contact_item jsonb;
  contact_area jsonb;
  contact_event_id uuid;
  contacted_concept public.concepts;
  contacted_concept_version_id uuid;
  contacted_food public.food_items;
begin
  select * into capture
  from public.capture_sessions
  where id = target_capture_id and user_id = (select auth.uid())
  for update;
  if not found then raise exception 'capture session not found'; end if;

  if capture.status = 'confirmed' then
    return jsonb_build_object(
      'already_confirmed', true,
      'event_ids', coalesce((
        select jsonb_agg(event.id order by event.created_at)
        from public.events event
        where event.capture_session_id = capture.id and event.user_id = (select auth.uid())
      ), '[]'::jsonb)
    );
  end if;
  if capture.status <> 'ready' then
    raise exception 'capture session is not ready for confirmation';
  end if;

  select field.confirmed_value #>> '{}' into occurrence_kind
  from public.capture_review_fields field
  where field.capture_session_id = capture.id
    and field.user_id = (select auth.uid())
    and field.field_key = 'occurrence_type'
    and field.confirmation_state = 'confirmed';
  if coalesce(occurrence_kind, '') not in (
    'meal', 'drink', 'product', 'cream', 'medication', 'exercise',
    'shower', 'washing', 'swimming', 'other'
  ) then
    raise exception 'a valid confirmed occurrence type is required';
  end if;
  required_keys := array['date_time', 'occurrence_type', 'identity'];
  if occurrence_kind in ('meal', 'drink') then
    required_keys := required_keys || array['meal_contents', 'preparation_contact'];
  elsif occurrence_kind in ('product', 'cream', 'medication') then
    required_keys := required_keys || array['product_details', 'skin_contact'];
  else
    required_keys := required_keys || array['activity_products', 'skin_contact'];
  end if;
  if exists (
    select 1 from public.capture_review_fields field
    where field.capture_session_id = capture.id
      and field.user_id = (select auth.uid())
      and field.field_key = 'occurrence_choice'
  ) then
    required_keys := array_prepend('occurrence_choice', required_keys);
  end if;

  for required_key in select unnest(required_keys)
  loop
    select field.confirmed_value into reviewed_value
    from public.capture_review_fields field
      where field.capture_session_id = capture.id
        and field.user_id = (select auth.uid())
        and field.field_key = required_key
        and field.confirmation_state = 'confirmed';
    if not found or reviewed_value is null then
      raise exception 'required review field is not confirmed: %', required_key;
    end if;
    if required_key = 'date_time'
       and (jsonb_typeof(reviewed_value) <> 'object'
         or nullif(reviewed_value ->> 'occurred_at', '') is null) then
      raise exception 'confirmed date_time is invalid';
    elsif required_key = 'occurrence_type'
       and coalesce(reviewed_value #>> '{}', '') not in (
         'meal', 'drink', 'product', 'cream', 'medication', 'exercise',
         'shower', 'washing', 'swimming', 'other'
       ) then
      raise exception 'confirmed occurrence_type is invalid';
    elsif required_key = 'identity'
       and (jsonb_typeof(reviewed_value) <> 'object'
         or nullif(btrim(reviewed_value ->> 'name'), '') is null) then
      raise exception 'confirmed identity is invalid';
    elsif required_key = 'occurrence_choice'
       and nullif(btrim(reviewed_value ->> 'selected'), '') is null then
      raise exception 'confirmed occurrence choice is invalid';
    elsif required_key = 'meal_contents'
       and coalesce(jsonb_typeof(reviewed_value -> 'ingredients'), '') <> 'array' then
      raise exception 'confirmed meal contents are invalid';
    elsif required_key = 'preparation_contact'
       and (
         jsonb_typeof(reviewed_value -> 'prepared_by_user') <> 'boolean'
         or coalesce(reviewed_value -> 'skin_contact' ->> 'mode', '')
           not in ('none', 'direct', 'gloves')
       ) then
      raise exception 'confirmed preparation/contact is invalid';
    elsif required_key = 'product_details'
       and nullif(btrim(reviewed_value ->> 'action'), '') is null then
      raise exception 'confirmed product details are invalid';
    elsif required_key = 'activity_products'
       and coalesce(jsonb_typeof(reviewed_value -> 'products'), '') <> 'array' then
      raise exception 'confirmed activity products are invalid';
    elsif required_key = 'skin_contact'
       and coalesce(reviewed_value ->> 'mode', '') not in ('none', 'direct', 'gloves') then
      raise exception 'confirmed skin contact is invalid';
    end if;
    if required_key = 'preparation_contact'
       and reviewed_value -> 'skin_contact' ->> 'mode' in ('direct', 'gloves')
       and (
         coalesce(jsonb_array_length(reviewed_value -> 'skin_contact' -> 'items'), 0) = 0
         or coalesce(jsonb_array_length(reviewed_value -> 'skin_contact' -> 'body_areas'), 0) = 0
       ) then
      raise exception 'contact item and body area are required';
    elsif required_key = 'skin_contact'
       and reviewed_value ->> 'mode' in ('direct', 'gloves')
       and (
         coalesce(jsonb_array_length(reviewed_value -> 'items'), 0) = 0
         or coalesce(jsonb_array_length(reviewed_value -> 'body_areas'), 0) = 0
       ) then
      raise exception 'contact item and body area are required';
    end if;
  end loop;

  if jsonb_typeof(resolved_activities) <> 'array'
     or jsonb_array_length(resolved_activities) not between 1 and 2 then
    raise exception 'a Quick Log must contain one occurrence with one or two linked activities';
  end if;
  expected_event_type := case occurrence_kind
    when 'meal' then 'meal'
    when 'drink' then 'meal'
    when 'product' then 'product_use'
    when 'cream' then 'topical_treatment'
    when 'medication' then 'medication'
    else 'activity'
  end;
  if resolved_activities -> 0 ->> 'type_code' is distinct from expected_event_type then
    raise exception 'activity payload does not match the confirmed occurrence type';
  end if;
  if jsonb_array_length(resolved_activities) = 2
     and (
       occurrence_kind not in ('meal', 'drink')
       or resolved_activities -> 1 ->> 'type_code' is distinct from 'meal_preparation'
       or coalesce((resolved_activities -> 1 ->> 'parent_order')::integer, 0) <> 1
     ) then
    raise exception 'the second activity must be a preparation linked to the meal';
  end if;
  if occurrence_kind in ('meal', 'drink') then
    select field.confirmed_value into contact_value
    from public.capture_review_fields field
    where field.capture_session_id = capture.id
      and field.user_id = (select auth.uid())
      and field.field_key = 'preparation_contact';
    if (
      coalesce((contact_value ->> 'prepared_by_user')::boolean, false)
      or contact_value -> 'skin_contact' ->> 'mode' in ('direct', 'gloves')
    ) and jsonb_array_length(resolved_activities) <> 2 then
      raise exception 'confirmed meal preparation/contact requires a linked preparation event';
    end if;
  else
    select field.confirmed_value into contact_value
    from public.capture_review_fields field
    where field.capture_session_id = capture.id
      and field.user_id = (select auth.uid())
      and field.field_key = 'skin_contact';
  end if;

  if recipe_definition is not null then
    if recipe_definition ->> 'mode' = 'existing' then
      select recipe.* into saved_recipe
      from public.recipes recipe
      where recipe.id = (recipe_definition ->> 'recipe_id')::uuid
        and recipe.user_id = (select auth.uid());
      if not found then raise exception 'recipe not found'; end if;
    else
      select * into saved_recipe
      from public.save_recipe_definition(
        recipe_name := recipe_definition ->> 'name',
        components := coalesce(recipe_definition -> 'components', '[]'::jsonb),
        instructions := recipe_definition ->> 'instructions',
        yield_amount := null,
        yield_unit := null,
        existing_recipe_id := nullif(recipe_definition ->> 'recipe_id', '')::uuid,
        derived_from_id := nullif(recipe_definition ->> 'derived_from_id', '')::uuid,
        recipe_attributes := coalesce(recipe_definition -> 'attributes', '{}'::jsonb)
      );
    end if;
    select version.id, recipe.output_food_item_id
    into recipe_version_id, recipe_output_id
    from public.recipes recipe
    join public.recipe_versions version on version.recipe_id = recipe.id
    where recipe.id = saved_recipe.id and recipe.user_id = (select auth.uid())
      and version.effective_to is null
    order by version.version_number desc limit 1;
    if not found then raise exception 'active recipe version not found'; end if;
    resolved_activities := replace(
      replace(resolved_activities::text, '"$resolved_recipe_version_id"', to_json(recipe_version_id)::text),
      '"$resolved_food_item_id"', to_json(recipe_output_id)::text
    )::jsonb;
  end if;

  if concept_definition is not null then
    if concept_definition ->> 'mode' = 'existing' then
      select concept.* into saved_concept
      from public.concepts concept
      where concept.id = (concept_definition ->> 'concept_id')::uuid
        and concept.user_id = (select auth.uid());
      if not found then raise exception 'catalogue item not found'; end if;
    else
      select * into saved_concept
      from public.save_catalogue_item(
        item_type := coalesce(nullif(concept_definition ->> 'concept_type', ''), 'product'),
        item_name := concept_definition ->> 'name',
        item_attributes := coalesce(concept_definition -> 'attributes', '{}'::jsonb),
        ingredients := coalesce(concept_definition -> 'ingredients', '[]'::jsonb),
        catalogue_item_id := nullif(concept_definition ->> 'concept_id', '')::uuid,
        derived_from_id := nullif(concept_definition ->> 'derived_from_id', '')::uuid
      );
    end if;
    select version.id into concept_version_id
    from public.concept_versions version
    where version.concept_id = saved_concept.id and version.user_id = (select auth.uid())
      and version.effective_to is null
    order by version.version_number desc limit 1;
    resolved_activities := replace(
      replace(
        resolved_activities::text,
        '"$resolved_concept_version_id"',
        coalesce(to_json(concept_version_id)::text, 'null')
      ),
      '"$resolved_concept_id"', to_json(saved_concept.id)::text
    )::jsonb;
  end if;

  result := public.log_activity_bundle(
    target_profile_id := capture.profile_id,
    occurred_at := capture.occurred_at,
    timezone := capture.recorded_timezone,
    capture_id := capture.id,
    activities := resolved_activities
  );

  if occurrence_kind in ('meal', 'drink') then
    contact_value := contact_value -> 'skin_contact';
    if jsonb_array_length(result -> 'event_ids') = 2 then
      contact_event_id := (result -> 'event_ids' ->> 1)::uuid;
    end if;
  else
    contact_event_id := (result -> 'event_ids' ->> 0)::uuid;
  end if;
  if contact_event_id is not null
     and contact_value ->> 'mode' in ('direct', 'gloves') then
    for contact_item in
      select value from jsonb_array_elements(contact_value -> 'items')
    loop
      contacted_concept := null;
      contacted_concept_version_id := null;
      contacted_food := null;
      select concept.* into contacted_concept
      from public.concepts concept
      where concept.user_id = (select auth.uid())
        and lower(concept.canonical_name) = lower(contact_item #>> '{}')
        and concept.archived_at is null
      order by concept.updated_at desc limit 1;
      if found then
        select version.id into contacted_concept_version_id
        from public.concept_versions version
        where version.concept_id = contacted_concept.id
          and version.user_id = (select auth.uid())
          and version.effective_to is null
        order by version.version_number desc limit 1;
      elsif occurrence_kind not in ('meal', 'drink') then
        select * into contacted_concept
        from public.save_catalogue_item(
          item_type := 'product',
          item_name := contact_item #>> '{}',
          item_attributes := jsonb_build_object('source_method', 'quick_log_contact'),
          ingredients := '[]'::jsonb,
          catalogue_item_id := null,
          derived_from_id := null
        );
        select version.id into contacted_concept_version_id
        from public.concept_versions version
        where version.concept_id = contacted_concept.id
          and version.user_id = (select auth.uid())
          and version.effective_to is null
        order by version.version_number desc limit 1;
      else
        select food.* into contacted_food
        from public.food_items food
        where lower(food.canonical_name) = lower(contact_item #>> '{}')
          and (food.user_id is null or food.user_id = (select auth.uid()))
        order by food.user_id nulls last limit 1;
        if not found then
          insert into public.food_items (user_id, canonical_name, food_kind)
          values ((select auth.uid()), contact_item #>> '{}', 'material')
          returning * into contacted_food;
        end if;
      end if;
      for contact_area in
        select value from jsonb_array_elements(contact_value -> 'body_areas')
      loop
        insert into public.event_concepts (
          user_id, event_id, concept_id, concept_version_id, food_item_id,
          role, body_area_code, contact_state, gloves_used, direct_contact,
          confidence, review_state, provenance
        ) values (
          (select auth.uid()), contact_event_id, contacted_concept.id,
          contacted_concept_version_id, contacted_food.id, 'contacted',
          contact_area #>> '{}', contact_value ->> 'mode',
          contact_value ->> 'mode' = 'gloves',
          case contact_value ->> 'mode' when 'direct' then 'yes' else 'no' end,
          1, 'accepted', jsonb_build_object('capture_session_id', capture.id)
        );
      end loop;
    end loop;
  end if;

  first_event_id := (result -> 'event_ids' ->> 0)::uuid;
  insert into public.record_artifacts (
    user_id, event_id, artifact_id, role, display_order
  )
  select
    artifact.user_id,
    first_event_id,
    artifact.artifact_id,
    case artifact.artifact_role
      when 'voice_note' then 'voice_note'
      when 'meal_photo' then 'meal_photo'
      when 'ingredient_label' then 'ingredient_label'
      when 'recipe_document' then 'recipe_document'
      else 'capture_evidence'
    end,
    artifact.display_order
  from public.capture_artifacts artifact
  where artifact.capture_session_id = capture.id and artifact.user_id = (select auth.uid())
  on conflict do nothing;

  return result || jsonb_build_object(
    'already_confirmed', false,
    'recipe_id', saved_recipe.id,
    'recipe_version_id', recipe_version_id,
    'concept_id', saved_concept.id,
    'concept_version_id', concept_version_id
  );
end;
$$;

grant execute on function public.confirm_quick_log_capture(uuid, jsonb, jsonb, jsonb)
  to authenticated;
