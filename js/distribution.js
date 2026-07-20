// 분배 신청 화면 (분배신청_단순화시안_v4): 회차 상태줄 + 자격 배너 + 필터 칩 + 한 줄 행 목록.
// 신청 가능/불가 판정은 전부 서버(can_apply/blocked_reason)를 그대로 따른다 — 화면은 표시만 개편.
const Distribution = (() => {
  const GRADE_BADGE = { 신화: "b-myth", 전설: "b-legend", 영웅: "b-hero", 희귀: "b-rare" };
  let data = null; // GET view=items 응답
  let myRequests = []; // 내 대기 신청 (취소 토글용)
  let activeFilter = "전체";
  let applyTarget = null; // 신청 모달 대상 그룹

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

  function cat5(g) {
    return GameData.category5(g.item_name, g.category, g.grade);
  }

  // "전원 가능" 완화가 실제 적용되는 그룹 — 서버 checkEligibility의 전설 아퀴 2회 유찰 규칙과 동일 판정
  function isUnsoldOpen(g) {
    const cat = String(g.category || "").replace(/ /g, "");
    return (g.unsold_period_count || 0) >= 2 && (cat === "아퀴" || cat === "아퀴룬") && g.grade === "전설";
  }

  function pendingReqFor(g) {
    const ids = g.item_ids || [];
    return myRequests.find((r) => ids.includes(r.item_id)) || null;
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
    if (data.auto_confirmed > 0) {
      toast(`⏰ 신청 기간이 마감되어 ${data.auto_confirmed}건이 자동 확정되었습니다.`);
    }
    renderPeriod();
    renderBanner();
    renderChips();
    renderList();
  }

  // ── 회차 상태줄 + 운영진 기간 관리 ──
  function renderPeriod() {
    const p = data.period;
    const label = document.getElementById("periodStatusLabel");
    const info = document.getElementById("periodTimeInfo");
    const staff = Auth.isStaff();

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

    // 마감 변경/연장/종료 폼은 운영진에게만
    const box = document.getElementById("periodStaffBox");
    box.classList.toggle("hidden", !staff);
    if (staff) {
      const active = !!(p && p.status === "진행중");
      document.getElementById("periodSetForm").style.display = active ? "none" : "flex";
      document.getElementById("periodActiveForm").style.display = active ? "flex" : "none";
      if (active) document.getElementById("periodNewEnd").value = String(p.end_time).replace(" ", "T").slice(0, 16);
    }
  }

  // ── 자격 배너: 신청 불가 사유는 여기 한 번만 (행마다 반복하지 않음) ──
  // 전 아이템 공통 차단 요건(전투력/아퀴룬 스샷)만 미충족으로 다루고,
  // 아이템별 기준(참여도·전투력 등)은 해당 행의 버튼 비활성으로만 표현한다.
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
        <div><b>지금은 신청할 수 없어요.</b> 신청하려면 다음이 필요합니다:<br>
          ${missing.map((m) => "· " + m).join(" &nbsp;")}
          <span class="fix" onclick="Distribution.goShots()">지금 등록하기 →</span></div>`;
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
      <div><b>신청 가능 상태입니다.</b> 참여도 ${rate} · 기여점수 ${(my.contribution_score || 0).toLocaleString()} · 전투력/아퀴룬 스샷 등록됨</div>`;
  }

  // "지금 등록하기 →" — 내 정보 > 인증샷 탭으로 이동
  function goShots() {
    Tabs.go("profile", document.querySelector('.tab[data-s="profile"]'));
    const stab = document.querySelector('.stab[data-pi="imgs"]');
    if (stab) Profile.setTab(stab);
  }

  // ── 필터 칩: 전체 | 신청 가능만 | 카테고리 5종(0건 숨김) | ✓ 내 신청 ──
  function filterNames() {
    return ["전체", "신청 가능만", ...GameData.DIST_CATEGORIES, "내 신청"];
  }
  function matchesFilter(g, f) {
    if (f === "전체") return true;
    if (f === "신청 가능만") return !!g.can_apply;
    if (f === "내 신청") return !!g.applied;
    return cat5(g) === f;
  }

  function renderChips() {
    const wrap = document.getElementById("applyChips");
    wrap.innerHTML = "";
    const groups = data.groups || [];
    let activeVisible = false;
    filterNames().forEach((f) => {
      const n = groups.filter((g) => matchesFilter(g, f)).length;
      if (n === 0 && GameData.DIST_CATEGORIES.includes(f)) return; // 0건 카테고리 칩은 숨김
      if (f === activeFilter) activeVisible = true;
      const chip = document.createElement("span");
      chip.className = "fchip" + (activeFilter === f ? " on" : "") + (n === 0 ? " empty" : "");
      chip.textContent = f === "내 신청" ? "✓ 내 신청" : f;
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

  // ── 아이템 목록: 한 줄 행 (등급 배지 | 이름 ×N | 예외 태그 | 버튼) ──
  // 룻자·룻 일자는 결사원 화면에 표시하지 않는다 (운영진용 분배 현황 탭에서만 유지).
  function renderList() {
    const listEl = document.getElementById("applyList");
    listEl.querySelectorAll(".irow[data-g]").forEach((el) => el.remove());
    const groups = (data.groups || []).filter((g) => matchesFilter(g, activeFilter));
    const order = GameData.DIST_CATEGORIES;
    groups.sort(
      (a, b) => order.indexOf(cat5(a)) - order.indexOf(cat5(b)) || String(a.item_name).localeCompare(String(b.item_name), "ko"),
    );
    document.getElementById("applyEmpty").style.display = groups.length ? "none" : "flex";

    groups.forEach((g) => {
      const row = document.createElement("div");
      row.className = "irow arow";
      row.dataset.g = "1";
      let tag = "";
      if (g.raid_type === "연합") tag = `<span class="atag">연합 룻</span>`;
      else if (isUnsoldOpen(g)) tag = `<span class="atag all">${g.unsold_period_count}회 유찰 · 전원 가능</span>`;
      // 심연석류(별빛·조각·찬란한)는 수량 개념 없이 신청만 받음 — ×N 표기 생략
      const showQty = (g.quantity || 0) >= 2 && !GameData.isOpenApplyItem(g.item_name);
      row.innerHTML = `
        <span class="gb">${g.grade ? `<span class="badge ${GRADE_BADGE[g.grade] || "b-gray"}">${g.grade}</span>` : ""}</span>
        <span class="nm"><b class="t"></b>${showQty ? ` <span class="qn">×${g.quantity}</span>` : ""}</span>
        ${tag}
        <span class="acts"></span>`;
      row.querySelector(".t").textContent = g.item_name;
      const acts = row.querySelector(".acts");
      const pending = pendingReqFor(g);

      if (g.applied && pending && periodActive()) {
        // 신청함 → 재클릭 시 확인 후 취소 (마감 전까지만)
        const btn = document.createElement("button");
        btn.className = "btn sm applied";
        btn.textContent = "✓ 신청함 · 취소";
        btn.addEventListener("click", () => cancelRequest(g, pending, btn));
        acts.appendChild(btn);
      } else if (g.applied) {
        const s = document.createElement("span");
        s.className = "badge b-green";
        s.textContent = "✓ 신청함";
        acts.appendChild(s);
      } else if (g.raid_type === "연합") {
        acts.innerHTML = `<button type="button" class="btn sm off" disabled>신청 불가</button>`;
      } else if (g.can_apply) {
        const btn = document.createElement("button");
        btn.className = "btn sm";
        btn.textContent = "신청";
        btn.addEventListener("click", () => startApply(g, btn));
        acts.appendChild(btn);
      } else {
        // 자격 미충족/기간 아님 등 — 사유 문구는 반복하지 않고 회색 비활성만
        acts.innerHTML = `<button type="button" class="btn sm off" disabled>신청</button>`;
      }
      listEl.appendChild(row);
    });
  }

  async function startApply(g, btn) {
    // 심연석류는 수량 입력 없이 항상 1건 신청 (선정은 운영진이 신청자 중 직접 선택)
    const needsModal = g.is_category_item || ((g.quantity || 0) > 1 && !GameData.isOpenApplyItem(g.item_name));
    if (needsModal) {
      openApply(g);
      return;
    }
    // 수량 입력이 필요 없는 아이템은 바로 신청
    btn.disabled = true;
    try {
      await Api.createItemRequest({ item_id: g.first_item_id, quantity: 1 });
      toast(`✅ ${g.item_name} 신청 완료!`);
      await load();
    } catch (err) {
      toast(err.message || "신청 실패", true);
      btn.disabled = false;
    }
  }

  async function cancelRequest(g, pending, btn) {
    if (!confirm(`"${g.item_name}" 신청을 취소할까요?`)) return;
    btn.disabled = true;
    try {
      await Api.cancelItemRequest(pending.id);
      toast("신청이 취소되었습니다.");
      await load();
    } catch (err) {
      toast(err.message || "취소 실패", true);
      btn.disabled = false;
    }
  }

  // ── 신청 모달 (카테고리 아이템 선호 입력 / 수량 2개 이상 아이템 수량 선택) ──
  function openApply(g) {
    applyTarget = g;
    document.getElementById("applyModalTitle").textContent = `${g.item_name} 신청`;
    document.getElementById("applyModalMeta").textContent = `등급 ${g.grade || "-"} · 재고 ${g.quantity}개`;

    const isCat = !!g.is_category_item;
    document.getElementById("applyQtyField").classList.toggle("hidden", isCat);
    document.getElementById("applyPrefFields").classList.toggle("hidden", !isCat);
    document.getElementById("applyPref1").value = "";
    document.getElementById("applyPref2").value = "";

    const note = document.getElementById("applyModalNote");
    if (!isCat) {
      const cap = g.item_name.replace(/ /g, "").includes("찬란한") ? Math.min(g.quantity, 3) : g.quantity;
      const qtyInput = document.getElementById("applyQty");
      qtyInput.value = 1;
      qtyInput.max = cap;
      note.style.display = cap < g.quantity ? "block" : "none";
      note.className = "toast";
      note.textContent = cap < g.quantity ? `이 아이템은 1인 최대 ${cap}개까지 신청할 수 있습니다.` : "";
    } else {
      note.style.display = "block";
      note.className = "toast";
      note.textContent = "카테고리 아이템입니다. 원하는 옵션을 1순위(필수)/2순위(선택)로 적어주세요. 수량은 1개 고정입니다.";
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
      const btn = document.getElementById("applySubmitBtn");
      btn.disabled = true;
      try {
        const body = { item_id: applyTarget.first_item_id };
        if (applyTarget.is_category_item) {
          body.preference_1 = document.getElementById("applyPref1").value.trim();
          body.preference_2 = document.getElementById("applyPref2").value.trim();
          if (!body.preference_1) {
            toast("1순위 선호를 입력해주세요.", true);
            return;
          }
        } else {
          body.quantity = parseInt(document.getElementById("applyQty").value, 10) || 1;
        }
        await Api.createItemRequest(body);
        document.getElementById("applyModalBackdrop").classList.remove("on");
        toast(`✅ ${applyTarget.item_name} 신청 완료!`);
        applyTarget = null;
        await load();
      } catch (err) {
        toast(err.message || "신청 실패", true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ── 운영진 기간 관리 ──
  function initPeriodForms() {
    document.getElementById("periodSetBtn").addEventListener("click", async () => {
      const start = document.getElementById("periodStart").value;
      const end = document.getElementById("periodEnd").value;
      if (!start || !end) {
        toast("시작/마감 시각을 입력해주세요.", true);
        return;
      }
      try {
        await Api.setDistributionPeriod(start, end);
        toast("📅 분배 신청 기간이 설정되었습니다.");
        await load();
      } catch (err) {
        toast(err.message || "기간 설정 실패", true);
      }
    });

    document.getElementById("periodExtendBtn").addEventListener("click", async () => {
      const newEnd = document.getElementById("periodNewEnd").value;
      if (!newEnd || !data.period) return;
      try {
        await Api.extendDistributionPeriod(data.period.id, newEnd);
        toast("마감 시각이 변경되었습니다.");
        await load();
      } catch (err) {
        toast(err.message || "연장 실패", true);
      }
    });

    document.getElementById("periodCloseBtn").addEventListener("click", async () => {
      if (!data.period) return;
      if (!confirm("기간을 종료하고 자동확정을 실행할까요? 되돌릴 수 없습니다.")) return;
      try {
        const res = await Api.closeDistributionPeriod(data.period.id);
        toast(`기간 종료 — ${res.confirmed_count || 0}건 자동 확정되었습니다.`);
        await load();
      } catch (err) {
        toast(err.message || "종료 실패", true);
      }
    });
  }

  function init() {
    initApplyModal();
    initPeriodForms();
  }

  return { init, load, goShots };
})();
