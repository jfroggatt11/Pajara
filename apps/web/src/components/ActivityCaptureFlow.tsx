import {useEffect, useState} from "react";
import type {Session} from "@supabase/supabase-js";
import {useVoiceRecorder} from "../hooks/useVoiceRecorder";
import {apiPost} from "../lib/api";
import {uploadCaptureArtifact} from "../lib/artifacts";
import {parseIngredientNames} from "../lib/catalogue";
import {localDatetimeToIso, localDatetimeValue} from "../lib/datetime";
import {transcribeWithMoonshine} from "../lib/moonshine";
import {supabase} from "../lib/supabase";
import type {
  ActivityProposal,
  BodyArea,
  CaptureSession,
  FoodBatch,
  FoodItem,
  Profile,
  ProposalCandidate,
  Recipe,
  RecipeVersion,
} from "../types";
import {FoodLabelImporter, type ImportedFoodFormulation} from "./FoodLabelImporter";
import {StatusMessage} from "./StatusMessage";

type CaptureSource = "photo" | "voice";
type ReviewStage = "capture" | "matches" | "ingredients" | "preparation" | "saved";

interface ProposalEdit {
  choice: string;
  label: string;
  ingredients: string;
  ingestionMethod: "eaten" | "drank" | "swallowed" | "sublingual" | "inhaled" | "other";
  amount: string;
  unit: string;
  durationMinutes: string;
  prepared: boolean;
  touched: string[];
  bodyArea: string;
  gloves: boolean;
  gloveMaterial: string;
  preparationMethod: string;
  contactNotes: string;
}

interface ResolvedDish {
  recipe: Recipe;
  version: RecipeVersion;
  ingredients: Array<{id: string; name: string}>;
}

interface SubRecipeSelection {
  key: string;
  name: string;
  foodItemId: string;
  recipeId: string;
  recipeVersionId: string;
  sourceFoodBatchId: string | null;
  source: "recent_batch" | "saved_recipe" | "food_label";
}

function normalizedSet(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLocaleLowerCase()).filter(Boolean))]
    .sort();
}

function sameIngredients(left: string[], right: string[]): boolean {
  return JSON.stringify(normalizedSet(left)) === JSON.stringify(normalizedSet(right));
}

function guessIngredients(proposal: ActivityProposal, generic: boolean): string[] {
  const guess = generic ? proposal.generic_guess : proposal.personalized_guess;
  return (guess.ingredients || []).map(({name}) => name);
}

function initialIngestionMethod(proposal: ActivityProposal): ProposalEdit["ingestionMethod"] {
  const proposed = proposal.personalized_guess.attributes?.ingestion_method;
  if (["eaten", "drank", "swallowed", "sublingual", "inhaled", "other"].includes(
    String(proposed),
  )) return proposed as ProposalEdit["ingestionMethod"];
  if (/\b(drank|drink|beverage|juice|water|coffee|tea)\b/i.test(proposal.label || "")) {
    return "drank";
  }
  return proposal.activity_type === "medication" ? "swallowed" : "eaten";
}

