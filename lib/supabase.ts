import { createClient } from "@supabase/supabase-js";

// Fall back to a harmless placeholder so the production build (which
// pre-renders pages) never crashes when env vars aren't available at build
// time. Real values come from the environment at build/runtime.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
