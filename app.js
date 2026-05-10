// =============== STATE (in-memory cache, hydrated from Supabase) ===============
const state = { employees: [], periods: [] };

const round2 = n => Math.round((n || 0) * 100) / 100;
const peso = n => "\u20B1" + (n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = n => (n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// =============== CONSTANTS ===============
// Default brands list for the dropdown in Settings
const DEFAULT_BRAND_NAMES = ["Leilei", "Aion", "GAC", "MG", "Chery", "Omoda & Jaecoo"];

// Commission rates — loaded from localStorage so Settings tab can override them
// Structure: { brandKey: { sedan, mpv, sunroof, scrap, units_rate, sedan_qty, ... }, ... }
// Also stores brand metadata: { __brands: [{ key, label }] }
function loadCommissionRates() {
  try {
    const saved = localStorage.getItem("commissionRates");
    if (saved) {
      const p = JSON.parse(saved);
      // Ensure each brand has all required fields
      const brands = p.__brands || [{ key: "byd", label: "BYD" }, { key: "geely", label: "Geely" }, { key: "other", label: "Other" }];
      brands.forEach(b => {
        if (!p[b.key]) p[b.key] = { sedan: 0, mpv: 0, sunroof: 0, scrap: 0, units_rate: 0 };
        if (p[b.key].scrap === undefined) p[b.key].scrap = 0;
        if (p[b.key].units_rate === undefined) p[b.key].units_rate = 0;
      });
      p.__brands = brands;
      return p;
    }
  } catch (e) { }
  return {
    __brands: [
      { key: "byd", label: "BYD" },
      { key: "geely", label: "Geely" },
      { key: "other", label: "Other" }
    ],
    byd: { sedan: 150, mpv: 200, sunroof: 50, scrap: 0, units_rate: 0 },
    geely: { sedan: 200, mpv: 200, sunroof: 200, scrap: 0, units_rate: 0 },
    other: { sedan: 0, mpv: 0, sunroof: 0, scrap: 0, units_rate: 0 }
  };
}
function saveCommissionRates(rates) {
  localStorage.setItem("commissionRates", JSON.stringify(rates));
}
let COMMISSION_RATES = loadCommissionRates();
// Keep legacy aliases in sync so existing calcEntry still works
let BYD = COMMISSION_RATES.byd;
let GEELY = COMMISSION_RATES.geely;
const TUBE_RATE = 50, HOLIDAY_AMT = 1000, OFFSET_AMT = 1000;
const SPECIAL_HOLIDAY_PCT = 0.30; // 30% of base rate
const BASE_RATE_OPTIONS = [1000, 1100, 1200];
const LOCATIONS = ["Calamba", "Sta. Rosa", "Las Piñas", "Alabang", "Makati", "Quezon City", "Pasig", "Manila", "Cavite", "Other"];
const COMPANY = { name: "Techtune Solutions Enterprises OPC", addr1: "Unit 6505 Valencia Casa De Sequoia", addr2: "Padre Diego Cera Ave., Elias Aldana, Las Pinas City", email: "techtunesolutions.enterprises@gmail.com" };

// derive hourly OT from base rate (orig 1000 -> 156.25 -> /6.4)
const otRateFromBase = b => round2((b || 1000) / 6.4);

// =============== CALC ===============
function calcEntryBase(e, baseRate) {
  if (e.is_offset) return OFFSET_AMT;
  // holiday_type "offsite" = employee didn't come in; only holiday bonus applies, no base pay
  const holidayType = e.holiday_type || (e.is_holiday ? "onsite" : "none");
  if (holidayType === "offsite") return 0;
  // special_holiday: employee came in, gets base pay + 30% bonus
  const br = baseRate || 1000;
  return e.is_halfday ? round2(br / 2) : br;
}
function safeDiv(n) { return n > 0 ? n : 1; }

// Parse units_list from entry (stored as JSON string or array)
function parseUnitsList(e) {
  if (Array.isArray(e.units_list)) return e.units_list;
  if (typeof e.units_list === "string" && e.units_list) {
    try { return JSON.parse(e.units_list); } catch (ex) { }
  }
  return [];
}

// Vehicle lists: { sedan: [{qty,div},...], mpv: [...], sunroof: [...], scrap: [...], tubes: [...] }
// Stored as JSON string in entry.vehicle_lists
const VEHICLE_TYPES = ["sedan", "mpv", "sunroof", "scrap", "tubes"];
const VEHICLE_LABELS = { sedan: "Sedan/SUV", mpv: "MPV", sunroof: "Sunroof", scrap: "Scrapping", tubes: "Tubes" };

function parseVehicleLists(e) {
  let parsed = null;
  if (e.vehicle_lists && typeof e.vehicle_lists === "object" && !Array.isArray(e.vehicle_lists)) {
    parsed = e.vehicle_lists;
  } else if (typeof e.vehicle_lists === "string" && e.vehicle_lists) {
    try { parsed = JSON.parse(e.vehicle_lists); } catch (ex) {}
  }
  if (!parsed) parsed = {};
  // For each type, ensure it's an array; seed from legacy scalar fields if empty
  VEHICLE_TYPES.forEach(t => {
    if (!Array.isArray(parsed[t]) || parsed[t].length === 0) {
      const legacyQtyKey = t === "scrap" ? "scrapping_qty" : t + "_qty";
      const legacyDivKey = t === "scrap" ? "scrap_div" : t + "_div";
      const legacyQty = +e[legacyQtyKey] || 0;
      const legacyDiv = +e[legacyDivKey] || 1;
      // Only seed a row if there's actual legacy data, otherwise empty array
      parsed[t] = legacyQty > 0 ? [{ qty: legacyQty, div: legacyDiv }] : [];
    }
  });
  return parsed;
}

// Sum all rows for a vehicle type given its rate
function sumVehicleRows(rows, rate, globalDiv) {
  return (rows || []).reduce((s, row) => s + round2((+row.qty || 0) * rate / safeDiv(+row.div || globalDiv)), 0);
}

function getBrandRates(brandKey) {
  const cr = COMMISSION_RATES;
  if (brandKey && cr[brandKey]) return cr[brandKey];
  if (cr.other) return cr.other;
  const brands = cr.__brands || [];
  const first = brands[0];
  return first && cr[first.key] ? cr[first.key] : { sedan: 0, mpv: 0, sunroof: 0, scrap: 0, units_rate: 0 };
}

function calcEntry(e, baseRate) {
  const r = getBrandRates(e.brand);
  const globalDiv = safeDiv(e.divide_by || 1);

  // Vehicle lists (multi-row dynamic fields)
  const vl = parseVehicleLists(e);

  // Units list: each row has qty and div, rate comes from brand's units_rate
  const unitsList = parseUnitsList(e);
  const unitsCommission = unitsList.reduce((sum, u) => {
    return sum + round2((+u.qty || 0) * (r.units_rate || 0) / safeDiv(+u.div || 1));
  }, 0);

  const commission = round2(
    sumVehicleRows(vl.sedan, r.sedan || 0, globalDiv) +
    sumVehicleRows(vl.mpv, r.mpv || 0, globalDiv) +
    sumVehicleRows(vl.sunroof, r.sunroof || 0, globalDiv) +
    sumVehicleRows(vl.scrap, r.scrap || 0, globalDiv) +
    sumVehicleRows(vl.tubes, TUBE_RATE, globalDiv) +
    unitsCommission
  );
  const otHrs = (+e.ot_hours || 0) + (+e.ot_minutes || 0) / 60;
  const otPay = round2(otHrs * (+e.ot_rate || otRateFromBase(baseRate)));
  // holiday_type: "onsite" = full pay + bonus, "offsite" = bonus only, "special" = +30% of base rate
  const holidayType = e.holiday_type || (e.is_holiday ? "onsite" : "none");
  let holiday = 0;
  if (holidayType === "onsite" || holidayType === "offsite") {
    holiday = HOLIDAY_AMT;
  } else if (holidayType === "special") {
    holiday = round2((baseRate || 1000) * SPECIAL_HOLIDAY_PCT);
  }
  const base = calcEntryBase(e, baseRate);
  const gas = +e.gas_allowance || 0;
  return { base, commission, otPay, holiday, gas, total: round2(base + commission + otPay + holiday + gas) };
}
function calcPeriod(p) {
  const emp = state.employees.find(e => e.id === p.employee_id);
  const baseRate = emp ? emp.base_rate : 1000;
  let basic = 0, ot = 0, com = 0, hol = 0, gas = 0;
  (p.entries || []).forEach(e => { const c = calcEntry(e, baseRate); basic += c.base; ot += c.otPay; com += c.commission; hol += c.holiday; gas += c.gas; });
  const earnings = round2(basic + ot + com + hol + gas);
  const ded = round2((p.deductions || []).reduce((s, d) => s + (+d.amount || 0), 0));
  return { basic: round2(basic), ot: round2(ot), commission: round2(com), holiday: round2(hol), gas: round2(gas), earnings, deductions: ded, net: round2(earnings - ded) };
}
function to12h(t) { if (!t) return ""; const [h, m] = t.split(":"); let H = +h; const ap = H >= 12 ? "PM" : "AM"; H = H % 12 || 12; return `${H}:${(m || "00").padStart(2, "0")} ${ap}`; }
function formatOT(h, m) { h = +h || 0; m = +m || 0; if (!h && !m) return "0"; if (h && m) return `${h}h ${m}m`; return h ? `${h}h` : `${m}m`; }

// =============== SUPABASE LOAD ===============
async function loadAll() {
  const [emps, pers, ents, deds] = await Promise.all([
    sb.from('employees').select('*').order('created_at'),
    sb.from('pay_periods').select('*').order('created_at'),
    sb.from('entries').select('*').order('date'),
    sb.from('deductions').select('*').order('created_at'),
  ]);
  if (emps.error) return toast("Load employees failed: " + emps.error.message);
  state.employees = emps.data || [];
  state.periods = (pers.data || []).map(p => ({
    ...p,
    entries: (ents.data || []).filter(e => e.pay_period_id === p.id),
    deductions: (deds.data || []).filter(d => d.pay_period_id === p.id),
  }));
}

// =============== THEME ===============
function applyTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  const btn = document.getElementById("theme-toggle-btn");
  if (btn) {
    btn.innerHTML = dark
      ? '<i data-lucide="sun"></i>'
      : '<i data-lucide="moon"></i>';
    btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
    lucide.createIcons();
  }
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const next = !isDark;
  localStorage.setItem("techtune-theme", next ? "dark" : "light");
  applyTheme(next);
  // Re-render charts so they pick up the new palette
  const dashActive = document.getElementById("view-dashboard")?.classList.contains("active");
  if (dashActive) renderDashboard();
}

// Apply saved theme immediately (before any render)
(function () {
  const saved = localStorage.getItem("techtune-theme");
  if (saved === "dark") document.documentElement.setAttribute("data-theme", "dark");
})();


document.querySelectorAll(".tab").forEach(t => {
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".view").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    document.getElementById("view-" + t.dataset.tab).classList.add("active");
    // Clean up floating net pay widget when leaving payroll tab
    const fnp = document.getElementById("floating-net-pay");
    if (fnp && fnp._ioCleanup) fnp._ioCleanup();
    if (t.dataset.tab === "dashboard") renderDashboard();
    if (t.dataset.tab === "settings") renderSettings();
  };
});

// =============== EMPLOYEES ===============
function openEditEmpDialog(id) {
  const emp = state.employees.find(e => e.id === id);
  if (!emp) return;
  document.getElementById("edit-emp-id").value = emp.id;
  document.getElementById("edit-emp-name").value = emp.name;
  document.getElementById("edit-emp-pos").value = emp.position || "";
  document.getElementById("edit-emp-base").value = String(emp.base_rate || 1000);
  document.getElementById("edit-emp-modal").classList.add("open");
  lucide.createIcons();
}
function closeEditEmpDialog() { document.getElementById("edit-emp-modal").classList.remove("open"); }

async function saveEditEmp() {
  const id = document.getElementById("edit-emp-id").value;
  const name = document.getElementById("edit-emp-name").value.trim();
  if (!name) return toast("Name required");
  const position = document.getElementById("edit-emp-pos").value.trim();
  const base_rate = +document.getElementById("edit-emp-base").value || 1000;
  const { error } = await sb.from('employees').update({ name, position, base_rate }).eq('id', id);
  if (error) return toast("Save failed: " + error.message);
  const emp = state.employees.find(e => e.id === id);
  if (emp) { emp.name = name; emp.position = position; emp.base_rate = base_rate; }
  closeEditEmpDialog();
  renderAll();
  toast("Employee updated ✓");
}