export function ActivityCaptureFlow({
  session,
  profile,
  bodyAreas,
  onSaved,
}: {
  session: Session;
  profile: Profile;
  bodyAreas: BodyArea[];
  onSaved: () => void;
}) {
  const [source, setSource] = useState<CaptureSource>("photo");
  const [occurred, setOccurred] = useState(localDatetimeValue());
  const [stage, setStage] = useState<ReviewStage>("capture");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [capture, setCapture] = useState<CaptureSession | null>(null);
  const [proposals, setProposals] = useState<ActivityProposal[]>([]);
  const [candidates, setCandidates] = useState<ProposalCandidate[]>([]);
  const [edits, setEdits] = useState<Record<string, ProposalEdit>>({});
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [savedRecipes, setSavedRecipes] = useState<Recipe[]>([]);
  const [recipeVersions, setRecipeVersions] = useState<RecipeVersion[]>([]);
  const [foodItems, setFoodItems] = useState<FoodItem[]>([]);
  const [recentBatches, setRecentBatches] = useState<FoodBatch[]>([]);
  const [subRecipeSelections, setSubRecipeSelections] = useState<
    Record<string, SubRecipeSelection[]>
  >({});
  const [subRecipeChoices, setSubRecipeChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const voice = useVoiceRecorder();

  useEffect(() => () => {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
  }, [photoPreview]);

  useEffect(() => {
    void (async () => {
      const [recipeResult, versionResult, foodResult, batchResult] = await Promise.all([
        supabase.from("recipes").select("*").is("archived_at", null).order("name"),
        supabase.from("recipe_versions").select("*").order("version_number", {ascending: false}),
        supabase.from("food_items").select("*").is("archived_at", null).order("canonical_name"),
        supabase
          .from("food_batches")
          .select("*")
          .is("exhausted_at", null)
          .order("prepared_at", {ascending: false})
          .limit(30),
      ]);
      const loadError = recipeResult.error || versionResult.error || foodResult.error
        || batchResult.error;
      if (loadError) {
        setError(loadError.message);
        return;
      }
      setSavedRecipes((recipeResult.data || []) as Recipe[]);
      setRecipeVersions((versionResult.data || []) as RecipeVersion[]);
      setFoodItems((foodResult.data || []) as FoodItem[]);
      setRecentBatches((batchResult.data || []) as FoodBatch[]);
    })();
  }, []);

  function reset() {
    if (capture && stage !== "saved") {
      void supabase
        .from("capture_sessions")
        .update({status: "discarded"})
        .eq("id", capture.id)
        .in("status", ["draft", "queued", "processing", "ready", "failed"]);
    }
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setStage("capture");
    setPhoto(null);
    setPhotoPreview(null);
    setTranscript("");
    setCapture(null);
    setProposals([]);
    setCandidates([]);
    setEdits({});
    setArtifactId(null);
    setSubRecipeSelections({});
    setSubRecipeChoices({});
    setError(null);
    setSuccess(null);
    setOccurred(localDatetimeValue());
    voice.clear();
  }

  async function stopAndTranscribe() {
    setBusy(true);
    setError(null);
    try {
      await voice.stop();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not stop recording.");
    } finally {
      setBusy(false);
    }
  }

  async function startRecording() {
    setError(null);
    try {
      await voice.start();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Microphone access was not available.");
    }
  }

  async function beginRecognition() {
    const audio = voice.audioFile;
    if (source === "photo" && !photo) {
      setError("Take or choose a meal photo first.");
      return;
    }
    if (source === "voice" && !audio && !transcript.trim()) {
      setError("Record a voice note or enter its transcript first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let confirmedTranscript = transcript.trim();
      if (source === "voice" && audio && !confirmedTranscript) {
        try {
          confirmedTranscript = await transcribeWithMoonshine(audio);
          setTranscript(confirmedTranscript);
        } catch {
          // The backend provider can transcribe the retained recording.
        }
      }
      const occurredAt = localDatetimeToIso(occurred);
      const {data: created, error: captureError} = await supabase
        .from("capture_sessions")
        .insert({
          user_id: session.user.id,
          profile_id: profile.id,
          source_type: source,
          occurred_at: occurredAt,
          recorded_timezone: profile.timezone,
          original_text: confirmedTranscript || null,
          transcript: confirmedTranscript || null,
          status: "draft",
          attributes: {},
        })
        .select()
        .single();
      if (captureError) throw captureError;
      const createdCapture = created as CaptureSession;
      const file = source === "photo" ? photo : audio;
      let uploadedArtifactId: string | null = null;
      if (file) {
        uploadedArtifactId = await uploadCaptureArtifact(
          session,
          createdCapture.id,
          file,
          source,
        );
        const {error: linkError} = await supabase
          .from("capture_sessions")
          .update({artifact_id: uploadedArtifactId})
          .eq("id", createdCapture.id);
        if (linkError) throw linkError;
      }
      setCapture({...createdCapture, artifact_id: uploadedArtifactId});
      setArtifactId(uploadedArtifactId);
      await apiPost("/v1/jobs/capture-extraction", session, {
        capture_session_id: createdCapture.id,
      });
      await pollForResults(createdCapture.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not analyze this capture.");
      setBusy(false);
    }
  }

  async function pollForResults(captureId: string) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const {data, error: loadError} = await supabase
        .from("capture_sessions")
        .select("*")
        .eq("id", captureId)
        .single();
      if (loadError) throw loadError;
      const current = data as CaptureSession;
      setCapture(current);
      if (current.status === "failed") {
        throw new Error(current.error || "The capture could not be analyzed.");
      }
      if (current.status === "ready") {
        const [proposalResult, candidateResult] = await Promise.all([
          supabase
            .from("activity_proposals")
            .select("*")
            .eq("capture_session_id", captureId)
            .order("proposal_order"),
          supabase
            .from("proposal_candidates")
            .select("*,activity_proposals!inner(capture_session_id)")
            .eq("activity_proposals.capture_session_id", captureId)
            .order("candidate_order"),
        ]);
        if (proposalResult.error) throw proposalResult.error;
        if (candidateResult.error) throw candidateResult.error;
        const loadedProposals = (proposalResult.data || []) as ActivityProposal[];
        const loadedCandidates = (candidateResult.data || []) as unknown as ProposalCandidate[];
        setProposals(loadedProposals);
        setCandidates(loadedCandidates);
        setEdits(Object.fromEntries(loadedProposals.map((proposal) => [
          proposal.id,
          {
            choice: "",
            label: proposal.personalized_guess.label || proposal.label || "",
            ingredients: guessIngredients(proposal, false).join("\n"),
            ingestionMethod: initialIngestionMethod(proposal),
            amount: "",
            unit: "",
            durationMinutes: "",
            prepared: false,
            touched: [],
            bodyArea: "both_hands",
            gloves: false,
            gloveMaterial: "",
            preparationMethod: "",
            contactNotes: "",
          },
        ])));
        setStage("matches");
        setBusy(false);
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    throw new Error("Analysis is taking longer than expected. You can retry from this screen.");
  }

  function chooseCandidate(proposal: ActivityProposal, candidate: ProposalCandidate) {
    setEdits((current) => ({
      ...current,
      [proposal.id]: {
        ...current[proposal.id],
        choice: candidate.id,
        label: candidate.snapshot.name || current[proposal.id].label,
        ingredients: (candidate.snapshot.ingredients || []).join("\n"),
      },
    }));
  }

  function chooseGeneric(proposal: ActivityProposal) {
    setEdits((current) => ({
      ...current,
      [proposal.id]: {
        ...current[proposal.id],
        choice: "generic",
        label: proposal.generic_guess.label || proposal.label || "",
        ingredients: guessIngredients(proposal, true).join("\n"),
      },
    }));
  }

  function chooseManual(proposal: ActivityProposal) {
    setEdits((current) => ({
      ...current,
      [proposal.id]: {
        ...current[proposal.id],
        choice: "manual",
        label: "",
        ingredients: "",
      },
    }));
  }

  async function resolveDish(proposal: ActivityProposal): Promise<ResolvedDish> {
    const edit = edits[proposal.id];
    const ingredientNames = parseIngredientNames(edit.ingredients);
    const selectedSubRecipes = subRecipeSelections[proposal.id] || [];
    const candidate = candidates.find(({id}) => id === edit.choice);
    if (candidate?.recipe_id && sameIngredients(
      ingredientNames,
      candidate.snapshot.ingredients || [],
    ) && selectedSubRecipes.length === 0) {
      return {
        recipe: {
          id: candidate.recipe_id,
          user_id: session.user.id,
          name: candidate.snapshot.name || edit.label,
          output_food_item_id: candidate.snapshot.output_food_item_id || "",
          derived_from_recipe_id: null,
          attributes: {},
          archived_at: null,
        },
        version: {
          id: candidate.snapshot.recipe_version_id || "",
          recipe_id: candidate.recipe_id,
          version_number: candidate.snapshot.recipe_version_number || 1,
          yield_amount: null,
          yield_unit: null,
          instructions: null,
          effective_to: null,
          review_state: "accepted",
        },
        ingredients: candidate.snapshot.ingredient_items || [],
      };
    }

    const isVariation = Boolean(candidate?.recipe_id);
    const requestedName = edit.label.trim()
      || (isVariation ? `${candidate?.snapshot.name || "Dish"} variation` : "Photographed dish");
    const recipeName = isVariation
      && requestedName.toLocaleLowerCase() === (candidate?.snapshot.name || "").toLocaleLowerCase()
      ? `${requestedName} variation`
      : requestedName;
    const {data, error: saveError} = await supabase.rpc("save_recipe_definition", {
      recipe_name: recipeName,
      components: [
        ...ingredientNames.map((name) => ({
          name,
          provenance: {
            method: capture?.source_type || "manual",
            capture_session_id: capture?.id,
            reviewed_by_user: true,
          },
        })),
        ...selectedSubRecipes.map((selection) => ({
          source_recipe_version_id: selection.recipeVersionId,
          provenance: {
            method: selection.source,
            capture_session_id: capture?.id,
            reviewed_by_user: true,
          },
        })),
      ],
      instructions: edit.preparationMethod || null,
      yield_amount: null,
      yield_unit: null,
      existing_recipe_id: null,
      derived_from_id: candidate?.recipe_id || null,
      recipe_attributes: {created_from_capture_session_id: capture?.id},
    });
    if (saveError) throw saveError;
    const recipe = (Array.isArray(data) ? data[0] : data) as Recipe;
    const {data: versionData, error: versionError} = await supabase
      .from("recipe_versions")
      .select("*")
      .eq("recipe_id", recipe.id)
      .is("effective_to", null)
      .order("version_number", {ascending: false})
      .limit(1)
      .single();
    if (versionError) throw versionError;
    const version = versionData as RecipeVersion;
    const {data: componentData, error: componentError} = await supabase
      .from("recipe_components")
      .select("component_food_item_id")
      .eq("recipe_version_id", version.id)
      .order("component_order");
    if (componentError) throw componentError;
    const foodIds = (componentData || []).map((row) => row.component_food_item_id as string);
    const {data: foods, error: foodError} = foodIds.length
      ? await supabase.from("food_items").select("id,canonical_name").in("id", foodIds)
      : {data: [], error: null};
    if (foodError) throw foodError;
    const nameById = new Map(
      (foods || []).map((food) => [food.id as string, food.canonical_name as string]),
    );
    return {
      recipe,
      version,
      ingredients: foodIds.map((id) => ({id, name: nameById.get(id) || "Ingredient"})),
    };
  }

  function addSubRecipe(proposalId: string) {
    const choice = subRecipeChoices[proposalId] || "";
    const [kind, id] = choice.split(":", 2);
    let selection: SubRecipeSelection | null = null;
    if (kind === "batch") {
      const batch = recentBatches.find((item) => item.id === id);
      const version = batch?.recipe_version_id
        ? recipeVersions.find((item) => item.id === batch.recipe_version_id)
        : null;
      const recipe = version ? savedRecipes.find((item) => item.id === version.recipe_id) : null;
      const food = batch ? foodItems.find((item) => item.id === batch.food_item_id) : null;
      if (batch && version && recipe) {
        selection = {
          key: `batch:${batch.id}`,
          name: food?.canonical_name || recipe.name,
          foodItemId: batch.food_item_id,
          recipeId: recipe.id,
          recipeVersionId: version.id,
          sourceFoodBatchId: batch.id,
          source: "recent_batch",
        };
      }
    } else if (kind === "recipe") {
      const version = recipeVersions.find((item) => item.id === id);
      const recipe = version ? savedRecipes.find((item) => item.id === version.recipe_id) : null;
      if (version && recipe) {
        selection = {
          key: `recipe:${version.id}`,
          name: recipe.name,
          foodItemId: recipe.output_food_item_id,
          recipeId: recipe.id,
          recipeVersionId: version.id,
          sourceFoodBatchId: null,
          source: "saved_recipe",
        };
      }
    }
    if (!selection) return;
    setSubRecipeSelections((current) => ({
      ...current,
      [proposalId]: [
        ...(current[proposalId] || []).filter(({key}) => key !== selection?.key),
        selection,
      ],
    }));
    setSubRecipeChoices((current) => ({...current, [proposalId]: ""}));
    if (selection.source === "recent_batch") {
      setEdits((current) => ({
        ...current,
        [proposalId]: {...current[proposalId], prepared: true},
      }));
    }
  }

  function addImportedFood(proposalId: string, imported: ImportedFoodFormulation) {
    const selection: SubRecipeSelection = {
      key: `label:${imported.recipeVersionId}`,
      name: imported.name,
      foodItemId: imported.foodItemId,
      recipeId: imported.recipeId,
      recipeVersionId: imported.recipeVersionId,
      sourceFoodBatchId: null,
      source: "food_label",
    };
    setSubRecipeSelections((current) => ({
      ...current,
      [proposalId]: [...(current[proposalId] || []), selection],
    }));
  }

  async function resolveConcept(
    proposal: ActivityProposal,
  ): Promise<{id: string; versionId: string | null} | null> {
    const edit = edits[proposal.id];
    const candidate = candidates.find(({id}) => id === edit.choice);
    if (candidate?.concept_id) {
      return {
        id: candidate.concept_id,
        versionId: candidate.snapshot.concept_version_id || null,
      };
    }
    const itemType = {
      product_use: "product",
      topical_treatment: "treatment",
      medication: "medication",
    }[proposal.activity_type];
    if (!itemType) return null;
    const {data, error: saveError} = await supabase.rpc("save_catalogue_item", {
      item_type: itemType,
      item_name: edit.label.trim(),
      item_attributes: {
        ...(proposal.personalized_guess.attributes || {}),
        created_from_capture_session_id: capture?.id,
      },
      ingredients: [],
      catalogue_item_id: null,
      derived_from_id: null,
    });
    if (saveError) throw saveError;
    const concept = (Array.isArray(data) ? data[0] : data) as {id: string};
    const {data: versionData, error: versionError} = await supabase
      .from("concept_versions")
      .select("id")
      .eq("concept_id", concept.id)
      .is("effective_to", null)
      .order("version_number", {ascending: false})
      .limit(1)
      .single();
    if (versionError) throw versionError;
    return {id: concept.id, versionId: versionData.id as string};
  }

  async function saveConfirmedActivities() {
    if (!capture) return;
    setBusy(true);
    setError(null);
    try {
      const activities: Array<Record<string, unknown>> = [];
      for (const proposal of proposals) {
        const edit = edits[proposal.id];
        if (!edit || !edit.choice || !edit.label.trim()) continue;
        if (proposal.activity_type !== "meal") {
          const concept = await resolveConcept(proposal);
          const role = {
            skin_contact: "contacted",
            product_use: "used",
            topical_treatment: "applied",
            medication: "taken",
            activity: "performed",
          }[proposal.activity_type] || "present";
          const bodyContact = ["skin_contact", "product_use", "topical_treatment"]
            .includes(proposal.activity_type);
          const medicationRoute = edit.ingestionMethod === "swallowed"
            ? "oral"
            : edit.ingestionMethod;
          activities.push({
            type_code: proposal.activity_type,
            label: edit.label.trim(),
            source_method: source,
            attributes: {
              ...(proposal.personalized_guess.attributes || {}),
              capture_reviewed: true,
              duration_minutes: edit.durationMinutes ? Number(edit.durationMinutes) : undefined,
            },
            participants: concept ? [{
              concept_id: concept.id,
              concept_version_id: concept.versionId,
              role,
              amount: edit.amount ? Number(edit.amount) : null,
              unit: edit.unit.trim() || null,
              body_area_code: bodyContact ? edit.bodyArea : null,
              duration_seconds: edit.durationMinutes
                ? Math.round(Number(edit.durationMinutes) * 60)
                : null,
              ingestion_method: proposal.activity_type === "medication"
                ? edit.ingestionMethod
                : null,
              route: proposal.activity_type === "medication" ? medicationRoute : null,
              provenance: {method: `${source}_capture_confirmation`},
            }] : [],
          });
          continue;
        }

        const dish = await resolveDish(proposal);
        const selectedBatches = (subRecipeSelections[proposal.id] || [])
          .filter((selection): selection is SubRecipeSelection & {sourceFoodBatchId: string} =>
            Boolean(selection.sourceFoodBatchId),
          );
        const mealOrder = activities.length + 1;
        activities.push({
          type_code: "meal",
          label: dish.recipe.name,
          source_method: source,
          attributes: {
            prepared_by_user: edit.prepared,
            capture_reviewed: true,
          },
          participants: [{
            food_item_id: dish.recipe.output_food_item_id,
            recipe_version_id: dish.version.id,
            role: "consumed",
            ingestion_method: edit.ingestionMethod,
            route: "oral",
            provenance: {
              method: `${source}_capture_confirmation`,
              recipe_id: dish.recipe.id,
              recipe_version: dish.version.version_number,
            },
          }],
        });
        if (edit.prepared || selectedBatches.length > 0) {
          const touched = new Set(normalizedSet(edit.touched));
          activities.push({
            type_code: "meal_preparation",
            label: `${dish.recipe.name} preparation`,
            source_method: source,
            parent_order: mealOrder,
            relation_type: "prepared_by",
            attributes: {
              preparation_method: edit.preparationMethod,
              skin_contact_description: edit.contactNotes,
              gloves_used: edit.gloves,
              glove_material: edit.gloves ? edit.gloveMaterial : null,
            },
            participants: [
              {
                food_item_id: dish.recipe.output_food_item_id,
                recipe_version_id: dish.version.id,
                role: "prepared",
                provenance: {method: "user_confirmed_preparation"},
              },
              ...selectedBatches.map((selection) => ({
                food_batch_id: selection.sourceFoodBatchId,
                role: "used",
                provenance: {
                  method: "user_selected_leftover_batch",
                  source_recipe_version_id: selection.recipeVersionId,
                },
              })),
              ...dish.ingredients
                .filter(({name}) => touched.has(name.trim().toLocaleLowerCase()))
                .map((ingredient) => ({
                  food_item_id: ingredient.id,
                  role: "contacted",
                  body_area_code: edit.bodyArea,
                  gloves_used: edit.gloves,
                  glove_material: edit.gloves ? edit.gloveMaterial : null,
                  direct_contact: edit.gloves ? "no" : "yes",
                  provenance: {method: "user_selected_ingredient_contact"},
                })),
            ],
          });
        }
      }
      if (activities.length === 0) {
        throw new Error("Choose or enter at least one activity before saving.");
      }
      const {data, error: logError} = await supabase.rpc("log_activity_bundle", {
        target_profile_id: profile.id,
        occurred_at: capture.occurred_at,
        timezone: capture.recorded_timezone,
        capture_id: capture.id,
        activities,
      });
      if (logError) throw logError;
      const eventIds = ((data as {event_ids?: string[]})?.event_ids || []);
      if (artifactId && eventIds[0]) {
        const {error: artifactError} = await supabase.from("record_artifacts").insert({
          user_id: session.user.id,
          event_id: eventIds[0],
          artifact_id: artifactId,
          role: source === "photo" ? "meal_photo" : "voice_note",
          display_order: 0,
        });
        if (artifactError) throw artifactError;
      }
      setSuccess(`Saved ${activities.length} confirmed activit${activities.length === 1 ? "y" : "ies"}.`);
      setStage("saved");
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the confirmed capture.");
    } finally {
      setBusy(false);
    }
  }

  const mealProposals = proposals.filter(({activity_type}) => activity_type === "meal");

  if (!profile.ai_enabled) {
    return (
      <section className="card smart-capture">
        <span className="eyebrow">Guided capture</span>
        <h2>Photo and voice matching is off</h2>
        <p className="field-help">
          Enable AI-assisted organization in Settings to use private recipe matching.
          The detailed manual form below remains available.
        </p>
      </section>
    );
  }

  return (
    <section className="card smart-capture">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Guided capture</span>
          <h2>Photo or voice</h2>
        </div>
        {stage !== "capture" && <button className="secondary small" onClick={reset}>Start over</button>}
      </div>
      <p className="field-help">
        Pajara suggests; you choose. Nothing becomes trusted history until the final review.
      </p>
      <StatusMessage error={error} success={success} />

      {stage === "capture" && (
        <div className="stack">
          <div className="form-grid activity-time-row">
            <label>
              When did it happen?
              <input
                type="datetime-local"
                value={occurred}
                onChange={(event) => setOccurred(event.target.value)}
                required
              />
            </label>
            <button type="button" className="secondary small" onClick={() => setOccurred(localDatetimeValue())}>
              Set to now
            </button>
          </div>
          <div className="segmented" role="group" aria-label="Capture method">
            <button disabled={voice.recording || busy} className={source === "photo" ? "active" : ""} onClick={() => setSource("photo")}>Photo</button>
            <button disabled={voice.recording || busy} className={source === "voice" ? "active" : ""} onClick={() => setSource("voice")}>Voice</button>
          </div>
          {source === "photo" ? (
            <label className="upload-zone capture-hero">
              <strong>Take a meal photo</strong>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(event) => {
                  const next = event.target.files?.[0] || null;
                  if (photoPreview) URL.revokeObjectURL(photoPreview);
                  setPhoto(next);
                  setPhotoPreview(next ? URL.createObjectURL(next) : null);
                }}
              />
              {photoPreview
                ? <img className="capture-preview" src={photoPreview} alt="Meal to identify" />
                : <span>Photograph the whole meal when possible.</span>}
            </label>
          ) : (
            <div className="subcard stack">
              <div className="voice-actions">
                {!voice.recording
                  ? <button className="secondary" onClick={() => void startRecording()}>Record activities</button>
                  : <button className="secondary danger" onClick={() => void stopAndTranscribe()}>Stop recording</button>}
                {voice.audioFile && <span className="status-pill">Recording ready</span>}
              </div>
              <label>
                Review or enter the transcript
                <textarea
                  rows={4}
                  value={transcript}
                  onChange={(event) => setTranscript(event.target.value)}
                  placeholder="I ate pasta, went running, showered, and applied hand cream…"
                />
              </label>
            </div>
          )}
          <button className="primary" disabled={busy || voice.recording} onClick={() => void beginRecognition()}>
            {busy ? "Finding possibilities…" : "Find possibilities"}
          </button>
        </div>
      )}

      {stage === "matches" && (
        <div className="stack capture-review">
          {photoPreview && <img className="capture-review-photo" src={photoPreview} alt="Captured meal" />}
          <div><span className="eyebrow">Step 1</span><h3>Choose the closest match</h3></div>
          {proposals.map((proposal) => {
            const proposalCandidates = candidates.filter(
              ({activity_proposal_id}) => activity_proposal_id === proposal.id,
            );
            const edit = edits[proposal.id];
            return (
              <article className="subcard proposal-card" key={proposal.id}>
                <span className="status-pill">{proposal.activity_type.replaceAll("_", " ")}</span>
                <h3>{proposal.personalized_guess.label || proposal.label}</h3>
                {proposalCandidates[0] && (
                  <button
                    className={`candidate-card top ${edit?.choice === proposalCandidates[0].id ? "selected" : ""}`}
                    onClick={() => chooseCandidate(proposal, proposalCandidates[0])}
                  >
                    <span className="eyebrow">Best saved match</span>
                    <strong>{proposalCandidates[0].snapshot.name}</strong>
                    <span>{proposalCandidates[0].explanation}</span>
                    <small>{Math.round(proposalCandidates[0].score * 100)}% retrieval score</small>
                  </button>
                )}
                {proposalCandidates.length > 1 && (
                  <details>
                    <summary>Other saved matches ({proposalCandidates.length - 1})</summary>
                    <div className="candidate-list">
                      {proposalCandidates.slice(1).map((candidate) => (
                        <button
                          className={`candidate-card ${edit?.choice === candidate.id ? "selected" : ""}`}
                          key={candidate.id}
                          onClick={() => chooseCandidate(proposal, candidate)}
                        >
                          <strong>{candidate.snapshot.name}</strong>
                          <span>{candidate.explanation}</span>
                        </button>
                      ))}
                    </div>
                  </details>
                )}
                <div className="choice-actions">
                  <button className={edit?.choice === "generic" ? "secondary active" : "secondary"} onClick={() => chooseGeneric(proposal)}>
                    None of these — use fresh guess
                  </button>
                  <button className={edit?.choice === "manual" ? "secondary active" : "secondary"} onClick={() => chooseManual(proposal)}>
                    Enter manually
                  </button>
                </div>
              </article>
            );
          })}
          <button
            className="primary"
            disabled={proposals.some((proposal) => !edits[proposal.id]?.choice)}
            onClick={() => setStage("ingredients")}
          >
            Review details
          </button>
        </div>
      )}

      {stage === "ingredients" && (
        <div className="stack capture-review">
          <div><span className="eyebrow">Step 2</span><h3>Confirm what it was</h3></div>
          {proposals.map((proposal) => {
            const edit = edits[proposal.id];
            if (!edit) return null;
            return (
              <article className="subcard stack" key={proposal.id}>
                <label>
                  {proposal.activity_type === "meal" ? "Dish name" : "Activity"}
                  <input value={edit.label} onChange={(event) => setEdits((current) => ({
                    ...current,
                    [proposal.id]: {...edit, label: event.target.value},
                  }))} />
                </label>
                {proposal.activity_type === "meal" && (
                  <>
                    <label>
                      Confirmed ingredients
                      <textarea rows={7} value={edit.ingredients} onChange={(event) => setEdits((current) => ({
                        ...current,
                        [proposal.id]: {...edit, ingredients: event.target.value},
                      }))} placeholder="One ingredient per line" />
                      <span className="field-help">
                        Add missing ingredients and remove incorrect guesses. Only this reviewed list is saved.
                      </span>
                    </label>
                    <div className="subcard stack">
                      <div>
                        <strong>Add a sub-recipe or leftovers</strong>
                        <p className="field-help">
                          Recent cooked batches are listed first. Remove any flat ingredient line that this component replaces.
                        </p>
                      </div>
                      <div className="form-grid">
                        <label>
                          Existing component
                          <select value={subRecipeChoices[proposal.id] || ""} onChange={(event) => setSubRecipeChoices((current) => ({...current, [proposal.id]: event.target.value}))}>
                            <option value="">Choose one…</option>
                            {recentBatches.some(({recipe_version_id}) => recipe_version_id) && (
                              <optgroup label="Recently cooked / leftovers">
                                {recentBatches.filter(({recipe_version_id}) => recipe_version_id).map((batch) => {
                                  const foodName = foodItems.find(({id}) => id === batch.food_item_id)?.canonical_name || "Prepared food";
                                  return <option value={`batch:${batch.id}`} key={batch.id}>{foodName} · {new Date(batch.prepared_at).toLocaleString()}</option>;
                                })}
                              </optgroup>
                            )}
                            <optgroup label="Saved recipe versions">
                              {recipeVersions.filter(({effective_to}) => effective_to === null).map((version) => {
                                const recipe = savedRecipes.find(({id}) => id === version.recipe_id);
                                return recipe ? <option value={`recipe:${version.id}`} key={version.id}>{recipe.name} · v{version.version_number}</option> : null;
                              })}
                            </optgroup>
                          </select>
                        </label>
                        <button type="button" className="secondary" disabled={!subRecipeChoices[proposal.id]} onClick={() => addSubRecipe(proposal.id)}>Add selected</button>
                      </div>
                      {(subRecipeSelections[proposal.id] || []).map((selection) => (
                        <div className="button-row" key={selection.key}>
                          <span className="status-pill">
                            {selection.source === "recent_batch" ? "Leftovers" : selection.source === "food_label" ? "Packaged" : "Recipe"}: {selection.name}
                          </span>
                          <button type="button" className="text-button" onClick={() => setSubRecipeSelections((current) => ({
                            ...current,
                            [proposal.id]: (current[proposal.id] || []).filter(({key}) => key !== selection.key),
                          }))}>Remove</button>
                        </div>
                      ))}
                      <FoodLabelImporter
                        session={session}
                        parentCaptureId={capture?.id}
                        onImported={(imported) => addImportedFood(proposal.id, imported)}
                      />
                    </div>
                  </>
                )}
              </article>
            );
          })}
          <div className="wizard-actions">
            <button className="secondary" onClick={() => setStage("matches")}>Back to matches</button>
            <button
              className="primary"
              disabled={proposals.some((proposal) => !edits[proposal.id]?.label.trim())}
              onClick={() => setStage("preparation")}
            >
              Confirm details
            </button>
          </div>
        </div>
      )}

      {stage === "preparation" && (
        <div className="stack capture-review">
          <div><span className="eyebrow">Step 3</span><h3>Ingestion and preparation</h3></div>
          {mealProposals.map((proposal) => {
            const edit = edits[proposal.id];
            const ingredients = parseIngredientNames(edit.ingredients);
            return (
              <article className="subcard stack" key={proposal.id}>
                <h3>{edit.label}</h3>
                <label>
                  How was it ingested?
                  <select value={edit.ingestionMethod} onChange={(event) => setEdits((current) => ({
                    ...current,
                    [proposal.id]: {
                      ...edit,
                      ingestionMethod: event.target.value as ProposalEdit["ingestionMethod"],
                    },
                  }))}>
                    <option value="eaten">Eaten</option>
                    <option value="drank">Drunk</option>
                    <option value="swallowed">Swallowed</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label className="check-row">
                  <input type="checkbox" checked={edit.prepared} onChange={(event) => setEdits((current) => ({
                    ...current,
                    [proposal.id]: {...edit, prepared: event.target.checked},
                  }))} />
                  <span>I prepared this meal</span>
                </label>
                {edit.prepared && (
                  <div className="stack contact-picker">
                    <strong>Which ingredients actually touched your skin?</strong>
                    <div className="ingredient-check-grid">
                      {ingredients.map((ingredient) => (
                        <label className="check-row compact" key={ingredient}>
                          <input
                            type="checkbox"
                            checked={edit.touched.includes(ingredient)}
                            onChange={(event) => {
                              const touched = event.target.checked
                                ? [...edit.touched, ingredient]
                                : edit.touched.filter((value) => value !== ingredient);
                              setEdits((current) => ({...current, [proposal.id]: {...edit, touched}}));
                            }}
                          />
                          <span>{ingredient}</span>
                        </label>
                      ))}
                    </div>
                    <label>
                      Preparation method
                      <textarea rows={3} value={edit.preparationMethod} onChange={(event) => setEdits((current) => ({
                        ...current,
                        [proposal.id]: {...edit, preparationMethod: event.target.value},
                      }))} placeholder="Chopped, mixed, baked…" />
                    </label>
                    <div className="form-grid">
                      <label>
                        Contact body area
                        <select value={edit.bodyArea} onChange={(event) => setEdits((current) => ({
                          ...current,
                          [proposal.id]: {...edit, bodyArea: event.target.value},
                        }))}>
                          {bodyAreas.map((area) => <option value={area.code} key={area.code}>{area.label}</option>)}
                        </select>
                      </label>
                      <label className="check-row compact">
                        <input type="checkbox" checked={edit.gloves} onChange={(event) => setEdits((current) => ({
                          ...current,
                          [proposal.id]: {...edit, gloves: event.target.checked},
                        }))} />
                        <span>Wore gloves</span>
                      </label>
                    </div>
                    {edit.gloves && <label>Glove material<input value={edit.gloveMaterial} onChange={(event) => setEdits((current) => ({
                      ...current,
                      [proposal.id]: {...edit, gloveMaterial: event.target.value},
                    }))} placeholder="Nitrile, latex…" /></label>}
                    <label>
                      Contact notes
                      <textarea rows={2} value={edit.contactNotes} onChange={(event) => setEdits((current) => ({
                        ...current,
                        [proposal.id]: {...edit, contactNotes: event.target.value},
                      }))} />
                    </label>
                  </div>
                )}
              </article>
            );
          })}
          {mealProposals.length === 0 && (
            <p className="field-help">No meal was proposed; review any activity-specific details below.</p>
          )}
          {proposals.filter(({activity_type}) => activity_type !== "meal").map((proposal) => {
            const edit = edits[proposal.id];
            const bodyContact = ["skin_contact", "product_use", "topical_treatment"]
              .includes(proposal.activity_type);
            return (
              <article className="subcard stack" key={proposal.id}>
                <h3>{edit.label}</h3>
                {proposal.activity_type === "medication" && (
                  <>
                    <div className="form-grid">
                      <label>Amount<input type="number" min="0" step="any" value={edit.amount} onChange={(event) => setEdits((current) => ({...current, [proposal.id]: {...edit, amount: event.target.value}}))} /></label>
                      <label>Unit<input value={edit.unit} onChange={(event) => setEdits((current) => ({...current, [proposal.id]: {...edit, unit: event.target.value}}))} placeholder="tablet, mg, ml…" /></label>
                    </div>
                    <label>
                      How was it taken?
                      <select value={edit.ingestionMethod} onChange={(event) => setEdits((current) => ({
                        ...current,
                        [proposal.id]: {...edit, ingestionMethod: event.target.value as ProposalEdit["ingestionMethod"]},
                      }))}>
                        <option value="swallowed">Swallowed</option>
                        <option value="sublingual">Under the tongue</option>
                        <option value="inhaled">Inhaled</option>
                        <option value="other">Other</option>
                      </select>
                    </label>
                  </>
                )}
                {bodyContact && (
                  <label>
                    Body area
                    <select value={edit.bodyArea} onChange={(event) => setEdits((current) => ({...current, [proposal.id]: {...edit, bodyArea: event.target.value}}))}>
                      {bodyAreas.map((area) => <option value={area.code} key={area.code}>{area.label}</option>)}
                    </select>
                  </label>
                )}
                {proposal.activity_type === "activity" && (
                  <label>
                    Duration in minutes
                    <input type="number" min="0" step="1" value={edit.durationMinutes} onChange={(event) => setEdits((current) => ({...current, [proposal.id]: {...edit, durationMinutes: event.target.value}}))} />
                  </label>
                )}
              </article>
            );
          })}
          <div className="wizard-actions">
            <button className="secondary" onClick={() => setStage("ingredients")}>Back</button>
            <button className="primary" disabled={busy} onClick={() => void saveConfirmedActivities()}>
              {busy ? "Saving confirmed history…" : "Save confirmed activities"}
            </button>
          </div>
        </div>
      )}

      {stage === "saved" && (
        <div className="capture-complete">
          <span className="complete-mark" aria-hidden="true">✓</span>
          <h3>Added to your timeline</h3>
          <p>The original capture, your choices, ingestion, and any preparation contact are linked.</p>
          <button className="primary" onClick={reset}>Log another</button>
        </div>
      )}
    </section>
  );
}
