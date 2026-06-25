"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

const LOCATION = "Main St Lot";
const TEN_MINUTES_MS = 10 * 60 * 1000;

type Report = {
  id: string;
  status: "free" | "taken";
  created_at: string;
};

function minutesAgo(isoDate: string) {
  const minutes = Math.floor((Date.now() - new Date(isoDate).getTime()) / 60000);
  if (minutes < 1) return "just now";
  return `${minutes} min ago`;
}

type UserPosition = { lat: number; lng: number };

export default function Home() {
  const [reports, setReports] = useState<Report[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [userPosition, setUserPosition] = useState<UserPosition | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);

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
      }
    );
  }, []);

  async function loadReports() {
    const cutoff = new Date(Date.now() - TEN_MINUTES_MS).toISOString();
    const { data } = await supabase
      .from("reports")
      .select("id, status, created_at")
      .eq("location_label", LOCATION)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(10);
    setReports(data ?? []);
  }

  useEffect(() => {
    loadReports();
  }, []);

  async function submitReport(status: "free" | "taken") {
    setSubmitting(true);
    await supabase.from("reports").insert({ status, location_label: LOCATION });
    await loadReports();
    setSubmitting(false);
  }

  return (
    <main style={{ padding: "2rem", maxWidth: 480, margin: "0 auto" }}>
      <h1 style={{ textAlign: "center" }}>ParkQuest</h1>
      <p style={{ textAlign: "center", color: "#555" }}>{LOCATION}</p>
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
          disabled={submitting}
          style={{
            flex: 1,
            padding: "1rem",
            fontSize: "1.1rem",
            background: "#2e7d32",
            color: "white",
            border: "none",
            borderRadius: 8,
          }}
        >
          Spot Free
        </button>
        <button
          onClick={() => submitReport("taken")}
          disabled={submitting}
          style={{
            flex: 1,
            padding: "1rem",
            fontSize: "1.1rem",
            background: "#c62828",
            color: "white",
            border: "none",
            borderRadius: 8,
          }}
        >
          Spot Taken
        </button>
      </div>

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
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
