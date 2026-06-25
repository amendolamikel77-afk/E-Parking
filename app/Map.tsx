"use client";

import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const userIcon = new L.Icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

const TEN_MINUTES_MS = 10 * 60 * 1000;

function reportIcon(status: "free" | "taken", createdAt: string, isMine: boolean) {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageFraction = Math.min(Math.max(ageMs / TEN_MINUTES_MS, 0), 1);
  // 1.0 opacity when just reported, fading to 0.25 as it nears expiry.
  const opacity = 1 - ageFraction * 0.75;
  const color = status === "free" ? "#2e7d32" : "#c62828";
  const borderColor = isMine ? "#9c27b0" : "white";

  return L.divIcon({
    className: "",
    html: `<div style="
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: ${color};
      opacity: ${opacity};
      border: 3px solid ${borderColor};
      box-shadow: 0 0 2px rgba(0,0,0,0.5);
    "></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
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
};

function minutesAgo(isoDate: string) {
  const minutes = Math.floor((Date.now() - new Date(isoDate).getTime()) / 60000);
  if (minutes < 1) return "just now";
  return `${minutes} min ago`;
}

export default function Map({ userPosition, reports, userId }: Props) {
  return (
    <MapContainer
      center={[userPosition.lat, userPosition.lng]}
      zoom={16}
      style={{ height: 300, width: "100%", borderRadius: 8 }}
    >
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
        .map((r) => (
          <Marker
            key={r.id}
            position={[r.lat as number, r.lng as number]}
            icon={reportIcon(
              r.status,
              r.created_at,
              r.user_id != null && r.user_id === userId
            )}
          >
            <Popup>
              {r.status === "free" ? "Free" : "Taken"} — {minutesAgo(r.created_at)}
              {r.user_id != null && r.user_id === userId && " (you)"}
            </Popup>
          </Marker>
        ))}
    </MapContainer>
  );
}
