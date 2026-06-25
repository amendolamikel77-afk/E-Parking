// Map the unbounded raw reliability score to a 0–10 credibility rating.
// New users start at 5/10; each net vote shifts them ±0.5, clamped to [0, 10].
export function credibilityOutOf10(rawScore: number | null) {
  if (rawScore == null) return null;
  const value = 5 + rawScore * 0.5;
  return Math.min(Math.max(value, 0), 10);
}

export function credibilityColor(score: number) {
  if (score >= 7) return "#2e7d32";
  if (score >= 4) return "#f9a825";
  return "#c62828";
}

export function credibilityLabel(score: number) {
  if (score >= 8.5) return "Highly trusted";
  if (score >= 7) return "Trusted";
  if (score >= 4) return "Building trust";
  return "Low trust";
}
