import {useEffect, useState, type FormEvent} from "react";
import type {Session} from "@supabase/supabase-js";
import {useVoiceRecorder} from "../hooks/useVoiceRecorder";
import {apiPost} from "../lib/api";
import {uploadArtifact} from "../lib/artifacts";
import {localDatetimeToIso, localDatetimeValue} from "../lib/datetime";
import {sortCatalogueItems} from "../lib/catalogue";
import {
  buildMealPreparationSourceText,
  suggestRecipeName,
} from "../lib/mealPreparation";
import {transcribeWithMoonshine} from "../lib/moonshine";
import {
  buildVoiceTranscriptionProvenance,
  moonshineConfig,
} from "../lib/voiceTranscription";
import {supabase} from "../lib/supabase";
import type {
  BodyArea,
  CatalogueItem,
  ConceptVersion,
  Profile,
  Recipe,
  RecipeVersion,
} from "../types";
import {ConversationalQuickLog} from "./ConversationalQuickLog";
import {SaveMealAsRecipe} from "./SaveMealAsRecipe";
import {StatusMessage} from "./StatusMessage";

const types = [
  ["meal", "Meal"],
  ["skin_contact", "Skin contact"],
  ["product_use", "Product use"],
  ["topical_treatment", "Cream / topical treatment"],
  ["medication", "Medication"],
  ["activity", "Activity"],
  ["note", "Note"],
] as const;

const activityTypes = [
  ["shower", "Shower"],
  ["bath", "Bath"],
  ["washing_up", "Washing up"],
  ["exercise", "Exercise"],
  ["sweating", "Sweating"],
  ["swimming", "Swimming"],
  ["other", "Other activity"],
] as const;

interface RecipeDraft {
  mealEventId: string;
  name: string;
  method: string;
  contact: string;
}

