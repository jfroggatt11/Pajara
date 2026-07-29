insert into public.body_areas (code, parent_code, label, laterality, display_order)
values
  ('whole_body', null, 'Whole body', null, 0),
  ('head', 'whole_body', 'Head', null, 10),
  ('face', 'head', 'Face', null, 20),
  ('scalp', 'head', 'Scalp', null, 30),
  ('neck', 'whole_body', 'Neck', null, 40),
  ('torso', 'whole_body', 'Torso', null, 50),
  ('chest', 'torso', 'Chest', null, 60),
  ('back', 'torso', 'Back', null, 70),
  ('left_arm', 'whole_body', 'Left arm', 'left', 80),
  ('right_arm', 'whole_body', 'Right arm', 'right', 90),
  ('left_elbow', 'left_arm', 'Left elbow', 'left', 100),
  ('right_elbow', 'right_arm', 'Right elbow', 'right', 110),
  ('left_wrist', 'left_arm', 'Left wrist', 'left', 120),
  ('right_wrist', 'right_arm', 'Right wrist', 'right', 130),
  ('both_hands', 'whole_body', 'Both hands', 'bilateral', 140),
  ('left_hand', 'left_arm', 'Left hand', 'left', 150),
  ('right_hand', 'right_arm', 'Right hand', 'right', 160),
  ('left_fingers', 'left_hand', 'Left fingers', 'left', 170),
  ('right_fingers', 'right_hand', 'Right fingers', 'right', 180),
  ('left_leg', 'whole_body', 'Left leg', 'left', 190),
  ('right_leg', 'whole_body', 'Right leg', 'right', 200),
  ('left_knee', 'left_leg', 'Left knee', 'left', 210),
  ('right_knee', 'right_leg', 'Right knee', 'right', 220),
  ('left_ankle', 'left_leg', 'Left ankle', 'left', 230),
  ('right_ankle', 'right_leg', 'Right ankle', 'right', 240),
  ('left_foot', 'left_leg', 'Left foot', 'left', 250),
  ('right_foot', 'right_leg', 'Right foot', 'right', 260)
on conflict (code) do update set
  parent_code = excluded.parent_code,
  label = excluded.label,
  laterality = excluded.laterality,
  display_order = excluded.display_order;

insert into public.type_definitions (kind, code, version, label, ui_hints)
values
  ('event', 'skin_check', 1, 'Skin check', '{"icon":"scan-face"}'),
  ('event', 'meal', 1, 'Meal', '{"icon":"utensils"}'),
  ('event', 'meal_preparation', 1, 'Meal preparation', '{"icon":"cooking-pot"}'),
  ('event', 'skin_contact', 1, 'Skin contact', '{"icon":"hand"}'),
  ('event', 'product_use', 1, 'Product use', '{"icon":"package"}'),
  ('event', 'topical_treatment', 1, 'Topical treatment', '{"icon":"cross"}'),
  ('event', 'medication', 1, 'Medication', '{"icon":"pill"}'),
  ('event', 'activity', 1, 'Activity', '{"icon":"activity"}'),
  ('event', 'note', 1, 'Note', '{"icon":"notebook"}'),
  ('event', 'sleep', 1, 'Sleep', '{"icon":"moon"}'),
  ('event', 'stress', 1, 'Stress', '{"icon":"brain"}'),
  ('event', 'illness', 1, 'Illness', '{"icon":"thermometer"}'),
  ('event', 'environmental_exposure', 1, 'Environmental exposure', '{"icon":"cloud-sun"}'),
  ('observation', 'redness', 1, 'Redness', '{"scale":"symptom_0_10_v1"}'),
  ('observation', 'itching', 1, 'Itching', '{"scale":"symptom_0_10_v1"}'),
  ('observation', 'dryness', 1, 'Dryness', '{"scale":"symptom_0_10_v1"}'),
  ('observation', 'cracking', 1, 'Cracking', '{"scale":"symptom_0_10_v1"}'),
  ('observation', 'swelling', 1, 'Swelling', '{"scale":"symptom_0_10_v1"}'),
  ('observation', 'pain', 1, 'Pain', '{"scale":"symptom_0_10_v1"}')
on conflict (kind, code, version) do update set
  label = excluded.label,
  ui_hints = excluded.ui_hints,
  active = true;

