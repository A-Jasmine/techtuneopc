// =============== SUPABASE CONFIG ===============
// Fill these from Supabase > Project Settings > API
const SUPABASE_URL = "https://ywupquhxwosxmcimnajp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_vRDmqLYEOrXvGRBOeYlJQQ_B3ckuMzS";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.sb = sb;
