import {useEffect, useState} from "react";
import type {Session} from "@supabase/supabase-js";
import {apiPost} from "../lib/api";
import {uploadCaptureArtifact} from "../lib/artifacts";
import {parseIngredientNames} from "../lib/catalogue";
import {supabase} from "../lib/supabase";
import type {CaptureSession, Recipe, RecipeVersion} from "../types";
import {StatusMessage} from "./StatusMessage";

interface FoodLabelProposal {
  product_name?: string | null;
  brand?: string | null;
  variant?: string | null;
  ingredients?: Array<{name: string; confidence: number; evidence: string}>;
  warnings?: string[];
}

export interface ImportedFoodFormulation {
  recipeId: string;
  recipeVersionId: string;
  foodItemId: string;
  name: string;
  captureSessionId: string;
}

export function FoodLabelImporter({
  session,
  parentCaptureId,
  onImported,
}: {
  session: Session;
  parentCaptureId?: string | null;
  onImported: (formulation: ImportedFoodFormulation) => void;
}) {
  const [open, setOpen] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [capture, setCapture] = useState<CaptureSession | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [ingredients, setIngredients] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  function resetPhoto(next: File | null) {
    if (preview) URL.revokeObjectURL(preview);
    setPhoto(next);
    setPreview(next ? URL.createObjectURL(next) : null);
    setCapture(null);
    setArtifactId(null);
    setName("");
    setIngredients("");
    setWarnings([]);
    setError(null);
    setSuccess(null);
  }

  async function pollForProposal(captureId: string) {
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
        throw new Error(current.error || "The ingredient label could not be read.");
      }
      if (current.status === "ready") {
        const proposal = (current.attributes?.food_label_proposal || {}) as FoodLabelProposal;
        const proposedName = [proposal.brand, proposal.product_name, proposal.variant]
          .filter(Boolean)
          .filter((value, index, values) => values.indexOf(value) === index)
          .join(" ");
        setName(proposedName);
        setIngredients((proposal.ingredients || []).map(({name: itemName}) => itemName).join("\n"));
        setWarnings(proposal.warnings || []);
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    throw new Error("Label reading is taking longer than expected. Please try again.");
  }

  async function readLabel() {
    if (!photo) {
      setError("Take or choose a clear ingredient-label photo first.");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const now = new Date().toISOString();
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const {data: created, error: captureError} = await supabase
        .from("capture_sessions")
        .insert({
          user_id: session.user.id,
          profile_id: null,
          source_type: "photo",
          occurred_at: now,
          recorded_timezone: timezone,
          status: "draft",
          attributes: {
            capture_purpose: "food_label",
            parent_capture_session_id: parentCaptureId || null,
          },
        })
        .select()
        .single();
      if (captureError) throw captureError;
      const createdCapture = created as CaptureSession;
      const uploadedArtifactId = await uploadCaptureArtifact(
        session,
        createdCapture.id,
        photo,
        "photo",
        "ingredient_label",
      );
      const {error: linkError} = await supabase
        .from("capture_sessions")
        .update({artifact_id: uploadedArtifactId})
        .eq("id", createdCapture.id);
      if (linkError) throw linkError;
      setCapture({...createdCapture, artifact_id: uploadedArtifactId});
      setArtifactId(uploadedArtifactId);
      await apiPost("/v1/jobs/capture-extraction", session, {
        capture_session_id: createdCapture.id,
        mode: "food_label",
      });
      await pollForProposal(createdCapture.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read the ingredient label.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmFormulation() {
    const ingredientNames = parseIngredientNames(ingredients);
    if (!capture || !name.trim() || ingredientNames.length === 0) {
      setError("Confirm a product name and at least one ingredient.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const {data, error: saveError} = await supabase.rpc("save_recipe_definition", {
        recipe_name: name.trim(),
        components: ingredientNames.map((ingredientName) => ({
          name: ingredientName,
          provenance: {
            method: "ingredient_label_confirmation",
            capture_session_id: capture.id,
            artifact_id: artifactId,
            reviewed_by_user: true,
          },
        })),
        instructions: null,
        yield_amount: null,
        yield_unit: null,
        existing_recipe_id: null,
        derived_from_id: null,
        recipe_attributes: {
          output_food_kind: "commercial_product",
          created_from_capture_session_id: capture.id,
          source_artifact_id: artifactId,
        },
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
      const {error: confirmError} = await supabase
        .from("capture_sessions")
        .update({status: "confirmed", confirmed_at: new Date().toISOString()})
        .eq("id", capture.id);
      if (confirmError) throw confirmError;
      onImported({
        recipeId: recipe.id,
        recipeVersionId: version.id,
        foodItemId: recipe.output_food_item_id,
        name: recipe.name,
        captureSessionId: capture.id,
      });
      setSuccess(`${recipe.name} was reviewed and added as a sub-recipe.`);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this packaged food.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="food-label-importer stack">
      <button type="button" className="secondary small" onClick={() => setOpen((current) => !current)}>
        {open ? "Close label import" : "Photograph a packaged-food label"}
      </button>
      <StatusMessage error={error} success={success} />
      {open && (
        <div className="subcard stack">
          <label className="upload-zone">
            <strong>Ingredient label photo</strong>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(event) => resetPhoto(event.target.files?.[0] || null)}
            />
            {preview
              ? <img className="capture-preview" src={preview} alt="Packaged food ingredient label" />
              : <span>Fill the frame with the product name and full ingredients list.</span>}
          </label>
          {!capture || !["ready", "confirmed"].includes(capture.status) ? (
            <button type="button" className="secondary" disabled={busy || !photo} onClick={() => void readLabel()}>
              {busy ? "Reading label…" : "Read label"}
            </button>
          ) : (
            <>
              <label>
                Product name
                <input value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label>
                Confirmed ingredients
                <textarea rows={7} value={ingredients} onChange={(event) => setIngredients(event.target.value)} />
                <span className="field-help">One ingredient per line. Correct OCR or AI mistakes before saving.</span>
              </label>
              {warnings.length > 0 && <p className="field-help">{warnings.join(" ")}</p>}
              <button type="button" className="primary" disabled={busy} onClick={() => void confirmFormulation()}>
                {busy ? "Saving…" : "Confirm packaged food"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
