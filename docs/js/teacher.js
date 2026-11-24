// หน้าครู (ใช้ผ่าน LINE LIFF บนมือถือเป็นหลัก)
(() => {
  const { cfg, $, $$, esc, toast, STATUS, thaiDate, thaiMonthYear, monthRange, fmtTime, bkkParts, addDays, isoDow, dowOf,
    datesBetween, fullName, formatNid, callFn, setBusy, TH_DAYS_SHORT, TH_MONTHS_SHORT } = App;
  const sb = App.makeClient("attendance-teacher-auth");
  const app = document.getElementById("app");
  const S = { liff: false, liffErr: "", me: null, st: null, skew: 0, tab: "home", timers: [], watch: null, pos: null, hist: null };
  const SKIP_KEY = "skipLineAuto";

  // ------------------------------------------------------------------ LIFF
  async function initLiff() {
    if (!cfg.LIFF_ID || !window.liff) return null;
    try {
      await liff.init({ liffId: cfg.LIFF_ID });
      S.liff = true;
      if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return "redirect"; }
    } catch (e) {
      S.liffErr = "เปิดการเชื่อมต่อ LINE ไม่สำเร็จ: " + (e && e.message ? e.message : e);
    }
    return null;
  }
  const idToken = () => { try { return S.liff && liff.isLoggedIn() ? liff.getIDToken() : null; } catch (e) { return null; } };
  function relogin() { try { liff.logout(); } catch (e) { /* ignore */ } liff.login({ redirectUri: location.href }); }

  // ------------------------------------------------------------------ เรียกฟังก์ชันพร้อม token
  async function authed(name, body) {
    const { data } = await sb.auth.getSession();
    if (!data.session) return { ok: false, code: "UNAUTHORIZED", error: "กรุณาเข้าสู่ระบบ" };
    return callFn(name, body, data.session.access_token);
  }
  async function loadMe() {
    const r = await authed("teacher", { action: "me" });
    if (!r.ok) {
      if (r.code === "UNAUTHORIZED") await sb.auth.signOut();
      return r;
    }
    S.me = r.teacher; S.st = r; S.skew = new Date(r.server_time).getTime() - Date.now();
    return r;
  }
  const serverNow = () => new Date(Date.now() + S.skew);

  // ------------------------------------------------------------------ เริ่มต้น
  async function boot() {
    if ((await initLiff()) === "redirect") return;
    const { data } = await sb.auth.getSession();
    if (data.session) {
      const r = await loadMe();
      if (r.ok) return route();
      if (r.code !== "UNAUTHORIZED") return showFatal(r.error);
    }
    if (S.liff && !localStorage.getItem(SKIP_KEY)) {
      const t = idToken();
      if (t) {
        const r = await callFn("auth", { action: "line", id_token: t });
        if (r.ok && r.bound) {
          const { error } = await sb.auth.verifyOtp({ token_hash: r.token_hash, type: "magiclink" });
          if (!error && (await loadMe()).ok) return route();
        } else if (r.code === "LINE_TOKEN_EXPIRED") return relogin();
      }
    }
    showLogin();
  }
  function showFatal(msg) {
    app.innerHTML = `<div class="auth-wrap"><div class="auth-card"><div class="logo">⚠️</div><h1>เกิดปัญหา</h1><p class="center">${esc(msg)}</p><button class="btn btn-primary btn-block" onclick="location.reload()">ลองใหม่</button></div></div>`;
  }
  function route() {
    if (!S.me.password_set || !S.me.pdpa_accepted) return showSetup();
    S.tab = "home"; go("home");
  }
  function go(tab) {
    stopLive(); S.tab = tab;
    ({ home: renderHome, history: renderHistory, report: renderReport, me: renderProfile })[tab]();
    window.scrollTo(0, 0);
  }
  function stopLive() {
    S.timers.forEach(clearInterval); S.timers = [];
    if (S.watch !== null && navigator.geolocation) navigator.geolocation.clearWatch(S.watch);
    S.watch = null; S.pos = null;
  }
  async function logout() {
    stopLive(); await sb.auth.signOut(); localStorage.setItem(SKIP_KEY, "1"); S.me = null; showLogin();
  }

  // ------------------------------------------------------------------ เข้าสู่ระบบ
  function showLogin() {
    app.innerHTML = `
    <div class="auth-wrap"><div class="auth-card">
      <div class="logo">🏫</div>
      <h1>${esc(cfg.APP_TITLE)}</h1>
      <div class="sub">${esc(cfg.SCHOOL_NAME)}</div>
      ${S.liffErr ? `<div class="alert alert-warn small">${esc(S.liffErr)}</div>` : ""}
      ${S.liff && !idToken() ? `<div class="alert alert-warn small">ไม่พบข้อมูลบัญชี LINE (ผู้ดูแลระบบควรตรวจว่า LIFF เปิดสิทธิ์ openid แล้ว)</div>` : ""}
      <form id="loginForm" autocomplete="on">
        <label for="nid">เลขบัตรประชาชน 13 หลัก</label>
        <input id="nid" inputmode="numeric" autocomplete="username" placeholder="x-xxxx-xxxxx-xx-x" maxlength="17">
        <label for="pw">รหัสผ่าน</label>
        <div class="pw"><input id="pw" type="password" autocomplete="current-password"><button type="button" id="togglePw">แสดง</button></div>
        <div id="msg"></div>
        <button class="btn btn-primary btn-block mt" id="loginBtn">เข้าสู่ระบบ</button>
      </form>
      <div class="center"><button class="link" id="forgotBtn">ลืมรหัสผ่าน?</button></div>
      <p class="hint center">เข้าครั้งแรก ให้ใช้รหัสผ่านชั่วคราวที่ได้รับจากโรงเรียน</p>
    </div></div>`;
    $("#nid").addEventListener("input", (e) => { e.target.value = formatNid(e.target.value); });
    $("#togglePw").onclick = () => { const i = $("#pw"); const show = i.type === "password"; i.type = show ? "text" : "password"; $("#togglePw").textContent = show ? "ซ่อน" : "แสดง"; };
    $("#forgotBtn").onclick = showForgot;
    $("#loginForm").onsubmit = doLogin;
  }
  async function doLogin(e) {
    e.preventDefault();
    const nid = $("#nid").value.replace(/\D/g, ""), pw = $("#pw").value, msg = $("#msg"), btn = $("#loginBtn");
    msg.innerHTML = "";
    if (nid.length !== 13) { msg.innerHTML = `<div class="alert alert-err">กรอกเลขบัตรประชาชนให้ครบ 13 หลัก</div>`; return; }
    if (!pw) { msg.innerHTML = `<div class="alert alert-err">กรอกรหัสผ่าน</div>`; return; }
    setBusy(btn, true, "กำลังเข้าสู่ระบบ…");
    const r = await callFn("auth", { action: "login", national_id: nid, password: pw, id_token: idToken() });
    if (!r.ok) {
      setBusy(btn, false);
      if (r.code === "LINE_TOKEN_EXPIRED" && S.liff) return relogin();
      msg.innerHTML = `<div class="alert alert-err">${esc(r.error)}</div>`;
      return;
    }
    const { error } = await sb.auth.setSession(r.session);
    if (error) { setBusy(btn, false); msg.innerHTML = `<div class="alert alert-err">เข้าสู่ระบบไม่สำเร็จ: ${esc(error.message)}</div>`; return; }
    localStorage.removeItem(SKIP_KEY);
    const me = await loadMe();
    if (!me.ok) { setBusy(btn, false); msg.innerHTML = `<div class="alert alert-err">${esc(me.error)}</div>`; return; }
    route();
  }

  function showForgot() {
    app.innerHTML = `
    <div class="auth-wrap"><div class="auth-card">
      <div class="logo">🔑</div><h1>ลืมรหัสผ่าน</h1>
      <p class="center muted">กรอกเลขบัตรประชาชน ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมลที่ลงทะเบียนไว้กับโรงเรียน</p>
      <form id="fgForm">
        <label for="nid">เลขบัตรประชาชน 13 หลัก</label>
        <input id="nid" inputmode="numeric" placeholder="x-xxxx-xxxxx-xx-x" maxlength="17">
        <div id="msg"></div>
        <button class="btn btn-primary btn-block mt" id="fgBtn">ส่งลิงก์ไปที่อีเมล</button>
      </form>
      <div class="center"><button class="link" id="backBtn">← กลับไปหน้าเข้าสู่ระบบ</button></div>
      <p class="hint center">ถ้าไม่ได้รับอีเมล ให้ตรวจกล่องจดหมายขยะ หรือติดต่อผู้ดูแลระบบเพื่อรีเซ็ตรหัสให้</p>
    </div></div>`;
    $("#nid").addEventListener("input", (e) => { e.target.value = formatNid(e.target.value); });
    $("#backBtn").onclick = showLogin;
    $("#fgForm").onsubmit = async (e) => {
      e.preventDefault();
      const nid = $("#nid").value.replace(/\D/g, ""), msg = $("#msg"), btn = $("#fgBtn");
      if (nid.length !== 13) { msg.innerHTML = `<div class="alert alert-err">กรอกเลขบัตรประชาชนให้ครบ 13 หลัก</div>`; return; }
      setBusy(btn, true, "กำลังส่ง…");
      const r = await callFn("auth", { action: "forgot", national_id: nid });
      setBusy(btn, false);
      msg.innerHTML = r.ok ? `<div class="alert alert-ok">${esc(r.message)}</div>` : `<div class="alert alert-err">${esc(r.error)}</div>`;
    };
  }

  // ------------------------------------------------------------------ ตั้งรหัสผ่านครั้งแรก + PDPA
  function showSetup() {
    const needPw = !S.me.password_set;
    app.innerHTML = `
    <div class="auth-wrap"><div class="auth-card">
      <div class="logo">👋</div>
      <h1>สวัสดี ${esc(fullName(S.me))}</h1>
      <p class="center muted">${needPw ? "ครั้งแรกที่เข้าระบบ กรุณาตั้งรหัสผ่านของคุณเอง" : "กรุณาอ่านและยอมรับข้อตกลงก่อนใช้งาน"}</p>
      <form id="setupForm">
        ${needPw ? `
        <label for="np">รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)</label>
        <div class="pw"><input id="np" type="password" autocomplete="new-password"><button type="button" id="togglePw">แสดง</button></div>
        <label for="np2">ยืนยันรหัสผ่านใหม่</label>
        <input id="np2" type="password" autocomplete="new-password">` : ""}
        <label>ข้อตกลงการใช้ข้อมูลส่วนบุคคล</label>
        <div class="pdpa-box">
          <b>${esc(cfg.SCHOOL_NAME)}</b> เก็บและใช้ข้อมูลของท่านเพื่อ <b>บันทึกเวลาปฏิบัติงานของครูหน้าเสาธง</b> เท่านั้น
          <ul>
            <li>ข้อมูลที่เก็บ: ชื่อ-สกุล ตำแหน่ง อีเมล บัญชี LINE (รหัสผู้ใช้และชื่อที่แสดง) เวลาเช็กชื่อ และตำแหน่ง GPS ณ ขณะกดเช็กชื่อ</li>
            <li>ระบบไม่ติดตามตำแหน่งของท่านตลอดเวลา อ่านตำแหน่งเฉพาะตอนเปิดหน้าเช็กชื่อและตอนกดเช็กชื่อ</li>
            <li>เลขบัตรประชาชนใช้ยืนยันตัวตนเท่านั้น และถูกเก็บในรูปแบบเข้ารหัส ไม่แสดงเต็มในรายงาน</li>
            <li>ผู้ที่เห็นข้อมูล: ผู้ดูแลระบบและผู้บริหารของโรงเรียน ส่วนครูเห็นเฉพาะข้อมูลของตนเอง</li>
            <li>ท่านมีสิทธิ์ขอเข้าถึง แก้ไข หรือลบข้อมูลของท่าน โดยติดต่อผู้ดูแลระบบของโรงเรียน</li>
          </ul>
        </div>
        <label class="check"><input type="checkbox" id="acc"> <span>ข้าพเจ้าได้อ่านและยอมรับข้อตกลงข้างต้น</span></label>
        <div id="msg"></div>
        <button class="btn btn-primary btn-block" id="setupBtn">${needPw ? "บันทึกและเริ่มใช้งาน" : "ยอมรับและเริ่มใช้งาน"}</button>
      </form>
    </div></div>`;
    if (needPw) $("#togglePw").onclick = () => { const i = $("#np"); const show = i.type === "password"; i.type = show ? "text" : "password"; $("#togglePw").textContent = show ? "ซ่อน" : "แสดง"; };
    $("#setupForm").onsubmit = async (e) => {
      e.preventDefault();
      const msg = $("#msg"), btn = $("#setupBtn"); msg.innerHTML = "";
      const err = (t) => { msg.innerHTML = `<div class="alert alert-err">${esc(t)}</div>`; };
      if (!$("#acc").checked) return err("กรุณาติ๊กยอมรับข้อตกลงก่อน");
      let r;
      if (needPw) {
        const np = $("#np").value;
        if (np.length < 8) return err("รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร");
        if (np !== $("#np2").value) return err("รหัสผ่านทั้งสองช่องไม่ตรงกัน");
        setBusy(btn, true, "กำลังบันทึก…");
        r = await authed("teacher", { action: "change_password", new_password: np, accept_pdpa: true });
      } else {
        setBusy(btn, true, "กำลังบันทึก…");
        r = await authed("teacher", { action: "accept_pdpa", accept: true });
      }
      if (!r.ok) { setBusy(btn, false); return err(r.error); }
      await loadMe();
      toast("ตั้งค่าเรียบร้อย");
      route();
    };
  }

  // ------------------------------------------------------------------ โครงหน้า
  function shell(inner) {
    const tabs = [["home", "🏠", "เช็กชื่อ"], ["history", "📅", "ประวัติ"], ["report", "📝", "แจ้งสถานะ"], ["me", "👤", "โปรไฟล์"]];
    app.innerHTML = `
      <header class="topbar"><div class="brand">${esc(cfg.APP_TITLE)}</div><div class="who">${esc(fullName(S.me))}</div></header>
      <main class="content">${inner}</main>
      <nav class="tabbar">${tabs.map(([k, ic, l]) => `<button data-tab="${k}" class="${S.tab === k ? "on" : ""}"><span class="ic">${ic}</span>${l}</button>`).join("")}</nav>`;
    $$(".tabbar button", app).forEach((b) => (b.onclick = () => go(b.dataset.tab)));
  }
  const chip = (st) => `<span class="chip ${STATUS[st].cls}">${STATUS[st].label}</span>`;
  const alertBox = (cls, t) => `<div class="alert alert-${cls}">${esc(t)}</div>`;

  // ------------------------------------------------------------------ GPS
  function distanceM(lat1, lng1, lat2, lng2) {
    const R = 6371000, rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function geoErrMsg(e) {
    if (e && e.code === 1) return "ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง — กรุณาเปิดสิทธิ์ตำแหน่งให้แอป LINE (iPhone: ตั้งค่า > LINE > ตำแหน่ง | Android: ตั้งค่า > แอป > LINE > สิทธิ์ > ตำแหน่ง) แล้วเปิดหน้านี้ใหม่";
    if (e && e.code === 3) return "หาตำแหน่งไม่ทันเวลา ลองเดินไปที่โล่งแจ้งแล้วกดใหม่";
    return "อ่านตำแหน่ง GPS ไม่ได้ กรุณาเปิดบริการตำแหน่งในโทรศัพท์แล้วลองใหม่";
  }
  function setGps(kind, text) {
    const box = $("#gps"); if (!box) return;
    box.className = "gps " + kind; $("#gpsText").innerHTML = text;
  }
  function updateGps() {
    const set = S.st.settings;
    if (set.lat == null) return setGps("bad", "ผู้ดูแลระบบยังไม่ได้ตั้งจุดเสาธง");
    if (!S.pos) return setGps("wait", "กำลังหาตำแหน่ง…");
    const { latitude, longitude, accuracy } = S.pos.coords;
    const d = Math.round(distanceM(latitude, longitude, set.lat, set.lng));
    if (accuracy > set.max_accuracy_m) return setGps("wait", `สัญญาณ GPS ยังไม่แม่น (คลาดเคลื่อน ±${Math.round(accuracy)} ม.) รอสักครู่…`);
    if (d <= set.radius_m) return setGps("good", `<b>อยู่ในพื้นที่เสาธง</b><br><span class="small">ห่างจุดเสาธงประมาณ ${d} ม. (±${Math.round(accuracy)} ม.)</span>`);
    setGps("bad", `<b>อยู่นอกพื้นที่เสาธง</b><br><span class="small">ห่างประมาณ ${d} ม. (ต้องไม่เกิน ${set.radius_m} ม.)</span>`);
  }
  function startGps() {
    if (!navigator.geolocation) return setGps("bad", "อุปกรณ์นี้ไม่รองรับ GPS");
    setGps("wait", "กำลังหาตำแหน่ง…");
    S.watch = navigator.geolocation.watchPosition(
      (p) => { S.pos = p; updateGps(); },
      (e) => { S.pos = null; setGps("bad", esc(geoErrMsg(e))); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 25000 });
  }
  const getFreshPosition = () => new Promise((res, rej) => navigator.geolocation
    ? navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 })
    : rej({ code: 2 }));

  // ------------------------------------------------------------------ หน้าหลัก / เช็กชื่อ
  function renderHome() {
    const st = S.st, set = st.settings, rec = st.record, me = S.me;
    const done = rec && (rec.status === "present" || rec.status === "late");
    const leaveRec = rec && !done && !(rec.source === "teacher" && rec.status === "note");
    const blocked = st.holiday ? `วันนี้เป็นวันหยุด (${st.holiday})` : !st.is_workday ? "วันนี้ไม่ใช่วันทำการ" : "";
    const needBind = set.require_line && !me.line_bound;

    let today;
    if (rec) {
      today = `<div class="today-box">${chip(rec.status)}
        ${rec.checkin_at ? `<div class="big-time">เวลา ${fmtTime(rec.checkin_at)} น.${rec.distance_m != null ? ` · ห่างเสาธง ${Math.round(rec.distance_m)} ม.` : ""}</div>` : ""}
        ${rec.source !== "gps" ? `<div class="small muted">${rec.source === "teacher" ? "ครูแจ้งเอง" : "ผู้ดูแลระบบบันทึกให้"}</div>` : ""}
        ${rec.note ? `<div class="small mt">หมายเหตุ: ${esc(rec.note)}</div>` : ""}</div>`;
    } else {
      today = `<div class="today-box"><span class="chip s-off">ยังไม่ได้เช็กชื่อ</span></div>`;
    }

    const canCheckin = !done && !blocked && !leaveRec;
    shell(`
      <div class="card hero">
        <div class="date">${thaiDate(st.today, { weekday: true })}</div>
        <div class="clock" id="clock">--:--:--</div>
        <div class="rule">เข้าแถว ${set.open_time}–${set.ontime_until} น. · สายหลัง ${set.ontime_until} น.</div>
      </div>
      ${blocked ? alertBox("info", blocked + " — ไม่ต้องเช็กชื่อ") : ""}
      ${needBind ? `<div class="alert alert-warn">บัญชีนี้ยังไม่ได้ผูกกับ LINE จึงยังเช็กชื่อไม่ได้
        ${S.liff && idToken() ? `<div class="mt"><button class="btn btn-sm btn-primary" id="bindBtn">ผูกบัญชี LINE นี้เข้ากับระบบ</button></div>` : `<div class="small">กรุณาเปิดระบบผ่านแอป LINE แล้วเข้าสู่ระบบอีกครั้ง</div>`}</div>` : ""}
      <div class="card">
        <h3>สถานะวันนี้</h3>${today}
        ${leaveRec ? alertBox("info", `วันนี้มีสถานะ "${STATUS[rec.status].label}" อยู่แล้ว หากต้องการแก้ไขให้ติดต่อผู้ดูแลระบบ`) : ""}
        ${canCheckin ? `
          <div class="gps wait" id="gps"><span class="dot"></span><div id="gpsText">กำลังหาตำแหน่ง…</div></div>
          <button class="checkin-btn" id="checkinBtn" ${needBind ? "disabled" : ""}>✋ เช็กชื่อ</button>
          <div id="ciMsg"></div>
          <div class="center"><button class="link small" id="gpsRetry">ลองหาตำแหน่งใหม่</button></div>` : ""}
        ${done ? `<div class="alert alert-ok center">เช็กชื่อเรียบร้อยแล้ว ขอบคุณครับ/ค่ะ</div>` : ""}
      </div>
      ${rec ? `<div class="card"><h3>หมายเหตุของวันนี้</h3>
        <textarea id="noteBox" maxlength="300" placeholder="พิมพ์หมายเหตุ เช่น มาสายเพราะ…">${esc(rec.note || "")}</textarea>
        <div id="noteMsg"></div><button class="btn btn-sm mt" id="noteBtn">บันทึกหมายเหตุ</button></div>` : ""}
      ${!rec && !blocked ? `<div class="center small muted">ลา / ไปราชการ / มีเหตุจำเป็น? <button class="link small" id="toReport">แจ้งสถานะ</button></div>` : ""}`);

    const tick = () => { const c = $("#clock"); if (c) c.textContent = bkkParts(serverNow()).time; };
    tick(); S.timers.push(setInterval(tick, 1000));
    const bind = $("#bindBtn");
    if (bind) bind.onclick = async () => {
      setBusy(bind, true, "กำลังผูก…");
      const r = await authed("teacher", { action: "bind_line", id_token: idToken() });
      if (!r.ok) { setBusy(bind, false); return toast(r.error, "err"); }
      await loadMe(); toast("ผูกบัญชี LINE แล้ว"); renderHome();
    };
    const tr = $("#toReport"); if (tr) tr.onclick = () => go("report");
    if (rec) $("#noteBtn").onclick = saveNote;
    if (canCheckin) {
      if (set.lat != null) startGps(); else updateGps();
      $("#checkinBtn").onclick = doCheckin;
      $("#gpsRetry").onclick = () => { if (S.watch !== null) navigator.geolocation.clearWatch(S.watch); S.watch = null; S.pos = null; startGps(); };
    }
  }
  async function saveNote() {
    const btn = $("#noteBtn"), msg = $("#noteMsg");
    setBusy(btn, true, "กำลังบันทึก…");
    const r = await authed("teacher", { action: "add_note", date: S.st.today, note: $("#noteBox").value });
    setBusy(btn, false);
    if (!r.ok) { msg.innerHTML = alertBox("err", r.error); return; }
    await loadMe(); toast("บันทึกหมายเหตุแล้ว"); renderHome();
  }
  async function doCheckin() {
    const btn = $("#checkinBtn"), msg = $("#ciMsg");
    msg.innerHTML = ""; setBusy(btn, true, "กำลังเช็กชื่อ…");
    let p;
    try { p = await getFreshPosition(); } catch (e) { setBusy(btn, false); msg.innerHTML = alertBox("err", geoErrMsg(e)); return; }
    const r = await authed("teacher", { action: "checkin", lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, id_token: idToken() });
    if (r.ok) { await loadMe(); toast(r.already ? "คุณเช็กชื่อไว้แล้ว" : "เช็กชื่อสำเร็จ"); return renderHome(); }
    setBusy(btn, false);
    if (r.code === "LINE_TOKEN_EXPIRED" && S.liff) return relogin();
    if (r.code === "UNAUTHORIZED") return logout();
    msg.innerHTML = alertBox("err", r.error);
  }

  // ------------------------------------------------------------------ ประวัติ
  async function renderHistory() {
    const now = App.ymd(S.st.today);
    if (!S.hist) S.hist = { y: now.y, m: now.m };
    const { y, m } = S.hist;
    shell(`<div class="card">
      <div class="monthnav"><button class="btn btn-sm" id="hPrev">◀</button><b>${thaiMonthYear(y, m)}</b><button class="btn btn-sm" id="hNext">▶</button></div>
      <div id="hBody" class="muted center">กำลังโหลด…</div></div>`);
    const shift = (n) => { let mm = S.hist.m + n, yy = S.hist.y; if (mm < 1) { mm = 12; yy--; } if (mm > 12) { mm = 1; yy++; } S.hist = { y: yy, m: mm }; renderHistory(); };
    $("#hPrev").onclick = () => shift(-1); $("#hNext").onclick = () => shift(1);

    const { from, to } = monthRange(y, m);
    const [a, h] = await Promise.all([
      sb.from("attendance").select("date,status,checkin_at,note,source").eq("teacher_id", S.me.id).gte("date", from).lte("date", to),
      sb.from("holidays").select("date,name").gte("date", from).lte("date", to),
    ]);
    const body = $("#hBody"); if (!body || S.tab !== "history") return;
    if (a.error || h.error) { body.innerHTML = alertBox("err", "โหลดข้อมูลไม่สำเร็จ: " + (a.error || h.error).message); return; }
    const recs = new Map(a.data.map((r) => [r.date, r])), hols = new Map(h.data.map((r) => [r.date, r.name]));
    const set = S.st.settings, today = S.st.today;
    const afterClose = bkkParts(serverNow()).time.slice(0, 5) > set.close_time;
    const start = S.me.start_date || "0000-00-00", end = S.me.end_date || "9999-12-31";
    const counts = {}; let none = 0; const rows = [];
    for (const d of datesBetween(from, to).reverse()) {
      const r = recs.get(d), off = hols.has(d) || !set.work_days.includes(isoDow(d));
      const label = `${TH_DAYS_SHORT[dowOf(d)]} ${App.ymd(d).d} ${TH_MONTHS_SHORT[m - 1]}`;
      if (r) {
        counts[r.status] = (counts[r.status] || 0) + 1;
        rows.push(`<div class="list-row"><div class="l"><div class="d">${label}</div>${r.note ? `<div class="n">${esc(r.note)}</div>` : ""}</div><div class="right">${chip(r.status)}${r.checkin_at ? `<div class="n">${fmtTime(r.checkin_at)} น.</div>` : ""}</div></div>`);
      } else if (off) {
        rows.push(`<div class="list-row off"><div class="l"><div class="d">${label}</div><div class="n">${esc(hols.get(d) || "วันหยุด")}</div></div></div>`);
      } else if (d >= start && d <= end && (d < today || (d === today && afterClose))) {
        none++; rows.push(`<div class="list-row none"><div class="l"><div class="d">${label}</div></div><span class="chip s-none">ไม่ได้เช็กชื่อ</span></div>`);
      } else if (d === today && d >= start) {
        rows.push(`<div class="list-row"><div class="l"><div class="d">${label}</div></div><span class="chip s-off">ยังไม่เช็ก</span></div>`);
      }
    }
    const sum = Object.keys(STATUS).filter((k) => counts[k]).map((k) => `<span class="chip ${STATUS[k].cls}">${STATUS[k].label} ${counts[k]}</span>`).join("")
      + (none ? `<span class="chip s-none">ไม่ได้เช็ก ${none}</span>` : "");
    body.className = "";
    body.innerHTML = `<div class="sum">${sum || '<span class="muted small">ยังไม่มีข้อมูลในเดือนนี้</span>'}</div>${rows.join("")}`;
  }

  // ------------------------------------------------------------------ แจ้งสถานะ
  async function renderReport() {
    const today = S.st.today;
    shell(`
      <div class="card"><h2>แจ้งสถานะ</h2>
        <p class="muted small">แจ้งล่วงหน้าหรือแจ้งในวันนั้นได้ (ย้อนหลังต้องติดต่อผู้ดูแลระบบ) ระบบข้ามวันหยุดและวันเสาร์-อาทิตย์ให้อัตโนมัติ</p>
        <form id="rpForm">
          <label for="rpStatus">สถานะ</label>
          <select id="rpStatus">
            ${["personal", "sick", "official", "maternity", "note"].map((k) => `<option value="${k}">${STATUS[k].label}${k === "note" ? " (พิมพ์ข้อความแจ้ง)" : ""}</option>`).join("")}
          </select>
          <div class="row2">
            <div><label for="rpFrom">ตั้งแต่วันที่</label><input type="date" id="rpFrom" min="${today}" value="${today}"></div>
            <div><label for="rpTo">ถึงวันที่ <span class="muted small">(ถ้าหลายวัน)</span></label><input type="date" id="rpTo" min="${today}"></div>
          </div>
          <label for="rpNote" id="rpNoteLabel">หมายเหตุ (ไม่บังคับ)</label>
          <textarea id="rpNote" maxlength="300" placeholder="เช่น ไปอบรมที่…, ติดธุระที่…"></textarea>
          <div id="rpMsg"></div>
          <button class="btn btn-primary btn-block mt" id="rpBtn">ส่งแจ้ง</button>
        </form>
      </div>
      <div class="card"><h3>รายการที่แจ้งไว้ (วันนี้และล่วงหน้า)</h3><div id="rpList" class="muted">กำลังโหลด…</div></div>`);
    const upd = () => { const isNote = $("#rpStatus").value === "note"; $("#rpNoteLabel").textContent = isNote ? "ข้อความที่ต้องการแจ้ง (จำเป็น)" : "หมายเหตุ (ไม่บังคับ)"; };
    $("#rpStatus").onchange = upd; upd();
    $("#rpFrom").onchange = () => { $("#rpTo").min = $("#rpFrom").value; };
    $("#rpForm").onsubmit = async (e) => {
      e.preventDefault();
      const msg = $("#rpMsg"), btn = $("#rpBtn");
      setBusy(btn, true, "กำลังส่ง…");
      const r = await authed("teacher", { action: "report_status", status: $("#rpStatus").value, date_from: $("#rpFrom").value, date_to: $("#rpTo").value || null, note: $("#rpNote").value });
      setBusy(btn, false);
      if (!r.ok) { msg.innerHTML = alertBox("err", r.error); return; }
      let t = `บันทึกแล้ว ${r.saved} วัน`;
      if (r.skipped && r.skipped.length) t += ` · ข้าม ${r.skipped.length} วัน: ` + r.skipped.map((s) => `${thaiDate(s.date, { short: true })} (${s.reason})`).join(", ");
      msg.innerHTML = alertBox(r.saved ? "ok" : "warn", t);
      await loadMe(); loadPending();
    };
    loadPending();
  }
  async function loadPending() {
    const box = $("#rpList"); if (!box) return;
    const { data, error } = await sb.from("attendance").select("date,status,note").eq("teacher_id", S.me.id).eq("source", "teacher").gte("date", S.st.today).order("date").limit(400);
    if (error) { box.innerHTML = alertBox("err", error.message); return; }
    if (!data.length) { box.innerHTML = `<span class="muted small">ไม่มีรายการ</span>`; return; }
    const groups = [];
    for (const r of data) {
      const g = groups[groups.length - 1];
      if (g && g.status === r.status && g.note === r.note && (new Date(r.date) - new Date(g.to)) / 86400000 <= 4) { g.to = r.date; g.n++; }
      else groups.push({ status: r.status, note: r.note, from: r.date, to: r.date, n: 1 });
    }
    box.className = "";
    box.innerHTML = groups.map((g, i) => `
      <div class="list-row"><div class="l"><div class="d">${chip(g.status)} ${thaiDate(g.from, { short: true })}${g.to !== g.from ? " – " + thaiDate(g.to, { short: true }) : ""} <span class="muted small">(${g.n} วัน)</span></div>
      ${g.note ? `<div class="n">${esc(g.note)}</div>` : ""}</div>
      <button class="btn btn-sm btn-danger" data-i="${i}">ยกเลิก</button></div>`).join("");
    $$("#rpList button[data-i]").forEach((b) => (b.onclick = async () => {
      const g = groups[+b.dataset.i];
      if (!confirm(`ยกเลิกการแจ้ง${STATUS[g.status].label} ${g.n} วัน ใช่หรือไม่?`)) return;
      setBusy(b, true);
      const r = await authed("teacher", { action: "cancel_status", date_from: g.from, date_to: g.to });
      if (!r.ok) { setBusy(b, false); return toast(r.error, "err"); }
      toast("ยกเลิกแล้ว"); await loadMe(); loadPending();
    }));
  }

  // ------------------------------------------------------------------ โปรไฟล์
  function renderProfile() {
    const me = S.me;
    shell(`
      <div class="card"><h2>ข้อมูลของฉัน</h2>
        <dl class="kv">
          <dt>ชื่อ-สกุล</dt><dd>${esc(fullName(me))}</dd>
          <dt>ตำแหน่ง</dt><dd>${esc(me.job_title || "-")}</dd>
          <dt>กลุ่มสาระ/ฝ่าย</dt><dd>${esc(me.department || "-")}</dd>
          <dt>เลขบัตร</dt><dd>${esc(me.national_id_masked)}</dd>
          <dt>อีเมล</dt><dd>${esc(me.email)}</dd>
          <dt>บัญชี LINE</dt><dd>${me.line_bound ? `<span class="tag tag-ok">ผูกแล้ว</span> ${esc(me.line_display_name || "")}` : `<span class="tag tag-warn">ยังไม่ผูก</span>`}</dd>
        </dl>
        <p class="hint">ต้องการแก้ไขข้อมูลหรือเปลี่ยนโทรศัพท์/บัญชี LINE ให้ติดต่อผู้ดูแลระบบ</p>
      </div>
      <div class="card"><h2>เปลี่ยนรหัสผ่าน</h2>
        <form id="pwForm">
          <label for="cp">รหัสผ่านปัจจุบัน</label><input id="cp" type="password" autocomplete="current-password">
          <label for="np">รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)</label><input id="np" type="password" autocomplete="new-password">
          <label for="np2">ยืนยันรหัสผ่านใหม่</label><input id="np2" type="password" autocomplete="new-password">
          <div id="pwMsg"></div>
          <button class="btn btn-primary btn-block mt" id="pwBtn">เปลี่ยนรหัสผ่าน</button>
        </form>
      </div>
      <div class="card"><button class="btn btn-block" id="logoutBtn">ออกจากระบบ</button>
        <p class="hint center">ปกติไม่ต้องออกจากระบบ ระบบจะจำบัญชี LINE ของคุณไว้</p></div>`);
    $("#logoutBtn").onclick = logout;
    $("#pwForm").onsubmit = async (e) => {
      e.preventDefault();
      const msg = $("#pwMsg"), btn = $("#pwBtn"), np = $("#np").value;
      if (np.length < 8) { msg.innerHTML = alertBox("err", "รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร"); return; }
      if (np !== $("#np2").value) { msg.innerHTML = alertBox("err", "รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน"); return; }
      setBusy(btn, true, "กำลังบันทึก…");
      const r = await authed("teacher", { action: "change_password", current_password: $("#cp").value, new_password: np });
      setBusy(btn, false);
      if (!r.ok) { msg.innerHTML = alertBox("err", r.error); return; }
      msg.innerHTML = ""; e.target.reset(); toast("เปลี่ยนรหัสผ่านแล้ว");
    };
  }

  boot();
})();
