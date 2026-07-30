import {useCallback, useEffect, useMemo, useRef, useState, type FormEvent} from "react";
import type {Session} from "@supabase/supabase-js";
import {apiPost} from "../lib/api";
import {uploadConceptArtifact} from "../lib/artifacts";
import {
  catalogueReviewDefaults,
  formatRecipeIngredientLine,
  isSameSuggestion,
  mergeRecipeIngredientLines,
  parseIngredientNames,
  parseRecipeIngredientLines,
} from "../lib/catalogue";
import {supabase} from "../lib/supabase";
import type {
  CatalogueExtraction,
  CatalogueItem,
  CatalogueItemType,
  ConceptVersion,
} from "../types";
import {StatusMessage} from "./StatusMessage";

interface CompositionRow {
  owner_concept_id: string;
  owner_version_id: string | null;
  component_concept_id: string;
  component_order: number | null;
  amount: number | null;
  unit: string | null;
  concentration: string | null;
}

const itemTypeLabels: Record<CatalogueItemType, string> = {
  product: "Personal / household product",
  medication: "Medication",
  treatment: "Cream / topical treatment",
  recipe: "Meal / recipe",
};

export function Catalogue({
  session,
  refreshKey,
  onChanged,
}: {
  session: Session;
  refreshKey: number;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<CatalogueItem[]>([]);
  const [versions, setVersions] = useState<ConceptVersion[]>([]);
  const [compositions, setCompositions] = useState<CompositionRow[]>([]);
  const [ingredientLookup, setIngredientLookup] = useState<Record<string, string>>({});
  const [extractions, setExtractions] = useState<CatalogueExtraction[]>([]);
  const [labelPreviewUrls, setLabelPreviewUrls] = useState<Record<string, string>>({});
  const [type, setType] = useState<CatalogueItemType>("product");
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [variant, setVariant] = useState("");
  const [category, setCategory] = useState("");
  const [form, setForm] = useState("");
  const [strength, setStrength] = useState("");
  const [servings, setServings] = useState("");
  const [preparationNotes, setPreparationNotes] = useState("");
  const [ingredients, setIngredients] = useState("");
  const [frontPhoto, setFrontPhoto] = useState<File | null>(null);
  const [labelPhoto, setLabelPhoto] = useState<File | null>(null);
  const [requestAi, setRequestAi] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [derivedFromId, setDerivedFromId] = useState<string | null>(null);
  const [reviewEdits, setReviewEdits] = useState<
    Record<string, {name: string; brand: string; variant: string; ingredients: string}>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const initializedCreateState = useRef(false);
  const editorRef = useRef<HTMLFormElement>(null);

  const load = useCallback(async () => {
    const [itemsResult, versionsResult, compositionsResult, ingredientsResult, extractionResult] =
      await Promise.all([
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
        supabase
          .from("compositions")
          .select(
            "owner_concept_id,owner_version_id,component_concept_id,component_order,amount,unit,concentration",
          )
          .in("review_state", ["accepted", "corrected"])
          .order("component_order"),
        supabase
          .from("concepts")
          .select("id,canonical_name")
          .eq("concept_type", "ingredient"),
        supabase
          .from("catalogue_extractions")
          .select("*")
          .eq("review_state", "proposed")
          .order("created_at"),
      ]);
    const loadError =
      itemsResult.error
      || versionsResult.error
      || compositionsResult.error
      || ingredientsResult.error
      || extractionResult.error;
    if (loadError) {
      setError(loadError.message);
      return;
    }
    const loadedItems = (itemsResult.data || []) as CatalogueItem[];
    setItems(loadedItems);
    if (!initializedCreateState.current) {
      setShowCreate(loadedItems.length === 0);
      initializedCreateState.current = true;
    }
    setVersions((versionsResult.data || []) as ConceptVersion[]);
    setCompositions((compositionsResult.data || []) as CompositionRow[]);
    setIngredientLookup(
      Object.fromEntries(
        (ingredientsResult.data || []).map((item) => [
          item.id as string,
          item.canonical_name as string,
        ]),
      ),
    );
    const pendingExtractions = (extractionResult.data || []) as CatalogueExtraction[];
    setExtractions(pendingExtractions);
    const artifactIds = pendingExtractions.map((item) => item.artifact_id);
    if (artifactIds.length === 0) {
      setLabelPreviewUrls({});
      return;
    }
    const {data: artifacts, error: artifactsError} = await supabase
      .from("artifacts")
      .select("id,bucket,object_path")
      .in("id", artifactIds);
    if (artifactsError) {
      setError(artifactsError.message);
      return;
    }
    const signed = await Promise.all(
      (artifacts || []).map(async (artifact) => {
        const {data} = await supabase.storage
          .from(artifact.bucket as string)
          .createSignedUrl(artifact.object_path as string, 900);
        return [artifact.id as string, data?.signedUrl || ""] as const;
      }),
    );
    setLabelPreviewUrls(Object.fromEntries(signed.filter(([, url]) => Boolean(url))));
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!extractions.some(({status}) => status === "queued" || status === "running")) {
      return;
    }
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [extractions, load]);

  const currentVersionByConcept = useMemo(
    () =>
      Object.fromEntries(
        versions.map((version) => [version.concept_id, version]),
      ) as Record<string, ConceptVersion>,
    [versions],
  );
  const hasActionableReview = extractions.some(
    ({status}) => status === "queued" || status === "running" || status === "succeeded",
  );

  function currentIngredientNames(conceptId: string): string[] {
    const version = currentVersionByConcept[conceptId];
    return compositions
      .filter(
        (row) =>
          row.owner_concept_id === conceptId
          && (!version || row.owner_version_id === version.id),
      )
      .map((row) => ingredientLookup[row.component_concept_id])
      .filter(Boolean);
  }

  function currentCompositionText(item: CatalogueItem): string {
    const version = currentVersionByConcept[item.id];
    const rows = compositions.filter(
      (row) =>
        row.owner_concept_id === item.id
        && (!version || row.owner_version_id === version.id),
    );
    if (item.concept_type === "recipe") {
      return rows
        .map((row) => {
          const ingredientName = ingredientLookup[row.component_concept_id];
          return ingredientName
            ? formatRecipeIngredientLine(ingredientName, row.amount, row.unit)
            : "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return rows
      .map((row) => ingredientLookup[row.component_concept_id])
      .filter(Boolean)
      .join("\n");
  }

  function resetCreateForm() {
    setName("");
    setBrand("");
    setVariant("");
    setCategory("");
    setForm("");
    setStrength("");
    setServings("");
    setPreparationNotes("");
    setIngredients("");
    setFrontPhoto(null);
    setLabelPhoto(null);
    setEditingItemId(null);
    setDerivedFromId(null);
  }

  function showEditor() {
    setShowCreate(true);
    window.setTimeout(
      () => editorRef.current?.scrollIntoView({behavior: "smooth", block: "start"}),
      0,
    );
  }

  function startEdit(item: CatalogueItem) {
    setType(item.concept_type);
    setName(item.canonical_name);
    setBrand(item.attributes.brand || "");
    setVariant(item.attributes.variant || "");
    setCategory(item.attributes.category || "");
    setForm(item.attributes.form || "");
    setStrength(item.attributes.strength || "");
    setServings(
      item.attributes.servings === undefined ? "" : String(item.attributes.servings),
    );
    setPreparationNotes(item.attributes.preparation_notes || "");
    setIngredients(currentCompositionText(item));
    setEditingItemId(item.id);
    setDerivedFromId(null);
    setFrontPhoto(null);
    setLabelPhoto(null);
    setError(null);
    setSuccess(null);
    showEditor();
  }

  function startVariation(item: CatalogueItem) {
    setType("recipe");
    setName(`${item.canonical_name} variation`);
    setBrand("");
    setVariant("");
    setCategory(item.attributes.category || "");
    setForm("");
    setStrength("");
    setServings(
      item.attributes.servings === undefined ? "" : String(item.attributes.servings),
    );
    setPreparationNotes(item.attributes.preparation_notes || "");
    setIngredients(currentCompositionText(item));
    setEditingItemId(null);
    setDerivedFromId(item.id);
    setFrontPhoto(null);
    setLabelPhoto(null);
    setError(null);
    setSuccess(null);
    showEditor();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const editingItem = items.find((item) => item.id === editingItemId);
    const duplicate = items.find(
      (item) =>
        item.id !== editingItemId
        &&
        item.canonical_name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()
        && (item.attributes.brand || "").trim().toLocaleLowerCase()
          === brand.trim().toLocaleLowerCase()
        && (item.attributes.variant || "").trim().toLocaleLowerCase()
          === variant.trim().toLocaleLowerCase(),
    );
    if (
      duplicate
      && !window.confirm(
        `${duplicate.canonical_name} is already saved with the same brand and variant. `
          + "Create another separate item anyway?",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const parsedIngredients =
        type === "recipe"
          ? parseRecipeIngredientLines(ingredients)
          : parseIngredientNames(ingredients);
      const {data: concept, error: createError} = await supabase.rpc(
        "save_catalogue_item",
        {
          item_type: type,
          item_name: name,
          item_attributes: {
            brand: brand.trim(),
            variant: variant.trim(),
            category: category.trim(),
            form: form.trim(),
            strength: strength.trim(),
            servings: servings ? Number(servings) : null,
            preparation_notes: preparationNotes.trim(),
            favorite: editingItem?.attributes.favorite || false,
          },
          ingredients: parsedIngredients,
          catalogue_item_id: editingItemId,
          derived_from_id: derivedFromId,
        },
      );
      if (createError) throw createError;
      const created = (
        Array.isArray(concept) ? concept[0] : concept
      ) as CatalogueItem | undefined;
      if (!created) throw new Error("The catalogue item was not returned after saving.");
      const {data: version, error: versionError} = await supabase
        .from("concept_versions")
        .select("id")
        .eq("concept_id", created.id)
        .is("effective_to", null)
        .single();
      if (versionError) throw versionError;

      const postSaveWarnings: string[] = [];
      if (frontPhoto) {
        try {
          await uploadConceptArtifact(
            session,
            created.id,
            version.id as string,
            frontPhoto,
            "product_front",
          );
        } catch {
          postSaveWarnings.push("the front photo did not upload");
        }
      }
      if (labelPhoto) {
        try {
          const artifactId = await uploadConceptArtifact(
            session,
            created.id,
            version.id as string,
            labelPhoto,
            "ingredient_label",
          );
          if (requestAi) {
            try {
              await apiPost("/v1/jobs/catalogue-extraction", session, {
                concept_id: created.id,
                artifact_id: artifactId,
              });
            } catch {
              postSaveWarnings.push("AI label extraction was not queued");
            }
          }
        } catch {
          postSaveWarnings.push("the ingredient-label photo did not upload");
        }
      }
      const completedEdit = Boolean(editingItemId);
      const completedVariation = Boolean(derivedFromId);
      resetCreateForm();
      setShowCreate(false);
      setSuccess(
        labelPhoto && requestAi && postSaveWarnings.length === 0
          ? `${
              completedEdit
                ? "Changes saved."
                : completedVariation
                  ? "Recipe variation created."
                  : "Saved."
            } The image extraction is queued and must be reviewed.`
          : completedEdit
            ? "Saved item updated. Earlier logged versions were retained."
            : completedVariation
              ? "Recipe variation created and linked to the original."
              : "Saved to your catalogue.",
      );
      if (postSaveWarnings.length > 0) {
        setError(`The item was saved, but ${postSaveWarnings.join(" and ")}.`);
      }
      await load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the catalogue item.");
    } finally {
      setBusy(false);
    }
  }

  function extractionEdit(extraction: CatalogueExtraction) {
    const item = items.find((candidate) => candidate.id === extraction.concept_id);
    if (item?.concept_type === "recipe") {
      return (
        reviewEdits[extraction.id]
        || {
          name:
            item.canonical_name.trim()
            || extraction.proposal?.product_name?.trim()
            || "",
          brand: "",
          variant: "",
          ingredients: mergeRecipeIngredientLines(
            currentCompositionText(item),
            extraction.proposal?.ingredients || [],
          ),
        }
      );
    }
    return (
      reviewEdits[extraction.id]
      || catalogueReviewDefaults(
        item,
        extraction.proposal,
        currentIngredientNames(extraction.concept_id),
      )
    );
  }

  async function review(
    extraction: CatalogueExtraction,
    decision: "corrected" | "rejected",
  ) {
    const edit = extractionEdit(extraction);
    const reviewedItem = items.find((item) => item.id === extraction.concept_id);
    setBusy(true);
    setError(null);
    try {
      const parsedIngredients =
        reviewedItem?.concept_type === "recipe"
          ? parseRecipeIngredientLines(edit.ingredients)
          : parseIngredientNames(edit.ingredients).map((ingredientName) => ({
              name: ingredientName,
            }));
      const reviewedIngredients = parsedIngredients.map((ingredient) => {
        const proposed = extraction.proposal?.ingredients?.find(
          (item) => item.name.toLocaleLowerCase() === ingredient.name.toLocaleLowerCase(),
        );
        return proposed
          ? {
              ...ingredient,
              confidence: proposed.confidence,
              evidence: proposed.evidence,
            }
          : ingredient;
      });
      const {error: reviewError} = await supabase.rpc("review_catalogue_extraction", {
        extraction_id: extraction.id,
        decision,
        reviewed_name: edit.name,
        reviewed_brand: edit.brand,
        reviewed_variant: edit.variant,
        reviewed_ingredients: reviewedIngredients,
      });
      if (reviewError) throw reviewError;
      setReviewEdits((current) => {
        const next = {...current};
        delete next[extraction.id];
        return next;
      });
      setSuccess(
        decision === "rejected"
          ? "Proposal rejected. Your existing catalogue data was unchanged."
          : reviewedItem?.concept_type === "recipe"
            ? "Reviewed recipe image saved as a new recipe version."
            : "Reviewed label saved as a new product version.",
      );
      await load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not review the label.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleFavorite(item: CatalogueItem) {
    const {error: updateError} = await supabase
      .from("concepts")
      .update({
        attributes: {...item.attributes, favorite: !item.attributes.favorite},
      })
      .eq("id", item.id);
    if (updateError) setError(updateError.message);
    else {
      await load();
      onChanged();
    }
  }

  async function archive(item: CatalogueItem) {
    if (!window.confirm(`Archive ${item.canonical_name}? Existing logs will be retained.`)) return;
    const {error: updateError} = await supabase
      .from("concepts")
      .update({archived_at: new Date().toISOString()})
      .eq("id", item.id);
    if (updateError) setError(updateError.message);
    else {
      await load();
      onChanged();
    }
  }

  async function dismissFailedExtraction(extraction: CatalogueExtraction) {
    const {error: deleteError} = await supabase
      .from("catalogue_extractions")
      .delete()
      .eq("id", extraction.id)
      .eq("status", "failed");
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setSuccess("Failed AI attempt dismissed. The saved item and label image were retained.");
    await load();
  }

  return (
    <section className="page">
      <header className="page-header">
        <div><span className="eyebrow">Reusable exposures</span><h1>Saved items</h1></div>
        <div className="saved-items-header-actions">
          <p>
            Save products and recipes once, then select the exact version whenever you use them.
          </p>
          {!showCreate && !hasActionableReview && (
            <button
              className="primary"
              onClick={() => {
                setError(null);
                setSuccess(null);
                setShowCreate(true);
              }}
            >
              Add a new item
            </button>
          )}
        </div>
      </header>
      <StatusMessage error={error} success={success} />

      {showCreate && (
        <form className="stack card create-item-card" onSubmit={submit} ref={editorRef}>
          <div className="section-heading">
            <div>
              <span className="eyebrow">
                {editingItemId
                  ? "Versioned correction"
                  : derivedFromId
                    ? "Recipe variation"
                    : "New catalogue entry"}
              </span>
              <h2>
                {editingItemId
                  ? `Edit ${name}`
                  : derivedFromId
                    ? "Create recipe variation"
                    : "Create a saved item"}
              </h2>
            </div>
            {items.length > 0 && (
              <button
                type="button"
                className="secondary small"
                onClick={() => {
                  resetCreateForm();
                  setShowCreate(false);
                }}
              >
                Cancel
              </button>
            )}
          </div>
          <p className="evidence">
            {editingItemId
              ? "Saving creates a new version of this same item. Earlier logged events keep "
                + "the version that was used at the time."
              : derivedFromId
                ? "This creates a separate recipe linked to its source, so future changes "
                  + "do not alter the original meal."
                : "This creates one reusable item. If you add an image, its AI review will "
                  + "update this same item rather than creating another."}
          </p>
          <div className="form-grid">
          <label>
            Item type
            <select
              value={type}
              disabled={Boolean(editingItemId || derivedFromId)}
              onChange={(event) => setType(event.target.value as CatalogueItemType)}
            >
              {Object.entries(itemTypeLabels).map(([value, label]) => (
                <option value={value} key={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            {type === "recipe" ? "Meal or recipe name" : "Product or medication name"}
            <input required value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          {type !== "recipe" && (
            <>
              <label>
                Brand
                <input value={brand} onChange={(event) => setBrand(event.target.value)} />
              </label>
              <label>
                Variant
                <input
                  value={variant}
                  onChange={(event) => setVariant(event.target.value)}
                  placeholder="e.g. fragrance free, sensitive"
                />
              </label>
            </>
          )}
          <label>
            Category
            <input
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              placeholder={
                type === "recipe"
                  ? "e.g. breakfast, pasta, soup"
                  : "e.g. shampoo, washing-up liquid, moisturiser"
              }
            />
          </label>
          {(type === "medication" || type === "treatment") && (
            <>
              <label>
                Form
                <input
                  value={form}
                  onChange={(event) => setForm(event.target.value)}
                  placeholder="e.g. cream, ointment, tablet"
                />
              </label>
              <label>
                Strength
                <input
                  value={strength}
                  onChange={(event) => setStrength(event.target.value)}
                  placeholder="e.g. 1%, 10 mg"
                />
              </label>
            </>
          )}
          {type === "recipe" && (
            <label>
              Servings
              <input
                type="number"
                min="0"
                step="any"
                value={servings}
                onChange={(event) => setServings(event.target.value)}
              />
            </label>
          )}
          </div>
          <label>
            {type === "recipe" ? "Recipe ingredients" : "Known ingredients"}
            <textarea
              rows={type === "recipe" ? 7 : 4}
              value={ingredients}
              onChange={(event) => setIngredients(event.target.value)}
              placeholder={
                type === "recipe"
                  ? "One per line: ingredient | amount | unit\ne.g. Pasta | 200 | g"
                  : "One ingredient per line, or paste a comma-separated list"
              }
            />
          </label>
          {type === "recipe" && (
            <label>
              Preparation notes
              <textarea
                rows={4}
                value={preparationNotes}
                onChange={(event) => setPreparationNotes(event.target.value)}
                placeholder="Method, substitutions, cooking details, or anything that defines this meal"
              />
            </label>
          )}
          <div className="form-grid">
          <label className="upload-zone">
            <strong>{type === "recipe" ? "Meal photo" : "Front photo"}</strong>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(event) => setFrontPhoto(event.target.files?.[0] || null)}
            />
            <span>
              {type === "recipe"
                ? "Optional reference photo for the saved meal."
                : "Optional product identity and packaging reference."}
            </span>
          </label>
          <label className="upload-zone">
            <strong>
              {type === "recipe" ? "Recipe / ingredient photo" : "Ingredient-label photo"}
            </strong>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(event) => setLabelPhoto(event.target.files?.[0] || null)}
            />
            <span>The original image is retained privately.</span>
          </label>
          </div>
          {labelPhoto && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={requestAi}
                onChange={(event) => setRequestAi(event.target.checked)}
              />
              <span>
                Ask AI to read this {type === "recipe" ? "recipe image" : "label"}.
                Extracted fields remain proposals until reviewed.
              </span>
            </label>
          )}
          <button className="primary" disabled={busy || !name.trim()}>
            {busy
              ? "Saving…"
              : editingItemId
                ? "Save changes"
                : derivedFromId
                  ? "Create variation"
                  : "Create saved item"}
          </button>
        </form>
      )}

      {extractions.length > 0 && (
        <section className="catalogue-section">
          <div className="section-heading">
            <div><span className="eyebrow">Human confirmation</span><h2>Image review</h2></div>
            <button className="secondary small" onClick={() => void load()}>Refresh</button>
          </div>
          <div className="stack">
            {extractions.map((extraction) => {
              const edit = extractionEdit(extraction);
              const reviewedItem = items.find((item) => item.id === extraction.concept_id);
              const isRecipe = reviewedItem?.concept_type === "recipe";
              return (
                <article className="card" key={extraction.id}>
                  <div className="timeline-title">
                    <h2>{reviewedItem?.canonical_name || "Saved item image"}</h2>
                    <span className={`trust ${extraction.status}`}>{extraction.status}</span>
                  </div>
                  {extraction.status === "failed" ? (
                    <div className="stack">
                      <p className="status error">
                        Extraction failed. Your original image and manually entered data remain
                        stored.
                      </p>
                      <button
                        className="secondary small dismiss-extraction"
                        onClick={() => void dismissFailedExtraction(extraction)}
                      >
                        Dismiss failed attempt
                      </button>
                    </div>
                  ) : extraction.status !== "succeeded" ? (
                      <p className="evidence">The worker is processing this private image.</p>
                  ) : (
                    <div className="stack">
                      <div className="review-merge-notice">
                        <strong>Updating the existing saved item</strong>
                        <span>
                          Your manually entered information is kept by default. AI suggestions
                          only change this item after you review and save them here.
                        </span>
                      </div>
                      {labelPreviewUrls[extraction.artifact_id] && (
                        <figure className="label-preview">
                          <img
                            src={labelPreviewUrls[extraction.artifact_id]}
                            alt={
                              isRecipe
                                ? "Original private recipe or ingredient photograph"
                                : "Original private ingredient-label photograph"
                            }
                          />
                          <figcaption>
                            Original label · private link expires after 15 minutes
                          </figcaption>
                        </figure>
                      )}
                      <div className="form-grid">
                        <label>
                          {isRecipe ? "Meal or recipe name" : "Product name"}
                          <input
                            value={edit.name}
                            onChange={(event) =>
                              setReviewEdits({
                                ...reviewEdits,
                                [extraction.id]: {...edit, name: event.target.value},
                              })}
                          />
                          {extraction.proposal?.product_name
                            && !isSameSuggestion(edit.name, extraction.proposal.product_name) && (
                            <button
                              type="button"
                              className="suggestion-button"
                              onClick={() =>
                                setReviewEdits({
                                  ...reviewEdits,
                                  [extraction.id]: {
                                    ...edit,
                                    name: extraction.proposal?.product_name || edit.name,
                                  },
                                })}
                            >
                              Use AI suggestion: {extraction.proposal.product_name}
                            </button>
                          )}
                        </label>
                        {!isRecipe && (
                          <>
                            <label>
                              Brand
                              <input
                                value={edit.brand}
                                onChange={(event) =>
                                  setReviewEdits({
                                    ...reviewEdits,
                                    [extraction.id]: {...edit, brand: event.target.value},
                                  })}
                              />
                              {extraction.proposal?.brand
                                && !isSameSuggestion(edit.brand, extraction.proposal.brand) && (
                                <button
                                  type="button"
                                  className="suggestion-button"
                                  onClick={() =>
                                    setReviewEdits({
                                      ...reviewEdits,
                                      [extraction.id]: {
                                        ...edit,
                                        brand: extraction.proposal?.brand || edit.brand,
                                      },
                                    })}
                                >
                                  Use AI suggestion: {extraction.proposal.brand}
                                </button>
                              )}
                            </label>
                            <label>
                              Variant
                              <input
                                value={edit.variant}
                                onChange={(event) =>
                                  setReviewEdits({
                                    ...reviewEdits,
                                    [extraction.id]: {...edit, variant: event.target.value},
                                  })}
                              />
                              {extraction.proposal?.variant
                                && !isSameSuggestion(edit.variant, extraction.proposal.variant) && (
                                <button
                                  type="button"
                                  className="suggestion-button"
                                  onClick={() =>
                                    setReviewEdits({
                                      ...reviewEdits,
                                      [extraction.id]: {
                                        ...edit,
                                        variant: extraction.proposal?.variant || edit.variant,
                                      },
                                    })}
                                >
                                  Use AI suggestion: {extraction.proposal.variant}
                                </button>
                              )}
                            </label>
                          </>
                        )}
                      </div>
                      <div className="extraction-confidence">
                        {extraction.proposal?.product_name_confidence !== null
                          && extraction.proposal?.product_name_confidence !== undefined && (
                          <p className="evidence">
                            {isRecipe ? "Recipe name" : "Product name"}: {Math.round(
                              extraction.proposal.product_name_confidence * 100,
                            )}% extraction confidence
                            {extraction.proposal.product_name_evidence
                              ? ` · “${extraction.proposal.product_name_evidence}”`
                              : ""}
                          </p>
                        )}
                        {!isRecipe
                          && extraction.proposal?.brand_confidence !== null
                          && extraction.proposal?.brand_confidence !== undefined && (
                          <p className="evidence">
                            Brand: {Math.round(extraction.proposal.brand_confidence * 100)}%
                            extraction confidence
                            {extraction.proposal.brand_evidence
                              ? ` · “${extraction.proposal.brand_evidence}”`
                              : ""}
                          </p>
                        )}
                        {!isRecipe
                          && extraction.proposal?.variant_confidence !== null
                          && extraction.proposal?.variant_confidence !== undefined && (
                          <p className="evidence">
                            Variant: {Math.round(extraction.proposal.variant_confidence * 100)}%
                            extraction confidence
                            {extraction.proposal.variant_evidence
                              ? ` · “${extraction.proposal.variant_evidence}”`
                              : ""}
                          </p>
                        )}
                      </div>
                      <label>
                        {isRecipe ? "Recipe ingredients" : "Ordered ingredients"}
                        <textarea
                          rows={7}
                          value={edit.ingredients}
                          onChange={(event) =>
                            setReviewEdits({
                              ...reviewEdits,
                              [extraction.id]: {...edit, ingredients: event.target.value},
                            })}
                      />
                        <span className="field-help">
                          Existing ingredients
                          {isRecipe ? " and quantities " : " "}
                          are retained and new AI readings are merged in.
                          Remove a line here only if you intend to remove it from the new
                          formulation version.
                        </span>
                      </label>
                      {(extraction.proposal?.ingredients || []).length > 0 && (
                        <details className="ingredient-evidence">
                          <summary>Show AI ingredient evidence and confidence</summary>
                          {(extraction.proposal?.ingredients || []).map((ingredient, index) => (
                            <p className="evidence" key={`${ingredient.name}-${index}`}>
                              {ingredient.name}: {Math.round(ingredient.confidence * 100)}%
                              extraction confidence
                              {ingredient.evidence ? ` · “${ingredient.evidence}”` : ""}
                            </p>
                          ))}
                        </details>
                      )}
                      {(extraction.proposal?.warnings || []).map((warning) => (
                        <p className="evidence" key={warning}>Warning: {warning}</p>
                      ))}
                      <p className="evidence">
                        Confidence is transcription certainty, not evidence that an ingredient
                        affects your skin. Review the label itself before accepting.
                      </p>
                      <div className="button-row">
                        <button
                          className="primary small"
                          disabled={busy}
                          onClick={() => void review(extraction, "corrected")}
                        >
                          {busy ? "Saving…" : `Save reviewed ${isRecipe ? "recipe" : "label"}`}
                        </button>
                        <button
                          className="text-button small"
                          disabled={busy}
                          onClick={() => void review(extraction, "rejected")}
                        >
                          Discard AI suggestion
                        </button>
                      </div>
                      <p className="evidence">
                        Saving updates {reviewedItem?.canonical_name || "this saved item"} and
                        creates a formulation history entry. It does not create a second item.
                      </p>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      <section className="catalogue-section">
        <div className="section-heading">
          <div><span className="eyebrow">Your catalogue</span><h2>Available for logging</h2></div>
        </div>
        {items.length === 0 ? (
          <div className="empty"><h2>No saved items yet</h2><p>Add the first one above.</p></div>
        ) : (
          <div className="catalogue-grid">
            {items.map((item) => {
              const version = currentVersionByConcept[item.id];
              const names = compositions
                .filter(
                  (row) =>
                    row.owner_concept_id === item.id
                    && (!version || row.owner_version_id === version.id),
                )
                .map((row) => ingredientLookup[row.component_concept_id])
                .filter(Boolean);
              const recipeLines =
                item.concept_type === "recipe"
                  ? currentCompositionText(item).split("\n").filter(Boolean)
                  : [];
              return (
                <article className="card catalogue-item" key={item.id}>
                  <div className="catalogue-item-heading">
                    <div>
                      <span className="eyebrow">{itemTypeLabels[item.concept_type]}</span>
                      <h2>{item.canonical_name}</h2>
                    </div>
                    <button
                      className="favorite-button"
                      aria-label={item.attributes.favorite ? "Remove favorite" : "Add favorite"}
                      onClick={() => void toggleFavorite(item)}
                    >
                      {item.attributes.favorite ? "★" : "☆"}
                    </button>
                  </div>
                  {item.attributes.brand && <p>{item.attributes.brand}</p>}
                  <div className="item-meta">
                    {item.attributes.category && <span>{item.attributes.category}</span>}
                    {item.attributes.variant && <span>{item.attributes.variant}</span>}
                    {item.attributes.form && <span>{item.attributes.form}</span>}
                    {item.attributes.strength && <span>{item.attributes.strength}</span>}
                    {item.attributes.servings !== undefined
                      && item.attributes.servings !== null && (
                      <span>{item.attributes.servings} servings</span>
                    )}
                    {version && (
                      <span>
                        {item.concept_type === "recipe" ? "recipe" : "formulation"}{" "}
                        v{version.version_number}
                      </span>
                    )}
                  </div>
                  <p className="evidence">
                    {recipeLines.length > 0
                      ? `${recipeLines.length} ingredient${recipeLines.length === 1 ? "" : "s"}: ${recipeLines.slice(0, 4).join(", ")}${recipeLines.length > 4 ? "…" : ""}`
                      : names.length > 0
                        ? `${names.length} ingredient${names.length === 1 ? "" : "s"}: ${names.slice(0, 5).join(", ")}${names.length > 5 ? "…" : ""}`
                      : "No reviewed ingredient list yet."}
                  </p>
                  {item.concept_type === "recipe" && item.attributes.preparation_notes && (
                    <p className="recipe-preparation-notes">
                      {item.attributes.preparation_notes}
                    </p>
                  )}
                  <div className="button-row catalogue-item-actions">
                    <button className="secondary small" onClick={() => startEdit(item)}>
                      Edit
                    </button>
                    {item.concept_type === "recipe" && (
                      <button className="secondary small" onClick={() => startVariation(item)}>
                        Create variation
                      </button>
                    )}
                    <button className="text-button small" onClick={() => void archive(item)}>
                      Archive
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}
