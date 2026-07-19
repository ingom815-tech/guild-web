// 내 정보 화면 (전 회원): 기본정보/장비/아퀴/인증샷/내 분배이력 셀프 관리 + 쟁지원조(데이/나이트).
// UI는 내정보탭_개선시안_v3.html 명세를 따른다 — 아퀴 3단 순환 칩, 장비 등급색 셀렉트+라이브 미리보기, 인증샷 드롭존.
// 저장 로직(Edge Function 호출/DB 값 체계)은 원본 그대로 — 분배 기간 진행 중에는 수정 잠금.
const Profile = (() => {
  let data = null; // GET /profile 응답
  let activeTab = "info";
  let aquiState = {}; // {아퀴id: ""|"l"|"m"} — 칩 UI 현재 상태
  let aquiOrig = {}; // 로드 시점 상태 (변경사항 건수 계산용)
  let pendingFiles = { power: [], aqui: [] }; // 드롭존에서 고른 업로드 대기 파일

  const SHIFT_LABEL = { day: "데이조", night: "나이트조" };
  const PANES = { info: "profilePaneInfo", equip: "profilePaneEquip", aqui: "profilePaneAqui", imgs: "profilePaneImgs", history: "profilePaneHistory" };
  const GRADE_CLS = { 절대자: "abs", 신화: "myth", 전설: "leg", 영웅: "hero" }; // 희귀 = 기본
  const SECT = { A: { key: "pvp", label: "PVP" }, B: { key: "sup", label: "지원" }, C: { key: "pve", label: "PVE" } };

  function toast(msg, isErr) {
    const t = document.getElementById("profileToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 5000);
  }

  async function load() {
    try {
      data = await Api.getProfile();
    } catch (e) {
      toast(e.message || "내 정보 조회 실패", true);
      return;
    }
    pendingFiles = { power: [], aqui: [] };
    render();
  }

  function setTab(el) {
    document.querySelectorAll(".stab[data-pi]").forEach((c) => c.classList.remove("on"));
    el.classList.add("on");
    activeTab = el.dataset.pi;
    for (const [key, id] of Object.entries(PANES)) {
      document.getElementById(id).classList.toggle("hidden", key !== activeTab);
    }
  }

  // 요약 카드의 참여조 배지 → 기본정보 탭의 참여조 카드로 이동
  function goShift() {
    setTab(document.querySelector('.stab[data-pi="info"]'));
    const card = document.getElementById("shiftCard");
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.style.transition = "box-shadow .3s";
    card.style.boxShadow = "0 0 0 3px rgba(29,158,117,.35)";
    setTimeout(() => (card.style.boxShadow = ""), 1600);
  }

  function render() {
    renderSummary();
    document.getElementById("profileLockBanner").classList.toggle("hidden", !data.locked);

    renderInfoPane();
    renderEquipPane();
    renderAquiPane();
    renderImgsPane();
    renderHistoryPane();
    renderShift();
    applyLock();
  }

  function applyLock() {
    const locked = !!data.locked;
    ["profilePaneInfo", "profilePaneEquip", "profilePaneAqui", "profilePaneImgs"].forEach((paneId) => {
      const pane = document.getElementById(paneId);
      pane.classList.toggle("locked", locked); // 아퀴 칩·드롭존 클릭 차단은 CSS + 핸들러 가드
      pane.querySelectorAll("input, select, button").forEach((el) => {
        el.disabled = locked;
      });
    });
  }

  // ── 프로필 요약 카드 ──
  function renderSummary() {
    const cls = data.info.class || "";
    const nick = data.user.current_id || data.user.user_id;
    setAvatar(cls, nick);
    document.getElementById("pfSumName").textContent = nick;
    const roleEl = document.getElementById("pfSumRole");
    roleEl.className = "role-badge " + data.user.role;
    roleEl.textContent = data.user.role;
    const shiftEl = document.getElementById("pfSumShift");
    shiftEl.textContent = data.preferred_shift ? SHIFT_LABEL[data.preferred_shift] : "쟁지원조 미선택";
    shiftEl.classList.toggle("none", !data.preferred_shift);
    shiftEl.title = "클릭하면 쟁지원조 변경으로 이동합니다";
    document.getElementById("pfSumSub").textContent = `${cls || "직업 미선택"} · ${data.user.user_id} · 시즌 ${data.season}`;
    document.getElementById("pfStatContrib").textContent = (data.info.contribution_score || 0).toLocaleString();
    document.getElementById("pfStatPart").textContent = (data.info.participation_score || 0).toLocaleString();
    document.getElementById("pfStatPower").textContent = (data.info.power || 0).toLocaleString();
  }

  // 직업 엠블럼 아바타 — SVG 로드 성공 시 금색 마스크 엠블럼, 실패·직업 미선택 시 첫 글자 fallback
  function setAvatar(cls, nick) {
    const avatar = document.getElementById("pfAvatar");
    avatar.textContent = (cls || nick || "?")[0];
    avatar.classList.remove("emblem-mode");
    const file = GameData.CLASS_ICONS[cls];
    if (!file) return;
    const url = `img/classes/${file}.svg`;
    const probe = new Image();
    probe.onload = () => {
      avatar.classList.add("emblem-mode");
      avatar.innerHTML = "";
      const i = document.createElement("i");
      i.className = "cls-emblem";
      i.style.webkitMaskImage = `url('${url}')`;
      i.style.maskImage = `url('${url}')`;
      avatar.appendChild(i);
    };
    probe.src = url;
  }

  // ── 기본정보 ──
  function renderInfoPane() {
    const clsSel = document.getElementById("pfClass");
    if (!clsSel.options.length) {
      clsSel.innerHTML =
        `<option value="">선택 안 함</option>` +
        GameData.CLASS_OPTIONS.map((c) => `<option value="${c}">${c}</option>`).join("");
    }
    document.getElementById("pfNick").value = data.info.current_id || "";
    document.getElementById("pfGuild").value = data.info.guild_name || "";
    document.getElementById("pfRank").value = data.info.subjugation_rank || "";
    clsSel.value = GameData.CLASS_OPTIONS.includes(data.info.class) ? data.info.class : "";
    document.getElementById("pfLevel").value = data.info.level ?? 0;
    document.getElementById("pfAbyss").value = data.info.abyss_level || "";
    document.getElementById("pfPower").value = data.info.power ?? 0;
    document.getElementById("pfNewPw").value = "";
  }

  // ── 장비: 등급색 셀렉트 + 라이브 미리보기 ──
  function equipGradeClass(grade) {
    return GRADE_CLS[grade] ? "g-" + GRADE_CLS[grade] : "";
  }

  function renderEquipPane() {
    const grid = document.getElementById("pfEquipGrid");
    const preview = document.getElementById("pfEquipPreview");
    grid.innerHTML = "";
    preview.innerHTML = "";
    const equip = GameData.parseEquipment(data.equipment_info);

    GameData.EQUIPMENT_SLOTS.forEach((slot, idx) => {
      const cur = GameData.EQUIPMENT_GRADES.includes(equip[slot]) ? equip[slot] : "희귀";

      const field = document.createElement("div");
      field.className = "gf";
      const label = document.createElement("label");
      label.textContent = slot;
      const sel = document.createElement("select");
      sel.dataset.slot = slot;
      sel.innerHTML = GameData.EQUIPMENT_GRADES.map((g) => `<option value="${g}">${g}</option>`).join("");
      sel.value = cur;
      sel.className = equipGradeClass(cur);
      sel.addEventListener("change", () => {
        sel.className = equipGradeClass(sel.value);
        const ps = preview.children[idx];
        ps.className = "pslot " + (GRADE_CLS[sel.value] || "");
        ps.querySelector(".p2").textContent = sel.value;
      });
      field.appendChild(label);
      field.appendChild(sel);
      grid.appendChild(field);

      const ps = document.createElement("div");
      ps.className = "pslot " + (GRADE_CLS[cur] || "");
      ps.innerHTML = `<span class="p1"></span><span class="p2"></span>`;
      ps.querySelector(".p1").textContent = slot;
      ps.querySelector(".p2").textContent = cur;
      preview.appendChild(ps);
    });
  }

  // ── 아퀴: 3단 순환 칩 (미보유 → 전설 → 신화 → 미보유, 신화 불가 룬은 전설 → 미보유) ──
  function renderAquiPane() {
    const wrap = document.getElementById("pfAquiEdit");
    wrap.innerHTML = "";
    const cls = data.info.class || "";
    const owned = GameData.parseAqui(data.status_check, cls);
    if (!cls) wrap.appendChild(GameData.aquiClassNoticeEl());

    aquiState = {};
    for (const group of ["A", "B", "C"]) {
      GameData.AQUI_ITEMS[group].forEach((item) => {
        let cur = owned[item.id] || "";
        if (cur === "m" && !GameData.canBeMythic(item, cls)) cur = "l"; // 원본과 동일한 레거시 보정
        if (cur) aquiState[item.id] = cur;
      });
    }
    aquiOrig = { ...aquiState };

    for (const group of ["A", "B", "C"]) {
      const s = SECT[group];
      const sect = document.createElement("div");
      sect.className = "sect";
      sect.innerHTML = `<div class="sh-head"><span class="t ${s.key}">${s.label}</span><span class="cnt" id="pfAquiCnt-${s.key}"></span></div><div class="chipbox"></div>`;
      const box = sect.querySelector(".chipbox");

      GameData.AQUI_ITEMS[group].forEach((item) => {
        const chip = document.createElement("span");
        chip.className = "rchip";
        chip.dataset.aquiId = item.id;
        chip.dataset.sec = s.key;
        chip.textContent = GameData.aquiName(item, cls) || item.id;
        chip.title = item.id;
        applyChipLevel(chip, aquiState[item.id] || "");
        chip.addEventListener("click", () => {
          if (data.locked) return;
          const cur = aquiState[item.id] || "";
          let next;
          if (cur === "") next = "l";
          else if (cur === "l") next = GameData.canBeMythic(item, cls) ? "m" : "";
          else next = "";
          if (next) aquiState[item.id] = next;
          else delete aquiState[item.id];
          applyChipLevel(chip, next);
          updateAquiCounters();
        });
        box.appendChild(chip);
      });
      wrap.appendChild(sect);
    }
    updateAquiCounters();
  }

  function applyChipLevel(chip, level) {
    chip.classList.toggle("lv-leg", level === "l");
    chip.classList.toggle("lv-myth", level === "m");
  }

  function updateAquiCounters() {
    ["pvp", "sup", "pve"].forEach((key) => {
      const leg = document.querySelectorAll(`#pfAquiEdit .rchip[data-sec="${key}"].lv-leg`).length;
      const myth = document.querySelectorAll(`#pfAquiEdit .rchip[data-sec="${key}"].lv-myth`).length;
      const el = document.getElementById(`pfAquiCnt-${key}`);
      if (el) el.textContent = `전설 ${leg} · 신화 ${myth}`;
    });
    const ids = new Set([...Object.keys(aquiState), ...Object.keys(aquiOrig)]);
    let changed = 0;
    ids.forEach((id) => {
      if ((aquiState[id] || "") !== (aquiOrig[id] || "")) changed++;
    });
    document.getElementById("pfAquiHint").textContent = `변경사항 ${changed}건${changed ? " — 저장 전까지 반영되지 않습니다" : ""}`;
  }

  // ── 인증샷: 기존 갤러리 + 드롭존 + 업로드 대기 썸네일 ──
  function renderGallery(containerId, urls) {
    const box = document.getElementById(containerId);
    box.innerHTML = "";
    if (!urls.length) {
      const s = document.createElement("span");
      s.className = "meta";
      s.textContent = "등록된 스샷이 없습니다.";
      box.appendChild(s);
      return;
    }
    urls.forEach((src) => {
      const a = document.createElement("a");
      a.href = src;
      a.target = "_blank";
      const img = document.createElement("img");
      img.src = src;
      img.style.cssText = "width:90px;height:90px;object-fit:cover;border-radius:8px;border:1px solid var(--line)";
      a.appendChild(img);
      box.appendChild(a);
    });
  }

  function renderImgsPane() {
    renderGallery("pfPowerGallery", data.power_imgs || []);
    renderGallery("pfAquiGallery", data.aqui_imgs || []);
    document.getElementById("pfPowerImg").value = "";
    document.getElementById("pfAquiImg").value = "";
    renderPending("power");
    renderPending("aqui");
  }

  const PENDING_UI = {
    power: { thumbs: "pfPowerPending", bar: "pfPowerSaveBar", max: 1 },
    aqui: { thumbs: "pfAquiPending", bar: "pfAquiSaveBar", max: 10 },
  };

  function addPending(kind, fileList) {
    if (data && data.locked) {
      toast("분배 기간 진행 중에는 수정할 수 없습니다.", true);
      return;
    }
    const imgs = [...fileList].filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    const max = PENDING_UI[kind].max;
    pendingFiles[kind] = kind === "power" ? imgs.slice(0, 1) : [...pendingFiles.aqui, ...imgs].slice(0, max);
    renderPending(kind);
  }

  function renderPending(kind) {
    const ui = PENDING_UI[kind];
    const box = document.getElementById(ui.thumbs);
    box.querySelectorAll(".thumb").forEach((el) => {
      const img = el.querySelector("img");
      if (img && img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
    });
    box.innerHTML = "";
    const files = pendingFiles[kind];
    files.forEach((f, i) => {
      const t = document.createElement("div");
      t.className = "thumb";
      const img = document.createElement("img");
      img.src = URL.createObjectURL(f);
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = "✕";
      x.title = "선택 취소";
      x.addEventListener("click", () => {
        pendingFiles[kind].splice(i, 1);
        renderPending(kind);
      });
      t.appendChild(img);
      t.appendChild(x);
      box.appendChild(t);
    });
    const bar = document.getElementById(ui.bar);
    bar.classList.toggle("hidden", !files.length);
    if (files.length) {
      bar.querySelector(".hint").textContent = `${files.length}장 선택됨 — 업로드하면 기존 스샷이 교체됩니다`;
    }
  }

  function wireDropzone(kind, dropId, inputId) {
    const drop = document.getElementById(dropId);
    const input = document.getElementById(inputId);
    drop.addEventListener("click", () => {
      if (data && data.locked) return;
      input.click();
    });
    input.addEventListener("change", () => {
      addPending(kind, input.files);
      input.value = "";
    });
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      addPending(kind, e.dataTransfer.files);
    });
  }

  async function uploadImgs(kind) {
    const files = pendingFiles[kind];
    if (!files.length) {
      toast("파일을 먼저 선택해주세요.", true);
      return;
    }
    try {
      const images = await ImageUtil.filesToDataUrls(files, PENDING_UI[kind].max);
      const res = await Api.uploadProfileImages(kind, images);
      toast(`✓ 스샷 ${res.urls.length}장 업로드 완료 (기존 스샷 교체됨)`);
      await load();
    } catch (err) {
      toast(err.message || "업로드 실패", true);
    }
  }

  // ── 내 분배 이력 ──
  function renderHistoryPane() {
    const listEl = document.getElementById("pfHistoryList");
    document.querySelectorAll("#pfHistoryList .irow[data-id]").forEach((el) => el.remove());
    const rows = data.my_history || [];
    document.getElementById("pfHistoryEmpty").style.display = rows.length ? "none" : "block";
    const GRADE_BADGE = { 신화: "b-myth", 전설: "b-legend", 영웅: "b-hero", 희귀: "b-rare" };
    rows.forEach((h) => {
      const row = document.createElement("div");
      row.className = "irow two"; // 데스크톱 불변(display:contents), 모바일 2단 행
      row.dataset.id = h.id;
      row.innerHTML = `
        <div class="r1">
          <span style="width:56px">${h.grade ? `<span class="badge ${GRADE_BADGE[h.grade] || "b-gray"}">${h.grade}</span>` : ""}</span>
          <span class="nm"></span>
        </div>
        <div class="r2">
          <span class="meta">수량 ${h.quantity ?? 1}</span>
          ${h.diamond_amount ? `<span class="meta">💎 ${h.diamond_amount.toLocaleString()}</span>` : ""}
          ${h.cash_amount ? `<span class="meta">💰 ${h.cash_amount.toLocaleString()}</span>` : ""}
          <span class="meta" style="margin-left:auto">${h.distributed_at ? String(h.distributed_at).slice(0, 10) : ""}</span>
        </div>`;
      row.querySelector(".nm").textContent = h.item_name;
      listEl.appendChild(row);
    });
  }

  // ── 쟁지원조 (기존 기능 유지 — 출석 집계는 여전히 !긴급 로그 기준) ──
  function renderShift() {
    document.querySelectorAll("#shiftToggle span").forEach((s) => {
      s.classList.toggle("on", s.dataset.sh === data.preferred_shift);
    });
    const pendingNote = document.getElementById("shiftPendingNote");
    if (data.pending_change) {
      pendingNote.textContent = `⏳ ${SHIFT_LABEL[data.pending_change.shift]} 변경은 시즌 ${data.pending_change.effective_season}부터 반영됩니다. (이번 시즌 계산: ${data.effective_shift ? SHIFT_LABEL[data.effective_shift] : "미선택"})`;
    } else {
      pendingNote.textContent = "";
    }
    const box = document.getElementById("shiftMetricBox");
    if (!data.effective_shift) {
      box.innerHTML = `<span class="meta">쟁지원조를 선택하면 내 조 쟁지원 참여율이 표시됩니다.</span>`;
      return;
    }
    const m = data.metrics;
    if (!m || m.rate === null) {
      box.innerHTML = "";
      const label = document.createElement("b");
      label.style.fontSize = "14px";
      label.textContent = `${SHIFT_LABEL[m ? m.shift : data.effective_shift]}`;
      const note = document.createElement("span");
      note.className = "meta";
      note.textContent = " · 이번 시즌 우리 조 쟁지원 소집이 아직 없습니다.";
      box.appendChild(label);
      box.appendChild(note);
      return;
    }
    box.innerHTML = `
      <b style="font-size:14px" class="sh-label"></b>
      <span style="margin-left:8px">내 조 쟁지원 참여율 <b class="rate-v" style="font-size:16px"></b> <span class="meta frac"></span></span>
      <span class="meta" style="margin-left:10px">· 타조 지원 <b class="sup-v"></b>회</span>`;
    box.querySelector(".sh-label").textContent = SHIFT_LABEL[m.shift];
    box.querySelector(".rate-v").textContent = `${m.rate}%`;
    box.querySelector(".frac").textContent = `(${m.attended}/${m.total})`;
    box.querySelector(".sup-v").textContent = m.other_support;
  }

  async function selectShift(el) {
    const shift = el.dataset.sh;
    if (data && data.preferred_shift === shift) return;
    try {
      const res = await Api.setProfileShift(shift);
      if (res.unchanged) return;
      if (res.immediate) {
        toast(`✓ ${SHIFT_LABEL[shift]} 선택 완료 — 이번 시즌부터 바로 반영됩니다.`);
      } else {
        toast(`✓ ${SHIFT_LABEL[shift]}(으)로 변경 — 시즌 ${res.effective_season}부터 계산에 반영됩니다.`);
      }
      await load();
    } catch (err) {
      toast(err.message || "조 선택 실패", true);
    }
  }

  // ── 저장 핸들러 (API 호출은 원본 그대로) ──
  function init() {
    document.getElementById("profileInfoForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const patch = {
        current_id: document.getElementById("pfNick").value.trim(),
        guild_name: document.getElementById("pfGuild").value.trim(),
        subjugation_rank: document.getElementById("pfRank").value.trim(),
        class: document.getElementById("pfClass").value.trim(),
        level: parseInt(document.getElementById("pfLevel").value, 10) || 0,
        abyss_level: document.getElementById("pfAbyss").value.trim(),
        power: parseInt(document.getElementById("pfPower").value, 10) || 0,
      };
      const newPw = document.getElementById("pfNewPw").value;
      if (newPw) patch.new_password = newPw;
      try {
        await Api.updateProfile(patch);
        toast("✓ 기본정보 저장 완료");
        // 세션의 닉네임 표시도 갱신
        const u = Auth.getUser();
        if (u && patch.current_id) {
          u.current_id = patch.current_id;
          Auth.setSession(localStorage.getItem("session_token"), u);
          Auth.applyRoleUI(u);
        }
        await load();
      } catch (err) {
        toast(err.message || "저장 실패", true);
      }
    });

    document.getElementById("pfEquipSaveBtn").addEventListener("click", async () => {
      const equip = {};
      document.querySelectorAll("#pfEquipGrid select[data-slot]").forEach((sel) => (equip[sel.dataset.slot] = sel.value));
      try {
        await Api.updateProfile({ equipment_info: JSON.stringify(equip) });
        toast("✓ 장비 저장 완료");
        await load();
      } catch (err) {
        toast(err.message || "저장 실패", true);
      }
    });

    document.getElementById("pfAquiSaveBtn").addEventListener("click", async () => {
      const owned = {};
      for (const [id, level] of Object.entries(aquiState)) {
        if (level) owned[id] = level;
      }
      try {
        await Api.updateProfile({ status_check: GameData.buildAquiString(owned) });
        toast("✓ 아퀴룬 저장 완료");
        await load();
      } catch (err) {
        toast(err.message || "저장 실패", true);
      }
    });

    wireDropzone("power", "pfPowerDrop", "pfPowerImg");
    wireDropzone("aqui", "pfAquiDrop", "pfAquiImg");
    document.getElementById("pfPowerUploadBtn").addEventListener("click", () => uploadImgs("power"));
    document.getElementById("pfAquiUploadBtn").addEventListener("click", () => uploadImgs("aqui"));
  }

  return { init, load, selectShift, setTab, goShift };
})();
