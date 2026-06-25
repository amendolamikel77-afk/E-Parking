import { supabase } from "@/lib/supabase";

export async function fetchReliabilityScores(userIds: string[]): Promise<Record<string, number>> {
  const ids = Array.from(new Set(userIds.filter(Boolean))) as string[];
  if (ids.length === 0) return {};
  const { data } = await supabase.from("profiles").select("id, reliability_score").in("id", ids);
  const map: Record<string, number> = {};
  for (const row of data ?? []) map[row.id] = row.reliability_score;
  return map;
}
