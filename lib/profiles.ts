import { supabase } from "@/lib/supabase";

export async function fetchReliabilityScores(userIds: string[]): Promise<Record<string, number>> {
  const ids = Array.from(new Set(userIds.filter(Boolean))) as string[];
  if (ids.length === 0) return {};
  const { data } = await supabase.from("profiles").select("id, reliability_score").in("id", ids);
  const map: Record<string, number> = {};
  for (const row of data ?? []) map[row.id] = row.reliability_score;
  return map;
}

export async function fetchProfileNames(userIds: string[]): Promise<Record<string, string>> {
  const ids = Array.from(new Set(userIds.filter(Boolean))) as string[];
  if (ids.length === 0) return {};
  const { data } = await supabase.from("profiles").select("id, full_name, email").in("id", ids);
  const map: Record<string, string> = {};
  for (const row of data ?? []) {
    map[row.id] = row.full_name || (row.email ? row.email.split("@")[0] : "Someone");
  }
  return map;
}
