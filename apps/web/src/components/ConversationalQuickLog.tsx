import {useEffect, useRef, useState, type ChangeEvent} from "react";
import type {Session} from "@supabase/supabase-js";
import {useVoiceRecorder} from "../hooks/useVoiceRecorder";
import {apiPost} from "../lib/api";
import {localDatetimeToIso, localDatetimeValue} from "../lib/datetime";
import {
  removeQuickLogArtifact,
  uploadQuickLogArtifact,
} from "../lib/artifacts";
import {transcribeWithMoonshine} from "../lib/moonshine";
import {supabase} from "../lib/supabase";
import type {
  BodyArea,
  CaptureReviewField,
  FoodBatch,
  FoodItem,
  Profile,
  Recipe,
  RecipeVersion,
} from "../types";
import {StatusMessage} from "./StatusMessage";

type EvidenceStatus = "uploading" | "ready" | "error";

interface EvidenceItem {
  localId: string;
  file: File | null;
  kind: "image" | "voice";
  displayOrder: number;
  artifactId: string | null;
  previewUrl: string | null;
  status: EvidenceStatus;
  error: string | null;
  transcription: "pending" | "local" | "fallback" | "failed" | null;
}

interface Knowledge {
  recipes: Recipe[];
  versions: RecipeVersion[];
  batches: FoodBatch[];
  foods: FoodItem[];
}

const occurrenceTypes = [
  "meal", "drink", "product", "cream", "medication", "exercise", "shower",
  "washing", "swimming", "other",
] as const;

const cardTitles: Record<string, string> = {
  occurrence_choice: "Which occurrence are you logging?",
  date_time: "Date and time",
  occurrence_type: "What happened?",
  identity: "Name and saved match",
  meal_contents: "Ingredients, sub-recipes and leftovers",
  preparation_contact: "Preparation and skin contact",
  product_details: "Product details",
  activity_products: "Products involved",
  skin_contact: "Skin contact",
};

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function commaList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function requiredQuickLogCards(type: string, multiple = false): string[] {
  const required = ["date_time", "occurrence_type", "identity"];
  if (["meal", "drink"].includes(type)) {
    required.push("meal_contents", "preparation_contact");
  } else if (["product", "cream", "medication"].includes(type)) {
    required.push("product_details", "skin_contact");
  } else {
    required.push("activity_products", "skin_contact");
  }
  if (multiple) required.unshift("occurrence_choice");
  return required;
}

export function isQuickLogFieldConfirmable(field: CaptureReviewField): boolean {
  const value = field.proposed_value;
  if (field.field_key === "occurrence_choice") return Boolean(objectValue(value).selected);
  if (field.field_key === "identity") {
    const identity = objectValue(value);
    if (!String(identity.name || "").trim()) return false;
    if (["existing", "variation"].includes(identity.mode) && !identity.selected) return false;
    if (identity.document_relationship === "unknown") return false;
  }
  if (field.field_key === "preparation_contact") {
    const preparation = objectValue(value);
    if (typeof preparation.prepared_by_user !== "boolean") return false;
    const contact = objectValue(preparation.skin_contact);
    if (contact.mode === "unknown") return false;
    if (["direct", "gloves"].includes(contact.mode)
      && (!(contact.items || []).length || !(contact.body_areas || []).length)) return false;
  }
  if (field.field_key === "skin_contact") {
    const contact = objectValue(value);
    if (contact.mode === "unknown") return false;
    if (["direct", "gloves"].includes(contact.mode)
      && (!(contact.items || []).length || !(contact.body_areas || []).length)) return false;
  }
  if (field.field_key === "product_details") {
    return Boolean(String(objectValue(value).action || "").trim());
  }
  return true;
}