function openEmpDialog() {
  document.getElementById("emp-modal").classList.add("open");
  document.getElementById("emp-name").value = "";
  document.getElementById("emp-pos").value = "Automotive Window Tint Installer";
  document.getElementById("emp-base").value = "1000";
  lucide.createIcons();
}
function closeEmpDialog() { document.getElementById("emp-modal").classList.remove("open"); }

async function saveEmp() {
  const name = document.getElementById("emp-name").value.trim();
  if (!name) return toast("Name required");
  const position = document.getElementById("emp-pos").value;
  const base_rate = +document.getElementById("emp-base").value || 1000;
  const { data, error } = await sb.from('employees').insert({ name, position, base_rate }).select().single();
  if (error) return toast("Save failed: " + error.message);
  state.employees.push(data);
  closeEmpDialog(); renderAll(); toast("Employee added");
}

async function deleteEmp(id) {
  const emp = state.employees.find(e => e.id === id);
  const ok = await confirmDanger({
    title: "Delete Employee?",
    message: `This will permanently delete <strong>${emp ? emp.name : 'this employee'}</strong> and ALL their pay periods, entries and deductions. This action cannot be undone.`,
    confirmText: "Delete Employee",
  });
  if (!ok) return;
  const { error } = await sb.from('employees').delete().eq('id', id);
  if (error) return toast("Delete failed: " + error.message);
  state.employees = state.employees.filter(e => e.id !== id);
  state.periods = state.periods.filter(p => p.employee_id !== id);
  renderAll();
  toast("Employee deleted");
}

let empSearch = "";

function onEmpSearchChange() {
  empSearch = (document.getElementById("emp-search-input")?.value || "").toLowerCase().trim();
  renderEmployees();
}

function renderEmployees() {
  const el = document.getElementById("emp-list");
  const searchBar = document.getElementById("emp-search-bar");

  if (state.employees.length === 0) {
    if (searchBar) searchBar.style.display = "none";
    el.innerHTML = '<div class="empty-state">No employees yet — add one to get started.</div>';
    return;
  }

  if (searchBar) searchBar.style.display = "flex";
  const inp = document.getElementById("emp-search-input");
  if (inp && document.activeElement !== inp) inp.value = empSearch;

  const filtered = empSearch
    ? state.employees.filter(e =>
      e.name.toLowerCase().includes(empSearch) ||
      (e.position || "").toLowerCase().includes(empSearch))
    : state.employees;

  if (filtered.length === 0) {
    el.innerHTML = '<div class="empty-state">No employees match your search.</div>';
    lucide.createIcons();
    return;
  }

  el.innerHTML = filtered.map(e => `
    <div class="list-item">
      <div class="emp-avatar">${e.name.charAt(0).toUpperCase()}</div>
      <div class="info">
        <strong>${e.name}</strong>
        <small>${e.position || ''} • <span class="rate-chip">₱${(+e.base_rate || 1000).toLocaleString()}/day</span></small>
      </div>
      <div class="row">
        <button class="btn accent" onclick="openEditEmpDialog('${e.id}')"><i data-lucide="pencil"></i> Edit</button>
        <button class="btn danger" onclick="deleteEmp('${e.id}')"><i data-lucide="trash-2"></i> Delete</button>
      </div>
    </div>`).join("");
  lucide.createIcons();
}

// =============== PERIODS ===============
function refreshEmpDropdown() {
  const sel = document.getElementById("pp-emp");
  const prev = sel.value;
  sel.innerHTML = state.employees.length
    ? '<option value="">— Select employee —</option>' + state.employees.map(e => `<option value="${e.id}">${e.name}</option>`).join("")
    : '<option value="">No employees</option>';
  if (prev && state.employees.find(e => e.id === prev)) sel.value = prev;
}

async function addPeriod() {
  const empId = document.getElementById("pp-emp").value;
  if (!empId) return toast("Select an employee first");
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb.from('pay_periods').insert({ employee_id: empId, start_date: today, end_date: today, pay_date: today }).select().single();
  if (error) return toast("Create failed: " + error.message);
  state.periods.push({ ...data, entries: [], deductions: [] });
  renderPayroll();
}

async function deletePeriod(id) {
  const p = state.periods.find(x => x.id === id);
  const ok = await confirmDanger({
    title: "Delete Pay Period?",
    message: `This will permanently delete the pay period <strong>${p ? p.start_date + ' → ' + p.end_date : ''}</strong>, including all daily entries and deductions. This cannot be undone.`,
    confirmText: "Delete Period",
  });
  if (!ok) return;
  const { error } = await sb.from('pay_periods').delete().eq('id', id);
  if (error) return toast("Delete failed: " + error.message);
  state.periods = state.periods.filter(p => p.id !== id);
  renderPayroll();
  toast("Pay period deleted");
}

const periodFilter = { month: "", search: "" };

function renderPayroll() {
  refreshEmpDropdown();
  const selectedEmpId = document.getElementById("pp-emp").value;
  const list = document.getElementById("period-list");
  const filterBar = document.getElementById("pp-filter-bar");

  if (!selectedEmpId) {
    if (filterBar) filterBar.style.display = "none";
    list.innerHTML = '<div class="empty-state"><i data-lucide="user-check" style="width:32px;height:32px;opacity:.4"></i><div>Select an employee above to view their pay periods.</div></div>';
    document.getElementById("period-detail").innerHTML = "";
    lucide.createIcons();
    return;
  }

  let empPeriods = state.periods.filter(p => p.employee_id === selectedEmpId);

  // Build month options from this employee's periods
  const monthSet = new Set();
  empPeriods.forEach(p => { if (p.pay_date) monthSet.add(p.pay_date.slice(0, 7)); });
  const months = [...monthSet].sort().reverse();

  if (filterBar) {
    filterBar.style.display = "flex";
    const monthSel = document.getElementById("pp-month");
    const searchInp = document.getElementById("pp-search");
    if (monthSel) {
      const cur = periodFilter.month;
      monthSel.innerHTML = '<option value="">All months</option>' + months.map(m => {
        const d = new Date(m + "-01");
        const label = d.toLocaleString("en-US", { month: "long", year: "numeric" });
        return `<option value="${m}" ${m === cur ? "selected" : ""}>${label}</option>`;
      }).join("");
    }
    if (searchInp && document.activeElement !== searchInp) searchInp.value = periodFilter.search;
  }

  let filtered = empPeriods.slice();
  if (periodFilter.month) filtered = filtered.filter(p => (p.pay_date || "").startsWith(periodFilter.month));
  if (periodFilter.search) {
    const q = periodFilter.search.toLowerCase();
    filtered = filtered.filter(p =>
      (p.start_date || "").includes(q) || (p.end_date || "").includes(q) || (p.pay_date || "").includes(q)
    );
  }
  filtered.sort((a, b) => (b.start_date || "").localeCompare(a.start_date || ""));

  if (filtered.length === 0) {
    list.innerHTML = empPeriods.length === 0
      ? '<div class="empty-state">No pay periods for this employee yet — click <strong>New Period</strong>.</div>'
      : '<div class="empty-state">No periods match your filter.</div>';
    document.getElementById("period-detail").innerHTML = "";
    lucide.createIcons();
    return;
  }
  list.innerHTML = filtered.map(p => {
    const t = calcPeriod(p);
    return `<div class="list-item">
      <div class="period-dot"></div>
      <div class="info"><strong>${p.start_date} → ${p.end_date}</strong><small>${p.entries.length} day${p.entries.length !== 1 ? 's' : ''} worked • Net: <span class="net-highlight">${peso(t.net)}</span></small></div>
      <div class="row">
        <button class="btn accent" onclick="editPeriod('${p.id}')"><i data-lucide="edit"></i> Edit</button>
        <button class="btn danger" onclick="deletePeriod('${p.id}')"><i data-lucide="trash-2"></i></button>
      </div>
    </div>`;
  }).join("");
  lucide.createIcons();
}

function onPeriodFilterChange() {
  const m = document.getElementById("pp-month");
  const s = document.getElementById("pp-search");
  periodFilter.month = m ? m.value : "";
  periodFilter.search = s ? s.value.trim() : "";
  renderPayroll();
}
function clearPeriodFilter() {
  periodFilter.month = "";
  periodFilter.search = "";
  renderPayroll();
}

function editPeriod(id) {
  const p = state.periods.find(x => x.id === id);
  const emp = state.employees.find(e => e.id === p.employee_id);
  const t = calcPeriod(p);

  // Attendance summary chips
  const fullDays = p.entries.filter(e => !e.is_halfday && !e.is_holiday && !e.is_offset).length;
  const halfDays = p.entries.filter(e => e.is_halfday).length;
  const holidayDays = p.entries.filter(e => e.is_holiday && e.holiday_type !== "special").length;
  const specialDays = p.entries.filter(e => (e.holiday_type || "") === "special").length;
  const offsetDays = p.entries.filter(e => e.is_offset).length;
  const attendanceChips = `
    <div class="attendance-chips">
      <span class="chip chip-full"><i data-lucide="sun"></i> ${fullDays} Full</span>
      ${halfDays ? `<span class="chip chip-half"><i data-lucide="clock"></i> ${halfDays} Half</span>` : ""}
      ${holidayDays ? `<span class="chip chip-holiday"><i data-lucide="star"></i> ${holidayDays} Holiday</span>` : ""}
      ${specialDays ? `<span class="chip chip-half"><i data-lucide="calendar-heart"></i> ${specialDays} Special Hol</span>` : ""}
      ${offsetDays ? `<span class="chip chip-offset"><i data-lucide="refresh-cw"></i> ${offsetDays} Offset</span>` : ""}
    </div>`;

  const div = document.getElementById("period-detail");
  div.innerHTML = `
    <div class="period-card">
      <div class="card-head">
        <div>
          <h2><i data-lucide="calendar"></i> ${emp.name} — Pay Period</h2>
          <small>Base ₱${(+emp.base_rate || 1000).toLocaleString()}/day • Edit work entries and compute net pay</small>
          ${attendanceChips}
        </div>
        <div class="row">
          <button class="btn" onclick="exportCSV('${p.id}')"><i data-lucide="file-spreadsheet"></i> Excel</button>
          <button class="btn" onclick="exportPDF('${p.id}')"><i data-lucide="file-down"></i> PDF</button>
        </div>
      </div>
      <div class="entry-grid">
        <label>Start<input type="date" value="${p.start_date}" onchange="updatePeriod('${p.id}','start_date',this.value)"></label>
        <label>End<input type="date" value="${p.end_date}" onchange="updatePeriod('${p.id}','end_date',this.value)"></label>
        <label>Pay Date<input type="date" value="${p.pay_date}" onchange="updatePeriod('${p.id}','pay_date',this.value)"></label>
      </div>

      <div class="period-summary">
        <div class="ps-blue">Basic<strong>${peso(t.basic)}</strong></div>
        <div class="ps-amber">OT<strong>${peso(t.ot)}</strong></div>
        <div class="ps-green">Commission<strong>${peso(t.commission)}</strong></div>
        <div class="ps-purple">Holiday<strong>${peso(t.holiday)}</strong></div>
        <div class="ps-cyan">Gas<strong>${peso(t.gas)}</strong></div>
        <div class="ps-rose">Deductions<strong>${peso(t.deductions)}</strong></div>
      </div>
      <div class="net-bar"><span>NET PAY</span><span>${peso(t.net)}</span></div>

      <div class="section-label"><i data-lucide="list"></i> Daily Work Log</div>
      <div id="entries-${p.id}"></div>
      <button class="btn primary" onclick="addEntry('${p.id}')"><i data-lucide="plus"></i> Add Day</button>

      <div class="section-label" style="margin-top:22px"><i data-lucide="minus-circle"></i> Deductions</div>
      <div id="deds-${p.id}"></div>
      <button class="btn" onclick="addDed('${p.id}')"><i data-lucide="plus"></i> Add Deduction</button>
    </div>`;
  renderEntries(p.id); renderDeds(p.id); lucide.createIcons();

  // ── Floating Net Pay pill ──
  // Remove any stale one first
  const stale = document.getElementById("floating-net-pay");
  if (stale) stale.remove();

  const floatEl = document.createElement("div");
  floatEl.id = "floating-net-pay";
  floatEl.className = "floating-net-pay";
  floatEl.innerHTML = `<span class="fnp-label">Net Pay</span><span class="fnp-amount">${peso(t.net)}</span><button class="fnp-top-btn" title="Back to top" onclick="document.querySelector('.net-bar').scrollIntoView({behavior:'smooth',block:'center'})"><i data-lucide="arrow-up"></i></button>`;
  document.body.appendChild(floatEl);
  lucide.createIcons();

  // Keep net pay amount in sync whenever updateEntry recalculates
  const _origUpdate = window._netBarUpdater;
  window._netBarUpdater = (netVal) => {
    const fa = document.querySelector("#floating-net-pay .fnp-amount");
    if (fa) fa.textContent = netVal;
  };

  // Show/hide based on whether the real net-bar is visible
  const netBar = div.querySelector(".net-bar");
  const addDayBtn = div.querySelector("button[onclick^='addEntry']");

  const io = new IntersectionObserver(entries => {
    const netBarVisible = entries.some(e => e.target === netBar && e.isIntersecting);
    floatEl.classList.toggle("fnp-visible", !netBarVisible);
  }, { threshold: 0.1 });

  if (netBar) io.observe(netBar);

  // Cleanup observer when user navigates away
  floatEl._ioCleanup = () => { io.disconnect(); floatEl.remove(); };
}

