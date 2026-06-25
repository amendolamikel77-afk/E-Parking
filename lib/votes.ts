import { supabase } from "@/lib/supabase";

export type VoteCounts = Record<string, { confirm: number; dispute: number }>;

export async function fetchVoteCounts(reportIds: string[]): Promise<VoteCounts> {
  if (reportIds.length === 0) return {};
  const { data } = await supabase
    .from("report_votes")
    .select("report_id, vote")
    .in("report_id", reportIds);

  const counts: VoteCounts = {};
  for (const row of data ?? []) {
    if (!counts[row.report_id]) counts[row.report_id] = { confirm: 0, dispute: 0 };
    counts[row.report_id][row.vote as "confirm" | "dispute"]++;
  }
  return counts;
}

export async function fetchMyVotedReportIds(
  userId: string,
  reportIds: string[]
): Promise<Set<string>> {
  if (reportIds.length === 0) return new Set();
  const { data } = await supabase
    .from("report_votes")
    .select("report_id")
    .eq("voter_id", userId)
    .in("report_id", reportIds);
  return new Set((data ?? []).map((r) => r.report_id));
}

export function reportStatus(counts: { confirm: number; dispute: number } | undefined) {
  if (!counts || (counts.confirm === 0 && counts.dispute === 0)) return "pending" as const;
  if (counts.confirm > counts.dispute) return "verified" as const;
  if (counts.dispute > counts.confirm) return "disputed" as const;
  return "pending" as const;
}