export function ConversationalQuickLog({
  session,
  profile,
  bodyAreas,
  onSaved,
  onManual,
}: {
  session: Session;
  profile: Profile;
  bodyAreas: BodyArea[];
  onSaved: () => void;
  onManual: () => void;
}) {
  const [captureId, setCaptureId] = useState<string | null>(null);
  const capturePromise = useRef<Promise<string> | null>(null);
  const nextArtifactOrder = useRef(0);
  const [occurred, setOccurred] = useState(localDatetimeValue());
  const [context, setContext] = useState("");
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [stage, setStage] = useState<"capture" | "processing" | "review" | "saved">("capture");
  const [fields, setFields] = useState<CaptureReviewField[]>([]);
  const [requiredKeys, setRequiredKeys] = useState<string[]>([]);
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [voicePurpose, setVoicePurpose] = useState<"evidence" | "correction">("evidence");
  const [pendingCorrectionVoice, setPendingCorrectionVoice] = useState<EvidenceItem | null>(null);
  const [resumeCandidate, setResumeCandidate] = useState<{
    id: string;
    status: string;
    occurred_at: string;
    error: string | null;
  } | null>(null);
  const [knowledge, setKnowledge] = useState<Knowledge>({
    recipes: [], versions: [], batches: [], foods: [],
  });
  const voice = useVoiceRecorder();

  useEffect(() => {
    void Promise.all([
      supabase.from("recipes").select("*").is("archived_at", null).order("updated_at", {ascending: false}),
      supabase.from("recipe_versions").select("*").is("effective_to", null).order("version_number", {ascending: false}),
      supabase.from("food_batches").select("*").is("exhausted_at", null).order("prepared_at", {ascending: false}).limit(20),
      supabase.from("food_items").select("*").is("archived_at", null),
    ]).then(([recipes, versions, batches, foods]) => {
      setKnowledge({
        recipes: (recipes.data || []) as Recipe[],
        versions: (versions.data || []) as RecipeVersion[],
        batches: (batches.data || []) as FoodBatch[],
        foods: (foods.data || []) as FoodItem[],
      });
    });
  }, []);

  useEffect(() => {
    void supabase
      .from("capture_sessions")
      .select("id,status,occurred_at,error")
      .eq("source_type", "mixed")
      .in("status", ["draft", "queued", "processing", "ready", "failed"])
      .order("updated_at", {ascending: false})
      .limit(1)
      .maybeSingle()
      .then(({data}) => setResumeCandidate(data));
  }, []);

  async function ensureCapture(): Promise<string> {
    if (captureId) return captureId;
    if (capturePromise.current) return capturePromise.current;
    capturePromise.current = (async () => {
      const {data, error: insertError} = await supabase
        .from("capture_sessions")
        .insert({
          user_id: session.user.id,
          profile_id: profile.id,
          source_type: "mixed",
          occurred_at: localDatetimeToIso(occurred),
          recorded_timezone: profile.timezone,
          original_text: context.trim() || null,
          status: "draft",
          attributes: {quick_log_version: 1},
        })
        .select("id")
        .single();
      if (insertError) throw insertError;
      setCaptureId(data.id as string);
      return data.id as string;
    })();
    try {
      return await capturePromise.current;
    } finally {
      capturePromise.current = null;
    }
  }

  function updateEvidence(localId: string, update: Partial<EvidenceItem>) {
    setEvidence((current) => current.map((item) =>
      item.localId === localId ? {...item, ...update} : item));
  }

  async function uploadEvidenceItem(item: EvidenceItem) {
    if (!item.file) throw new Error("This resumed upload cannot be retried from this device.");
    try {
      const id = await ensureCapture();
      const artifactId = await uploadQuickLogArtifact(
        session, id, item.file, item.displayOrder,
      );
      updateEvidence(item.localId, {artifactId, status: "ready", error: null});
      return artifactId;
    } catch (caught) {
      updateEvidence(item.localId, {
        status: "error",
        error: caught instanceof Error ? caught.message : "Upload failed.",
      });
      throw caught;
    }
  }

  async function addFiles(files: File[], kind: "image" | "voice") {
    const currentCount = evidence.filter((item) => item.kind === kind).length;
    const limit = kind === "image" ? 8 : 4;
    const accepted = files.slice(0, Math.max(0, limit - currentCount));
    if (!accepted.length) {
      setError(`You can add up to ${limit} ${kind === "image" ? "images" : "voice notes"}.`);
      return [];
    }
    setError(null);
    const items = accepted.map((file) => ({
      localId: crypto.randomUUID(),
      file,
      kind,
      displayOrder: nextArtifactOrder.current++,
      artifactId: null,
      previewUrl: kind === "image" ? URL.createObjectURL(file) : null,
      status: "uploading" as const,
      error: null,
      transcription: kind === "voice" ? "pending" as const : null,
    }));
    setEvidence((current) => [...current, ...items]);
    await Promise.allSettled(items.map(uploadEvidenceItem));
    return items;
  }

  async function removeEvidence(item: EvidenceItem) {
    setError(null);
    try {
      if (captureId && item.artifactId) {
        await removeQuickLogArtifact(captureId, item.artifactId);
      }
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      setEvidence((current) => current.filter((entry) => entry.localId !== item.localId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove that upload.");
    }
  }

  async function retryEvidence(item: EvidenceItem) {
    if (!item.file) {
      setError("Remove this item and add it again to retry the original upload.");
      return;
    }
    updateEvidence(item.localId, {status: "uploading", error: null});
    await uploadEvidenceItem(item).catch(() => undefined);
  }

  async function startVoice(purpose: "evidence" | "correction") {
    setError(null);
    setVoicePurpose(purpose);
    voice.clear();
    try {
      await voice.start();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Microphone access failed.");
    }
  }

  async function stopVoice() {
    const file = await voice.stop();
    if (!file) return;
    const [item] = await addFiles([file], "voice");
    voice.clear();
    if (!item) return;
    const artifactId = await waitForArtifact(item.displayOrder);
    const uploaded = {...item, artifactId, status: artifactId ? "ready" as const : "error" as const};
    if (!artifactId) return;
    if (voicePurpose === "evidence") {
      try {
        const transcript = await transcribeWithMoonshine(file);
        const id = await ensureCapture();
        const {error: transcriptError} = await supabase.from("capture_messages").insert({
          user_id: session.user.id,
          capture_session_id: id,
          author: "user",
          message_kind: "voice_transcript",
          text_content: transcript,
          artifact_id: artifactId,
          message_order: await nextMessageOrder(id),
          provenance: {method: "local_transcription"},
        });
        if (transcriptError) throw transcriptError;
        updateEvidence(item.localId, {transcription: "local"});
      } catch {
        updateEvidence(item.localId, {transcription: "failed"});
        setError(
          "Local transcription failed. Type the context, remove the note, or explicitly use backend transcription.",
        );
      }
      return;
    }
    setPendingCorrectionVoice(uploaded);
    try {
      const transcript = await transcribeWithMoonshine(file);
      setPendingCorrectionVoice(null);
      await sendCorrection(transcript, artifactId);
    } catch {
      setError("Local transcription failed. Type the correction, or use backend transcription.");
    }
  }

  async function waitForArtifact(displayOrder: number): Promise<string | null> {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const {data} = await supabase
        .from("capture_artifacts")
        .select("artifact_id")
        .eq("capture_session_id", await ensureCapture())
        .eq("display_order", displayOrder)
        .maybeSingle();
      if (data?.artifact_id) return data.artifact_id as string;
      await sleep(150);
    }
    return null;
  }

  async function resumeDraft() {
    if (!resumeCandidate) return;
    setBusy(true);
    setError(null);
    try {
      const id = resumeCandidate.id;
      setCaptureId(id);
      setOccurred(localDatetimeValue(new Date(resumeCandidate.occurred_at)));
      const [{data: links, error: linksError}, {data: messages}] = await Promise.all([
        supabase
          .from("capture_artifacts")
          .select("artifact_id,artifact_role,display_order")
          .eq("capture_session_id", id)
          .order("display_order"),
        supabase
          .from("capture_messages")
          .select("artifact_id,message_kind")
          .eq("capture_session_id", id),
      ]);
      if (linksError) throw linksError;
      const restored: EvidenceItem[] = [];
      for (const link of links || []) {
        const {data: artifact, error: artifactError} = await supabase
          .from("artifacts")
          .select("id,bucket,object_path,media_type")
          .eq("id", link.artifact_id)
          .single();
        if (artifactError) throw artifactError;
        const image = String(artifact.media_type).startsWith("image/");
        let previewUrl: string | null = null;
        if (image) {
          const {data: signed} = await supabase.storage
            .from(artifact.bucket)
            .createSignedUrl(artifact.object_path, 3600);
          previewUrl = signed?.signedUrl || null;
        }
        const transcribed = (messages || []).some((message) =>
          message.artifact_id === artifact.id && message.message_kind === "voice_transcript");
        restored.push({
          localId: crypto.randomUUID(),
          file: null,
          kind: image ? "image" : "voice",
          displayOrder: link.display_order,
          artifactId: artifact.id,
          previewUrl,
          status: "ready",
          error: null,
          transcription: image ? null : transcribed ? "local" : "fallback",
        });
      }
      setEvidence(restored);
      nextArtifactOrder.current = 1 + Math.max(
        ...restored.map((item) => item.displayOrder), -1,
      );
      setResumeCandidate(null);
      if (resumeCandidate.status === "ready") {
        await loadReview(id);
        setStage("review");
      } else if (["queued", "processing"].includes(resumeCandidate.status)) {
        setStage("processing");
        await waitUntilReady(id);
        await loadReview(id);
        setStage("review");
      } else {
        setStage("capture");
        if (resumeCandidate.error) setError(resumeCandidate.error);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resume this draft.");
      setStage("capture");
    } finally {
      setBusy(false);
    }
  }

  async function discardResumeCandidate() {
    if (!resumeCandidate) return;
    await supabase.from("capture_sessions").update({status: "discarded"}).eq("id", resumeCandidate.id);
    setResumeCandidate(null);
  }

  async function loadReview(id: string) {
    const [{data: capture, error: captureError}, {data, error: fieldsError}] = await Promise.all([
      supabase.from("capture_sessions").select("attributes,status,error").eq("id", id).single(),
      supabase.from("capture_review_fields").select("*").eq("capture_session_id", id).order("created_at"),
    ]);
    if (captureError) throw captureError;
    if (fieldsError) throw fieldsError;
    setFields((data || []) as CaptureReviewField[]);
    setRequiredKeys((capture.attributes?.required_review_fields || []) as string[]);
  }

  async function waitUntilReady(id: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const {data, error: readError} = await supabase
        .from("capture_sessions")
        .select("status,error")
        .eq("id", id)
        .single();
      if (readError) throw readError;
      if (data.status === "ready") return;
      if (data.status === "failed") throw new Error(data.error || "Interpretation failed.");
      await sleep(800);
    }
    throw new Error("Interpretation is taking longer than expected. This draft is safe to resume.");
  }

  async function review() {
    const failed = evidence.some((item) => item.status === "error");
    const uploading = evidence.some((item) => item.status === "uploading");
    const transcriptionBlocked = evidence.some((item) =>
      item.kind === "voice" && item.transcription === "failed");
    if (failed || uploading || transcriptionBlocked) {
      setError(
        failed
          ? "Retry or remove failed uploads first."
          : transcriptionBlocked
            ? "Choose backend transcription, type the context, or remove the failed voice note."
            : "Please wait for uploads to finish.",
      );
      return;
    }
    if (!evidence.length && !context.trim()) {
      setError("Add a photo, voice note, or a little typed context first.");
      return;
    }
    setBusy(true);
    setError(null);
    setStage("processing");
    try {
      const id = await ensureCapture();
      const {error: updateError} = await supabase
        .from("capture_sessions")
        .update({
          occurred_at: localDatetimeToIso(occurred),
          recorded_timezone: profile.timezone,
          original_text: context.trim() || null,
          status: "draft",
          error: null,
        })
        .eq("id", id);
      if (updateError) throw updateError;
      await apiPost("/v1/jobs/capture-extraction", session, {
        capture_session_id: id,
        mode: "quick_log",
        operation: "synthesize",
      });
      await waitUntilReady(id);
      await loadReview(id);
      setStage("review");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not interpret this Quick Log.");
      setStage("capture");
    } finally {
      setBusy(false);
    }
  }

  async function changeField(fieldKey: string, proposedValue: unknown) {
    if (!captureId) return;
    setFields((current) => current.map((field) => field.field_key === fieldKey
      ? {...field, proposed_value: proposedValue, confirmed_value: null, confirmation_state: "unconfirmed"}
      : field));
    const {error: updateError} = await supabase
      .from("capture_review_fields")
      .update({
        proposed_value: proposedValue,
        confirmed_value: null,
        confirmation_state: "unconfirmed",
        provenance: {method: "manual_correction"},
      })
      .eq("capture_session_id", captureId)
      .eq("field_key", fieldKey);
    if (updateError) setError(updateError.message);
    if (fieldKey === "date_time") {
      const dateTime = objectValue(proposedValue);
      await supabase.from("capture_sessions").update({
        occurred_at: dateTime.occurred_at,
        recorded_timezone: dateTime.timezone || profile.timezone,
      }).eq("id", captureId);
    }
    if (fieldKey === "occurrence_type") {
      const type = String(proposedValue);
      const required = requiredQuickLogCards(
        type, fields.some((item) => item.field_key === "occurrence_choice"),
      );
      setRequiredKeys(required);
      const {data: capture} = await supabase
        .from("capture_sessions")
        .select("attributes")
        .eq("id", captureId)
        .single();
      await supabase.from("capture_sessions").update({
        attributes: {...(capture?.attributes || {}), required_review_fields: required},
      }).eq("id", captureId);
    }
  }

  async function confirmField(field: CaptureReviewField) {
    if (!captureId) return;
    const {error: updateError} = await supabase
      .from("capture_review_fields")
      .update({confirmed_value: field.proposed_value, confirmation_state: "confirmed"})
      .eq("id", field.id);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setFields((current) => current.map((item) => item.id === field.id
      ? {...item, confirmed_value: item.proposed_value, confirmation_state: "confirmed"}
      : item));
  }

  async function nextMessageOrder(id: string): Promise<number> {
    const {data} = await supabase
      .from("capture_messages")
      .select("message_order")
      .eq("capture_session_id", id)
      .order("message_order", {ascending: false})
      .limit(1);
    return ((data?.[0]?.message_order as number | undefined) ?? -1) + 1;
  }

  async function sendCorrection(text: string, artifactId: string | null = null, backend = false) {
    if (!text.trim() || !captureId) return;
    setBusy(true);
    setError(null);
    try {
      const {data: message, error: messageError} = await supabase
        .from("capture_messages")
        .insert({
          user_id: session.user.id,
          capture_session_id: captureId,
          author: "user",
          message_kind: "correction",
          text_content: text.trim(),
          artifact_id: artifactId,
          message_order: await nextMessageOrder(captureId),
          provenance: backend ? {transcription: "backend_requested"} : {method: artifactId ? "local_transcription" : "typed"},
        })
        .select("id")
        .single();
      if (messageError) throw messageError;
      await apiPost("/v1/jobs/capture-extraction", session, {
        capture_session_id: captureId,
        mode: "quick_log",
        operation: "refine",
        correction_message_id: message.id,
      });
      setComposer("");
      await waitUntilReady(captureId);
      await loadReview(captureId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not apply that correction.");
    } finally {
      setBusy(false);
    }
  }

  function fieldValue(key: string): unknown {
    return fields.find((field) => field.field_key === key)?.proposed_value;
  }

  async function chooseOccurrence(field: CaptureReviewField, selected: string) {
    const choice = objectValue(field.proposed_value);
    await changeField(field.field_key, {...choice, selected});
    if (selected) await sendCorrection(`Log only this occurrence: ${selected}`);
  }

  async function saveOccurrence() {
    if (!captureId) return;
    const missing = requiredKeys.filter((key) =>
      fields.find((field) => field.field_key === key)?.confirmation_state !== "confirmed");
    if (missing.length) {
      setError("Confirm every card before saving.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const occurrenceType = String(fieldValue("occurrence_type"));
      const identity = objectValue(fieldValue("identity"));
      const selected = objectValue(identity.selected);
      const name = String(identity.name || "Untitled occurrence");
      let recipeDefinition: Record<string, unknown> | null = null;
      let conceptDefinition: Record<string, unknown> | null = null;
      const participants: Array<Record<string, unknown>> = [];
      const activities: Array<Record<string, unknown>> = [];

      if (["meal", "drink"].includes(occurrenceType)) {
        const contents = objectValue(fieldValue("meal_contents"));
        const ingredients = Array.isArray(contents.ingredients) ? contents.ingredients : [];
        const subrecipes = Array.isArray(contents.subrecipes) ? contents.subrecipes : [];
        const leftovers = Array.isArray(contents.leftovers) ? contents.leftovers : [];
        const preparation = objectValue(fieldValue("preparation_contact"));
        const contact = objectValue(preparation.skin_contact);
        const hasPreparationEvent = preparation.prepared_by_user === true
          || contact.mode === "direct" || contact.mode === "gloves";
        recipeDefinition = identity.mode === "existing" && selected.recipe_id
          ? {mode: "existing", recipe_id: selected.recipe_id}
          : {
              mode: identity.mode === "variation" ? "variation" : "new",
              name,
              derived_from_id: identity.mode === "variation" ? selected.recipe_id : null,
              components: [
                ...ingredients.map((item: any) => ({name: String(item.name || item)})),
                ...subrecipes.map((item: any) => ({
                  name: item.name,
                  source_recipe_version_id: item.recipe_version_id,
                })),
                ...leftovers.map((item: any) => ({
                  name: item.name,
                  source_recipe_version_id: item.recipe_version_id,
                })),
              ],
              attributes: {source_method: "quick_log", output_food_kind: occurrenceType === "drink" ? "beverage" : "prepared_food"},
            };
        participants.push({
          food_item_id: identity.mode === "existing" ? selected.output_food_item_id : "$resolved_food_item_id",
          recipe_version_id: identity.mode === "existing" ? selected.recipe_version_id : "$resolved_recipe_version_id",
          role: "consumed",
          ingestion_method: occurrenceType === "drink" ? "drank" : "eaten",
        });
        if (!hasPreparationEvent) {
          participants.push(...leftovers.filter((item: any) => item.food_batch_id).map((item: any) => ({
            food_item_id: item.food_item_id,
            food_batch_id: item.food_batch_id,
            recipe_version_id: item.recipe_version_id,
            role: "consumed",
            ingestion_method: "eaten",
          })));
        }
        activities.push({
          type_code: "meal",
          label: name,
          source_method: "mixed",
          attributes: {quick_log: true, occurrence_type: occurrenceType},
          participants,
        });
        if (hasPreparationEvent) {
          activities.push({
            type_code: "meal_preparation",
            label: `Prepared ${name}`,
            source_method: "mixed",
            parent_order: 1,
            relation_type: "prepared_for",
            attributes: {skin_contact: contact},
            participants: [
              {
                food_item_id: identity.mode === "existing" ? selected.output_food_item_id : "$resolved_food_item_id",
                recipe_version_id: identity.mode === "existing" ? selected.recipe_version_id : "$resolved_recipe_version_id",
                role: "prepared",
              },
              ...leftovers.filter((item: any) => item.food_batch_id).map((item: any) => ({
                food_item_id: item.food_item_id,
                food_batch_id: item.food_batch_id,
                recipe_version_id: item.recipe_version_id,
                role: "used",
              })),
            ],
          });
        }
      } else {
        const isReusableProduct = ["product", "cream", "medication"].includes(occurrenceType);
        if (identity.mode === "existing" && selected.concept_id) {
          conceptDefinition = {mode: "existing", concept_id: selected.concept_id};
        } else if (isReusableProduct) {
          const details = objectValue(fieldValue("product_details"));
          conceptDefinition = {
            mode: "new",
            concept_type: occurrenceType === "cream" ? "treatment" : occurrenceType,
            name,
            ingredients: Array.isArray(details.ingredients)
              ? details.ingredients.map((item: any) => ({name: String(item.name || item)}))
              : [],
            attributes: {source_method: "quick_log"},
          };
        }
        const role = occurrenceType === "medication" ? "taken" : occurrenceType === "cream" ? "applied" : isReusableProduct ? "used" : "performed";
        const activityParticipant = conceptDefinition ? {
          concept_id: identity.mode === "existing" ? selected.concept_id : "$resolved_concept_id",
          concept_version_id: identity.mode === "existing" ? selected.concept_version_id : "$resolved_concept_version_id",
          role,
        } : null;
        const activityDetails = objectValue(fieldValue("activity_products"));
        const productParticipants = isReusableProduct
          ? []
          : (activityDetails.products || []).flatMap((item: any) => {
              const match = objectValue(item.selected);
              return match.concept_id ? [{
                concept_id: match.concept_id,
                concept_version_id: match.concept_version_id,
                role: "used",
              }] : [];
            });
        activities.push({
          type_code: occurrenceType === "cream" ? "topical_treatment" : occurrenceType === "product" ? "product_use" : occurrenceType === "medication" ? "medication" : "activity",
          label: name,
          source_method: "mixed",
          attributes: {
            quick_log: true,
            occurrence_type: occurrenceType,
            details: fieldValue("product_details") || fieldValue("activity_products"),
            skin_contact: fieldValue("skin_contact"),
          },
          participants: [...(activityParticipant ? [activityParticipant] : []), ...productParticipants],
        });
      }

      const {error: saveError} = await supabase.rpc("confirm_quick_log_capture", {
        target_capture_id: captureId,
        recipe_definition: recipeDefinition,
        concept_definition: conceptDefinition,
        activities,
      });
      if (saveError) throw saveError;
      setSuccess("Occurrence saved to your trusted history.");
      setStage("saved");
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this occurrence.");
    } finally {
      setBusy(false);
    }
  }

  function renderContact(field: CaptureReviewField, parentKey?: string) {
    const outer = objectValue(field.proposed_value);
    const contact = parentKey ? objectValue(outer[parentKey]) : outer;
    const update = (next: Record<string, unknown>) => changeField(
      field.field_key,
      parentKey ? {...outer, [parentKey]: next} : next,
    );
    return (
      <div className="form-grid">
        <label>
          Contact
          <select value={contact.mode || "unknown"} onChange={(event) => update({...contact, mode: event.target.value})}>
            <option value="none">No contact</option>
            <option value="direct">Direct contact</option>
            <option value="gloves">Through gloves</option>
            <option value="unknown">Needs correction</option>
          </select>
        </label>
        {contact.mode !== "none" && (
          <label>
            Body area
            <select value={contact.body_areas?.[0] || ""} onChange={(event) => update({...contact, body_areas: event.target.value ? [event.target.value] : []})}>
              <option value="">Choose…</option>
              {bodyAreas.map((area) => <option value={area.code} key={area.code}>{area.label}</option>)}
            </select>
          </label>
        )}
        {contact.mode !== "none" && (
          <label className="full-width">
            What contacted skin?
            <input value={(contact.items || []).join(", ")} onChange={(event) => update({...contact, items: commaList(event.target.value)})} placeholder="e.g. tomato, dish soap" />
          </label>
        )}
      </div>
    );
  }

  function renderField(field: CaptureReviewField) {
    const value = field.proposed_value;
    if (field.field_key === "date_time") {
      const dateTime = objectValue(value);
      return <input type="datetime-local" value={localDatetimeValue(new Date(dateTime.occurred_at))} onChange={(event) => changeField(field.field_key, {...dateTime, occurred_at: localDatetimeToIso(event.target.value)})} />;
    }
    if (field.field_key === "occurrence_type") {
      return <select value={String(value)} onChange={(event) => changeField(field.field_key, event.target.value)}>{occurrenceTypes.map((type) => <option key={type} value={type}>{type.replace("_", " ")}</option>)}</select>;
    }
    if (field.field_key === "occurrence_choice") {
      const choice = objectValue(value);
      return <select value={choice.selected || ""} onChange={(event) => void chooseOccurrence(field, event.target.value)}><option value="">Choose one…</option>{(choice.choices || []).map((item: string) => <option key={item}>{item}</option>)}</select>;
    }
    if (field.field_key === "identity") {
      const identity = objectValue(value);
      const alternatives = Array.isArray(identity.alternatives) ? identity.alternatives : [];
      return (
        <div className="stack compact-stack">
          <label>Name<input value={identity.name || ""} onChange={(event) => changeField(field.field_key, {...identity, name: event.target.value})} /></label>
          {alternatives.length > 0 && <label>Saved match<select value={identity.selected?.recipe_id || identity.selected?.concept_id || ""} onChange={(event) => {
            const candidate = alternatives.find((item: any) => (item.recipe_id || item.concept_id) === event.target.value);
            changeField(field.field_key, {...identity, selected: candidate || null, name: candidate?.name || identity.generic_name || identity.name, mode: candidate ? "existing" : "new"});
          }}><option value="">None — save as new</option>{alternatives.map((item: any) => <option key={item.recipe_id || item.concept_id} value={item.recipe_id || item.concept_id}>{item.name} · {Math.round(Number(item.score || 0) * 100)}%</option>)}</select></label>}
          <div className="choice-actions" aria-label="Identity choice">
            {(["existing", "variation", "new"] as const).map((mode) => <button type="button" className={`secondary small ${identity.mode === mode ? "active" : ""}`} onClick={() => changeField(field.field_key, {...identity, mode})} key={mode}>{mode === "existing" ? "Existing" : mode === "variation" ? "Variation" : "New"}</button>)}
          </div>
          {identity.document_relationship === "unknown" && <label>How does the label or recipe relate?<select value="unknown" onChange={(event) => changeField(field.field_key, {...identity, document_relationship: event.target.value})}><option value="unknown">Choose…</option><option value="eaten_directly">Eaten directly</option><option value="used_as_ingredient">Used as an ingredient</option><option value="handled_or_applied">Handled / applied</option><option value="unrelated">Unrelated</option></select></label>}
        </div>
      );
    }
    if (field.field_key === "meal_contents") {
      const contents = objectValue(value);
      const ingredients = Array.isArray(contents.ingredients) ? contents.ingredients : [];
      return (
        <div className="stack compact-stack">
          <label>Ingredients<textarea rows={3} value={ingredients.map((item: any) => item.name || item).join(", ")} onChange={(event) => changeField(field.field_key, {...contents, ingredients: commaList(event.target.value).map((name) => ({name, evidence: "User confirmed"}))})} /></label>
          <label>Add a sub-recipe<select value="" onChange={(event) => {
            const recipe = knowledge.recipes.find((item) => item.id === event.target.value);
            const version = knowledge.versions.find((item) => item.recipe_id === recipe?.id);
            if (recipe && version) changeField(field.field_key, {...contents, subrecipes: [...(contents.subrecipes || []), {recipe_id: recipe.id, recipe_version_id: version.id, food_item_id: recipe.output_food_item_id, name: recipe.name}]});
          }}><option value="">Choose a saved recipe…</option>{knowledge.recipes.map((recipe) => <option value={recipe.id} key={recipe.id}>{recipe.name}</option>)}</select></label>
          <label>Add recent leftovers<select value="" onChange={(event) => {
            const batch = knowledge.batches.find((item) => item.id === event.target.value);
            const food = knowledge.foods.find((item) => item.id === batch?.food_item_id);
            if (batch) changeField(field.field_key, {...contents, leftovers: [...(contents.leftovers || []), {food_batch_id: batch.id, recipe_version_id: batch.recipe_version_id, food_item_id: batch.food_item_id, name: food?.canonical_name || "Leftovers", prepared_at: batch.prepared_at}]});
          }}><option value="">Choose recent leftovers…</option>{knowledge.batches.map((batch) => <option value={batch.id} key={batch.id}>{knowledge.foods.find((food) => food.id === batch.food_item_id)?.canonical_name || "Recent meal"} · {new Date(batch.prepared_at).toLocaleDateString()}</option>)}</select></label>
          {[...(contents.subrecipes || []), ...(contents.leftovers || [])].map((item: any) => <span className="status-pill" key={item.recipe_version_id + (item.food_batch_id || "")}>{item.name}</span>)}
        </div>
      );
    }
    if (field.field_key === "preparation_contact") {
      const preparation = objectValue(value);
      return <div className="stack compact-stack"><label>Did you prepare it?<select value={preparation.prepared_by_user === null ? "unknown" : preparation.prepared_by_user ? "yes" : "no"} onChange={(event) => changeField(field.field_key, {...preparation, prepared_by_user: event.target.value === "unknown" ? null : event.target.value === "yes"})}><option value="unknown">Choose…</option><option value="yes">Yes</option><option value="no">No</option></select></label>{renderContact(field, "skin_contact")}</div>;
    }
    if (field.field_key === "product_details") {
      const details = objectValue(value);
      const ingredients = Array.isArray(details.ingredients) ? details.ingredients : [];
      return <div className="stack compact-stack"><label>What happened?<input value={details.action || ""} onChange={(event) => changeField(field.field_key, {...details, action: event.target.value})} /></label><label>Ingredients from label evidence<textarea rows={3} value={ingredients.map((item: any) => item.name || item).join(", ")} onChange={(event) => changeField(field.field_key, {...details, ingredients: commaList(event.target.value).map((name) => ({name, evidence: "User confirmed"}))})} /></label></div>;
    }
    if (field.field_key === "activity_products") {
      const details = objectValue(value);
      const products = Array.isArray(details.products) ? details.products : [];
      return <div className="stack compact-stack"><label>Products involved (leave blank to confirm none)<input value={products.map((item: any) => typeof item === "string" ? item : item.name).join(", ")} onChange={(event) => changeField(field.field_key, {...details, products: commaList(event.target.value).map((name) => ({name, selected: null}))})} placeholder="None" /></label>{products.filter((item: any) => item?.selected?.name).map((item: any) => <small className="evidence" key={item.name}>{item.name} matched to saved {item.selected.name}</small>)}</div>;
    }
    if (field.field_key === "skin_contact") return renderContact(field);
    return <pre>{JSON.stringify(value, null, 2)}</pre>;
  }

  const confirmedCount = requiredKeys.filter((key) => fields.find((field) => field.field_key === key)?.confirmation_state === "confirmed").length;
  const allConfirmed = requiredKeys.length > 0 && confirmedCount === requiredKeys.length;
  const imageCount = evidence.filter((item) => item.kind === "image").length;
  const voiceCount = evidence.filter((item) => item.kind === "voice").length;

  if (stage === "saved") {
    return <section className="card capture-complete"><span className="complete-mark">✓</span><h2>Occurrence saved</h2><p>The confirmed fields and original evidence are linked in trusted history.</p><StatusMessage error={error} success={success} /><button className="secondary" type="button" onClick={() => window.location.reload()}>Start another Quick Log</button></section>;
  }

  return (
    <section className="card smart-capture conversational-log">
      {stage === "capture" && (
        <div className="stack">
          {resumeCandidate && !captureId && (
            <aside className="resume-capture">
              <div><strong>Resume your Quick Log?</strong><small>{new Date(resumeCandidate.occurred_at).toLocaleString()} · {resumeCandidate.status}</small></div>
              <div className="button-row"><button type="button" className="primary small" disabled={busy} onClick={() => void resumeDraft()}>Resume</button><button type="button" className="text-button small" onClick={() => void discardResumeCandidate()}>Discard draft</button></div>
            </aside>
          )}
          <div className="capture-hero stack">
            <span className="eyebrow">One occurrence · any evidence</span>
            <h2>Show or tell Pajara what happened</h2>
            <p>Add a meal photo, product label, recipe screenshot, activity photo, or voice note. Mix them freely.</p>
            <div className="quick-capture-actions">
              <label className="primary capture-action">Take / add photos<input aria-label="Take or add photos" type="file" accept="image/*" multiple disabled={imageCount >= 8} onChange={(event: ChangeEvent<HTMLInputElement>) => { void addFiles(Array.from(event.target.files || []), "image"); event.target.value = ""; }} /></label>
              {!voice.recording ? <button className="secondary capture-action" type="button" disabled={voiceCount >= 4} onClick={() => void startVoice("evidence")}>Speak</button> : <button className="danger capture-action" type="button" onClick={() => void stopVoice()}>Stop recording</button>}
            </div>
            <small>{imageCount}/8 images · {voiceCount}/4 voice notes · 30 seconds each</small>
          </div>
          {evidence.length > 0 && <div className="mixed-evidence-grid">{evidence.map((item) => <article className="evidence-tile" key={item.localId}>{item.previewUrl ? <img src={item.previewUrl} alt="Quick Log evidence preview" /> : <div className="voice-evidence">♪ Voice note</div>}<span className={`status-pill ${item.status}`}>{item.kind === "voice" && item.status === "ready" ? item.transcription === "local" ? "transcribed" : item.transcription === "fallback" ? "backend selected" : item.transcription === "failed" ? "transcription failed" : item.status : item.status}</span>{item.error && <small>{item.error}</small>}<div className="button-row">{item.status === "error" && <button type="button" className="secondary small" onClick={() => void retryEvidence(item)}>Retry</button>}{item.transcription === "failed" && <button type="button" className="secondary small" onClick={() => { updateEvidence(item.localId, {transcription: "fallback"}); setError(null); }}>Use backend transcription</button>}<button type="button" className="text-button small" disabled={item.status === "uploading"} onClick={() => void removeEvidence(item)}>Remove</button></div></article>)}</div>}
          <label>Optional typed context<textarea rows={2} value={context} onChange={(event) => setContext(event.target.value)} placeholder="Anything the photos or voice might not make clear" /></label>
          <label>When did it happen?<div className="activity-time-row form-grid"><input type="datetime-local" value={occurred} onChange={(event) => setOccurred(event.target.value)} /><button type="button" className="secondary small" onClick={() => setOccurred(localDatetimeValue())}>Now</button></div></label>
          <StatusMessage error={error} success={success} />
          <div className="wizard-actions"><button className="text-button" type="button" onClick={onManual}>Enter manually</button><button className="primary" type="button" disabled={busy || voice.recording} onClick={() => profile.ai_enabled ? void review() : onManual()}>{busy ? "Reviewing…" : profile.ai_enabled ? "Review" : "Continue manually"}</button></div>
          {!profile.ai_enabled && <p className="status error">AI is disabled for this profile. Your detailed manual form remains available.</p>}
        </div>
      )}
      {stage === "processing" && <div className="capture-complete"><span className="complete-mark">…</span><h2>Making one clear occurrence</h2><p>Reading all evidence together and checking your saved items.</p><StatusMessage error={error} success={success} /></div>}
      {stage === "review" && (
        <div className="stack">
          <div className="section-heading"><div><span className="eyebrow">Confirm every card</span><h2>{confirmedCount} of {requiredKeys.length} confirmed</h2></div><span className="status-pill">Draft only</span></div>
          {requiredKeys.map((key) => {
            const field = fields.find((item) => item.field_key === key);
            if (!field) return null;
            return <article className={`subcard review-card ${field.confirmation_state}`} key={field.id}><div className="section-heading"><h3>{cardTitles[key] || key}</h3><span className="status-pill">{field.confirmation_state}</span></div>{renderField(field)}<button type="button" className={field.confirmation_state === "confirmed" ? "secondary" : "primary"} disabled={!isQuickLogFieldConfirmable(field)} onClick={() => void confirmField(field)}>{field.confirmation_state === "confirmed" ? "Confirmed ✓" : "Yes, confirm"}</button>{!isQuickLogFieldConfirmable(field) && <small className="evidence">Complete the short choices above before confirming.</small>}</article>;
          })}
          <section className="composer-card"><label>Tell Pajara anything to change<div className="composer-row"><textarea rows={2} value={composer} onChange={(event) => setComposer(event.target.value)} placeholder="e.g. This was yesterday, it was leftovers, and I wore gloves" /><button type="button" className="secondary" onClick={() => voice.recording ? void stopVoice() : void startVoice("correction")}>{voice.recording ? "Stop" : "Speak"}</button><button type="button" className="primary" disabled={busy || !composer.trim()} onClick={() => void sendCorrection(composer)}>Send</button></div></label>{pendingCorrectionVoice && <button type="button" className="secondary small" onClick={() => { setError(null); void sendCorrection("Voice correction (transcription pending)", pendingCorrectionVoice.artifactId, true).then(() => setPendingCorrectionVoice(null)); }}>Use backend transcription</button>}</section>
          <StatusMessage error={error} success={success} />
          <section className="save-summary"><h3>Ready to save</h3><p>{String(objectValue(fieldValue("identity")).name || "Occurrence")} · {String(fieldValue("occurrence_type") || "")}</p><button type="button" className="primary save-occurrence" disabled={!allConfirmed || busy} onClick={() => void saveOccurrence()}>{busy ? "Saving…" : "Save occurrence"}</button><small>Nothing enters trusted history until this button succeeds.</small></section>
          <button type="button" className="text-button" onClick={onManual}>Use detailed manual entry instead</button>
        </div>
      )}
    </section>
  );
}
