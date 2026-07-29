import {createClient} from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const isConfigured = Boolean(url && key);

export const supabase = createClient(
  url || "https://configuration-required.invalid",
  key || "configuration-required",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);

