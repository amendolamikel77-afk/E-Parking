"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Stats = {
  totalReports: number;
  uniqueReporters: number;
  reportsLast7Days: number;
};

export default function StatsPage() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    async function load() {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const { count: totalReports } = await supabase
        .from("reports")
        .select("id", { count: "exact", head: true });

      const { count: reportsLast7Days } = await supabase
        .from("reports")
        .select("id", { count: "exact", head: true })
        .gte("created_at", sevenDaysAgo);

      const { data: reporterRows } = await supabase
        .from("reports")
        .select("reporter_id")
        .gte("created_at", sevenDaysAgo);

      const uniqueReporters = new Set(
        (reporterRows ?? []).map((r) => r.reporter_id).filter(Boolean)
      ).size;

      setStats({
        totalReports: totalReports ?? 0,
        uniqueReporters,
        reportsLast7Days: reportsLast7Days ?? 0,
      });
    }
    load();
  }, []);

  return (
    <main style={{ padding: "2rem", maxWidth: 480, margin: "0 auto" }}>
      <h1>Stats</h1>
      {!stats ? (
        <p>Loading...</p>
      ) : (
        <ul>
          <li>Total reports (all time): {stats.totalReports}</li>
          <li>Reports in the last 7 days: {stats.reportsLast7Days}</li>
          <li>Unique reporters in the last 7 days: {stats.uniqueReporters}</li>
        </ul>
      )}
    </main>
  );
}
