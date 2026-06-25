"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { supabase } from "@/lib/supabase";
import { getDeviceId, getLastSubmitAt, setLastSubmitAt } from "@/lib/device";
import { distanceMeters, formatDistance } from "@/lib/distance";

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
  reporter_id: string | null;
};

type UserPosition = { lat: number; lng: number };

function minutesAgo(isoDate: string) {
  const minutes = Math.floor((Date.now() - new Date(isoDate).getTime()) / 60000);
  if (minutes < 1) return "just now";
  return `${minutes} min ago`;
}

export default function Home() {
  const [location, setLocation] = useState(DEFAULT_LOCATION);
  const [reports, setReports] = useState<Report[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [userPosition, setUserPosition] = useState<UserPosition | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);

  useEffect(() => {
    setDeviceId(getDeviceId());
    const saved = localStorage.getItem(LOCATION_STORAGE_KEY);
    if (saved) setLocation(saved);
  }, []);

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
      .select("id, status, created_at, lat, lng, reporter_id")
      .eq("location_label", locationLabel)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(10);
    setReports(data ?? []);
  }

  useEffect(() => {
    loadReports(location);
    const last = getLastSubmitAt(location);
    if (last) setCooldownUntil(last + THROTTLE_MS);
  }, [location]);

  function changeLocation(next: string) {
    setLocation(next);
    localStorage.setItem(LOCATION_STORAGE_KEY, next);
  }

  const onCooldown = cooldownUntil != null && Date.now() < cooldownUntil;

  async function submitReport(status: "free" | "taken") {
    if (onCooldown) return;
    setSubmitting(true);
    await supabase.from("reports").insert({
      status,
      location_label: location,
      lat: userPosition?.lat ?? null,
      lng: userPosition?.lng ?? null,
      reporter_id: deviceId,
    });
    const now = Date.now();
    setLastSubmitAt(location, now);
    setCooldownUntil(now + THROTTLE_MS);
    await loadReports(location);
    setSubmitting(false);
  }

  return (
    <main style={{ padding: "2rem", maxWidth: 480, margin: "0 auto" }}>
      <h1 style={{ textAlign: "center" }}>ParkQuest</h1>

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
          disabled={submitting || onCooldown}
          style={{
            flex: 1,
            padding: "1rem",
            fontSize: "1.1rem",
            background: "#2e7d32",
            color: "white",
            border: "none",
            borderRadius: 8,
            opacity: onCooldown ? 0.5 : 1,
          }}
        >
          Spot Free
        </button>
        <button
          onClick={() => submitReport("taken")}
          disabled={submitting || onCooldown}
          style={{
            flex: 1,
            padding: "1rem",
            fontSize: "1.1rem",
            background: "#c62828",
            color: "white",
            border: "none",
            borderRadius: 8,
            opacity: onCooldown ? 0.5 : 1,
          }}
        >
          Spot Taken
        </button>
      </div>
      {onCooldown && (
        <p style={{ textAlign: "center", color: "#888", fontSize: "0.8rem" }}>
          You just reported here — try again in a minute.
        </p>
      )}

      {userPosition && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Map userPosition={userPosition} reports={reports} deviceId={deviceId} />
        </div>
      )}

      <h2 style={{ fontSize: "1rem", color: "#555" }}>Recent reports</h2>
      {reports.length === 0 ? (
        <p style={{ color: "#888" }}>No reports in the last 10 minutes.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {reports.map((r) => (
            <li
              key={r.id}
              style={{
                padding: "0.5rem 0",
                borderBottom: "1px solid #eee",
              }}
            >
              {r.status === "free" ? "🟢 Free" : "🔴 Taken"} — {minutesAgo(r.created_at)}
              {r.reporter_id === deviceId && (
                <span style={{ color: "#9c27b0" }}> (you)</span>
              )}
              {userPosition && r.lat != null && r.lng != null && (
                <span style={{ color: "#aaa" }}>
                  {" — "}
                  {formatDistance(distanceMeters(userPosition, { lat: r.lat, lng: r.lng }))}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
