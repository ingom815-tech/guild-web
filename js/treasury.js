// 공금 관리 화면: 잔액 조회(전 회원) + 수동 입출금(운영진 이상, 현금/다이아 통합 폼) + 이력(삭제는 관리자만)
// UI는 공금관리_개선시안.html 명세를 따른다. 트랜잭션 로직(저장/삭제 API 호출)은 기존 그대로.
const Treasury = (() => {
  const PAGE_SIZE = 20;
  let history = [];
  let staffOwners = []; // 다이아 룻자 select용 — [{user_id, current_id}]
  let pendingDeleteId = null;
  let formAsset = "현금"; // 통합 폼에서 선택된 자산
  let fAsset = "전체"; // 이력 자산 필터 (전체/현금/다이아)
  let fDir = "전체"; // 이력 유형 필터 (전체/입금/출금)
  let fPeriod = "all"; // 기간 필터 (this/last/all)
  let page = 0;

  function toast(msg, isErr) {
    const t = document.getElementById("treasuryToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 4000);
  }

  async function load() {
    const staff = Auth.isStaff();
    document.getElementById("treasuryStaffForms").classList.toggle("hidden", !staff);
    document.getElementById("treasuryCols").classList.toggle("solo", !staff);

    try {
      const [balances, hist] = await Promise.all([Api.getTreasuryBalances(), Api.getTreasuryHistory({})]);
      renderBalances(balances);
      history = hist;
      page = 0;
      renderHistory();
    } catch (e) {
      toast(e.message || "공금 정보 조회 실패", true);
      return;
    }

    if (staff) {
      try {
        const members = await Api.listMembers();
        staffOwners = members.filter((m) => m.role === "운영진" || m.role === "관리자");
        renderOwnerSelect();
      } catch (e) {
        // 결사원 관리 권한이 없는 운영진 계정 등에서도 공금 화면 자체는 계속 쓸 수 있어야 하므로 조용히 무시.
      }
    }
  }

  function renderOwnerSelect() {
    const sel = document.getElementById("diamondOwner");
    sel.innerHTML = staffOwners.map((m) => `<option value="${m.user_id}">${m.current_id || m.user_id}</option>`).join("");
  }

  function renderBalances(data) {
    document.getElementById("cashBalance").innerHTML = (data.cash.balance || 0).toLocaleString() + " <small>원</small>";
    document.getElementById("diamondTotal").innerHTML = (data.diamond_total || 0).toLocaleString() + " <small>개</small>";
    document.getElementById("diamondSumMeta").textContent = "합계 " + (data.diamond_total || 0).toLocaleString() + "개";

    const listEl = document.getElementById("diamondList");
    document.querySelectorAll("#diamondList .hrow[data-owner]").forEach((el) => el.remove());
    const emptyRow = document.getElementById("diamondEmpty");
    const diamonds = (data.diamonds || []).slice().sort((a, b) => (b.balance || 0) - (a.balance || 0));
    emptyRow.style.display = diamonds.length ? "none" : "flex";

    const max = Math.max(1, ...diamonds.map((d) => d.balance || 0));
    diamonds.forEach((d) => {
      const row = document.createElement("div");
      row.className = "hrow";
      row.dataset.owner = d.owner_user_id;
      const pct = Math.max(1, Math.round(((d.balance || 0) / max) * 100));
      row.innerHTML = `<span class="nm"></span><span class="bar"><i style="width:${pct}%"></i></span><span class="n"></span>`;
      row.querySelector(".nm").textContent = d.owner_name || d.owner_user_id;
      row.querySelector(".n").textContent = (d.balance || 0).toLocaleString();
      listEl.appendChild(row);
    });
  }

  // ── 이력 필터/집계 ──
  function periodRange() {
    // 반환: {y, m} (로컬=KST 기준) 또는 null(전체)
    if (fPeriod === "all") return null;
    const now = new Date();
    let y = now.getFullYear();
    let m = now.getMonth();
    if (fPeriod === "last") {
      m -= 1;
      if (m < 0) {
        m = 11;
        y -= 1;
      }
    }
    return { y, m };
  }

  function inPeriod(h, range) {
    if (!range) return true;
    if (!h.created_at) return false;
    const d = new Date(h.created_at);
    return d.getFullYear() === range.y && d.getMonth() === range.m;
  }

  function fmtWhen(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const now = new Date();
    const y = d.getFullYear() !== now.getFullYear() ? d.getFullYear() + "." : "";
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${y}${d.getMonth() + 1}.${d.getDate()} ${hh}:${mm}`;
  }

  function renderSummary(periodRows, range) {
    const el = document.getElementById("treasurySummary");
    const sums = { 현금: { 입금: 0, 출금: 0 }, 다이아: { 입금: 0, 출금: 0 } };
    periodRows.forEach((h) => {
      if (sums[h.asset_type] && sums[h.asset_type][h.direction] !== undefined) {
        sums[h.asset_type][h.direction] += h.amount || 0;
      }
    });
    let label = "전체 합계";
    if (range) {
      const yearPrefix = range.y !== new Date().getFullYear() ? range.y + "년 " : "";
      label = `${yearPrefix}${range.m + 1}월 합계`;
    }
    const part = (a) =>
      `${a}: 입금 +${sums[a].입금.toLocaleString()} / 출금 −${sums[a].출금.toLocaleString()}`;
    el.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = label;
    el.appendChild(b);
    el.appendChild(document.createTextNode(` — ${part("현금")} · ${part("다이아")}`));
    el.style.display = "block";
  }

  function renderHistory() {
    const body = document.getElementById("treasuryHistoryBody");
    body.innerHTML = "";

    const range = periodRange();
    const periodRows = history.filter((h) => inPeriod(h, range));
    renderSummary(periodRows, range);

    const rows = periodRows.filter(
      (h) => (fAsset === "전체" || h.asset_type === fAsset) && (fDir === "전체" || h.direction === fDir)
    );

    const maxPage = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);
    if (page > maxPage) page = maxPage;
    const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="6" class="who" style="text-align:center;padding:18px">이력이 없습니다.</td>`;
      body.appendChild(tr);
    }

    const isAdmin = (Auth.getUser() || {}).role === "관리자";
    pageRows.forEach((h) => {
      const isCash = h.asset_type === "현금";
      const isIn = h.direction === "입금";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="abadge ${isCash ? "a-cash" : "a-dia"}"></span></td>
        <td class="amt ${isIn ? "in" : "out"}"></td>
        <td class="desc"></td>
        <td class="who"></td>
        <td class="when"></td>
        <td>${isAdmin ? '<button class="del" data-act="del">삭제</button>' : ""}</td>`;
      tr.querySelector(".abadge").textContent = h.asset_type;
      tr.querySelector(".amt").textContent = (isIn ? "+" : "−") + (h.amount || 0).toLocaleString();
      tr.querySelector(".desc").textContent = h.description || "-";
      tr.querySelector(".who").textContent = h.owner_name || "-";
      tr.querySelector(".when").textContent = fmtWhen(h.created_at);
      if (isAdmin) {
        tr.querySelector('[data-act="del"]').addEventListener("click", () => requestDelete(h));
      }
      body.appendChild(tr);
    });

    renderPager(rows.length);
  }

  function renderPager(total) {
    const el = document.getElementById("treasuryPager");
    el.innerHTML = "";
    if (!total) return;
    if (total <= PAGE_SIZE) {
      el.textContent = `${total}건`;
      return;
    }
    const start = page * PAGE_SIZE + 1;
    const end = Math.min(total, (page + 1) * PAGE_SIZE);
    const prev = document.createElement("button");
    prev.textContent = "◂ 이전";
    prev.disabled = page === 0;
    prev.addEventListener("click", () => {
      page -= 1;
      renderHistory();
    });
    const next = document.createElement("button");
    next.textContent = "다음 ▸";
    next.disabled = end >= total;
    next.addEventListener("click", () => {
      page += 1;
      renderHistory();
    });
    el.appendChild(prev);
    el.appendChild(document.createTextNode(` ${start}–${end} / ${total}건 `));
    el.appendChild(next);
  }

  function setChip(el, attr) {
    document.querySelectorAll(`.fchip[data-${attr}]`).forEach((c) => c.classList.remove("on"));
    el.classList.add("on");
  }

  function setHistoryFilter(el) {
    setChip(el, "hi");
    fDir = el.dataset.hi;
    page = 0;
    renderHistory();
  }

  function setAssetFilter(el) {
    setChip(el, "ta");
    fAsset = el.dataset.ta;
    page = 0;
    renderHistory();
  }

  function setPeriod(el) {
    setChip(el, "tp");
    fPeriod = el.dataset.tp;
    page = 0;
    renderHistory();
  }

  // ── 통합 입출금 폼 ──
  function setFormAsset(a, el) {
    formAsset = a;
    document.querySelectorAll("#txAssetSeg span").forEach((s) => s.classList.toggle("on", s === el));
    document.getElementById("diamondOwner").classList.toggle("hidden", a !== "다이아");
    document.getElementById("txAmount").placeholder = a === "다이아" ? "수량 (개)" : "금액 (원)";
  }

  function initForms() {
    document.querySelectorAll("#txAssetSeg span").forEach((s) => {
      s.addEventListener("click", () => setFormAsset(s.dataset.asset, s));
    });

    document.getElementById("txForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("txSubmitBtn");
      btn.disabled = true;
      try {
        const tx = {
          asset_type: formAsset,
          direction: document.getElementById("txDirection").value,
          amount: parseInt(document.getElementById("txAmount").value, 10),
          description: document.getElementById("txDesc").value.trim(),
        };
        if (formAsset === "다이아") {
          const ownerSel = document.getElementById("diamondOwner");
          if (!ownerSel.value) throw new Error("룻자(운영진) 목록을 불러오지 못했습니다.");
          const owner = staffOwners.find((m) => m.user_id === ownerSel.value);
          tx.owner_user_id = ownerSel.value;
          tx.owner_name = owner ? owner.current_id || owner.user_id : ownerSel.value;
        }
        await Api.createTreasuryTransaction(tx);
        document.getElementById("txForm").reset();
        toast(`✓ ${formAsset} 처리 완료`);
        await load();
      } catch (err) {
        toast(err.message || "처리 실패", true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function requestDelete(h) {
    pendingDeleteId = h.id;
    const sign = h.direction === "입금" ? "+" : "-";
    const unit = h.asset_type === "현금" ? "원" : "개";
    document.getElementById("treasuryDeleteModalMsg").textContent =
      `[${h.asset_type}] ${h.direction} ${sign}${(h.amount || 0).toLocaleString()}${unit} (${h.owner_name || "-"}) 이력을 삭제할까요? 잔액이 자동으로 되돌아갑니다.`;
    document.getElementById("treasuryDeleteModalBackdrop").classList.add("on");
  }

  function initDeleteModal() {
    document.getElementById("treasuryDeleteCancelBtn").addEventListener("click", () => {
      pendingDeleteId = null;
      document.getElementById("treasuryDeleteModalBackdrop").classList.remove("on");
    });
    document.getElementById("treasuryDeleteConfirmBtn").addEventListener("click", async () => {
      if (!pendingDeleteId) return;
      try {
        await Api.deleteTreasuryTransaction(pendingDeleteId);
        document.getElementById("treasuryDeleteModalBackdrop").classList.remove("on");
        toast("🗑️ 삭제(잔액 되돌림) 완료");
        pendingDeleteId = null;
        await load();
      } catch (err) {
        toast(err.message || "삭제 실패", true);
      }
    });
  }

  function init() {
    initForms();
    initDeleteModal();
  }

  return { init, load, setHistoryFilter, setAssetFilter, setPeriod };
})();
