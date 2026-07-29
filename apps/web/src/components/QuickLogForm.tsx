import {useState, type FormEvent} from "react";
import type {Session} from "@supabase/supabase-js";
import {useVoiceRecorder} from "../hooks/useVoiceRecorder";
import {apiPost} from "../lib/api";
import {uploadArtifact} from "../lib/artifacts";
import {supabase} from "../lib/supabase";
import type {BodyArea, Profile} from "../types";
import {StatusMessage} from "./StatusMessage";

const types = [
  ["meal", "Meal"],
  ["skin_contact", "Skin contact / product"],
  ["topical_treatment", "Treatment"],
  ["activity", "Activity"],
  ["note", "Note"],
] as const;

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
  const [text, setText] = useState("");
  const [prepared, setPrepared] = useState(false);
  const [handled, setHandled] = useState("");
  const [bodyArea, setBodyArea] = useState("both_hands");
  const [gloves, setGloves] = useState(false);
  const [requestAi, setRequestAi] = useState(profile.ai_enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const voice = useVoiceRecorder();

  async function startVoice() {
    setError(null);
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const now = new Date().toISOString();
      const {data: mainEvent, error: eventError} = await supabase
        .from("events")
        .insert({
          user_id: session.user.id,
          profile_id: profile.id,
          type_code: type,
          occurred_start: now,
          recorded_timezone: profile.timezone,
          label: null,
          attributes: {original_text: text, prepared_by_user: type === "meal" ? prepared : undefined},
          trust_status: requestAi && !(type === "meal" && prepared) ? "draft" : "trusted",
          source_method: voice.audioFile ? "voice" : "text",
        })
        .select()
        .single();
      if (eventError) throw eventError;

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
            label: "Meal preparation",
            attributes: {
              original_text: text,
              prepared_by_user: true,
              handled_ingredients_text: handled,
              contact_body_area: bodyArea,
              gloves_used: gloves,
            },
            trust_status: requestAi ? "draft" : "trusted",
            source_method: voice.audioFile ? "voice" : "text",
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

      if (requestAi) {
        try {
          await apiPost("/v1/jobs/extraction", session, {
            event_id: extractionTarget,
            artifact_id: artifactId,
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
          setText("");
          setHandled("");
          voice.clear();
          onSaved();
          return;
        }
      }
      setSuccess(requestAi ? "Saved. AI extraction is queued for review." : "Log saved.");
      setText("");
      setHandled("");
      voice.clear();
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
        <p>Save first. Structure manually or review an AI proposal afterward.</p>
      </header>
      <form className="stack card" onSubmit={submit}>
        <label>
          What are you logging?
          <select value={type} onChange={(event) => setType(event.target.value)}>
            {types.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </label>
        <label>
          Describe it
          <textarea
            rows={5}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="For example: Made tomato pasta, chopped tomatoes with bare hands, then washed with the kitchen soap."
          />
        </label>
        <div className="voice-row">
          {!voice.recording ? (
            <button type="button" className="secondary" onClick={() => void startVoice()}>
              Record voice note
            </button>
          ) : (
            <button type="button" className="danger" onClick={voice.stop}>Stop recording</button>
          )}
          {voice.audioFile && <span>Voice note ready · {(voice.audioFile.size / 1024).toFixed(0)} KB</span>}
        </div>
        {type === "meal" && (
          <fieldset className="subcard">
            <legend>Preparation and skin contact</legend>
            <label className="check-row">
              <input type="checkbox" checked={prepared} onChange={(event) => setPrepared(event.target.checked)} />
              <span>I prepared this meal</span>
            </label>
            {prepared && (
              <>
                <label>
                  What actually touched your skin?
                  <input value={handled} onChange={(event) => setHandled(event.target.value)} placeholder="e.g. raw tomato, flour dough" />
                </label>
                <div className="form-grid">
                  <label>Body area<select value={bodyArea} onChange={(event) => setBodyArea(event.target.value)}>{bodyAreas.map((area) => <option value={area.code} key={area.code}>{area.label}</option>)}</select></label>
                  <label className="check-row compact"><input type="checkbox" checked={gloves} onChange={(event) => setGloves(event.target.checked)} /><span>Wore gloves</span></label>
                </div>
              </>
            )}
          </fieldset>
        )}
        <label className="check-row">
          <input type="checkbox" checked={requestAi} onChange={(event) => setRequestAi(event.target.checked)} />
          <span>Ask AI to propose structured fields. Nothing becomes trusted until I review it.</span>
        </label>
        <StatusMessage error={error} success={success} />
        <button className="primary" disabled={busy || (!text.trim() && !voice.audioFile)}>
          {busy ? "Saving…" : "Save log"}
        </button>
      </form>
    </section>
  );
}