async function updatePeriod(id, key, val) {
  const p = state.periods.find(x => x.id === id);
  p[key] = val;
  const { error } = await sb.from('pay_periods').update({ [key]: val }).eq('id', id);
  if (error) toast("Update failed: " + error.message);
  editPeriod(id);
}

// =============== ENTRIES ===============
// Pull current default qty for first brand (the default brand on new entries)
const DEFAULT_BRAND_KEY = () => {
  const brands = COMMISSION_RATES.__brands || [];
  return brands.length ? brands[0].key : "geely";
};
const DEFAULT_UNITS = () => COMMISSION_RATES[DEFAULT_BRAND_KEY()] || {};
async function addEntry(pid) {
  const p = state.periods.find(x => x.id === pid);
  const emp = state.employees.find(e => e.id === p.employee_id);
  const defaultBrand = DEFAULT_BRAND_KEY();
  const newEntry = {
    pay_period_id: pid, date: new Date().toISOString().slice(0, 10), location: "Calamba",
    time_in: "08:00", time_out: "17:00", ot_hours: 0, ot_minutes: 0, ot_rate: otRateFromBase(emp.base_rate),
    brand: defaultBrand,
    sedan_qty: DEFAULT_UNITS().sedan_qty || 0,
    mpv_qty: DEFAULT_UNITS().mpv_qty || 0,
    sunroof_qty: DEFAULT_UNITS().sunroof_qty || 0,
    scrapping_qty: DEFAULT_UNITS().scrapping_qty || 0,
    tubes_qty: DEFAULT_UNITS().tubes_qty || 0,
    units_list: JSON.stringify([]),
    vehicle_lists: JSON.stringify({ sedan: [], mpv: [], sunroof: [], scrap: [], tubes: [] }),
    divide_by: 1,
    sedan_div: 1, mpv_div: 1, sunroof_div: 1, scrap_div: 1, tubes_div: 1,
    gas_allowance: 0, is_holiday: false, is_offset: false, is_halfday: false,
    holiday_type: "none", notes: ""
  };
  const { data, error } = await sb.from('entries').insert(newEntry).select().single();
  if (error) return toast("Add entry failed: " + error.message);
  p.entries.push(data);
  editPeriod(pid);
  toast("Day added ✓");
  // Scroll to the newly added entry after render
  requestAnimationFrame(() => {
    const newEl = document.getElementById("entry-" + data.id);
    if (newEl) newEl.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}
async function delEntry(pid, eid) {
  const p = state.periods.find(x => x.id === pid);
  const e = p.entries.find(x => x.id === eid);
  const ok = await confirmDanger({
    title: "Delete Daily Entry?",
    message: `This will remove the entry for <strong>${e ? e.date : 'this day'}</strong> from this pay period. This action cannot be undone.`,
    confirmText: "Delete Entry",
  });
  if (!ok) return;
  const { error } = await sb.from('entries').delete().eq('id', eid);
  if (error) return toast("Delete failed: " + error.message);
  p.entries = p.entries.filter(e => e.id !== eid);
  editPeriod(pid);
}

const NUMERIC_KEYS = ["sedan_qty", "mpv_qty", "sunroof_qty", "scrapping_qty", "tubes_qty", "divide_by", "sedan_div", "mpv_div", "sunroof_div", "scrap_div", "tubes_div", "ot_hours", "ot_minutes", "gas_allowance", "ot_rate"];
const BOOL_KEYS = ["is_holiday", "is_offset", "is_halfday"];
const STRING_KEYS = ["holiday_type"];

async function updateEntry(pid, eid, key, val) {
  const p = state.periods.find(x => x.id === pid);
  const e = p.entries.find(x => x.id === eid);
  if (NUMERIC_KEYS.includes(key)) val = +val || 0;
  if (BOOL_KEYS.includes(key)) val = !!val;
  if (key === "units_list") {
    // val is already the parsed array; store serialized for DB, keep array in memory
    e.units_list = val;
    const serialized = JSON.stringify(val);
    const { error } = await sb.from('entries').update({ units_list: serialized }).eq('id', eid);
    if (error) toast("Save failed: " + error.message);
  } else if (key === "vehicle_lists") {
    e.vehicle_lists = val;
    const serialized = JSON.stringify(val);
    const { error } = await sb.from('entries').update({ vehicle_lists: serialized }).eq('id', eid);
    if (error) toast("Save failed: " + error.message);
  } else {
    e[key] = val;
    const { error } = await sb.from('entries').update({ [key]: val }).eq('id', eid);
    if (error) toast("Save failed: " + error.message);
  }

  const emp = state.employees.find(x => x.id === p.employee_id);
  const c = calcEntry(e, emp.base_rate);
  const tot = document.querySelector(`#entry-${eid} .entry-total`);
  if (tot) tot.textContent = "Total: " + peso(c.total);
  const totals = document.querySelector(`#entry-${eid} .entry-totals`);
  if (totals) totals.innerHTML = `<span>Base: <strong>${peso(c.base)}</strong></span><span>Com: <strong>${peso(c.commission)}</strong></span><span>OT: <strong>${peso(c.otPay)}</strong></span><span>Holiday: <strong>${peso(c.holiday)}</strong></span>`;
  const baseEl = document.querySelector(`#entry-${eid} .base-display`);
  if (baseEl) baseEl.textContent = peso(c.base);
  const t = calcPeriod(p);
  const sum = document.querySelector("#period-detail .period-summary");
  if (sum) sum.innerHTML = `
    <div class="ps-blue">Basic<strong>${peso(t.basic)}</strong></div>
    <div class="ps-amber">OT<strong>${peso(t.ot)}</strong></div>
    <div class="ps-green">Commission<strong>${peso(t.commission)}</strong></div>
    <div class="ps-purple">Holiday<strong>${peso(t.holiday)}</strong></div>
    <div class="ps-cyan">Gas<strong>${peso(t.gas)}</strong></div>
    <div class="ps-rose">Deductions<strong>${peso(t.deductions)}</strong></div>`;
  const nb = document.querySelector("#period-detail .net-bar");
  if (nb) nb.innerHTML = `<span>NET PAY</span><span>${peso(t.net)}</span>`;
  if (window._netBarUpdater) window._netBarUpdater(peso(t.net));
}

function stepField(pid, eid, key, delta, btn) {
  const inp = btn.closest('.comm-field-wrap').querySelector('input[type="number"]');
  const newVal = Math.max(0, (+inp.value || 0) + delta);
  inp.value = newVal;
  updateEntry(pid, eid, key, newVal);
}

// ── Vehicle Lists (dynamic multi-row per vehicle type) ──
function saveVehicleLists(pid, eid, vl) {
  const p = state.periods.find(x => x.id === pid);
  const e = p.entries.find(x => x.id === eid);
  e.vehicle_lists = vl;
  const serialized = JSON.stringify(vl);
  sb.from('entries').update({ vehicle_lists: serialized }).eq('id', eid)
    .then(({ error }) => { if (error) toast("Save failed: " + error.message); });
  updateEntryTotals(pid, eid);
}
function addVehicleRow(pid, eid, type) {
  const p = state.periods.find(x => x.id === pid);
  const e = p.entries.find(x => x.id === eid);
  const vl = parseVehicleLists(e);
  vl[type].push({ qty: 0, div: 1 });
  saveVehicleLists(pid, eid, vl);
  renderVehicleListUI(pid, eid, type);
}
function removeVehicleRow(pid, eid, type, idx) {
  const p = state.periods.find(x => x.id === pid);
  const e = p.entries.find(x => x.id === eid);
  const vl = parseVehicleLists(e);
  vl[type].splice(idx, 1);
  saveVehicleLists(pid, eid, vl);
  renderVehicleListUI(pid, eid, type);
}
function updateVehicleRow(pid, eid, type, idx, field, val) {
  const p = state.periods.find(x => x.id === pid);
  const e = p.entries.find(x => x.id === eid);
  const vl = parseVehicleLists(e);
  if (!vl[type] || !vl[type][idx]) return;
  vl[type][idx][field] = field === "div" ? (+val || 1) : (+val || 0);
  saveVehicleLists(pid, eid, vl);
}
function renderVehicleListUI(pid, eid, type) {
  const p = state.periods.find(x => x.id === pid);
  const e = p.entries.find(x => x.id === eid);
  const wrap = document.getElementById(`vlist-${eid}-${type}`);
  if (!wrap) return;
  const vl = parseVehicleLists(e);
  const rows = vl[type] || [];
  const r = getBrandRates(e.brand);
  const rateMap = { sedan: r.sedan || 0, mpv: r.mpv || 0, sunroof: r.sunroof || 0, scrap: r.scrap || 0, tubes: TUBE_RATE };
  const rate = rateMap[type] || 0;
  const label = VEHICLE_LABELS[type] || type;
  const isOffsite = (e.holiday_type || (e.is_holiday ? "onsite" : "none")) === "offsite";
  const dis = isOffsite ? "disabled" : "";

  wrap.innerHTML = rows.map((row, i) => {
    const divOpts = Array.from({length:10},(_,k)=>k+1).map(n=>`<option value="${n}" ${(+row.div||1)===n?"selected":""}>${String.fromCharCode(247)}${n}</option>`).join("");
    const isFirst = i === 0;
    return `
    <div class="vlist-row" style="display:grid;grid-template-columns:1fr 90px 28px;gap:6px;align-items:end;${isFirst ? '' : 'margin-top:6px'}">
      <label style="margin:0;gap:3px">
        ${isFirst ? `<span style="font-size:10px;font-weight:700;letter-spacing:.6px;color:var(--text-dim)">${label} <span style="font-weight:400;color:var(--text-dim)">(₱${rate}/ea)</span></span>` : `<span style="font-size:10px;color:var(--text-dim);font-style:italic">+ more</span>`}
        <input type="number" min="0" value="${row.qty || 0}" ${dis} onchange="updateVehicleRow('${pid}','${eid}','${type}',${i},'qty',this.value)">
      </label>
      <div style="display:flex;flex-direction:column;gap:3px">
        ${isFirst ? `<span style="font-size:10px;font-weight:700;letter-spacing:.6px;color:var(--text-dim)">Workers</span>` : `<span style="font-size:10px;opacity:0">w</span>`}
        <select style="font-size:12px" title="Divide by" ${dis} onchange="updateVehicleRow('${pid}','${eid}','${type}',${i},'div',this.value)">${divOpts}</select>
      </div>
      <button type="button" class="icon-btn" style="width:26px;height:34px;padding:0;color:var(--danger);border:none;background:none;align-self:end;margin-bottom:1px" title="Remove row" ${dis} onclick="removeVehicleRow('${pid}','${eid}','${type}',${i})"><i data-lucide="x"></i></button>
    </div>`;
  }).join("") + `
  <button type="button" class="btn" style="width:100%;margin-top:${rows.length?'8':'0'}px;font-size:11px;padding:4px 8px" ${dis} onclick="addVehicleRow('${pid}','${eid}','${type}')"><i data-lucide="plus"></i> Add ${label}</button>`;
  lucide.createIcons();
}

// Units list helpers
function addUnitsRow(pid, eid) {
  const p = state.periods.find(x => x.id === pid);
  const e = p.entries.find(x => x.id === eid);
  const list = parseUnitsList(e);
  list.push({ desc: "", qty: 0, div: 1 });
  updateEntry(pid, eid, "units_list", list);
  // Re-render just the units list section
  renderUnitsListUI(pid, eid);
  updateEntryTotals(pid, eid);
}
function removeUnitsRow(pid, eid, idx) {
  const p = state.periods.find(x => x.id === pid);
  const e = p.entries.find(x => x.id === eid);
  const list = parseUnitsList(e);
  list.splice(idx, 1);
  updateEntry(pid, eid, "units_list", list);
  renderUnitsListUI(pid, eid);
  updateEntryTotals(pid, eid);
}
function updateUnitsRow(pid, eid, idx, field, val) {
  const p = state.periods.find(x => x.id === pid);
  const e = p.entries.find(x => x.id === eid);
  const list = parseUnitsList(e);
  if (!list[idx]) return;
  if (field === "qty" || field === "div") val = +val || (field === "div" ? 1 : 0);
  list[idx][field] = val;
  updateEntry(pid, eid, "units_list", list);
  updateEntryTotals(pid, eid);
}
function renderUnitsListUI(pid, eid) {
  const p = state.periods.find(x => x.id === pid);
  const e = p.entries.find(x => x.id === eid);
  const wrap = document.getElementById(`units-list-${eid}`);
  if (!wrap) return;
  const list = parseUnitsList(e);
  const r = getBrandRates(e.brand);
  const isOffsite = (e.holiday_type || (e.is_holiday ? "onsite" : "none")) === "offsite";
  const disAttr = isOffsite ? "disabled" : "";

  // Each unit row becomes its own comm-field-wrap card, plus a final add-button card
  // We render the wrapper itself as the grid cell spanning container
  wrap.innerHTML = list.map((u, i) => `
    <div class="comm-field-wrap comm-field-wrap--unit-row">
      <label>
        <span style="display:flex;align-items:center;justify-content:space-between;gap:4px">
          <span>Units Qty <span style="font-weight:400;font-size:10px;color:var(--text-dim)">(₱${(r.units_rate || 0).toLocaleString()}/ea)</span></span>
          <button type="button" class="icon-btn" style="width:18px;height:18px;padding:0;flex-shrink:0;color:var(--danger);border:none;background:none" title="Remove" ${disAttr} onclick="removeUnitsRow('${pid}','${eid}',${i})"><i data-lucide="x"></i></button>
        </span>
        <input type="number" min="0" value="${u.qty || 0}" style="width:100%;text-align:center;padding:6px 8px;font-size:13px;margin-top:4px" ${disAttr} onchange="updateUnitsRow('${pid}','${eid}',${i},'qty',this.value)">
      </label>
      <div class="div-row"><span class="div-label">Workers</span>
        <select style="flex:1;font-size:12px" title="Divide by (# of workers)" ${disAttr} onchange="updateUnitsRow('${pid}','${eid}',${i},'div',this.value)">
          ${Array.from({length:10},(_,k)=>k+1).map(n=>`<option value="${n}" ${(+u.div||1)===n?"selected":""}>${String.fromCharCode(247)}${n}</option>`).join("")}
        </select>
      </div>
    </div>`).join("") + `
  <div class="comm-field-wrap comm-field-wrap--add-unit">
    <span class="div-label" style="visibility:hidden">Add</span>
    <button type="button" class="btn" style="width:100%" ${disAttr} onclick="addUnitsRow('${pid}','${eid}')"><i data-lucide="plus"></i> Add Unit</button>
    <div class="div-row" style="visibility:hidden"><span class="div-label">Workers</span></div>
  </div>`;
  lucide.createIcons();
}
function updateEntryTotals(pid, eid) {
  const p = state.periods.find(x => x.id === pid);
  const e = p.entries.find(x => x.id === eid);
  const emp = state.employees.find(x => x.id === p.employee_id);
  const c = calcEntry(e, emp.base_rate);
  const tot = document.querySelector(`#entry-${eid} .entry-total`);
  if (tot) tot.textContent = "Total: " + peso(c.total);
  const totals = document.querySelector(`#entry-${eid} .entry-totals`);
  if (totals) totals.innerHTML = `<span>Base: <strong>${peso(c.base)}</strong></span><span>Com: <strong>${peso(c.commission)}</strong></span><span>OT: <strong>${peso(c.otPay)}</strong></span><span>Holiday: <strong>${peso(c.holiday)}</strong></span>`;
  const t = calcPeriod(p);
  const sum = document.querySelector("#period-detail .period-summary");
  if (sum) sum.innerHTML = `
    <div class="ps-blue">Basic<strong>${peso(t.basic)}</strong></div>
    <div class="ps-amber">OT<strong>${peso(t.ot)}</strong></div>
    <div class="ps-green">Commission<strong>${peso(t.commission)}</strong></div>
    <div class="ps-purple">Holiday<strong>${peso(t.holiday)}</strong></div>
    <div class="ps-cyan">Gas<strong>${peso(t.gas)}</strong></div>
    <div class="ps-rose">Deductions<strong>${peso(t.deductions)}</strong></div>`;
  const nb = document.querySelector("#period-detail .net-bar");
  if (nb) nb.innerHTML = `<span>NET PAY</span><span>${peso(t.net)}</span>`;
  if (window._netBarUpdater) window._netBarUpdater(peso(t.net));
}

function renderEntries(pid) {
  const p = state.periods.find(x => x.id === pid);
  const emp = state.employees.find(x => x.id === p.employee_id);
  const baseRate = emp.base_rate || 1000;
  const wrap = document.getElementById("entries-" + pid);
  wrap.innerHTML = p.entries.map(e => {
    const c = calcEntry(e, baseRate);
    const holidayType = e.holiday_type || (e.is_holiday ? "onsite" : "none");
    const isOffsite = holidayType === "offsite";
    const baseLabel = e.is_offset ? `Offset day`
      : holidayType === "offsite" ? `Holiday Offsite · ₱0 base (holiday bonus only)`
        : holidayType === "onsite" ? (e.is_halfday ? `Holiday Onsite · Half day · ₱${(baseRate / 2).toLocaleString()}` : `Holiday Onsite · ₱${baseRate.toLocaleString()}`)
          : holidayType === "special" ? (e.is_halfday ? `Special Holiday · Half day · ₱${(baseRate / 2).toLocaleString()} + ${Math.round(baseRate * 0.3)}` : `Special Holiday · ₱${baseRate.toLocaleString()} + ₱${Math.round(baseRate * 0.3)} bonus`)
            : e.is_halfday ? `Half day · ₱${(baseRate / 2).toLocaleString()}` : `Full day · ₱${baseRate.toLocaleString()}`;

    // Per-field divide helpers (÷1 – ÷10)
    const divSel = (field, val) => {
      const cur = val || 1;
      const opts = Array.from({length:10},(_,i)=>i+1).map(n=>`<option value="${n}" ${cur===n?"selected":""}>${String.fromCharCode(247)}${n}</option>`).join("");
      return `<select style="width:80px;font-size:12px" onchange="updateEntry('${pid}','${e.id}','${field}',this.value)" title="Divide by (# of workers)">${opts}</select>`;
    };

    // Brand rate hint
    const r = getBrandRates(e.brand);
    const brandHint = `<span class="brand-rate-hint" style="font-size:11px;color:var(--text-dim);display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap">
      <span>Sedan ₱${r.sedan}</span><span>MPV ₱${r.mpv}</span><span>Sunroof ₱${r.sunroof}</span>
    </span>`;

    // Build dynamic brand options
    const brandOptions = (COMMISSION_RATES.__brands || []).map(b =>
      `<option value="${b.key}" ${e.brand === b.key ? "selected" : ""}>${b.label}</option>`
    ).join("");

    const offOpacity = isOffsite ? "opacity:.38;pointer-events:none;user-select:none" : "";

    return `<div class="entry${isOffsite ? ' entry-offsite' : ''}" id="entry-${e.id}">
      <div class="entry-grid">
        <label>Date<input type="date" value="${e.date}" onchange="updateEntry('${pid}','${e.id}','date',this.value)"></label>
        <label>Location<select onchange="updateEntry('${pid}','${e.id}','location',this.value)">${LOCATIONS.map(l => `<option ${l === e.location ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label style="${isOffsite ? offOpacity : ''}">Time In<input type="time" value="${e.time_in || ''}" ${isOffsite ? "disabled" : ""} onchange="updateEntry('${pid}','${e.id}','time_in',this.value)"></label>
        <label style="${isOffsite ? offOpacity : ''}">Time Out<input type="time" value="${e.time_out || ''}" ${isOffsite ? "disabled" : ""} onchange="updateEntry('${pid}','${e.id}','time_out',this.value)"></label>
      </div>
      <div class="base-info-row">
        <span class="base-info-label"><i data-lucide="wallet"></i> ${baseLabel}</span>
        <span class="base-info-amount">Base: <strong class="base-display">${peso(c.base)}</strong></span>
      </div>
      <div class="entry-section">
        <h4>Day Type</h4>
        <div class="entry-grid" style="align-items:end">
          <label class="toggle-check tone-amber ${e.is_halfday && !isOffsite ? 'is-checked' : ''}" style="${isOffsite ? offOpacity : ''}">
            <input type="checkbox" ${e.is_halfday ? "checked" : ""} ${isOffsite ? "disabled" : ""} onchange="updateEntry('${pid}','${e.id}','is_halfday',this.checked);this.closest('.toggle-check').classList.toggle('is-checked',this.checked)">
            <span class="toggle-box"><svg viewBox="0 0 14 12" fill="none"><polyline points="2,6.5 5.5,10 12,2.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            Half Day (½ base rate)
          </label>
          <label style="flex-direction:column;gap:4px">
            <span style="font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--text-dim)">Holiday Pay</span>
            <select onchange="onHolidayTypeChange('${pid}','${e.id}',this.value)" style="${holidayType === 'offsite' ? 'border-color:var(--purple);background:var(--purple-bg);color:var(--purple)' : holidayType === 'onsite' ? 'border-color:var(--green);background:var(--green-bg);color:var(--green)' : holidayType === 'special' ? 'border-color:var(--amber);background:var(--amber-bg);color:var(--amber)' : ''}">
              <option value="none"    ${holidayType === "none" ? "selected" : ""}>None</option>
              <option value="onsite"  ${holidayType === "onsite" ? "selected" : ""}>Holiday Onsite (+₱1,000)</option>
              <option value="offsite" ${holidayType === "offsite" ? "selected" : ""}>Holiday Offsite (+₱1,000, no work)</option>
              <option value="special" ${holidayType === "special" ? "selected" : ""}>Special Holiday (+30% of daily rate)</option>
            </select>
          </label>
          <label class="toggle-check tone-blue ${e.is_offset ? "is-checked" : ""}">
            <input type="checkbox" ${e.is_offset ? "checked" : ""} onchange="updateEntry('${pid}','${e.id}','is_offset',this.checked);this.closest('.toggle-check').classList.toggle('is-checked',this.checked)">
            <span class="toggle-box"><svg viewBox="0 0 14 12" fill="none"><polyline points="2,6.5 5.5,10 12,2.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            Offset (₱1,000)
          </label>
        </div>
      </div>
      <div class="entry-section" style="${isOffsite ? offOpacity : ''}">
        <h4>Overtime</h4>
        <div class="entry-grid">
          <label>OT Hrs<input type="number" min="0" value="${e.ot_hours || 0}" ${isOffsite ? "disabled" : ""} onchange="updateEntry('${pid}','${e.id}','ot_hours',this.value)"></label>
          <label>OT Min<input type="number" min="0" max="59" value="${e.ot_minutes || 0}" ${isOffsite ? "disabled" : ""} onchange="updateEntry('${pid}','${e.id}','ot_minutes',this.value)"></label>
          <label>OT Rate (₱/hr)<input type="number" min="0" step="0.01" value="${e.ot_rate || otRateFromBase(baseRate)}" ${isOffsite ? "disabled" : ""} onchange="updateEntry('${pid}','${e.id}','ot_rate',this.value)"></label>
        </div>
      </div>
      <div class="entry-section" style="${isOffsite ? offOpacity : ''}">
        <h4>Commission</h4>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
          <label style="margin:0;flex-direction:row;align-items:center;gap:8px;font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--text-dim)">Brand
            <select onchange="updateEntry('${pid}','${e.id}','brand',this.value);renderEntries('${pid}')" ${isOffsite ? "disabled" : ""}>
              ${brandOptions}
            </select>
          </label>
          ${brandHint}
        </div>
        <div class="commission-grid">
          <div class="comm-field-wrap" id="vlist-${e.id}-sedan"><!-- rendered by renderVehicleListUI --></div>
          <div class="comm-field-wrap" id="vlist-${e.id}-mpv"><!-- rendered by renderVehicleListUI --></div>
          <div class="comm-field-wrap" id="vlist-${e.id}-sunroof"><!-- rendered by renderVehicleListUI --></div>
          <div class="comm-field-wrap" id="vlist-${e.id}-scrap"><!-- rendered by renderVehicleListUI --></div>
          <div class="comm-field-wrap" id="vlist-${e.id}-tubes"><!-- rendered by renderVehicleListUI --></div>
          <div class="comm-field-wrap comm-field-wrap--units" id="units-list-${e.id}">
            <!-- rendered by renderUnitsListUI -->
          </div>
        </div>
      </div>
      <div class="entry-section">
        <h4>Extras</h4>
        <div class="entry-grid">
          <label>Gas Allowance<input type="number" min="0" value="${e.gas_allowance || 0}" onchange="updateEntry('${pid}','${e.id}','gas_allowance',this.value)"></label>
        </div>
        <label style="margin-top:8px;display:flex;flex-direction:column;gap:6px;font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--text-dim)">Notes<input value="${e.notes || ""}" onchange="updateEntry('${pid}','${e.id}','notes',this.value)"></label>
      </div>
      <div class="entry-foot">
        <div class="entry-totals"><span>Base: <strong>${peso(c.base)}</strong></span><span>Com: <strong>${peso(c.commission)}</strong></span><span>OT: <strong>${peso(c.otPay)}</strong></span><span>Holiday: <strong>${peso(c.holiday)}</strong></span></div>
        <div style="display:flex;align-items:center;gap:10px"><span class="entry-total">Total: ${peso(c.total)}</span><button class="btn danger" onclick="delEntry('${pid}','${e.id}')"><i data-lucide="trash-2"></i></button></div>
      </div>
    </div>`;
  }).join("");
  lucide.createIcons();
  // Populate dynamic vehicle lists and units lists for each entry
  p.entries.forEach(e => {
    VEHICLE_TYPES.forEach(t => renderVehicleListUI(pid, e.id, t));
    renderUnitsListUI(pid, e.id);
  });
}

// Handle holiday type change — syncs legacy is_holiday flag too
async function onHolidayTypeChange(pid, eid, type) {
  const p = state.periods.find(x => x.id === pid);
  const e = p.entries.find(x => x.id === eid);
  e.holiday_type = type;
  e.is_holiday = (type === "onsite" || type === "offsite" || type === "special");
  await sb.from('entries').update({ holiday_type: type, is_holiday: e.is_holiday }).eq('id', eid);
  editPeriod(pid); // full re-render so offsite greying applies
}

// =============== DEDUCTIONS ===============
async function addDed(pid) {
  const p = state.periods.find(x => x.id === pid);
  const { data, error } = await sb.from('deductions').insert({ pay_period_id: pid, label: "", amount: 0 }).select().single();
  if (error) return toast("Add failed: " + error.message);
  p.deductions = p.deductions || [];
  p.deductions.push(data);
  editPeriod(pid);
}
async function delDed(pid, did) {
  const p = state.periods.find(x => x.id === pid);
  const d = p.deductions.find(x => x.id === did);
  const ok = await confirmDanger({
    title: "Delete Deduction?",
    message: `Remove <strong>${d && d.label ? d.label : 'this deduction'}</strong>${d && d.amount ? ' (' + peso(d.amount) + ')' : ''} from this pay period?`,
    confirmText: "Delete",
  });
  if (!ok) return;
  const { error } = await sb.from('deductions').delete().eq('id', did);
  if (error) return toast("Delete failed: " + error.message);
  p.deductions = p.deductions.filter(d => d.id !== did);
  editPeriod(pid);
}
async function updateDed(pid, did, key, val) {
  const p = state.periods.find(x => x.id === pid);
  const d = p.deductions.find(x => x.id === did);
  d[key] = key === "amount" ? (+val || 0) : val;
  const { error } = await sb.from('deductions').update({ [key]: d[key] }).eq('id', did);
  if (error) toast("Save failed: " + error.message);
  editPeriod(pid);
}
function renderDeds(pid) {
  const p = state.periods.find(x => x.id === pid);
  const w = document.getElementById("deds-" + pid);
  w.innerHTML = (p.deductions || []).map(d => `<div class="deduct-row"><input placeholder="Label" value="${d.label || ""}" onchange="updateDed('${pid}','${d.id}','label',this.value)"><input type="number" placeholder="Amount" value="${d.amount || 0}" onchange="updateDed('${pid}','${d.id}','amount',this.value)"><button class="btn danger" onclick="delDed('${pid}','${d.id}')"><i data-lucide="trash-2"></i></button></div>`).join("");
  lucide.createIcons();
}

// =============== DASHBOARD ===============
let chartBar, chartPie, chartLine;
let dashboardMonth = new Date().toISOString().slice(0, 7); // e.g. "2025-01"
let historyEmpId = "";

function buildMonthOptions() {
  const monthSet = new Set();
  state.periods.forEach(p => { if (p.pay_date) monthSet.add(p.pay_date.slice(0, 7)); });
  const months = [...monthSet].sort().reverse();
  return months;
}

function renderDashboard() {
  // ── Inject month selector into KPI area if not already present ──
  const kpiMonthWrap = document.getElementById("kpi-month-wrap");
  if (kpiMonthWrap) {
    const months = buildMonthOptions();
    const sel = document.getElementById("kpi-month-sel");
    const current = sel ? sel.value : dashboardMonth;
    kpiMonthWrap.innerHTML = `
      <select id="kpi-month-sel" style="font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--border-hi);background:var(--surface);color:var(--text);cursor:pointer" onchange="dashboardMonth=this.value;renderDashboard()">
        ${months.map(m => {
      const d = new Date(m + "-01");
      const label = d.toLocaleString("en-US", { month: "short", year: "numeric" });
      return `<option value="${m}" ${m === (current || dashboardMonth) ? "selected" : ""}>${label}</option>`;
    }).join("")}
      </select>`;
    if (sel && current) dashboardMonth = current;
  }

  document.getElementById("kpi-emp").textContent = state.employees.length;
  document.getElementById("kpi-per").textContent = state.periods.length;
  let netTotal = 0, monthTotal = 0;
  const perEmp = {}, breakdown = { Basic: 0, OT: 0, Commission: 0, Holiday: 0, Gas: 0 };
  state.periods.forEach(p => {
    const t = calcPeriod(p); netTotal += t.net;
    if ((p.pay_date || "").startsWith(dashboardMonth)) monthTotal += t.net;
    const emp = state.employees.find(e => e.id === p.employee_id);
    if (emp) perEmp[emp.name] = (perEmp[emp.name] || 0) + t.net;
    breakdown.Basic += t.basic; breakdown.OT += t.ot; breakdown.Commission += t.commission;
    breakdown.Holiday += t.holiday; breakdown.Gas += t.gas;
  });
  document.getElementById("kpi-net").textContent = peso(netTotal);
  document.getElementById("kpi-month").textContent = peso(monthTotal);

  if (chartBar) chartBar.destroy();
  if (chartPie) chartPie.destroy();
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  Chart.defaults.color = isDark ? '#666666' : '#999999';
  Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";

  const accentColors = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];
  const gridColor = isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.05)';
  const tooltipBg = isDark ? '#1a1a1a' : '#fff';
  const tooltipTitle = isDark ? '#e0e0e0' : '#111';
  const tooltipBody = isDark ? '#888' : '#666';
  const tooltipBorder = isDark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)';
  const tickColor = isDark ? '#555' : '#999';

  chartBar = new Chart(document.getElementById("chart-bar"), {
    type: "bar",
    data: { labels: Object.keys(perEmp), datasets: [{ label: "Net Pay", data: Object.values(perEmp), backgroundColor: Object.keys(perEmp).map((_, i) => accentColors[i % accentColors.length]), borderRadius: 8, borderSkipped: false }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: tooltipBg, borderColor: tooltipBorder, borderWidth: 1, titleColor: tooltipTitle, bodyColor: tooltipBody, padding: 12, callbacks: { label: ctx => ' ₱' + ctx.parsed.y.toLocaleString('en-PH', { minimumFractionDigits: 2 }) } } },
      scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: tickColor, font: { size: 11 } } }, y: { grid: { color: gridColor }, border: { display: false }, ticks: { color: tickColor, font: { size: 11 }, callback: v => '₱' + (v / 1000).toFixed(0) + 'k' } } }
    }
  });
  chartPie = new Chart(document.getElementById("chart-pie"), {
    type: "doughnut",
    data: { labels: Object.keys(breakdown), datasets: [{ data: Object.values(breakdown), backgroundColor: accentColors, borderColor: isDark ? '#1a1a1a' : '#fff', borderWidth: 3, hoverOffset: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '68%',
      plugins: {
        legend: { position: 'right', labels: { color: isDark ? '#777' : '#777', font: { size: 11 }, boxWidth: 10, boxHeight: 10, borderRadius: 3, padding: 14, usePointStyle: true, pointStyle: 'rectRounded' } },
        tooltip: { backgroundColor: tooltipBg, borderColor: tooltipBorder, borderWidth: 1, titleColor: tooltipTitle, bodyColor: tooltipBody, padding: 12, callbacks: { label: ctx => ' ₱' + ctx.parsed.toLocaleString('en-PH', { minimumFractionDigits: 2 }) } }
      }
    }
  });

  renderEarningsHistory();
}

// ── Per-employee earnings history ──
function renderEarningsHistory() {
  const container = document.getElementById("history-section");
  if (!container) return;
  if (!state.employees.length) { container.style.display = "none"; return; }
  container.style.display = "";

  // Populate employee selector
  const empSel = document.getElementById("history-emp-sel");
  if (!historyEmpId && state.employees.length) historyEmpId = state.employees[0].id;
  empSel.innerHTML = state.employees.map(e => `<option value="${e.id}" ${e.id === historyEmpId ? "selected" : ""}>${e.name}</option>`).join("");

  const emp = state.employees.find(e => e.id === historyEmpId);
  if (!emp) return;
  const empPeriods = state.periods.filter(p => p.employee_id === historyEmpId).sort((a, b) => (a.pay_date || a.start_date).localeCompare(b.pay_date || b.start_date));

  // Table
  const tableEl = document.getElementById("history-table-body");
  if (!empPeriods.length) {
    tableEl.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-dim);padding:20px">No pay periods yet.</td></tr>`;
  } else {
    tableEl.innerHTML = empPeriods.map(p => {
      const t = calcPeriod(p);
      return `<tr>
        <td>${p.pay_date || "—"}</td>
        <td>${p.start_date} → ${p.end_date}</td>
        <td style="text-align:right">${peso(t.basic)}</td>
        <td style="text-align:right">${peso(t.commission)}</td>
        <td style="text-align:right">${peso(t.ot)}</td>
        <td style="text-align:right">${peso(t.deductions)}</td>
        <td style="text-align:right;font-weight:700;color:var(--green)">${peso(t.net)}</td>
        <td style="text-align:center">${p.entries.length}</td>
      </tr>`;
    }).join("");
  }

  // Line chart
  if (chartLine) chartLine.destroy();
  const labels = empPeriods.map(p => p.pay_date || p.start_date);
  const netData = empPeriods.map(p => calcPeriod(p).net);
  const isDarkLine = document.documentElement.getAttribute("data-theme") === "dark";
  const gridColorL = isDarkLine ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.05)';
  const tickColorL = isDarkLine ? '#555' : '#999';
  const tooltipBgL = isDarkLine ? '#1a1a1a' : '#fff';
  const tooltipTitleL = isDarkLine ? '#e0e0e0' : '#111';
  const tooltipBodyL = isDarkLine ? '#888' : '#666';
  const tooltipBorderL = isDarkLine ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)';
  chartLine = new Chart(document.getElementById("chart-line"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Net Pay",
        data: netData,
        borderColor: '#2563eb',
        backgroundColor: isDarkLine ? 'rgba(37,99,235,0.15)' : 'rgba(37,99,235,0.08)',
        pointBackgroundColor: '#2563eb',
        pointRadius: 5,
        pointHoverRadius: 7,
        tension: 0.35,
        fill: true,
        borderWidth: 2.5
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: tooltipBgL, borderColor: tooltipBorderL, borderWidth: 1, titleColor: tooltipTitleL, bodyColor: tooltipBodyL, padding: 12, callbacks: { label: ctx => ' ₱' + ctx.parsed.y.toLocaleString('en-PH', { minimumFractionDigits: 2 }) } }
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: tickColorL, font: { size: 10 }, maxRotation: 45 } },
        y: { grid: { color: gridColorL }, border: { display: false }, ticks: { color: tickColorL, font: { size: 11 }, callback: v => '₱' + (v / 1000).toFixed(0) + 'k' } }
      }
    }
  });
}

