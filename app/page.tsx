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
import { fetchReliabilityScores } from "@/lib/profiles";

const Map = dynamic(() => import("./Map"), { ssr: false });

const DEFAULT_LOCATION = "Main St Lot";
const LOCATION_STORAGE_KEY = "parkquest_location";
const REPORT_LIFETIME_MS = 60 * 1000;
const THROTTLE_MS = 60 * 1000;
const PHOTO_BUCKET = "parking-photos";

type Report = {
  id: string;
  status: "free" | "taken";
  created_at: string;
  lat: number | null;
  lng: number | null;
  user_id: string | null;
};

type UserPosition = { lat: number; lng: number };

function ageLabel(isoDate: string) {
  const seconds = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)}h ago`;
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
  const [claimingReportId, setClaimingReportId] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [reporterCredibility, setReporterCredibility] = useState<Record<string, number | null>>(
    {}
  );
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [, forceTick] = useState(0);

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

  // Re-render periodically so marker opacity / "Xs ago" labels stay live.
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 5000);
    return () => clearInterval(id);
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
    const cutoff = new Date(Date.now() - REPORT_LIFETIME_MS).toISOString();
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

    const scores = await fetchReliabilityScores(loaded.map((r) => r.user_id).filter(Boolean) as string[]);
    const credibility: Record<string, number | null> = {};
    for (const [id, rawScore] of Object.entries(scores)) {
      credibility[id] = credibilityOutOf10(rawScore);
    }
    setReporterCredibility(credibility);
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

  // Reports expire after just 60s, so keep the feed fresh without a manual reload.
  useEffect(() => {
    const id = setInterval(() => loadReports(location), 15000);
    return () => clearInterval(id);
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

  async function submitReport() {
    if (!userId || onCooldown) return;
    setSubmitting(true);
    await supabase.from("reports").insert({
      status: "free",
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

  function startClaim(reportId: string) {
    setClaimError(null);
    setClaimingReportId(reportId);
  }

  function cancelClaim() {
    setClaimingReportId(null);
    setClaimError(null);
  }

  async function submitClaimPhoto(reportId: string, file: File) {
    if (!userId) return;
    setUploadingPhoto(true);
    setClaimError(null);
    try {
      const path = `${reportId}/${userId}-${Date.now()}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(path, file, { contentType: file.type || "image/jpeg" });
      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);

      await supabase.from("report_votes").insert({
        report_id: reportId,
        voter_id: userId,
        vote: "parked_confirm",
        photo_url: publicUrlData.publicUrl,
      });
      await supabase.from("reports").update({ status: "taken" }).eq("id", reportId);

      setMyVotedIds((prev) => new Set(prev).add(reportId));
      await loadReports(location);
      setClaimingReportId(null);
    } catch {
      setClaimError("Couldn't upload that photo. Try again.");
    } finally {
      setUploadingPhoto(false);
    }
  }

  const credibility = credibilityOutOf10(score);
  const avatarUrl = (session?.user.user_metadata?.avatar_url as string) ?? null;
  const displayName =
    (session?.user.user_metadata?.full_name as string) ?? session?.user.email ?? "";
  const initial = displayName ? displayName.charAt(0).toUpperCase() : "?";

  const allKnownReports = [...reports, ...myReports];
  const selectedReport = selectedReportId
    ? allKnownReports.find((r) => r.id === selectedReportId) ?? null
    : null;
  const selectedReportCounts = selectedReportId ? voteCounts[selectedReportId] : undefined;
  const selectedReportIsMine =
    selectedReport != null && selectedReport.user_id != null && selectedReport.user_id === userId;
  const selectedReportCredibility =
    selectedReport?.user_id ? reporterCredibility[selectedReport.user_id] ?? null : null;

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
              <span className="chip-score" style={{ color: credibilityColor(credibility) }}>
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
            <>
              📍 Located — {userPosition.lat.toFixed(5)}, {userPosition.lng.toFixed(5)}
            </>
          ) : locationError ? (
            <>⚠️ Location unavailable: {locationError}</>
          ) : (
            <>
              <span className="spin">⏳</span> Getting your location…
            </>
          )}
        </p>
      </section>

      {claimingReportId && (
        <section className="card prompt fade-in">
          <strong>📷 Confirm you parked here</strong>
          <span className="meta">
            Take a quick photo to verify the spot — our AI checks it actually looks like
            parking before the reporter gets credibility points.
          </span>
          <label className="btn btn-primary" style={{ display: "inline-block" }}>
            {uploadingPhoto ? "Checking photo…" : "Take / choose photo"}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              disabled={uploadingPhoto}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) submitClaimPhoto(claimingReportId, file);
              }}
            />
          </label>
          {claimError && (
            <span style={{ color: "var(--red)", fontSize: "0.85rem" }}>{claimError}</span>
          )}
          <button className="btn btn-ghost" onClick={cancelClaim} disabled={uploadingPhoto}>
            Cancel
          </button>
        </section>
      )}

      <section className="card">
        <div className="report-actions" style={{ gridTemplateColumns: "1fr" }}>
          <button
            className="btn btn-report btn-free"
            onClick={() => submitReport()}
            disabled={!userId || submitting || onCooldown}
          >
            <span className="emoji">🅿️</span>
            Spot Free
          </button>
        </div>
        {!userId && (
          <p className="hint" style={{ textAlign: "center" }}>
            Sign in to report a spot.
          </p>
        )}
        {userId && onCooldown && (
          <p className="hint" style={{ textAlign: "center" }}>
            You just reported here — try again in a minute.
          </p>
        )}
      </section>

      {userPosition && (
        <div className="map-wrap fade-in">
          <Map
            userPosition={userPosition}
            reports={reports}
            userId={userId}
            reporterCredibility={reporterCredibility}
            lifetimeMs={REPORT_LIFETIME_MS}
            onSelectReport={setSelectedReportId}
          />
        </div>
      )}

      {userId && myReports.length > 0 && (
        <section className="card">
          <h2 className="card-title">My recent reports</h2>
          {myReports.map((r) => {
            const status = reportStatus(myReportVoteCounts[r.id]);
            const pill = statusPill(status);
            return (
              <div
                key={r.id}
                className="report-item"
                onClick={() => setSelectedReportId(r.id)}
                style={{ cursor: "pointer" }}
              >
                <div className="report-row">
                  <span className="badge">{r.status === "free" ? "🟢 Free" : "🔴 Taken"}</span>
                  <span className="meta">{ageLabel(r.created_at)}</span>
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
          <p className="empty">No reports in the last minute.</p>
        ) : (
          reports.map((r) => {
            const isMine = r.user_id != null && r.user_id === userId;
            const counts = voteCounts[r.id];
            const alreadyVoted = myVotedIds.has(r.id);
            return (
              <div
                key={r.id}
                className="report-item"
                onClick={() => setSelectedReportId(r.id)}
                style={{ cursor: "pointer" }}
              >
                <div className="report-row">
                  <span className="badge">{r.status === "free" ? "🟢 Free" : "🔴 Taken"}</span>
                  <span className="meta">{ageLabel(r.created_at)}</span>
                  {isMine && (
                    <span
                      className="status-pill"
                      style={{ background: "var(--primary-soft)", color: "var(--primary-dark)" }}
                    >
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
                    {r.status === "free" && (
                      <button
                        className="btn-vote"
                        style={{ color: "var(--primary-dark)", borderColor: "var(--primary)" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          startClaim(r.id);
                        }}
                        disabled={alreadyVoted}
                      >
                        📷 Parked here
                      </button>
                    )}
                    <button
                      className="btn-vote"
                      onClick={(e) => {
                        e.stopPropagation();
                        castVote(r.id, "dispute");
                      }}
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

      {selectedReport && (
        <div className="modal-backdrop" onClick={() => setSelectedReportId(null)}>
          <div className="card modal-card" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedReportId(null)}>
              ✕
            </button>
            <h2 style={{ marginBottom: "0.75rem" }}>
              {selectedReport.status === "free" ? "🟢 Free spot" : "🔴 Taken spot"}
            </h2>
            <div className="detail-row">
              <span className="meta">Reported</span>
              <span>{ageLabel(selectedReport.created_at)}</span>
            </div>
            <div className="detail-row">
              <span className="meta">Reporter credibility</span>
              <span style={{ color: selectedReportCredibility != null ? credibilityColor(selectedReportCredibility) : undefined }}>
                {selectedReportCredibility != null ? `${selectedReportCredibility.toFixed(1)} / 10` : "—"}
              </span>
            </div>
            {userPosition && selectedReport.lat != null && selectedReport.lng != null && (
              <div className="detail-row">
                <span className="meta">Distance</span>
                <span>
                  {formatDistance(
                    distanceMeters(userPosition, { lat: selectedReport.lat, lng: selectedReport.lng })
                  )}
                </span>
              </div>
            )}
            <div className="detail-row">
              <span className="meta">Votes</span>
              <span>
                👍 {selectedReportCounts?.confirm ?? 0} · 👎 {selectedReportCounts?.dispute ?? 0}
              </span>
            </div>
            {userId && !selectedReportIsMine && selectedReport.status === "free" && (
              <button
                className="btn btn-primary"
                style={{ width: "100%", marginTop: "1rem" }}
                onClick={() => {
                  startClaim(selectedReport.id);
                  setSelectedReportId(null);
                }}
                disabled={myVotedIds.has(selectedReport.id)}
              >
                📷 Parked here
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
