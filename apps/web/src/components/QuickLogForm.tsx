import {useEffect, useState, type FormEvent} from "react";
import type {Session} from "@supabase/supabase-js";
import {useVoiceRecorder} from "../hooks/useVoiceRecorder";
import {apiPost} from "../lib/api";
import {uploadArtifact} from "../lib/artifacts";
import {
  buildVoiceTranscriptionProvenance,
  moonshineConfig,
  transcribeWithMoonshine,
} from "../lib/moonshine";
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
      const now = new Date().toISOString();
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
          label: null,
          attributes: {
            original_text: text,
            prepared_by_user: type === "meal" ? prepared : undefined,
            voice_transcription: voiceTranscription,
          },
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
              voice_transcription: voiceTranscription,
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
          setText("");
          setHandled("");
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
      setSuccess(requestAi ? "Saved. AI extraction is queued for review." : "Log saved.");
      setText("");
      setHandled("");
      voice.clear();
      setVoiceStatus("idle");
      setMachineTranscript(null);
      setTranscriptConfirmed(false);
      setTranscriptConfirmedAt(null);
      setVoiceError(null);
      setUseBackendFallback(false);
      setTextBeforeVoice("");
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
            onChange={(event) => {
              setText(event.target.value);
              if (voice.audioFile) {
                setTranscriptConfirmed(false);
                setTranscriptConfirmedAt(null);
              }
            }}
            placeholder="For example: Made tomato pasta, chopped tomatoes with bare hands, then washed with the kitchen soap."
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
            || (!text.trim() && !voice.audioFile)
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
      </form>
    </section>
  );
}
