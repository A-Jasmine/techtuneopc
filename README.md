# Techtune Payroll — Supabase Edition

## Setup
1. Open `supabase.js` and replace `SUPABASE_URL` and `SUPABASE_ANON_KEY`
   with values from Supabase → Project Settings → API.
2. Make sure the SQL schema (employees, pay_periods, entries, deductions) is created.
3. **Authentication**: This app now requires login.
   - In Supabase → Authentication → Users, create at least one user (email + password).
   - In Authentication → Providers, make sure **Email** is enabled.
   - For RLS: either disable RLS on the four tables (dev only), or add policies allowing
     `authenticated` users to `SELECT/INSERT/UPDATE/DELETE`.
4. Open `login.html` first (or open `index.html` — it will redirect to login if you're not signed in).

## What's new in this build
- **Holiday no longer removes base pay.** When you tick *Holiday Pay*, the employee still
  gets their daily base rate (because they actually went onsite), and the ₱1,000 holiday
  bonus is added on top. Combine with *Half Day* if they only worked a half holiday.
- **Pay period filter.** When you select an employee on the Payroll tab, a filter bar
  appears: filter by month or search by date string.
- **Classy login page** (`login.html`) connected to Supabase Auth. The main app gates
  itself behind a session and shows a *Sign Out* button in the topbar.
- **Friendly delete warnings.** All destructive actions (delete employee, delete pay
  period, delete daily entry, delete deduction, sign out) now use a custom confirm
  dialog with a clear danger icon, instead of the browser's plain `confirm()` popup.

## Files
- `login.html` — sign-in screen
- `index.html` — main app (auth-gated)
- `app.js` — application logic
- `styles.css` — styles
- `supabase.js` — Supabase client config (edit this!)
