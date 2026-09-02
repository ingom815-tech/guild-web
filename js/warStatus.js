// 전력 현황 (전 결사원) — 운영진이 전력 분석에서 "결사원에게 공개"를 누른 시점의
// 편성 스냅샷(app_settings.war_published)을 읽기 전용으로 표시. 디자인은 전력 분석 보드와 동일(.warscope).
const WarStatus = (() => {
  const ROLES = [
    { id: "tank", name: "탱커" },
    { id: "bruiser", name: "브루저" },
    { id: "mdealer", name: "마딜러" },
    { id: "pdealer", name: "물딜러" },
    { id: "support", name: "서포터" },
    { id: "healer", name: "힐러" },
  ];
  const RNAME = { tank: "탱커", bruiser: "브루저", mdealer: "마딜러", pdealer: "물딜러", support: "서포터", healer: "힐러" };
  const RCOLOR = { tank: "#5B8DD9", bruiser: "#D06060", mdealer: "#9B59D0", pdealer: "#2E9CB8", support: "#E8A13C", healer: "#1D9E75" };
  const PAIRC = ["#1D9E75", "#5B8DD9", "#D06060", "#9B59D0", "#E8A13C", "#854F0B"];
  // 저장 시점이 6종 개편 이전인 스냅샷의 'dealer' 정규화 (0023 이관 기준과 동일)
  const MAGIC_CLASSES = ["태양감시자", "주문각인사"];
  function normRole(role, cls) {
    if (role === "dealer") return MAGIC_CLASSES.includes(cls) ? "mdealer" : "pdealer";
    return role;
  }

  // { guilds: { 결사명: { published_at, members: [{nick, class, guild, role, pair, main, myth}] } } }
  let snapshot = null;
  let classStatus = {}; // 실시간 클래스현황 {결사: [{nick, class, next_class, myth}]} — 내정보 저장 즉시 반영
  let gFilter = null; // 현재 결사 페이지 (전체 보기 없음)
  let viewMode = "roles"; // roles | line(전력판) | class(클래스현황)
  let segWired = false;
  let publicGuilds = null; // 결사 버튼은 스냅샷 유무와 무관하게 항상 표시 (register GET — 무인증 결사 목록)
  const LINES = [
    { id: "front", name: "전위" },
    { id: "mid", name: "중위" },
    { id: "rear", name: "후위" },
  ];

  function toast(msg, isErr) {
    const t = document.getElementById("wsToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 4000);
  }

  function wireSeg() {
    if (segWired) return;
    segWired = true;
    document.querySelectorAll("#wsViewSeg span").forEach((s) => {
      s.addEventListener("click", () => {
        viewMode = s.dataset.v;
        document.querySelectorAll("#wsViewSeg span").forEach((x) => x.classList.toggle("on", x === s));
        document.getElementById("wsBoard").style.display = viewMode === "roles" ? "" : "none";
        document.getElementById("wsLineBoard").style.display = viewMode === "line" ? "" : "none";
        document.getElementById("wsClassBoard").style.display = viewMode === "class" ? "" : "none";
      });
    });
  }

  async function load() {
    wireSeg();
    let data;
    try {
      data = await Api.getWarStatus();
      if (!publicGuilds) publicGuilds = ((await Api.getPublicGuilds().catch(() => [])) || []).map((g) => g.name).filter(Boolean);
    } catch (e) {
      toast(e.message || "전력 현황 조회 실패", true);
      return;
    }
    snapshot = data && data.published ? data : null;
    classStatus = (data && data.class_status) || {};
    render();
  }

  function visible(m) {
    return (m.guild || "(미지정)") === gFilter;
  }

  function render() {
    const empty = document.getElementById("wsEmpty");
    const content = document.getElementById("wsContent");
    const at = document.getElementById("wsPublishedAt");
    const bar = document.getElementById("wsGuildBar");
    bar.querySelectorAll(".mc").forEach((el) => el.remove());

    // 결사별 스냅샷 병합 (각 결사는 운영진이 "저장"한 시점의 편성)
    // 결사 버튼은 공개 결사 목록 기준으로 항상 전부 표시 — 스냅샷 없는 결사는 빈 보드 안내
    const guildMap = (snapshot && snapshot.guilds) || {};
    const snapNames = Object.keys(guildMap).filter(
      (g) => (guildMap[g].members || []).length || (guildMap[g].class_members || []).length,
    );
    const guildNames = [...(publicGuilds || [])];
    snapNames.forEach((g) => {
      if (!guildNames.includes(g)) guildNames.push(g);
    });
    Object.keys(classStatus).forEach((g) => {
      if ((classStatus[g] || []).length && !guildNames.includes(g)) guildNames.push(g);
    });
    const mem = snapNames.flatMap((g) => guildMap[g].members || [])
      .map((m) => ({ ...m, role: normRole(m.role, m.class || "-") }));

    if (!guildNames.length) {
      empty.style.display = "";
      content.style.display = "none";
      at.textContent = "";
      return;
    }
    empty.style.display = "none";
    content.style.display = "";
    if (!guildNames.includes(gFilter)) gFilter = guildNames[0] || null;
    // 현재 결사의 저장 시각 (스냅샷 없으면 안내)
    at.textContent = gFilter && guildMap[gFilter]
      ? `저장 시각: ${gFilter} ${guildMap[gFilter].published_at || ""}`
      : `${gFilter || ""} — 아직 저장된 기록이 없습니다 (운영진이 전력 분석에서 저장하면 표시됩니다)`;

    const stat = bar.querySelector(".stat");
    guildNames.forEach((g) => {
      const chip = document.createElement("span");
      chip.className = "mc" + (gFilter === g ? " on" : "");
      chip.textContent = g;
      chip.addEventListener("click", () => {
        gFilter = g;
        render();
      });
      bar.insertBefore(chip, stat);
    });

    // 본인 칩 강조용 — 로그인한 결사원의 닉네임 (Auth는 const라 window에 안 붙음 — typeof 가드)
    const myNick = (typeof Auth !== "undefined" && Auth.getUser && (Auth.getUser() || {}).current_id) || null;

    // 역할 보드 (읽기 전용 — 시안: 흰 헤더에 역할명·인원·신화 수, 2단 칩(직업 위/닉 아래))
    const board = document.getElementById("wsBoard");
    board.innerHTML = "";
    const frag = document.createDocumentFragment();
    ROLES.forEach((r) => {
      const list = mem.filter((m) => m.role === r.id && visible(m));
      const mythCnt = list.filter((m) => m.myth).length;
      const col = document.createElement("div");
      col.className = `role r-${r.id}`;
      col.innerHTML =
        `<div class="rh2"><span class="rn" style="color:${RCOLOR[r.id]}">${r.name}</span><span class="cnt">${list.length}명</span>` +
        `<div class="rs">신화 ${mythCnt}</div></div><div class="rbody"></div>`;
      const bodyEl = col.querySelector(".rbody");
      if (!list.length) bodyEl.innerHTML = `<div class="empty-hint">비어 있음</div>`;
      list.forEach((m) => {
        const lv = Number(m.main) || 0;
        const me = myNick && m.nick === myNick;
        const chip = document.createElement("div");
        chip.className = "chip wchip" + (m.myth ? " myth" : "") + (lv > 0 ? ` m${lv}` : "") + (me ? " me" : "");
        chip.style.cursor = "default";
        chip.innerHTML = `<small class="cl"></small><div class="nkrow"><span class="nk"></span>` +
          (m.pair != null ? `<span class="pairb" style="background:${PAIRC[(m.pair - 1) % PAIRC.length]}">${m.pair}</span>` : "") +
          `</div>` +
          (lv > 0 ? `<span class="mainstars">${"★".repeat(lv)}</span>` : "") +
          (me ? `<span class="mebadge">나</span>` : "");
        chip.querySelector(".nk").textContent = m.nick.length > 5 ? m.nick.slice(0, 5) + "…" : m.nick;
        chip.querySelector(".cl").textContent = m.class || "-";
        chip.title = m.nick;
        bodyEl.appendChild(chip);
      });
      frag.appendChild(col);
    });
    board.appendChild(frag);

    // 전력판 (전위/중위/후위 가로 행 — 읽기 전용, 섹터 지정된 인원만)
    // 칩 단순화: 직업+닉+별 배지만. 짝지 = 같은 색 테두리 + 나란히 정렬(짝 번호순).
    const lb = document.getElementById("wsLineBoard");
    lb.innerHTML = "";
    const lwrap = document.createElement("div");
    lwrap.className = "linecols";
    LINES.forEach((sec) => {
      const list = mem.filter((m) => m.line === sec.id && visible(m))
        .sort((a, b) => (a.pair == null ? 1e9 : a.pair) - (b.pair == null ? 1e9 : b.pair));
      const col = document.createElement("div");
      col.className = `role lcol l-${sec.id}`;
      col.innerHTML = `<div class="rh">${sec.name}<span class="c">${list.length}명</span></div><div class="rbody"></div>`;
      const bodyEl = col.querySelector(".rbody");
      if (!list.length) bodyEl.innerHTML = `<div class="empty-hint">비어 있음</div>`;
      list.forEach((m) => {
        const lv = Number(m.main) || 0;
        const me = myNick && m.nick === myNick;
        const chip = document.createElement("div");
        chip.className = "chip wchip" + (me ? " me" : "");
        chip.style.cursor = "default";
        chip.innerHTML = `<small class="cl"></small><div class="nkrow"><span class="nk"></span></div>` +
          (lv > 0 ? `<span class="mainstars">${"★".repeat(lv)}</span>` : "") +
          (me ? `<span class="mebadge">나</span>` : "");
        chip.querySelector(".nk").textContent = m.nick.length > 5 ? m.nick.slice(0, 5) + "…" : m.nick;
        chip.querySelector(".cl").textContent = m.class || "-";
        chip.title = m.pair != null ? `${m.nick} · 짝지 ${m.pair}번` : m.nick;
        if (m.pair != null) chip.style.border = `2px solid ${PAIRC[(m.pair - 1) % PAIRC.length]}`;
        bodyEl.appendChild(chip);
      });
      lwrap.appendChild(col);
    });
    lb.appendChild(lwrap);

    // 클래스현황 (읽기 전용 — 실시간: 내정보에서 클래스변경 저장 즉시 반영, 운영진 저장 불필요)
    // 배치 기준: 클래스변경(next_class) 선택자는 변경 클래스 섹터, 미선택자는 현재 직업 섹터.
    // 7개 직업 섹터는 인원이 없어도 항상 미리 표시. 신화아퀴 보유자는 금테 + "신화" 배지 강조.
    const cb = document.getElementById("wsClassBoard");
    cb.innerHTML = "";
    const hint = document.createElement("div");
    hint.className = "meta";
    hint.style.margin = "0 0 8px";
    hint.textContent = "클래스현황은 실시간입니다 — 내정보에서 클래스변경을 저장하면 바로 반영됩니다.";
    cb.appendChild(hint);
    const cwrap = document.createElement("div");
    cwrap.className = "linecols";
    const classMembers = (gFilter && classStatus[gFilter]) || [];
    const CLASS7 = GameData.CLASS_OPTIONS;
    {
      const effClass = (m) => (m.next_class && CLASS7.includes(m.next_class) ? m.next_class : m.class);
      const sectors = [...CLASS7, "(미지정)"];
      sectors.forEach((cls) => {
        const list = classMembers.filter((m) => (effClass(m) && sectors.includes(effClass(m)) ? effClass(m) : "(미지정)") === cls);
        if (cls === "(미지정)" && !list.length) return; // 미지정은 있을 때만
        const mythCnt = list.filter((m) => m.myth).length;
        const col = document.createElement("div");
        col.className = "role lcol c-class";
        col.innerHTML = `<div class="rh"><span class="cname">${cls}</span><span class="c">${list.length}명 · 신화 ${mythCnt}</span></div><div class="rbody"></div>`;
        const bodyEl = col.querySelector(".rbody");
        if (!list.length) bodyEl.innerHTML = `<div class="empty-hint">비어 있음</div>`;
        list.sort((a, b) => (b.myth ? 1 : 0) - (a.myth ? 1 : 0) || String(a.nick).localeCompare(String(b.nick), "ko"));
        list.forEach((m) => {
          const me = myNick && m.nick === myNick;
          const changed = m.next_class && CLASS7.includes(m.next_class) && m.next_class !== m.class;
          const chip = document.createElement("div");
          chip.className = "chip wchip" + (m.myth ? " myth" : "") + (me ? " me" : "");
          chip.style.cursor = "default";
          chip.innerHTML = `<small class="cl"></small><div class="nkrow"><span class="nk"></span></div>` +
            (m.myth ? `<span class="mythtag">신화</span>` : "") +
            (me ? `<span class="mebadge">나</span>` : "");
          chip.querySelector(".cl").textContent = changed ? `${m.class || "-"} ➜ 변경` : " ";
          chip.querySelector(".nk").textContent = String(m.nick).length > 5 ? String(m.nick).slice(0, 5) + "…" : m.nick;
          chip.title = changed ? `${m.nick} · ${m.class || "-"} → ${m.next_class}` : m.nick;
          bodyEl.appendChild(chip);
        });
        cwrap.appendChild(col);
      });
      cb.appendChild(cwrap);
    }

    // 짝지 편성 스트립 (읽기 전용 — 현재 결사 짝만, 해제 버튼 없음)
    const pairsMap = {};
    mem.forEach((m) => {
      if (m.pair != null && visible(m)) (pairsMap[m.pair] = pairsMap[m.pair] || []).push(m);
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
