// 분배 신청 화면 — 지망제 (분배신청_지망제_시안): 규칙 한 줄 + 자격 배너 + 내 지망 스트립 +
// 행 펼침(1·2·3순위 지망 등록 + 지망자 전원 공개). 자유 신청(유찰/대량 소모품/심연석)은 지망 칸 없이 토글.
// 자격 판정·선정은 전부 서버(can_apply/RPC) 기준 — 화면의 "현재 유력/순위 밖"은 실시간 참고 표시.
const Distribution = (() => {
  const GRADE_BADGE = { 신화: "b-myth", 전설: "b-legend", 영웅: "b-hero", 희귀: "b-rare" };
  let data = null; // GET view=items 응답
  let myRequests = []; // 내 대기 신청 (지망 스트립/해제용, wish_rank 포함)
  let activeFilter = "전체";
  let openNames = new Set(); // 재렌더 후에도 펼침 상태 유지
  let applyTarget = null; // 모달 대상 { g, rank } (rank null = 자유 신청 수량 입력)
  let pendingFocus = null; // 결사 창고에서 넘어올 때 포커스할 아이템명

  function toast(msg, isErr) {
    const t = document.getElementById("applyToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 5000);
  }

  // DB의 기간 시각은 KST 벽시계값(타임존 없음) — 문자열을 그대로 표시하고,
  // 비교할 때만 서버와 같은 방식(문자열을 UTC로 해석 vs 현재+9h)을 쓴다.
  function fmtNaive(ts) {
    if (!ts) return "-";
    return String(ts).replace("T", " ").slice(0, 16);
  }
  function naiveEpoch(ts) {
    const s = String(ts).replace(" ", "T");
    return new Date(s.endsWith("Z") ? s : s + "Z").getTime();
  }
  function kstNowEpoch() {
    return Date.now() + 9 * 3600 * 1000;
  }
  function periodActive() {
    return !!(data && data.period && data.period.status === "진행중");
  }
  function myUid() {
    return (Auth.getUser() || {}).user_id;
  }
  function cat5(g) {
    return GameData.category5(g.item_name, g.category, g.grade);
  }
  function groupOfReq(r) {
    return (data.groups || []).find((g) => (g.item_ids || []).includes(r.item_id)) || null;
  }
  function myPendingWish(rank) {
    return myRequests.find((r) => r.wish_rank === rank) || null;
  }
  function myPendingForGroup(g, wishOnly) {
    const ids = g.item_ids || [];
    return myRequests.find((r) => ids.includes(r.item_id) && (wishOnly ? r.wish_rank != null : r.wish_rank == null)) || null;
  }

  // 현재 시점 선정 시뮬레이션 (표시용): 1→2→3순위 풀 순서로 재고 수량만큼.
  // 자유 신청은 기여점수순 상위 N. 서버 확정(R3 잔여 취소 등)의 실시간 근사치.
  function simWinners(g) {
    const winners = [];
    let remaining = g.quantity || 0;
    const apps = g.applicants || [];
    if (g.is_free) {
      for (const a of apps) {
        if (remaining <= 0) break;
        winners.push(a);
        remaining--;
      }
      return winners;
    }
    for (const r of [1, 2, 3]) {
      for (const a of apps.filter((x) => x.rank === r)) {
        if (remaining <= 0) return winners;
        winners.push(a);
        remaining--;
      }
    }
    return winners;
  }

  async function load() {
    try {
      const [items, my] = await Promise.all([Api.getDistributionItems(), Api.getMyRequests()]);
      data = items;
      myRequests = my;
    } catch (e) {
      toast(e.message || "분배 정보 조회 실패", true);
      return;
    }
    // 신화 등급은 분배 신청 대상이 아님 — 운영진 수동 분배 (창고에서 "문의" 안내)
    data.groups = (data.groups || []).filter((g) => g.grade !== "신화");
    if (data.auto_confirmed > 0) {
      toast(`⏰ 신청 기간이 마감되어 ${data.auto_confirmed}건이 자동 확정되었습니다.`);
    }
    renderPeriod();
    renderBanner();
    renderWishStrip();
    renderChips();
    renderList();
    if (pendingFocus) applyFocus();
  }

  // 결사 창고 → 신청 탭 연결: 해당 아이템 행으로 스크롤 + 펼침 + 1.5초 하이라이트
  function focusItem(name) {
    pendingFocus = name;
  }

  function applyFocus() {
    const name = pendingFocus;
    pendingFocus = null;
    openNames.add(name);
    activeFilter = "전체"; // 현재 필터에 가려 있어도 보이도록
    renderChips();
    renderList();
    const el = [...document.querySelectorAll("#applyList .aitem")].find(
      (it) => it.querySelector(".nm .t").textContent === name,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1500);
  }

  // ── 회차 상태줄 (기간 설정 폼은 결사 창고 탭으로 이동 — warehouse.js 담당) ──
  function renderPeriod() {
    const p = data.period;
    const label = document.getElementById("periodStatusLabel");
    const info = document.getElementById("periodTimeInfo");

    if (p && p.status === "진행중") {
      label.textContent = "🟢 분배 신청 접수중";
      const remainMs = naiveEpoch(p.end_time) - kstNowEpoch();
      const remainH = Math.max(0, Math.floor(remainMs / 3600000));
      const remainM = Math.max(0, Math.floor((remainMs % 3600000) / 60000));
      info.textContent = `마감까지 ${remainH}시간 ${remainM}분 · 마감 ${fmtNaive(p.end_time)}`;
    } else {
      label.textContent = "⚪ 신청 기간이 아닙니다";
      info.textContent = p ? `최근 기간: ${fmtNaive(p.start_time)} ~ ${fmtNaive(p.end_time)} (종료)` : "설정된 기간이 없습니다.";
    }
  }

  // ── 자격 배너: 공통 관문(전투력/아퀴룬 스샷)만 안내 ──
  function renderBanner() {
    const el = document.getElementById("eligBanner");
    const my = data.my || {};
    const missing = [];
    if (!my.has_power_ss) missing.push("전투력 스샷 등록");
    if (!my.has_aqui_ss) missing.push("아퀴룬 스샷 등록");

    if (missing.length) {
      el.className = "elig bad";
      el.style.display = "flex";
      el.innerHTML = `
        <span class="ic">⚠️</span>
        <div><b>지금은 지망할 수 없어요.</b> 지망하려면 다음이 필요합니다:<br>
          ${missing.map((m) => "· " + m).join(" &nbsp;")}
          <span class="fix" onclick="Distribution.goShots()">지금 등록하기 →</span></div>`;
      return;
    }
    if (my.has_confirmed_wish) {
      el.className = "elig ok";
      el.style.display = "flex";
      el.innerHTML = `<span class="ic">🎉</span><div><b>이번 회차 확정 완료!</b> 남은 지망은 자동 취소되었어요. 자유 신청 아이템은 계속 신청할 수 있습니다.</div>`;
      return;
    }
    if (!periodActive()) {
      el.style.display = "none";
      return;
    }
    el.className = "elig ok";
    el.style.display = "flex";
    const rate = my.participation_rate != null ? my.participation_rate + "%" : "-";
    el.innerHTML = `
      <span class="ic">✅</span>
      <div><b>지망 가능 상태입니다.</b> 참여도 ${rate} · 기여점수 ${(my.contribution_score || 0).toLocaleString()} · 전투력/아퀴룬 스샷 등록됨</div>`;
  }

  function goShots() {
    Tabs.go("profile", document.querySelector('.tab[data-s="profile"]'));
    const stab = document.querySelector('.stab[data-pi="imgs"]');
    if (stab) Profile.setTab(stab);
  }

  // ── 내 지망 카드 (1·2·3순위 칸 + 실시간 경합 상태 — 시안 v2 문구) ──
  function applySlotStatus(el, g, myRank) {
    const winners = simWinners(g);
    const iAmWinner = winners.some((w) => w.user_id === myUid());
    const apps = (g.applicants || []).filter((a) => a.rank != null);
    if (iAmWinner) {
      const rival = apps.find((a) => a.user_id !== myUid());
      el.className = "ws win";
      el.textContent = rival ? "내 점수가 높아 현재 유력" : "단독 지망 — 현재 선정 1위";
      return;
    }
    const top = winners[0];
    el.className = "ws";
    el.textContent = top
      ? `${top.rank ? top.rank + "순위에 " : ""}${top.nick}(${(top.score || 0).toLocaleString()}) — 현재 순위 밖`
      : "현재 순위 밖";
  }

  function renderWishStrip() {
    const meta = document.getElementById("myWishMeta");
    meta.textContent = `내 기여점수 ${((data.my || {}).contribution_score || 0).toLocaleString()}`;
    const wrap = document.getElementById("wishSlots");
    wrap.innerHTML = "";
    for (const rank of [1, 2, 3]) {
      const slot = document.createElement("div");
      slot.className = "wslot";
      const req = myPendingWish(rank);
      const g = req ? groupOfReq(req) : null;
      if (req && g) {
        slot.classList.add("filled");
        slot.innerHTML = `<div class="wl">${rank}순위</div><div class="wi"></div><div class="ws"></div>`;
        slot.querySelector(".wi").textContent = g.item_name;
        applySlotStatus(slot.querySelector(".ws"), g, rank);
      } else {
        slot.innerHTML = `<div class="wl">${rank}순위</div><div class="wempty">${rank === 1 ? "목록에서 지망을 등록하세요" : "—"}</div>`;
      }
      wrap.appendChild(slot);
    }
  }

  // ── 필터 칩 ──
  function filterNames() {
    return ["전체", "신청 가능만", ...GameData.DIST_CATEGORIES, "내 지망"];
  }
  function matchesFilter(g, f) {
    if (f === "전체") return true;
    if (f === "신청 가능만") return !!g.can_apply;
    if (f === "내 지망") return g.my_rank != null || !!g.my_free_applied || !!g.applied;
    return cat5(g) === f;
  }

  function renderChips() {
    const wrap = document.getElementById("applyChips");
    wrap.innerHTML = "";
    const groups = data.groups || [];
    let activeVisible = false;
    filterNames().forEach((f) => {
      const n = groups.filter((g) => matchesFilter(g, f)).length;
      if (n === 0 && GameData.DIST_CATEGORIES.includes(f)) return; // 0건 카테고리 칩 숨김
      if (f === activeFilter) activeVisible = true;
      const chip = document.createElement("span");
      chip.className = "fchip" + (activeFilter === f ? " on" : "") + (n === 0 ? " empty" : "");
      chip.textContent = f === "내 지망" ? "✓ 내 지망" : f;
      const cnt = document.createElement("span");
      cnt.className = "cnt";
      cnt.textContent = n;
      chip.appendChild(cnt);
      chip.addEventListener("click", () => {
        activeFilter = f;
        renderChips();
        renderList();
      });
      wrap.appendChild(chip);
    });
    if (!activeVisible) {
      activeFilter = "전체";
      const first = wrap.querySelector(".fchip");
      if (first) first.classList.add("on");
    }
  }

  // ── 자격 미달 축약 태그 (부족 조건 하나만) ──
  function lackTag(g) {
    const elig = g.eligibility || {};
    if (elig.eligible || !(elig.failed || []).length) return null;
    const f = elig.failed[0];
    if (f.label === "참여도") return `참여도 ${f.required}↑`;
    if (f.label === "전투력") return `전투력 ${Number(f.required).toLocaleString()}↑`;
    if (f.label === "장비") return elig.rule === "찬란한 심연석" ? "절대자 풀셋 필요" : "절대자 달성자 제외";
    return `${f.label} 조건`;
  }

  // ── 아이템 목록: 카테고리 섹션 헤더 그룹핑 (행 + 펼침) ──
  const GRADE_BAR = { 전설: "g-leg", 신화: "g-myth", 절대자: "g-myth", 희귀: "g-rare", 영웅: "g-hero" };

  function renderList() {
    const listEl = document.getElementById("applyList");
    listEl.querySelectorAll(".cathead, .mlist").forEach((el) => el.remove());
    const groups = (data.groups || []).filter((g) => matchesFilter(g, activeFilter));
    const order = GameData.DIST_CATEGORIES;
    groups.sort(
      (a, b) => order.indexOf(cat5(a)) - order.indexOf(cat5(b)) || String(a.item_name).localeCompare(String(b.item_name), "ko"),
    );
    document.getElementById("applyEmpty").style.display = groups.length ? "none" : "block";

    // "아퀴룬 18 ───" 형식 섹션 헤더 + 카테고리별 목록 컨테이너
    for (const cat of order) {
      const catGroups = groups.filter((g) => cat5(g) === cat);
      if (!catGroups.length) continue;
      const headEl = document.createElement("div");
      headEl.className = "cathead";
      headEl.innerHTML = `<span class="cname"></span><span class="ccnt">${catGroups.length}</span><span class="ln"></span>`;
      headEl.querySelector(".cname").textContent = cat;
      listEl.appendChild(headEl);
      const box = document.createElement("div");
      box.className = "mlist";
      catGroups.forEach((g) => box.appendChild(buildItem(g)));
      listEl.appendChild(box);
    }
  }

  function buildItem(g) {
    const item = document.createElement("div");
    item.className = "aitem " + (GRADE_BAR[g.grade] || "") + (openNames.has(g.item_name) ? " open" : "");
    const winners = simWinners(g);
    const wishCnt = (g.applicants || []).filter((a) => a.rank != null).length;
    const freeCnt = (g.applicants || []).filter((a) => a.rank == null).length;

    // ── 행(헤더): 등급 컬러바(::before) + 경쟁 강도 배지 ──
    const head = document.createElement("div");
    head.className = "ihead";
    const showQty = (g.quantity || 0) >= 2 && !GameData.isOpenApplyItem(g.item_name);
    let tag = "";
    if (g.raid_type === "연합") tag = `<span class="atag">연합 룻</span>`;
    else if (g.is_free) tag = `<span class="free-tag">자유 신청</span>`;
    else {
      const lk = !Auth.isStaff() && lackTag(g);
      if (lk) tag = `<span class="atag lack"></span>`;
    }
    // 경쟁 강도: 지망 없음(회색) / 경쟁 1~2명(초록) / 3명+(황색). 자유 신청은 신청 N명.
    let comp;
    if (g.is_free) comp = freeCnt ? `<span class="comp c1">신청 ${freeCnt}명</span>` : `<span class="comp c0">신청 없음</span>`;
    else if (!wishCnt) comp = `<span class="comp c0">지망 없음</span>`;
    else comp = `<span class="comp ${wishCnt >= 3 ? "c2" : "c1"}">경쟁 ${wishCnt}명</span>`;
    head.innerHTML = `
      <span class="nm"><span class="t"></span>${showQty ? `<span class="qn">×${g.quantity}</span>` : ""}</span>
      <span class="mypick" style="display:none"></span>
      ${tag}
      ${comp}
      <span class="chev">▾</span>`;
    head.querySelector(".t").textContent = g.item_name;
    const lackEl = head.querySelector(".atag.lack");
    if (lackEl) lackEl.textContent = lackTag(g);
    const mp = head.querySelector(".mypick");
    if (g.my_rank != null) {
      mp.style.display = "";
      mp.textContent = `내 ${g.my_rank}순위`;
    } else if (g.my_free_applied) {
      mp.style.display = "";
      mp.textContent = "✓ 신청함";
    }
    head.addEventListener("click", () => {
      item.classList.toggle("open");
      if (item.classList.contains("open")) openNames.add(g.item_name);
      else openNames.delete(g.item_name);
    });
    item.appendChild(head);

    // ── 펼침 본문 ──
    const body = document.createElement("div");
    body.className = "ibody";
    if (g.raid_type === "연합") {
      body.innerHTML = `<div class="pickbar"><span class="pl">🔒 연합 룻 아이템 — 분배 신청 대상이 아닙니다.</span></div>`;
    } else if (g.is_free) {
      buildFreeBody(body, g, winners);
    } else {
      buildWishBody(body, g, winners);
    }
    item.appendChild(body);
    return item;
  }

  function candChip(a, isTop) {
    const c = document.createElement("span");
    c.className = "cand" + (isTop ? " top" : "") + (a.user_id === myUid() ? " me" : "");
    const nm = document.createElement("span");
    nm.textContent = a.nick;
    const sc = document.createElement("span");
    sc.className = "sc";
    sc.textContent = (a.score || 0).toLocaleString();
    c.appendChild(nm);
    c.appendChild(sc);
    return c;
  }

  // 자유 신청 아이템: 신청 토글 + 신청자(기여점수순) 공개
  function buildFreeBody(body, g, winners) {
    const ns = String(g.item_name).replace(/ /g, "");
    const isSimyeon = ns.includes("별빛심연석") || (ns.includes("찬란한") && ns.includes("심연석"));
    const why = g.free_apply
      ? "대량 소모품 — 전원 신청 가능, 지망 칸을 쓰지 않습니다."
      : isSimyeon
        ? "재고 무관 신청 — 지망 칸을 쓰지 않고, 선정은 운영진이 결정합니다."
        : `${g.unsold_period_count}회 유찰 — 전원 신청 가능, 지망 칸을 쓰지 않습니다.`;
    const bar = document.createElement("div");
    bar.className = "pickbar";
    bar.innerHTML = `<span class="pl"></span>`;
    bar.querySelector(".pl").textContent = why;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pbtn" + (g.my_free_applied ? " sel" : "");
    btn.textContent = g.my_free_applied ? "✓ 신청함 · 취소" : "신청";
    const canFree = g.can_apply || g.my_free_applied;
    btn.disabled = !canFree || !periodActive();
    btn.addEventListener("click", () => freeToggle(g, btn));
    bar.appendChild(btn);
    body.appendChild(bar);

    const grp = document.createElement("div");
    grp.className = "rank-group";
    grp.innerHTML = `<div class="rt">신청자 (기여점수순)</div>`;
    const apps = (g.applicants || []).filter((a) => a.rank == null);
    if (!apps.length) {
      const c = document.createElement("span");
      c.className = "cand none";
      c.textContent = "아직 없음";
      grp.appendChild(c);
    } else {
      const winSet = new Set(winners.map((w) => w.user_id));
      apps.forEach((a) => grp.appendChild(candChip(a, winSet.has(a.user_id))));
    }
    body.appendChild(grp);
  }

  // 지망 아이템: 1·2·3순위 버튼 + 순위 그룹별 지망자 전원 공개
  function buildWishBody(body, g, winners) {
    const bar = document.createElement("div");
    bar.className = "pickbar";
    bar.innerHTML = `<span class="pl">내 지망:</span>`;
    const canPick = (g.can_apply || g.my_rank != null) && periodActive() && !(data.my || {}).has_confirmed_wish;
    for (const rank of [1, 2, 3]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pbtn" + (g.my_rank === rank ? " sel" : "");
      b.textContent = `${rank}순위`;
      b.disabled = !canPick;
      b.addEventListener("click", () => pickRank(g, rank, b));
      bar.appendChild(b);
    }
    if (g.my_rank != null) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "pbtn clear";
      clear.textContent = "해제";
      clear.disabled = !periodActive();
      clear.addEventListener("click", () => clearWish(g, clear));
      bar.appendChild(clear);
    }
    body.appendChild(bar);

    if (!canPick && g.blocked_reason && g.my_rank == null) {
      const note = document.createElement("div");
      note.className = "meta";
      note.style.margin = "0 0 8px";
      note.textContent = g.blocked_reason;
      body.appendChild(note);
    }

    const winSet = new Set(winners.map((w) => w.user_id));
    const pools = [1, 2, 3].map((r) => (g.applicants || []).filter((a) => a.rank === r));
    if (!pools.some((p) => p.length)) {
      // 지망자 없는 아이템: 유도 문구 (시안 v2)
      const grp = document.createElement("div");
      grp.className = "rank-group";
      grp.innerHTML = `<div class="rt">아직 지망자가 없습니다 — 1순위로 걸면 현재 선정 1위</div>`;
      body.appendChild(grp);
      return;
    }
    [1, 2, 3].forEach((r) => {
      const pool = pools[r - 1];
      if (!pool.length) return;
      const grp = document.createElement("div");
      grp.className = "rank-group";
      grp.innerHTML = `<div class="rt">${r}순위 지망${r === 1 ? " — 여기서 먼저 선정" : ""}</div>`;
      pool.forEach((a) => grp.appendChild(candChip(a, winSet.has(a.user_id))));
      body.appendChild(grp);
    });
  }

  // ── 지망/신청 액션 ──
  async function pickRank(g, rank, btn) {
    if (g.my_rank === rank) return; // 이미 이 순위
    if (g.is_category_item) {
      openApply(g, rank);
      return;
    }
    btn.disabled = true;
    try {
      await Api.createItemRequest({ item_id: g.first_item_id, wish_rank: rank });
      toast(`✓ ${g.item_name} — ${rank}순위 지망 등록`);
      await load();
    } catch (err) {
      toast(err.message || "지망 등록 실패", true);
      btn.disabled = false;
    }
  }

  async function clearWish(g, btn) {
    const pending = myPendingForGroup(g, true);
    if (!pending) return;
    if (!confirm(`"${g.item_name}" 지망을 해제할까요?`)) return;
    btn.disabled = true;
    try {
      await Api.cancelItemRequest(pending.id);
      toast("지망을 해제했습니다.");
      await load();
    } catch (err) {
      toast(err.message || "해제 실패", true);
      btn.disabled = false;
    }
  }

  async function freeToggle(g, btn) {
    btn.disabled = true;
    try {
      if (g.my_free_applied) {
        const pending = myPendingForGroup(g, false);
        if (!pending) return;
        if (!confirm(`"${g.item_name}" 신청을 취소할까요?`)) {
          btn.disabled = false;
          return;
        }
        await Api.cancelItemRequest(pending.id);
        toast("신청이 취소되었습니다.");
        await load();
        return;
      }
      const ns = String(g.item_name).replace(/ /g, "");
      const isSimyeon = ns.includes("별빛심연석") || (ns.includes("찬란한") && ns.includes("심연석"));
      if (g.is_category_item) {
        openApply(g, null);
        return;
      }
      if (!isSimyeon && (g.quantity || 0) > 1) {
        openApply(g, null); // 대량 소모품: 기존 수량 규칙 유지 — 수량 입력 모달
        return;
      }
      await Api.createItemRequest({ item_id: g.first_item_id, quantity: 1 });
      toast(`✅ ${g.item_name} 신청 완료!`);
      await load();
    } catch (err) {
      toast(err.message || "신청 실패", true);
      btn.disabled = false;
    }
  }

  // ── 모달 (카테고리 아이템 희망 옵션 / 자유 신청 수량) ──
  function openApply(g, rank) {
    applyTarget = { g, rank };
    document.getElementById("applyModalTitle").textContent =
      rank != null ? `${g.item_name} — ${rank}순위 지망` : `${g.item_name} 신청`;
    document.getElementById("applyModalMeta").textContent = `등급 ${g.grade || "-"} · 재고 ${g.quantity}개`;

    const isCat = !!g.is_category_item;
    // 수량 입력은 자유 신청(수량 있는 대량 소모품)일 때만 — 지망은 수량 1 고정
    const showQty = !isCat && rank == null;
    document.getElementById("applyQtyField").classList.toggle("hidden", !showQty);
    document.getElementById("applyPrefFields").classList.toggle("hidden", !isCat);
    document.getElementById("applyPref1").value = "";
    document.getElementById("applyPref2").value = "";

    const note = document.getElementById("applyModalNote");
    if (showQty) {
      const cap = g.item_name.replace(/ /g, "").includes("찬란한") ? Math.min(g.quantity, 3) : g.quantity;
      const qtyInput = document.getElementById("applyQty");
      qtyInput.value = 1;
      qtyInput.max = cap;
      note.style.display = cap < g.quantity ? "block" : "none";
      note.className = "toast";
      note.textContent = cap < g.quantity ? `이 아이템은 1인 최대 ${cap}개까지 신청할 수 있습니다.` : "";
    } else if (isCat) {
      note.style.display = "block";
      note.className = "toast";
      note.textContent = "카테고리 아이템입니다. 원하는 옵션을 희망 옵션 1(필수)/2(선택)로 적어주세요. 수량은 1개 고정입니다.";
    } else {
      note.style.display = "none";
    }
    document.getElementById("applyModalBackdrop").classList.add("on");
  }

  function initApplyModal() {
    document.getElementById("applyCancelBtn").addEventListener("click", () => {
      document.getElementById("applyModalBackdrop").classList.remove("on");
    });
    document.getElementById("applyForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!applyTarget) return;
      const { g, rank } = applyTarget;
      const btn = document.getElementById("applySubmitBtn");
      btn.disabled = true;
      try {
        const body = { item_id: g.first_item_id };
        if (rank != null) body.wish_rank = rank;
        if (g.is_category_item) {
          body.preference_1 = document.getElementById("applyPref1").value.trim();
          body.preference_2 = document.getElementById("applyPref2").value.trim();
          if (!body.preference_1) {
            toast("희망 옵션 1을 입력해주세요.", true);
            return;
          }
        } else if (rank == null) {
          body.quantity = parseInt(document.getElementById("applyQty").value, 10) || 1;
        }
        await Api.createItemRequest(body);
        document.getElementById("applyModalBackdrop").classList.remove("on");
        toast(rank != null ? `✓ ${g.item_name} — ${rank}순위 지망 등록` : `✅ ${g.item_name} 신청 완료!`);
        applyTarget = null;
        await load();
      } catch (err) {
        toast(err.message || "신청 실패", true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function init() {
    initApplyModal();
  }

  return { init, load, goShots, focusItem };
})();