// ── Settings tab ──
function renderSettings() {
  const el = document.getElementById("settings-content");
  if (!el) return;
  el.innerHTML = `
    <div class="card" id="brand-mgmt-card">
      <div class="card-head">
        <div>
          <h2><i data-lucide="tag"></i> Brand Management</h2>
          <small>Configure commission rates per brand. All brands appear dynamically in payroll entries.</small>
        </div>
        <button class="btn primary" onclick="saveSettings()"><i data-lucide="save"></i> Save All</button>
      </div>
      <div id="brand-mgmt-body" style="display:grid;gap:0"></div>
      <div style="padding:20px 4px 4px;display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">
        <div style="display:flex;flex-direction:column;gap:6px;flex:1;min-width:180px">
          <span style="font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--text-dim)">Add from default list</span>
          <select id="brand-preset-sel" style="width:100%">
            <option value="">— Pick a brand —</option>
            ${DEFAULT_BRAND_NAMES.map(n => `<option value="${n}">${n}</option>`).join("")}
          </select>
        </div>
        <button class="btn accent" onclick="addBrandFromPreset()"><i data-lucide="plus-circle"></i> Add Brand</button>
        <div style="display:flex;flex-direction:column;gap:6px;flex:1;min-width:180px">
          <span style="font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--text-dim)">Or add a custom brand</span>
          <input id="brand-custom-input" placeholder="Brand name…" style="width:100%" />
        </div>
        <button class="btn accent" onclick="addCustomBrand()"><i data-lucide="plus-circle"></i> Add Custom</button>
      </div>
    </div>`;
  renderBrandMgmtBody();
  lucide.createIcons();
}

