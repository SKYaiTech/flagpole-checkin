// หน้าผู้ดูแลระบบ (ใช้บนคอมพิวเตอร์เป็นหลัก)
(() => {
  const { cfg, $, $$, esc, toast, STATUS, STATUS_KEYS, SOURCE_LABEL, thaiDate, bkkToday, bkkParts, addDays, isoDow, dowOf, datesBetween,
    fullName, sortTeachers, fmtTime, hhmm, parseDateFlexible, download, callFn, setBusy, debounce, formatNid, TH_DAYS_SHORT, TH_MONTHS } = App;
  const sb = App.makeClient("attendance-admin-auth");
  const A = { sb, addDays, user: null, settings: null, holidays: new Map(), teachers: [], tmap: new Map(), view: "dashboard",
    dashDate: null, dashFilter: "all", sel: new Set(), timers: [], creds: [] };
  window.Admin = A;

  const TEACHER_COLS = "id,auth_user_id,national_id_masked,prefix,first_name,last_name,job_title,department,email,active,password_set,pdpa_accepted_at,line_user_id,line_display_name,line_bound_at,locked_until,sort_order,start_date,end_date,created_at";
  const ACTION_LABEL = {
    teacher_create: "เพิ่มครู", teacher_import: "นำเข้าครู", teacher_update: "แก้ไขข้อมูลครู", teacher_reset_password: "รีเซ็ตรหัสผ่านครู",
    teacher_unbind_line: "ยกเลิกการผูก LINE", teacher_activate: "เปิดใช้งานครู", teacher_deactivate: "ปิดใช้งานครู", teacher_delete: "ลบครู",
    attendance_set: "บันทึก/แก้ไขการเช็กชื่อ", attendance_bulk_set: "บันทึกสถานะหลายคน", attendance_delete: "ลบบันทึกการเช็กชื่อ",
    settings_save: "แก้ไขการตั้งค่า", holiday_add: "เพิ่มวันหยุด", holiday_delete: "ลบวันหยุด",
  };

  // ================================================================ ตัวช่วย
  const loaded = {};
  function loadScript(url) {
    if (!loaded[url]) loaded[url] = new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = url; s.onload = res;
      s.onerror = () => { delete loaded[url]; rej(new Error("โหลดไลบรารีไม่สำเร็จ (ตรวจอินเทอร์เน็ต): " + url)); };
      document.head.appendChild(s);
    });
    return loaded[url];
  }
  A.loadXlsx = () => loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js").then(() => window.XLSX);
  function loadLeaflet() {
    if (!$("#leafletCss")) { const l = document.createElement("link"); l.id = "leafletCss"; l.rel = "stylesheet"; l.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"; document.head.appendChild(l); }
    return loadScript("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js").then(() => window.L);
  }
  A.fetchAll = async (make) => {
    const out = [], size = 1000;
    for (let from = 0; ; from += size) {
      const { data, error } = await make().range(from, from + size - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < size) break;
    }
    return out;
  };
  const modal = {
    open(title, html, { wide = false } = {}) {
      $("#modalRoot").innerHTML = `<div class="modal-bg" id="mbg"><div class="modal ${wide ? "wide" : ""}" role="dialog"><div class="modal-head"><h2>${esc(title)}</h2><button type="button" id="mx" aria-label="ปิด">✕</button></div><div id="mbody">${html}</div></div></div>`;
      $("#mx").onclick = () => modal.close();
      $("#mbg").addEventListener("mousedown", (e) => { if (e.target.id === "mbg") modal.close(); });
      return $("#mbody");
    },
    close() { $("#modalRoot").innerHTML = ""; },
    isOpen() { return !!$("#mbg"); },
  };
  A.modal = modal;
  A.printHtml = (html, { landscape = false } = {}) => {
    const root = $("#printRoot"); root.innerHTML = html;
    let st = $("#pageStyle"); if (!st) { st = document.createElement("style"); st.id = "pageStyle"; document.head.appendChild(st); }
    st.textContent = `@page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 10mm; }`;
    document.body.classList.add("is-printing");
    const done = () => { document.body.classList.remove("is-printing"); root.innerHTML = ""; window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    setTimeout(() => window.print(), 150);
  };
  async function callAdmin(action, payload = {}) {
    const { data } = await sb.auth.getSession();
    if (!data.session) { showLogin("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่"); return { ok: false, code: "UNAUTHORIZED", error: "เซสชันหมดอายุ" }; }
    const r = await callFn("admin", { action, ...payload }, data.session.access_token);
    if (!r.ok && r.code === "UNAUTHORIZED") { await sb.auth.signOut(); showLogin("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่"); }
    return r;
  }
  const alertBox = (cls, t) => `<div class="alert alert-${cls}">${esc(t)}</div>`;
  const chip = (st) => `<span class="chip ${STATUS[st].cls}">${STATUS[st].label}</span>`;
  const statusOptions = (sel, exclude = []) => STATUS_KEYS.filter((k) => !exclude.includes(k)).map((k) => `<option value="${k}" ${k === sel ? "selected" : ""}>${STATUS[k].label}</option>`).join("");
  function validThaiId(id) {
    if (!/^\d{13}$/.test(id)) return false;
    let s = 0; for (let i = 0; i < 12; i++) s += Number(id[i]) * (13 - i);
    return (11 - (s % 11)) % 10 === Number(id[12]);
  }

  // ---------------------------------------------------------------- ข้อมูลพื้นฐาน
  async function loadBase() {
    const [s, h, t] = await Promise.all([
      sb.from("settings").select("*").eq("id", 1).single(),
      sb.from("holidays").select("*").order("date"),
      A.fetchAll(() => sb.from("teachers").select(TEACHER_COLS).order("created_at").order("id")),
    ]);
    if (s.error) throw s.error; if (h.error) throw h.error;
    A.settings = s.data;
    A.holidays = new Map(h.data.map((x) => [x.date, x.name]));
    A.teachers = sortTeachers(t);
    A.tmap = new Map(A.teachers.map((x) => [x.id, x]));
  }
  A.isWorkday = (d) => !A.holidays.has(d) && A.settings.work_days.includes(isoDow(d));
  A.teachersOn = (d) => A.teachers.filter((t) => (!t.start_date || t.start_date <= d) && (!t.end_date || t.end_date >= d) && (t.active || (t.end_date && t.end_date >= d)));

  // ================================================================ เข้าสู่ระบบ
  function showLogin(note) {
    clearTimers();
    $("#app").innerHTML = `
    <div class="auth-wrap"><div class="auth-card">
      <div class="logo">🛠️</div><h1>ผู้ดูแลระบบ</h1><div class="sub">${esc(cfg.SCHOOL_NAME)}</div>
      ${note ? alertBox("warn", note) : ""}
      <form id="aForm">
        <label for="aEmail">อีเมล</label><input id="aEmail" type="email" autocomplete="username">
        <label for="aPw">รหัสผ่าน</label><input id="aPw" type="password" autocomplete="current-password">
        <div id="aMsg"></div>
        <button class="btn btn-primary btn-block mt" id="aBtn">เข้าสู่ระบบ</button>
      </form>
      <div class="center"><button class="link" id="aForgot">ลืมรหัสผ่าน?</button></div>
    </div></div>`;
    $("#aForm").onsubmit = async (e) => {
      e.preventDefault();
      const msg = $("#aMsg"), btn = $("#aBtn");
      setBusy(btn, true, "กำลังเข้าสู่ระบบ…");
      const { data, error } = await sb.auth.signInWithPassword({ email: $("#aEmail").value.trim(), password: $("#aPw").value });
      if (error) { setBusy(btn, false); msg.innerHTML = alertBox("err", "อีเมลหรือรหัสผ่านไม่ถูกต้อง"); return; }
      const ok = await enter(data.user);
      if (!ok) { setBusy(btn, false); msg.innerHTML = alertBox("err", "บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ"); }
    };
    $("#aForgot").onclick = async () => {
      const email = $("#aEmail").value.trim();
      if (!email) { $("#aMsg").innerHTML = alertBox("warn", "กรอกอีเมลก่อน แล้วกด \"ลืมรหัสผ่าน\" อีกครั้ง"); return; }
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: new URL("reset.html", location.href).href });
      $("#aMsg").innerHTML = error ? alertBox("err", "ส่งอีเมลไม่สำเร็จ: " + error.message) : alertBox("ok", "หากอีเมลนี้เป็นของผู้ดูแลระบบ จะได้รับลิงก์ตั้งรหัสผ่านใหม่");
    };
  }
  async function enter(user) {
    const { data: adm } = await sb.from("admins").select("*").eq("auth_user_id", user.id).maybeSingle();
    if (!adm) { await sb.auth.signOut(); return false; }
    A.user = user;
    try { await loadBase(); } catch (e) { $("#app").innerHTML = `<div class="main">${alertBox("err", "โหลดข้อมูลไม่สำเร็จ: " + (e.message || e))}<button class="btn" onclick="location.reload()">ลองใหม่</button></div>`; return true; }
    renderShell(); go(A.view);
    return true;
  }

  // ================================================================ โครงหน้า
  const NAV = [["dashboard", "📊", "ภาพรวมวันนี้"], ["records", "🗂️", "ข้อมูลเช็กชื่อ"], ["teachers", "👥", "จัดการครู"], ["reports", "🖨️", "รายงาน"], ["backup", "💾", "สำรองข้อมูล"], ["settings", "⚙️", "ตั้งค่า"], ["audit", "📜", "บันทึกกิจกรรม"]];
  function renderShell() {
    $("#app").innerHTML = `<div class="shell"><aside class="side">
      <div class="brand">${esc(cfg.APP_TITLE)}<small>ผู้ดูแลระบบ · ${esc(A.settings.school_name)}</small></div>
      ${NAV.map(([k, ic, l]) => `<button class="nav" data-view="${k}"><span>${ic}</span>${l}</button>`).join("")}
      <div class="foot">${esc(A.user.email)}<br><button class="link" style="color:#cbd5e1;padding:4px 0" id="logoutBtn">ออกจากระบบ</button></div>
    </aside><main class="main" id="main"></main></div>`;
    $$(".side button.nav").forEach((b) => (b.onclick = () => go(b.dataset.view)));
    $("#logoutBtn").onclick = async () => { await sb.auth.signOut(); A.user = null; showLogin(); };
  }
  function clearTimers() { A.timers.forEach(clearInterval); A.timers = []; }
  const reports = window.AdminReports(A);
  const VIEWS = { dashboard: viewDashboard, records: viewRecords, teachers: viewTeachers, reports: reports.view, backup: viewBackup, settings: viewSettings, audit: viewAudit };
  function go(view) {
    clearTimers(); A.view = view; A.sel = new Set();
    $$(".side button.nav").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    const main = $("#main"); main.onclick = main.onchange = main.oninput = null;
    Promise.resolve(VIEWS[view]()).catch((e) => { console.error(e); main.innerHTML = alertBox("err", "เกิดข้อผิดพลาด: " + (e.message || e)); });
    window.scrollTo(0, 0);
  }

  // ================================================================ 1) ภาพรวมวันนี้
  async function viewDashboard() {
    const main = $("#main");
    if (!A.dashDate) A.dashDate = bkkToday();
    main.innerHTML = `
      <div class="page-head"><h1>ภาพรวม</h1>
        <div class="toolbar"><button class="btn btn-sm" data-act="prev">◀</button><input type="date" id="dDate" value="${A.dashDate}">
        <button class="btn btn-sm" data-act="next">▶</button><button class="btn btn-sm" data-act="today">วันนี้</button><button class="btn btn-sm" data-act="reload">⟳ รีเฟรช</button></div></div>
      <div id="dBody" class="muted">กำลังโหลด…</div>`;
    const setDate = (d) => { A.dashDate = d; A.sel = new Set(); $("#dDate").value = d; drawDash(); };
    $("#dDate").onchange = (e) => e.target.value && setDate(e.target.value);
    main.onclick = (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      const act = b.dataset.act;
      if (act === "prev") setDate(addDays(A.dashDate, -1));
      else if (act === "next") setDate(addDays(A.dashDate, 1));
      else if (act === "today") setDate(bkkToday());
      else if (act === "reload") drawDash();
      else if (act === "filter") { A.dashFilter = A.dashFilter === b.dataset.f ? "all" : b.dataset.f; drawDash(true); }
      else if (act === "edit") { const r = A.dashRows.find((x) => x.t.id === b.dataset.tid); openRecordModal({ teacherId: r.t.id, date: A.dashDate, record: r.rec, onDone: () => drawDash() }); }
      else if (act === "bulk") openBulkModal();
      else if (act === "clearsel") { A.sel = new Set(); drawDash(true); }
    };
    main.onchange = (e) => {
      if (e.target.id === "selAll") {
        const visible = $$("#dBody input.sel").map((c) => c.dataset.tid);
        if (e.target.checked) visible.forEach((id) => A.sel.add(id)); else visible.forEach((id) => A.sel.delete(id));
        $$("#dBody input.sel").forEach((c) => (c.checked = e.target.checked)); drawBulk();
      } else if (e.target.classList.contains("sel")) {
        if (e.target.checked) A.sel.add(e.target.dataset.tid); else A.sel.delete(e.target.dataset.tid);
        drawBulk();
      }
    };
    await drawDash();
    A.timers.push(setInterval(() => { if (A.view === "dashboard" && A.dashDate === bkkToday() && !modal.isOpen()) drawDash(); }, 30000));
  }
  let dashSeq = 0;
  async function drawDash(local) {
    const date = A.dashDate, body = $("#dBody"); if (!body) return;
    const seq = ++dashSeq;
    if (!local || !A.dashRecs || A.dashRecsDate !== date) {
      let rows;
      try { rows = await A.fetchAll(() => sb.from("attendance").select("*").eq("date", date).order("id")); }
      catch (e) { if (seq === dashSeq) body.innerHTML = alertBox("err", "โหลดข้อมูลไม่สำเร็จ: " + e.message); return; }
      if (seq !== dashSeq) return;
      A.dashRecs = new Map(rows.map((r) => [r.teacher_id, r])); A.dashRecsDate = date;
    }
    const p = bkkParts(), isToday = date === p.date, afterClose = p.time.slice(0, 5) > hhmm(A.settings.close_time);
    const work = A.isWorkday(date), noneLabel = !isToday && date < p.date || (isToday && afterClose) ? "ไม่ได้เช็กชื่อ" : date > p.date ? "-" : "ยังไม่เช็ก";
    const list = A.teachersOn(date);
    A.dashRows = list.map((t) => {
      const rec = A.dashRecs.get(t.id);
      return { t, rec, key: rec ? rec.status : work && date <= p.date ? "none" : "off" };
    });
    const count = {}; A.dashRows.forEach((r) => (count[r.key] = (count[r.key] || 0) + 1));
    const stat = (k, label, color) => `<div class="stat ${A.dashFilter === k ? "on" : ""}" style="border-left-color:${color}" data-act="filter" data-f="${k}"><div class="n">${count[k] || 0}</div><div class="l">${label}</div></div>`;
    const colors = { present: "#16a34a", late: "#d97706", personal: "#2563eb", sick: "#db2777", official: "#7c3aed", maternity: "#0d9488", note: "#64748b" };
    const shown = A.dashRows.filter((r) => A.dashFilter === "all" || r.key === A.dashFilter);
    const off = !work;
    body.className = "";
    body.innerHTML = `
      <h2 style="margin-top:0">${thaiDate(date, { weekday: true })}${isToday ? ' <span class="tag tag-ok">วันนี้</span>' : ""}</h2>
      ${off ? alertBox("info", A.holidays.has(date) ? `วันหยุด: ${A.holidays.get(date) || "วันหยุด"}` : "ไม่ใช่วันทำการ (ตามที่ตั้งค่าไว้)") : ""}
      <div class="stats">${STATUS_KEYS.map((k) => stat(k, STATUS[k].label, colors[k])).join("")}${stat("none", noneLabel === "-" ? "ยังไม่ถึงวัน" : noneLabel, "#dc2626")}
        <div class="stat ${A.dashFilter === "all" ? "on" : ""}" style="border-left-color:#1e3a8a" data-act="filter" data-f="all"><div class="n">${list.length}</div><div class="l">ทั้งหมด</div></div></div>
      <div id="bulk"></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th><input type="checkbox" id="selAll" title="เลือกทั้งหมดที่แสดง"></th><th>ที่</th><th>ชื่อ-สกุล</th><th>ตำแหน่ง</th><th>สถานะ</th><th>เวลา</th><th>ห่างเสาธง</th><th>หมายเหตุ</th><th>ที่มา</th><th></th></tr></thead><tbody>
      ${shown.map((r, i) => `<tr><td><input type="checkbox" class="sel" data-tid="${r.t.id}" ${A.sel.has(r.t.id) ? "checked" : ""}></td><td>${i + 1}</td>
        <td class="nowrap">${esc(fullName(r.t))}</td><td>${esc(r.t.job_title)}</td>
        <td>${r.rec ? chip(r.rec.status) : r.key === "none" ? `<span class="chip s-none">${noneLabel}</span>` : `<span class="chip s-off">-</span>`}</td>
        <td>${r.rec && r.rec.checkin_at ? fmtTime(r.rec.checkin_at) : ""}</td><td>${r.rec && r.rec.distance_m != null ? Math.round(r.rec.distance_m) + " ม." : ""}</td>
        <td>${r.rec ? esc(r.rec.note) : ""}</td><td>${r.rec ? `<span class="tag">${SOURCE_LABEL[r.rec.source]}</span>` : ""}</td>
        <td class="right"><button class="btn btn-sm" data-act="edit" data-tid="${r.t.id}">${r.rec ? "แก้ไข" : "บันทึกให้"}</button></td></tr>`).join("") || `<tr><td colspan="10" class="center muted" style="padding:24px">ไม่มีรายการ</td></tr>`}
      </tbody></table></div>
      <p class="hint">คลิกที่ตัวเลขด้านบนเพื่อกรองรายการ · ติ๊กเลือกหลายคนแล้วตั้งสถานะพร้อมกันได้ (เช่น ไปราชการ/อบรมทั้งกลุ่ม) · หน้านี้รีเฟรชเองทุก 30 วินาที</p>`;
    drawBulk();
  }
  function drawBulk() {
    const box = $("#bulk"); if (!box) return;
    box.innerHTML = A.sel.size ? `<div class="bulkbar"><b>เลือกแล้ว ${A.sel.size} คน</b><button class="btn btn-sm btn-primary" data-act="bulk">ตั้งสถานะที่เลือก</button><button class="btn btn-sm" data-act="clearsel">ล้างการเลือก</button></div>` : "";
  }
  function openBulkModal() {
    const ids = [...A.sel], date = A.dashDate;
    const body = modal.open(`ตั้งสถานะ ${ids.length} คน — ${thaiDate(date, { short: true })}`, `
      <form id="bf"><label>สถานะ</label><select id="bStatus">${statusOptions("official", ["present", "late"])}</select>
      <label>หมายเหตุ (ไม่บังคับ ยกเว้นสถานะ "หมายเหตุ")</label><input id="bNote" maxlength="300" placeholder="เช่น ไปอบรมที่โรงเรียน…">
      <label>เหตุผลที่บันทึก (จำเป็น — เก็บในบันทึกกิจกรรม)</label><input id="bReason" maxlength="200" placeholder="เช่น ตามหนังสือสั่งการที่ …/2569">
      <p class="hint">ครูที่มีบันทึกของวันนี้อยู่แล้วจะถูกแทนที่ด้วยสถานะใหม่</p><div id="bMsg"></div>
      <div class="modal-foot"><button type="button" class="btn" id="bCancel">ยกเลิก</button><button class="btn btn-primary" id="bSave">บันทึก</button></div></form>`);
    $("#bCancel", body).onclick = modal.close;
    $("#bf", body).onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("#bSave", body); setBusy(btn, true, "กำลังบันทึก…");
      const r = await callAdmin("attendance_bulk_set", { teacher_ids: ids, date, status: $("#bStatus", body).value, note: $("#bNote", body).value, reason: $("#bReason", body).value });
      if (!r.ok) { setBusy(btn, false); $("#bMsg", body).innerHTML = alertBox("err", r.error); return; }
      modal.close(); toast(`บันทึกแล้ว ${r.saved} คน`); A.sel = new Set(); drawDash();
    };
  }

  // ---------------------------------------------------------------- แก้ไข/เพิ่มบันทึก 1 รายการ (ใช้ร่วมกัน)
  function openRecordModal({ teacherId = null, date = null, record = null, onDone }) {
    const isNew = !teacherId;
    const body = modal.open(isNew ? "เพิ่มบันทึกการเช็กชื่อ" : record ? "แก้ไขบันทึกการเช็กชื่อ" : "บันทึกการเช็กชื่อให้ครู", `
      <form id="rf">
        ${isNew
          ? `<label>ครู</label><select id="rT">${A.teachers.map((t) => `<option value="${t.id}">${esc(fullName(t))}${t.active ? "" : " (ปิดใช้งาน)"}</option>`).join("")}</select>
             <label>วันที่</label><input type="date" id="rD" value="${bkkToday()}">`
          : `<p><b>${esc(fullName(A.tmap.get(teacherId)))}</b> · ${thaiDate(date, { weekday: true })}</p>`}
        <div class="row2"><div><label>สถานะ</label><select id="rS">${statusOptions(record ? record.status : "present")}</select></div>
        <div id="rTimeBox"><label>เวลาที่มา (ถ้าทราบ)</label><input type="time" id="rTime" value="${record && record.checkin_at ? fmtTime(record.checkin_at) : ""}"></div></div>
        <label>หมายเหตุ</label><input id="rN" maxlength="300" value="${esc(record ? record.note : "")}" placeholder="ข้อความที่จะแสดงในรายงาน">
        <label>เหตุผลที่แก้ไข (จำเป็น — เก็บในบันทึกกิจกรรม)</label><input id="rR" maxlength="200" placeholder="เช่น GPS ขัดข้อง ครูมาจริงตามที่ตรวจสอบ">
        ${isNew ? `<p class="hint">ถ้าครูคนนั้นมีบันทึกของวันดังกล่าวอยู่แล้ว จะถูกแทนที่</p>` : ""}
        <div id="rMsg"></div>
        <div class="modal-foot">${record ? `<button type="button" class="btn btn-danger" id="rDel" style="margin-right:auto">ลบบันทึกนี้</button>` : ""}
          <button type="button" class="btn" id="rCancel">ยกเลิก</button><button class="btn btn-primary" id="rSave">บันทึก</button></div>
      </form>`);
    const syncTime = () => { const s = $("#rS", body).value; $("#rTimeBox", body).style.display = s === "present" || s === "late" ? "" : "none"; };
    $("#rS", body).onchange = syncTime; syncTime();
    $("#rCancel", body).onclick = modal.close;
    const ids = () => ({ teacher_id: isNew ? $("#rT", body).value : teacherId, date: isNew ? $("#rD", body).value : date });
    $("#rf", body).onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("#rSave", body); setBusy(btn, true, "กำลังบันทึก…");
      const r = await callAdmin("attendance_set", { ...ids(), status: $("#rS", body).value, checkin_time: $("#rTime", body).value || null, note: $("#rN", body).value, reason: $("#rR", body).value });
      if (!r.ok) { setBusy(btn, false); $("#rMsg", body).innerHTML = alertBox("err", r.error); return; }
      modal.close(); toast("บันทึกแล้ว"); onDone && onDone();
    };
    const del = $("#rDel", body);
    if (del) del.onclick = async () => {
      if (!$("#rR", body).value.trim()) { $("#rMsg", body).innerHTML = alertBox("err", "กรุณาระบุเหตุผลในช่องด้านบนก่อนลบ"); return; }
      if (!confirm("ลบบันทึกนี้ใช่หรือไม่?")) return;
      setBusy(del, true);
      const r = await callAdmin("attendance_delete", { ...ids(), reason: $("#rR", body).value });
      if (!r.ok) { setBusy(del, false); $("#rMsg", body).innerHTML = alertBox("err", r.error); return; }
      modal.close(); toast("ลบแล้ว"); onDone && onDone();
    };
  }

  // ================================================================ 2) ข้อมูลเช็กชื่อ (ค้นหา/แก้ไข)
  const RC = { from: null, to: null, teacher: "", status: "", page: 1, rows: [] };
  async function viewRecords() {
    const main = $("#main"), today = bkkToday();
    if (!RC.from) { RC.from = today.slice(0, 7) + "-01"; RC.to = today; }
    main.innerHTML = `
      <div class="page-head"><h1>ข้อมูลเช็กชื่อ</h1><button class="btn btn-primary" data-act="new">+ เพิ่มบันทึก</button></div>
      <div class="card"><div class="toolbar">
        <label>ตั้งแต่ <input type="date" id="fFrom" value="${RC.from}"></label><label>ถึง <input type="date" id="fTo" value="${RC.to}"></label>
        <label>ครู <select id="fT"><option value="">ทั้งหมด</option>${A.teachers.map((t) => `<option value="${t.id}" ${RC.teacher === t.id ? "selected" : ""}>${esc(fullName(t))}</option>`).join("")}</select></label>
        <label>สถานะ <select id="fS"><option value="">ทั้งหมด</option>${STATUS_KEYS.map((k) => `<option value="${k}" ${RC.status === k ? "selected" : ""}>${STATUS[k].label}</option>`).join("")}</select></label>
        <button class="btn btn-primary btn-sm" data-act="search">ค้นหา</button><button class="btn btn-sm" data-act="xlsx">📥 Excel</button></div></div>
      <div id="rBody" class="muted">กำลังโหลด…</div>`;
    main.onclick = (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      if (b.dataset.act === "new") openRecordModal({ onDone: searchRecords });
      else if (b.dataset.act === "search") { RC.page = 1; searchRecords(); }
      else if (b.dataset.act === "xlsx") exportRecords();
      else if (b.dataset.act === "page") { RC.page = +b.dataset.p; drawRecords(); }
      else if (b.dataset.act === "edit") { const r = RC.rows[+b.dataset.i]; openRecordModal({ teacherId: r.teacher_id, date: r.date, record: r, onDone: searchRecords }); }
    };
    await searchRecords();
  }
  async function searchRecords() {
    RC.from = $("#fFrom").value; RC.to = $("#fTo").value; RC.teacher = $("#fT").value; RC.status = $("#fS").value;
    const body = $("#rBody");
    if (!RC.from || !RC.to || RC.to < RC.from) { body.innerHTML = alertBox("err", "เลือกช่วงวันที่ให้ถูกต้อง"); return; }
    body.innerHTML = "กำลังโหลด…";
    try {
      RC.rows = await A.fetchAll(() => {
        let q = sb.from("attendance").select("*").gte("date", RC.from).lte("date", RC.to);
        if (RC.teacher) q = q.eq("teacher_id", RC.teacher);
        if (RC.status) q = q.eq("status", RC.status);
        return q.order("date", { ascending: false }).order("id");
      });
    } catch (e) { body.innerHTML = alertBox("err", "โหลดข้อมูลไม่สำเร็จ: " + e.message); return; }
    RC.rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : fullName(A.tmap.get(a.teacher_id) || { first_name: "", last_name: "" }).localeCompare(fullName(A.tmap.get(b.teacher_id) || { first_name: "", last_name: "" }), "th")));
    drawRecords();
  }
  function drawRecords() {
    const body = $("#rBody"), per = 100, pages = Math.max(1, Math.ceil(RC.rows.length / per));
    RC.page = Math.min(RC.page, pages);
    const slice = RC.rows.slice((RC.page - 1) * per, RC.page * per), off = (RC.page - 1) * per;
    body.className = "";
    body.innerHTML = `<p class="muted small">พบ ${RC.rows.length.toLocaleString()} รายการ</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>วันที่</th><th>ชื่อ-สกุล</th><th>สถานะ</th><th>เวลา</th><th>ห่างเสาธง</th><th>หมายเหตุ</th><th>ที่มา</th><th></th></tr></thead><tbody>
      ${slice.map((r, i) => { const t = A.tmap.get(r.teacher_id); return `<tr><td class="nowrap">${thaiDate(r.date, { short: true, weekday: true })}</td><td class="nowrap">${t ? esc(fullName(t)) : "?"}</td><td>${chip(r.status)}</td>
        <td>${fmtTime(r.checkin_at)}</td><td>${r.distance_m != null ? Math.round(r.distance_m) + " ม." : ""}</td><td>${esc(r.note)}</td><td><span class="tag">${SOURCE_LABEL[r.source]}</span></td>
        <td class="right"><button class="btn btn-sm" data-act="edit" data-i="${off + i}">แก้ไข</button></td></tr>`; }).join("") || `<tr><td colspan="8" class="center muted" style="padding:24px">ไม่พบรายการ</td></tr>`}
      </tbody></table></div>
      ${pages > 1 ? `<div class="pager"><button class="btn btn-sm" data-act="page" data-p="${RC.page - 1}" ${RC.page <= 1 ? "disabled" : ""}>◀</button> หน้า ${RC.page} / ${pages} <button class="btn btn-sm" data-act="page" data-p="${RC.page + 1}" ${RC.page >= pages ? "disabled" : ""}>▶</button></div>` : ""}`;
  }
  async function exportRecords() {
    if (!RC.rows.length) return toast("ไม่มีข้อมูลให้ส่งออก", "err");
    const XLSX = await A.loadXlsx();
    const aoa = [["วันที่", "ชื่อ-สกุล", "ตำแหน่ง", "สถานะ", "เวลา", "ห่างเสาธง(ม.)", "หมายเหตุ", "ที่มา"], ...RC.rows.map((r) => { const t = A.tmap.get(r.teacher_id) || {}; return [r.date, t.first_name ? fullName(t) : "", t.job_title || "", STATUS[r.status].label, fmtTime(r.checkin_at), r.distance_m != null ? Math.round(r.distance_m) : "", r.note, SOURCE_LABEL[r.source]]; })];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "เช็กชื่อ");
    XLSX.writeFile(wb, `เช็กชื่อ_${RC.from}_${RC.to}.xlsx`);
  }

  // ================================================================ 3) จัดการครู
  const TF = { q: "", f: "all" };
  async function viewTeachers() {
    const main = $("#main");
    main.innerHTML = `
      <div class="page-head"><h1>จัดการครู</h1><div class="toolbar">
        <button class="btn btn-primary" data-act="add">+ เพิ่มครู</button><button class="btn" data-act="import">📤 นำเข้าจาก Excel</button>
        <button class="btn" data-act="slips" ${A.creds.length ? "" : "disabled"} title="พิมพ์ใบรหัสผ่านของรายการที่เพิ่งสร้าง/รีเซ็ตในครั้งนี้">🖨️ พิมพ์ใบแจกรหัส (${A.creds.length})</button></div></div>
      <div class="card"><div class="toolbar"><input id="tQ" placeholder="ค้นหาชื่อ / อีเมล / ตำแหน่ง" style="min-width:240px" value="${esc(TF.q)}">
        <select id="tF">${[["all", "ทั้งหมด"], ["active", "ใช้งานอยู่"], ["inactive", "ปิดการใช้งาน"], ["nopw", "ยังไม่ตั้งรหัสผ่านเอง"], ["noline", "ยังไม่ผูก LINE"]].map(([v, l]) => `<option value="${v}" ${TF.f === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        <span class="muted small" id="tCount"></span></div></div>
      <div id="tBody"></div>`;
    $("#tQ").oninput = debounce((e) => { TF.q = e.target.value; drawTeachers(); }, 150);
    $("#tF").onchange = (e) => { TF.f = e.target.value; drawTeachers(); };
    main.onclick = (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      const t = A.tmap.get(b.dataset.tid), act = b.dataset.act;
      $$("details.menu[open]").forEach((d) => d.removeAttribute("open"));
      if (act === "add") openTeacherModal();
      else if (act === "import") openImportModal();
      else if (act === "slips") printSlips(A.creds);
      else if (act === "edit") openTeacherModal(t);
      else if (act === "reset") resetPassword(t);
      else if (act === "unbind") unbindLine(t);
      else if (act === "toggle") toggleActive(t);
      else if (act === "delete") deleteTeacher(t);
    };
    drawTeachers();
  }
  function drawTeachers() {
    const q = TF.q.trim().toLowerCase();
    const list = A.teachers.filter((t) => {
      if (TF.f === "active" && !t.active) return false; if (TF.f === "inactive" && t.active) return false;
      if (TF.f === "nopw" && (t.password_set || !t.active)) return false; if (TF.f === "noline" && (t.line_user_id || !t.active)) return false;
      return !q || (fullName(t) + " " + t.email + " " + t.job_title + " " + t.department).toLowerCase().includes(q);
    });
    $("#tCount").textContent = `แสดง ${list.length} จาก ${A.teachers.length} คน · ใช้งาน ${A.teachers.filter((t) => t.active).length} · ผูก LINE แล้ว ${A.teachers.filter((t) => t.line_user_id).length}`;
    $("#tBody").innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>ที่</th><th>ชื่อ-สกุล</th><th>ตำแหน่ง / กลุ่มสาระ</th><th>เลขบัตร</th><th>อีเมล</th><th>บัญชี</th><th>LINE</th><th></th></tr></thead><tbody>
      ${list.map((t, i) => `<tr class="${t.active ? "" : "inactive"}"><td>${i + 1}</td><td class="nowrap"><b>${esc(fullName(t))}</b></td>
        <td>${esc(t.job_title)}${t.department ? `<div class="small muted">${esc(t.department)}</div>` : ""}</td><td class="nowrap">${esc(t.national_id_masked)}</td><td>${esc(t.email)}</td>
        <td>${t.active ? `<span class="tag tag-ok">ใช้งาน</span>` : `<span class="tag tag-err">ปิดใช้งาน</span>`} ${t.password_set ? "" : `<span class="tag tag-warn" title="ยังใช้รหัสชั่วคราวอยู่">ยังไม่ตั้งรหัสเอง</span>`}</td>
        <td>${t.line_user_id ? `<span class="tag tag-ok" title="${esc(t.line_display_name || "")}">ผูกแล้ว</span>` : `<span class="tag">ยังไม่ผูก</span>`}</td>
        <td class="right"><details class="menu"><summary class="btn btn-sm">จัดการ ▾</summary><div class="pop">
          <button data-act="edit" data-tid="${t.id}">✏️ แก้ไขข้อมูล</button><button data-act="reset" data-tid="${t.id}">🔑 รีเซ็ตรหัสผ่าน</button>
          ${t.line_user_id ? `<button data-act="unbind" data-tid="${t.id}">🔗 ยกเลิกการผูก LINE</button>` : ""}
          <button data-act="toggle" data-tid="${t.id}">${t.active ? "⏸️ ปิดการใช้งาน" : "▶️ เปิดการใช้งาน"}</button>
          ${t.active ? "" : `<button class="dng" data-act="delete" data-tid="${t.id}">🗑️ ลบถาวร</button>`}</div></details></td></tr>`).join("") || `<tr><td colspan="8" class="center muted" style="padding:24px">ไม่พบรายการ</td></tr>`}
      </tbody></table></div>`;
  }
  async function reloadTeachers() { await loadBase(); if (A.view === "teachers") drawTeachers(); }

  function openTeacherModal(t = null) {
    const edit = !!t;
    const body = modal.open(edit ? "แก้ไขข้อมูลครู" : "เพิ่มครู", `
      <form id="tf">
        <label>เลขบัตรประชาชน 13 หลัก${edit ? ` <span class="muted small">(เว้นว่างถ้าไม่เปลี่ยน — ปัจจุบัน ${esc(t.national_id_masked)})</span>` : ""}</label>
        <input id="fNid" inputmode="numeric" maxlength="17" placeholder="x-xxxx-xxxxx-xx-x" autocomplete="off">
        <div class="row3"><div><label>คำนำหน้า</label><input id="fPre" list="preList" value="${esc(t ? t.prefix : "")}"><datalist id="preList"><option>นาย</option><option>นาง</option><option>นางสาว</option><option>ดร.</option><option>ว่าที่ร้อยตรี</option></datalist></div>
          <div><label>ชื่อ</label><input id="fFirst" value="${esc(t ? t.first_name : "")}"></div><div><label>นามสกุล</label><input id="fLast" value="${esc(t ? t.last_name : "")}"></div></div>
        <div class="row2"><div><label>ตำแหน่ง / วิทยฐานะ</label><input id="fJob" value="${esc(t ? t.job_title : "")}" placeholder="เช่น ครู คศ.2"></div>
          <div><label>กลุ่มสาระ / ฝ่าย</label><input id="fDep" value="${esc(t ? t.department : "")}"></div></div>
        <label>อีเมล (ใช้รับลิงก์ตั้งรหัสผ่านใหม่)</label><input id="fMail" type="email" value="${esc(t ? t.email : "")}">
        <div class="row3"><div><label>วันที่เริ่มนับ</label><input type="date" id="fStart" value="${t ? t.start_date : bkkToday()}"></div>
          <div><label>วันที่สิ้นสุด <span class="muted small">(ถ้ามี)</span></label><input type="date" id="fEnd" value="${t && t.end_date ? t.end_date : ""}"></div>
          <div><label>ลำดับในรายงาน</label><input type="number" id="fSort" value="${t ? t.sort_order : 0}"></div></div>
        <p class="hint">"วันที่เริ่มนับ" คือวันแรกที่นับเป็นวันทำงานของครูคนนี้ในรายงาน (ก่อนหน้านั้นจะไม่ถูกนับว่าขาด)</p>
        <label class="check"><input type="checkbox" id="fBad"> <span>ยอมรับเลขบัตรที่ไม่ผ่านการตรวจเลขตรวจสอบ (ใช้เฉพาะกรณีเลขทดสอบ)</span></label>
        <div id="fMsg"></div>
        <div class="modal-foot"><button type="button" class="btn" id="fCancel">ยกเลิก</button><button class="btn btn-primary" id="fSave">${edit ? "บันทึก" : "เพิ่มครู"}</button></div>
      </form>`);
    $("#fNid", body).addEventListener("input", (e) => { e.target.value = formatNid(e.target.value); });
    $("#fCancel", body).onclick = modal.close;
    $("#tf", body).onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("#fSave", body), msg = $("#fMsg", body);
      const nid = $("#fNid", body).value.replace(/\D/g, "");
      const fields = { prefix: $("#fPre", body).value, first_name: $("#fFirst", body).value, last_name: $("#fLast", body).value, job_title: $("#fJob", body).value, department: $("#fDep", body).value, email: $("#fMail", body).value, start_date: $("#fStart", body).value, sort_order: $("#fSort", body).value };
      setBusy(btn, true, "กำลังบันทึก…");
      let r;
      if (edit) {
        fields.end_date = $("#fEnd", body).value || null;
        if (nid) fields.national_id = nid;
        r = await callAdmin("teacher_update", { id: t.id, fields, allow_bad_checksum: $("#fBad", body).checked });
      } else {
        r = await callAdmin("teacher_create", { teacher: { ...fields, national_id: nid }, allow_bad_checksum: $("#fBad", body).checked });
      }
      if (!r.ok) { setBusy(btn, false); msg.innerHTML = alertBox("err", r.error); return; }
      await reloadTeachers();
      if (edit) { modal.close(); toast("บันทึกแล้ว"); }
      else showCredentials([{ ...r.teacher, temp_password: r.temp_password }], "เพิ่มครูเรียบร้อย");
    };
  }

  // แสดงรหัสชั่วคราว (แสดงครั้งเดียว) + ปุ่มพิมพ์ใบแจกรหัส
  function showCredentials(list, title) {
    list.forEach((c) => { A.creds = A.creds.filter((x) => x.id !== c.id); A.creds.push(c); });
    const body = modal.open(title, `
      ${list.length === 1 ? `<p><b>${esc(fullName(list[0]))}</b></p><div class="temp-pw">${esc(list[0].temp_password)}</div>` : `<p>สร้างรหัสชั่วคราวให้ ${list.length} คน</p>`}
      ${alertBox("warn", "รหัสชั่วคราวนี้แสดงครั้งเดียวและระบบไม่เก็บรหัสจริงไว้ กรุณาพิมพ์ใบแจกรหัสหรือจดไว้ตอนนี้ หากทำหาย ให้รีเซ็ตรหัสผ่านใหม่")}
      <p class="small">ครูเข้าสู่ระบบด้วย <b>เลขบัตรประชาชนของตนเอง</b> + รหัสชั่วคราวนี้ แล้วระบบจะให้ตั้งรหัสผ่านใหม่ทันที</p>
      <div class="modal-foot"><button class="btn" id="cClose">ปิด</button><button class="btn btn-primary" id="cPrint">🖨️ พิมพ์ใบแจกรหัส</button></div>`);
    $("#cClose", body).onclick = modal.close;
    $("#cPrint", body).onclick = () => printSlips(list);
    if (A.view === "teachers") { const b = $('[data-act="slips"]'); if (b) { b.disabled = false; b.textContent = `🖨️ พิมพ์ใบแจกรหัส (${A.creds.length})`; } }
  }
  function slipUrl() { return cfg.LIFF_ID ? `https://liff.line.me/${cfg.LIFF_ID}` : new URL("index.html", location.href).href; }
  function printSlips(list) {
    if (!list.length) return;
    const s = A.settings;
    const html = `<div class="slips">${list.map((c) => `<div class="slip">
      <div class="h">${esc(s.school_name)}<br>ใบแจ้งรหัสผ่านชั่วคราว — ระบบ${esc(cfg.APP_TITLE)}</div>
      <div><b>${esc(fullName(c))}</b>${c.job_title ? ` <span style="color:#444">(${esc(c.job_title)})</span>` : ""}</div>
      <div>ชื่อผู้ใช้: <b>เลขบัตรประชาชน 13 หลักของท่าน</b></div>
      <div>รหัสผ่านชั่วคราว: <span class="pw">${esc(c.temp_password)}</span></div>
      <ol><li>เปิดลิงก์ในแอป LINE: ${esc(slipUrl())}</li><li>กรอกเลขบัตรประชาชนและรหัสผ่านชั่วคราวข้างต้น</li><li>ตั้งรหัสผ่านใหม่ของท่านเอง และยอมรับข้อตกลงการใช้ข้อมูล</li><li>ลืมรหัส: กด "ลืมรหัสผ่าน" ระบบจะส่งลิงก์ไปที่อีเมลที่ลงทะเบียนไว้</li></ol>
      <div style="font-size:11px;margin-top:3px">* ห้ามบอกรหัสผ่านแก่ผู้อื่น และควรทำลายใบนี้หลังตั้งรหัสผ่านใหม่แล้ว</div></div>`).join("")}</div>`;
    A.printHtml(html);
  }
  async function resetPassword(t) {
    if (!confirm(`รีเซ็ตรหัสผ่านของ ${fullName(t)} ใช่หรือไม่?\nระบบจะสร้างรหัสชั่วคราวใหม่ และครูต้องตั้งรหัสผ่านใหม่เมื่อเข้าครั้งถัดไป`)) return;
    const r = await callAdmin("teacher_reset_password", { id: t.id });
    if (!r.ok) return toast(r.error, "err");
    await reloadTeachers();
    showCredentials([{ ...r.teacher, temp_password: r.temp_password }], "รีเซ็ตรหัสผ่านเรียบร้อย");
  }
  async function unbindLine(t) {
    if (!confirm(`ยกเลิกการผูก LINE ของ ${fullName(t)} ใช่หรือไม่?\n(ใช้เมื่อครูเปลี่ยนโทรศัพท์/บัญชี LINE — ครูจะผูกใหม่ได้เมื่อเข้าสู่ระบบครั้งถัดไป)`)) return;
    const r = await callAdmin("teacher_unbind_line", { id: t.id });
    if (!r.ok) return toast(r.error, "err");
    await reloadTeachers(); toast("ยกเลิกการผูกแล้ว");
  }
  async function toggleActive(t) {
    const to = !t.active;
    if (!confirm(to ? `เปิดการใช้งาน ${fullName(t)} อีกครั้ง?` : `ปิดการใช้งาน ${fullName(t)}?\n(ประวัติเดิมยังอยู่ครบ ครูจะเข้าสู่ระบบไม่ได้ และระบบจะไม่นับเป็นผู้ที่ต้องเช็กชื่อหลังจากวันนี้)`)) return;
    const r = await callAdmin("teacher_set_active", { id: t.id, active: to });
    if (!r.ok) return toast(r.error, "err");
    await reloadTeachers(); toast(to ? "เปิดการใช้งานแล้ว" : "ปิดการใช้งานแล้ว");
  }
  async function deleteTeacher(t) {
    const typed = prompt(`⚠️ ลบ ${fullName(t)} ถาวร — ประวัติการเช็กชื่อของครูคนนี้จะถูกลบด้วย และกู้คืนไม่ได้\n(แนะนำให้ดาวน์โหลดไฟล์สำรองข้อมูลก่อน)\n\nพิมพ์คำว่า "ลบ" เพื่อยืนยัน`);
    if (typed === null) return;
    if (typed.trim() !== "ลบ") return toast("ยกเลิกการลบ (ต้องพิมพ์คำว่า ลบ)", "err");
    const r = await callAdmin("teacher_delete", { id: t.id, confirm: true });
    if (!r.ok) return toast(r.error, "err");
    await reloadTeachers(); toast("ลบแล้ว");
  }

  // ---------------------------------------------------------------- นำเข้าจาก Excel
  const IMPORT_COLS = {
    national_id: ["เลขบัตรประชาชน", "เลขประจำตัวประชาชน", "เลขบัตร", "national_id", "nid"],
    prefix: ["คำนำหน้า", "คำนำหน้าชื่อ", "prefix"],
    first_name: ["ชื่อ", "first_name", "firstname"],
    last_name: ["นามสกุล", "สกุล", "last_name", "lastname"],
    job_title: ["ตำแหน่ง", "ตำแหน่ง/วิทยฐานะ", "job_title", "position"],
    department: ["กลุ่มสาระ/ฝ่าย", "กลุ่มสาระ", "ฝ่าย", "department"],
    email: ["อีเมล", "อีเมลล์", "email", "e-mail"],
    start_date: ["วันที่เริ่มนับ", "วันเริ่มนับ", "start_date"],
    sort_order: ["ลำดับ", "sort_order", "order"],
  };
  async function downloadTemplate() {
    const XLSX = await A.loadXlsx();
    const aoa = [["เลขบัตรประชาชน", "คำนำหน้า", "ชื่อ", "นามสกุล", "ตำแหน่ง", "กลุ่มสาระ/ฝ่าย", "อีเมล", "วันที่เริ่มนับ (ไม่บังคับ)", "ลำดับ (ไม่บังคับ)"],
      ["'(ตัวอย่าง) 1101700230708", "นาย", "สมชาย", "ใจดี", "ครู คศ.2", "คณิตศาสตร์", "somchai@example.com", "", 1]];
    const ws = XLSX.utils.aoa_to_sheet(aoa); ws["!cols"] = [{ wch: 18 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 26 }, { wch: 22 }, { wch: 16 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "รายชื่อครู");
    XLSX.writeFile(wb, "แบบฟอร์มนำเข้ารายชื่อครู.xlsx");
  }
  function parseSheet(XLSX, buf) {
    const wb = XLSX.read(buf, { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: true });
    if (rows.length < 2) throw new Error("ไม่พบข้อมูลในไฟล์");
    const head = rows[0].map((h) => String(h).replace(/\(.*?\)/g, "").trim().toLowerCase());
    const idx = {};
    for (const [key, names] of Object.entries(IMPORT_COLS)) idx[key] = head.findIndex((h) => names.some((n) => n.toLowerCase() === h));
    const missing = ["national_id", "first_name", "last_name", "email"].filter((k) => idx[k] < 0);
    if (missing.length) throw new Error("ไม่พบคอลัมน์ที่จำเป็น: " + missing.map((k) => IMPORT_COLS[k][0]).join(", ") + " (หัวตารางต้องอยู่แถวแรก)");
    const out = [];
    rows.slice(1).forEach((r, n) => {
      const get = (k) => (idx[k] >= 0 ? r[idx[k]] : "");
      if (r.every((c) => String(c).trim() === "")) return;
      const nid = String(get("national_id")).replace(/\D/g, "");
      const sd = parseDateFlexible(get("start_date"));
      const row = { line: n + 2, national_id: nid, prefix: String(get("prefix")).trim(), first_name: String(get("first_name")).trim(), last_name: String(get("last_name")).trim(),
        job_title: String(get("job_title")).trim(), department: String(get("department")).trim(), email: String(get("email")).trim().toLowerCase(), start_date: sd || undefined, sort_order: get("sort_order") === "" ? undefined : Number(get("sort_order")) };
      const errs = [];
      if (nid.length !== 13) errs.push("เลขบัตรไม่ครบ 13 หลัก");
      if (!row.first_name || !row.last_name) errs.push("ไม่มีชื่อ/นามสกุล");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) errs.push("อีเมลไม่ถูกต้อง");
      if (sd === undefined) errs.push("วันที่เริ่มนับไม่ถูกต้อง");
      row.errs = errs; row.badSum = nid.length === 13 && !validThaiId(nid);
      out.push(row);
    });
    return out;
  }
  function openImportModal() {
    const body = modal.open("นำเข้ารายชื่อครูจาก Excel", `
      <p class="small">ใช้ไฟล์ .xlsx หรือ .csv ที่มีหัวตารางในแถวแรก คอลัมน์ที่จำเป็น: <b>เลขบัตรประชาชน, ชื่อ, นามสกุล, อีเมล</b> (ส่วน คำนำหน้า, ตำแหน่ง, กลุ่มสาระ/ฝ่าย, วันที่เริ่มนับ, ลำดับ ไม่บังคับ)</p>
      <div class="toolbar"><button class="btn btn-sm" id="iTpl">📄 ดาวน์โหลดแบบฟอร์มตัวอย่าง</button></div>
      <label>เลือกไฟล์</label><input type="file" id="iFile" accept=".xlsx,.xls,.csv">
      <div id="iPrev"></div>`, { wide: true });
    $("#iTpl", body).onclick = () => downloadTemplate().catch((e) => toast(e.message, "err"));
    $("#iFile", body).onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const prev = $("#iPrev", body); prev.innerHTML = "กำลังอ่านไฟล์…";
      try {
        const XLSX = await A.loadXlsx();
        const rows = parseSheet(XLSX, await f.arrayBuffer());
        const existingMail = new Set(A.teachers.map((t) => t.email)), seen = new Set();
        rows.forEach((r) => { if (existingMail.has(r.email)) r.errs.push("อีเมลซ้ำกับครูในระบบ"); if (seen.has(r.national_id)) r.errs.push("เลขบัตรซ้ำในไฟล์"); seen.add(r.national_id); });
        showImportPreview(body, rows);
      } catch (err) { prev.innerHTML = alertBox("err", err.message || String(err)); }
    };
  }
  function showImportPreview(body, rows) {
    const prev = $("#iPrev", body);
    const bad = rows.filter((r) => r.errs.length).length, sumWarn = rows.filter((r) => !r.errs.length && r.badSum).length;
    prev.innerHTML = `
      <div class="mt">${alertBox(bad ? "warn" : "ok", `พบ ${rows.length} แถว · พร้อมนำเข้า ${rows.length - bad} · มีปัญหา ${bad} (แถวที่มีปัญหาจะถูกข้าม)`)}</div>
      ${sumWarn ? `<label class="check"><input type="checkbox" id="iBad"> <span>มี ${sumWarn} แถวที่เลขบัตรไม่ผ่านการตรวจเลขตรวจสอบ — ติ๊กเพื่อยอมรับ (ปกติให้ตรวจแก้ไขไฟล์ก่อน)</span></label>` : ""}
      <div class="tbl-wrap" style="max-height:300px"><table class="tbl"><thead><tr><th>แถว</th><th>ชื่อ-สกุล</th><th>เลขบัตร</th><th>อีเมล</th><th>ตรวจสอบ</th></tr></thead><tbody>
      ${rows.slice(0, 300).map((r) => `<tr><td>${r.line}</td><td>${esc(r.prefix + r.first_name + " " + r.last_name)}</td><td>${r.national_id ? "x-xxxx-xxxxx-" + esc(r.national_id.slice(10, 12) || "??") + "-" + esc(r.national_id.slice(12) || "?") : "-"}</td><td>${esc(r.email)}</td>
        <td>${r.errs.length ? `<span class="tag tag-err">${esc(r.errs.join(", "))}</span>` : r.badSum ? `<span class="tag tag-warn">เลขตรวจสอบไม่ผ่าน</span>` : `<span class="tag tag-ok">พร้อม</span>`}</td></tr>`).join("")}
      </tbody></table></div>${rows.length > 300 ? `<p class="hint">แสดง 300 แถวแรก</p>` : ""}
      <div id="iMsg"></div>
      <div class="modal-foot"><button class="btn" id="iCancel">ยกเลิก</button><button class="btn btn-primary" id="iGo" ${rows.length - bad ? "" : "disabled"}>นำเข้า ${rows.length - bad} รายการ</button></div>`;
    $("#iCancel", body).onclick = modal.close;
    $("#iGo", body).onclick = async () => {
      const allowBad = $("#iBad", body) ? $("#iBad", body).checked : false;
      const todo = rows.filter((r) => !r.errs.length && (allowBad || !r.badSum));
      if (!todo.length) { $("#iMsg", body).innerHTML = alertBox("err", "ไม่มีรายการที่นำเข้าได้ (เลขบัตรไม่ผ่านการตรวจเลขตรวจสอบ)"); return; }
      const btn = $("#iGo", body); btn.disabled = true;
      const results = []; let failed = 0;
      for (let i = 0; i < todo.length; i += 25) {
        btn.textContent = `กำลังนำเข้า… ${Math.min(i + 25, todo.length)}/${todo.length}`;
        const chunk = todo.slice(i, i + 25);
        const r = await callAdmin("teacher_import", { rows: chunk.map(({ line, errs, badSum, ...x }) => x), allow_bad_checksum: allowBad });
        if (!r.ok) { $("#iMsg", body).innerHTML = alertBox("err", `หยุดที่แถว ${chunk[0].line}: ${r.error}`); break; }
        r.results.forEach((x, k) => results.push({ row: chunk[k], ...x }));
      }
      await reloadTeachers();
      const okRes = results.filter((x) => x.ok);
      failed = results.length - okRes.length;
      okRes.forEach((x) => { A.creds = A.creds.filter((c) => c.id !== x.teacher.id); A.creds.push({ ...x.teacher, temp_password: x.temp_password }); });
      const creds = okRes.map((x) => ({ ...x.teacher, temp_password: x.temp_password }));
      body.innerHTML = `
        ${alertBox(failed ? "warn" : "ok", `นำเข้าสำเร็จ ${okRes.length} คน${failed ? ` · ไม่สำเร็จ ${failed}` : ""}`)}
        ${failed ? `<div class="tbl-wrap" style="max-height:180px"><table class="tbl"><tbody>${results.filter((x) => !x.ok).map((x) => `<tr><td>แถว ${x.row.line}</td><td>${esc(x.row.first_name + " " + x.row.last_name)}</td><td><span class="tag tag-err">${esc(x.error)}</span></td></tr>`).join("")}</tbody></table></div>` : ""}
        ${alertBox("warn", "รหัสชั่วคราวแสดงครั้งเดียว กรุณาพิมพ์ใบแจกรหัสหรือดาวน์โหลดรายการตอนนี้ หากทำหายให้รีเซ็ตรหัสผ่านรายคน")}
        <div class="modal-foot"><button class="btn" id="iClose">ปิด</button>
          <button class="btn" id="iXlsx" ${creds.length ? "" : "disabled"}>📥 ดาวน์โหลดรายการรหัส (Excel)</button>
          <button class="btn btn-primary" id="iPrint" ${creds.length ? "" : "disabled"}>🖨️ พิมพ์ใบแจกรหัส ${creds.length} ใบ</button></div>`;
      $("#iClose", body).onclick = modal.close;
      $("#iPrint", body).onclick = () => printSlips(creds);
      $("#iXlsx", body).onclick = async () => {
        const XLSX = await A.loadXlsx();
        const aoa = [["ชื่อ-สกุล", "ตำแหน่ง", "เลขบัตร(ปิดบัง)", "อีเมล", "รหัสผ่านชั่วคราว"], ...creds.map((c) => [fullName(c), c.job_title, c.national_id_masked, c.email, c.temp_password])];
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "รหัสชั่วคราว");
        XLSX.writeFile(wb, "รหัสผ่านชั่วคราว_ลบหลังแจก.xlsx");
      };
    };
  }

  // ================================================================ 4) สำรองข้อมูล
  async function viewBackup() {
    const main = $("#main"), last = localStorage.getItem("lastBackupAt");
    const days = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : null;
    main.innerHTML = `
      <div class="page-head"><h1>สำรองข้อมูล</h1></div>
      ${last ? (days > 30 ? alertBox("warn", `สำรองข้อมูลล่าสุดเมื่อ ${days} วันที่แล้ว ควรสำรองใหม่`) : alertBox("ok", `สำรองข้อมูลล่าสุดเมื่อ ${days === 0 ? "วันนี้" : days + " วันที่แล้ว"} (จากเครื่องนี้)`)) : alertBox("warn", "ยังไม่เคยสำรองข้อมูลจากเครื่องนี้")}
      <div class="card"><h2>📥 ไฟล์ Excel (อ่านและพิมพ์ได้)</h2>
        <p class="muted">รวมรายชื่อครู ประวัติเช็กชื่อทั้งหมด วันหยุด และการตั้งค่า แยกเป็นหลายชีต เปิดด้วย Excel ได้ทันที</p>
        <button class="btn btn-primary" id="bX">ดาวน์โหลด Excel</button> <span id="bXs" class="muted small"></span></div>
      <div class="card"><h2>🗄️ ไฟล์สำรองเต็ม (JSON)</h2>
        <p class="muted">เก็บข้อมูลดิบครบทุกตาราง รวมค่าแฮชของเลขบัตร (ไม่ใช่เลขจริง) ใช้สำหรับกู้ข้อมูลกรณีฉุกเฉิน ควรเก็บไว้ในที่ปลอดภัยและไม่แชร์ให้ผู้อื่น</p>
        <button class="btn" id="bJ">ดาวน์โหลด JSON</button> <span id="bJs" class="muted small"></span></div>
      ${alertBox("info", "แนะนำให้สำรองข้อมูลอย่างน้อยเดือนละครั้ง และก่อนลบข้อมูลหรือสิ้นปีการศึกษา — แพ็กเกจฟรีของ Supabase ไม่ควรถือเป็นที่เก็บข้อมูลเพียงแห่งเดียว")}`;
    const mark = () => localStorage.setItem("lastBackupAt", new Date().toISOString());
    $("#bX").onclick = async () => {
      const btn = $("#bX"), st = $("#bXs"); btn.disabled = true;
      try {
        st.textContent = "กำลังรวบรวมข้อมูล…";
        const XLSX = await A.loadXlsx();
        const att = await A.fetchAll(() => sb.from("attendance").select("*").order("date").order("id"));
        const wb = XLSX.utils.book_new();
        const add = (name, aoa) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
        add("ครู", [["ชื่อ-สกุล", "ตำแหน่ง", "กลุ่มสาระ/ฝ่าย", "เลขบัตร(ปิดบัง)", "อีเมล", "สถานะบัญชี", "ผูก LINE", "ตั้งรหัสผ่านเอง", "วันที่เริ่มนับ", "วันที่สิ้นสุด", "ลำดับ"],
          ...A.teachers.map((t) => [fullName(t), t.job_title, t.department, t.national_id_masked, t.email, t.active ? "ใช้งาน" : "ปิด", t.line_user_id ? "ผูกแล้ว" : "ไม่ผูก", t.password_set ? "ใช่" : "ยังไม่", t.start_date, t.end_date || "", t.sort_order])]);
        add("เช็กชื่อ", [["วันที่", "ชื่อ-สกุล", "สถานะ", "เวลา", "ห่างเสาธง(ม.)", "หมายเหตุ", "ที่มา"],
          ...att.map((r) => { const t = A.tmap.get(r.teacher_id); return [r.date, t ? fullName(t) : "(ลบแล้ว)", STATUS[r.status].label, fmtTime(r.checkin_at), r.distance_m != null ? Math.round(r.distance_m) : "", r.note, SOURCE_LABEL[r.source]]; })]);
        add("วันหยุด", [["วันที่", "ชื่อวันหยุด"], ...[...A.holidays].map(([d, n]) => [d, n])]);
        const s = A.settings;
        add("ตั้งค่า", [["รายการ", "ค่า"], ["ชื่อโรงเรียน", s.school_name], ["จุดเสาธง (lat,lng)", s.lat != null ? `${s.lat}, ${s.lng}` : "-"], ["รัศมี (ม.)", s.radius_m], ["เริ่มรับเช็กชื่อ", hhmm(s.open_time)], ["ตรงเวลาถึง", hhmm(s.ontime_until)], ["ปิดรับเช็กชื่อ", hhmm(s.close_time)], ["วันทำการ (1=จันทร์)", s.work_days.join(",")]]);
        XLSX.writeFile(wb, `สำรองข้อมูลเช็กชื่อ_${bkkToday()}.xlsx`);
        mark(); st.textContent = `เสร็จแล้ว (ประวัติเช็กชื่อ ${att.length.toLocaleString()} รายการ)`;
      } catch (e) { st.textContent = ""; toast(e.message || String(e), "err"); }
      btn.disabled = false;
    };
    $("#bJ").onclick = async () => {
      const btn = $("#bJ"), st = $("#bJs"); btn.disabled = true;
      try {
        const out = { exported_at: new Date().toISOString(), version: 1, tables: {} };
        for (const table of ["settings", "teachers", "attendance", "holidays", "admins", "audit_logs"]) {
          out.tables[table] = [];
          for (let offset = 0; ; ) {
            st.textContent = `กำลังอ่าน ${table}… ${out.tables[table].length.toLocaleString()}`;
            const r = await callAdmin("backup_export", { table, offset, limit: 2000 });
            if (!r.ok) throw new Error(r.error);
            out.tables[table].push(...r.rows); offset = r.next;
            if (r.done) break;
          }
        }
        download(`backup_attendance_${bkkToday()}.json`, JSON.stringify(out, null, 1), "application/json");
        mark(); st.textContent = "เสร็จแล้ว";
      } catch (e) { st.textContent = ""; toast(e.message || String(e), "err"); }
      btn.disabled = false;
    };
  }

  // ================================================================ 5) ตั้งค่า
  async function viewSettings() {
    const main = $("#main"), s = A.settings;
    const wd = [[1, "จ."], [2, "อ."], [3, "พ."], [4, "พฤ."], [5, "ศ."], [6, "ส."], [7, "อา."]];
    main.innerHTML = `
      <div class="page-head"><h1>ตั้งค่า</h1></div>
      <form id="sf">
      <div class="card"><h2>📍 จุดเสาธงและการตรวจ GPS</h2>
        <p class="muted small">คลิกบนแผนที่หรือลากหมุดไปยังจุดเสาธง · หรือยืนที่เสาธงแล้วกด "ใช้ตำแหน่งปัจจุบันของฉัน" (ควรเปิดหน้านี้ในโทรศัพท์) · หรือวางพิกัดจาก Google Maps</p>
        <div id="map"><div class="splash">กำลังโหลดแผนที่…</div></div>
        <div class="row3 mt"><div><label>ละติจูด</label><input id="sLat" inputmode="decimal" value="${s.lat ?? ""}"></div><div><label>ลองจิจูด</label><input id="sLng" inputmode="decimal" value="${s.lng ?? ""}"></div>
          <div><label>รัศมีที่ยอมรับ (เมตร)</label><input id="sRad" type="number" min="10" max="5000" value="${s.radius_m}"></div></div>
        <div class="toolbar mt"><button type="button" class="btn btn-sm" id="sHere">📡 ใช้ตำแหน่งปัจจุบันของฉัน</button>
          <input id="sPaste" placeholder="วางพิกัดจาก Google Maps เช่น 17.4138, 102.7872" style="min-width:280px"><button type="button" class="btn btn-sm" id="sPasteBtn">ใช้พิกัดนี้</button></div>
        <label>ความคลาดเคลื่อน GPS สูงสุดที่ยอมรับ (เมตร)</label><input id="sAcc" type="number" min="10" max="1000" value="${s.max_accuracy_m}" style="max-width:200px">
        <p class="hint">ถ้า GPS คลาดเคลื่อนมากกว่าค่านี้ ระบบจะให้ครูรอสัญญาณแม่นขึ้นก่อน (แนะนำ 50–100) · รัศมีแนะนำ 50–150 เมตร ขึ้นกับขนาดลานเสาธง</p>
        <label class="check"><input type="checkbox" id="sLine" ${s.require_line ? "checked" : ""}> <span>ต้องยืนยันบัญชี LINE ตอนเช็กชื่อ (ป้องกันการเช็กแทนกัน) — ปิดเฉพาะตอนทดสอบ</span></label></div>

      <div class="card"><h2>🕗 เวลาและวันทำการ</h2>
        <div class="row3"><div><label>เริ่มรับเช็กชื่อ</label><input type="time" id="sOpen" value="${hhmm(s.open_time)}"></div>
          <div><label>เช็กก่อนเวลานี้ = "มา"</label><input type="time" id="sOn" value="${hhmm(s.ontime_until)}"></div>
          <div><label>ปิดรับเช็กชื่อ</label><input type="time" id="sClose" value="${hhmm(s.close_time)}"></div></div>
        <p class="hint">เช็กระหว่าง "เริ่มรับ" ถึง "ตรงเวลาถึง" = มา · หลังจากนั้นจนถึง "ปิดรับ" = สาย · หลังปิดรับ ครูเช็กเองไม่ได้ (แอดมินบันทึกให้ได้)</p>
        <label>วันทำการ</label><div class="toolbar">${wd.map(([n, l]) => `<label class="check" style="margin:0"><input type="checkbox" class="sWd" value="${n}" ${s.work_days.includes(n) ? "checked" : ""}> ${l}</label>`).join("")}</div></div>

      <div class="card"><h2>🏫 ข้อมูลหัวรายงาน</h2>
        <div class="row2"><div><label>ชื่อโรงเรียน</label><input id="sName" value="${esc(s.school_name)}"></div><div><label>สังกัด (ไม่บังคับ)</label><input id="sOrg" value="${esc(s.org_name)}" placeholder="เช่น สำนักงานเขตพื้นที่การศึกษา…"></div></div>
        <div class="row2"><div><label>ชื่อผู้อำนวยการ</label><input id="sDir" value="${esc(s.director_name)}"></div><div><label>ตำแหน่งใต้ลายเซ็น</label><input id="sDirT" value="${esc(s.director_title)}"></div></div>
        <div class="row2"><div><label>ตำแหน่งผู้ตรวจ</label><input id="sIns" value="${esc(s.inspector_title)}"></div><div><label>โลโก้ (ไม่บังคับ)</label><input id="sLogo" value="${esc(s.logo_url)}" placeholder="เช่น assets/logo.png"></div></div>
        <p class="hint">โลโก้: วางไฟล์ภาพไว้ในโฟลเดอร์ docs/assets ของ repository แล้วใส่ชื่อไฟล์ เช่น assets/logo.png</p></div>
      <div id="sMsg"></div>
      <button class="btn btn-primary" id="sSave">💾 บันทึกการตั้งค่า</button>
      </form>

      <div class="card mt"><h2>📅 วันหยุดของโรงเรียน</h2>
        <p class="muted small">วันเสาร์-อาทิตย์ไม่ต้องใส่ (ตั้งที่ "วันทำการ") — ใส่เฉพาะวันหยุดราชการ วันหยุดชดเชย หรือวันที่โรงเรียนปิด วันเหล่านี้จะไม่ถูกนับว่าไม่ได้เช็กชื่อ</p>
        <div class="toolbar"><label>ตั้งแต่ <input type="date" id="hFrom"></label><label>ถึง <input type="date" id="hTo"></label><input id="hName" placeholder="ชื่อวันหยุด เช่น วันปิยมหาราช" style="min-width:240px"><button class="btn btn-primary btn-sm" id="hAdd">+ เพิ่ม</button></div>
        <div id="hList" class="mt"></div></div>

      <div class="card"><h2>🔐 เปลี่ยนรหัสผ่านผู้ดูแลระบบ</h2>
        <form id="apForm" class="row2" style="align-items:end"><div><label>รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)</label><input id="apNew" type="password" autocomplete="new-password"></div><div><button class="btn" id="apBtn">เปลี่ยนรหัสผ่าน</button></div></form><div id="apMsg"></div></div>`;
    initMap(s);
    $("#sf").onsubmit = saveSettings;
    $("#hAdd").onclick = addHoliday;
    $("#hList").onclick = async (e) => {
      const b = e.target.closest("[data-d]"); if (!b) return;
      if (!confirm(`ลบวันหยุด ${thaiDate(b.dataset.d)} ?`)) return;
      const r = await callAdmin("holiday_delete", { date: b.dataset.d });
      if (!r.ok) return toast(r.error, "err");
      await loadBase(); drawHolidays();
    };
    $("#apForm").onsubmit = async (e) => {
      e.preventDefault();
      const pw = $("#apNew").value, msg = $("#apMsg");
      if (pw.length < 8) { msg.innerHTML = alertBox("err", "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร"); return; }
      const { error } = await sb.auth.updateUser({ password: pw });
      msg.innerHTML = error ? alertBox("err", "เปลี่ยนไม่สำเร็จ: " + error.message) : alertBox("ok", "เปลี่ยนรหัสผ่านแล้ว");
      if (!error) $("#apNew").value = "";
    };
    drawHolidays();
  }
  let map = null, marker = null, circle = null;
  async function initMap(s) {
    try {
      const L = await loadLeaflet(), el = $("#map"); if (!el) return;
      el.innerHTML = ""; if (map) { map.remove(); map = null; }
      const has = s.lat != null, center = has ? [s.lat, s.lng] : [17.4138, 102.7872];
      map = L.map(el).setView(center, has ? 18 : 14);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
      circle = L.circle(center, { radius: s.radius_m, color: "#1e3a8a", fillOpacity: 0.12 });
      marker = L.marker(center, { draggable: true });
      const put = (lat, lng, pan) => {
        marker.setLatLng([lat, lng]); circle.setLatLng([lat, lng]);
        if (!map.hasLayer(marker)) { marker.addTo(map); circle.addTo(map); }
        $("#sLat").value = lat.toFixed(6); $("#sLng").value = lng.toFixed(6);
        if (pan) map.setView([lat, lng], Math.max(map.getZoom(), 18));
      };
      if (has) { marker.addTo(map); circle.addTo(map); }
      map.on("click", (e) => put(e.latlng.lat, e.latlng.lng));
      marker.on("dragend", () => { const p = marker.getLatLng(); put(p.lat, p.lng); });
      $("#sRad").oninput = () => { const v = Number($("#sRad").value); if (v > 0) circle.setRadius(v); };
      const fromInputs = () => { const la = parseFloat($("#sLat").value), ln = parseFloat($("#sLng").value); if (isFinite(la) && isFinite(ln)) put(la, ln, true); };
      $("#sLat").onchange = $("#sLng").onchange = fromInputs;
      $("#sHere").onclick = () => {
        if (!navigator.geolocation) return toast("เบราว์เซอร์นี้ไม่รองรับ GPS", "err");
        navigator.geolocation.getCurrentPosition((p) => { put(p.coords.latitude, p.coords.longitude, true); toast(`ได้ตำแหน่งแล้ว (คลาดเคลื่อน ±${Math.round(p.coords.accuracy)} ม.)`); },
          () => toast("อ่านตำแหน่งไม่ได้ — ตรวจสอบสิทธิ์ตำแหน่งของเบราว์เซอร์", "err"), { enableHighAccuracy: true, timeout: 20000 });
      };
      $("#sPasteBtn").onclick = () => {
        const m = $("#sPaste").value.match(/(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/);
        if (!m) return toast("รูปแบบพิกัดไม่ถูกต้อง", "err"); put(+m[1], +m[2], true);
      };
    } catch (e) { const el = $("#map"); if (el) el.innerHTML = `<div class="splash">โหลดแผนที่ไม่สำเร็จ — ยังกรอกพิกัดด้วยมือได้<br><small>${esc(e.message)}</small></div>`; }
  }
  async function saveSettings(e) {
    e.preventDefault();
    const btn = $("#sSave"), msg = $("#sMsg"); msg.innerHTML = "";
    const wd = $$(".sWd").filter((c) => c.checked).map((c) => +c.value);
    const settings = {
      lat: $("#sLat").value.trim() === "" ? null : $("#sLat").value, lng: $("#sLng").value.trim() === "" ? null : $("#sLng").value,
      radius_m: $("#sRad").value, max_accuracy_m: $("#sAcc").value, require_line: $("#sLine").checked,
      open_time: $("#sOpen").value, ontime_until: $("#sOn").value, close_time: $("#sClose").value, work_days: wd,
      school_name: $("#sName").value, org_name: $("#sOrg").value, director_name: $("#sDir").value, director_title: $("#sDirT").value, inspector_title: $("#sIns").value, logo_url: $("#sLogo").value,
    };
    setBusy(btn, true, "กำลังบันทึก…");
    const r = await callAdmin("settings_save", { settings });
    setBusy(btn, false);
    if (!r.ok) { msg.innerHTML = alertBox("err", r.error); window.scrollTo(0, document.body.scrollHeight); return; }
    await loadBase(); toast("บันทึกการตั้งค่าแล้ว");
    if (settings.lat === null) msg.innerHTML = alertBox("warn", "ยังไม่ได้ตั้งจุดเสาธง ครูจะเช็กชื่อไม่ได้จนกว่าจะตั้งพิกัด");
  }
  function drawHolidays() {
    const box = $("#hList"); if (!box) return;
    const items = [...A.holidays].sort(([a], [b]) => (a < b ? 1 : -1));
    box.innerHTML = items.length ? `<div class="tbl-wrap" style="max-height:300px"><table class="tbl"><tbody>${items.map(([d, n]) => `<tr><td class="nowrap">${thaiDate(d, { weekday: true })}</td><td>${esc(n)}</td><td class="right"><button type="button" class="btn btn-sm btn-danger" data-d="${d}">ลบ</button></td></tr>`).join("")}</tbody></table></div>` : `<span class="muted small">ยังไม่มีวันหยุดที่บันทึกไว้</span>`;
  }
  async function addHoliday() {
    const from = $("#hFrom").value, to = $("#hTo").value || from;
    if (!from) return toast("เลือกวันที่ก่อน", "err");
    const r = await callAdmin("holiday_add", { date_from: from, date_to: to, name: $("#hName").value });
    if (!r.ok) return toast(r.error, "err");
    await loadBase(); drawHolidays(); toast(`เพิ่มวันหยุด ${r.added} วัน`);
    $("#hFrom").value = $("#hTo").value = $("#hName").value = "";
  }

  // ================================================================ 6) บันทึกกิจกรรม
  async function viewAudit() {
    const main = $("#main");
    main.innerHTML = `<div class="page-head"><h1>บันทึกกิจกรรม</h1><span class="muted small">แสดง 300 รายการล่าสุด</span></div><div id="aBody" class="muted">กำลังโหลด…</div>`;
    const { data, error } = await sb.from("audit_logs").select("*").order("at", { ascending: false }).limit(300);
    const body = $("#aBody"); if (!body) return;
    if (error) { body.innerHTML = alertBox("err", error.message); return; }
    const when = (iso) => { const p = bkkParts(new Date(iso)); return `${thaiDate(p.date, { short: true })} ${p.time.slice(0, 5)}`; };
    const brief = (d) => { if (!d) return ""; const o = { ...d }; delete o.before; delete o.after; return Object.entries(o).filter(([, v]) => v !== null && v !== "").map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · "); };
    body.className = "";
    body.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>เวลา</th><th>ผู้ทำ</th><th>การกระทำ</th><th>รายละเอียด</th></tr></thead><tbody>
      ${data.map((r) => `<tr><td class="nowrap">${when(r.at)}</td><td>${esc(r.actor_email || "")}</td><td class="nowrap"><b>${esc(ACTION_LABEL[r.action] || r.action)}</b></td><td class="small">${esc(brief(r.detail))}${r.detail && r.detail.before ? `<div class="muted">ก่อน: ${esc(r.detail.before.status || "")} ${esc(r.detail.before.note || "")} → หลัง: ${esc((r.detail.after || {}).status || "")} ${esc((r.detail.after || {}).note || "")}</div>` : ""}</td></tr>`).join("") || `<tr><td colspan="4" class="center muted" style="padding:24px">ยังไม่มีบันทึก</td></tr>`}
      </tbody></table></div>`;
  }

  // ================================================================ เริ่มต้น
  (async function boot() {
    const { data } = await sb.auth.getSession();
    if (data.session && (await enter(data.session.user))) return;
    showLogin();
  })();
})();
