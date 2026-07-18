// 내 정보 화면 (전 회원): 기본정보/장비/아퀴/인증샷/내 분배이력 셀프 관리 + 긴급 참여조.
// 원본 render_profile(app.py:10358-10735) 이식 — 분배 기간 진행 중에는 수정 잠금.
const Profile = (() => {
  let data = null; // GET /profile 응답
  let activeTab = "info";

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
    render();
  }

  const SHIFT_LABEL = { day: "데이조", night: "나이트조" };
  const PANES = { info: "profilePaneInfo", equip: "profilePaneEquip", aqui: "profilePaneAqui", imgs: "profilePaneImgs", history: "profilePaneHistory" };

  function setTab(el) {
    document.querySelectorAll(".fchip[data-pi]").forEach((c) => c.classList.remove("on"));
    el.classList.add("on");
    activeTab = el.dataset.pi;
    for (const [key, id] of Object.entries(PANES)) {
      document.getElementById(id).classList.toggle("hidden", key !== activeTab);
    }
  }

  function render() {
    document.getElementById("profileNameLabel").textContent = `${data.user.current_id || data.user.user_id}님의 정보`;
    document.getElementById("profileMetaLine").textContent =
      `고정아이디 ${data.user.user_id} · ${data.user.role} · 시즌 ${data.season} · 참여점수 ${(data.info.participation_score || 0).toLocaleString()} · 기여점수 ${(data.info.contribution_score || 0).toLocaleString()}`;

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
      document.querySelectorAll(`#${paneId} input, #${paneId} select, #${paneId} button`).forEach((el) => {
        el.disabled = locked;
      });
    });
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

  // ── 장비 ──
  function renderEquipPane() {
    const grid = document.getElementById("pfEquipGrid");
    grid.innerHTML = "";
    const equip = GameData.parseEquipment(data.equipment_info);
    GameData.EQUIPMENT_SLOTS.forEach((slot) => {
      const field = document.createElement("div");
      field.className = "field";
      const label = document.createElement("label");
      label.textContent = slot;
      const sel = document.createElement("select");
      sel.dataset.slot = slot;
      sel.innerHTML = GameData.EQUIPMENT_GRADES.map((g) => `<option value="${g}">${g}</option>`).join("");
      sel.value = GameData.EQUIPMENT_GRADES.includes(equip[slot]) ? equip[slot] : "희귀";
      field.appendChild(label);
      field.appendChild(sel);
      grid.appendChild(field);
    });
  }

  // ── 아퀴 ──
  function renderAquiPane() {
    const wrap = document.getElementById("pfAquiEdit");
    wrap.innerHTML = "";
    const cls = data.info.class || "";
    const owned = GameData.parseAqui(data.status_check, cls);
    if (!cls) wrap.appendChild(GameData.aquiClassNoticeEl());
    for (const group of ["A", "B", "C"]) {
      const info = GameData.AQUI_GROUPS[group];
      const head = document.createElement("div");
      head.style.cssText = `font-weight:700;font-size:12px;margin:10px 0 6px;color:${info.color}`;
      head.textContent = `${info.label} (${group})`;
      wrap.appendChild(head);
      const grid = document.createElement("div");
      grid.className = "aqui-edit-grid";
      GameData.AQUI_ITEMS[group].forEach((item) => {
        const field = document.createElement("div");
        field.className = "field";
        const label = GameData.aquiLabelEl(item, cls);
        const sel = document.createElement("select");
        sel.dataset.aquiId = item.id;
        const opts = [["", "미보유"], ["l", "전설"]];
        if (GameData.canBeMythic(item, cls)) opts.push(["m", "신화"]);
        sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
        const cur = owned[item.id] || "";
        sel.value = cur === "m" && !GameData.canBeMythic(item, cls) ? "l" : cur;
        field.appendChild(label);
        field.appendChild(sel);
        grid.appendChild(field);
      });
      wrap.appendChild(grid);
    }
  }

  // ── 인증샷 ──
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
  }

  // ── 내 분배 이력 ──
  function renderHistoryPane() {
    const listEl = document.getElementById("pfHistoryList");
    document.querySelectorAll("#pfHistoryList .irow[data-id]").forEach((el) => el.remove());
    const rows = data.my_history || [];
    document.getElementById("pfHistoryEmpty").style.display = rows.length ? "none" : "flex";
    const GRADE_BADGE = { 신화: "b-myth", 전설: "b-legend", 영웅: "b-hero", 희귀: "b-rare" };
    rows.forEach((h) => {
      const row = document.createElement("div");
      row.className = "irow";
      row.dataset.id = h.id;
      row.innerHTML = `
        <span style="width:56px">${h.grade ? `<span class="badge ${GRADE_BADGE[h.grade] || "b-gray"}">${h.grade}</span>` : ""}</span>
        <span class="nm"></span>
        <span class="meta">수량 ${h.quantity ?? 1}</span>
        ${h.diamond_amount ? `<span class="meta">💎 ${h.diamond_amount.toLocaleString()}</span>` : ""}
        ${h.cash_amount ? `<span class="meta">💰 ${h.cash_amount.toLocaleString()}</span>` : ""}
        <span class="meta" style="margin-left:auto">${h.distributed_at ? String(h.distributed_at).slice(0, 10) : ""}</span>`;
      row.querySelector(".nm").textContent = h.item_name;
      listEl.appendChild(row);
    });
  }

  // ── 긴급 참여조 (기존 기능 유지) ──
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
      box.innerHTML = `<span class="meta">참여조를 선택하면 내 조 긴급 참여율이 표시됩니다.</span>`;
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
      note.textContent = " · 이번 시즌 우리 조 긴급 소집이 아직 없습니다.";
      box.appendChild(label);
      box.appendChild(note);
      return;
    }
    box.innerHTML = `
      <b style="font-size:14px" class="sh-label"></b>
      <span style="margin-left:8px">내 조 긴급 참여율 <b class="rate-v" style="font-size:16px"></b> <span class="meta frac"></span></span>
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

  // ── 저장 핸들러 ──
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
      document.querySelectorAll("#pfAquiEdit select[data-aqui-id]").forEach((sel) => {
        if (sel.value) owned[sel.dataset.aquiId] = sel.value;
      });
      try {
        await Api.updateProfile({ status_check: GameData.buildAquiString(owned) });
        toast("✓ 아퀴룬 저장 완료");
        await load();
      } catch (err) {
        toast(err.message || "저장 실패", true);
      }
    });

    document.getElementById("pfPowerUploadBtn").addEventListener("click", () => uploadImgs("power", "pfPowerImg", 1));
    document.getElementById("pfAquiUploadBtn").addEventListener("click", () => uploadImgs("aqui", "pfAquiImg", 10));
  }

  async function uploadImgs(kind, inputId, maxCount) {
    const input = document.getElementById(inputId);
    if (!input.files.length) {
      toast("파일을 먼저 선택해주세요.", true);
      return;
    }
    try {
      const images = await ImageUtil.filesToDataUrls(input.files, maxCount);
      const res = await Api.uploadProfileImages(kind, images);
      toast(`✓ 스샷 ${res.urls.length}장 업로드 완료 (기존 스샷 교체됨)`);
      await load();
    } catch (err) {
      toast(err.message || "업로드 실패", true);
    }
  }

  return { init, load, selectShift, setTab };
})();