const RATE_FIELDS = [
  { key: "sedan", label: "Sedan / SUV" },
  { key: "mpv", label: "MPV" },
  { key: "sunroof", label: "Sunroof" },
  { key: "scrap", label: "Scrapping" },
  { key: "units_rate", label: "Units" },
];

function renderBrandMgmtBody() {
  const brands = COMMISSION_RATES.__brands || [];
  const body = document.getElementById("brand-mgmt-body");
  if (!body) return;
  if (!brands.length) {
    body.innerHTML = '<div class="empty-state" style="padding:24px">No brands configured yet — add one below.</div>';
    lucide.createIcons();
    return;
  }
  body.innerHTML = brands.map((b, idx) => {
    const r = COMMISSION_RATES[b.key] || {};
    const isFirst = idx === 0;
    return `
      <div style="padding:20px 4px;${isFirst ? '' : 'border-top:1px solid var(--border);margin-top:4px'}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div style="font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-soft)">${b.label}</div>
          <button class="btn danger" style="padding:4px 10px;font-size:11px" onclick="removeBrand('${b.key}')"><i data-lucide="trash-2"></i> Remove</button>
        </div>
        <div style="display:grid;gap:8px">
          <div style="display:grid;grid-template-columns:160px 1fr 1fr;gap:10px;align-items:end;padding-bottom:4px;border-bottom:1px solid var(--border)">
            <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim)">Vehicle Type</span>
            <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim)">Rate per unit (₱)</span>
            <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim)">Default Qty</span>
          </div>
          ${RATE_FIELDS.map(f => `
            <div style="display:grid;grid-template-columns:160px 1fr 1fr;gap:10px;align-items:center">
              <span style="font-size:12px;font-weight:600;color:var(--text)">${f.label}</span>
              <input type="number" id="sr-${b.key}-${f.key}" min="0" value="${r[f.key] || 0}" placeholder="₱ rate">
              <input type="number" id="sq-${b.key}-${f.key}" min="0" value="${r[f.key + '_qty'] || r[f.key === 'units_rate' ? 'units_qty' : f.key === 'scrap' ? 'scrapping_qty' : f.key + '_qty'] || 0}" placeholder="default qty">
            </div>
          `).join("")}
          <div style="display:grid;grid-template-columns:160px 1fr 1fr;gap:10px;align-items:center">
            <span style="font-size:12px;font-weight:600;color:var(--text)">Tubes</span>
            <input type="number" id="sr-${b.key}-tubes_rate" min="0" value="${r.tubes_rate || 0}" placeholder="₱ rate">
            <input type="number" id="sq-${b.key}-tubes" min="0" value="${r.tubes_qty || 0}" placeholder="default qty">
          </div>
        </div>
      </div>`;
  }).join("");
  lucide.createIcons();
}

