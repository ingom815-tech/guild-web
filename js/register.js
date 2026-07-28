// 가입 신청 화면 (로그인 전, 무인증) — 원본 로그인 화면 가입 탭 이식.
// 장비/아퀴 그리드는 GameData 기반, 스샷은 ImageUtil로 전처리 후 base64 전송.
const Register = (() => {
  let powerImages = []; // 전처리된 base64 배열
  let aquiImages = [];

  function showErr(msg) {
    const box = document.getElementById("registerErr");
    box.textContent = msg;
    box.style.display = msg ? "block" : "none";
  }

  function show() {
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("registerScreen").classList.remove("hidden");
    buildGrids();
    loadGuildOptions();
  }

  // 소속결사 선택지 (guilds 목록 — 무인증 조회, 합병 준비). 화면 열 때마다 재시도.
  async function loadGuildOptions() {
    const sel = document.getElementById("regGuild");
    sel.innerHTML = `<option value="">불러오는 중...</option>`;
    try {
      const list = await Api.getPublicGuilds();
      sel.innerHTML = `<option value="">선택...</option>`;
      (list || []).forEach((g) => {
        const o = document.createElement("option");
        o.value = g.name;
        o.textContent = g.name;
        sel.appendChild(o);
      });
      if (!list || !list.length) {
        sel.innerHTML = `<option value="">결사 목록이 비어 있습니다 — 운영진에게 문의해주세요</option>`;
      }
    } catch (e) {
      sel.innerHTML = `<option value="">목록을 불러오지 못했습니다 — 새로고침 후 다시 시도해주세요</option>`;
    }
  }

  function hide() {
    document.getElementById("registerScreen").classList.add("hidden");
    document.getElementById("loginScreen").classList.remove("hidden");
  }

  function buildGrids() {
    // 직업 select
    const clsSel = document.getElementById("regClass");
    if (!clsSel.options.length) {
      clsSel.innerHTML =
        `<option value="">선택 안 함</option>` +
        GameData.CLASS_OPTIONS.map((c) => `<option value="${c}">${c}</option>`).join("");
    }
    // 장비 그리드
    const grid = document.getElementById("regEquipGrid");
    if (!grid.children.length) {
      GameData.EQUIPMENT_SLOTS.forEach((slot) => {
        const field = document.createElement("div");
        field.className = "field";
        const label = document.createElement("label");
        label.textContent = slot;
        const sel = document.createElement("select");
        sel.dataset.slot = slot;
        sel.innerHTML = GameData.EQUIPMENT_GRADES.map((g) => `<option value="${g}">${g}</option>`).join("");
        field.appendChild(label);
        field.appendChild(sel);
        grid.appendChild(field);
      });
    }
    rebuildAquiGrid();
  }

  function rebuildAquiGrid() {
    const cls = document.getElementById("regClass").value.trim();
    const wrap = document.getElementById("regAquiEdit");
    // 현재 선택값 보존
    const kept = {};
    wrap.querySelectorAll("select[data-aqui-id]").forEach((sel) => {
      if (sel.value) kept[sel.dataset.aquiId] = sel.value;
    });
    wrap.innerHTML = "";
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
        const cur = kept[item.id] || "";
        sel.value = cur === "m" && !GameData.canBeMythic(item, cls) ? "l" : cur;
        field.appendChild(label);
        field.appendChild(sel);
        grid.appendChild(field);
      });
      wrap.appendChild(grid);
    }
  }

  function renderPreviews(containerId, images) {
    const box = document.getElementById(containerId);
    box.innerHTML = "";
    images.forEach((src) => {
      const img = document.createElement("img");
      img.src = src;
      img.style.cssText = "width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line)";
      box.appendChild(img);
    });
  }

  // 진단 로그 (실패 무시) — 첨부/전송 실패 시 원인 수집. 파일 내용은 보내지 않는다.
  function diag(context, detail) {
    try {
      Api.sendDiag(context, detail);
    } catch (_) {
      // 무시
    }
  }

  async function onFileChange(inputId, previewId, statusId, maxCount, target) {
    const input = document.getElementById(inputId);
    const status = document.getElementById(statusId);
    if (!input.files.length) return;
    const files = [...input.files];
    status.textContent = "처리 중...";
    status.style.color = "";
    try {
      const arr = await ImageUtil.filesToDataUrls(input.files, maxCount);
      target.length = 0;
      target.push(...arr);
      renderPreviews(previewId, target);
      status.textContent = `✅ ${arr.length}장 첨부됨`;
      showErr("");
    } catch (err) {
      // 실패 이유를 첨부칸 바로 아래에 표시 (폼 상단 에러 박스는 화면 밖일 수 있음)
      const heic = files.some((f) => /\.hei[cf]$/i.test(f.name || "") || /hei[cf]/i.test(f.type || ""));
      const msg = (err.message || "이미지 처리 실패") +
        (heic ? " — 아이폰 HEIC 사진은 지원되지 않아요. 게임 스크린샷(PNG/JPG)을 올려주세요." : "");
      status.textContent = "⚠️ " + msg;
      status.style.color = "#A32D2D";
      showErr(msg);
      diag("register_attach", {
        input: inputId,
        error: err.message || String(err),
        files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
      });
      target.length = 0;
      renderPreviews(previewId, target);
      input.value = "";
    }
  }

  function collectEquip() {
    const equip = {};
    document.querySelectorAll("#regEquipGrid select[data-slot]").forEach((sel) => (equip[sel.dataset.slot] = sel.value));
    return JSON.stringify(equip);
  }

  function collectAqui() {
    const owned = {};
    document.querySelectorAll("#regAquiEdit select[data-aqui-id]").forEach((sel) => {
      if (sel.value) owned[sel.dataset.aquiId] = sel.value;
    });
    return GameData.buildAquiString(owned);
  }

  function init() {
    document.getElementById("showRegisterLink").addEventListener("click", (e) => {
      e.preventDefault();
      show();
    });
    document.getElementById("backToLoginLink").addEventListener("click", (e) => {
      e.preventDefault();
      hide();
    });
    document.getElementById("regClass").addEventListener("change", rebuildAquiGrid);
    document.getElementById("regPowerImg").addEventListener("change", () =>
      onFileChange("regPowerImg", "regPowerPreview", "regPowerStatus", 1, powerImages));
    document.getElementById("regAquiImg").addEventListener("change", () =>
      onFileChange("regAquiImg", "regAquiPreview", "regAquiStatus", 10, aquiImages));

    document.getElementById("registerForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      showErr("");
      const pw = document.getElementById("regPw").value;
      const pw2 = document.getElementById("regPw2").value;
      if (pw.length < 4) return showErr("비밀번호는 4자 이상이어야 합니다.");
      if (pw !== pw2) return showErr("비밀번호 확인이 일치하지 않습니다.");

      const btn = document.getElementById("regSubmitBtn");
      btn.disabled = true;
      btn.textContent = "신청 중...";
      try {
        const res = await Api.register({
          user_id: document.getElementById("regUserId").value.trim(),
          password: pw,
          current_id: document.getElementById("regNick").value.trim(),
          role: "결사원", // 가입은 전부 결사원 — 운영진 지정은 관리자가 결사원 관리에서
          guild_name: document.getElementById("regGuild").value,
          subjugation_rank: document.getElementById("regRank").value.trim(),
          class: document.getElementById("regClass").value.trim(),
          level: parseInt(document.getElementById("regLevel").value, 10) || 0,
          abyss_level: document.getElementById("regAbyss").value.trim(),
          power: parseInt(document.getElementById("regPower").value, 10) || 0,
          equipment_info: collectEquip(),
          status_check: collectAqui(),
          power_images: powerImages,
          aqui_images: aquiImages,
        });
        alert(res.message || "가입 신청이 접수되었습니다. 운영진 승인 후 로그인할 수 있습니다.");
        document.getElementById("registerForm").reset();
        powerImages = [];
        aquiImages = [];
        renderPreviews("regPowerPreview", []);
        renderPreviews("regAquiPreview", []);
        document.getElementById("regPowerStatus").textContent = "";
        document.getElementById("regAquiStatus").textContent = "";
        hide();
      } catch (err) {
        showErr(err.message || "가입 신청 실패");
        diag("register_submit", {
          error: err.message || String(err),
          power_count: powerImages.length,
          aqui_count: aquiImages.length,
        });
      } finally {
        btn.disabled = false;
        btn.textContent = "가입 신청";
      }
    });
  }

  return { init, show, hide };
})();
