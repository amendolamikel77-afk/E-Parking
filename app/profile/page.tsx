"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { fetchVoteCounts, reportStatus, VoteCounts } from "@/lib/votes";
import {
  credibilityOutOf10,
  credibilityColor,
  credibilityLabel,
} from "@/lib/credibility";

type Report = {
  id: string;
  status: "free" | "taken";
  created_at: string;
};

function minutesAgo(isoDate: string) {
  const minutes = Math.floor((Date.now() - new Date(isoDate).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function ProfilePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [voteCounts, setVoteCounts] = useState<VoteCounts>({});
  const [loaded, setLoaded] = useState(false);

  const userId = session?.user.id ?? null;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    async function load() {
      if (!userId) {
        setScore(null);
        setReports([]);
        setVoteCounts({});
        setLoaded(true);
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("reliability_score")
        .eq("id", userId)
        .single();
      setScore(profile?.reliability_score ?? 0);

      const { data } = await supabase
        .from("reports")
        .select("id, status, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(20);
      const loadedReports = data ?? [];
      setReports(loadedReports);
      setVoteCounts(await fetchVoteCounts(loadedReports.map((r) => r.id)));
      setLoaded(true);
    }
    load();
  }, [userId]);

  async function signIn() {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + "/profile" },
    });
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  if (!session) {
    return (
      <main className="app-shell">
        <header className="topbar">
          <Link href="/" className="btn btn-ghost" aria-label="Back to home">
            ← Back
          </Link>
          <span className="brand">
            Profile
            <span className="brand-mark">P</span>
          </span>
        </header>
        <section className="card" style={{ textAlign: "center" }}>
          <p className="hint" style={{ marginBottom: "1rem" }}>
            Sign in to build your credibility and track your reports.
          </p>
          <button onClick={signIn} className="btn btn-primary">
            Sign in with Google
          </button>
        </section>
      </main>
    );
  }

  const credibility = credibilityOutOf10(score);
  const avatarUrl = (session.user.user_metadata?.avatar_url as string) ?? null;
  const displayName =
    (session.user.user_metadata?.full_name as string) ?? session.user.email ?? "";
  const initial = displayName ? displayName.charAt(0).toUpperCase() : "?";

  const verified = reports.filter((r) => reportStatus(voteCounts[r.id]) === "verified").length;

  return (
    <main className="app-shell fade-in">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark">P</span>
          Profile
        </span>
      </header>

      <section className="card" style={{ textAlign: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.5rem" }}>
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt={displayName}
              className="avatar"
              style={{ width: 64, height: 64 }}
            />
          ) : (
            <span
              className="avatar avatar-fallback"
              style={{ width: 64, height: 64, fontSize: "1.5rem" }}
            >
              {initial}
            </span>
          )}
          <strong style={{ fontSize: "1.1rem" }}>{displayName}</strong>
          <span className="meta">{session.user.email}</span>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Credibility</h2>
        <div className="gauge">
          {credibility != null && (
            <>
              <div
                className="gauge-circle"
                style={{
                  background: `linear-gradient(135deg, ${credibilityColor(
                    credibility
                  )}, ${credibilityColor(credibility)}cc)`,
                }}
              >
                <span className="gauge-value">{credibility.toFixed(1)}</span>
                <span className="gauge-of">out of 10</span>
              </div>
              <strong style={{ color: credibilityColor(credibility) }}>
                {credibilityLabel(credibility)}
              </strong>
              <span className="meta">
                Earn trust when others confirm your spots — especially when they park there.
              </span>
            </>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Activity</h2>
        <div className="stat-grid">
          <div>
            <div className="stat-num">{reports.length}</div>
            <div className="stat-label">Reports</div>
          </div>
          <div>
            <div className="stat-num">{verified}</div>
            <div className="stat-label">Verified</div>
          </div>
          <div>
            <div className="stat-num">{score ?? 0}</div>
            <div className="stat-label">Points</div>
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Report history</h2>
        {!loaded ? (
          <p className="empty">Loading…</p>
        ) : reports.length === 0 ? (
          <p className="empty">No reports yet. Head to Home to report a spot.</p>
        ) : (
          reports.map((r) => {
            const status = reportStatus(voteCounts[r.id]);
            const pill =
              status === "verified"
                ? { label: "Verified", bg: "var(--green-soft)", color: "var(--green)" }
                : status === "disputed"
                ? { label: "Disputed", bg: "var(--red-soft)", color: "var(--red)" }
                : { label: "Pending", bg: "#eef2f7", color: "var(--text-soft)" };
            return (
              <div key={r.id} className="report-item">
                <div className="report-row">
                  <span className="badge">
                    {r.status === "free" ? "🟢 Free" : "🔴 Taken"}
                  </span>
                  <span className="meta">{minutesAgo(r.created_at)}</span>
                  <span
                    className="status-pill"
                    style={{ background: pill.bg, color: pill.color, marginLeft: "auto" }}
                  >
                    {pill.label}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Account</h2>
        <button
          onClick={signOut}
          className="btn btn-ghost"
          style={{ width: "100%" }}
        >
          Sign out
        </button>
      </section>
    </main>
  );
}
