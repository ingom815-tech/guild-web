// 대시보드: KPI + 직업 분포 + 주요 아퀴 보유 현황 + 회원 카드 목록 (전 회원 조회 가능)
const Dashboard = (() => {
  // 원본 app.py CLASS_ICONS 그대로.
  const CLASS_ICONS = {
    집행관: "🛡️", 향사수: "🏹", 주문각인사: "🪄", 환영검사: "⚔️",
    태양감시자: "☀️", 심연추방자: "🌀", 야만투사: "🪓",
    음유시인: "🎵", 사제: "✝️", 흑마법사: "🔮", 연금술사: "⚗️",
    암살자: "🗡️", 광전사: "💢", 도적: "🥷", 레인저: "🌿",
  };
  const BAR_COLORS = ["#60a5fa", "#f59e0b", "#34d399", "#a78bfa", "#f472b6", "#fb923c", "#38bdf8", "#4ade80", "#e879f9", "#facc15"];

  let data = null;
  let activeClassTab = "all";

  function toast(msg, isErr) {
    const t = document.getElementById("dashToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 4000);
  }

  async function load() {
    try {
      data = await Api.getDashboard();
    } catch (e) {
      toast(e.message || "대시보드 조회 실패", true);
      return;
    }
    renderKpi();
    renderClassBars();
    renderKeyAqui();
    initFilterOptions();
    renderCards();
  }

  function kpiHtml(label, value, color, sub) {
    return `<div class="kpi"><div class="lbl">${label}</div><div class="val" style="color:${color}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
  }

  function renderKpi() {
    const k = data.kpi;
    const staff = Auth.isStaff();
    const rate = k.avg_participation_rate != null ? `${k.avg_participation_rate}%` : "-";
    let html = kpiHtml("전체 인원", `${k.total_members}명`, "#60a5fa", `${k.guild_count}개 결사`);
    if (staff && k.avg_power != null) html += kpiHtml("평균 전투력", (k.avg_power || 0).toLocaleString(), "#f59e0b", "");
    html += kpiHtml("평균 전체 참여율", rate, "#34d399", "");
    html += kpiHtml("평균 기여점수", (k.avg_contribution || 0).toLocaleString(), "#a78bfa", "");
    if (staff && k.pending_requests != null) {
      html += kpiHtml("분배 대기", `${k.pending_requests}건`, k.pending_requests > 0 ? "#ef4444" : "#6b7280", "");
    }
    document.getElementById("kpiGrid").innerHTML = html;
  }

  function setClassTab(el) {
    document.querySelectorAll(".fchip[data-ci]").forEach((c) => c.classList.remove("on"));
    el.classList.add("on");
    activeClassTab = el.dataset.ci;
    renderClassBars();
  }

  function renderClassBars() {
    const rows = (data.class_distribution && data.class_distribution[activeClassTab]) || [];
    const el = document.getElementById("classBars");
    if (!rows.length) {
      el.innerHTML = `<div class="meta">해당 결사원 없음</div>`;
      return;
    }
    const max = Math.max(...rows.map((r) => r.count));
    el.innerHTML = rows
      .map((r, i) => {
        const w = max ? Math.round((r.count / max) * 100) : 0;
        const color = BAR_COLORS[i % BAR_COLORS.length];
        const icon = CLASS_ICONS[r.class] || "";
        return `<div class="cbar-row">
          <span class="cls">${icon} ${r.class}</span>
          <span class="track"><span class="fill" style="width:${w}%;background:${color}"></span></span>
          <span class="cnt">${r.count}</span>
        </div>`;
      })
      .join("");
  }

  function renderKeyAqui() {
    const el = document.getElementById("keyAquiCards");
    el.innerHTML = (data.key_aqui || [])
      .map((t) => {
        const owners = t.owners && t.owners.length
          ? t.owners.map((n) => `<div>${n}</div>`).join("")
          : `<div style="color:var(--txt3)">없음</div>`;
        return `<div class="aqui-card" style="border-color:${t.color}55">
          <div class="ttl" style="color:${t.color}">${t.label} <span style="color:var(--txt3);font-weight:500;font-size:11px">(${(t.owners || []).length}명)</span></div>
          <div class="cls">${(t.classes || []).join(" / ")}</div>
          <div class="owners">${owners}</div>
        </div>`;
      })
      .join("");
  }

  function initFilterOptions() {
    const members = data.members || [];
    const staff = Auth.isStaff();

    const classes = [...new Set(members.map((m) => m.class).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
    document.getElementById("dashClassFilter").innerHTML =
      `<option value="전체">⚔️ 직업 전체</option>` + classes.map((c) => `<option value="${c}">${c}</option>`).join("");

    const guilds = [...new Set(members.map((m) => m.guild_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
    document.getElementById("dashGuildFilter").innerHTML =
      `<option value="전체">🏰 결사 전체</option>` + guilds.map((g) => `<option value="${g}">${g}</option>`).join("");

    // 정렬 옵션: 운영진은 전투력순 포함, 일반 회원은 참여/기여만 (원본과 동일).
    const sorts = staff ? ["전투력순", "참여점수순", "기여점수순"] : ["참여점수순", "기여점수순"];
    document.getElementById("dashSort").innerHTML = sorts.map((s) => `<option value="${s}">${s}</option>`).join("");
  }

  function renderCards() {
    const grid = document.getElementById("memberGrid");
    const q = (document.getElementById("qd").value || "").trim();
    const cls = document.getElementById("dashClassFilter").value || "전체";
    const guild = document.getElementById("dashGuildFilter").value || "전체";
    const sort = document.getElementById("dashSort").value;
    const staff = Auth.isStaff();

    let rows = (data.members || []).filter((m) => {
      if (q && !(m.current_id || "").includes(q)) return false;
      if (cls !== "전체" && m.class !== cls) return false;
      if (guild !== "전체" && m.guild_name !== guild) return false;
      return true;
    });

    const key = sort === "전투력순" ? "power" : sort === "참여점수순" ? "participation_score" : "contribution_score";
    rows = rows.slice().sort((a, b) => (b[key] || 0) - (a[key] || 0));

    document.getElementById("memberGridEmpty").style.display = rows.length ? "none" : "block";
    grid.innerHTML = "";
    rows.forEach((m) => {
      const card = document.createElement("div");
      card.className = "mcard";
      const icon = CLASS_ICONS[m.class] || "";
      card.innerHTML = `
        <div class="hd">
          <span class="nm"></span>
          <span class="role-badge ${m.role || ""}"></span>
        </div>
        <div class="meta-line"></div>
        <div class="stat"><span>Lv</span><b>${m.level ?? 0}</b></div>
        ${staff ? `<div class="stat"><span>전투력</span><b>${(m.power ?? 0).toLocaleString()}</b></div>` : ""}
        <div class="stat"><span>참여율</span><b>${m.participation_rate != null ? m.participation_rate + "%" : "-"}</b></div>
        <div class="stat"><span>기여점수</span><b>${(m.contribution_score ?? 0).toLocaleString()}</b></div>`;
      card.querySelector(".nm").textContent = m.current_id || m.user_id;
      card.querySelector(".role-badge").textContent = m.role || "";
      card.querySelector(".meta-line").textContent =
        `${icon} ${m.class || "-"} · ${m.guild_name || "-"}` + (m.subjugation_rank ? ` · 토벌 ${m.subjugation_rank}` : "");
      grid.appendChild(card);
    });
  }

  function filter() {
    renderCards();
  }

  function init() {}

  return { init, load, filter, setClassTab };
})();