function addBrandFromPreset() {
  const sel = document.getElementById("brand-preset-sel");
  const label = sel.value.trim();
  if (!label) return toast("Pick a brand from the list");
  addBrandByLabel(label);
  sel.value = "";
}

function addCustomBrand() {
  const inp = document.getElementById("brand-custom-input");
  const label = (inp.value || "").trim();
  if (!label) return toast("Enter a brand name");
  addBrandByLabel(label);
  inp.value = "";
}

function addBrandByLabel(label) {
  const brands = COMMISSION_RATES.__brands || [];
  // Generate a safe key from the label
  const key = label.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || ("brand_" + Date.now());
  if (brands.find(b => b.key === key)) return toast(`"${label}" already exists`);
  brands.push({ key, label });
  COMMISSION_RATES.__brands = brands;
  if (!COMMISSION_RATES[key]) COMMISSION_RATES[key] = { sedan: 0, mpv: 0, sunroof: 0, scrap: 0, units_rate: 0, tubes_rate: 0 };
  // Save and re-render
  saveCommissionRates(COMMISSION_RATES);
  renderBrandMgmtBody();
  lucide.createIcons();
  toast(`Brand "${label}" added ✓`);
}

async function removeBrand(key) {
  const brands = COMMISSION_RATES.__brands || [];
  const b = brands.find(x => x.key === key);
  const ok = await confirmDanger({
    title: "Remove Brand?",
    message: `Remove <strong>${b ? b.label : key}</strong> and all its rate settings? Existing entries with this brand won't be recalculated automatically.`,
    confirmText: "Remove",
  });
  if (!ok) return;
  COMMISSION_RATES.__brands = brands.filter(x => x.key !== key);
  delete COMMISSION_RATES[key];
  saveCommissionRates(COMMISSION_RATES);
  renderBrandMgmtBody();
  lucide.createIcons();
  toast("Brand removed");
}

function saveSettings() {
  const brands = COMMISSION_RATES.__brands || [];
  brands.forEach(b => {
    const r = {};
    RATE_FIELDS.forEach(f => {
      const rateEl = document.getElementById(`sr-${b.key}-${f.key}`);
      const qtyEl = document.getElementById(`sq-${b.key}-${f.key}`);
      r[f.key] = rateEl ? (+rateEl.value || 0) : 0;
      // Map field key to qty key
      const qtyKey = f.key === 'units_rate' ? 'units_qty' : f.key === 'scrap' ? 'scrapping_qty' : f.key + '_qty';
      r[qtyKey] = qtyEl ? (+qtyEl.value || 0) : 0;
    });
    const tubesRateEl = document.getElementById(`sr-${b.key}-tubes_rate`);
    const tubesQtyEl = document.getElementById(`sq-${b.key}-tubes`);
    r.tubes_rate = tubesRateEl ? (+tubesRateEl.value || 0) : 0;
    r.tubes_qty = tubesQtyEl ? (+tubesQtyEl.value || 0) : 0;
    COMMISSION_RATES[b.key] = r;
  });
  BYD = COMMISSION_RATES.byd || {};
  GEELY = COMMISSION_RATES.geely || {};
  saveCommissionRates(COMMISSION_RATES);
  toast("Commission rates & defaults saved ✓");
}

// =============== EXPORTS (XLSX with styling) ===============
const XLS_BORDER = { style: "thin", color: { rgb: "BFBFBF" } };
const XLS_BORDERS = { top: XLS_BORDER, bottom: XLS_BORDER, left: XLS_BORDER, right: XLS_BORDER };
const xStyle = (extra = {}) => ({
  font: { name: "Calibri", sz: 11, color: { rgb: "111111" }, ...(extra.font || {}) },
  alignment: { vertical: "center", horizontal: "left", wrapText: true, ...(extra.alignment || {}) },
  border: XLS_BORDERS,
  ...(extra.fill ? { fill: extra.fill } : {}),
  ...(extra.numFmt ? { numFmt: extra.numFmt } : {})
});
const xTitle = (text) => ({ v: text, t: "s", s: { font: { name: "Calibri", sz: 18, bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "111111" } }, alignment: { horizontal: "center", vertical: "center" } } });
const xSection = (text) => ({ v: text, t: "s", s: { font: { name: "Calibri", sz: 12, bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "333333" } }, alignment: { horizontal: "left", vertical: "center" }, border: XLS_BORDERS } });
const xHead = (text) => ({ v: text, t: "s", s: { font: { name: "Calibri", sz: 11, bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "1F1F1F" } }, alignment: { horizontal: "center", vertical: "center" }, border: XLS_BORDERS } });
const xLabel = (text) => ({ v: text, t: "s", s: { font: { name: "Calibri", sz: 11, bold: true, color: { rgb: "111111" } }, fill: { fgColor: { rgb: "F2F2F2" } }, alignment: { horizontal: "left", vertical: "center" }, border: XLS_BORDERS } });
const xText = (text, opts = {}) => ({ v: text ?? "", t: "s", s: xStyle(opts) });
const xNum = (n, opts = {}) => ({ v: Number(n || 0), t: "n", s: xStyle({ ...opts, numFmt: opts.numFmt || '#,##0.00', alignment: { horizontal: "right", vertical: "center", ...(opts.alignment || {}) } }) });
const xTotal = (text) => ({ v: text, t: "s", s: { font: { name: "Calibri", sz: 11, bold: true, color: { rgb: "111111" } }, fill: { fgColor: { rgb: "DDDDDD" } }, alignment: { horizontal: "left", vertical: "center" }, border: XLS_BORDERS } });
const xTotalNum = (n) => ({ v: Number(n || 0), t: "n", s: { font: { name: "Calibri", sz: 11, bold: true, color: { rgb: "111111" } }, fill: { fgColor: { rgb: "DDDDDD" } }, alignment: { horizontal: "right", vertical: "center" }, numFmt: '#,##0.00', border: XLS_BORDERS } });

function pushMerge(merges, r1, c1, r2, c2) { merges.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } }); }
function setRowHeight(ws, idx, h) { ws['!rows'] = ws['!rows'] || []; ws['!rows'][idx] = { hpt: h }; }

