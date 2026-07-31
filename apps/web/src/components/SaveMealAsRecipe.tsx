import {useState, type FormEvent} from "react";
import {parseIngredientNames} from "../lib/catalogue";
import {supabase} from "../lib/supabase";
import type {CatalogueItem} from "../types";
import {StatusMessage} from "./StatusMessage";

export function SaveMealAsRecipe({
  mealEventId,
  defaultName = "",
  defaultMethod = "",
  defaultContact = "",
  initiallyOpen = false,
  onSaved,
  onDismiss,
}: {
  mealEventId: string;
  defaultName?: string;
  defaultMethod?: string;
  defaultContact?: string;
  initiallyOpen?: boolean;
  onSaved?: (recipe: CatalogueItem) => void;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [name, setName] = useState(defaultName);
  const [ingredients, setIngredients] = useState("");
  const [method, setMethod] = useState(defaultMethod);
  const [contact, setContact] = useState(defaultContact);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const {data, error: saveError} = await supabase.rpc(
        "save_meal_event_as_recipe",
        {
          meal_event_id: mealEventId,
          recipe_name: name.trim(),
          recipe_ingredients: parseIngredientNames(ingredients),
          preparation_method: method.trim(),
          preparation_contact_notes: contact.trim(),
        },
      );
      if (saveError) throw saveError;
      const recipe = (Array.isArray(data) ? data[0] : data) as CatalogueItem | undefined;
      if (!recipe) throw new Error("The saved recipe was not returned.");
      setSavedName(recipe.canonical_name);
      setOpen(false);
      onSaved?.(recipe);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this recipe.");
    } finally {
      setBusy(false);
    }
  }

  if (savedName) {
    return (
      <p className="status success" role="status">
        {savedName} is now available under Saved items and is linked to this meal.
      </p>
    );
  }

  if (!open) {
    return (
      <button className="secondary small" onClick={() => setOpen(true)}>
        Save as a reusable recipe
      </button>
    );
  }

  return (
    <form className="stack subcard save-meal-recipe" onSubmit={save}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">Repeat this meal</span>
          <h3>Save as a recipe</h3>
        </div>
        <button
          type="button"
          className="text-button small"
          onClick={() => {
            setOpen(false);
            onDismiss?.();
          }}
        >
          Not now
        </button>
      </div>
      <p className="evidence">
        Review the reusable details first. The recipe will be linked to the meal you
        just logged, including its exact initial version.
      </p>
      <label>
        Recipe name
        <input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Tomato pasta"
        />
      </label>
      <label>
        Ingredients
        <textarea
          aria-label="Ingredients"
          rows={4}
          value={ingredients}
          onChange={(event) => setIngredients(event.target.value)}
          placeholder="One ingredient per line"
        />
        <span className="field-help">
          Ingredients are not inferred from preparation-contact notes.
        </span>
      </label>
      <label>
        Preparation method
        <textarea
          rows={3}
          value={method}
          onChange={(event) => setMethod(event.target.value)}
        />
      </label>
      <label>
        Usual skin contact while preparing
        <textarea
          aria-label="Usual skin contact while preparing"
          rows={3}
          value={contact}
          onChange={(event) => setContact(event.target.value)}
        />
        <span className="field-help">
          This becomes an editable prompt when the recipe is logged again, not a claim
          that the same contact always occurred.
        </span>
      </label>
      <StatusMessage error={error} />
      <button className="primary" disabled={busy || !name.trim()}>
        {busy ? "Saving…" : "Save recipe and link this meal"}
      </button>
    </form>
  );
}
