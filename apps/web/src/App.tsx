import {useEffect, useState} from "react";
import type {Session} from "@supabase/supabase-js";
import {AuthScreen} from "./components/AuthScreen";
import {CheckInForm} from "./components/CheckInForm";
import {Catalogue} from "./components/Catalogue";
import {ProfileSetup} from "./components/ProfileSetup";
import {PhotoCompare} from "./components/PhotoCompare";
import {QuickLogForm} from "./components/QuickLogForm";
import {Reports} from "./components/Reports";
import {ReviewQueue} from "./components/ReviewQueue";
import {Settings} from "./components/Settings";
import {Timeline} from "./components/Timeline";
import {Trends} from "./components/Trends";
import {isConfigured, supabase} from "./lib/supabase";
import type {BodyArea, Profile, View} from "./types";

const nav: Array<[View, string]> = [
  ["home", "Today"],
  ["checkin", "Skin check"],
  ["log", "Quick log"],
  ["catalogue", "Saved items"],
  ["review", "Review"],
  ["timeline", "Timeline"],
  ["photos", "Photos"],
  ["trends", "Trends"],
  ["reports", "Reports"],
  ["settings", "Settings"],
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [bodyAreas, setBodyAreas] = useState<BodyArea[]>([]);
  const [view, setView] = useState<View>("home");
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    void supabase.auth.getSession().then(({data}) => {
      setSession(data.session);
      setLoading(false);
    });
    const {data: listener} = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (!nextSession) setProfile(null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    void Promise.all([
      supabase.from("profiles").select("*").maybeSingle(),
      supabase.from("body_areas").select("*").eq("active", true).order("display_order"),
    ]).then(([profileResult, areasResult]) => {
      setProfile((profileResult.data as Profile | null) || null);
      setBodyAreas((areasResult.data || []) as BodyArea[]);
    });
  }, [session]);

  if (!isConfigured) {
    return <main className="auth-shell"><section className="auth-card"><h1>Configuration required</h1><p>Add the Supabase environment variables before running Pajara.</p></section></main>;
  }
  if (loading) return <main className="loading">Loading Pajara…</main>;
  if (!session) return <AuthScreen />;
  if (!profile) return <ProfileSetup session={session} onCreated={setProfile} />;

  const refresh = () => setRefreshKey((value) => value + 1);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setView("home")}><span>P</span>Pajara</button>
        <nav aria-label="Primary">
          {nav.map(([value, label]) => (
            <button className={view === value ? "active" : ""} onClick={() => setView(value)} key={value}>{label}</button>
          ))}
        </nav>
        <p className="sidebar-note">Patterns, not diagnoses.</p>
      </aside>
      <main className="content">
        {view === "home" && (
          <section className="page home">
            <header className="hero">
              <span className="eyebrow">Today</span>
              <h1>How is your skin,<br />{profile.display_name}?</h1>
              <p>Two minutes now makes later comparisons more reliable.</p>
              <div className="hero-actions">
                <button className="primary" onClick={() => setView("checkin")}>Start skin check</button>
                <button className="secondary" onClick={() => setView("log")}>Log an exposure</button>
              </div>
            </header>
            <div className="notice-grid">
              <article className="card"><span className="eyebrow">Capture</span><h2>Morning and evening</h2><p>Keep photos and scores tied to the same named body area.</p></article>
              <article className="card"><span className="eyebrow">Review</span><h2>You remain the source of truth</h2><p>AI suggestions stay pending until you accept or correct them.</p></article>
              <article className="card boundary"><span className="eyebrow">Safety</span><h2>Associations are not causes</h2><p>Do not change treatment based on tracking results without clinical advice.</p></article>
            </div>
          </section>
        )}
        {view === "checkin" && <CheckInForm session={session} profile={profile} bodyAreas={bodyAreas} onSaved={refresh} />}
        {view === "log" && <QuickLogForm session={session} profile={profile} bodyAreas={bodyAreas} onSaved={refresh} />}
        {view === "catalogue" && <Catalogue session={session} refreshKey={refreshKey} onChanged={refresh} />}
        {view === "review" && <ReviewQueue refreshKey={refreshKey} />}
        {view === "timeline" && <Timeline session={session} refreshKey={refreshKey} onChanged={refresh} />}
        {view === "photos" && (
          <PhotoCompare
            refreshKey={refreshKey}
            bodyAreas={bodyAreas}
            timezone={profile.timezone}
          />
        )}
        {view === "trends" && <Trends refreshKey={refreshKey} />}
        {view === "reports" && <Reports session={session} refreshKey={refreshKey} />}
        {view === "settings" && <Settings session={session} profile={profile} onProfile={setProfile} />}
      </main>
      <nav className="mobile-nav" aria-label="Mobile primary">
        {nav.map(([value, label]) => <button className={view === value ? "active" : ""} onClick={() => setView(value)} key={value}>{label}</button>)}
      </nav>
    </div>
  );
}
