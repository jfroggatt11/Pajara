import {useState, type FormEvent} from "react";
import type {Session} from "@supabase/supabase-js";
import {uploadArtifact} from "../lib/artifacts";
import {supabase} from "../lib/supabase";
import type {BodyArea, Profile} from "../types";
import {StatusMessage} from "./StatusMessage";

const symptoms = ["redness", "itching", "dryness", "cracking", "swelling", "pain"] as const;
const maxPhotos = 12;
const photoViews = [
  ["overview", "Overview"],
  ["palm", "Palm / front"],
  ["back", "Back of hand"],
  ["side", "Side"],
  ["close_up", "Close-up"],
  ["other", "Other"],
] as const;

interface PhotoEntry {
  id: string;
  bodyAreaCode: string;
  viewCode: string;
  file: File | null;
}

function newPhotoEntry(bodyAreaCode: string, viewCode = "overview"): PhotoEntry {
  return {id: crypto.randomUUID(), bodyAreaCode, viewCode, file: null};
}

function localDatetime(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function CheckInForm({
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
  const [period, setPeriod] = useState<"morning" | "evening">(
    new Date().getHours() < 14 ? "morning" : "evening",
  );
  const [occurred, setOccurred] = useState(localDatetime());
  const [bodyArea, setBodyArea] = useState("both_hands");
  const [scores, setScores] = useState<Record<string, number | null>>(
    Object.fromEntries(symptoms.map((symptom) => [symptom, null])),
  );
  const [photoEntries, setPhotoEntries] = useState<PhotoEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function addPhoto() {
    setPhotoEntries((entries) =>
      entries.length >= maxPhotos ? entries : [...entries, newPhotoEntry(bodyArea)],
    );
  }

  function addHandViews() {
    const handViews = [
      newPhotoEntry("left_hand", "palm"),
      newPhotoEntry("left_hand", "back"),
      newPhotoEntry("right_hand", "palm"),
      newPhotoEntry("right_hand", "back"),
    ];
    setPhotoEntries((entries) => [
      ...entries,
      ...handViews.slice(0, Math.max(0, maxPhotos - entries.length)),
    ]);
  }

  function updatePhotoEntry(id: string, update: Partial<PhotoEntry>) {
    setPhotoEntries((entries) =>
      entries.map((entry) => entry.id === id ? {...entry, ...update} : entry),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const time = new Date(occurred).toISOString();
      const {data: skinEvent, error: eventError} = await supabase
        .from("events")
        .insert({
          user_id: session.user.id,
          profile_id: profile.id,
          type_code: "skin_check",
          occurred_start: time,
          recorded_timezone: profile.timezone,
          label: `${period === "morning" ? "Morning" : "Evening"} skin check`,
          attributes: {period, capture_protocol_version: 2},
          trust_status: "trusted",
          source_method: "manual",
        })
        .select()
        .single();
      if (eventError) throw eventError;

      const observationRows = symptoms.flatMap((symptom) => {
        const score = scores[symptom];
        return score === null
          ? []
          : [{
              user_id: session.user.id,
              event_id: skinEvent.id,
              body_area_code: bodyArea,
              type_code: symptom,
              observed_at: time,
              numeric_value: score,
              scale_code: "symptom_0_10_v1",
              scale_min: 0,
              scale_max: 10,
              trust_status: "trusted",
              attributes: {},
            }];
      });
      if (observationRows.length > 0) {
        const {error: observationError} = await supabase
          .from("observations")
          .insert(observationRows);
        if (observationError) throw observationError;
      }

      const selectedPhotos = photoEntries.filter(
        (entry): entry is PhotoEntry & {file: File} => entry.file !== null,
      );
      for (const [index, entry] of selectedPhotos.entries()) {
        await uploadArtifact(
          session,
          skinEvent.id,
          entry.file,
          "skin-originals",
          "skin_photo",
          {
            bodyAreaCode: entry.bodyAreaCode,
            viewCode: entry.viewCode,
            displayOrder: index,
            capturedAt: time,
          },
        );
      }
      setSuccess("Skin check saved.");
      setPhotoEntries([]);
      setScores(Object.fromEntries(symptoms.map((symptom) => [symptom, null])));
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the skin check.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <div><span className="eyebrow">Structured observation</span><h1>Skin check</h1></div>
        <p>Use the same area, view, distance, and diffuse lighting when practical.</p>
      </header>
      <form onSubmit={submit} className="stack card">
        <div className="segmented" aria-label="Check-in period">
          {(["morning", "evening"] as const).map((value) => (
            <button
              type="button"
              className={period === value ? "active" : ""}
              onClick={() => setPeriod(value)}
              key={value}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="form-grid">
          <label>When<input type="datetime-local" value={occurred} onChange={(event) => setOccurred(event.target.value)} required /></label>
          <label>
            Symptom area
            <select value={bodyArea} onChange={(event) => setBodyArea(event.target.value)}>
              {bodyAreas.map((area) => <option value={area.code} key={area.code}>{area.label}</option>)}
            </select>
          </label>
        </div>
        <div className="score-grid">
          {symptoms.map((symptom) => (
            <label className="score" key={symptom}>
              <span>
                <strong>{symptom}</strong>
                <output>{scores[symptom] ?? "—"}</output>
              </span>
              <span className="check-row compact">
                <input
                  type="checkbox"
                  checked={scores[symptom] !== null}
                  onChange={(event) => setScores({
                    ...scores,
                    [symptom]: event.target.checked ? 0 : null,
                  })}
                />
                <span>I observed this symptom</span>
              </span>
              <input
                type="range"
                min="0"
                max="10"
                value={scores[symptom] ?? 0}
                disabled={scores[symptom] === null}
                onChange={(event) => setScores({...scores, [symptom]: Number(event.target.value)})}
              />
              <small>Unobserved stays missing · 0 none · 10 worst imaginable</small>
            </label>
          ))}
        </div>
        <fieldset className="subcard photo-capture">
          <legend>Photos</legend>
          <p className="evidence">
            Give each photo its own area and view. Keep lighting, distance, and framing
            consistent where practical.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="secondary small"
              disabled={photoEntries.length >= maxPhotos}
              onClick={addPhoto}
            >
              Add photo
            </button>
            <button
              type="button"
              className="secondary small"
              disabled={photoEntries.length > maxPhotos - 4}
              onClick={addHandViews}
            >
              Add left/right palm & back
            </button>
            <span className="evidence">{photoEntries.length}/{maxPhotos} slots</span>
          </div>
          <div className="photo-capture-list">
            {photoEntries.map((entry, index) => (
              <article className="photo-entry" key={entry.id}>
                <div className="photo-entry-heading">
                  <strong>Photo {index + 1}</strong>
                  <button
                    type="button"
                    className="text-button small"
                    onClick={() => setPhotoEntries((entries) =>
                      entries.filter((item) => item.id !== entry.id)
                    )}
                  >
                    Remove
                  </button>
                </div>
                <div className="form-grid">
                  <label>
                    Body area
                    <select
                      value={entry.bodyAreaCode}
                      onChange={(event) =>
                        updatePhotoEntry(entry.id, {bodyAreaCode: event.target.value})
                      }
                    >
                      {bodyAreas.map((area) => (
                        <option value={area.code} key={area.code}>{area.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    View
                    <select
                      value={entry.viewCode}
                      onChange={(event) =>
                        updatePhotoEntry(entry.id, {viewCode: event.target.value})
                      }
                    >
                      {photoViews.map(([value, label]) => (
                        <option value={value} key={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="upload-zone">
                  <strong>{entry.file ? "Replace photo" : "Take or choose photo"}</strong>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                    capture="environment"
                    onChange={(event) =>
                      updatePhotoEntry(entry.id, {file: event.target.files?.[0] || null})
                    }
                  />
                  {entry.file && <em>{entry.file.name}</em>}
                </label>
              </article>
            ))}
          </div>
        </fieldset>
        <StatusMessage error={error} success={success} />
        <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save skin check"}</button>
      </form>
    </section>
  );
}
