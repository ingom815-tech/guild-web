// 전력 현황 (전 결사원) — 운영진이 전력 분석에서 "결사원에게 공개"를 누른 시점의
// 편성 스냅샷(app_settings.war_published)을 읽기 전용으로 표시. 디자인은 전력 분석 보드와 동일(.warscope).
const WarStatus = (() => {
  const ROLES = [
    { id: "tank", name: "탱커" },
    { id: "bruiser", name: "브루저" },
    { id: "healer", name: "힐러" },
    { id: "dealer", name: "딜러" },
    { id: "support", name: "서포터" },
  ];
  const RNAME = { tank: "탱커", bruiser: "브루저", healer: "힐러", dealer: "딜러", support: "서포터" };
  const RCOLOR = { tank: "#5B8DD9", bruiser: "#D06060", healer: "#1D9E75", dealer: "#9B59D0", support: "#E8A13C" };
  const PAIRC = ["#1D9E75", "#5B8DD9", "#D06060", "#9B59D0", "#E8A13C", "#854F0B"];

  // { guilds: { 결사명: { published_at, members: [{nick, class, guild, role, pair, main, myth}] } } }
  let snapshot = null;
  let gFilter = "all";

  function toast(msg, isErr) {
    const t = document.getElementById("wsToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 4000);
  }

  async function load() {
    let data;
    try {
      data = await Api.getWarStatus();
    } catch (e) {
      toast(e.message || "전력 현황 조회 실패", true);
      return;
    }
    snapshot = data && data.published ? data : null;
    render();
  }

  function visible(m) {
    return gFilter === "all" || (m.guild || "") === gFilter;
  }

  function render() {
    const empty = document.getElementById("wsEmpty");
    const content = document.getElementById("wsContent");
    const at = document.getElementById("wsPublishedAt");
    const bar = document.getElementById("wsGuildBar");
    bar.querySelectorAll(".mc").forEach((el) => el.remove());

    // 결사별 스냅샷 병합 (각 결사는 운영진이 "저장"한 시점의 편성)
    const guildMap = (snapshot && snapshot.guilds) || {};
    const guildNames = Object.keys(guildMap).filter((g) => (guildMap[g].members || []).length);
    const mem = guildNames.flatMap((g) => guildMap[g].members || []);

    if (!mem.length) {
      empty.style.display = "";
      content.style.display = "none";
      at.textContent = "";
      return;
    }
    empty.style.display = "none";
    content.style.display = "";
    // 결사별 저장 시각 요약 (특정 결사 선택 시 그 결사만)
    const times = (gFilter === "all" ? guildNames : guildNames.filter((g) => g === gFilter))
      .map((g) => `${g} ${guildMap[g].published_at || ""}`);
    at.textContent = times.length ? `저장 시각: ${times.join(" · ")}` : "";

    if (gFilter !== "all" && !guildNames.includes(gFilter)) gFilter = "all";
    const stat = bar.querySelector(".stat");
    [["all", "전체 결사"], ...guildNames.map((g) => [g, g])].forEach(([val, label]) => {
      const chip = document.createElement("span");
      chip.className = "mc" + (gFilter === val ? " on" : "");
      chip.textContent = label;
      chip.addEventListener("click", () => {
        gFilter = val;
        render();
      });
      bar.insertBefore(chip, stat);
    });

    // 역할 보드 (읽기 전용)
    const board = document.getElementById("wsBoard");
    board.innerHTML = "";
    const frag = document.createDocumentFragment();
    ROLES.forEach((r) => {
      const list = mem.filter((m) => m.role === r.id && visible(m));
      const col = document.createElement("div");
      col.className = `role r-${r.id}`;
      col.innerHTML = `<div class="rh">${r.name}<span class="c">${list.length}명</span></div><div class="rbody"></div>`;
      const bodyEl = col.querySelector(".rbody");
      if (!list.length) bodyEl.innerHTML = `<div class="empty-hint">비어 있음</div>`;
      list.forEach((m) => {
        const lv = Number(m.main) || 0;
        const chip = document.createElement("div");
        chip.className = "chip" + (m.myth ? " myth" : "") + (lv > 0 ? " main" : "");
        chip.style.cursor = "default";
        chip.innerHTML = `<span class="nk"></span> <small class="cl"></small>` +
          (lv > 0 ? `<span class="mainstars">${"★".repeat(lv)}</span>` : "") +
          (m.pair != null ? `<span class="pairb" style="background:${PAIRC[(m.pair - 1) % PAIRC.length]}">${m.pair}</span>` : "");
        chip.querySelector(".nk").textContent = m.nick;
        chip.querySelector(".cl").textContent = m.class || "-";
        bodyEl.appendChild(chip);
      });
      frag.appendChild(col);
    });
    board.appendChild(frag);

    // 짝지 편성 스트립 (읽기 전용 — 해제 버튼 없음)
    const pairsMap = {};
    mem.forEach((m) => {
      if (m.pair != null) (pairsMap[m.pair] = pairsMap[m.pair] || []).push(m);
    });
    const pl = document.getElementById("wsPairList");
    pl.innerHTML = "";
    const keys = Object.keys(pairsMap).map(Number).sort((a, b) => a - b);
    if (!keys.length) {
      pl.innerHTML = `<span class="empty-hint">공개된 짝지가 없습니다</span>`;
    }
    keys.forEach((k) => {
      const [a, b] = pairsMap[k];
      const cell = document.createElement("span");
      cell.className = "pcell";
      const pm = (m) => {
        const el = document.createElement("span");
        el.className = "pm";
        if (!m) {
          el.innerHTML = "<b>(상대 없음)</b>";
          return el;
        }
        const pr = document.createElement("span");
        pr.className = "pr";
        pr.style.color = RCOLOR[m.role];
        pr.textContent = RNAME[m.role];
        const nm = document.createElement("b");
        nm.textContent = m.nick;
        el.appendChild(pr);
        el.appendChild(nm);
        return el;
      };
      const badge = document.createElement("span");
      badge.className = "pairb";
      badge.style.background = PAIRC[(k - 1) % PAIRC.length];
      badge.textContent = k;
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = "↔";
      cell.appendChild(badge);
      cell.appendChild(pm(a));
      cell.appendChild(arrow);
      cell.appendChild(pm(b));
      pl.appendChild(cell);
    });
  }

  return { load };
})();
