import {useState, type FormEvent} from "react";
import type {Session} from "@supabase/supabase-js";
import {supabase} from "../lib/supabase";
import type {Profile} from "../types";
import {StatusMessage} from "./StatusMessage";

export function ProfileSetup({
  session,
  onCreated,
}: {
  session: Session;
  onCreated: (profile: Profile) => void;
}) {
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!consent) return;
    const {data, error: saveError} = await supabase
      .from("profiles")
      .insert({
        user_id: session.user.id,
        display_name: name,
        timezone,
        locale: navigator.language || "en",
        consent_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (saveError) setError(saveError.message);
    else onCreated(data as Profile);
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <span className="eyebrow">First-time setup</span>
        <h1>Create your profile</h1>
        <p>
          Your structured records and original photos/audio will be stored privately
          in Supabase. If you later enable remote AI, selected inputs will be sent to
          the configured AI provider for extraction.
        </p>
        <form onSubmit={submit} className="stack">
          <label>
            Display name
            <input required value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Timezone
            <input value={timezone} readOnly />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>I understand where my data is stored and that Pajara is not diagnostic.</span>
          </label>
          <button className="primary" disabled={!consent}>Create profile</button>
        </form>
        <StatusMessage error={error} />
      </section>
    </main>
  );
}

