// 대시보드 — "대시보드_최종통합_시안_v2.html" 레이아웃 구현
// KPI 4칸(무채색) / 직업분포 단색바 / 신화 아퀴룬 보유 표 / 멤버 정렬표+페이지네이션 / 장비·아퀴 인셋 패널 카드
const Dashboard = (() => {
  const PAGE_SIZE = 20;

  // 직업별 신화 아퀴룬 매핑 (0번 데이터 검증 결과와 대조 완료 — 표 컬럼명은 섹션 중립 "신화 1번/2번").
  // 실제 저장 섹션은 룬마다 다름(PVP/지원/PVE 혼재) — 카드 아퀴 뷰는 DB 저장 섹션(ID 접두) 그대로 렌더링.
  const MYTHIC_RUNES = {
    향사수: ["향연의 덫", "관통하는 화살"],
    집행관: ["맹렬한 돌격", "신의 방패"],
    야만투사: ["신수의 발톱", null],
    환영검사: ["암기 투척", "환영검 투척"],
    태양감시자: ["점멸 습격", "황금률의 파도"],
    주문각인사: ["유성 낙하", "고양의 영역"],
    심연추방자: ["휘몰아치는 힘", "심연의 등불"],
  };
  const GROUP_LABELS = { A: "PVP", B: "지원", C: "PVE" };

  let data = null;
  let activeClassTab = "all";
  let cardView = "basic"; // basic | equip | aqui
  let sortKey = "contribution_score";
  let sortDir = -1; // -1 desc, 1 asc
  let page = 0;

  function toast(msg, isErr) {
    const t = document.getElementById("dashToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 4000);
  }

  // 룬 이름 → 해당 직업의 아퀴 ID (없으면 null)
  function runeIdForClass(runeName, cls) {
    if (!runeName || !cls) return null;
    for (const g of ["A", "B", "C"]) {
      for (const item of GameData.AQUI_ITEMS[g]) {
        if (item[cls] === runeName) return item.id;
      }
    }
    return null;
  }

  async function load() {
    try {
      data = await Api.getDashboard();
    } catch (e) {
      toast(e.message || "대시보드 조회 실패", true);
      return;
    }
    sortKey = Auth.isStaff() ? "power" : "participation_score";
    sortDir = -1;
    page = 0;
    renderKpi();
    renderClassBars();
    renderMythTable();
    initFilterOptions();
    renderMemberArea();
  }

  // ── KPI (4칸, 무채색 — 참여율은 전체/데이/나이트 3분할, 데이/나이트는 자리만) ──
  function renderKpi() {
    const k = data.kpi;
    const staff = Auth.isStaff();
    const grid = document.getElementById("kpiGrid");
    grid.className = "kpis" + (staff ? "" : " k3");
    const rate = k.avg_participation_rate != null ? `${k.avg_participation_rate}%` : "-";

    let html = `<div class="kpi"><div class="lb">전체 인원</div><div class="v">${k.total_members}</div><div class="sub">${k.guild_count}개 결사</div></div>`;
    if (staff && k.avg_power != null) {
      html += `<div class="kpi"><div class="lb">평균 전투력</div><div class="v">${(k.avg_power || 0).toLocaleString()}</div><div class="sub">&nbsp;</div></div>`;
    }
    // 데이/나이트 = 조 선택자들의 자기 조 긴급 참여율 평균 (선택자 0명 또는 로그 0건이면 "—")
    const sm = data.shift_metrics || {};
    const dayRate = sm.kpi_day_rate != null ? `${sm.kpi_day_rate}%` : "—";
    const nightRate = sm.kpi_night_rate != null ? `${sm.kpi_night_rate}%` : "—";
    html += `<div class="kpi"><div class="lb">평균 참여율</div>
      <div class="p3">
        <div class="seg"><div class="sv">${rate}</div><div class="slb">전체</div></div>
        <div class="seg"><div class="sv">${dayRate}</div><div class="slb">데이</div></div>
        <div class="seg"><div class="sv">${nightRate}</div><div class="slb">나이트</div></div>
      </div></div>`;
    html += `<div class="kpi"><div class="lb">평균 기여점수</div><div class="v">${(k.avg_contribution || 0).toLocaleString()}</div><div class="sub">&nbsp;</div></div>`;
    grid.innerHTML = html;
    renderShiftWidget();
  }

  // 운영진 전용 한 줄 위젯: 조별 인원 + 이번 회차 긴급 현황 (색 절제, 진회색 숫자)
  function renderShiftWidget() {
    const el = document.getElementById("shiftWidget");
    const sm = data.shift_metrics || {};
    if (!Auth.isStaff() || sm.day_members === undefined) {
      el.innerHTML = "";
      return;
    }
    const coh = (v) => (v != null ? `${v}%` : "—");
    el.innerHTML = `<div class="panel" style="padding:10px 18px;margin-bottom:16px;font-size:13px;display:flex;gap:18px;flex-wrap:wrap;color:var(--txt2)">
      <span>🚨 데이조 <b style="color:var(--txt)">${sm.day_members}</b>명 · 나이트조 <b style="color:var(--txt)">${sm.night_members}</b>명 · 미선택 <b style="color:var(--txt)">${sm.unselected}</b>명</span>
      <span>이번 회차: 데이 쟁지원 <b style="color:var(--txt)">${sm.day_logs}</b>회 (평균 응집률 <b style="color:var(--txt)">${coh(sm.day_cohesion)}</b>) · 나이트 쟁지원 <b style="color:var(--txt)">${sm.night_logs}</b>회 (평균 응집률 <b style="color:var(--txt)">${coh(sm.night_cohesion)}</b>)</span>
    </div>`;
  }

  // ── 직업 분포 (단색 초록, 최다 직업 = 100%) ──
  function setClassTab(el) {
    document.querySelectorAll(".fchip[data-ci]").forEach((c) => c.classList.remove("on"));
    el.classList.add("on");
    activeClassTab = el.dataset.ci;
    renderClassBars();
  }

  function renderClassBars() {
    const raw = (data.class_distribution && data.class_distribution[activeClassTab]) || [];
    // 전체/주력 전환 시 행 수가 달라 패널 높이가 출렁이지 않도록,
    // 항상 전 직업을 0명 포함 고정 행수로 렌더링한다 (탭 전환 = 값만 변화).
    const counts = Object.create(null);
    raw.forEach((r) => {
      counts[r.class] = r.count;
    });
    const names = [...new Set([...GameData.CLASS_OPTIONS, ...raw.map((r) => r.class)])];
    const rows = names.map((c) => ({ class: c, count: counts[c] || 0 })).sort((a, b) => b.count - a.count);
    const el = document.getElementById("classBars");
    if (!rows.length) {
      el.innerHTML = `<div class="gtext">해당 결사원 없음</div>`;
      return;
    }
    const max = Math.max(...rows.map((r) => r.count), 1);
    el.innerHTML = rows
      .map((r) => {
        const w = Math.round((r.count / max) * 100);
        return `<div class="jrow"><span class="nm"></span><div class="bar"><div style="width:${w}%"></div></div><span class="n"${r.count ? "" : ' style="color:var(--txt3)"'}>${r.count}</span></div>`;
      })
      .join("");
    el.querySelectorAll(".jrow .nm").forEach((n, i) => (n.textContent = rows[i].class));
  }

  // ── 신화 아퀴룬 보유 현황 표 ──
  // 보유 판정: 해당 룬 ID가 신화 등급(:m)으로 저장된 경우만 (M1/M2 레거시 토큰 포함 — parseAqui가 m으로 해석).
  // 신화 체크는 신규 오픈 후 수집 예정이라 현재는 대부분 미보유가 정상.
  function renderMythTable() {
    const members = (data.members || []).filter((m) => MYTHIC_RUNES[m.class]);
    // 보유자만 표시 (1개 이상 신화 보유). 없으면 안내 문구.
    const rows = members
      .map((m) => {
        const owned = GameData.parseAqui(m.status_check, m.class);
        const [r1, r2] = MYTHIC_RUNES[m.class];
        const has1 = r1 ? owned[runeIdForClass(r1, m.class)] === "m" : false;
        const has2 = r2 ? owned[runeIdForClass(r2, m.class)] === "m" : false;
        return { m, r1, r2, has1, has2, cnt: (has1 ? 1 : 0) + (has2 ? 1 : 0) };
      })
      .filter((r) => r.cnt > 0);
    rows.sort((a, b) => b.cnt - a.cnt || (b.m.contribution_score || 0) - (a.m.contribution_score || 0));

    document.getElementById("mythMeta").textContent = rows.length ? `${rows.length}명 보유 · 스크롤로 전체` : "";

    if (!rows.length) {
      document.getElementById("mythTable").innerHTML =
        `<tr><td class="gtext" style="text-align:center;padding:24px 10px">아직 신화 아퀴룬 보유자가 없습니다.</td></tr>`;
      return;
    }

    const cell = (name, has, exists) => {
      if (!exists) return `<span class="aq-none">해당 없음</span>`;
      return has ? `<span class="aq-myth"></span>` : `<span class="aq-none">미보유</span>`;
    };
    const table = document.getElementById("mythTable");
    table.innerHTML =
      `<tr><th>아이디</th><th>직업</th><th>신화 1번</th><th>신화 2번</th></tr>` +
      rows
        .map(
          (r) => `<tr>
            <td><b class="nm"></b></td>
            <td class="gtext cls"></td>
            <td>${cell(r.r1, r.has1, !!r.r1)}</td>
            <td>${cell(r.r2, r.has2, !!r.r2)}</td>
          </tr>`,
        )
        .join("");
    // 텍스트는 textContent로 안전하게 주입
    const trs = table.querySelectorAll("tr");
    rows.forEach((r, i) => {
      const tr = trs[i + 1];
      tr.querySelector(".nm").textContent = r.m.current_id || r.m.user_id;
      tr.querySelector(".cls").textContent = r.m.class;
      const badges = tr.querySelectorAll(".aq-myth");
      let bi = 0;
      if (r.has1) badges[bi++].textContent = r.r1;
      if (r.has2) badges[bi++].textContent = r.r2;
    });
  }

  // ── 필터/정렬 옵션 ──
  const SORT_MAP = { 전투력순: "power", 참여점수순: "participation_score", 기여점수순: "contribution_score" };

  function initFilterOptions() {
    const members = data.members || [];
    const staff = Auth.isStaff();

    const classes = [...new Set(members.map((m) => m.class).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
    document.getElementById("dashClassFilter").innerHTML =
      `<option value="전체">직업 전체</option>` + classes.map((c) => `<option value="${c}">${c}</option>`).join("");

    const guilds = [...new Set(members.map((m) => m.guild_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
    document.getElementById("dashGuildFilter").innerHTML =
      `<option value="전체">결사 전체</option>` + guilds.map((g) => `<option value="${g}">${g}</option>`).join("");

    const sorts = staff ? ["전투력순", "참여점수순", "기여점수순"] : ["참여점수순", "기여점수순"];
    document.getElementById("dashSort").innerHTML = sorts.map((s) => `<option value="${s}">${s}</option>`).join("");
  }

  function sortSelect() {
    const v = document.getElementById("dashSort").value;
    sortKey = SORT_MAP[v] || "contribution_score";
    sortDir = -1;
    page = 0;
    renderMemberArea();
  }

  function sortBy(key) {
    if (sortKey === key) {
      sortDir = -sortDir;
    } else {
      sortKey = key;
      sortDir = key === "current_id" || key === "class" || key === "role" ? 1 : -1;
    }
    page = 0;
    renderMemberArea();
  }

  function filteredMembers() {
    const q = (document.getElementById("qd").value || "").trim();
    const cls = document.getElementById("dashClassFilter").value || "전체";
    const guild = document.getElementById("dashGuildFilter").value || "전체";
    let rows = (data.members || []).filter((m) => {
      if (q && !(m.current_id || "").includes(q)) return false;
      if (cls !== "전체" && m.class !== cls) return false;
      if (guild !== "전체" && m.guild_name !== guild) return false;
      return true;
    });
    rows = rows.slice().sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "string" || typeof bv === "string") {
        return String(av || "").localeCompare(String(bv || ""), "ko") * sortDir;
      }
      return ((av || 0) - (bv || 0)) * sortDir;
    });
    return rows;
  }

  function setCardView(el) {
    document.querySelectorAll(".vtoggle span[data-vi]").forEach((c) => c.classList.remove("on"));
    el.classList.add("on");
    cardView = el.dataset.vi;
    page = 0;
    renderMemberArea();
  }

  function filter() {
    page = 0;
    renderMemberArea();
  }

  function renderMemberArea() {
    const rows = filteredMembers();
    const basicWrap = document.getElementById("dashBasicWrap");
    const grid = document.getElementById("memberGrid");
    const empty = document.getElementById("memberGridEmpty");

    basicWrap.style.display = cardView === "basic" && rows.length ? "" : "none";
    grid.style.display = cardView !== "basic" && rows.length ? "grid" : "none";
    empty.style.display = rows.length ? "none" : "block";
    if (!rows.length) return;

    if (cardView === "basic") renderTable(rows);
    else renderCards(rows);
  }

  // ── 기본 뷰: 정렬 가능한 표 + 20명 페이지네이션 ──
  function renderTable(rows) {
    const staff = Auth.isStaff();
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    page = Math.min(page, totalPages - 1);
    const slice = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    const arrow = (key) => (sortKey === key ? (sortDir === -1 ? " ↓" : " ↑") : "");
    const th = (label, key, num) =>
      `<th class="${num ? "num" : ""}" onclick="Dashboard.sortBy('${key}')">${label}${arrow(key)}</th>`;

    let header = "<tr>";
    header += th("닉네임", "current_id");
    header += th("구분", "role");
    header += th("직업", "class");
    header += th("Lv", "level", true);
    if (staff) header += th("전투력", "power", true);
    header += th("참여율", "participation_rate", true);
    header += `<th class="num">데이</th><th class="num">나이트</th>`;
    header += th("기여점수", "contribution_score", true);
    header += "</tr>";

    const bodyHtml = slice
      .map((m) => {
        const isStaffRole = m.role === "운영진" || m.role === "관리자";
        const rate = m.participation_rate != null ? `${m.participation_rate}%` : "—";
        const rateHtml = m.participation_rate != null && m.participation_rate < 50 ? `<span class="low">${rate}</span>` : rate;
        return `<tr>
          <td><b class="nm"></b></td>
          <td><span class="role ${isStaffRole ? "r-staff" : "r-member"}"></span></td>
          <td class="gtext cls"></td>
          <td class="num">${m.level ?? 0}</td>
          ${staff ? `<td class="num"><b>${m.power != null ? m.power.toLocaleString() : "—"}</b></td>` : ""}
          <td class="num">${rateHtml}</td>
          <td class="num gtext">—</td>
          <td class="num gtext">—</td>
          <td class="num">${(m.contribution_score ?? 0).toLocaleString()}</td>
        </tr>`;
      })
      .join("");

    const table = document.getElementById("memberTable");
    table.innerHTML = header + bodyHtml;
    const trs = table.querySelectorAll("tr");
    slice.forEach((m, i) => {
      const tr = trs[i + 1];
      tr.querySelector(".nm").textContent = m.current_id || m.user_id;
      tr.querySelector(".role").textContent = m.role || "";
      tr.querySelector(".cls").textContent = `${m.class || "-"}${m.subjugation_rank ? " · 토벌 " + m.subjugation_rank : ""}`;
    });

    const from = page * PAGE_SIZE + 1;
    const to = Math.min(rows.length, (page + 1) * PAGE_SIZE);
    const pager = document.getElementById("dashPager");
    pager.innerHTML =
      `${page > 0 ? `<span style="cursor:pointer" onclick="Dashboard.goPage(-1)">◂ 이전 · </span>` : ""}` +
      `${from}–${to} / ${rows.length}명` +
      `${to < rows.length ? `<span style="cursor:pointer" onclick="Dashboard.goPage(1)"> · 다음 ▸</span>` : ""}`;
  }

  function goPage(delta) {
    page += delta;
    renderMemberArea();
  }

  // ── 장비/아퀴 카드 공통 헤더 ──
  function cardShell(m) {
    const staff = Auth.isStaff();
    const isStaffRole = m.role === "운영진" || m.role === "관리자";
    const card = document.createElement("div");
    card.className = "mcard";
    card.innerHTML = `
      <div class="hd"><b class="nm"></b><span class="role ${isStaffRole ? "r-staff" : "r-member"}"></span></div>
      <div class="sub"></div>`;
    card.querySelector(".nm").textContent = m.current_id || m.user_id;
    card.querySelector(".role").textContent = m.role || "";
    const subParts = [m.class || "-"];
    if (m.subjugation_rank) subParts.push(`토벌 ${m.subjugation_rank}`);
    let subHtml = subParts.join(" · ");
    if (staff && m.power != null) subHtml += ` · 전투력 <b>${m.power.toLocaleString()}</b>`;
    card.querySelector(".sub").innerHTML = subHtml;
    return card;
  }

  const GRADE_SLOT_CLASS = { 절대자: "abs", 신화: "myth", 전설: "leg", 영웅: "hero", 희귀: "rare" };
  const GRADE_SUM_CLASS = { 절대자: "sa", 신화: "sm", 전설: "sl", 영웅: "sh", 희귀: "sr" };

  // ── 장비 카드: 인셋 패널 + 정사각 슬롯 타일 + 등급 요약 ──
  function gearPanelHtml(m) {
    const equip = GameData.parseEquipment(m.equipment_info);
    const counts = {};
    const slots = GameData.EQUIPMENT_SLOTS.map((slot) => {
      const grade = equip[slot];
      if (grade) counts[grade] = (counts[grade] || 0) + 1;
      const cls = grade ? GRADE_SLOT_CLASS[grade] || "" : "empty";
      return `<div class="slot ${cls}"><span class="part">${slot}</span><span class="gr">${grade || "—"}</span></div>`;
    }).join("");
    const sum = ["절대자", "신화", "전설", "영웅", "희귀"]
      .filter((g) => counts[g])
      .map((g) => `<span class="${GRADE_SUM_CLASS[g]}">${g} <b>${counts[g]}</b></span>`)
      .join("");
    return `<div class="gearpanel">
      <div class="slotgrid">${slots}</div>
      <div class="gearsum">${sum || `<span>장비 정보 없음</span>`}</div>
    </div>`;
  }

  // ── 아퀴 카드: 2층 구조 (액티브 3열 = DB 저장 섹션 그대로 / 패시브 줄 3개) ──
  function aquiPanelHtml(m) {
    const owned = GameData.parseAqui(m.status_check, m.class || "");
    const cols = ["A", "B", "C"]
      .map((g) => {
        const skills = GameData.AQUI_ITEMS[g].filter((it) => !it.id.includes("_"));
        const slotHtml = skills
          .map((it) => {
            const grade = owned[it.id];
            const name = GameData.skillLabel(it, m.class);
            if (!grade) return `<div class="aqslot empty"><div class="nm">미장착</div></div>`;
            const cls = grade === "m" ? "myth" : "on";
            return `<div class="aqslot ${cls}"><div class="nm" title="${name}">${name}</div></div>`;
          })
          .join("");
        return `<div class="aqcol"><div class="ct">${GROUP_LABELS[g]}</div>${slotHtml}</div>`;
      })
      .join("");

    const prows = ["A", "B", "C"]
      .map((g) => {
        const extras = GameData.AQUI_ITEMS[g].filter((it) => it.id.includes("_"));
        let cnt = 0;
        const dots = extras
          .map((it) => {
            const grade = owned[it.id];
            if (grade) cnt++;
            return `<span class="pd ${grade === "m" ? "m" : grade ? "f" : ""}"></span>`;
          })
          .join("");
        return `<div class="prow"><span class="pl">${GROUP_LABELS[g]}</span><div class="pdots">${dots}</div><span class="pcnt">${cnt}/${extras.length}</span></div>`;
      })
      .join("");

    return `<div class="aqpanel">
      <div class="aqcols">${cols}</div>
      <div class="passive">${prows}</div>
    </div>`;
  }

  function renderCards(rows) {
    const grid = document.getElementById("memberGrid");
    grid.innerHTML = "";
    rows.forEach((m) => {
      const card = cardShell(m);
      card.insertAdjacentHTML("beforeend", cardView === "equip" ? gearPanelHtml(m) : aquiPanelHtml(m));
      grid.appendChild(card);
    });
  }

  function init() {}

  return { init, load, filter, setClassTab, setCardView, sortSelect, sortBy, goPage };
})();