export function QuickLogForm({
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
  const [type, setType] = useState<string>("meal");
  const [occurred, setOccurred] = useState(localDatetimeValue());
  const [text, setText] = useState("");
  const [prepared, setPrepared] = useState(false);
  const [preparationMethod, setPreparationMethod] = useState("");
  const [handled, setHandled] = useState("");
  const [bodyArea, setBodyArea] = useState("both_hands");
  const [gloves, setGloves] = useState(false);
  const [gloveMaterial, setGloveMaterial] = useState("");
  const [selectedConceptId, setSelectedConceptId] = useState("");
  const [activityConceptIds, setActivityConceptIds] = useState<string[]>([]);
  const [activityProductAreas, setActivityProductAreas] = useState<Record<string, string>>({});
  const [catalogueItems, setCatalogueItems] = useState<CatalogueItem[]>([]);
  const [conceptVersions, setConceptVersions] = useState<ConceptVersion[]>([]);
  const [mealRecipes, setMealRecipes] = useState<Recipe[]>([]);
  const [mealRecipeVersions, setMealRecipeVersions] = useState<RecipeVersion[]>([]);
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState("");
  const [route, setRoute] = useState("");
  const [ingestionMethod, setIngestionMethod] = useState<
    "eaten" | "drank" | "swallowed" | "sublingual" | "inhaled" | "other"
  >("eaten");
  const [activityType, setActivityType] = useState("shower");
  const [durationMinutes, setDurationMinutes] = useState("");
  const [waterTemperature, setWaterTemperature] = useState("unknown");
  const [directContact, setDirectContact] = useState<"yes" | "no" | "unknown">("unknown");
  const [requestAi, setRequestAi] = useState(profile.ai_enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [recipeDraft, setRecipeDraft] = useState<RecipeDraft | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<
    "idle" | "loading" | "transcribing" | "ready" | "error"
  >("idle");
  const [machineTranscript, setMachineTranscript] = useState<string | null>(null);
  const [transcriptConfirmed, setTranscriptConfirmed] = useState(false);
  const [transcriptConfirmedAt, setTranscriptConfirmedAt] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [useBackendFallback, setUseBackendFallback] = useState(false);
  const [textBeforeVoice, setTextBeforeVoice] = useState("");
  const voice = useVoiceRecorder();

  useEffect(() => {
    void Promise.all([
      supabase
        .from("concepts")
        .select("*")
        .in("concept_type", ["product", "medication", "treatment", "recipe"])
        .is("archived_at", null)
        .order("canonical_name"),
      supabase
        .from("concept_versions")
        .select("*")
        .is("effective_to", null)
        .order("version_number", {ascending: false}),
      supabase.from("recipes").select("*").is("archived_at", null).order("name"),
      supabase
        .from("recipe_versions")
        .select("*")
        .is("effective_to", null)
        .order("version_number", {ascending: false}),
    ]).then(([itemsResult, versionsResult, recipesResult, recipeVersionsResult]) => {
      setCatalogueItems((itemsResult.data || []) as CatalogueItem[]);
      setConceptVersions((versionsResult.data || []) as ConceptVersion[]);
      setMealRecipes((recipesResult.data || []) as Recipe[]);
      setMealRecipeVersions((recipeVersionsResult.data || []) as RecipeVersion[]);
    });
  }, []);

  useEffect(() => {
    if (!voice.audioFile) return;
    let cancelled = false;
    setVoiceStatus("loading");
    setMachineTranscript(null);
    setTranscriptConfirmed(false);
    setTranscriptConfirmedAt(null);
    setVoiceError(null);
    setUseBackendFallback(false);

    void transcribeWithMoonshine(voice.audioFile)
      .then((transcript) => {
        if (cancelled) return;
        setMachineTranscript(transcript);
        setText((current) => current.trim() ? `${current.trim()}\n${transcript}` : transcript);
        setVoiceStatus("ready");
      })
      .catch((caught) => {
        if (cancelled) return;
        setVoiceError(
          caught instanceof Error ? caught.message : "Local transcription failed.",
        );
        setVoiceStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [voice.audioFile]);

  async function startVoice() {
    setError(null);
    setTextBeforeVoice(text);
    setVoiceStatus("idle");
    setMachineTranscript(null);
    setTranscriptConfirmed(false);
    setTranscriptConfirmedAt(null);
    setVoiceError(null);
    setUseBackendFallback(false);
    try {
      await voice.start();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `Microphone access failed: ${caught.message}`
          : "Microphone access failed.",
      );
    }
  }

  function discardVoice() {
    setText(textBeforeVoice);
    voice.clear();
    setVoiceStatus("idle");
    setMachineTranscript(null);
    setTranscriptConfirmed(false);
    setTranscriptConfirmedAt(null);
    setVoiceError(null);
    setUseBackendFallback(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const now = localDatetimeToIso(occurred);
      const selectedItems =
        type === "activity"
          ? catalogueItems.filter((item) => activityConceptIds.includes(item.id))
          : type === "meal"
            ? []
            : catalogueItems.filter((item) => item.id === selectedConceptId);
      const selectedItem = selectedItems[0];
      const selectedRecipe = type === "meal"
        ? mealRecipes.find((recipe) => recipe.id === selectedConceptId)
        : undefined;
      const selectedRecipeVersion = selectedRecipe
        ? mealRecipeVersions.find((version) => version.recipe_id === selectedRecipe.id)
        : undefined;
      const preparationSourceText =
        type === "meal" && prepared
          ? buildMealPreparationSourceText({
              method: preparationMethod,
              contact: handled,
              notes: text,
            })
          : "";
      const shouldExtract = requestAi && Boolean(
        text.trim() || voice.audioFile || preparationSourceText,
      );
      const voiceTranscription = voice.audioFile
        ? buildVoiceTranscriptionProvenance({
            machineTranscript,
            confirmedText: text,
            confirmedAt: transcriptConfirmedAt,
            fallbackRequested: useBackendFallback,
            localError: voiceError,
          })
        : undefined;
      const {data: mainEvent, error: eventError} = await supabase
        .from("events")
        .insert({
          user_id: session.user.id,
          profile_id: profile.id,
          type_code: type,
          occurred_start: now,
          recorded_timezone: profile.timezone,
          label:
            (type === "activity"
              ? activityTypes.find(([value]) => value === activityType)?.[1]
              : selectedRecipe?.name || selectedItem?.canonical_name || null),
          attributes: {
            original_text: text,
            prepared_by_user: type === "meal" ? prepared : undefined,
            activity_code: type === "activity" ? activityType : undefined,
            duration_minutes:
              type === "activity" && durationMinutes ? Number(durationMinutes) : undefined,
            water_temperature:
              type === "activity"
              && ["shower", "bath", "washing_up"].includes(activityType)
                ? waterTemperature
                : undefined,
            gloves_used:
              type === "activity" && activityType === "washing_up" ? gloves : undefined,
            glove_material:
              type === "activity" && activityType === "washing_up"
                ? gloveMaterial
                : undefined,
            direct_contact:
              type === "activity" && activityType === "washing_up"
                ? directContact
                : undefined,
            voice_transcription: voiceTranscription,
            ingestion_method: ["meal", "medication"].includes(type)
              ? ingestionMethod
              : undefined,
          },
          trust_status: shouldExtract && !(type === "meal" && prepared) ? "draft" : "trusted",
          source_method: voice.audioFile ? "voice" : text.trim() ? "text" : "manual",
        })
        .select()
        .single();
      if (eventError) throw eventError;
      const recipeOffer =
        type === "meal" && !selectedItem && !selectedRecipe
          ? {
              mealEventId: mainEvent.id as string,
              name: suggestRecipeName(text),
              method: prepared ? preparationMethod : "",
              contact: prepared ? handled : "",
            }
          : null;

      for (const linkedItem of selectedItems) {
        const selectedVersion = conceptVersions.find(
          (version) => version.concept_id === linkedItem.id,
        );
        const role = {
          meal: "consumed",
          skin_contact: "contacted",
          product_use: "used",
          topical_treatment: "applied",
          medication: "taken",
          activity: activityType === "washing_up" ? "contacted" : "used",
        }[type] || "present";
        const {error: conceptError} = await supabase.from("event_concepts").insert({
          user_id: session.user.id,
          event_id: mainEvent.id,
          concept_id: linkedItem.id,
          concept_version_id: selectedVersion?.id || null,
          role,
          amount: amount ? Number(amount) : null,
          unit: unit.trim() || null,
          body_area_code:
            type === "activity"
              ? activityProductAreas[linkedItem.id] || null
              : ["skin_contact", "topical_treatment"].includes(type)
                ? bodyArea
                : null,
          duration_seconds: durationMinutes ? Math.round(Number(durationMinutes) * 60) : null,
          route: route.trim() || null,
          gloves_used:
            type === "activity" && activityType === "washing_up" ? gloves : null,
          glove_material:
            type === "activity" && activityType === "washing_up"
              ? gloveMaterial.trim() || null
              : null,
          direct_contact:
            type === "activity" && activityType === "washing_up" ? directContact : null,
          ingestion_method: type === "medication" ? ingestionMethod : null,
          confidence: 1,
          review_state: "accepted",
          provenance: {
            method: "manual_catalogue_selection",
            concept_version: selectedVersion?.version_number || null,
          },
        });
        if (conceptError) throw conceptError;
        const {error: recentError} = await supabase
          .from("concepts")
          .update({
            attributes: {...linkedItem.attributes, last_used_at: now},
          })
          .eq("id", linkedItem.id);
        if (recentError) throw recentError;
      }

      if (selectedRecipe && selectedRecipeVersion) {
        const {error: recipeLinkError} = await supabase.from("event_concepts").insert({
          user_id: session.user.id,
          event_id: mainEvent.id,
          concept_id: null,
          food_item_id: selectedRecipe.output_food_item_id,
          recipe_version_id: selectedRecipeVersion.id,
          role: "consumed",
          route: ingestionMethod === "eaten" || ingestionMethod === "drank"
            || ingestionMethod === "swallowed" ? "oral" : ingestionMethod,
          ingestion_method: ingestionMethod,
          confidence: 1,
          review_state: "accepted",
          provenance: {
            method: "manual_recipe_selection",
            recipe_id: selectedRecipe.id,
            recipe_version: selectedRecipeVersion.version_number,
          },
        });
        if (recipeLinkError) throw recipeLinkError;
        const {error: recipeRecentError} = await supabase
          .from("recipes")
          .update({
            attributes: {...selectedRecipe.attributes, last_used_at: now},
          })
          .eq("id", selectedRecipe.id);
        if (recipeRecentError) throw recipeRecentError;
      }

      let extractionTarget = mainEvent.id as string;
      if (type === "meal" && prepared) {
        const {data: prepEvent, error: prepError} = await supabase
          .from("events")
          .insert({
            user_id: session.user.id,
            profile_id: profile.id,
            type_code: "meal_preparation",
            occurred_start: now,
            recorded_timezone: profile.timezone,
            label: selectedRecipe
              ? `${selectedRecipe.name} preparation`
              : selectedItem
                ? `${selectedItem.canonical_name} preparation`
                : "Meal preparation",
            attributes: {
              original_text: preparationSourceText,
              prepared_by_user: true,
              preparation_method: preparationMethod,
              handled_ingredients_text: handled,
              skin_contact_description: handled,
              contact_body_area: bodyArea,
              gloves_used: gloves,
              glove_material: gloves ? gloveMaterial.trim() || null : null,
              voice_transcription: voiceTranscription,
            },
            trust_status: shouldExtract ? "draft" : "trusted",
            source_method: voice.audioFile ? "voice" : text.trim() ? "text" : "manual",
          })
          .select()
          .single();
        if (prepError) throw prepError;
        const {error: relationError} = await supabase.from("event_relations").insert({
          user_id: session.user.id,
          from_event_id: mainEvent.id,
          to_event_id: prepEvent.id,
          relation_type: "prepared_by",
          attributes: {},
        });
        if (relationError) throw relationError;
        if (selectedRecipe && selectedRecipeVersion) {
          const {error: preparedLinkError} = await supabase.from("event_concepts").insert({
            user_id: session.user.id,
            event_id: prepEvent.id,
            food_item_id: selectedRecipe.output_food_item_id,
            recipe_version_id: selectedRecipeVersion.id,
            role: "prepared",
            confidence: 1,
            review_state: "accepted",
            provenance: {
              method: "manual_recipe_preparation_confirmation",
              recipe_id: selectedRecipe.id,
              recipe_version: selectedRecipeVersion.version_number,
            },
          });
          if (preparedLinkError) throw preparedLinkError;
          const {error: batchError} = await supabase.from("food_batches").insert({
            user_id: session.user.id,
            food_item_id: selectedRecipe.output_food_item_id,
            recipe_version_id: selectedRecipeVersion.id,
            produced_by_event_id: prepEvent.id,
            amount: selectedRecipeVersion.yield_amount,
            remaining_amount: null,
            unit: selectedRecipeVersion.yield_unit,
            prepared_at: now,
            attributes: {availability: "unknown", source_method: "manual"},
          });
          if (batchError) throw batchError;
        }
        extractionTarget = prepEvent.id as string;
      }

      let artifactId: string | undefined;
      if (voice.audioFile) {
        artifactId = await uploadArtifact(
          session,
          extractionTarget,
          voice.audioFile,
          "voice-originals",
          "voice_note",
        );
      }

      if (shouldExtract) {
        try {
          await apiPost("/v1/jobs/extraction", session, {
            event_id: extractionTarget,
            artifact_id: artifactId,
            force_transcription: useBackendFallback,
          });
        } catch (caught) {
          const {error: trustError} = await supabase
            .from("events")
            .update({trust_status: "trusted"})
            .eq("id", extractionTarget);
          setError(
            `Log saved, but AI extraction was not queued: ${
              caught instanceof Error ? caught.message : "the request failed"
            }${
              trustError ? ` The manual record remains a draft: ${trustError.message}` : ""
            }`,
          );
          setSuccess(
            trustError
              ? "Your original input is stored and visible in the timeline."
              : "Your original log is safely stored as trusted manual data.",
          );
          if (recipeOffer) setRecipeDraft(recipeOffer);
          setText("");
          setPreparationMethod("");
          setHandled("");
          setPrepared(false);
          setSelectedConceptId("");
          setGloves(false);
          setGloveMaterial("");
          voice.clear();
          setVoiceStatus("idle");
          setMachineTranscript(null);
          setTranscriptConfirmed(false);
          setTranscriptConfirmedAt(null);
          setVoiceError(null);
          setUseBackendFallback(false);
          setTextBeforeVoice("");
          onSaved();
          return;
        }
      }
      setSuccess(shouldExtract ? "Saved. AI extraction is queued for review." : "Log saved.");
      if (recipeOffer) setRecipeDraft(recipeOffer);
      setText("");
      setPreparationMethod("");
      setHandled("");
      setPrepared(false);
      setSelectedConceptId("");
      setGloves(false);
      setGloveMaterial("");
      setActivityConceptIds([]);
      setActivityProductAreas({});
      setAmount("");
      setUnit("");
      setRoute("");
      setIngestionMethod("eaten");
      setDurationMinutes("");
      voice.clear();
      setVoiceStatus("idle");
      setMachineTranscript(null);
      setTranscriptConfirmed(false);
      setTranscriptConfirmedAt(null);
      setVoiceError(null);
      setUseBackendFallback(false);
      setTextBeforeVoice("");
      setOccurred(localDatetimeValue());
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the log.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <div><span className="eyebrow">Fast capture</span><h1>Quick log</h1></div>
        <p>Start with a photo or voice note, review the closest matches, then confirm exactly what happened.</p>
      </header>
      <ConversationalQuickLog
        session={session}
        profile={profile}
        bodyAreas={bodyAreas}
        onSaved={onSaved}
        onManual={() => setManualOpen(true)}
      />
      <div className="manual-log-divider"><span>Detailed fallback</span></div>
      <button type="button" className="secondary manual-entry-button" onClick={() => setManualOpen((open) => !open)}>
        {manualOpen ? "Hide manual entry" : "Enter manually"}
      </button>
      {manualOpen && <form className="stack card manual-log-form" onSubmit={submit}>
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
        <label>
          What are you logging?
          <select
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setSelectedConceptId("");
              setActivityConceptIds([]);
              setActivityProductAreas({});
              setPrepared(false);
              setPreparationMethod("");
              setHandled("");
              setAmount("");
              setUnit("");
              setRoute("");
              setIngestionMethod(event.target.value === "medication" ? "swallowed" : "eaten");
            }}
          >
            {types.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </label>
        {type === "activity" && (
          <fieldset className="subcard">
            <legend>Activity details</legend>
            <div className="form-grid">
              <label>
                Activity
                <select
                  value={activityType}
                  onChange={(event) => {
                    setActivityType(event.target.value);
                    setSelectedConceptId("");
                    setActivityConceptIds([]);
                    setActivityProductAreas({});
                    if (event.target.value === "washing_up") setBodyArea("both_hands");
                  }}
                >
                  {activityTypes.map(([value, label]) => (
                    <option value={value} key={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label>
                Duration in minutes
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={durationMinutes}
                  onChange={(event) => setDurationMinutes(event.target.value)}
                />
              </label>
              {["shower", "bath", "washing_up"].includes(activityType) && (
                <label>
                  Water temperature
                  <select
                    value={waterTemperature}
                    onChange={(event) => setWaterTemperature(event.target.value)}
                  >
                    <option value="unknown">Not recorded</option>
                    <option value="cool">Cool</option>
                    <option value="lukewarm">Lukewarm</option>
                    <option value="warm">Warm</option>
                    <option value="hot">Hot</option>
                  </select>
                </label>
              )}
              {activityType === "washing_up" && (
                <label>
                  Default hand/body area
                  <select
                    value={bodyArea}
                    onChange={(event) => {
                      setBodyArea(event.target.value);
                      setActivityProductAreas(
                        Object.fromEntries(
                          activityConceptIds.map((conceptId) => [
                            conceptId,
                            event.target.value,
                          ]),
                        ),
                      );
                    }}
                  >
                    {bodyAreas.map((area) => (
                      <option value={area.code} key={area.code}>{area.label}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {activityType === "washing_up" && (
              <>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={gloves}
                    onChange={(event) => setGloves(event.target.checked)}
                  />
                  <span>Wore gloves</span>
                </label>
                {gloves && (
                  <label>
                    Glove material
                    <input
                      value={gloveMaterial}
                      onChange={(event) => setGloveMaterial(event.target.value)}
                      placeholder="e.g. nitrile, latex, rubber"
                    />
                  </label>
                )}
                <label>
                  Direct detergent/water contact
                  <select
                    value={directContact}
                    onChange={(event) =>
                      setDirectContact(event.target.value as "yes" | "no" | "unknown")}
                  >
                    <option value="unknown">Unknown / not recorded</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </label>
              </>
            )}
          </fieldset>
        )}
        {["meal", "skin_contact", "product_use", "topical_treatment", "medication", "activity"]
          .includes(type) && (
          <fieldset className="subcard">
            <legend>
              {type === "meal"
                ? "Saved meal or recipe"
                : type === "medication"
                ? "Saved medication"
                : type === "topical_treatment"
                  ? "Saved treatment"
                  : activityType === "washing_up" && type === "activity"
                    ? "Detergent / product used"
                    : "Saved product"}
            </legend>
            <label>
              {type === "activity"
                ? "Select every product used"
                : type === "meal"
                  ? "Select a saved meal"
                  : "Select an item"}
              {type === "activity" ? (
                <span className="choice-list">
                {sortCatalogueItems(catalogueItems
                    .filter((item) =>
                      item.concept_type === "product" || item.concept_type === "treatment")
                  ).map((item) => (
                      <span className="check-row" key={item.id}>
                        <input
                          type="checkbox"
                          checked={activityConceptIds.includes(item.id)}
                          onChange={(event) =>
                            setActivityConceptIds((current) => {
                              if (event.target.checked) {
                                setActivityProductAreas((areas) => ({
                                  ...areas,
                                  [item.id]: activityType === "washing_up" ? bodyArea : "",
                                }));
                                return [...current, item.id];
                              }
                              setActivityProductAreas((areas) => {
                                const next = {...areas};
                                delete next[item.id];
                                return next;
                              });
                              return current.filter((id) => id !== item.id);
                            })}
                        />
                        <span>
                          {item.attributes.favorite ? "★ " : ""}
                          {item.canonical_name}
                          {item.attributes.brand ? ` · ${item.attributes.brand}` : ""}
                        </span>
                      </span>
                    ))}
                  {catalogueItems.filter((item) =>
                    item.concept_type === "product" || item.concept_type === "treatment")
                    .length === 0 && (
                    <span className="evidence">No saved products yet.</span>
                  )}
                </span>
              ) : (
                <select
                  value={selectedConceptId}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    const selected = catalogueItems.find((item) => item.id === nextId);
                    const selectedRecipe = mealRecipes.find((recipe) => recipe.id === nextId);
                    const selectedVersion = mealRecipeVersions.find(
                      (version) => version.recipe_id === selectedRecipe?.id,
                    );
                    setSelectedConceptId(nextId);
                    if (type === "meal") {
                      setPreparationMethod(selectedVersion?.instructions || "");
                      setHandled("");
                    }
                  }}
                >
                  <option value="">None / describe it below</option>
                  {type === "meal" ? mealRecipes.map((recipe) => (
                    <option value={recipe.id} key={recipe.id}>{recipe.name}</option>
                  )) : sortCatalogueItems(catalogueItems
                    .filter((item) => {
                      if (type === "medication") return item.concept_type === "medication";
                      if (type === "topical_treatment") {
                        return item.concept_type === "treatment"
                          || item.attributes.category === "moisturiser";
                      }
                      return item.concept_type === "product"
                        || item.concept_type === "treatment";
                    }))
                    .map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.attributes.favorite ? "★ " : ""}
                        {item.canonical_name}
                        {item.attributes.brand ? ` · ${item.attributes.brand}` : ""}
                      </option>
                    ))}
                </select>
              )}
            </label>
            {type === "activity" && activityConceptIds.length > 0 && (
              <div className="activity-product-areas">
                {activityConceptIds.map((conceptId) => (
                  <label key={conceptId}>
                    {catalogueItems.find((item) => item.id === conceptId)?.canonical_name}
                    {" "}contact area
                    <select
                      value={activityProductAreas[conceptId] || ""}
                      onChange={(event) =>
                        setActivityProductAreas({
                          ...activityProductAreas,
                          [conceptId]: event.target.value,
                        })}
                    >
                      <option value="">Not recorded</option>
                      {bodyAreas.map((area) => (
                        <option value={area.code} key={area.code}>{area.label}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
            {selectedConceptId && ["medication", "topical_treatment", "product_use"]
              .includes(type) && (
              <div className="form-grid">
                <label>
                  Amount / dose
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                </label>
                <label>
                  Unit
                  <input
                    value={unit}
                    onChange={(event) => setUnit(event.target.value)}
                    placeholder="e.g. tablet, mg, pump, fingertip unit"
                  />
                </label>
                <label>
                  Route
                  <input
                    value={route}
                    onChange={(event) => setRoute(event.target.value)}
                    placeholder={type === "topical_treatment" ? "topical" : "e.g. oral"}
                  />
                </label>
                {type === "medication" && (
                  <label>
                    Ingestion method
                    <select value={ingestionMethod} onChange={(event) => setIngestionMethod(
                      event.target.value as typeof ingestionMethod,
                    )}>
                      <option value="swallowed">Swallowed</option>
                      <option value="sublingual">Under the tongue</option>
                      <option value="inhaled">Inhaled</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                )}
                {type === "topical_treatment" && (
                  <label>
                    Applied to
                    <select
                      value={bodyArea}
                      onChange={(event) => setBodyArea(event.target.value)}
                    >
                      {bodyAreas.map((area) => (
                        <option value={area.code} key={area.code}>{area.label}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
            {type === "meal" && selectedConceptId && (
              <div className="stack compact-recipe-summary">
                {mealRecipeVersions.find((version) =>
                  version.recipe_id === selectedConceptId)?.instructions && (
                  <p className="evidence">
                    <strong>Saved method:</strong>{" "}
                    {mealRecipeVersions.find((version) =>
                      version.recipe_id === selectedConceptId)?.instructions}
                  </p>
                )}
                <p className="evidence">
                  This logs the current saved recipe version. Preparation contact is
                  recorded separately below.
                </p>
              </div>
            )}
            {(type === "meal"
              ? mealRecipes.length === 0
              : catalogueItems.length === 0) && (
              <p className="evidence">
                {type === "meal"
                  ? "Add a reusable meal or recipe under Saved items first."
                  : "Add reusable products, treatments or medications under Saved items first."}
              </p>
            )}
          </fieldset>
        )}
        {type === "meal" && (
          <label>
            How was it ingested?
            <select value={ingestionMethod} onChange={(event) => setIngestionMethod(
              event.target.value as typeof ingestionMethod,
            )}>
              <option value="eaten">Eaten</option>
              <option value="drank">Drunk</option>
              <option value="swallowed">Swallowed</option>
              <option value="other">Other</option>
            </select>
          </label>
        )}
        <label>
          {selectedConceptId || activityConceptIds.length > 0 || type === "activity"
            ? "Additional notes (optional)"
            : "Describe it"}
          <textarea
            rows={5}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              if (voice.audioFile) {
                setTranscriptConfirmed(false);
                setTranscriptConfirmedAt(null);
              }
            }}
            placeholder={
              type === "meal"
                ? "For example: Made tomato pasta, chopped tomatoes with bare hands, then washed with the kitchen soap."
                : "Anything else that may matter, such as timing, contact or circumstances."
            }
          />
        </label>
        <div className="voice-row">
          {!voice.recording && !voice.audioFile ? (
            <button type="button" className="secondary" onClick={() => void startVoice()}>
              Record voice note
            </button>
          ) : voice.recording ? (
            <button type="button" className="danger" onClick={voice.stop}>Stop recording</button>
          ) : (
            <button type="button" className="secondary" onClick={discardVoice}>
              Discard and re-record
            </button>
          )}
          {voice.recording && <span>Maximum {voice.maxRecordingSeconds} seconds</span>}
          {voice.audioFile && (
            <span>
              Voice note ready · {(voice.audioFile.size / 1024).toFixed(0)} KB
              {voice.durationSeconds === null ? "" : ` · ${voice.durationSeconds.toFixed(1)} sec`}
            </span>
          )}
        </div>
        {voice.audioFile && (
          <fieldset className="subcard voice-review">
            <legend>Review voice transcript</legend>
            {voiceStatus === "loading" || voiceStatus === "transcribing" ? (
              <p className="voice-progress" aria-live="polite">
                Loading the {moonshineConfig.model.replace("model/", "")} English model and
                transcribing on this device. The first use may take a little while.
              </p>
            ) : voiceStatus === "ready" ? (
              <>
                <p className="status success">
                  Local transcript ready. Correct the description above, then confirm it.
                </p>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={transcriptConfirmed}
                    onChange={(event) => {
                      setTranscriptConfirmed(event.target.checked);
                      setTranscriptConfirmedAt(
                        event.target.checked ? new Date().toISOString() : null,
                      );
                    }}
                  />
                  <span>I reviewed the voice transcript and corrected any mistakes.</span>
                </label>
              </>
            ) : voiceStatus === "error" ? (
              <>
                <p className="status error">
                  Local transcription did not complete: {voiceError}
                </p>
                <p className="evidence">
                  You can type the transcript above and confirm it, or explicitly request
                  the configured backend transcription fallback.
                </p>
                {text.trim() && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={transcriptConfirmed}
                      onChange={(event) => {
                        setTranscriptConfirmed(event.target.checked);
                        setTranscriptConfirmedAt(
                          event.target.checked ? new Date().toISOString() : null,
                        );
                        if (event.target.checked) setUseBackendFallback(false);
                      }}
                    />
                    <span>I entered and reviewed the transcript manually.</span>
                  </label>
                )}
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={useBackendFallback}
                    disabled={!requestAi}
                    onChange={(event) => {
                      setUseBackendFallback(event.target.checked);
                      if (event.target.checked) {
                        setTranscriptConfirmed(false);
                        setTranscriptConfirmedAt(null);
                      }
                    }}
                  />
                  <span>
                    Send this audio to the configured backend transcription provider.
                    The resulting transcript and fields will require review.
                  </span>
                </label>
              </>
            ) : null}
            <p className="evidence">
              Moonshine transcription runs locally. The original recording is still saved
              privately with this log for provenance.
            </p>
          </fieldset>
        )}
        {type === "meal" && (
          <fieldset className="subcard">
            <legend>Preparation and skin contact</legend>
            <label className="check-row">
              <input
                type="checkbox"
                checked={prepared}
                onChange={(event) => {
                  const nextPrepared = event.target.checked;
                  setPrepared(nextPrepared);
                  if (nextPrepared && selectedConceptId) {
                    const selectedVersion = mealRecipeVersions.find(
                      (version) => version.recipe_id === selectedConceptId,
                    );
                    if (!preparationMethod) {
                      setPreparationMethod(selectedVersion?.instructions || "");
                    }
                  }
                }}
              />
              <span>I prepared this meal</span>
            </label>
            {prepared && (
              <>
                <label>
                  How did you prepare it this time?
                  <textarea
                    rows={3}
                    value={preparationMethod}
                    onChange={(event) => setPreparationMethod(event.target.value)}
                    placeholder="e.g. Chopped the vegetables, mixed by hand, then fried"
                  />
                </label>
                <label>
                  What actually touched your skin, and how?
                  <textarea
                    rows={3}
                    value={handled}
                    onChange={(event) => setHandled(event.target.value)}
                    placeholder="e.g. Chopped raw tomatoes and onion with bare hands; washed the knife with detergent"
                  />
                  <span className="field-help">
                    This is the actual contact for this preparation, not an assumption
                    based on every recipe ingredient.
                  </span>
                </label>
                <div className="form-grid">
                  <label>Body area<select value={bodyArea} onChange={(event) => setBodyArea(event.target.value)}>{bodyAreas.map((area) => <option value={area.code} key={area.code}>{area.label}</option>)}</select></label>
                  <label className="check-row compact"><input type="checkbox" checked={gloves} onChange={(event) => setGloves(event.target.checked)} /><span>Wore gloves</span></label>
                </div>
                {gloves && (
                  <label>
                    Glove material
                    <input
                      value={gloveMaterial}
                      onChange={(event) => setGloveMaterial(event.target.value)}
                      placeholder="e.g. nitrile, latex, rubber"
                    />
                  </label>
                )}
              </>
            )}
          </fieldset>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            checked={requestAi}
            onChange={(event) => {
              setRequestAi(event.target.checked);
              if (!event.target.checked) setUseBackendFallback(false);
            }}
          />
          <span>Ask AI to propose structured fields. Nothing becomes trusted until I review it.</span>
        </label>
        <StatusMessage error={error} success={success} />
        <button
          className="primary"
          disabled={
            busy
            || (
              !text.trim()
              && !voice.audioFile
              && !selectedConceptId
              && activityConceptIds.length === 0
              && type !== "activity"
            )
            || voiceStatus === "loading"
            || voiceStatus === "transcribing"
            || Boolean(
              voice.audioFile
              && !useBackendFallback
              && (!text.trim() || !transcriptConfirmed),
            )
          }
        >
          {busy ? "Saving…" : "Save log"}
        </button>
      </form>}
      {recipeDraft && (
        <SaveMealAsRecipe
          key={recipeDraft.mealEventId}
          mealEventId={recipeDraft.mealEventId}
          defaultName={recipeDraft.name}
          defaultMethod={recipeDraft.method}
          defaultContact={recipeDraft.contact}
          initiallyOpen
          onSaved={() => {
            setRecipeDraft(null);
            onSaved();
          }}
          onDismiss={() => setRecipeDraft(null)}
        />
      )}
    </section>
  );
}
