// 결사 창고 — 결사원용 재고 열람 (결사창고_시안_v8, 열람 중심).
// 기존 재고 조회(status='재고') 재사용, 룻자/수정/삭제 등 관리 요소는 일절 표시하지 않는다.
// 클릭: 일반 카드 + 활성 기간 → 신청 탭 점프 / 기간 아님 → 안내 토스트 /
//       신화 → 항상 "운영진 문의" 토스트 (신화는 분배 신청 제외) / 연합 → 무반응.
// 분배 신청 기간 설정 폼(운영진 전용)도 이 탭이 담당한다.
const Warehouse = (() => {
  const GRADE_CHIP = { 전설: "leg", 신화: "myth", 절대자: "myth", 희귀: "rare", 영웅: "hero" };
  const GRADE_ORDER = ["신화", "절대자", "전설", "영웅", "희귀"]; // 섹션 내 정렬: 신화 → 전설 → 희귀
  // 섹션은 4개 — 별빛/찬란한 심연석은 "심연석" 섹션으로 합침
  const SECTIONS = [
    ["아퀴룬", ["아퀴룬"]],
    ["심연석", ["별빛심연석", "찬란한심연석"]],
    ["브로치", ["브로치"]],
    ["전파편 및 기타", ["전파편 및 기타"]],
  ];
  let groups = [];
  let period = null;
  let periodActive = false;
  let activeChip = "전체";

  function toast(msg, isErr) {
    const t = document.getElementById("whToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 4000);
  }

  // 하단 다크 토스트 (클릭 안내용 — 시안 v8)
  function dtoast(msg) {
    const t = document.getElementById("whDToast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(dtoast._t);
    dtoast._t = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // KST 벽시계값 비교/표시 (distribution.js와 동일 규약)
  function fmtNaive(ts) {
    if (!ts) return "-";
    return String(ts).replace("T", " ").slice(0, 16);
  }
  function naiveEpoch(ts) {
    const s = String(ts).replace(" ", "T");
    return new Date(s.endsWith("Z") ? s : s + "Z").getTime();
  }

  function catOf(g) {
    return GameData.category5(g.item_name, g.category, g.grade);
  }
  function isMyth(g) {
    return g.grade === "신화" || g.grade === "절대자";
  }

  // 등록일(KST 벽시계값) 기준 7일 이내 = 최근 입고 (품명 앞 초록 점)
  function isNew(g) {
    if (!g.newest) return false;
    const t = new Date(String(g.newest).replace(" ", "T") + (String(g.newest).endsWith("Z") ? "" : "Z")).getTime();
    return Date.now() + 9 * 3600 * 1000 - t < 7 * 86400 * 1000;
  }

  async function load() {
    try {
      const [items, dist] = await Promise.all([
        Api.listInventory(),
        Api.getDistributionItems().catch(() => null), // 신청 연결/기간 폼용 — 실패해도 열람은 유지
      ]);
      period = (dist && dist.period) || null;
      periodActive = !!(period && period.status === "진행중");
      // (item_name, raid_type) 그룹 — 분배 신청 탭과 동일 문법
      const map = new Map();
      for (const it of items || []) {
        const rt = it.raid_type || "결사";
        const key = it.item_name + "|" + rt;
        let g = map.get(key);
        if (!g) {
          g = { item_name: it.item_name, raid_type: rt, grade: it.grade, category: it.category, quantity: 0, newest: null };
          map.set(key, g);
        }
        g.quantity += it.quantity || 0;
        if (it.registered_at && (!g.newest || String(it.registered_at) > String(g.newest))) g.newest = it.registered_at;
      }
      groups = [...map.values()];
    } catch (e) {
      toast(e.message || "창고 조회 실패", true);
      return;
    }
    renderPeriodCard();
    renderSummary();
    renderChips();
    render();
  }

  // ── 분배 신청 기간 설정 카드 (운영진 전용 — 카드 노출은 CSS .staff-only가 처리) ──
  function renderPeriodCard() {
    const label = document.getElementById("whPeriodLabel");
    const info = document.getElementById("whPeriodInfo");
    if (periodActive) {
      label.textContent = "🟢 분배 신청 접수중";
      const remainMs = naiveEpoch(period.end_time) - (Date.now() + 9 * 3600 * 1000);
      const remainH = Math.max(0, Math.floor(remainMs / 3600000));
      const remainM = Math.max(0, Math.floor((remainMs % 3600000) / 60000));
      info.textContent = `마감까지 ${remainH}시간 ${remainM}분 · 마감 ${fmtNaive(period.end_time)}`;
    } else {
      label.textContent = "⚪ 신청 기간이 아닙니다";
      info.textContent = period ? `최근 기간: ${fmtNaive(period.start_time)} ~ ${fmtNaive(period.end_time)} (종료)` : "설정된 기간이 없습니다.";
    }
    document.getElementById("periodSetForm").style.display = periodActive ? "none" : "flex";
    document.getElementById("periodActiveForm").style.display = periodActive ? "flex" : "none";
    if (periodActive) {
      document.getElementById("periodNewEnd").value = String(period.end_time).replace(" ", "T").slice(0, 16);
    }
  }

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
      if (!newEnd || !period) return;
      try {
        await Api.extendDistributionPeriod(period.id, newEnd);
        toast("마감 시각이 변경되었습니다.");
        await load();
      } catch (err) {
        toast(err.message || "연장 실패", true);
      }
    });

    document.getElementById("periodCloseBtn").addEventListener("click", async () => {
      if (!period) return;
      if (!confirm("기간을 종료하고 자동확정(지망 선정)을 실행할까요? 되돌릴 수 없습니다.")) return;
      try {
        const res = await Api.closeDistributionPeriod(period.id);
        toast(`기간 종료 — ${res.confirmed_count || 0}건 자동 확정되었습니다.`);
        await load();
      } catch (err) {
        toast(err.message || "종료 실패", true);
      }
    });
  }

  // ── 요약 한 줄: "전체 N종 · 신화 N · 전설 N · 희귀 N · (기준 시각)" ──
  function renderSummary() {
    const el = document.getElementById("whSummary");
    el.innerHTML = "";
    const parts = [`전체 <b>${groups.length}종</b>`];
    for (const gr of GRADE_ORDER) {
      const n = groups.filter((g) => g.grade === gr).length;
      if (n) parts.push(`${gr} <b>${n}</b>`);
    }
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    const asOf = `${d.getUTCMonth() + 1}-${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} 기준`;
    el.innerHTML = parts.join(" · ") + ` · ${asOf}`;
  }

  // ── 필터 칩: 전체 | 카테고리 5종(0개 숨김) | 신화만 ──
  function chipNames() {
    const names = ["전체"];
    GameData.DIST_CATEGORIES.forEach((c) => {
      if (groups.some((g) => catOf(g) === c)) names.push(c);
    });
    if (groups.some(isMyth)) names.push("신화만");
    return names;
  }
  function matchesChip(g, chip) {
    if (chip === "전체") return true;
    if (chip === "신화만") return isMyth(g);
    return catOf(g) === chip;
  }

  function renderChips() {
    const wrap = document.getElementById("whChips");
    wrap.innerHTML = "";
    const names = chipNames();
    if (!names.includes(activeChip)) activeChip = "전체";
    names.forEach((n) => {
      const chip = document.createElement("span");
      chip.className = "fchip" + (n === "신화만" ? " gold" : "") + (activeChip === n ? " on" : "");
      const cnt = n === "전체" ? groups.length : groups.filter((g) => matchesChip(g, n)).length;
      chip.textContent = (n === "전파편 및 기타" ? "전파편·기타" : n) + (n === "신화만" ? "" : ` ${cnt}`);
      chip.addEventListener("click", () => {
        activeChip = n;
        renderChips();
        render();
      });
      wrap.appendChild(chip);
    });
  }

  function render() {
    const listEl = document.getElementById("whList");
    listEl.querySelectorAll(".cathead, .grid").forEach((el) => el.remove());
    const q = (document.getElementById("qw").value || "").trim();
    const rows = groups.filter((g) => matchesChip(g, activeChip) && (!q || g.item_name.includes(q)));
    document.getElementById("whEmpty").style.display = rows.length ? "none" : "block";

    for (const [label, cats] of SECTIONS) {
      const secRows = rows
        .filter((g) => cats.includes(catOf(g)))
        .sort(
          (a, b) =>
            GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade) ||
            a.item_name.localeCompare(b.item_name, "ko"),
        );
      if (!secRows.length) continue;
      const head = document.createElement("div");
      head.className = "cathead";
      head.innerHTML = `<span class="ct"></span><small>${secRows.length}종</small><span class="ln"></span>`;
      head.querySelector(".ct").textContent = label;
      listEl.appendChild(head);
      const grid = document.createElement("div");
      grid.className = "grid";
      secRows.forEach((g) => grid.appendChild(buildTile(g)));
      listEl.appendChild(grid);
    }
  }

  function buildTile(g) {
    const tile = document.createElement("div");
    const myth = isMyth(g);
    const legendSim = !myth && GameData.isLegendSimyeonItem(g.item_name); // 전설 심연석 = 시즌 마감 수동 분배
    const union = g.raid_type === "연합";
    tile.className = "tile" + (myth ? " myth" : "") + (union ? " noapply" : "");
    // 우측 상단 배지는 예외만: 신화="문의" / 전설 심연석="1:1 신청" / 연합="연합". 일반 카드는 배지 없음.
    const corner = myth
      ? `<span class="corner ask">문의</span>`
      : legendSim
        ? `<span class="corner ask">1:1 신청</span>`
        : union
          ? `<span class="corner no">연합</span>`
          : "";
    tile.innerHTML = `
      ${corner}
      <div class="tn">${isNew(g) ? `<span class="newdot" title="최근 입고"></span>` : ""}<span class="t"></span></div>
      <div class="tm">
        <span class="gchip ${GRADE_CHIP[g.grade] || "rare"}">${g.grade || "-"}</span>
        ${g.quantity >= 2 ? `<span class="qty">×${g.quantity}</span>` : ""}
      </div>`;
    tile.querySelector(".t").textContent = g.item_name;

    if (myth) {
      tile.addEventListener("click", () =>
        dtoast("신화 등급은 분배 신청 대상이 아닙니다 — 운영진에게 문의해주세요 · 자세한 내용은 규정 탭 참고"));
    } else if (legendSim) {
      tile.addEventListener("click", () =>
        dtoast("전설 심연석은 시즌 마감 시 기여점수 상위 순으로 분배됩니다 — 필요하신 분은 운영진에게 1:1 신청해주세요"));
    } else if (!union) {
      tile.addEventListener("click", () => {
        if (periodActive) goApply(g);
        else dtoast("지금은 분배 신청 기간이 아닙니다");
      });
    }
    return tile;
  }

  // 분배 신청 하위 탭으로 전환 + 해당 아이템 행 스크롤·펼침·하이라이트
  function goApply(g) {
    Distribution.focusItem(g.item_name);
    Tabs.goDist("apply");
  }

  function init() {
    initPeriodForms();
  }

  return { init, load, render };
})();