function exportTimestamp() {
  const d = new Date();
  return d.toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
}
function exportCSV(pid) {
  const p = state.periods.find(x => x.id === pid);
  const emp = state.employees.find(e => e.id === p.employee_id);
  const t = calcPeriod(p);
  const aoa = []; const merges = [];

  aoa.push([xTitle("PAYROLL STATEMENT")]); pushMerge(merges, 0, 0, 0, 19);
  aoa.push([xText(COMPANY.name, { font: { bold: true, sz: 12 }, alignment: { horizontal: "center" } })]); pushMerge(merges, 1, 0, 1, 19);
  aoa.push([xText(`${COMPANY.addr1} • ${COMPANY.addr2} • ${COMPANY.email}`, { font: { sz: 10, color: { rgb: "555555" } }, alignment: { horizontal: "center" } })]); pushMerge(merges, 2, 0, 2, 19);
  aoa.push([xText("")]);

  aoa.push([xSection("EMPLOYEE INFORMATION")]); pushMerge(merges, 4, 0, 4, 19);
  aoa.push([xLabel("Employee"), xText(emp.name), xLabel("Pay Period"), xText(`${p.start_date} to ${p.end_date}`)]);
  aoa.push([xLabel("Position"), xText(emp.position), xLabel("Pay Date"), xText(p.pay_date)]);
  aoa.push([xLabel("Base Rate"), xText(`PHP ${(+emp.base_rate || 1000).toLocaleString()}/day`), xLabel("Days Worked"), xText(String(p.entries.length))]);
  aoa.push([xText("")]);

  const earnRow = aoa.length;
  aoa.push([xSection("EARNINGS SUMMARY (PHP)")]); pushMerge(merges, earnRow, 0, earnRow, 19);
  aoa.push([xHead("Description"), xHead("Amount")]);
  [["Basic Salary", t.basic], ["Overtime Pay", t.ot], ["Commission", t.commission], ["Holiday Pay", t.holiday], ["Gas Allowance", t.gas]]
    .forEach(([k, v]) => aoa.push([xText(k), xNum(v)]));
  aoa.push([xTotal("TOTAL EARNINGS"), xTotalNum(t.earnings)]);
  aoa.push([xText("")]);

  const dedRow = aoa.length;
  aoa.push([xSection("DEDUCTIONS (PHP)")]); pushMerge(merges, dedRow, 0, dedRow, 19);
  aoa.push([xHead("Description"), xHead("Amount")]);
  if (!(p.deductions || []).length) aoa.push([xText("No deductions"), xNum(0)]);
  else (p.deductions || []).forEach(d => aoa.push([xText(d.label || "—"), xNum(d.amount)]));
  aoa.push([xTotal("TOTAL DEDUCTIONS"), xTotalNum(t.deductions)]);
  aoa.push([xText("")]);

  const netR = aoa.length;
  aoa.push([{ v: "NET PAY", t: "s", s: { font: { name: "Calibri", sz: 14, bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "111111" } }, alignment: { horizontal: "left", vertical: "center" }, border: XLS_BORDERS } },
  { v: Number(t.net || 0), t: "n", s: { font: { name: "Calibri", sz: 14, bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "111111" } }, alignment: { horizontal: "right", vertical: "center" }, numFmt: '"PHP "#,##0.00', border: XLS_BORDERS } }]);
  setRowHeight(aoa, netR, 28);
  aoa.push([xText("")]);

  const dailyR = aoa.length;
  aoa.push([xSection("DAILY BREAKDOWN")]); pushMerge(merges, dailyR, 0, dailyR, 21);
  const headers = ["Date", "Location", "Time In", "Time Out", "Type", "Base Pay", "OT Hrs", "OT Min", "Total OT", "Brand", "Sedan", "MPV", "Sunroof", "Scrap", "Tubes", "Div", "Commission", "OT Pay", "Holiday", "Gas", "Day Total", "Notes"];
  aoa.push(headers.map(h => xHead(h)));
  p.entries.forEach(e => {
    const c = calcEntry(e, emp.base_rate);
    const type = e.is_offset ? "Offset" : e.is_holiday ? "Holiday" : e.is_halfday ? "Half Day" : "Full";
    const otH = +e.ot_hours || 0;
    const otM = +e.ot_minutes || 0;
    const totalOTLabel = formatOT(otH, otM);
    aoa.push([
      xText(e.date), xText(e.location), xText(to12h(e.time_in) || "—"), xText(to12h(e.time_out) || "—"), xText(type),
      xNum(c.base), xText(String(otH)), xText(String(otM)), xText(totalOTLabel), xText((e.brand || "").toUpperCase()),
      xText(String(e.sedan_qty || 0)), xText(String(e.mpv_qty || 0)), xText(String(e.sunroof_qty || 0)), xText(String(e.scrapping_qty || 0)), xText(String(e.tubes_qty || 0)), xText(String(e.divide_by || 1)),
      xNum(c.commission), xNum(c.otPay), xNum(c.holiday), xNum(c.gas), xNum(c.total), xText(e.notes || "")
    ]);
  });

  // Totals row
  const totalOTHrs = p.entries.reduce((s, e) => s + (+e.ot_hours || 0), 0);
  const totalOTMins = p.entries.reduce((s, e) => s + (+e.ot_minutes || 0), 0);
  const normOTH = totalOTHrs + Math.floor(totalOTMins / 60);
  const normOTM = totalOTMins % 60;
  aoa.push([
    xTotal("TOTALS"), xTotal(""), xTotal(""), xTotal(""), xTotal(""),
    xTotal(""), xTotalNum(normOTH), xTotalNum(normOTM), xTotal(formatOT(normOTH, normOTM)), xTotal(""),
    xTotal(""), xTotal(""), xTotal(""), xTotal(""), xTotal(""), xTotal(""),
    xTotalNum(t.commission), xTotalNum(t.ot), xTotalNum(t.holiday), xTotalNum(t.gas), xTotalNum(t.earnings), xTotal("")
  ]);

  const ws = XLSX.utils.aoa_to_sheet(aoa.map(row => row.map(cell => cell || xText(""))));
  ws['!merges'] = merges;
  ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 9 }, { wch: 11 }, { wch: 7 }, { wch: 7 }, { wch: 9 }, { wch: 8 }, { wch: 7 }, { wch: 7 }, { wch: 8 }, { wch: 7 }, { wch: 7 }, { wch: 6 }, { wch: 13 }, { wch: 11 }, { wch: 11 }, { wch: 10 }, { wch: 13 }, { wch: 22 }];
  ws['!rows'] = ws['!rows'] || [];
  ws['!rows'][0] = { hpt: 28 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Payroll");
  XLSX.writeFile(wb, `${emp.name.replace(/\s+/g, "_")}_${p.start_date}_to_${p.end_date}_payroll_exported_${exportTimestamp()}.xlsx`);
}

// =============== SUMMARY EXPORT CORE ===============
function buildSummaryXLSX(titleLabel, rangeLabel, filteredPeriods) {
  const aoa = []; const merges = [];
  aoa.push([xTitle(`PAYROLL SUMMARY — ${titleLabel}`)]); pushMerge(merges, 0, 0, 0, 13);
  aoa.push([xText(COMPANY.name, { font: { bold: true, sz: 12 }, alignment: { horizontal: "center" } })]); pushMerge(merges, 1, 0, 1, 13);
  const subLine = rangeLabel
    ? `${rangeLabel}  •  Generated ${new Date().toLocaleString("en-PH")}`
    : `Generated ${new Date().toLocaleString("en-PH")}`;
  aoa.push([xText(subLine, { font: { sz: 10, color: { rgb: "555555" } }, alignment: { horizontal: "center" } })]); pushMerge(merges, 2, 0, 2, 13);
  aoa.push([xText("")]);

  const headers = ["Employee", "Position", "Period Start", "Period End", "Pay Date", "Days", "Basic", "OT", "Commission", "Holiday", "Gas", "Total Earnings", "Deductions", "NET PAY"];
  aoa.push(headers.map(h => xHead(h)));

  let grand = 0;
  state.employees.forEach(emp => {
    const my = filteredPeriods.filter(p => p.employee_id === emp.id).sort((a, b) => a.start_date.localeCompare(b.start_date));
    if (!my.length) return;
    let sub = 0;
    my.forEach(p => {
      const t = calcPeriod(p);
      aoa.push([
        xText(emp.name), xText(emp.position), xText(p.start_date), xText(p.end_date), xText(p.pay_date),
        xText(String(p.entries.length)),
        xNum(t.basic), xNum(t.ot), xNum(t.commission), xNum(t.holiday), xNum(t.gas), xNum(t.earnings), xNum(t.deductions), xNum(t.net)
      ]);
      sub += t.net;
    });
    aoa.push([xTotal(`${emp.name} SUBTOTAL`), xTotal(""), xTotal(""), xTotal(""), xTotal(""), xTotal(""), xTotal(""), xTotal(""), xTotal(""), xTotal(""), xTotal(""), xTotal(""), xTotal(""), xTotalNum(sub)]);
    aoa.push([xText("")]);
    grand += sub;
  });
  aoa.push([
    { v: "GRAND TOTAL", t: "s", s: { font: { name: "Calibri", sz: 13, bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "111111" } }, alignment: { horizontal: "left", vertical: "center" }, border: XLS_BORDERS } },
    ...Array(12).fill({ v: "", t: "s", s: { fill: { fgColor: { rgb: "111111" } }, border: XLS_BORDERS } }),
    { v: Number(grand || 0), t: "n", s: { font: { name: "Calibri", sz: 13, bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "111111" } }, alignment: { horizontal: "right", vertical: "center" }, numFmt: '"PHP "#,##0.00', border: XLS_BORDERS } }
  ]);

  const ws = XLSX.utils.aoa_to_sheet(aoa.map(row => row.map(cell => cell || xText(""))));
  ws['!merges'] = merges;
  ws['!cols'] = [{ wch: 22 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 7 }, { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 11 }, { wch: 11 }, { wch: 14 }, { wch: 12 }, { wch: 14 }];
  ws['!rows'] = [{ hpt: 28 }];
  return { ws, grand };
}

function exportSummaryCSV(mode) {
  // mode = 'weekly'
  const today = new Date();
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);
  const filtered = state.periods.filter(p => (p.pay_date || "") >= cutoffStr && (p.pay_date || "") <= todayStr);
  if (!filtered.length) { toast("No pay periods found for the past 7 days."); return; }
  const { ws } = buildSummaryXLSX("WEEKLY", `Pay date: ${cutoffStr} → ${todayStr}`, filtered);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Summary");
  XLSX.writeFile(wb, `payroll_summary_weekly_${todayStr}_exported_${exportTimestamp()}.xlsx`);
  toast("Weekly Excel exported ✓");
}

// =============== DATE RANGE MODAL ===============
function openDateRangeModal() {
  const modal = document.getElementById("daterange-modal");
  // Default: current month start → today
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);
  document.getElementById("dr-start").value = monthStart;
  document.getElementById("dr-end").value = todayStr;
  modal.classList.add("open");
  lucide.createIcons();
  updateDateRangePreview();
  document.getElementById("dr-start").addEventListener("change", updateDateRangePreview);
  document.getElementById("dr-end").addEventListener("change", updateDateRangePreview);
}

function closeDateRangeModal() {
  document.getElementById("daterange-modal").classList.remove("open");
  const s = document.getElementById("dr-start");
  const e = document.getElementById("dr-end");
  s.removeEventListener("change", updateDateRangePreview);
  e.removeEventListener("change", updateDateRangePreview);
}

function updateDateRangePreview() {
  const start = document.getElementById("dr-start").value;
  const end = document.getElementById("dr-end").value;
  const preview = document.getElementById("dr-preview");
  if (!start || !end) { preview.style.display = "none"; return; }
  if (end < start) { preview.style.display = "flex"; preview.className = "dr-preview dr-preview--warn"; preview.innerHTML = '<i data-lucide="alert-circle"></i> End date must be after start date.'; lucide.createIcons(); return; }
  const matched = state.periods.filter(p => (p.pay_date || "") >= start && (p.pay_date || "") <= end);
  const empCount = new Set(matched.map(p => p.employee_id)).size;
  const grandNet = matched.reduce((sum, p) => sum + calcPeriod(p).net, 0);
  preview.style.display = "flex";
  preview.className = matched.length ? "dr-preview dr-preview--ok" : "dr-preview dr-preview--empty";
  if (!matched.length) {
    preview.innerHTML = '<i data-lucide="inbox"></i> No pay periods found in this date range.';
  } else {
    preview.innerHTML = `<i data-lucide="check-circle"></i> <strong>${matched.length}</strong> pay period${matched.length !== 1 ? "s" : ""} across <strong>${empCount}</strong> employee${empCount !== 1 ? "s" : ""} &nbsp;·&nbsp; Grand Net: <strong>${peso(grandNet)}</strong>`;
  }
  lucide.createIcons();
}

function exportDateRange() {
  const start = document.getElementById("dr-start").value;
  const end = document.getElementById("dr-end").value;
  if (!start || !end) return toast("Please select both start and end dates.");
  if (end < start) return toast("End date must be after start date.");
  const filtered = state.periods.filter(p => (p.pay_date || "") >= start && (p.pay_date || "") <= end);
  if (!filtered.length) { toast("No pay periods found in that date range."); return; }
  const label = `${start} to ${end}`;
  const { ws } = buildSummaryXLSX(`CUSTOM RANGE`, `Pay date: ${label}`, filtered);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Summary");
  XLSX.writeFile(wb, `payroll_summary_${start}_to_${end}_exported_${exportTimestamp()}.xlsx`);
  closeDateRangeModal();
  toast("Custom range Excel exported ✓");
}

