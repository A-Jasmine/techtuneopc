// =============== STATE (in-memory cache, hydrated from Supabase) ===============
const state = { employees: [], periods: [] };

const round2 = n => Math.round((n || 0) * 100) / 100;
const peso = n => "\u20B1" + (n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = n => (n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// =============== CONSTANTS ===============
const BYD = { sedan: 150, mpv: 200, sunroof: 50 };
const GEELY = { sedan: 200, mpv: 200, sunroof: 200 };
const TUBE_RATE = 50, HOLIDAY_AMT = 1000, OFFSET_AMT = 1000;
const BASE_RATE_OPTIONS = [1000, 1100, 1200];
const LOCATIONS = ["Calamba", "Sta. Rosa", "Las Piñas", "Alabang", "Makati", "Quezon City", "Pasig", "Manila", "Cavite", "Other"];
const COMPANY = { name: "Techtune Solutions Enterprises OPC", addr1: "Unit 6505 Valencia Casa De Sequoia", addr2: "Padre Diego Cera Ave., Elias Aldana, Las Pinas City", email: "techtunesolutions.enterprises@gmail.com" };

// derive hourly OT from base rate (orig 1000 -> 156.25 -> /6.4)
const otRateFromBase = b => round2((b || 1000) / 6.4);

// =============== CALC ===============
function calcEntryBase(e, baseRate) {
  if (e.is_offset) return OFFSET_AMT;
  // Holiday no longer zeroes the base — employees still get paid their daily rate
  // when they go onsite on a holiday. Holiday Pay is added separately on top.
  const br = baseRate || 1000;
  return e.is_halfday ? round2(br / 2) : br;
}
function calcEntry(e, baseRate) {
  const r = e.brand === "byd" ? BYD : e.brand === "geely" ? GEELY : { sedan: 0, mpv: 0, sunroof: 0 };
  const raw = (e.sedan_qty || 0) * r.sedan + (e.mpv_qty || 0) * r.mpv + (e.sunroof_qty || 0) * r.sunroof
            + (e.scrapping_qty || 0) * (e.scrapping_rate || 0) + (e.tubes_qty || 0) * TUBE_RATE;
  const div = (e.divide_by || 1) > 0 ? (e.divide_by || 1) : 1;
  const commission = round2(raw / div);
  const otHrs = (+e.ot_hours || 0) + (+e.ot_minutes || 0) / 60;
  const otPay = round2(otHrs * (+e.ot_rate || otRateFromBase(baseRate)));
  const holiday = e.is_holiday ? HOLIDAY_AMT : 0;
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

// =============== TABS ===============
document.querySelectorAll(".tab").forEach(t => {
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".view").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    document.getElementById("view-" + t.dataset.tab).classList.add("active");
    if (t.dataset.tab === "dashboard") renderDashboard();
  };
});

// =============== EMPLOYEES ===============
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

function renderEmployees() {
  const el = document.getElementById("emp-list");
  const q = (document.getElementById("emp-search")?.value || "").trim().toLowerCase();
  let list = state.employees;
  if (q) list = list.filter(e => e.name.toLowerCase().includes(q) || (e.position || "").toLowerCase().includes(q));
  if (state.employees.length === 0) { el.innerHTML = '<div class="empty-state">No employees yet — add one to get started.</div>'; return; }
  if (list.length === 0) { el.innerHTML = '<div class="empty-state">No employees match your search.</div>'; return; }
  el.innerHTML = list.map(e => `
    <div class="list-item">
      <div class="emp-avatar">${e.name.charAt(0).toUpperCase()}</div>
      <div class="info">
        <strong>${e.name}</strong>
        <small>${e.position || ''} • <span class="rate-chip">₱${(+e.base_rate||1000).toLocaleString()}/day</span></small>
      </div>
      <button class="btn danger" onclick="deleteEmp('${e.id}')"><i data-lucide="trash-2"></i> Delete</button>
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
  const div = document.getElementById("period-detail");
  div.innerHTML = `
    <div class="period-card">
      <div class="card-head">
        <div>
          <h2><i data-lucide="calendar"></i> ${emp.name} — Pay Period</h2>
          <small>Base ₱${(+emp.base_rate||1000).toLocaleString()}/day • Edit work entries and compute net pay</small>
        </div>
        <div class="row">
          <button class="btn" onclick="exportCSV('${p.id}')"><i data-lucide="file-spreadsheet"></i> CSV</button>
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
}

async function updatePeriod(id, key, val) {
  const p = state.periods.find(x => x.id === id);
  p[key] = val;
  const { error } = await sb.from('pay_periods').update({ [key]: val }).eq('id', id);
  if (error) toast("Update failed: " + error.message);
  editPeriod(id);
}

// =============== ENTRIES ===============
async function addEntry(pid) {
  const p = state.periods.find(x => x.id === pid);
  const emp = state.employees.find(e => e.id === p.employee_id);
  const newEntry = {
    pay_period_id: pid, date: new Date().toISOString().slice(0, 10), location: "Calamba",
    time_in: "08:00", time_out: "17:00", ot_hours: 0, ot_minutes: 0, ot_rate: otRateFromBase(emp.base_rate),
    brand: "geely", sedan_qty: 0, mpv_qty: 0, sunroof_qty: 0, scrapping_qty: 0, scrapping_rate: 0,
    tubes_qty: 0, divide_by: 1, gas_allowance: 0, is_holiday: false, is_offset: false, is_halfday: false, notes: ""
  };
  const { data, error } = await sb.from('entries').insert(newEntry).select().single();
  if (error) return toast("Add entry failed: " + error.message);
  p.entries.push(data);
  editPeriod(pid);
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

const NUMERIC_KEYS = ["sedan_qty","mpv_qty","sunroof_qty","scrapping_qty","scrapping_rate","tubes_qty","divide_by","ot_hours","ot_minutes","gas_allowance","ot_rate"];
const BOOL_KEYS = ["is_holiday","is_offset","is_halfday"];

async function updateEntry(pid, eid, key, val) {
  const p = state.periods.find(x => x.id === pid);
  const e = p.entries.find(x => x.id === eid);
  if (NUMERIC_KEYS.includes(key)) val = +val || 0;
  if (BOOL_KEYS.includes(key)) val = !!val;
  e[key] = val;
  const { error } = await sb.from('entries').update({ [key]: val }).eq('id', eid);
  if (error) toast("Save failed: " + error.message);

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
}

function renderEntries(pid) {
  const p = state.periods.find(x => x.id === pid);
  const emp = state.employees.find(x => x.id === p.employee_id);
  const baseRate = emp.base_rate || 1000;
  const wrap = document.getElementById("entries-" + pid);
  wrap.innerHTML = p.entries.map(e => {
    const c = calcEntry(e, baseRate);
    const baseLabel = e.is_offset ? `Offset day` : e.is_holiday ? (e.is_halfday ? `Holiday · Half day · ₱${(baseRate/2).toLocaleString()}` : `Holiday onsite · ₱${baseRate.toLocaleString()}`) : e.is_halfday ? `Half day · ₱${(baseRate/2).toLocaleString()}` : `Full day · ₱${baseRate.toLocaleString()}`;
    return `<div class="entry" id="entry-${e.id}">
      <div class="entry-grid">
        <label>Date<input type="date" value="${e.date}" onchange="updateEntry('${pid}','${e.id}','date',this.value)"></label>
        <label>Location<select onchange="updateEntry('${pid}','${e.id}','location',this.value)">${LOCATIONS.map(l => `<option ${l === e.location ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Time In<input type="time" value="${e.time_in || ''}" onchange="updateEntry('${pid}','${e.id}','time_in',this.value)"></label>
        <label>Time Out<input type="time" value="${e.time_out || ''}" onchange="updateEntry('${pid}','${e.id}','time_out',this.value)"></label>
      </div>
      <div class="base-info-row">
        <span class="base-info-label"><i data-lucide="wallet"></i> ${baseLabel}</span>
        <span class="base-info-amount">Base: <strong class="base-display">${peso(c.base)}</strong></span>
      </div>
      <div class="entry-section">
        <h4>Day Type</h4>
        <div class="entry-grid">
          <label class="toggle-check tone-amber ${e.is_halfday ? "is-checked" : ""}">
            <input type="checkbox" ${e.is_halfday ? "checked" : ""} onchange="updateEntry('${pid}','${e.id}','is_halfday',this.checked);this.closest('.toggle-check').classList.toggle('is-checked',this.checked)">
            <span class="toggle-box"><svg viewBox="0 0 14 12" fill="none"><polyline points="2,6.5 5.5,10 12,2.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            Half Day (½ base rate)
          </label>
          <label class="toggle-check tone-purple ${e.is_holiday ? "is-checked" : ""}">
            <input type="checkbox" ${e.is_holiday ? "checked" : ""} onchange="updateEntry('${pid}','${e.id}','is_holiday',this.checked);this.closest('.toggle-check').classList.toggle('is-checked',this.checked)">
            <span class="toggle-box"><svg viewBox="0 0 14 12" fill="none"><polyline points="2,6.5 5.5,10 12,2.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            Holiday Pay (+₱1,000 bonus)
          </label>
          <label class="toggle-check tone-blue ${e.is_offset ? "is-checked" : ""}">
            <input type="checkbox" ${e.is_offset ? "checked" : ""} onchange="updateEntry('${pid}','${e.id}','is_offset',this.checked);this.closest('.toggle-check').classList.toggle('is-checked',this.checked)">
            <span class="toggle-box"><svg viewBox="0 0 14 12" fill="none"><polyline points="2,6.5 5.5,10 12,2.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            Offset (₱1,000)
          </label>
        </div>
      </div>
      <div class="entry-section">
        <h4>Overtime</h4>
        <div class="entry-grid">
          <label>OT Hrs<input type="number" min="0" value="${e.ot_hours||0}" onchange="updateEntry('${pid}','${e.id}','ot_hours',this.value)"></label>
          <label>OT Min<input type="number" min="0" max="59" value="${e.ot_minutes||0}" onchange="updateEntry('${pid}','${e.id}','ot_minutes',this.value)"></label>
          <label>OT Rate (₱/hr)<input type="number" min="0" step="0.01" value="${e.ot_rate || otRateFromBase(baseRate)}" onchange="updateEntry('${pid}','${e.id}','ot_rate',this.value)"></label>
        </div>
      </div>
      <div class="entry-section">
        <h4>Commission</h4>
        <div class="entry-grid">
          <label>Brand<select onchange="updateEntry('${pid}','${e.id}','brand',this.value)">
            <option value="byd" ${e.brand === "byd" ? "selected" : ""}>BYD</option>
            <option value="geely" ${e.brand === "geely" ? "selected" : ""}>Geely</option>
            <option value="other" ${e.brand === "other" ? "selected" : ""}>Other</option>
          </select></label>
          <label>Sedan/CUV Qty<input type="number" min="0" value="${e.sedan_qty||0}" onchange="updateEntry('${pid}','${e.id}','sedan_qty',this.value)"></label>
          <label>MPV Qty<input type="number" min="0" value="${e.mpv_qty||0}" onchange="updateEntry('${pid}','${e.id}','mpv_qty',this.value)"></label>
          <label>Sunroof Qty<input type="number" min="0" value="${e.sunroof_qty||0}" onchange="updateEntry('${pid}','${e.id}','sunroof_qty',this.value)"></label>
          <label>Scrap Qty<input type="number" min="0" value="${e.scrapping_qty||0}" onchange="updateEntry('${pid}','${e.id}','scrapping_qty',this.value)"></label>
          <label>Scrap Rate<input type="number" min="0" value="${e.scrapping_rate||0}" onchange="updateEntry('${pid}','${e.id}','scrapping_rate',this.value)"></label>
          <label>Tubes Qty (₱50 ea)<input type="number" min="0" value="${e.tubes_qty||0}" onchange="updateEntry('${pid}','${e.id}','tubes_qty',this.value)"></label>
          <label>Divide By<input type="number" min="1" value="${e.divide_by||1}" onchange="updateEntry('${pid}','${e.id}','divide_by',this.value)"></label>
        </div>
      </div>
      <div class="entry-section">
        <h4>Extras</h4>
        <div class="entry-grid">
          <label>Gas Allowance<input type="number" min="0" value="${e.gas_allowance||0}" onchange="updateEntry('${pid}','${e.id}','gas_allowance',this.value)"></label>
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
let chartBar, chartPie;
function renderDashboard() {
  document.getElementById("kpi-emp").textContent = state.employees.length;
  document.getElementById("kpi-per").textContent = state.periods.length;
  let netTotal = 0, monthTotal = 0;
  const month = new Date().toISOString().slice(0, 7);
  const perEmp = {}, breakdown = { Basic: 0, OT: 0, Commission: 0, Holiday: 0, Gas: 0 };
  state.periods.forEach(p => {
    const t = calcPeriod(p); netTotal += t.net;
    if ((p.pay_date || "").startsWith(month)) monthTotal += t.net;
    const emp = state.employees.find(e => e.id === p.employee_id);
    if (emp) perEmp[emp.name] = (perEmp[emp.name] || 0) + t.net;
    breakdown.Basic += t.basic; breakdown.OT += t.ot; breakdown.Commission += t.commission;
    breakdown.Holiday += t.holiday; breakdown.Gas += t.gas;
  });
  document.getElementById("kpi-net").textContent = peso(netTotal);
  document.getElementById("kpi-month").textContent = peso(monthTotal);

  if (chartBar) chartBar.destroy();
  if (chartPie) chartPie.destroy();
  Chart.defaults.color = '#999999';
  Chart.defaults.font.family = "'DM Sans', sans-serif";

  const accentColors = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];
  chartBar = new Chart(document.getElementById("chart-bar"), {
    type: "bar",
    data: { labels: Object.keys(perEmp), datasets: [{ label: "Net Pay", data: Object.values(perEmp), backgroundColor: Object.keys(perEmp).map((_, i) => accentColors[i % accentColors.length]), borderRadius: 8, borderSkipped: false }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#fff', borderColor: 'rgba(0,0,0,.1)', borderWidth: 1, titleColor: '#111', bodyColor: '#666', padding: 12, callbacks: { label: ctx => ' ₱' + ctx.parsed.y.toLocaleString('en-PH', { minimumFractionDigits: 2 }) } } },
      scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: '#999', font: { size: 11 } } }, y: { grid: { color: 'rgba(0,0,0,.05)' }, border: { display: false }, ticks: { color: '#999', font: { size: 11 }, callback: v => '₱' + (v / 1000).toFixed(0) + 'k' } } } }
  });
  chartPie = new Chart(document.getElementById("chart-pie"), {
    type: "doughnut",
    data: { labels: Object.keys(breakdown), datasets: [{ data: Object.values(breakdown), backgroundColor: accentColors, borderColor: '#fff', borderWidth: 3, hoverOffset: 6 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '68%',
      plugins: { legend: { position: 'right', labels: { color: '#777', font: { size: 11 }, boxWidth: 10, boxHeight: 10, borderRadius: 3, padding: 14, usePointStyle: true, pointStyle: 'rectRounded' } },
        tooltip: { backgroundColor: '#fff', borderColor: 'rgba(0,0,0,.1)', borderWidth: 1, titleColor: '#111', bodyColor: '#666', padding: 12, callbacks: { label: ctx => ' ₱' + ctx.parsed.toLocaleString('en-PH', { minimumFractionDigits: 2 }) } } } }
  });
}

// =============== EXPORTS ===============
function exportCSV(pid) {
  const p = state.periods.find(x => x.id === pid);
  const emp = state.employees.find(e => e.id === p.employee_id);
  const t = calcPeriod(p);

  const typeLabel = e => e.is_offset ? "Offset" : e.is_holiday ? (e.is_halfday ? "Holiday · Half" : "Holiday") : e.is_halfday ? "Half Day" : "Full Day";
  const typeBadge = e => {
    if (e.is_offset)  return `<span class="badge badge-blue">Offset</span>`;
    if (e.is_holiday && e.is_halfday) return `<span class="badge badge-purple">Holiday · Half</span>`;
    if (e.is_holiday) return `<span class="badge badge-purple">Holiday</span>`;
    if (e.is_halfday) return `<span class="badge badge-amber">Half Day</span>`;
    return `<span class="badge badge-green">Full Day</span>`;
  };

  const entryRows = p.entries.map(e => {
    const c = calcEntry(e, emp.base_rate);
    return `<tr>
      <td>${e.date}</td>
      <td>${e.location || '—'}</td>
      <td>${to12h(e.time_in) || '—'}</td>
      <td>${to12h(e.time_out) || '—'}</td>
      <td>${typeBadge(e)}</td>
      <td>${(e.brand || '').toUpperCase() || '—'}</td>
      <td class="num">${e.sedan_qty || '—'}</td>
      <td class="num">${e.mpv_qty || '—'}</td>
      <td class="num">${e.sunroof_qty || '—'}</td>
      <td class="num">${e.scrapping_qty || '—'}</td>
      <td class="num">${e.tubes_qty || '—'}</td>
      <td class="num">${e.divide_by || 1}</td>
      <td class="num money">${fmt(c.commission)}</td>
      <td class="num money">${fmt(c.otPay)}</td>
      <td class="num money bold">${fmt(c.total)}</td>
    </tr>`;
  }).join("");

  const dedRows = (p.deductions || []).length
    ? p.deductions.map(d => `<tr><td>${d.label || '—'}</td><td class="num money">₱${fmt(d.amount)}</td></tr>`).join("")
    : `<tr><td colspan="2" style="color:#aaa;text-align:center">No deductions</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Payroll — ${emp.name} (${p.start_date} to ${p.end_date})</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'DM Sans',sans-serif;background:#f5f5f4;color:#111;padding:36px 24px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .page{max-width:900px;margin:auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.10)}
  /* Header */
  .hdr{background:linear-gradient(135deg,#059669 0%,#0891b2 100%);color:#fff;padding:32px 36px 28px;position:relative;overflow:hidden}
  .hdr::after{content:'';position:absolute;right:-40px;top:-40px;width:220px;height:220px;border-radius:50%;background:rgba(255,255,255,.07)}
  .hdr-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
  .company-name{font-size:18px;font-weight:700;letter-spacing:-.3px}
  .company-sub{font-size:11px;opacity:.75;margin-top:3px}
  .doc-label{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;opacity:.7;text-align:right}
  .doc-title{font-size:28px;font-weight:700;letter-spacing:-1px;text-align:right;margin-top:2px}
  .hdr-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:24px;padding-top:22px;border-top:1px solid rgba(255,255,255,.22)}
  .meta-item small{font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;opacity:.65;display:block;margin-bottom:4px}
  .meta-item strong{font-size:14px;font-weight:600}
  /* Body */
  .body{padding:30px 36px 40px}
  /* Summary cards */
  .summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:28px}
  .summary-box{border:1px solid #e5e7eb;border-radius:14px;overflow:hidden}
  .summary-head{background:#f9fafb;border-bottom:1px solid #e5e7eb;padding:11px 16px;font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#6b7280}
  .summary-table{width:100%;border-collapse:collapse}
  .summary-table td{padding:9px 16px;font-size:13px;border-bottom:1px solid #f3f4f6}
  .summary-table tr:last-child td{border-bottom:none}
  .summary-table .lbl{color:#6b7280;width:55%}
  .summary-table .val{font-family:'DM Mono',monospace;font-weight:600;text-align:right}
  .summary-table .total-row td{background:#f9fafb;font-weight:700;font-size:13.5px}
  /* Net pay */
  .net-box{background:linear-gradient(135deg,#059669 0%,#0891b2 100%);border-radius:14px;padding:20px 24px;display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;color:#fff}
  .net-box .lbl{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;opacity:.75}
  .net-box .amount{font-family:'DM Mono',monospace;font-size:26px;font-weight:700;letter-spacing:-1px;color:#d1fae5}
  /* Daily log */
  .section-title{font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9ca3af;margin-bottom:12px}
  .log-wrap{border:1px solid #e5e7eb;border-radius:14px;overflow:hidden}
  .log-table{width:100%;border-collapse:collapse;font-size:12px}
  .log-table th{background:#f9fafb;padding:10px 10px;font-size:9.5px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#6b7280;text-align:left;border-bottom:1px solid #e5e7eb;white-space:nowrap}
  .log-table td{padding:9px 10px;border-bottom:1px solid #f3f4f6;color:#374151;vertical-align:middle}
  .log-table tr:last-child td{border-bottom:none}
  .log-table tr:nth-child(even) td{background:#fafafa}
  .num{text-align:right;font-family:'DM Mono',monospace}
  .money{color:#059669}
  .bold{font-weight:700}
  /* Badges */
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.3px;white-space:nowrap}
  .badge-green{background:#d1fae5;color:#065f46}
  .badge-amber{background:#fef3c7;color:#92400e}
  .badge-purple{background:#ede9fe;color:#4c1d95}
  .badge-blue{background:#dbeafe;color:#1e40af}
  /* Print */
  .print-btn{display:flex;gap:10px;justify-content:flex-end;margin-bottom:20px}
  .btn-print{font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;padding:9px 20px;border-radius:10px;border:none;cursor:pointer;background:linear-gradient(135deg,#059669,#0891b2);color:#fff;box-shadow:0 2px 8px rgba(5,150,105,.25)}
  .btn-dl{font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;padding:9px 20px;border-radius:10px;border:1px solid #e5e7eb;cursor:pointer;background:#f9fafb;color:#374151}
  @media print{
    body{background:#fff;padding:0}
    .page{box-shadow:none;border-radius:0}
    .print-btn{display:none}
  }
</style>
</head>
<body>
<div class="print-btn">
  <button class="btn-dl" onclick="downloadCSVFallback()">⬇ Download CSV</button>
  <button class="btn-print" onclick="window.print()">🖨 Print / Save PDF</button>
</div>
<div class="page">
  <div class="hdr">
    <div class="hdr-top">
      <div>
        <div class="company-name">${COMPANY.name}</div>
        <div class="company-sub">${COMPANY.addr1}, ${COMPANY.addr2}</div>
        <div class="company-sub">${COMPANY.email}</div>
      </div>
      <div>
        <div class="doc-label">Document</div>
        <div class="doc-title">Payroll Statement</div>
      </div>
    </div>
    <div class="hdr-meta">
      <div class="meta-item"><small>Employee</small><strong>${emp.name}</strong></div>
      <div class="meta-item"><small>Position</small><strong>${emp.position || '—'}</strong></div>
      <div class="meta-item"><small>Base Rate</small><strong>₱${(+emp.base_rate||1000).toLocaleString()}/day</strong></div>
      <div class="meta-item"><small>Pay Period</small><strong>${p.start_date} → ${p.end_date}</strong></div>
      <div class="meta-item"><small>Pay Date</small><strong>${p.pay_date}</strong></div>
      <div class="meta-item"><small>Days Worked</small><strong>${p.entries.length}</strong></div>
    </div>
  </div>

  <div class="body">
    <div class="summary-grid">
      <div class="summary-box">
        <div class="summary-head">Earnings</div>
        <table class="summary-table">
          <tr><td class="lbl">Basic Salary</td><td class="val">₱${fmt(t.basic)}</td></tr>
          <tr><td class="lbl">Overtime Pay</td><td class="val">₱${fmt(t.ot)}</td></tr>
          <tr><td class="lbl">Commission</td><td class="val">₱${fmt(t.commission)}</td></tr>
          <tr><td class="lbl">Holiday Pay</td><td class="val">₱${fmt(t.holiday)}</td></tr>
          <tr><td class="lbl">Gas Allowance</td><td class="val">₱${fmt(t.gas)}</td></tr>
          <tr class="total-row"><td class="lbl">Total Earnings</td><td class="val">₱${fmt(t.earnings)}</td></tr>
        </table>
      </div>
      <div class="summary-box">
        <div class="summary-head">Deductions</div>
        <table class="summary-table">
          ${dedRows}
          <tr class="total-row"><td class="lbl">Total Deductions</td><td class="val">₱${fmt(t.deductions)}</td></tr>
        </table>
      </div>
    </div>

    <div class="net-box">
      <div class="lbl">Net Pay</div>
      <div class="amount">₱${fmt(t.net)}</div>
    </div>

    <div class="section-title">Daily Work Log</div>
    <div class="log-wrap">
      <table class="log-table">
        <thead>
          <tr>
            <th>Date</th><th>Location</th><th>In</th><th>Out</th><th>Type</th>
            <th>Brand</th><th>Sed</th><th>MPV</th><th>Sun</th><th>Scr</th><th>Tub</th><th>Div</th>
            <th>Commission</th><th>OT Pay</th><th>Total</th>
          </tr>
        </thead>
        <tbody>${entryRows}</tbody>
      </table>
    </div>

    <div style="margin-top:28px;text-align:center;font-size:11px;color:#9ca3af">
      Generated ${new Date().toLocaleString('en-PH')} · Techtune Payroll System
    </div>
  </div>
</div>
<script>
function downloadCSVFallback() {
  const rows = ${JSON.stringify(buildCSVRows(p, emp, t))};
  const blob = new Blob(["\uFEFF" + rows.join("\\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url;
  a.download = "${emp.name.replace(/\s+/g, "_")}_${p.start_date}_to_${p.end_date}_payroll.csv";
  a.click(); URL.revokeObjectURL(url);
}
</script>
</body></html>`;

  const win = window.open("", "_blank");
  win.document.write(html);
  win.document.close();
}

function buildCSVRows(p, emp, t) {
  const rows = [];
  const r = (...c) => rows.push(c.map(x => `"${String(x ?? "").replace(/"/g, '""')}"`).join(","));
  r("PAYROLL STATEMENT"); r(COMPANY.name); r(COMPANY.addr1); r(COMPANY.addr2); r(COMPANY.email); r("");
  r("Employee", emp.name); r("Position", emp.position); r("Base Rate", `₱${(+emp.base_rate||1000).toLocaleString()}/day`);
  r("Pay Period", `${p.start_date} to ${p.end_date}`); r("Pay Date", p.pay_date); r("");
  r("=== EARNINGS (PHP) ==="); r("Description", "Amount");
  r("Basic Salary", fmt(t.basic)); r("Overtime Pay", fmt(t.ot)); r("Commission", fmt(t.commission));
  r("Holiday Pay", fmt(t.holiday)); r("Gas Allowance", fmt(t.gas)); r("TOTAL EARNINGS", fmt(t.earnings)); r("");
  r("=== DEDUCTIONS (PHP) ===");
  if (!(p.deductions || []).length) r("No deductions", "0.00");
  else (p.deductions || []).forEach(d => r(d.label || "—", fmt(d.amount)));
  r("TOTAL DEDUCTIONS", fmt(t.deductions)); r("NET PAY (PHP)", fmt(t.net)); r("");
  r("=== DAILY BREAKDOWN ===");
  r("Date","Location","Time In","Time Out","Type","Base Pay","OT","Brand","Sedan","MPV","Sunroof","Scrap","Tubes","Div","Commission","OT Pay","Holiday","Gas","Day Total","Notes");
  (p.entries || []).forEach(e => {
    const c = calcEntry(e, emp.base_rate);
    const type = e.is_offset ? "Offset" : e.is_holiday ? "Holiday" : e.is_halfday ? "Half Day" : "Full";
    r(e.date, e.location, to12h(e.time_in)||"—", to12h(e.time_out)||"—", type, fmt(c.base), formatOT(e.ot_hours, e.ot_minutes), (e.brand||"").toUpperCase(), e.sedan_qty, e.mpv_qty, e.sunroof_qty, e.scrapping_qty, e.tubes_qty, e.divide_by, fmt(c.commission), fmt(c.otPay), fmt(c.holiday), fmt(c.gas), fmt(c.total), e.notes||"");
  });
  return rows;
}
function exportSummaryCSV(bucket) {
  const label = bucket === 7 ? "Weekly" : "Bi-Weekly";
  let grandNet = 0, grandBasic = 0, grandOT = 0, grandCom = 0, grandHol = 0, grandGas = 0, grandEarnings = 0, grandDed = 0;

  const empBlocks = state.employees.map(emp => {
    const my = state.periods.filter(p => p.employee_id === emp.id).sort((a, b) => a.start_date.localeCompare(b.start_date));
    if (!my.length) return "";
    let subNet = 0, subBasic = 0, subOT = 0, subCom = 0, subHol = 0, subGas = 0, subEarnings = 0, subDed = 0;
    const rows = my.map(p => {
      const t = calcPeriod(p);
      subBasic += t.basic; subOT += t.ot; subCom += t.commission; subHol += t.holiday; subGas += t.gas;
      subEarnings += t.earnings; subDed += t.deductions; subNet += t.net;
      return `<tr>
        <td>${emp.name}</td>
        <td style="color:#6b7280;font-size:11px">${emp.position||''}</td>
        <td>${p.start_date}</td>
        <td>${p.end_date}</td>
        <td>${p.pay_date}</td>
        <td class="num">${p.entries.length}</td>
        <td class="num money">₱${fmt(t.basic)}</td>
        <td class="num">₱${fmt(t.ot)}</td>
        <td class="num">₱${fmt(t.commission)}</td>
        <td class="num">₱${fmt(t.holiday)}</td>
        <td class="num">₱${fmt(t.gas)}</td>
        <td class="num">₱${fmt(t.earnings)}</td>
        <td class="num red">₱${fmt(t.deductions)}</td>
        <td class="num money bold">₱${fmt(t.net)}</td>
      </tr>`;
    }).join("");
    grandBasic += subBasic; grandOT += subOT; grandCom += subCom; grandHol += subHol; grandGas += subGas;
    grandEarnings += subEarnings; grandDed += subDed; grandNet += subNet;
    return rows + `<tr class="subtotal-row">
      <td colspan="6">${emp.name} — Subtotal</td>
      <td class="num">₱${fmt(subBasic)}</td>
      <td class="num">₱${fmt(subOT)}</td>
      <td class="num">₱${fmt(subCom)}</td>
      <td class="num">₱${fmt(subHol)}</td>
      <td class="num">₱${fmt(subGas)}</td>
      <td class="num">₱${fmt(subEarnings)}</td>
      <td class="num red">₱${fmt(subDed)}</td>
      <td class="num bold">₱${fmt(subNet)}</td>
    </tr>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Payroll Summary — ${label}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'DM Sans',sans-serif;background:#f5f5f4;color:#111;padding:36px 24px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .page{max-width:1100px;margin:auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.10)}
  .hdr{background:linear-gradient(135deg,#059669 0%,#0891b2 100%);color:#fff;padding:32px 36px 28px;position:relative;overflow:hidden}
  .hdr::after{content:'';position:absolute;right:-40px;top:-40px;width:220px;height:220px;border-radius:50%;background:rgba(255,255,255,.07)}
  .hdr-top{display:flex;align-items:flex-start;justify-content:space-between}
  .company-name{font-size:18px;font-weight:700}
  .company-sub{font-size:11px;opacity:.75;margin-top:3px}
  .doc-label{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;opacity:.7;text-align:right}
  .doc-title{font-size:24px;font-weight:700;letter-spacing:-1px;text-align:right;margin-top:2px}
  .hdr-meta{display:flex;gap:24px;margin-top:20px;padding-top:18px;border-top:1px solid rgba(255,255,255,.22)}
  .meta-item small{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;opacity:.65;display:block;margin-bottom:3px}
  .meta-item strong{font-size:13px;font-weight:600}
  .body{padding:28px 32px 40px}
  .kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
  .kpi{border:1px solid #e5e7eb;border-radius:12px;padding:14px 16px}
  .kpi small{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#9ca3af;display:block;margin-bottom:5px}
  .kpi strong{font-family:'DM Mono',monospace;font-size:17px;font-weight:700;color:#111;letter-spacing:-.5px}
  .kpi.kpi-green{border-left:3px solid #059669}.kpi.kpi-blue{border-left:3px solid #0891b2}.kpi.kpi-amber{border-left:3px solid #d97706}.kpi.kpi-red{border-left:3px solid #dc2626}
  .section-title{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9ca3af;margin-bottom:12px}
  .tbl-wrap{border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{background:#f9fafb;padding:10px 10px;font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#6b7280;text-align:left;border-bottom:1px solid #e5e7eb;white-space:nowrap}
  td{padding:9px 10px;border-bottom:1px solid #f3f4f6;color:#374151;vertical-align:middle;white-space:nowrap}
  tr:last-child td{border-bottom:none}
  tr:nth-child(even):not(.subtotal-row) td{background:#fafafa}
  .subtotal-row td{background:#f0fdf4;font-weight:700;font-size:11.5px;border-top:1px solid #bbf7d0;border-bottom:2px solid #bbf7d0;color:#065f46}
  .grand-row td{background:linear-gradient(135deg,#059669,#0891b2);color:#fff;font-weight:700;font-size:13px}
  .num{text-align:right;font-family:'DM Mono',monospace}
  .money{color:#059669}.red{color:#dc2626}.bold{font-weight:700}
  .print-btn{display:flex;gap:10px;justify-content:flex-end;margin-bottom:20px}
  .btn-print{font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;padding:9px 20px;border-radius:10px;border:none;cursor:pointer;background:linear-gradient(135deg,#059669,#0891b2);color:#fff}
  .btn-dl{font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;padding:9px 20px;border-radius:10px;border:1px solid #e5e7eb;cursor:pointer;background:#f9fafb;color:#374151}
  @media print{body{background:#fff;padding:0}.page{box-shadow:none;border-radius:0}.print-btn{display:none}}
</style>
</head>
<body>
<div class="print-btn">
  <button class="btn-dl" onclick="downloadSummaryCSV()">⬇ Download CSV</button>
  <button class="btn-print" onclick="window.print()">🖨 Print / Save PDF</button>
</div>
<div class="page">
  <div class="hdr">
    <div class="hdr-top">
      <div>
        <div class="company-name">${COMPANY.name}</div>
        <div class="company-sub">${COMPANY.addr1}, ${COMPANY.addr2}</div>
        <div class="company-sub">${COMPANY.email}</div>
      </div>
      <div>
        <div class="doc-label">Summary Report</div>
        <div class="doc-title">${label} Payroll</div>
      </div>
    </div>
    <div class="hdr-meta">
      <div class="meta-item"><small>Generated</small><strong>${new Date().toLocaleString('en-PH')}</strong></div>
      <div class="meta-item"><small>Employees</small><strong>${state.employees.length}</strong></div>
      <div class="meta-item"><small>Total Periods</small><strong>${state.periods.length}</strong></div>
    </div>
  </div>
  <div class="body">
    <div class="kpi-grid" style="margin-bottom:24px">
      <div class="kpi kpi-green"><small>Grand Net Pay</small><strong>₱${fmt(grandNet)}</strong></div>
      <div class="kpi kpi-blue"><small>Total Earnings</small><strong>₱${fmt(grandEarnings)}</strong></div>
      <div class="kpi kpi-amber"><small>Total Commission</small><strong>₱${fmt(grandCom)}</strong></div>
      <div class="kpi kpi-red"><small>Total Deductions</small><strong>₱${fmt(grandDed)}</strong></div>
    </div>
    <div class="section-title">Pay Period Breakdown</div>
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>Employee</th><th>Position</th><th>Period Start</th><th>Period End</th><th>Pay Date</th><th>Days</th>
            <th>Basic</th><th>OT</th><th>Commission</th><th>Holiday</th><th>Gas</th>
            <th>Earnings</th><th>Deductions</th><th>Net Pay</th>
          </tr>
        </thead>
        <tbody>
          ${empBlocks}
          <tr class="grand-row">
            <td colspan="6">GRAND TOTAL</td>
            <td class="num">₱${fmt(grandBasic)}</td>
            <td class="num">₱${fmt(grandOT)}</td>
            <td class="num">₱${fmt(grandCom)}</td>
            <td class="num">₱${fmt(grandHol)}</td>
            <td class="num">₱${fmt(grandGas)}</td>
            <td class="num">₱${fmt(grandEarnings)}</td>
            <td class="num">₱${fmt(grandDed)}</td>
            <td class="num bold">₱${fmt(grandNet)}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div style="margin-top:24px;text-align:center;font-size:11px;color:#9ca3af">
      Generated ${new Date().toLocaleString('en-PH')} · Techtune Payroll System
    </div>
  </div>
</div>
<script>
function downloadSummaryCSV() {
  const rows = [];
  const r = (...c) => rows.push(c.map(x => '"' + String(x ?? "").replace(/"/g, '""') + '"').join(","));
  r("PAYROLL SUMMARY — ${label.toUpperCase()}"); r("${COMPANY.name}"); r("Generated", "${new Date().toLocaleString('en-PH')}"); r("");
  r("Employee","Position","Period Start","Period End","Pay Date","Days","Basic","OT","Commission","Holiday","Gas","Total Earnings","Deductions","NET PAY");
  ${JSON.stringify(state.employees.map(emp => {
    const my = state.periods.filter(p => p.employee_id === emp.id).sort((a,b) => a.start_date.localeCompare(b.start_date));
    return { emp, my };
  }))}.forEach(({emp, my}) => {
    if (!my.length) return;
    my.forEach(p => {
      // rows already embedded via server-side
    });
  });
  // Simpler: just download the visible table rows
  const tbl = document.querySelector('table');
  if (!tbl) return;
  const csvRows = [...tbl.querySelectorAll('tr')].map(tr =>
    [...tr.querySelectorAll('th,td')].map(td => '"' + td.innerText.replace(/"/g,'""') + '"').join(',')
  );
  const blob = new Blob(["\uFEFF" + csvRows.join("\\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = "payroll_summary_${bucket === 7 ? 'weekly' : 'biweekly'}_${new Date().toISOString().slice(0,10)}.csv";
  a.click();
}
</script>
</body></html>`;

  const win = window.open("", "_blank");
  win.document.write(html);
  win.document.close();
}
function downloadCSV(content, name) {
  const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

// =============== PDF ===============
function exportPDF(pid) {
  const p = state.periods.find(x => x.id === pid);
  const emp = state.employees.find(e => e.id === p.employee_id);
  const t = calcPeriod(p);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 36; let y = margin;

  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.text("PAYROLL STATEMENT", pageW / 2, y, { align: "center" }); y += 18;
  doc.setFontSize(11); doc.text(COMPANY.name, pageW / 2, y, { align: "center" }); y += 13;
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(90);
  doc.text(COMPANY.addr1, pageW / 2, y, { align: "center" }); y += 11;
  doc.text(COMPANY.addr2, pageW / 2, y, { align: "center" }); y += 11;
  doc.text(COMPANY.email, pageW / 2, y, { align: "center" }); y += 14;
  doc.setTextColor(0); doc.line(margin, y, pageW - margin, y); y += 14;

  doc.autoTable({
    startY: y, margin: { left: margin, right: margin }, theme: "plain", styles: { fontSize: 9, cellPadding: 3 },
    body: [
      [{ content: "Employee:", styles: { fontStyle: "bold" } }, emp.name, { content: "Pay Period:", styles: { fontStyle: "bold" } }, `${p.start_date} to ${p.end_date}`],
      [{ content: "Position:", styles: { fontStyle: "bold" } }, emp.position, { content: "Pay Date:", styles: { fontStyle: "bold" } }, p.pay_date],
      [{ content: "Base Rate:", styles: { fontStyle: "bold" } }, `PHP ${(+emp.base_rate||1000).toLocaleString()}/day`, { content: "Days Worked:", styles: { fontStyle: "bold" } }, String(p.entries.length)],
    ],
    columnStyles: { 0: { cellWidth: 70 }, 1: { cellWidth: 170 }, 2: { cellWidth: 70 }, 3: { cellWidth: "auto" } }
  });
  y = doc.lastAutoTable.finalY + 14;

  const halfW = (pageW - margin * 2 - 12) / 2;
  doc.autoTable({
    startY: y, margin: { left: margin }, tableWidth: halfW,
    head: [["EARNINGS", "Amount (PHP)"]],
    body: [["Basic Salary", fmt(t.basic)], ["Overtime Pay", fmt(t.ot)], ["Commission", fmt(t.commission)], ["Holiday Pay", fmt(t.holiday)], ["Gas Allowance", fmt(t.gas)],
    [{ content: "TOTAL EARNINGS", styles: { fontStyle: "bold" } }, { content: fmt(t.earnings), styles: { fontStyle: "bold" } }]],
    headStyles: { fillColor: [33, 33, 33], textColor: 255, halign: "left" }, styles: { fontSize: 9, cellPadding: 4 }, columnStyles: { 1: { halign: "right" } }
  });
  const eY = doc.lastAutoTable.finalY;

  const dedBody = (p.deductions || []).length ? p.deductions.map(d => [d.label || "—", fmt(d.amount)]) : [[{ content: "No deductions", colSpan: 2, styles: { textColor: 130, halign: "center" } }]];
  dedBody.push([{ content: "TOTAL DEDUCTIONS", styles: { fontStyle: "bold" } }, { content: fmt(t.deductions), styles: { fontStyle: "bold" } }]);
  doc.autoTable({
    startY: y, margin: { left: margin + halfW + 12 }, tableWidth: halfW,
    head: [["DEDUCTIONS", "Amount (PHP)"]], body: dedBody,
    headStyles: { fillColor: [33, 33, 33], textColor: 255, halign: "left" }, styles: { fontSize: 9, cellPadding: 4 }, columnStyles: { 1: { halign: "right" } }
  });
  y = Math.max(eY, doc.lastAutoTable.finalY) + 14;

  doc.setFillColor(33, 33, 33); doc.rect(margin, y, pageW - margin * 2, 28, "F");
  doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(13);
  doc.text("NET PAY", margin + 12, y + 18);
  doc.text(`PHP ${fmt(t.net)}`, pageW - margin - 12, y + 18, { align: "right" });
  doc.setTextColor(0); y += 42;

  doc.autoTable({
    startY: y, margin: { left: margin, right: margin },
    head: [["Date", "Loc", "In", "Out", "Type", "Brand", "Sed", "MPV", "Sun", "Scr", "Tub", "Div", "Commission", "OT Pay", "Total"]],
    body: p.entries.map(e => {
      const c = calcEntry(e, emp.base_rate);
      const type = e.is_offset ? "OFFSET" : e.is_holiday ? "HOLIDAY" : e.is_halfday ? "HALF" : "FULL";
      return [e.date, e.location || "—", to12h(e.time_in) || "—", to12h(e.time_out) || "—", type, (e.brand || "").toUpperCase(),
        e.sedan_qty || "—", e.mpv_qty || "—", e.sunroof_qty || "—", e.scrapping_qty || "—", e.tubes_qty || "—", e.divide_by, fmt(c.commission), fmt(c.otPay), fmt(c.total)];
    }),
    headStyles: { fillColor: [33, 33, 33], textColor: 255, fontSize: 7.5 }, styles: { fontSize: 7.5, cellPadding: 3, overflow: "linebreak" },
    columnStyles: {
      0: { cellWidth: 48 }, 1: { cellWidth: 48 }, 2: { cellWidth: 42 }, 3: { cellWidth: 42 }, 4: { cellWidth: 36 }, 5: { cellWidth: 34 },
      6: { cellWidth: 22, halign: "center" }, 7: { cellWidth: 22, halign: "center" }, 8: { cellWidth: 22, halign: "center" }, 9: { cellWidth: 22, halign: "center" }, 10: { cellWidth: 22, halign: "center" }, 11: { cellWidth: 22, halign: "center" },
      12: { cellWidth: 60, halign: "right" }, 13: { cellWidth: 46, halign: "right" }, 14: { cellWidth: 56, halign: "right", fontStyle: "bold" }
    },
    didDrawPage: () => { doc.setFontSize(8); doc.setTextColor(130); doc.text(`Generated • ${new Date().toLocaleString("en-PH")}`, pageW / 2, doc.internal.pageSize.getHeight() - 18, { align: "center" }); doc.setTextColor(0); }
  });

  doc.save(`${emp.name.replace(/\s+/g, "_")}_${p.start_date}_to_${p.end_date}_payslip.pdf`);
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

