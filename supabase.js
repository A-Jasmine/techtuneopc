// =============== SUPABASE CONFIG ===============
// Fill these from Supabase > Project Settings > API
const SUPABASE_URL = "https://ywupquhxwosxmcimnajp.supabase.com";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3dXBxdWh4d29zeG1jaW1uYWpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyOTQ0NDQsImV4cCI6MjA5Mzg3MDQ0NH0.cpeWtzF2PqKi8Hzqn4wh4EAagumC0mEJ6pmZ7NIvhrw";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.sb = sb;
