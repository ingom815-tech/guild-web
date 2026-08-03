// 전력 분석 (운영진 전용) — 쟁 오더 작전판. 전력분석탭_시안_v3 구조·인터랙션 그대로.
// 배치/짝지 변경은 즉시 서버 저장(war_roles) — 별도 저장 버튼 없음.
// 표시 데이터(전투력/일정·쟁참여율/신화아퀴/직업/결사)는 전부 기존 소스에서 파생(view=war).
const War = (() => {
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

  let members = []; // {user_id, nick, guild, cls, cp, sch, war, myth, role, pair}
  let guilds = [];
  let gFilter = null; // 현재 결사 페이지 (전체 보기 없음 — 결사별 페이지 4개)
  let poolJob = "all";
  let sortMode = "default"; // default | cp | part
  let pairingFrom = null; // 짝지 지정 중인 user_id

  function toast(msg, isErr) {
    const t = document.getElementById("warToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 4000);
  }

  async function load() {
    try {
      const [data, glist] = await Promise.all([
        Api.getWarBoard(),
        Api.getGuilds().catch(() => []),
      ]);
      members = (data.members || []).map((m) => ({
        user_id: m.user_id,
        nick: m.nick,
        guild: m.guild || "",
        cls: m.class || "-",
        cp: m.power || 0,
        sch: m.sch_rate, // 일정참여율 (null 가능)
        war: m.war_rate, // 쟁참여율 (null 가능)
        myth: !!m.myth,
        role: m.role || null,
        pair: m.pair_no != null ? m.pair_no : null,
        main: Number(m.main) || 0, // 별 0~3
      }));
      guilds = glist || [];
      publishedMap = data.published || {};
    } catch (e) {
      toast(e.message || "전력 분석 조회 실패", true);
      return;
    }
    cancelPair();
    renderGuildBar();
    fillJobSelect();
    renderPublishedInfo();
    render();
  }

  let publishedMap = {}; // 결사별 저장(공개) 시각 {결사명: "YYYY-MM-DD HH:MM"}
  function renderPublishedInfo() {
    const el = document.getElementById("warPublishedInfo");
    const entries = Object.entries(publishedMap);
    if (!entries.length) {
      el.textContent = '아직 저장된 편성이 없습니다 — 편성 후 "저장"을 누르면 결사원 전력 현황 탭에 공개됩니다.';
      return;
    }
    el.textContent = `📢 저장됨(결사원 공개): ${entries.map(([g, at]) => `${g} ${at}`).join(" · ")} — 수정 후 다시 저장하면 반영됩니다.`;
  }

  // ── 상단 결사 페이지 칩 (guilds 동적 — 알파/베타/감마/델타, 페이지처럼 전환) ──
  function memGuild(m) {
    return m.guild || "(미지정)";
  }
  function guildNames() {
    const names = guilds.map((g) => g.name);
    members.forEach((m) => {
      if (!names.includes(memGuild(m))) names.push(memGuild(m));
    });
    return names;
  }
  function renderGuildBar() {
    const bar = document.getElementById("warGuildBar");
    bar.querySelectorAll(".mc").forEach((el) => el.remove());
    const names = guildNames();
    if (!names.includes(gFilter)) gFilter = names[0] || null;
    const stat = bar.querySelector(".stat");
    names.forEach((name) => {
      const chip = document.createElement("span");
      chip.className = "mc" + (gFilter === name ? " on" : "");
      chip.textContent = name;
      chip.addEventListener("click", () => {
        gFilter = name;
        renderGuildBar();
        render();
      });
      bar.insertBefore(chip, stat);
    });
  }

  function fillJobSelect() {
    const sel = document.getElementById("warPoolJob");
    if (sel.options.length) return; // 1회만
    sel.innerHTML =
      `<option value="all">직업 전체</option>` +
      GameData.CLASS_OPTIONS.map((c) => `<option value="${c}">${c}</option>`).join("");
  }

  function visible(m) {
    return memGuild(m) === gFilter;
  }
  const fmtRate = (v) => (v != null ? `${v}%` : "—");

  function render() {
    // ── B파트: 미배치 풀 (결사+직업 필터, 정렬) ──
    const pool = document.getElementById("warPool");
    let unassigned = members.filter((m) => !m.role && visible(m) && (poolJob === "all" || m.cls === poolJob));
    if (sortMode === "cp") unassigned = [...unassigned].sort((a, b) => b.cp - a.cp);
    else if (sortMode === "part") unassigned = [...unassigned].sort((a, b) => (b.sch || 0) - (a.sch || 0));
    pool.innerHTML = "";
    if (!unassigned.length) {
      pool.innerHTML = `<div class="empty-hint">필터 조건의 미배치 결사원이 없습니다</div>`;
    }
    const poolFrag = document.createDocumentFragment();
    unassigned.forEach((m) => {
      const card = document.createElement("div");
      card.className = "pcard" + (m.myth ? " myth" : "");
      card.innerHTML = `
        <div class="n"><span class="nk"></span> <small class="sub"></small> ${m.myth ? '<span class="mythdot">신화아퀴</span>' : ""}</div>
        <div class="s"><span>전투력 <b>${m.cp.toLocaleString()}</b></span><span>일정 <b>${fmtRate(m.sch)}</b></span><span>쟁 <b>${fmtRate(m.war)}</b></span></div>`;
      card.querySelector(".nk").textContent = m.nick;
      card.querySelector(".sub").textContent = `${m.cls} · ${m.guild || "-"}`;
      card.addEventListener("click", (e) => openAssign(e, m.user_id));
      poolFrag.appendChild(card);
    });
    pool.appendChild(poolFrag);

    // ── A파트: 역할 보드 (현재 결사 페이지만) ──
    const board = document.getElementById("warBoard");
    board.innerHTML = "";
    const grid = document.createElement("div");
    grid.className = "warboard";
    ROLES.forEach((r) => {
      const list = members.filter((m) => m.role === r.id && visible(m));
      const col = document.createElement("div");
      col.className = `role r-${r.id}`;
      col.innerHTML = `<div class="rh">${r.name}<span class="c">${list.length}명</span></div><div class="rbody"></div>`;
      const bodyEl = col.querySelector(".rbody");
      if (!list.length) bodyEl.innerHTML = `<div class="empty-hint">비어 있음</div>`;
      list.forEach((m) => {
        const chip = document.createElement("div");
        chip.className = "chip" + (m.myth ? " myth" : "") + (m.main > 0 ? " main" : "");
        chip.innerHTML = `<span class="nk"></span> <small class="cl"></small>` +
          (m.main > 0 ? `<span class="mainstars">${"★".repeat(m.main)}</span>` : "") +
          (m.pair != null ? `<span class="pairb" style="background:${PAIRC[(m.pair - 1) % PAIRC.length]}">${m.pair}</span>` : "");
        chip.querySelector(".nk").textContent = m.nick;
        chip.querySelector(".cl").textContent = m.cls;
        chip.addEventListener("click", (e) => chipClick(e, m.user_id));
        bodyEl.appendChild(chip);
      });
      grid.appendChild(col);
    });
    board.appendChild(grid);

    // ── 짝지 편성 스트립 (역할군 색 + 닉네임 세로 2단 — 현재 결사 짝만) ──
    const pairsMap = {};
    members.forEach((m) => {
      if (m.pair != null) (pairsMap[m.pair] = pairsMap[m.pair] || []).push(m);
    });
    const pl = document.getElementById("warPairList");
    pl.innerHTML = "";
    const keys = Object.keys(pairsMap).map(Number).sort((a, b) => a - b)
      .filter((k) => pairsMap[k].some((m) => visible(m)));
    if (!keys.length) {
      pl.innerHTML = `<span class="empty-hint">아직 짝지가 없습니다 — 배치된 칩을 눌러 "짝지 지정"</span>`;
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
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = "✕";
      x.title = "짝지 해제";
      x.addEventListener("click", () => unpairByNo(k));
      cell.appendChild(badge);
      cell.appendChild(pm(a));
      cell.appendChild(arrow);
      cell.appendChild(pm(b));
      cell.appendChild(x);
      pl.appendChild(cell);
    });

    // ── 카운트 (현재 결사 기준 — 미배치는 빨강 강조) ──
    document.getElementById("warCntDone").textContent = members.filter((m) => m.role && visible(m)).length;
    document.getElementById("warCntLeft").textContent = members.filter((m) => !m.role && visible(m)).length;
  }

  // ── 팝오버 ──
  function showPop(x, y, buildFn) {
    const pop = document.getElementById("warPop");
    pop.innerHTML = "";
    buildFn(pop);
    pop.style.display = "block";
    pop.style.left = Math.min(x, window.innerWidth - 250) + "px";
    pop.style.top = Math.min(y, window.innerHeight - 240) + "px";
    document.getElementById("warOverlay").style.display = "block";
  }
  function closePop() {
    document.getElementById("warPop").style.display = "none";
    document.getElementById("warOverlay").style.display = "none";
  }

  function findM(uid) {
    return members.find((m) => m.user_id === uid);
  }

  function roleBtnsEl(uid) {
    const grid = document.createElement("div");
    grid.className = "rbtns";
    ROLES.forEach((r) => {
      const b = document.createElement("div");
      b.className = `rb ${r.id}`;
      b.textContent = r.name;
      b.addEventListener("click", () => setRole(uid, r.id));
      grid.appendChild(b);
    });
    return grid;
  }

  // 풀 카드 클릭 → 역할 선택 팝오버
  function openAssign(e, uid) {
    const m = findM(uid);
    showPop(e.clientX, e.clientY, (pop) => {
      const h = document.createElement("h4");
      h.textContent = `${m.nick} — 역할 선택`;
      pop.appendChild(h);
      pop.appendChild(roleBtnsEl(uid));
    });
  }

  // 배치 칩 클릭 → 역할 변경/짝지/해제 팝오버 (짝지 지정 중이면 상대 연결)
  function chipClick(e, uid) {
    e.stopPropagation();
    if (pairingFrom !== null) {
      completePair(uid);
      return;
    }
    const m = findM(uid);
    showPop(e.clientX, e.clientY, (pop) => {
      const h = document.createElement("h4");
      h.textContent = m.nick;
      const rl = document.createElement("span");
      rl.style.color = RCOLOR[m.role];
      rl.textContent = ` · ${RNAME[m.role]}`;
      h.appendChild(rl);
      pop.appendChild(h);
      pop.appendChild(roleBtnsEl(uid));
      const sep = document.createElement("div");
      sep.className = "sep";
      pop.appendChild(sep);
      const pairAct = document.createElement("div");
      pairAct.className = "act";
      pairAct.textContent = `짝지 지정${m.pair != null ? ` (현재 ${m.pair}번)` : ""}`;
      pairAct.addEventListener("click", () => startPair(uid));
      pop.appendChild(pairAct);
      if (m.pair != null) {
        const unAct = document.createElement("div");
        unAct.className = "act";
        unAct.textContent = "짝지 해제";
        unAct.addEventListener("click", () => unpairMember(uid));
        pop.appendChild(unAct);
      }
      // 메인 등급: ★ / ★★ / ★★★ / 해제 (현재 등급은 강조)
      const mainRow = document.createElement("div");
      mainRow.className = "mainrow";
      const lab = document.createElement("span");
      lab.textContent = "메인";
      mainRow.appendChild(lab);
      [1, 2, 3].forEach((lv) => {
        const b = document.createElement("span");
        b.className = "ms" + (m.main === lv ? " on" : "");
        b.textContent = "★".repeat(lv);
        b.addEventListener("click", () => setMainLevel(uid, lv));
        mainRow.appendChild(b);
      });
      const off = document.createElement("span");
      off.className = "ms off" + (m.main === 0 ? " on" : "");
      off.textContent = "해제";
      off.addEventListener("click", () => setMainLevel(uid, 0));
      mainRow.appendChild(off);
      pop.appendChild(mainRow);
      const del = document.createElement("div");
      del.className = "act danger";
      del.textContent = "배치 해제 (풀로 되돌리기)";
      del.addEventListener("click", () => unassign(uid));
      pop.appendChild(del);
    });
  }

  // ── 액션 (낙관적 업데이트 — 화면 즉시 반영, 저장은 백그라운드, 실패 시 재조회로 원복) ──
  function saveBg(promise, failMsg) {
    promise.catch((e) => {
      toast((e && e.message) || failMsg, true);
      load(); // 서버 상태로 원복
    });
  }

  function setRole(uid, role) {
    closePop();
    findM(uid).role = role;
    render();
    saveBg(Api.setWarRole(uid, role), "역할 저장 실패");
  }

  function unassign(uid) {
    closePop();
    const m = findM(uid);
    if (m.pair != null) {
      const no = m.pair;
      members.forEach((x) => {
        if (x.pair === no) x.pair = null;
      });
    }
    m.role = null;
    render();
    saveBg(Api.setWarRole(uid, null), "배치 해제 실패");
  }

  function startPair(uid) {
    pairingFrom = uid;
    closePop();
    document.getElementById("warPairBanner").style.display = "block";
  }

  function completePair(targetUid) {
    if (targetUid === pairingFrom) {
      cancelPair();
      return;
    }
    const a = pairingFrom;
    cancelPair();
    // 양쪽의 기존 짝 자동 해제 + 임시 번호로 즉시 표시 (서버 확정 번호로 뒤에서 치환)
    const oldNos = new Set([findM(a).pair, findM(targetUid).pair].filter((n) => n != null));
    members.forEach((m) => {
      if (oldNos.has(m.pair)) m.pair = null;
    });
    const tempNo = Math.max(0, ...members.map((m) => m.pair || 0)) + 1;
    findM(a).pair = tempNo;
    findM(targetUid).pair = tempNo;
    render();
    saveBg(
      Api.setWarPair(a, targetUid).then((res) => {
        if (res.pair_no !== tempNo) {
          // 서버가 부여한 실제 번호로 조용히 교체 (색/번호 일관성)
          if (findM(a).pair === tempNo) findM(a).pair = res.pair_no;
          if (findM(targetUid).pair === tempNo) findM(targetUid).pair = res.pair_no;
          render();
        }
      }),
      "짝지 저장 실패",
    );
  }

  function cancelPair() {
    pairingFrom = null;
    const b = document.getElementById("warPairBanner");
    if (b) b.style.display = "none";
  }

  function unpairByNo(no) {
    const one = members.find((m) => m.pair === no);
    if (!one) return;
    members.forEach((m) => {
      if (m.pair === no) m.pair = null;
    });
    render();
    saveBg(Api.clearWarPair(one.user_id), "짝지 해제 실패");
  }

  function unpairMember(uid) {
    closePop();
    const m = findM(uid);
    if (m.pair != null) unpairByNo(m.pair);
  }

  // 메인 등급 지정 (별 0~3 — 낙관적)
  function setMainLevel(uid, level) {
    closePop();
    findM(uid).main = level;
    render();
    saveBg(Api.setWarMain(uid, level), "메인 지정 저장 실패");
  }

  function init() {
    // 저장 = 현재 결사 페이지의 편성 스냅샷 발행
    document.getElementById("warPublishBtn").addEventListener("click", async () => {
      if (!gFilter || gFilter === "(미지정)") {
        toast("소속 결사가 지정된 결사만 저장할 수 있습니다", true);
        return;
      }
      const btn = document.getElementById("warPublishBtn");
      btn.disabled = true;
      btn.textContent = "저장 중...";
      try {
        const res = await Api.publishWar(gFilter);
        publishedMap[gFilter] = res.published_at;
        renderPublishedInfo();
        toast(`💾 저장 완료 — ${gFilter} 편성이 전력 현황 탭에 공개되었습니다 (${res.count}명)`);
      } catch (e) {
        toast(e.message || "저장 실패", true);
      } finally {
        btn.disabled = false;
        btn.textContent = "💾 저장";
      }
    });
    document.getElementById("warOverlay").addEventListener("click", closePop);
    document.getElementById("warPoolJob").addEventListener("change", (e) => {
      poolJob = e.target.value;
      render();
    });
    document.querySelectorAll("#warSortSeg span").forEach((s) => {
      s.addEventListener("click", () => {
        sortMode = s.dataset.s;
        document.querySelectorAll("#warSortSeg span").forEach((x) => x.classList.toggle("on", x === s));
        render();
      });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        cancelPair();
        closePop();
      }
    });
  }

  return { init, load };
})();
