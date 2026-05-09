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
  if (e.is_holiday) return 0;
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
  if (!confirm("Delete this employee and all their pay periods?")) return;
  const { error } = await sb.from('employees').delete().eq('id', id);
  if (error) return toast("Delete failed: " + error.message);
  state.employees = state.employees.filter(e => e.id !== id);
  state.periods = state.periods.filter(p => p.employee_id !== id);
  renderAll();
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
  if (!confirm("Delete this pay period?")) return;
  const { error } = await sb.from('pay_periods').delete().eq('id', id);
  if (error) return toast("Delete failed: " + error.message);
  state.periods = state.periods.filter(p => p.id !== id);
  renderPayroll();
}

function renderPayroll() {
  refreshEmpDropdown();
  const selectedEmpId = document.getElementById("pp-emp").value;
  const list = document.getElementById("period-list");
  const filtered = selectedEmpId ? state.periods.filter(p => p.employee_id === selectedEmpId) : [];

  if (!selectedEmpId) {
    list.innerHTML = '<div class="empty-state"><i data-lucide="user-check" style="width:32px;height:32px;opacity:.4"></i><div>Select an employee above to view their pay periods.</div></div>';
    document.getElementById("period-detail").innerHTML = "";
    lucide.createIcons();
    return;
  }
  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">No pay periods for this employee yet — click <strong>New Period</strong>.</div>';
    document.getElementById("period-detail").innerHTML = "";
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
    const baseLabel = e.is_offset ? `Offset day` : e.is_holiday ? `Holiday (no base)` : e.is_halfday ? `Half day · ₱${(baseRate/2).toLocaleString()}` : `Full day · ₱${baseRate.toLocaleString()}`;
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
            Holiday Pay (₱1,000)
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
  const rows = [];
  const r = (...c) => rows.push(c.map(x => `"${String(x ?? "").replace(/"/g, '""')}"`).join(","));
  r("PAYROLL STATEMENT"); r(COMPANY.name); r(COMPANY.addr1); r(COMPANY.addr2); r(COMPANY.email); r("");
  r("Employee", emp.name); r("Position", emp.position); r("Base Rate", `₱${(+emp.base_rate||1000).toLocaleString()}/day`);
  r("Pay Period", `${p.start_date} to ${p.end_date}`); r("Pay Date", p.pay_date); r("");
  r("=== EARNINGS SUMMARY (PHP) ==="); r("Description", "Amount");
  r("Basic Salary", fmt(t.basic)); r("Overtime Pay", fmt(t.ot)); r("Commission", fmt(t.commission));
  r("Holiday Pay", fmt(t.holiday)); r("Gas Allowance", fmt(t.gas)); r("TOTAL EARNINGS", fmt(t.earnings)); r("");
  r("=== DEDUCTIONS (PHP) ===");
  if (!(p.deductions || []).length) r("No deductions", "0.00");
  else (p.deductions || []).forEach(d => r(d.label || "—", fmt(d.amount)));
  r("TOTAL DEDUCTIONS", fmt(t.deductions)); r("");
  r("NET PAY (PHP)", fmt(t.net)); r("");
  r("=== DAILY BREAKDOWN ===");
  r("Date", "Location", "Time In", "Time Out", "Type", "Base Pay", "OT", "Brand", "Sedan", "MPV", "Sunroof", "Scrap", "Tubes", "Div", "Commission", "OT Pay", "Holiday", "Gas", "Day Total", "Notes");
  p.entries.forEach(e => {
    const c = calcEntry(e, emp.base_rate);
    const type = e.is_offset ? "Offset" : e.is_holiday ? "Holiday" : e.is_halfday ? "Half Day" : "Full";
    r(e.date, e.location, to12h(e.time_in) || "—", to12h(e.time_out) || "—", type, fmt(c.base), formatOT(e.ot_hours, e.ot_minutes), (e.brand || "").toUpperCase(), e.sedan_qty, e.mpv_qty, e.sunroof_qty, e.scrapping_qty, e.tubes_qty, e.divide_by, fmt(c.commission), fmt(c.otPay), fmt(c.holiday), fmt(c.gas), fmt(c.total), e.notes || "");
  });
  downloadCSV(rows.join("\n"), `${emp.name.replace(/\s+/g, "_")}_${p.start_date}_to_${p.end_date}_payroll.csv`);
}
function exportSummaryCSV(bucket) {
  const rows = [];
  const r = (...c) => rows.push(c.map(x => `"${String(x ?? "").replace(/"/g, '""')}"`).join(","));
  r(`PAYROLL SUMMARY — ${bucket === 7 ? "WEEKLY" : "BIWEEKLY"}`); r(COMPANY.name); r("Generated", new Date().toLocaleString("en-PH")); r("");
  r("Employee", "Position", "Period Start", "Period End", "Pay Date", "Days", "Basic", "OT", "Commission", "Holiday", "Gas", "Total Earnings", "Deductions", "NET PAY");
  let grand = 0;
  state.employees.forEach(emp => {
    const my = state.periods.filter(p => p.employee_id === emp.id).sort((a, b) => a.start_date.localeCompare(b.start_date));
    if (!my.length) return;
    let sub = 0;
    my.forEach(p => { const t = calcPeriod(p); r(emp.name, emp.position, p.start_date, p.end_date, p.pay_date, p.entries.length, fmt(t.basic), fmt(t.ot), fmt(t.commission), fmt(t.holiday), fmt(t.gas), fmt(t.earnings), fmt(t.deductions), fmt(t.net)); sub += t.net; });
    r("", "", "", "", "", `${emp.name} SUBTOTAL`, "", "", "", "", "", "", "", fmt(sub)); r(""); grand += sub;
  });
  r("", "", "", "", "", "GRAND TOTAL", "", "", "", "", "", "", "", fmt(grand));
  downloadCSV(rows.join("\n"), `payroll_summary_${bucket === 7 ? "weekly" : "biweekly"}_${new Date().toISOString().slice(0, 10)}.csv`);
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

// =============== BOOT ===============
(async () => {
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
