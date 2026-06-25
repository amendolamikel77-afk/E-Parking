import { createClient } from "@supabase/supabase-js";

// Server-only client using the service-role key. Never import this from a
// "use client" file — it bypasses Row Level Security.
export function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}
