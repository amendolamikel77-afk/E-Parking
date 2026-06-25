"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { getLastSubmitAt, setLastSubmitAt } from "@/lib/device";
import { distanceMeters, formatDistance } from "@/lib/distance";
import { fetchVoteCounts, fetchMyVotedReportIds, reportStatus, VoteCounts } from "@/lib/votes";

const Map = dynamic(() => import("./Map"), { ssr: false });

const DEFAULT_LOCATION = "Main St Lot";
const LOCATION_STORAGE_KEY = "parkquest_location";
const TEN_MINUTES_MS = 10 * 60 * 1000;
const THROTTLE_MS = 60 * 1000;

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

function statusColor(status: "pending" | "verified" | "disputed") {
  if (status === "verified") return "#2e7d32";
  if (status === "disputed") return "#c62828";
  return "#999";
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
    navigator.geolocation.getCurrentPosition(
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

  async function signOut() {
    await supabase.auth.signOut();
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

  async function castVote(reportId: string, vote: "confirm" | "dispute") {
    if (!userId || myVotedIds.has(reportId)) return;
    await supabase.from("report_votes").insert({ report_id: reportId, voter_id: userId, vote });
    setMyVotedIds((prev) => new Set(prev).add(reportId));
    setVoteCounts(await fetchVoteCounts(reports.map((r) => r.id)));
  }

  return (
    <main style={{ padding: "2rem", maxWidth: 480, margin: "0 auto" }}>
      <h1 style={{ textAlign: "center" }}>ParkQuest</h1>

      <div style={{ textAlign: "center", marginBottom: "1rem" }}>
        {session ? (
          <span style={{ fontSize: "0.85rem", color: "#555" }}>
            {session.user.email} · ⭐ {score ?? "…"}{" "}
            <button
              onClick={signOut}
              style={{
                marginLeft: 8,
                fontSize: "0.8rem",
                background: "none",
                border: "1px solid #ccc",
                borderRadius: 6,
                padding: "2px 8px",
                cursor: "pointer",
              }}
            >
              Sign out
            </button>
          </span>
        ) : (
          <button
            onClick={signIn}
            style={{
              fontSize: "0.9rem",
              padding: "0.5rem 1rem",
              border: "1px solid #ccc",
              borderRadius: 6,
              background: "white",
              cursor: "pointer",
            }}
          >
            Sign in with Google
          </button>
        )}
      </div>

      <input
        value={location}
        onChange={(e) => changeLocation(e.target.value)}
        placeholder="Location name (e.g. Main St Lot)"
        style={{
          display: "block",
          width: "100%",
          padding: "0.5rem",
          margin: "0.5rem 0",
          textAlign: "center",
          border: "1px solid #ccc",
          borderRadius: 6,
        }}
      />

      <p style={{ textAlign: "center", color: "#888", fontSize: "0.85rem" }}>
        {userPosition
          ? `Your position: ${userPosition.lat.toFixed(5)}, ${userPosition.lng.toFixed(5)}`
          : locationError
          ? `Location unavailable: ${locationError}`
          : "Getting your location..."}
      </p>

      <div style={{ display: "flex", gap: "1rem", margin: "2rem 0" }}>
        <button
          onClick={() => submitReport("free")}
          disabled={!userId || submitting || onCooldown}
          style={{
            flex: 1,
            padding: "1rem",
            fontSize: "1.1rem",
            background: "#2e7d32",
            color: "white",
            border: "none",
            borderRadius: 8,
            opacity: !userId || onCooldown ? 0.5 : 1,
          }}
        >
          Spot Free
        </button>
        <button
          onClick={() => submitReport("taken")}
          disabled={!userId || submitting || onCooldown}
          style={{
            flex: 1,
            padding: "1rem",
            fontSize: "1.1rem",
            background: "#c62828",
            color: "white",
            border: "none",
            borderRadius: 8,
            opacity: !userId || onCooldown ? 0.5 : 1,
          }}
        >
          Spot Taken
        </button>
      </div>
      {!userId && (
        <p style={{ textAlign: "center", color: "#888", fontSize: "0.8rem" }}>
          Sign in to report a spot.
        </p>
      )}
      {userId && onCooldown && (
        <p style={{ textAlign: "center", color: "#888", fontSize: "0.8rem" }}>
          You just reported here — try again in a minute.
        </p>
      )}

      {userPosition && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Map userPosition={userPosition} reports={reports} userId={userId} />
        </div>
      )}

      {userId && myReports.length > 0 && (
        <>
          <h2 style={{ fontSize: "1rem", color: "#555" }}>My recent reports</h2>
          <ul style={{ listStyle: "none", padding: 0, marginBottom: "1.5rem" }}>
            {myReports.map((r) => {
              const status = reportStatus(myReportVoteCounts[r.id]);
              return (
                <li
                  key={r.id}
                  style={{
                    padding: "0.5rem",
                    marginBottom: 6,
                    borderRadius: 6,
                    background: `${statusColor(status)}1a`,
                    borderLeft: `4px solid ${statusColor(status)}`,
                  }}
                >
                  {r.status === "free" ? "🟢 Free" : "🔴 Taken"} — {minutesAgo(r.created_at)} —{" "}
                  <strong style={{ color: statusColor(status) }}>{status}</strong>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <h2 style={{ fontSize: "1rem", color: "#555" }}>Recent reports</h2>
      {reports.length === 0 ? (
        <p style={{ color: "#888" }}>No reports in the last 10 minutes.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {reports.map((r) => {
            const isMine = r.user_id != null && r.user_id === userId;
            const counts = voteCounts[r.id];
            const alreadyVoted = myVotedIds.has(r.id);
            return (
              <li
                key={r.id}
                style={{
                  padding: "0.5rem 0",
                  borderBottom: "1px solid #eee",
                }}
              >
                <div>
                  {r.status === "free" ? "🟢 Free" : "🔴 Taken"} — {minutesAgo(r.created_at)}
                  {isMine && <span style={{ color: "#9c27b0" }}> (you)</span>}
                  {userPosition && r.lat != null && r.lng != null && (
                    <span style={{ color: "#aaa" }}>
                      {" — "}
                      {formatDistance(distanceMeters(userPosition, { lat: r.lat, lng: r.lng }))}
                    </span>
                  )}
                </div>
                {counts && (counts.confirm > 0 || counts.dispute > 0) && (
                  <div style={{ fontSize: "0.75rem", color: "#888" }}>
                    👍 {counts.confirm} · 👎 {counts.dispute}
                  </div>
                )}
                {userId && !isMine && (
                  <div style={{ marginTop: 4 }}>
                    <button
                      onClick={() => castVote(r.id, "confirm")}
                      disabled={alreadyVoted}
                      style={{
                        marginRight: 6,
                        fontSize: "0.75rem",
                        padding: "2px 8px",
                        border: "1px solid #ccc",
                        borderRadius: 6,
                        background: alreadyVoted ? "#eee" : "white",
                      }}
                    >
                      Still there 👍
                    </button>
                    <button
                      onClick={() => castVote(r.id, "dispute")}
                      disabled={alreadyVoted}
                      style={{
                        fontSize: "0.75rem",
                        padding: "2px 8px",
                        border: "1px solid #ccc",
                        borderRadius: 6,
                        background: alreadyVoted ? "#eee" : "white",
                      }}
                    >
                      Not accurate 👎
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
