import {useState, type FormEvent} from "react";
import {supabase} from "../lib/supabase";
import {StatusMessage} from "./StatusMessage";

export function AuthScreen() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const {error: authError} = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: window.location.origin,
      },
    });
    setBusy(false);
    if (authError) setError(authError.message);
    else setSent(true);
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <span className="eyebrow">Private pattern tracking</span>
        <h1>Pajara</h1>
        <p className="lede">
          Capture skin changes and everyday exposures, then review patterns without
          turning associations into diagnoses.
        </p>
        <div className="medical-boundary">
          Pajara does not diagnose conditions, establish causes, or advise medication
          changes.
        </div>
        {sent ? (
          <p role="status">Check your email for a secure sign-in link.</p>
        ) : (
          <form onSubmit={submit} className="stack">
            <label>
              Email
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <button className="primary" disabled={busy}>
              {busy ? "Sending…" : "Email me a sign-in link"}
            </button>
          </form>
        )}
        <StatusMessage error={error} />
      </section>
    </main>
  );
}

