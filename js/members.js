// 결사원 관리 화면: 목록 렌더/필터/등록/수정/비밀번호 재설정/탈퇴(2단계 확인)
const Members = (() => {
  let members = [];
  let activeRoleFilter = "전체";
  let activeView = "general"; // general | equip | aqui
  let aquiView = "p"; // p(사람별) | r(룬별 현황)
  let runeFilter = ""; // 특정 룬 기준 보기 (슬롯 코드)
  let onlyNoMode = false; // 미보유만
  let pendingDeleteId = null;

  function toast(msg, isErr) {
    const t = document.getElementById("membersToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 4000);
  }

  async function load() {
    try {
      members = await Api.listMembers();
    } catch (e) {
      toast(e.message || "결사원 목록 조회 실패", true);
      return;
    }
    render();
    loadRegistrations();
  }

  // ── 가입 신청 관리 ──
  let regConfirmAction = null;

  async function loadRegistrations() {
    let regs = [];
    try {
      regs = await Api.getRegistrations();
    } catch (e) {
      return; // 조회 실패 시 카드만 숨김
    }
    const card = document.getElementById("regRequestsCard");
    card.classList.toggle("hidden", !regs.length);
    document.getElementById("regRequestsCount").textContent = regs.length;
    const listEl = document.getElementById("regRequestsList");
    listEl.innerHTML = "";

    regs.forEach((r) => {
      const row = document.createElement("div");
      row.className = "irow";
      row.style.flexWrap = "wrap";
      const powerImgs = ImageUtil.parseImgUrls(r.power_img_url);
      const aquiImgs = ImageUtil.parseImgUrls(r.status_check_img_url);
      const thumb = (src) =>
        `<a href="${src}" target="_blank"><img src="${src}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;border:1px solid var(--line)"></a>`;
      row.innerHTML = `
        <div style="min-width:200px">
          <b class="nm"></b> <span class="meta uid"></span>
          <div class="meta detail"></div>
        </div>
        <div class="row" style="gap:4px;flex-wrap:wrap">
          ${powerImgs.map(thumb).join("")}${aquiImgs.map(thumb).join("")}
        </div>
        <span style="margin-left:auto;display:flex;gap:6px">
          <button class="btn sm" data-act="approve">승인</button>
          <button class="btn sm ghost" data-act="reject" style="color:#A32D2D">거절</button>
        </span>`;
      row.querySelector(".nm").textContent = r.current_id || r.user_id;
      row.querySelector(".uid").textContent = `(${r.user_id})`;
      row.querySelector(".detail").textContent =
        `${r.role || "결사원"} · ${r.class || "-"} · Lv ${r.level ?? 0} · 전투력 ${(r.power ?? 0).toLocaleString()} · ${r.guild_name || "-"}` +
        ` · 스샷 전투력 ${powerImgs.length}장/아퀴 ${aquiImgs.length}장`;
      row.querySelector('[data-act="approve"]').addEventListener("click", () => {
        openRegConfirm("가입 승인", `"${r.current_id || r.user_id}"님의 가입을 승인할까요? 즉시 로그인 가능해집니다.`, async () => {
          await Api.approveRegistration(r.id);
          toast(`✓ ${r.current_id || r.user_id} 가입 승인 완료`);
          await load();
        });
      });
      row.querySelector('[data-act="reject"]').addEventListener("click", () => {
        openRegConfirm("가입 거절", `"${r.current_id || r.user_id}"님의 가입 신청을 거절할까요?`, async () => {
          await Api.rejectRegistration(r.id);
          toast(`가입 신청을 거절했습니다.`);
          await load();
        });
      });
      listEl.appendChild(row);
    });
  }

  function openRegConfirm(title, msg, action) {
    regConfirmAction = action;
    document.getElementById("regConfirmTitle").textContent = title;
    document.getElementById("regConfirmMsg").textContent = msg;
    document.getElementById("regConfirmBackdrop").classList.add("on");
  }

  function initRegConfirmModal() {
    document.getElementById("regConfirmCancelBtn").addEventListener("click", () => {
      regConfirmAction = null;
      document.getElementById("regConfirmBackdrop").classList.remove("on");
    });
    document.getElementById("regConfirmYesBtn").addEventListener("click", async () => {
      const action = regConfirmAction;
      regConfirmAction = null;
      document.getElementById("regConfirmBackdrop").classList.remove("on");
      if (!action) return;
      try {
        await action();
      } catch (err) {
        toast(err.message || "처리 실패", true);
      }
    });
  }

  function classFilterValue() {
    return document.getElementById("qmClass").value || "";
  }

  function filteredRows() {
    const q = (document.getElementById("qm").value || "").trim();
    const clsF = classFilterValue();
    return members.filter((m) => {
      const roleHit = activeRoleFilter === "전체" || m.role === activeRoleFilter;
      const clsHit = !clsF || m.class === clsF;
      const qHit =
        !q ||
        (m.current_id || "").includes(q) ||
        (m.user_id || "").includes(q) ||
        (m.guild_name || "").includes(q) ||
        (m.class || "").includes(q);
      return roleHit && clsHit && qHit;
    });
  }

  function render() {
    const rows = filteredRows();
    document.getElementById("membersTable").classList.toggle("hidden", activeView !== "general");
    document.getElementById("membersEquipTable").classList.toggle("hidden", activeView !== "equip");
    document.getElementById("membersAquiTable").classList.toggle("hidden", activeView !== "aqui");
    updateAquiToolbar();
    if (activeView === "equip") renderEquip(rows);
    else if (activeView === "aqui") renderAqui(rows);
    else renderGeneral(rows);
  }

  function renderGeneral(rows) {
    const container = document.getElementById("membersTable");
    document.querySelectorAll("#membersTable .irow[data-id]").forEach((el) => el.remove());
    const emptyRow = document.getElementById("membersEmpty");
    emptyRow.style.display = rows.length ? "none" : "flex";

    const isAdmin = (Auth.getUser() || {}).role === "관리자";
    rows.forEach((m) => {
      const row = document.createElement("div");
      row.className = "irow";
      row.dataset.id = m.user_id;
      row.innerHTML = `
        <span class="nm"></span>
        <span style="width:110px" class="meta uid"></span>
        <span style="width:90px" class="meta guild"></span>
        <span style="width:80px" class="meta cls"></span>
        <span style="width:50px">${m.level ?? 0}</span>
        <span style="width:80px">${(m.power ?? 0).toLocaleString()}</span>
        <span style="width:56px"><span class="role-badge"></span></span>
        <span style="width:70px">${m.contribution_score ?? 0}</span>
        <span style="width:108px" class="shots"></span>
        <span style="margin-left:auto;display:flex;gap:6px">
          <button class="btn sm ghost" data-act="edit">수정</button>
          <button class="btn sm ghost" data-act="delete" style="color:#A32D2D">탈퇴</button>
        </span>`;
      row.querySelector(".nm").textContent = m.current_id || m.user_id;
      row.querySelector(".uid").textContent = m.user_id;
      row.querySelector(".guild").textContent = m.guild_name || "-";
      row.querySelector(".cls").textContent = m.class || "-";
      const badge = row.querySelector(".role-badge");
      badge.textContent = m.role || "";
      badge.className = "role-badge " + (m.role || "");

      // 스샷 유무 표시 + 종류별 보기 버튼 — 이미지 원문은 용량이 커서 목록에 포함되지 않으므로
      // 서버가 내려준 유무 플래그로만 표시하고, 클릭 시 그 결사원 것만 따로 조회한다.
      const shotsCell = row.querySelector(".shots");
      shotsCell.style.display = "flex";
      shotsCell.style.gap = "4px";
      const mkShotBtn = (label, kind, has) => {
        const btn = document.createElement("button");
        btn.className = "btn sm ghost shotbtn";
        btn.textContent = label;
        if (has) {
          btn.title = `${label} 스샷 보기`;
          btn.addEventListener("click", () => openShots(m, kind));
        } else {
          btn.disabled = true;
          btn.style.opacity = ".35";
          btn.title = `${label} 스샷 없음`;
        }
        shotsCell.appendChild(btn);
      };
      mkShotBtn("장비", "power", m.has_power_img);
      mkShotBtn("아퀴", "aqui", m.has_aqui_img);

      row.querySelector('[data-act="edit"]').addEventListener("click", () => openEdit(m));
      const delBtn = row.querySelector('[data-act="delete"]');
      if (isAdmin) {
        delBtn.addEventListener("click", () => requestDelete(m));
      } else {
        delBtn.disabled = true;
        delBtn.title = "탈퇴 처리는 관리자만 가능합니다.";
        delBtn.style.opacity = ".4";
      }
      container.appendChild(row);
    });
  }

  // ── 스샷 보기 모달 (열 때 해당 결사원의 요청한 종류 이미지만 서버에서 가져옴) ──
  async function openShots(m, kind) {
    const kindLabel = kind === "power" ? "⚔️ 장비(전투력) 스샷" : "🔮 아퀴룬 스샷";
    document.getElementById("shotModalTitle").textContent = `${m.current_id || m.user_id} — ${kindLabel}`;
    const body = document.getElementById("shotModalBody");
    body.innerHTML = '<div class="meta" style="padding:20px 0"><span class="spinner"></span>스크린샷을 불러오는 중...</div>';
    document.getElementById("shotModalBackdrop").classList.add("on");

    let imgData;
    try {
      imgData = await Api.getMemberImages(m.user_id);
    } catch (e) {
      body.innerHTML = '<div class="meta" style="padding:20px 0;color:#A32D2D">스크린샷을 불러오지 못했습니다.</div>';
      return;
    }
    const imgs = ImageUtil.parseImgUrls(kind === "power" ? imgData.power_img_url : imgData.status_check_img_url);
    body.innerHTML = "";
    const div = document.createElement("div");
    div.className = "shot-group";
    const head = document.createElement("div");
    head.className = "meta";
    head.textContent = `총 ${imgs.length}장 — 썸네일을 클릭하면 원본이 새 탭에서 열립니다.`;
    div.appendChild(head);
    const grid = document.createElement("div");
    grid.className = "shot-grid";
    if (imgs.length) {
      imgs.forEach((src) => {
        const a = document.createElement("a");
        a.href = src;
        a.target = "_blank";
        a.rel = "noopener";
        const img = document.createElement("img");
        img.src = src;
        img.loading = "lazy";
        a.appendChild(img);
        grid.appendChild(a);
      });
    } else {
      grid.innerHTML = '<span class="meta">등록된 스샷이 없습니다.</span>';
    }
    div.appendChild(grid);
    body.appendChild(div);
  }

  // ── 장비정보 표 (19슬롯 등급, 첫 열 고정 + 가로 스크롤) ──
  const GRADE_SHORT = { 절대자: "절", 신화: "신", 전설: "전", 영웅: "영", 희귀: "희" };

  function emptyTableRow(colspan, msg) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = colspan;
    td.className = "dim";
    td.style.textAlign = "center";
    td.textContent = msg;
    tr.appendChild(td);
    return tr;
  }

  function renderEquip(rows) {
    const wrap = document.getElementById("membersEquipTable");
    wrap.innerHTML = "";
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    const addTh = (text, cls) => {
      const th = document.createElement("th");
      th.textContent = text;
      if (cls) th.className = cls;
      hr.appendChild(th);
    };
    addTh("닉네임", "stick");
    addTh("요약");
    GameData.EQUIPMENT_SLOTS.forEach((slot) => addTh(slot, "ctr"));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    if (!rows.length) tbody.appendChild(emptyTableRow(GameData.EQUIPMENT_SLOTS.length + 2, "결사원이 없습니다."));
    rows.forEach((m) => {
      const equip = GameData.parseEquipment(m.equipment_info);
      const tr = document.createElement("tr");
      const td0 = document.createElement("td");
      td0.className = "stick";
      td0.style.fontWeight = "600";
      td0.textContent = m.current_id || m.user_id;
      tr.appendChild(td0);

      const counts = {};
      GameData.EQUIPMENT_SLOTS.forEach((s) => {
        const g = equip[s];
        if (GameData.GRADE_COLORS[g]) counts[g] = (counts[g] || 0) + 1;
      });
      const tdSum = document.createElement("td");
      ["절대자", "신화", "전설", "영웅", "희귀"].forEach((g) => {
        if (!counts[g]) return;
        const b = document.createElement("b");
        b.style.color = GameData.GRADE_COLORS[g];
        b.style.marginRight = "6px";
        b.textContent = `${GRADE_SHORT[g]}${counts[g]}`;
        tdSum.appendChild(b);
      });
      if (!tdSum.children.length) {
        tdSum.textContent = "미입력";
        tdSum.className = "dim";
      }
      tr.appendChild(tdSum);

      GameData.EQUIPMENT_SLOTS.forEach((slot) => {
        const td = document.createElement("td");
        td.className = "ctr";
        const g = equip[slot];
        if (GameData.GRADE_COLORS[g]) {
          td.textContent = GRADE_SHORT[g] || g;
          td.style.color = GameData.GRADE_COLORS[g];
          td.style.fontWeight = "700";
          td.title = `${slot}: ${g}`;
        } else {
          td.textContent = "-";
          td.classList.add("dim");
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  // ── 아퀴정보 목록 (아퀴정보목록_개선시안_v2.html — 사람별 요약 + 룬별 현황) ──
  function aquiColLabel(id) {
    return id.replace("_pot", "약").replace("_s", "특");
  }

  const AQUI_GROUP_META = {
    A: { label: "PVP", bar: "pvp" },
    B: { label: "지원", bar: "sup" },
    C: { label: "PVE", bar: "pve" },
  };

  function aquiAllItems() {
    return ["A", "B", "C"].flatMap((g) => GameData.AQUI_ITEMS[g].map((it) => ({ ...it, group: g })));
  }

  // 화면 표시 이름: 직업 매핑의 룬 이름, 없으면 코드 fallback (화면이 깨지지 않게)
  function runeDisplay(item, cls) {
    return (cls && GameData.aquiName(item, cls)) || aquiColLabel(item.id);
  }

  // "특정 룬 기준 보기" 드롭다운 — 현재 직업 필터의 매핑에서 동적 생성.
  // 미보유자 탐색이 주 용도라 각 룬의 미보유 인원 수를 함께 표시하고, 섹션별로 그룹핑한다.
  function rebuildRuneOptions() {
    const sel = document.getElementById("qmRune");
    const clsF = classFilterValue();
    const prev = runeFilter;
    const ownedList = filteredRows().map((m) => GameData.parseAqui(m.status_check, m.class || ""));
    const notOwnCount = (id) => ownedList.filter((o) => !o[id]).length;
    sel.innerHTML =
      `<option value="">특정 룬 기준 보기</option>` +
      ["A", "B", "C"].map((g) =>
        `<optgroup label="${AQUI_GROUP_META[g].label} (${g})">` +
        GameData.AQUI_ITEMS[g]
          .map((it) => `<option value="${it.id}">${runeDisplay(it, clsF)} · 미보유 ${notOwnCount(it.id)}명</option>`)
          .join("") +
        `</optgroup>`,
      ).join("");
    sel.value = prev;
    if (sel.value !== prev) {
      runeFilter = "";
      onlyNoMode = false;
    }
  }

  function updateAquiToolbar() {
    document.getElementById("aquiTools").classList.toggle("hidden", activeView !== "aqui");
    if (activeView !== "aqui") return;
    rebuildRuneOptions();
    const onlyNoEl = document.getElementById("qmOnlyNo");
    onlyNoEl.classList.toggle("hidden", !(runeFilter && aquiView === "p"));
    onlyNoEl.classList.toggle("on", onlyNoMode);
    onlyNoEl.textContent = onlyNoMode ? "☑ 미보유만" : "☐ 미보유만";
  }

  function renderAqui(rows) {
    const wrap = document.getElementById("membersAquiTable");
    wrap.innerHTML = "";
    if (aquiView === "r") renderAquiRunes(wrap, rows);
    else renderAquiPeople(wrap, rows);
  }

  // ── 사람별 뷰: 닉네임 | 직업 | 보유 | PVP·지원·PVE 미니바 | (선택 룬) | 행 클릭 펼침 ──
  function renderAquiPeople(wrap, rows) {
    const clsF = classFilterValue();
    const runeItem = runeFilter ? aquiAllItems().find((it) => it.id === runeFilter) : null;

    const entries = rows.map((m) => ({ m, owned: GameData.parseAqui(m.status_check, m.class || "") }));
    let shown = entries;
    // 미보유 명단은 항상 참여점수 높은 순 — 이 순서가 분배 우선순위 후보 (룬별 현황과 동일 규칙)
    const pscore = (e) => e.m.participation_score ?? 0;
    if (runeItem && onlyNoMode) {
      shown = entries.filter((e) => !e.owned[runeItem.id]).sort((a, b) => pscore(b) - pscore(a));
    } else if (runeItem) {
      // 미보유만이 꺼져 있어도 미보유자 우선 + 각 그룹 안에서 참여점수 내림차순
      shown = [...entries].sort(
        (a, b) => (a.owned[runeItem.id] ? 1 : 0) - (b.owned[runeItem.id] ? 1 : 0) || pscore(b) - pscore(a),
      );
    }

    if (runeItem) {
      const note = document.createElement("div");
      note.className = "runenote";
      const ownCnt = entries.filter((e) => !!e.owned[runeItem.id]).length;
      const disp = runeDisplay(runeItem, clsF);
      const paren = disp === runeItem.id || disp === aquiColLabel(runeItem.id)
        ? AQUI_GROUP_META[runeItem.group].label
        : `${runeItem.id} · ${AQUI_GROUP_META[runeItem.group].label}`;
      note.innerHTML = `🔎 <b class="rn"></b> <span class="meta" style="color:inherit">(${paren})</span> 기준 보기 — ` +
        `<b>미보유 ${entries.length - ownCnt}명</b> / 보유 ${ownCnt}명 (${clsF || "전체"} ${entries.length}명)` +
        `<span class="mapref" style="display:block;margin-top:4px"></span>`;
      note.querySelector(".rn").textContent = runeDisplay(runeItem, clsF);
      // 직업 필터가 "전체"면 코드만으론 어떤 룬인지 알 수 없으니 직업별 룬 이름을 그리드로 병기
      const ref = note.querySelector(".mapref");
      if (!clsF) {
        ref.style.cssText =
          "display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px 18px;" +
          "margin-top:8px;padding-top:8px;border-top:1px dashed #9FE1CB";
        GameData.CLASS_OPTIONS.forEach((c) => {
          const cell = document.createElement("span");
          cell.style.cssText = "display:flex;gap:8px;align-items:baseline";
          const cls = document.createElement("span");
          cls.style.cssText = "min-width:72px;font-weight:600;font-size:12px";
          cls.textContent = c;
          const rn = document.createElement("span");
          const n = GameData.aquiName(runeItem, c);
          rn.textContent = n || "매핑 없음";
          if (!n) rn.style.opacity = ".5";
          cell.appendChild(cls);
          cell.appendChild(rn);
          ref.appendChild(cell);
        });
      } else {
        ref.remove();
      }
      wrap.appendChild(note);
    }

    const box = document.createElement("div");
    box.className = "mtable";
    const table = document.createElement("table");
    table.className = "aqtable";
    const colCount = runeItem ? 8 : 7;
    const hr = document.createElement("tr");
    hr.innerHTML =
      `<th>닉네임</th><th>직업</th><th class="num">보유</th><th>PVP</th><th>지원</th><th>PVE</th>` +
      (runeItem ? `<th class="runeth"></th>` : "") +
      `<th style="width:30px"></th>`;
    if (runeItem) hr.querySelector(".runeth").textContent = runeDisplay(runeItem, clsF);
    table.appendChild(hr);

    if (!shown.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="${colCount}" style="text-align:center;color:var(--txt3)">결사원이 없습니다.</td>`;
      table.appendChild(tr);
    }

    shown.forEach(({ m, owned }) => {
      const secCnt = { A: 0, B: 0, C: 0 };
      Object.keys(owned).forEach((id) => {
        if (secCnt[id[0]] !== undefined) secCnt[id[0]] += 1;
      });
      const total = Object.keys(owned).length;

      const tr = document.createElement("tr");
      tr.className = "mrow";
      const secCell = (g) => {
        const n = secCnt[g];
        const pct = Math.round((n / 13) * 100);
        return `<td><span class="secbar"><span class="bar ${AQUI_GROUP_META[g].bar}"><i style="width:${pct}%"></i></span><span class="cnt${n <= 3 ? " low" : ""}">${n}/13</span></span></td>`;
      };
      tr.innerHTML =
        `<td><b class="nm"></b></td><td class="cnt cls"></td><td class="num"><b>${total}</b>/39</td>` +
        secCell("A") + secCell("B") + secCell("C") +
        (runeItem
          ? owned[runeItem.id]
            ? `<td class="have">✓ 보유</td>`
            : `<td class="nothave">— 미보유</td>`
          : "") +
        `<td class="chev">▾</td>`;
      tr.querySelector(".nm").textContent = m.current_id || m.user_id;
      tr.querySelector(".cls").textContent = m.class || "-";

      // 펼침 상세: 39개 룬 이름 배지 (보유=흰, 신화=금색, 미보유=점선 흐림)
      const detail = document.createElement("tr");
      detail.className = "detail";
      const td = document.createElement("td");
      td.colSpan = colCount;
      for (const g of ["A", "B", "C"]) {
        const dsec = document.createElement("div");
        dsec.className = "dsec";
        const dt = document.createElement("div");
        dt.className = `dt ${AQUI_GROUP_META[g].bar}`;
        dt.textContent = `${AQUI_GROUP_META[g].label} (13)`;
        dsec.appendChild(dt);
        const chips = document.createElement("div");
        chips.className = "chips";
        GameData.AQUI_ITEMS[g].forEach((item) => {
          const grade = owned[item.id];
          const chip = document.createElement("span");
          chip.className = "rc " + (grade === "m" ? "myth" : grade ? "own" : "no");
          chip.textContent = runeDisplay(item, m.class || "");
          chip.title = `${item.id}${grade === "m" ? " · 신화" : grade ? " · 전설" : " · 미보유"}`;
          chips.appendChild(chip);
        });
        dsec.appendChild(chips);
        td.appendChild(dsec);
      }
      detail.appendChild(td);

      tr.addEventListener("click", () => tr.classList.toggle("open"));
      table.appendChild(tr);
      table.appendChild(detail);
    });

    box.appendChild(table);
    wrap.appendChild(box);

    const foot = document.createElement("div");
    foot.style.cssText = "text-align:center;padding:10px;font-size:12.5px;color:var(--txt3)";
    foot.textContent = `총 ${shown.length}명${clsF ? ` (${clsF})` : ""}${runeItem && onlyNoMode ? " — 미보유만" : ""}`;
    wrap.appendChild(foot);
  }

  // ── 룬별 현황 뷰: 미보유 많은 순(수요) → 행 클릭 시 미보유자 참여점수순 (분배 우선순위 후보) ──
  function renderAquiRunes(wrap, rows) {
    const clsF = classFilterValue();
    const note = document.createElement("div");
    note.className = "runenote gray";
    note.innerHTML =
      `💡 미보유 인원이 많은 룬(수요 높음)이 위로 정렬됩니다. 행을 클릭하면 미보유자가 <b>참여점수순</b>으로 표시됩니다 — 이 순서가 분배 우선순위 후보입니다.` +
      (clsF ? "" : ` <span style="color:var(--txt3)">직업 필터를 선택하면 룬 이름으로 표시됩니다.</span>`);
    wrap.appendChild(note);

    const entries = rows.map((m) => ({ m, owned: GameData.parseAqui(m.status_check, m.class || "") }));
    const stats = aquiAllItems().map((it) => {
      const notOwn = entries.filter((e) => !e.owned[it.id]).map((e) => e.m);
      notOwn.sort((a, b) => (b.participation_score ?? 0) - (a.participation_score ?? 0));
      return { it, ownCnt: entries.length - notOwn.length, notOwn };
    });
    stats.sort((a, b) => b.notOwn.length - a.notOwn.length);

    const box = document.createElement("div");
    box.className = "mtable";
    const table = document.createElement("table");
    table.className = "aqtable";
    const hr = document.createElement("tr");
    hr.innerHTML = `<th>룬 이름</th><th>섹션</th><th class="num">보유 / 전체</th><th class="num">미보유 ↓</th><th>수요</th><th style="width:30px"></th>`;
    table.appendChild(hr);

    if (!entries.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="6" style="text-align:center;color:var(--txt3)">결사원이 없습니다.</td>`;
      table.appendChild(tr);
    } else {
      stats.forEach(({ it, ownCnt, notOwn }) => {
        const ratio = notOwn.length / entries.length;
        const tr = document.createElement("tr");
        tr.className = "mrow";
        const mythTag = clsF && GameData.canBeMythic(it, clsF)
          ? ` <span style="font-size:10px;color:var(--gold-tx)">신화</span>`
          : "";
        tr.innerHTML =
          `<td><b class="rn"></b>${mythTag}</td><td class="cnt sec"></td>` +
          `<td class="num">${ownCnt} / ${entries.length}</td><td class="num"><b>${notOwn.length}명</b></td>` +
          `<td><span class="demand ${ratio >= 0.6 ? "d-high" : "d-mid"}">${ratio >= 0.6 ? "수요 높음" : "보통"}</span></td>` +
          `<td class="chev">▾</td>`;
        tr.querySelector(".rn").textContent = runeDisplay(it, clsF);
        tr.querySelector(".sec").textContent = AQUI_GROUP_META[it.group].label;

        const detail = document.createElement("tr");
        detail.className = "rdetail";
        const td = document.createElement("td");
        td.colSpan = 6;
        if (!notOwn.length) {
          td.innerHTML = `<span class="meta">전원 보유 중입니다.</span>`;
        } else {
          notOwn.slice(0, 10).forEach((m, i) => {
            const cand = document.createElement("span");
            cand.className = "cand" + (i < 3 ? " top" : "");
            const b = document.createElement("b");
            b.textContent = `${i + 1}. ${m.current_id || m.user_id}`;
            const sc = document.createElement("span");
            sc.className = "sc";
            sc.textContent = `${i === 0 ? "참여 " : ""}${(m.participation_score ?? 0).toLocaleString()}`;
            cand.appendChild(b);
            cand.appendChild(sc);
            td.appendChild(cand);
          });
          if (notOwn.length > 10) {
            const rest = document.createElement("span");
            rest.className = "cand";
            rest.innerHTML = `<b>…외 ${notOwn.length - 10}명</b>`;
            td.appendChild(rest);
          }
        }
        detail.appendChild(td);

        tr.addEventListener("click", () => tr.classList.toggle("ropen"));
        table.appendChild(tr);
        table.appendChild(detail);
      });
    }

    box.appendChild(table);
    wrap.appendChild(box);
    const foot = document.createElement("div");
    foot.style.cssText = "text-align:center;padding:10px;font-size:12.5px;color:var(--txt3)";
    foot.textContent = `${clsF || "전체"} 39개 룬 · ${entries.length}명 기준`;
    wrap.appendChild(foot);
  }

  // ── 아퀴 매핑 조회 모달 (단일 출처: gamedata.js AQUI_ITEMS — 원본 app.py 상수 이식본) ──
  // 직업을 최대 3개까지 선택해 슬롯별 룬 이름을 나란히 비교한다. 초과 선택 시 가장 오래된 선택 해제.
  let aquiMapSelected = [];

  function toggleAquiMapClass(cls) {
    const idx = aquiMapSelected.indexOf(cls);
    if (idx >= 0) {
      if (aquiMapSelected.length === 1) return; // 최소 1개는 유지
      aquiMapSelected.splice(idx, 1);
    } else {
      aquiMapSelected.push(cls);
      if (aquiMapSelected.length > 3) aquiMapSelected.shift();
    }
    renderAquiMapChips();
    renderAquiMapTable();
  }

  function renderAquiMapChips() {
    const box = document.getElementById("aquiMapClasses");
    box.innerHTML = "";
    GameData.CLASS_OPTIONS.forEach((c) => {
      const chip = document.createElement("span");
      chip.className = "fchip" + (aquiMapSelected.includes(c) ? " on" : "");
      chip.textContent = c;
      chip.addEventListener("click", () => toggleAquiMapClass(c));
      box.appendChild(chip);
    });
  }

  function renderAquiMapTable() {
    const table = document.getElementById("aquiMapTable");
    table.innerHTML = "";
    const hr = document.createElement("tr");
    const addTh = (t) => {
      const th = document.createElement("th");
      th.textContent = t;
      hr.appendChild(th);
    };
    addTh("코드");
    addTh("섹션");
    aquiMapSelected.forEach((c) => addTh(c));
    table.appendChild(hr);

    aquiAllItems().forEach((it) => {
      const tr = document.createElement("tr");
      const tdCode = document.createElement("td");
      tdCode.className = "cnt";
      tdCode.textContent = it.id;
      const tdSec = document.createElement("td");
      tdSec.className = "cnt";
      tdSec.textContent = AQUI_GROUP_META[it.group].label;
      tr.appendChild(tdCode);
      tr.appendChild(tdSec);
      aquiMapSelected.forEach((c) => {
        const td = document.createElement("td");
        const name = GameData.aquiName(it, c);
        if (name) {
          const b = document.createElement("b");
          b.textContent = name;
          td.appendChild(b);
          if (GameData.canBeMythic(it, c)) {
            const tag = document.createElement("span");
            tag.style.cssText = "font-size:10px;color:var(--gold-tx);margin-left:5px";
            tag.textContent = "신화";
            td.appendChild(tag);
          }
        } else {
          td.textContent = "—";
          td.style.color = "var(--txt3)";
          td.title = "매핑 없음 (코드로 표시됨)";
        }
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
  }

  function openAquiMap() {
    if (!aquiMapSelected.length) {
      const clsF = classFilterValue();
      aquiMapSelected = [clsF || GameData.CLASS_OPTIONS[0]];
    }
    renderAquiMapChips();
    renderAquiMapTable();
    document.getElementById("aquiMapBackdrop").classList.add("on");
  }

  function filter() {
    render();
  }

  function setRole(el) {
    document.querySelectorAll(".fchip[data-ri]").forEach((c) => c.classList.remove("on"));
    el.classList.add("on");
    activeRoleFilter = el.dataset.ri;
    render();
  }

  function setView(el) {
    document.querySelectorAll("#memberViewToggle span").forEach((s) => s.classList.remove("on"));
    el.classList.add("on");
    activeView = el.dataset.mv;
    render();
  }

  function setAquiView(el) {
    document.querySelectorAll("#aquiViewSwitch span").forEach((s) => s.classList.remove("on"));
    el.classList.add("on");
    aquiView = el.dataset.av;
    render();
  }

  function setRuneFilter() {
    const prev = runeFilter;
    runeFilter = document.getElementById("qmRune").value || "";
    // 룬 기준 보기의 주 용도는 미보유자 탐색 — 룬을 새로 고르면 "미보유만"을 자동으로 켠다
    if (runeFilter && runeFilter !== prev) onlyNoMode = true;
    if (!runeFilter) onlyNoMode = false;
    render();
  }

  function toggleOnlyNo() {
    onlyNoMode = !onlyNoMode;
    render();
  }

  // ── 장비/아퀴 편집 섹션 (수정 모달 내부, JS로 동적 생성) ──
  function buildEquipEditGrid(equipMap) {
    const grid = document.getElementById("memberEquipGrid");
    grid.innerHTML = "";
    GameData.EQUIPMENT_SLOTS.forEach((slot) => {
      const field = document.createElement("div");
      field.className = "field";
      const label = document.createElement("label");
      label.textContent = slot;
      const sel = document.createElement("select");
      sel.dataset.slot = slot;
      sel.innerHTML = GameData.EQUIPMENT_GRADES.map((g) => `<option value="${g}">${g}</option>`).join("");
      sel.value = GameData.EQUIPMENT_GRADES.includes(equipMap[slot]) ? equipMap[slot] : "희귀";
      field.appendChild(label);
      field.appendChild(sel);
      grid.appendChild(field);
    });
  }

  function buildAquiEditGrid(aquiMap, memberClass) {
    const wrap = document.getElementById("memberAquiEdit");
    wrap.innerHTML = "";
    if (!memberClass) wrap.appendChild(GameData.aquiClassNoticeEl());
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
        const label = GameData.aquiLabelEl(item, memberClass);
        const sel = document.createElement("select");
        sel.dataset.aquiId = item.id;
        const opts = [["", "미보유"], ["l", "전설"]];
        if (GameData.canBeMythic(item, memberClass)) opts.push(["m", "신화"]);
        sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
        const cur = aquiMap[item.id] || "";
        sel.value = cur === "m" && !GameData.canBeMythic(item, memberClass) ? "l" : cur;
        field.appendChild(label);
        field.appendChild(sel);
        grid.appendChild(field);
      });
      wrap.appendChild(grid);
    }
  }

  function collectEquipAquiPayload() {
    const payload = {};
    const equipGrid = document.getElementById("memberEquipGrid");
    if (equipGrid.children.length) {
      const equip = {};
      equipGrid.querySelectorAll("select[data-slot]").forEach((sel) => (equip[sel.dataset.slot] = sel.value));
      payload.equipment_info = JSON.stringify(equip);
    }
    const aquiWrap = document.getElementById("memberAquiEdit");
    if (aquiWrap.children.length) {
      const owned = {};
      aquiWrap.querySelectorAll("select[data-aqui-id]").forEach((sel) => {
        if (sel.value) owned[sel.dataset.aquiId] = sel.value;
      });
      payload.status_check = GameData.buildAquiString(owned);
    }
    return payload;
  }

  // 직업이 바뀌면 아퀴 라벨/신화 선택지를 다시 그림 (현재 선택값 유지)
  function refreshAquiForClass() {
    const wrap = document.getElementById("memberAquiEdit");
    if (!wrap.children.length) return;
    const owned = {};
    wrap.querySelectorAll("select[data-aqui-id]").forEach((sel) => {
      if (sel.value) owned[sel.dataset.aquiId] = sel.value;
    });
    buildAquiEditGrid(owned, document.getElementById("memberClass").value.trim());
  }

  // ── 등록/수정 모달 (하나의 폼을 두 모드로 재사용) ──
  function openCreate() {
    document.getElementById("memberForm").reset();
    document.getElementById("memberForm").dataset.mode = "create";
    document.getElementById("memberForm").dataset.userId = "";
    document.getElementById("memberModalTitle").textContent = "결사원 등록";
    document.getElementById("memberIdRow").classList.remove("hidden");
    document.getElementById("memberUserId").disabled = false;
    document.getElementById("memberPwResetBox").classList.add("hidden");
    document.getElementById("memberLevel").value = 0;
    document.getElementById("memberPower").value = 0;
    document.getElementById("memberEquipDetails").classList.remove("hidden");
    document.getElementById("memberEquipDetails").open = false;
    document.getElementById("memberAquiDetails").classList.remove("hidden");
    document.getElementById("memberAquiDetails").open = false;
    buildEquipEditGrid({});
    buildAquiEditGrid({}, "");
    document.getElementById("memberModalBackdrop").classList.add("on");
  }

  function openEdit(m) {
    document.getElementById("memberForm").reset();
    document.getElementById("memberForm").dataset.mode = "edit";
    document.getElementById("memberForm").dataset.userId = m.user_id;
    document.getElementById("memberModalTitle").textContent = `결사원 수정 — ${m.current_id || m.user_id}`;
    // 아이디/비밀번호는 등록 전용 필드라 수정 모드에서는 숨김(아이디는 PK라 변경 불가, 비번은 아래 별도 재설정 박스 사용).
    document.getElementById("memberIdRow").classList.add("hidden");
    document.getElementById("memberCurrentId").value = m.current_id || "";
    document.getElementById("memberGuild").value = m.guild_name || "";
    document.getElementById("memberClass").value = m.class || "";
    document.getElementById("memberLevel").value = m.level ?? 0;
    document.getElementById("memberPower").value = m.power ?? 0;
    document.getElementById("memberRole").value = m.role || "결사원";
    document.getElementById("memberSubjRank").value = m.subjugation_rank || "";
    document.getElementById("memberAbyss").value = m.abyss_level || "";

    const isAdmin = (Auth.getUser() || {}).role === "관리자";
    document.getElementById("memberPwResetBox").classList.toggle("hidden", !isAdmin);
    document.getElementById("memberNewPw").value = "";

    document.getElementById("memberEquipDetails").classList.remove("hidden");
    document.getElementById("memberEquipDetails").open = false;
    document.getElementById("memberAquiDetails").classList.remove("hidden");
    document.getElementById("memberAquiDetails").open = false;
    buildEquipEditGrid(GameData.parseEquipment(m.equipment_info));
    buildAquiEditGrid(GameData.parseAqui(m.status_check, m.class || ""), m.class || "");

    document.getElementById("memberModalBackdrop").classList.add("on");
  }

  function closeModal() {
    document.getElementById("memberModalBackdrop").classList.remove("on");
  }

  function initMemberModal() {
    document.getElementById("memberAddBtn").addEventListener("click", openCreate);
    document.getElementById("memberCancelBtn").addEventListener("click", closeModal);
    // 직업 변경 시 아퀴 스킬 라벨/신화 선택지 갱신
    document.getElementById("memberClass").addEventListener("change", refreshAquiForClass);

    document.getElementById("memberForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = document.getElementById("memberForm");
      const mode = form.dataset.mode;
      const btn = document.getElementById("memberSaveBtn");
      btn.disabled = true;
      try {
        if (mode === "create") {
          const payload = {
            user_id: document.getElementById("memberUserId").value.trim(),
            password: document.getElementById("memberPassword").value,
            current_id: document.getElementById("memberCurrentId").value.trim(),
            guild_name: document.getElementById("memberGuild").value.trim(),
            class: document.getElementById("memberClass").value.trim(),
            level: parseInt(document.getElementById("memberLevel").value, 10) || 0,
            power: parseInt(document.getElementById("memberPower").value, 10) || 0,
            role: document.getElementById("memberRole").value,
            subjugation_rank: document.getElementById("memberSubjRank").value.trim(),
            abyss_level: document.getElementById("memberAbyss").value.trim(),
            ...collectEquipAquiPayload(),
          };
          await Api.createMember(payload);
          toast(`✓ ${payload.current_id} 등록 완료`);
        } else {
          const payload = {
            current_id: document.getElementById("memberCurrentId").value.trim(),
            guild_name: document.getElementById("memberGuild").value.trim(),
            class: document.getElementById("memberClass").value.trim(),
            level: parseInt(document.getElementById("memberLevel").value, 10) || 0,
            power: parseInt(document.getElementById("memberPower").value, 10) || 0,
            role: document.getElementById("memberRole").value,
            subjugation_rank: document.getElementById("memberSubjRank").value.trim(),
            abyss_level: document.getElementById("memberAbyss").value.trim(),
            ...collectEquipAquiPayload(),
          };
          await Api.updateMember(form.dataset.userId, payload);
          toast("✓ 수정 완료");
        }
        closeModal();
        await load();
      } catch (err) {
        toast(err.message || "저장 실패", true);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("memberPwResetBtn").addEventListener("click", async () => {
      const form = document.getElementById("memberForm");
      const newPw = document.getElementById("memberNewPw").value;
      if (!newPw || newPw.length < 4) {
        toast("비밀번호는 4자 이상이어야 합니다.", true);
        return;
      }
      const btn = document.getElementById("memberPwResetBtn");
      btn.disabled = true;
      try {
        await Api.updateMember(form.dataset.userId, { new_password: newPw });
        document.getElementById("memberNewPw").value = "";
        toast("✓ 비밀번호가 재설정되었습니다");
      } catch (err) {
        toast(err.message || "비밀번호 재설정 실패", true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ── 탈퇴 (2단계 확인) ──
  async function requestDelete(m) {
    try {
      await Api.deleteMember(m.user_id, false);
      pendingDeleteId = m.user_id;
      document.getElementById("memberDeleteModalMsg").textContent =
        `"${m.current_id || m.user_id}"님을 탈퇴 처리할까요? 이 작업은 되돌릴 수 없습니다.`;
      document.getElementById("memberDeleteModalBackdrop").classList.add("on");
    } catch (err) {
      toast(err.message || "탈퇴 확인 실패", true);
    }
  }

  function initDeleteModal() {
    document.getElementById("memberDeleteCancelBtn").addEventListener("click", () => {
      pendingDeleteId = null;
      document.getElementById("memberDeleteModalBackdrop").classList.remove("on");
    });
    document.getElementById("memberDeleteConfirmBtn").addEventListener("click", async () => {
      if (!pendingDeleteId) return;
      try {
        await Api.deleteMember(pendingDeleteId, true);
        document.getElementById("memberDeleteModalBackdrop").classList.remove("on");
        toast("🗑️ 탈퇴 처리되었습니다");
        pendingDeleteId = null;
        await load();
      } catch (err) {
        toast(err.message || "탈퇴 처리 실패", true);
      }
    });
  }

  function init() {
    document.getElementById("qmClass").innerHTML =
      `<option value="">전체 직업</option>` +
      GameData.CLASS_OPTIONS.map((c) => `<option value="${c}">${c}</option>`).join("");
    initMemberModal();
    initDeleteModal();
    initRegConfirmModal();
    document.getElementById("shotCloseBtn").addEventListener("click", () => {
      document.getElementById("shotModalBackdrop").classList.remove("on");
    });
    document.getElementById("aquiMapBtn").addEventListener("click", openAquiMap);
    document.getElementById("aquiMapCloseBtn").addEventListener("click", () => {
      document.getElementById("aquiMapBackdrop").classList.remove("on");
    });
  }

  return { init, load, filter, setRole, setView, setAquiView, setRuneFilter, toggleOnlyNo };
})();
