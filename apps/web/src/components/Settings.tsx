import {useEffect, useState} from "react";
import type {Session} from "@supabase/supabase-js";
import {apiPost} from "../lib/api";
import {supabase} from "../lib/supabase";
import type {Profile} from "../types";
import {StatusMessage} from "./StatusMessage";

export function Settings({
  session,
  profile,
  onProfile,
}: {
  session: Session;
  profile: Profile;
  onProfile: (profile: Profile) => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exports, setExports] = useState<Array<{id: string; object_path: string; bucket: string; created_at: string}>>([]);
  const [confirmation, setConfirmation] = useState("");

  async function loadExports() {
    const {data} = await supabase
      .from("artifacts")
      .select("id,object_path,bucket,created_at")
      .eq("artifact_kind", "export")
      .order("created_at", {ascending: false});
    setExports(data || []);
  }
  useEffect(() => { void loadExports(); }, []);

  async function toggleAi() {
    const {data, error: updateError} = await supabase
      .from("profiles")
      .update({ai_enabled: !profile.ai_enabled})
      .eq("id", profile.id)
      .select()
      .single();
    if (updateError) setError(updateError.message);
    else onProfile(data as Profile);
  }

  async function exportData() {
    try {
      await apiPost("/v1/jobs/export", session, {include_originals: true});
      setMessage("Export queued. Its private download will appear in Storage when complete.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not queue export.");
    }
  }

  async function downloadExport(item: {bucket: string; object_path: string}) {
    const {data, error: signedError} = await supabase.storage
      .from(item.bucket)
      .createSignedUrl(item.object_path, 60);
    if (signedError) setError(signedError.message);
    else window.location.assign(data.signedUrl);
  }

  async function deleteAllData() {
    try {
      await apiPost("/v1/jobs/deletion", session, {
        scope: "all_tracking_data",
        confirmation,
      });
      setMessage("Deletion queued. Your tracking records and private objects will be removed.");
      setConfirmation("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not queue deletion.");
    }
  }

  return (
    <section className="page">
      <header className="page-header"><div><span className="eyebrow">Control</span><h1>Settings & data</h1></div></header>
      <div className="stack">
        <article className="card">
          <h2>Remote AI extraction</h2>
          <p>When enabled, selected text/audio can be sent to the configured provider. Proposals still require review.</p>
          <button className="secondary" onClick={() => void toggleAi()}>{profile.ai_enabled ? "Disable remote AI by default" : "Enable AI requests by default"}</button>
        </article>
        <article className="card">
          <h2>Export</h2>
          <p>Create a portable archive of structured records and the original media currently available in private Storage.</p>
          <button className="secondary" onClick={() => void exportData()}>Queue data export</button>
          <button className="text-button" onClick={() => void loadExports()}>Refresh completed exports</button>
          {exports.map((item) => (
            <button className="secondary small" key={item.id} onClick={() => void downloadExport(item)}>
              Download export from {new Date(item.created_at).toLocaleString()}
            </button>
          ))}
        </article>
        <article className="card stack">
          <h2>Delete tracking data</h2>
          <p>This removes your profile, records, and private files but leaves the invited sign-in account available for a fresh start. Existing external backups cannot be remotely erased.</p>
          <label>Type DELETE MY PAJARA DATA<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
          <button className="danger" disabled={confirmation !== "DELETE MY PAJARA DATA"} onClick={() => void deleteAllData()}>Delete all tracking data</button>
        </article>
        <article className="card">
          <h2>Account</h2>
          <p>Signed in as {session.user.email}</p>
          <button className="text-button" onClick={() => void supabase.auth.signOut()}>Sign out</button>
        </article>
        <StatusMessage error={error} success={message} />
      </div>
    </section>
  );
}
