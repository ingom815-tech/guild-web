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
        const label = document.createElement("label");
        label.textContent = GameData.skillLabel(item, cls);
        label.title = GameData.skillLabel(item, cls);
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

  async function onFileChange(inputId, previewId, maxCount, target) {
    const input = document.getElementById(inputId);
    if (!input.files.length) return;
    try {
      const arr = await ImageUtil.filesToDataUrls(input.files, maxCount);
      target.length = 0;
      target.push(...arr);
      renderPreviews(previewId, target);
      showErr("");
    } catch (err) {
      showErr(err.message || "이미지 처리 실패");
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
      onFileChange("regPowerImg", "regPowerPreview", 1, powerImages));
    document.getElementById("regAquiImg").addEventListener("change", () =>
      onFileChange("regAquiImg", "regAquiPreview", 10, aquiImages));

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
          role: document.getElementById("regRole").value,
          guild_name: document.getElementById("regGuild").value.trim(),
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
        hide();
      } catch (err) {
        showErr(err.message || "가입 신청 실패");
      } finally {
        btn.disabled = false;
        btn.textContent = "가입 신청";
      }
    });
  }

  return { init, show, hide };
})();
