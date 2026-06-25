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
        .select("user_id")
        .gte("created_at", sevenDaysAgo);

      const uniqueReporters = new Set(
        (reporterRows ?? []).map((r) => r.user_id).filter(Boolean)
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
    <main className="app-shell fade-in">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark">P</span>
          Stats
        </span>
      </header>

      {!stats ? (
        <section className="card">
          <p className="empty">Loading…</p>
        </section>
      ) : (
        <section className="card">
          <h2 className="card-title">Experiment progress</h2>
          <div className="stat-grid">
            <div>
              <div className="stat-num">{stats.totalReports}</div>
              <div className="stat-label">Total reports</div>
            </div>
            <div>
              <div className="stat-num">{stats.reportsLast7Days}</div>
              <div className="stat-label">Last 7 days</div>
            </div>
            <div>
              <div className="stat-num">{stats.uniqueReporters}</div>
              <div className="stat-label">Reporters (7d)</div>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
