# Techtune Payroll — Supabase Edition

## Setup
1. Open `supabase.js` and replace `SUPABASE_URL` and `SUPABASE_ANON_KEY`
   with values from Supabase → Project Settings → API.
2. Make sure the SQL schema (employees, pay_periods, entries, deductions) is created.
3. **For local testing**, RLS may block anonymous writes. Either:
   - Disable RLS on the four tables (quick, dev only), or
   - Add policies allowing anon `SELECT/INSERT/UPDATE/DELETE`.
4. Open `index.html` in a browser (or serve via any static host).

## What changed
- All data is stored in Supabase (no more localStorage).
- Add Employee dialog now picks a **Base Rate** (₱1000 / ₱1100 / ₱1200 per day).
- Daily entries have a **Half Day** checkbox → pays ½ base rate.
- Holiday and Offset checkboxes now show a clear, colored checkmark.
- Tasteful color accents on summary tiles, toggles, dropdown, and net pay bar.
- Payroll dropdown only shows the **selected employee's** pay periods.
