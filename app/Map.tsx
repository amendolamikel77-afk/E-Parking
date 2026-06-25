"use client";

import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import { useEffect } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { credibilityColor } from "@/lib/credibility";

// Pans/zooms the map whenever `focus` changes (e.g. a report row is clicked).
function MapFocus({ focus }: { focus: { lat: number; lng: number; key: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if (focus) map.flyTo([focus.lat, focus.lng], 18, { duration: 0.8 });
  }, [focus, map]);
  return null;
}

const userIcon = new L.Icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

function reportIcon(
  status: "free" | "taken",
  createdAt: string,
  lifetimeMs: number,
  credibility: number | null,
  isMine: boolean
) {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageFraction = Math.min(Math.max(ageMs / lifetimeMs, 0), 1);
  // 1.0 opacity when just reported, fading to 0.25 as it nears expiry.
  const opacity = 1 - ageFraction * 0.75;
  const color = credibility != null ? credibilityColor(credibility) : "#757575";
  const borderColor = isMine ? "#9c27b0" : "white";
  const emoji = status === "free" ? "🅿️" : "🚗";

  return L.divIcon({
    className: "",
    html: `<div style="
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: ${color};
      opacity: ${opacity};
      border: 3px solid ${borderColor};
      box-shadow: 0 0 3px rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
    ">${emoji}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

type Report = {
  id: string;
  status: "free" | "taken";
  created_at: string;
  lat: number | null;
  lng: number | null;
  user_id: string | null;
};

type Props = {
  userPosition: { lat: number; lng: number };
  reports: Report[];
  userId: string | null;
  reporterCredibility: Record<string, number | null>;
  lifetimeMs: number;
  onSelectReport: (reportId: string) => void;
  focus: { lat: number; lng: number; key: number } | null;
};

function ageLabel(isoDate: string) {
  const seconds = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}

export default function Map({
  userPosition,
  reports,
  userId,
  reporterCredibility,
  lifetimeMs,
  onSelectReport,
  focus,
}: Props) {
  return (
    <MapContainer
      center={[userPosition.lat, userPosition.lng]}
      zoom={16}
      style={{ height: 440, width: "100%" }}
    >
      <MapFocus focus={focus} />
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; OpenStreetMap contributors'
        maxZoom={19}
      />
      <Marker position={[userPosition.lat, userPosition.lng]} icon={userIcon}>
        <Popup>You</Popup>
      </Marker>
      {reports
        .filter((r) => r.lat != null && r.lng != null)
        .map((r) => {
          const isMine = r.user_id != null && r.user_id === userId;
          const credibility = r.user_id ? reporterCredibility[r.user_id] ?? null : null;
          return (
            <Marker
              key={r.id}
              position={[r.lat as number, r.lng as number]}
              icon={reportIcon(r.status, r.created_at, lifetimeMs, credibility, isMine)}
              eventHandlers={{ click: () => onSelectReport(r.id) }}
            >
              <Popup>
                {r.status === "free" ? "Free" : "Taken"} — {ageLabel(r.created_at)}
                {isMine && " (you)"}
                <br />
                Reporter credibility: {credibility != null ? credibility.toFixed(1) : "—"}/10
              </Popup>
            </Marker>
          );
        })}
    </MapContainer>
  );
}
