// =============== SUPABASE CONFIG ===============
// Fill these from Supabase > Project Settings > API
const SUPABASE_URL = "https://vnxzrbcctnsnacbobepk.supabase.com";
const SUPABASE_ANON_KEY = "sb_publishable_6dZkRXqDe-ubVWIdoYcAfw_EQoQdFvA";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.sb = sb;