// =============== PDF (Monochrome • Landscape • Formal) ===============
function exportPDF(pid) {
  const p = state.periods.find(x => x.id === pid);
  const emp = state.employees.find(e => e.id === p.employee_id);
  const t = calcPeriod(p);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40; let y = margin;

  // Letterhead
  doc.setDrawColor(0); doc.setLineWidth(1.4);
  doc.line(margin, y, pageW - margin, y); y += 18;
  doc.setFont("times", "bold"); doc.setFontSize(18); doc.setTextColor(0);
  doc.text("PAYROLL STATEMENT", pageW / 2, y, { align: "center" }); y += 18;
  doc.setFont("times", "normal"); doc.setFontSize(11);
  doc.text(COMPANY.name, pageW / 2, y, { align: "center" }); y += 13;
  doc.setFontSize(9); doc.setTextColor(80);
  doc.text(`${COMPANY.addr1}  •  ${COMPANY.addr2}  •  ${COMPANY.email}`, pageW / 2, y, { align: "center" }); y += 10;
  doc.setTextColor(0); doc.setLineWidth(0.6);
  doc.line(margin, y, pageW - margin, y); y += 16;

  // Info table
  doc.autoTable({
    startY: y, margin: { left: margin, right: margin }, theme: "grid",
    styles: { font: "helvetica", fontSize: 9, cellPadding: 5, lineColor: [180, 180, 180], lineWidth: 0.4, textColor: 20 },
    body: [
      [{ content: "Employee", styles: { fontStyle: "bold", fillColor: [240, 240, 240] } }, emp.name,
      { content: "Pay Period", styles: { fontStyle: "bold", fillColor: [240, 240, 240] } }, `${p.start_date} to ${p.end_date}`],
      [{ content: "Position", styles: { fontStyle: "bold", fillColor: [240, 240, 240] } }, emp.position,
      { content: "Pay Date", styles: { fontStyle: "bold", fillColor: [240, 240, 240] } }, p.pay_date],
      [{ content: "Base Rate", styles: { fontStyle: "bold", fillColor: [240, 240, 240] } }, `PHP ${(+emp.base_rate || 1000).toLocaleString()}/day`,
      { content: "Days Worked", styles: { fontStyle: "bold", fillColor: [240, 240, 240] } }, String(p.entries.length)],
    ],
    columnStyles: { 0: { cellWidth: 90 }, 1: { cellWidth: 260 }, 2: { cellWidth: 90 }, 3: { cellWidth: "auto" } }
  });
  y = doc.lastAutoTable.finalY + 14;

  // Earnings & Deductions side-by-side
  const halfW = (pageW - margin * 2 - 16) / 2;
  doc.autoTable({
    startY: y, margin: { left: margin }, tableWidth: halfW, theme: "grid",
    head: [["EARNINGS", "Amount (PHP)"]],
    body: [["Basic Salary", fmt(t.basic)], ["Overtime Pay", fmt(t.ot)], ["Commission", fmt(t.commission)], ["Holiday Pay", fmt(t.holiday)], ["Gas Allowance", fmt(t.gas)],
    [{ content: "TOTAL EARNINGS", styles: { fontStyle: "bold", fillColor: [230, 230, 230] } }, { content: fmt(t.earnings), styles: { fontStyle: "bold", fillColor: [230, 230, 230], halign: "right" } }]],
    headStyles: { fillColor: [30, 30, 30], textColor: 255, halign: "left", fontStyle: "bold" },
    styles: { font: "helvetica", fontSize: 9, cellPadding: 5, lineColor: [180, 180, 180], lineWidth: 0.4, textColor: 20 },
    columnStyles: { 1: { halign: "right" } }
  });
  const eY = doc.lastAutoTable.finalY;

  const dedBody = (p.deductions || []).length ? p.deductions.map(d => [d.label || "—", fmt(d.amount)]) : [[{ content: "No deductions", colSpan: 2, styles: { textColor: 130, halign: "center", fontStyle: "italic" } }]];
  dedBody.push([{ content: "TOTAL DEDUCTIONS", styles: { fontStyle: "bold", fillColor: [230, 230, 230] } }, { content: fmt(t.deductions), styles: { fontStyle: "bold", fillColor: [230, 230, 230], halign: "right" } }]);
  doc.autoTable({
    startY: y, margin: { left: margin + halfW + 16 }, tableWidth: halfW, theme: "grid",
    head: [["DEDUCTIONS", "Amount (PHP)"]], body: dedBody,
    headStyles: { fillColor: [30, 30, 30], textColor: 255, halign: "left", fontStyle: "bold" },
    styles: { font: "helvetica", fontSize: 9, cellPadding: 5, lineColor: [180, 180, 180], lineWidth: 0.4, textColor: 20 },
    columnStyles: { 1: { halign: "right" } }
  });
  y = Math.max(eY, doc.lastAutoTable.finalY) + 14;

  // Net pay band
  doc.setFillColor(20, 20, 20); doc.rect(margin, y, pageW - margin * 2, 32, "F");
  doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(13);
  doc.text("NET PAY", margin + 14, y + 21);
  doc.setFontSize(14);
  doc.text(`PHP ${fmt(t.net)}`, pageW - margin - 14, y + 21, { align: "right" });
  doc.setTextColor(0); y += 46;

  // Daily breakdown — A4 landscape usable width = ~761pt (841 - 40*2)
  // Columns must sum to ≤ 761. Total below = 761.
  doc.autoTable({
    startY: y, margin: { left: margin, right: margin }, theme: "grid",
    head: [["Date", "Location", "In", "Out", "Type", "Brand", "Sed", "MPV", "Sun", "Scr", "Tub", "OT Hrs", "OT Min", "Commission", "OT Pay", "Holiday", "Gas", "Total"]],
    body: p.entries.map(e => {
      const c = calcEntry(e, emp.base_rate);
      const holidayType = e.holiday_type || (e.is_holiday ? "onsite" : "none");
      const type = e.is_offset ? "OFFSET" : holidayType === "offsite" ? "HOL OFF" : holidayType === "onsite" ? "HOL ON" : holidayType === "special" ? "HOL SP" : e.is_halfday ? "HALF" : "FULL";
      const otH = +e.ot_hours || 0;
      const otM = +e.ot_minutes || 0;
      // Show vehicle list summary: total qty across rows, with div notation if any row divides
      const vl = parseVehicleLists(e);
      const vSummary = (rows) => {
        if (!rows || !rows.length) return "—";
        const totalQty = rows.reduce((s, r) => s + (+r.qty || 0), 0);
        if (!totalQty) return "—";
        if (rows.length === 1) {
          const d = +rows[0].div || 1;
          return d > 1 ? `${totalQty}÷${d}` : `${totalQty}`;
        }
        return rows.filter(r => +r.qty > 0).map(r => { const d = +r.div||1; return d>1?`${r.qty}÷${d}`:String(r.qty); }).join("+") || "—";
      };
      return [e.date, e.location || "—", to12h(e.time_in) || "—", to12h(e.time_out) || "—", type, (e.brand || "").toUpperCase(),
      vSummary(vl.sedan), vSummary(vl.mpv), vSummary(vl.sunroof),
      vSummary(vl.scrap), vSummary(vl.tubes),
      otH || "—", otM || "—",
      fmt(c.commission), fmt(c.otPay), fmt(c.holiday), fmt(c.gas), fmt(c.total)];
    }),
    headStyles: { fillColor: [30, 30, 30], textColor: 255, fontSize: 7.5, fontStyle: "bold", halign: "center" },
    styles: { font: "helvetica", fontSize: 7.5, cellPadding: 3.5, lineColor: [180, 180, 180], lineWidth: 0.3, textColor: 20, overflow: "linebreak" },
    alternateRowStyles: { fillColor: [248, 248, 248] },
    columnStyles: {
      0: { cellWidth: 52 },  // Date
      1: { cellWidth: 52 },  // Location
      2: { cellWidth: 40 },  // In
      3: { cellWidth: 40 },  // Out
      4: { cellWidth: 42 },  // Type
      5: { cellWidth: 36 },  // Brand
      6: { cellWidth: 30, halign: "center" },  // Sed
      7: { cellWidth: 30, halign: "center" },  // MPV
      8: { cellWidth: 30, halign: "center" },  // Sun
      9: { cellWidth: 30, halign: "center" },  // Scr
      10: { cellWidth: 30, halign: "center" }, // Tub
      11: { cellWidth: 30, halign: "center" }, // OT Hrs
      12: { cellWidth: 30, halign: "center" }, // OT Min
      13: { cellWidth: 62, halign: "right" },  // Commission
      14: { cellWidth: 50, halign: "right" },  // OT Pay
      15: { cellWidth: 47, halign: "right" },  // Holiday
      16: { cellWidth: 40, halign: "right" },  // Gas
      17: { cellWidth: 56, halign: "right", fontStyle: "bold" } // Total
    },
    didDrawPage: () => {
      doc.setFontSize(8); doc.setTextColor(110); doc.setFont("helvetica", "normal");
      doc.text(`${COMPANY.name} — Confidential Payroll Document`, margin, pageH - 18);
      doc.text(`Generated ${new Date().toLocaleString("en-PH")}  •  Page ${doc.internal.getNumberOfPages()}`, pageW - margin, pageH - 18, { align: "right" });
      doc.setTextColor(0);
    }
  });

  // OT & hours totals summary below the table
  const pdfTotalOTH = p.entries.reduce((s, e) => s + (+e.ot_hours || 0), 0);
  const pdfTotalOTM = p.entries.reduce((s, e) => s + (+e.ot_minutes || 0), 0);
  const pdfNormH = pdfTotalOTH + Math.floor(pdfTotalOTM / 60);
  const pdfNormM = pdfTotalOTM % 60;
  const summY = doc.lastAutoTable.finalY + 10;
  doc.setFillColor(242, 246, 255); doc.roundedRect(margin, summY, pageW - margin * 2, 24, 4, 4, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(30);
  doc.text(`Total Days Worked: ${p.entries.length}`, margin + 14, summY + 15);
  doc.text(`Total OT: ${formatOT(pdfNormH, pdfNormM) || "0"}  (${pdfNormH}h ${pdfNormM}m)`, margin + 160, summY + 15);
  doc.setTextColor(0);

  doc.save(`${emp.name.replace(/\s+/g, "_")}_${p.start_date}_to_${p.end_date}_payslip_exported_${exportTimestamp()}.pdf`);
}

// =============== UTILITY ===============
function toast(msg) { const el = document.getElementById("toast"); el.textContent = msg; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2400); }

async function renderAll() { renderEmployees(); renderPayroll(); renderDashboard(); }

// =============== CONFIRM MODAL ===============
function confirmDanger({ title = "Are you sure?", message = "", confirmText = "Delete", cancelText = "Cancel" } = {}) {
  return new Promise(resolve => {
    let m = document.getElementById("confirm-modal");
    if (!m) {
      m = document.createElement("div");
      m.id = "confirm-modal";
      m.className = "modal";
      m.innerHTML = `
        <div class="modal-content confirm-content">
          <div class="confirm-icon"><i data-lucide="alert-triangle"></i></div>
          <h3 id="cm-title"></h3>
          <p id="cm-msg"></p>
          <div class="confirm-actions">
            <button class="btn" id="cm-cancel"></button>
            <button class="btn danger" id="cm-ok"></button>
          </div>
        </div>`;
      document.body.appendChild(m);
    }
    document.getElementById("cm-title").textContent = title;
    document.getElementById("cm-msg").innerHTML = message;
    const okBtn = document.getElementById("cm-ok");
    const cancelBtn = document.getElementById("cm-cancel");
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    m.classList.add("open");
    if (window.lucide) lucide.createIcons();
    const cleanup = (val) => {
      m.classList.remove("open");
      okBtn.onclick = null; cancelBtn.onclick = null; m.onclick = null;
      resolve(val);
    };
    okBtn.onclick = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
    m.onclick = (e) => { if (e.target === m) cleanup(false); };
  });
}

// =============== AUTH ===============
async function logout() {
  const ok = await confirmDanger({
    title: "Sign out?",
    message: "You'll need to sign in again to access payroll.",
    confirmText: "Sign Out",
  });
  if (!ok) return;
  await sb.auth.signOut();
  location.href = "login.html";
}

async function requireAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    location.href = "login.html";
    return null;
  }
  // Show user email in the topbar if there's a slot for it
  const ue = document.getElementById("user-email");
  if (ue) ue.textContent = session.user.email || "";
  return session;
}

// =============== BOOT ===============
(async () => {
  const session = await requireAuth();
  if (!session) return;
  // Sync theme toggle icon with persisted preference
  applyTheme(localStorage.getItem("techtune-theme") === "dark");
  toast("Connecting to Supabase…");
  try {
    await loadAll();
    await renderAll();
    toast("Loaded ✓");
  } catch (err) {
    console.error(err);
    toast("Failed to load. Check supabase.js config.");
  }
})();

