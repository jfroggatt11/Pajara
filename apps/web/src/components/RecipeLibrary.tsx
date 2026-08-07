import {useCallback, useEffect, useMemo, useState, type FormEvent} from "react";
import type {Session} from "@supabase/supabase-js";
import {supabase} from "../lib/supabase";
import type {FoodItem, Recipe, RecipeComponent, RecipeVersion} from "../types";
import {FoodLabelImporter} from "./FoodLabelImporter";
import {StatusMessage} from "./StatusMessage";

interface ComponentEdit {
  key: string;
  kind: "food" | "recipe";
  name: string;
  sourceRecipeVersionId: string;
  amount: string;
  unit: string;
  optional: boolean;
}

function emptyComponent(): ComponentEdit {
  return {
    key: crypto.randomUUID(),
    kind: "food",
    name: "",
    sourceRecipeVersionId: "",
    amount: "",
    unit: "",
    optional: false,
  };
}

export function RecipeLibrary({
  session,
  refreshKey,
  onChanged,
}: {
  session: Session;
  refreshKey: number;
  onChanged: () => void;
}) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [versions, setVersions] = useState<RecipeVersion[]>([]);
  const [components, setComponents] = useState<RecipeComponent[]>([]);
  const [foods, setFoods] = useState<FoodItem[]>([]);
  const [showEditor, setShowEditor] = useState(false);
  const [editingRecipeId, setEditingRecipeId] = useState<string | null>(null);
  const [derivedFromId, setDerivedFromId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [yieldAmount, setYieldAmount] = useState("");
  const [yieldUnit, setYieldUnit] = useState("");
  const [componentEdits, setComponentEdits] = useState<ComponentEdit[]>([emptyComponent()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [recipeResult, versionResult, componentResult, foodResult] = await Promise.all([
      supabase.from("recipes").select("*").is("archived_at", null).order("name"),
      supabase.from("recipe_versions").select("*").order("version_number", {ascending: false}),
      supabase
        .from("recipe_components")
        .select("*")
        .in("review_state", ["accepted", "corrected"])
        .order("component_order"),
      supabase.from("food_items").select("*").is("archived_at", null).order("canonical_name"),
    ]);
    const loadError = recipeResult.error || versionResult.error
      || componentResult.error || foodResult.error;
    if (loadError) {
      setError(loadError.message);
      return;
    }
    setRecipes((recipeResult.data || []) as Recipe[]);
    setVersions((versionResult.data || []) as RecipeVersion[]);
    setComponents((componentResult.data || []) as RecipeComponent[]);
    setFoods((foodResult.data || []) as FoodItem[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const activeVersions = useMemo(
    () => versions.filter(({effective_to}) => effective_to === null),
    [versions],
  );
  const recipeById = useMemo(
    () => new Map(recipes.map((recipe) => [recipe.id, recipe])),
    [recipes],
  );
  const versionById = useMemo(
    () => new Map(versions.map((version) => [version.id, version])),
    [versions],
  );
  const foodById = useMemo(
    () => new Map(foods.map((food) => [food.id, food])),
    [foods],
  );

  function resetEditor() {
    setEditingRecipeId(null);
    setDerivedFromId(null);
    setName("");
    setInstructions("");
    setYieldAmount("");
    setYieldUnit("");
    setComponentEdits([emptyComponent()]);
    setShowEditor(false);
  }

  function editsForVersion(version: RecipeVersion): ComponentEdit[] {
    const rows = components.filter(({recipe_version_id}) => recipe_version_id === version.id);
    return rows.length === 0 ? [emptyComponent()] : rows.map((component) => ({
      key: component.id,
      kind: component.source_recipe_version_id ? "recipe" : "food",
      name: foodById.get(component.component_food_item_id)?.canonical_name || "",
      sourceRecipeVersionId: component.source_recipe_version_id || "",
      amount: component.amount === null ? "" : String(component.amount),
      unit: component.unit || "",
      optional: component.optional,
    }));
  }

  function startEdit(recipe: Recipe, variation: boolean) {
    const version = activeVersions.find(({recipe_id}) => recipe_id === recipe.id);
    if (!version) return;
    setEditingRecipeId(variation ? null : recipe.id);
    setDerivedFromId(variation ? recipe.id : null);
    setName(variation ? `${recipe.name} variation` : recipe.name);
    setInstructions(version.instructions || "");
    setYieldAmount(version.yield_amount === null ? "" : String(version.yield_amount));
    setYieldUnit(version.yield_unit || "");
    setComponentEdits(editsForVersion(version));
    setError(null);
    setSuccess(null);
    setShowEditor(true);
  }

  function updateComponent(key: string, patch: Partial<ComponentEdit>) {
    setComponentEdits((current) => current.map(
      (component) => component.key === key ? {...component, ...patch} : component,
    ));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const validComponents = componentEdits.filter((component) =>
      component.kind === "recipe" ? component.sourceRecipeVersionId : component.name.trim(),
    );
    if (validComponents.length === 0) {
      setError("Add at least one food or saved recipe.");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const {error: saveError} = await supabase.rpc("save_recipe_definition", {
        recipe_name: name.trim(),
        components: validComponents.map((component) => ({
          ...(component.kind === "recipe"
            ? {source_recipe_version_id: component.sourceRecipeVersionId}
            : {name: component.name.trim()}),
          amount: component.amount ? Number(component.amount) : null,
          unit: component.unit.trim() || null,
          optional: component.optional,
          provenance: {method: "recipe_editor", reviewed_by_user: true},
        })),
        instructions: instructions.trim() || null,
        yield_amount: yieldAmount ? Number(yieldAmount) : null,
        yield_unit: yieldUnit.trim() || null,
        existing_recipe_id: editingRecipeId,
        derived_from_id: derivedFromId,
        recipe_attributes: {},
      });
      if (saveError) throw saveError;
      const wasEdit = Boolean(editingRecipeId);
      const wasVariation = Boolean(derivedFromId);
      resetEditor();
      setSuccess(
        wasEdit
          ? "Recipe updated as a new version; earlier logs and parent recipes keep their exact versions."
          : wasVariation
            ? "Recipe variation created and linked to its source."
            : "Recipe saved to the meal graph.",
      );
      await load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the recipe.");
    } finally {
      setBusy(false);
    }
  }

  async function archive(recipe: Recipe) {
    if (!window.confirm(`Archive ${recipe.name}? Logged meals and nested version links stay intact.`)) {
      return;
    }
    const {error: archiveError} = await supabase
      .from("recipes")
      .update({archived_at: new Date().toISOString()})
      .eq("id", recipe.id);
    if (archiveError) setError(archiveError.message);
    else {
      await load();
      onChanged();
    }
  }

  function versionLabel(versionId: string): string {
    const version = versionById.get(versionId);
    const recipe = version ? recipeById.get(version.recipe_id) : null;
    return recipe && version ? `${recipe.name} · v${version.version_number}` : "Saved recipe";
  }

  const selectedHistoricalVersions = new Set(
    componentEdits.map(({sourceRecipeVersionId}) => sourceRecipeVersionId).filter(Boolean),
  );
  const nestedVersionOptions = versions.filter((version) =>
    version.recipe_id !== editingRecipeId
    && (version.effective_to === null || selectedHistoricalVersions.has(version.id)),
  );

  return (
    <section className="catalogue-section recipe-library">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Meals and reusable preparations</span>
          <h2>Recipes</h2>
        </div>
        {!showEditor && <button className="primary" onClick={() => setShowEditor(true)}>Add recipe</button>}
      </div>
      <p className="evidence">
        A recipe is a versioned plan that produces a food. A component can be a food such as
        tomato, or the exact version of another recipe such as tomato sauce v2.
      </p>
      <StatusMessage error={error} success={success} />

      {showEditor && (
        <form className="card stack recipe-editor" onSubmit={save}>
          <div className="section-heading">
            <div>
              <span className="eyebrow">{editingRecipeId ? "New version" : derivedFromId ? "Variation" : "New recipe"}</span>
              <h2>{editingRecipeId ? `Edit ${name}` : derivedFromId ? "Create a variation" : "Build a recipe"}</h2>
            </div>
            <button type="button" className="secondary small" onClick={resetEditor}>Cancel</button>
          </div>
          <label>Recipe or dish name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
          <div className="form-grid">
            <label>Yield<input type="number" min="0" step="any" value={yieldAmount} onChange={(event) => setYieldAmount(event.target.value)} placeholder="e.g. 4" /></label>
            <label>Yield unit<input value={yieldUnit} onChange={(event) => setYieldUnit(event.target.value)} placeholder="portions, jar, loaf…" /></label>
          </div>
          <fieldset className="subcard recipe-components-editor">
            <legend>Components</legend>
            {componentEdits.map((component, index) => (
              <div className="recipe-component-row" key={component.key}>
                <label>
                  Component type
                  <select value={component.kind} onChange={(event) => updateComponent(component.key, {
                    kind: event.target.value as ComponentEdit["kind"],
                    name: "",
                    sourceRecipeVersionId: "",
                  })}>
                    <option value="food">Food / ingredient</option>
                    <option value="recipe">Saved recipe output</option>
                  </select>
                </label>
                {component.kind === "food" ? (
                  <label>
                    Food
                    <input value={component.name} onChange={(event) => updateComponent(component.key, {name: event.target.value})} placeholder="e.g. tomato, pasta, olive oil" list="known-food-items" />
                  </label>
                ) : (
                  <label>
                    Exact recipe version
                    <select required value={component.sourceRecipeVersionId} onChange={(event) => updateComponent(component.key, {sourceRecipeVersionId: event.target.value})}>
                      <option value="">Choose a saved recipe…</option>
                      {nestedVersionOptions.map((version) => <option value={version.id} key={version.id}>{versionLabel(version.id)}</option>)}
                    </select>
                  </label>
                )}
                <label>Amount<input type="number" min="0" step="any" value={component.amount} onChange={(event) => updateComponent(component.key, {amount: event.target.value})} /></label>
                <label>Unit<input value={component.unit} onChange={(event) => updateComponent(component.key, {unit: event.target.value})} /></label>
                <label className="check-row compact"><input type="checkbox" checked={component.optional} onChange={(event) => updateComponent(component.key, {optional: event.target.checked})} /><span>Optional</span></label>
                <button type="button" className="text-button" aria-label={`Remove component ${index + 1}`} onClick={() => setComponentEdits((current) => current.filter(({key}) => key !== component.key))}>Remove</button>
              </div>
            ))}
            <button type="button" className="secondary small" onClick={() => setComponentEdits((current) => [...current, emptyComponent()])}>Add component</button>
            <FoodLabelImporter
              session={session}
              onImported={(imported) => setComponentEdits((current) => [
                ...current,
                {
                  ...emptyComponent(),
                  kind: "recipe",
                  name: imported.name,
                  sourceRecipeVersionId: imported.recipeVersionId,
                },
              ])}
            />
          </fieldset>
          <datalist id="known-food-items">{foods.map((food) => <option value={food.canonical_name} key={food.id} />)}</datalist>
          <label>Preparation method<textarea rows={5} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Chop, combine, cook…" /></label>
          <p className="field-help">
            Nested recipes are pinned to the selected version. Updating that sub-recipe later
            will not silently rewrite this recipe or earlier meal history.
          </p>
          <button className="primary" disabled={busy || !name.trim()}>{busy ? "Saving…" : editingRecipeId ? "Save new version" : derivedFromId ? "Create variation" : "Save recipe"}</button>
        </form>
      )}

      {recipes.length === 0 ? (
        <div className="empty compact-empty"><p>No recipes yet. Photo capture can create one after confirmation, or add one here.</p></div>
      ) : (
        <div className="catalogue-grid recipe-grid">
          {recipes.map((recipe) => {
            const version = activeVersions.find(({recipe_id}) => recipe_id === recipe.id);
            const rows = version
              ? components.filter(({recipe_version_id}) => recipe_version_id === version.id)
              : [];
            return (
              <article className="card catalogue-item" key={recipe.id}>
                <div className="catalogue-item-heading">
                  <div><span className="eyebrow">Recipe {version ? `v${version.version_number}` : ""}</span><h2>{recipe.name}</h2></div>
                </div>
                {version?.yield_amount && <p className="item-meta"><span>Yields {version.yield_amount} {version.yield_unit || ""}</span></p>}
                <div className="recipe-component-summary">
                  {rows.map((component) => (
                    <span key={component.id}>
                      {component.source_recipe_version_id
                        ? `↳ ${versionLabel(component.source_recipe_version_id)}`
                        : foodById.get(component.component_food_item_id)?.canonical_name || "Food"}
                      {component.amount ? ` · ${component.amount} ${component.unit || ""}` : ""}
                    </span>
                  ))}
                </div>
                {version?.instructions && <p className="recipe-preparation-notes">{version.instructions}</p>}
                <div className="button-row catalogue-item-actions">
                  <button className="secondary small" onClick={() => startEdit(recipe, false)}>Edit</button>
                  <button className="secondary small" onClick={() => startEdit(recipe, true)}>Make variation</button>
                  <button className="text-button" onClick={() => void archive(recipe)}>Archive</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
