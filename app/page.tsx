"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { getLastSubmitAt, setLastSubmitAt } from "@/lib/device";
import { distanceMeters, formatDistance } from "@/lib/distance";
import { fetchVoteCounts, fetchMyVotedReportIds, reportStatus, VoteCounts } from "@/lib/votes";
import { credibilityOutOf10, credibilityColor } from "@/lib/credibility";

const Map = dynamic(() => import("./Map"), { ssr: false });

const DEFAULT_LOCATION = "Main St Lot";
const LOCATION_STORAGE_KEY = "parkquest_location";
const TEN_MINUTES_MS = 10 * 60 * 1000;
const THROTTLE_MS = 60 * 1000;
const NEARBY_RADIUS_METERS = 30;

type Report = {
  id: string;
  status: "free" | "taken";
  created_at: string;
  lat: number | null;
  lng: number | null;
  user_id: string | null;
};

type UserPosition = { lat: number; lng: number };

function minutesAgo(isoDate: string) {
  const minutes = Math.floor((Date.now() - new Date(isoDate).getTime()) / 60000);
  if (minutes < 1) return "just now";
  return `${minutes} min ago`;
}

function statusPill(status: "pending" | "verified" | "disputed") {
  if (status === "verified")
    return { label: "Verified", bg: "var(--green-soft)", color: "var(--green)" };
  if (status === "disputed")
    return { label: "Disputed", bg: "var(--red-soft)", color: "var(--red)" };
  return { label: "Pending", bg: "#eef2f7", color: "var(--text-soft)" };
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const [location, setLocation] = useState(DEFAULT_LOCATION);
  const [reports, setReports] = useState<Report[]>([]);
  const [voteCounts, setVoteCounts] = useState<VoteCounts>({});
  const [myVotedIds, setMyVotedIds] = useState<Set<string>>(new Set());
  const [myReports, setMyReports] = useState<Report[]>([]);
  const [myReportVoteCounts, setMyReportVoteCounts] = useState<VoteCounts>({});
  const [submitting, setSubmitting] = useState(false);
  const [userPosition, setUserPosition] = useState<UserPosition | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [dismissedParkIds, setDismissedParkIds] = useState<Set<string>>(new Set());

  const userId = session?.user.id ?? null;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(LOCATION_STORAGE_KEY);
    if (saved) setLocation(saved);
  }, []);

  async function refreshScore() {
    if (!userId) {
      setScore(null);
      return;
    }
    const { data } = await supabase
      .from("profiles")
      .select("reliability_score")
      .eq("id", userId)
      .single();
    setScore(data?.reliability_score ?? 0);
  }

  useEffect(() => {
    refreshScore();
  }, [userId]);

  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationError("Geolocation is not supported by this browser.");
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setUserPosition({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
      },
      (error) => {
        setLocationError(error.message);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  async function loadReports(locationLabel: string) {
    const cutoff = new Date(Date.now() - TEN_MINUTES_MS).toISOString();
    const { data } = await supabase
      .from("reports")
      .select("id, status, created_at, lat, lng, user_id")
      .eq("location_label", locationLabel)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(10);
    const loaded = data ?? [];
    setReports(loaded);

    const ids = loaded.map((r) => r.id);
    setVoteCounts(await fetchVoteCounts(ids));
    setMyVotedIds(userId ? await fetchMyVotedReportIds(userId, ids) : new Set());
  }

  async function loadMyReports() {
    if (!userId) {
      setMyReports([]);
      setMyReportVoteCounts({});
      return;
    }
    const { data } = await supabase
      .from("reports")
      .select("id, status, created_at, lat, lng, user_id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(5);
    const loaded = data ?? [];
    setMyReports(loaded);
    setMyReportVoteCounts(await fetchVoteCounts(loaded.map((r) => r.id)));
  }

  useEffect(() => {
    loadReports(location);
    loadMyReports();
    const last = getLastSubmitAt(location);
    if (last) setCooldownUntil(last + THROTTLE_MS);
  }, [location, userId]);

  function changeLocation(next: string) {
    setLocation(next);
    localStorage.setItem(LOCATION_STORAGE_KEY, next);
  }

  async function signIn() {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
  }

  const onCooldown = cooldownUntil != null && Date.now() < cooldownUntil;

  async function submitReport(status: "free" | "taken") {
    if (!userId || onCooldown) return;
    setSubmitting(true);
    await supabase.from("reports").insert({
      status,
      location_label: location,
      lat: userPosition?.lat ?? null,
      lng: userPosition?.lng ?? null,
      user_id: userId,
    });
    const now = Date.now();
    setLastSubmitAt(location, now);
    setCooldownUntil(now + THROTTLE_MS);
    await loadReports(location);
    await loadMyReports();
    setSubmitting(false);
  }

  async function castVote(reportId: string, vote: "confirm" | "dispute" | "parked_confirm") {
    if (!userId || myVotedIds.has(reportId)) return;
    await supabase.from("report_votes").insert({ report_id: reportId, voter_id: userId, vote });
    setMyVotedIds((prev) => new Set(prev).add(reportId));
    setVoteCounts(await fetchVoteCounts(reports.map((r) => r.id)));
  }

  const nearbyReportToConfirm =
    userId && userPosition
      ? reports.find(
          (r) =>
            r.lat != null &&
            r.lng != null &&
            r.user_id !== userId &&
            !myVotedIds.has(r.id) &&
            !dismissedParkIds.has(r.id) &&
            distanceMeters(userPosition, { lat: r.lat, lng: r.lng }) <= NEARBY_RADIUS_METERS
        ) ?? null
      : null;

  async function confirmParkedHere(reportId: string) {
    await castVote(reportId, "parked_confirm");
    setDismissedParkIds((prev) => new Set(prev).add(reportId));
  }

  function dismissParkedPrompt(reportId: string) {
    setDismissedParkIds((prev) => new Set(prev).add(reportId));
  }

  const credibility = credibilityOutOf10(score);
  const avatarUrl = (session?.user.user_metadata?.avatar_url as string) ?? null;
  const displayName =
    (session?.user.user_metadata?.full_name as string) ?? session?.user.email ?? "";
  const initial = displayName ? displayName.charAt(0).toUpperCase() : "?";

  return (
    <main className="app-shell">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark">P</span>
          ParkQuest
        </span>

        {session ? (
          <Link href="/profile" className="chip">
            {credibility != null && (
              <span
                className="chip-score"
                style={{ color: credibilityColor(credibility) }}
              >
                {credibility.toFixed(1)}
              </span>
            )}
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarUrl} alt={displayName} className="avatar" />
            ) : (
              <span className="avatar avatar-fallback">{initial}</span>
            )}
          </Link>
        ) : (
          <button onClick={signIn} className="btn btn-ghost">
            Sign in
          </button>
        )}
      </header>

      <section className="card">
        <label className="field-label" htmlFor="location">
          Parking area
        </label>
        <input
          id="location"
          className="input"
          value={location}
          onChange={(e) => changeLocation(e.target.value)}
          placeholder="e.g. Main St Lot"
        />
        <p className="hint">
          {userPosition ? (
            <>📍 Located — {userPosition.lat.toFixed(5)}, {userPosition.lng.toFixed(5)}</>
          ) : locationError ? (
            <>⚠️ Location unavailable: {locationError}</>
          ) : (
            <>
              <span className="spin">⏳</span> Getting your location…
            </>
          )}
        </p>
      </section>

      {nearbyReportToConfirm && (
        <section className="card prompt fade-in">
          <strong>Did you park here?</strong>
          <span className="meta">A spot was reported within {NEARBY_RADIUS_METERS}m of you.</span>
          <div className="prompt-actions">
            <button
              className="btn btn-primary"
              onClick={() => confirmParkedHere(nearbyReportToConfirm.id)}
            >
              Yes, I parked
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => dismissParkedPrompt(nearbyReportToConfirm.id)}
            >
              No
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <div className="report-actions">
          <button
            className="btn btn-report btn-free"
            onClick={() => submitReport("free")}
            disabled={!userId || submitting || onCooldown}
          >
            <span className="emoji">🅿️</span>
            Spot Free
          </button>
          <button
            className="btn btn-report btn-taken"
            onClick={() => submitReport("taken")}
            disabled={!userId || submitting || onCooldown}
          >
            <span className="emoji">🚗</span>
            Spot Taken
          </button>
        </div>
        {!userId && <p className="hint" style={{ textAlign: "center" }}>Sign in to report a spot.</p>}
        {userId && onCooldown && (
          <p className="hint" style={{ textAlign: "center" }}>
            You just reported here — try again in a minute.
          </p>
        )}
      </section>

      {userPosition && (
        <div className="map-wrap fade-in">
          <Map userPosition={userPosition} reports={reports} userId={userId} />
        </div>
      )}

      {userId && myReports.length > 0 && (
        <section className="card">
          <h2 className="card-title">My recent reports</h2>
          {myReports.map((r) => {
            const status = reportStatus(myReportVoteCounts[r.id]);
            const pill = statusPill(status);
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
          })}
        </section>
      )}

      <section className="card">
        <h2 className="card-title">Recent reports nearby</h2>
        {reports.length === 0 ? (
          <p className="empty">No reports in the last 10 minutes.</p>
        ) : (
          reports.map((r) => {
            const isMine = r.user_id != null && r.user_id === userId;
            const counts = voteCounts[r.id];
            const alreadyVoted = myVotedIds.has(r.id);
            return (
              <div key={r.id} className="report-item">
                <div className="report-row">
                  <span className="badge">
                    {r.status === "free" ? "🟢 Free" : "🔴 Taken"}
                  </span>
                  <span className="meta">{minutesAgo(r.created_at)}</span>
                  {isMine && (
                    <span className="status-pill" style={{ background: "var(--primary-soft)", color: "var(--primary-dark)" }}>
                      You
                    </span>
                  )}
                  {userPosition && r.lat != null && r.lng != null && (
                    <span className="meta" style={{ marginLeft: "auto" }}>
                      {formatDistance(distanceMeters(userPosition, { lat: r.lat, lng: r.lng }))}
                    </span>
                  )}
                </div>
                {counts && (counts.confirm > 0 || counts.dispute > 0) && (
                  <span className="tally">
                    👍 {counts.confirm} · 👎 {counts.dispute}
                  </span>
                )}
                {userId && !isMine && (
                  <div className="vote-row">
                    <button
                      className="btn-vote"
                      onClick={() => castVote(r.id, "confirm")}
                      disabled={alreadyVoted}
                    >
                      Still there 👍
                    </button>
                    <button
                      className="btn-vote"
                      onClick={() => castVote(r.id, "dispute")}
                      disabled={alreadyVoted}
                    >
                      Not accurate 👎
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>
    </main>
  );
}
