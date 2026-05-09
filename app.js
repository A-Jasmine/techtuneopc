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
  if (state.employees.length === 0) { el.innerHTML = '<div class="empty-state">No employees yet — add one to get started.</div>'; return; }
  el.innerHTML = state.employees.map(e => `
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
  Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";

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
  aoa.push([xSection("DAILY BREAKDOWN")]); pushMerge(merges, dailyR, 0, dailyR, 19);
  const headers = ["Date", "Location", "Time In", "Time Out", "Type", "Base Pay", "OT", "Brand", "Sedan", "MPV", "Sunroof", "Scrap", "Tubes", "Div", "Commission", "OT Pay", "Holiday", "Gas", "Day Total", "Notes"];
  aoa.push(headers.map(h => xHead(h)));
  p.entries.forEach(e => {
    const c = calcEntry(e, emp.base_rate);
    const type = e.is_offset ? "Offset" : e.is_holiday ? "Holiday" : e.is_halfday ? "Half Day" : "Full";
    aoa.push([
      xText(e.date), xText(e.location), xText(to12h(e.time_in) || "—"), xText(to12h(e.time_out) || "—"), xText(type),
      xNum(c.base), xText(formatOT(e.ot_hours, e.ot_minutes)), xText((e.brand || "").toUpperCase()),
      xText(String(e.sedan_qty || 0)), xText(String(e.mpv_qty || 0)), xText(String(e.sunroof_qty || 0)), xText(String(e.scrapping_qty || 0)), xText(String(e.tubes_qty || 0)), xText(String(e.divide_by || 1)),
      xNum(c.commission), xNum(c.otPay), xNum(c.holiday), xNum(c.gas), xNum(c.total), xText(e.notes || "")
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa.map(row => row.map(cell => cell || xText(""))));
  ws['!merges'] = merges;
  ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 9 }, { wch: 11 }, { wch: 7 }, { wch: 8 }, { wch: 7 }, { wch: 7 }, { wch: 8 }, { wch: 7 }, { wch: 7 }, { wch: 6 }, { wch: 13 }, { wch: 11 }, { wch: 11 }, { wch: 10 }, { wch: 13 }, { wch: 22 }];
  ws['!rows'] = ws['!rows'] || [];
  ws['!rows'][0] = { hpt: 28 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Payroll");
  XLSX.writeFile(wb, `${emp.name.replace(/\s+/g, "_")}_${p.start_date}_to_${p.end_date}_payroll.xlsx`);
}

function exportSummaryCSV(bucket) {
  const aoa = []; const merges = [];
  aoa.push([xTitle(`PAYROLL SUMMARY — ${bucket === 7 ? "WEEKLY" : "BIWEEKLY"}`)]); pushMerge(merges, 0, 0, 0, 13);
  aoa.push([xText(COMPANY.name, { font: { bold: true, sz: 12 }, alignment: { horizontal: "center" } })]); pushMerge(merges, 1, 0, 1, 13);
  aoa.push([xText(`Generated ${new Date().toLocaleString("en-PH")}`, { font: { sz: 10, color: { rgb: "555555" } }, alignment: { horizontal: "center" } })]); pushMerge(merges, 2, 0, 2, 13);
  aoa.push([xText("")]);

  const headers = ["Employee", "Position", "Period Start", "Period End", "Pay Date", "Days", "Basic", "OT", "Commission", "Holiday", "Gas", "Total Earnings", "Deductions", "NET PAY"];
  aoa.push(headers.map(h => xHead(h)));

  let grand = 0;
  state.employees.forEach(emp => {
    const my = state.periods.filter(p => p.employee_id === emp.id).sort((a, b) => a.start_date.localeCompare(b.start_date));
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

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Summary");
  XLSX.writeFile(wb, `payroll_summary_${bucket === 7 ? "weekly" : "biweekly"}_${new Date().toISOString().slice(0, 10)}.xlsx`);
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

  // Daily breakdown — landscape gives us more width
  doc.autoTable({
    startY: y, margin: { left: margin, right: margin }, theme: "grid",
    head: [["Date", "Location", "Time In", "Time Out", "Type", "Brand", "Sed", "MPV", "Sun", "Scr", "Tub", "Div", "Commission", "OT Pay", "Holiday", "Gas", "Day Total"]],
    body: p.entries.map(e => {
      const c = calcEntry(e, emp.base_rate);
      const type = e.is_offset ? "OFFSET" : e.is_holiday ? "HOLIDAY" : e.is_halfday ? "HALF" : "FULL";
      return [e.date, e.location || "—", to12h(e.time_in) || "—", to12h(e.time_out) || "—", type, (e.brand || "").toUpperCase(),
        e.sedan_qty || "—", e.mpv_qty || "—", e.sunroof_qty || "—", e.scrapping_qty || "—", e.tubes_qty || "—", e.divide_by,
        fmt(c.commission), fmt(c.otPay), fmt(c.holiday), fmt(c.gas), fmt(c.total)];
    }),
    headStyles: { fillColor: [30, 30, 30], textColor: 255, fontSize: 8, fontStyle: "bold", halign: "center" },
    styles: { font: "helvetica", fontSize: 8, cellPadding: 4, lineColor: [180, 180, 180], lineWidth: 0.3, textColor: 20, overflow: "linebreak" },
    alternateRowStyles: { fillColor: [248, 248, 248] },
    columnStyles: {
      0: { cellWidth: 60 }, 1: { cellWidth: 70 }, 2: { cellWidth: 50 }, 3: { cellWidth: 50 }, 4: { cellWidth: 46 }, 5: { cellWidth: 46 },
      6: { cellWidth: 30, halign: "center" }, 7: { cellWidth: 30, halign: "center" }, 8: { cellWidth: 30, halign: "center" }, 9: { cellWidth: 30, halign: "center" }, 10: { cellWidth: 30, halign: "center" }, 11: { cellWidth: 28, halign: "center" },
      12: { cellWidth: 70, halign: "right" }, 13: { cellWidth: 60, halign: "right" }, 14: { cellWidth: 56, halign: "right" }, 15: { cellWidth: 50, halign: "right" }, 16: { cellWidth: 64, halign: "right", fontStyle: "bold" }
    },
    didDrawPage: () => {
      doc.setFontSize(8); doc.setTextColor(110); doc.setFont("helvetica", "normal");
      doc.text(`${COMPANY.name} — Confidential Payroll Document`, margin, pageH - 18);
      doc.text(`Generated ${new Date().toLocaleString("en-PH")}  •  Page ${doc.internal.getNumberOfPages()}`, pageW - margin, pageH - 18, { align: "right" });
      doc.setTextColor(0);
    }
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

