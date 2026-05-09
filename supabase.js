// =============== SUPABASE CONFIG ===============
// Replace with your project values from Supabase → Project Settings → API
const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
const SUPABASE_ANON_KEY = "YOUR-ANON-KEY";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
