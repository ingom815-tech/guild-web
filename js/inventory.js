// 재고 관리 화면: 목록 렌더/필터/등록/수정/삭제(2단계 확인)
const Inventory = (() => {
  const GRADES = ["희귀", "영웅", "전설", "신화", "절대자"];
  // 공식 아이템 구분 5분류 — 앞으로 등록되는 아이템은 이 중에서만 선택 (구 값은 category5로 환산)
  const CATEGORIES = GameData.DIST_CATEGORIES;
  const GRADE_BADGE = { 신화: "b-myth", 전설: "b-legend", 영웅: "b-hero", 희귀: "b-rare" };

  let items = [];
  let itemMaster = []; // [{item_name, grade, category}, ...] — 자동완성 + 등급/구분 자동 채움용
  let activeGradeFilter = "전체";
  let pendingDeleteId = null;

  function gradeClass(grade) {
    return GRADE_BADGE[grade] || "b-gray";
  }

  function fillSelect(sel, options) {
    sel.innerHTML = options.map((o) => `<option value="${o}">${o}</option>`).join("");
  }

  function initSelects() {
    ["dropGrade", "editGrade"].forEach((id) => fillSelect(document.getElementById(id), GRADES));
    ["dropCategory", "editCategory"].forEach((id) => fillSelect(document.getElementById(id), CATEGORIES));
  }

  // 기존 시스템처럼 등록된 아이템명 목록으로 자동완성(datalist) 제공 + 정확히 일치하는
  // 이름을 고르면 등급/구분을 자동으로 채워준다.
  async function loadItemMaster() {
    try {
      itemMaster = (await Api.listItemMaster()) || [];
    } catch (e) {
      itemMaster = [];
      return;
    }
    const list = document.getElementById("itemMasterList");
    if (list) {
      list.innerHTML = itemMaster.map((m) => `<option value="${m.item_name}"></option>`).join("");
    }
  }

  function autoFillFromItemMaster(nameInputId, gradeSelectId, categorySelectId) {
    const nameInput = document.getElementById(nameInputId);
    nameInput.addEventListener("input", () => {
      const match = itemMaster.find((m) => m.item_name === nameInput.value.trim());
      if (!match) return;
      if (match.grade && GRADES.includes(match.grade)) {
        document.getElementById(gradeSelectId).value = match.grade;
      }
      // 아이템 사전에 구 구분 값이 남아 있어도 공식 5분류로 환산해 채운다
      document.getElementById(categorySelectId).value = GameData.category5(match.item_name, match.category, match.grade);
    });
  }

  function toast(msg, isErr) {
    const t = document.getElementById("invToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "") ;
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 4000);
  }
  function dropToast(msg, isErr) {
    const t = document.getElementById("dropToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(dropToast._t);
    dropToast._t = setTimeout(() => (t.style.display = "none"), 4000);
  }

  async function load() {
    const list = document.getElementById("invTable");
    try {
      items = await Api.listInventory();
    } catch (e) {
      toast(e.message || "재고 조회 실패", true);
      return;
    }
    render();
  }

  // 등급 필터 칩마다 건수 배지 표시 (검색어와 무관하게 전체 재고 기준, 0건은 흐리게)
  function updateGradeCounts() {
    document.querySelectorAll('.fchip[data-gi]').forEach((chip) => {
      const key = chip.dataset.gi;
      const n =
        key === "전체" ? items.length :
        key === "미신청" ? items.filter((it) => (it.applicant_count || 0) === 0).length :
        items.filter((it) => it.grade === key).length;
      let cnt = chip.querySelector(".cnt");
      if (!cnt) {
        cnt = document.createElement("span");
        cnt.className = "cnt";
        chip.appendChild(cnt);
      }
      cnt.textContent = n;
      chip.classList.toggle("empty", n === 0);
    });
  }

  function render() {
    updateGradeCounts();
    const container = document.getElementById("invTable");
    const q = (document.getElementById("qi").value || "").trim();
    const rows = items.filter((it) => {
      const gradeHit =
        activeGradeFilter === "전체" ||
        (activeGradeFilter === "미신청" ? (it.applicant_count || 0) === 0 : it.grade === activeGradeFilter);
      const qHit = !q || (it.item_name || "").includes(q);
      return gradeHit && qHit;
    });

    // 헤더 행은 정적 HTML에 이미 있으므로 데이터 행만 갈아끼움
    document.querySelectorAll("#invTable .irow[data-id]").forEach((el) => el.remove());
    const emptyRow = document.getElementById("invEmpty");
    emptyRow.style.display = rows.length ? "none" : "flex";

    const staff = Auth.isStaff();
    rows.forEach((it) => {
      const row = document.createElement("div");
      row.className = "irow two"; // r1/r2 래퍼는 데스크톱에서 display:contents (레이아웃 불변), 모바일 2단 행
      row.dataset.id = it.id;
      const applied = it.applicant_count || 0;
      const appliedHtml = applied === 0
        ? `<span style="width:60px;color:#A32D2D;font-weight:600" class="ap">⚠️ 0</span>`
        : `<span style="width:60px" class="ap">${applied}명</span>`;
      row.innerHTML = `
        <div class="r1">
          <span style="width:56px">${it.grade ? `<span class="badge ${gradeClass(it.grade)}">${it.grade}</span>` : ""}</span>
          <span class="nm"></span>
          <span style="width:60px">수량 ${it.quantity}</span>
        </div>
        <div class="r2">
          ${appliedHtml}
          <span style="width:100px" class="meta lt"></span>
          <span style="margin-left:auto;display:flex;gap:6px" class="staff-only">
            <button class="btn sm ghost" data-act="edit">수정</button>
            <button class="btn sm ghost" data-act="delete" style="color:#A32D2D">삭제</button>
          </span>
        </div>`;
      row.querySelector(".nm").textContent = it.item_name;
      row.querySelector(".lt").textContent = it.looter || "-";
      if (staff) {
        row.querySelector('[data-act="edit"]').addEventListener("click", () => openEdit(it));
        row.querySelector('[data-act="delete"]').addEventListener("click", () => requestDelete(it));
      }
      container.appendChild(row);
    });
  }

  function filter() {
    render();
  }

  function setGrade(el) {
    document.querySelectorAll(".fchip[data-gi]").forEach((c) => c.classList.remove("on"));
    el.classList.add("on");
    activeGradeFilter = el.dataset.gi;
    render();
  }

  // ── 드랍 등록 ──
  function initDropForm() {
    const form = document.getElementById("dropForm");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("dropSubmitBtn");
      btn.disabled = true;
      const payload = {
        item_name: document.getElementById("dropName").value.trim(),
        grade: document.getElementById("dropGrade").value,
        category: document.getElementById("dropCategory").value,
        quantity: parseInt(document.getElementById("dropQty").value, 10) || 1,
        looter: document.getElementById("dropLooter").value.trim(),
        free_apply: document.getElementById("dropFree").checked,
      };
      try {
        await Api.createInventoryItem(payload);
        dropToast(`✓ ${payload.item_name} 등록 완료`);
        form.reset();
        document.getElementById("dropQty").value = 1;
        await load();
      } catch (err) {
        dropToast(err.message || "등록 실패", true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ── 텍스트 로그 파싱 → 장바구니 ──
  let cart = [];
  let unmatchedList = [];

  function cartToast(msg, isErr) {
    const t = document.getElementById("logResultToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
  }

  function initLogParse() {
    document.getElementById("logParseBtn").addEventListener("click", () => {
      const text = document.getElementById("logText").value;
      if (!text.trim()) {
        cartToast("텍스트를 붙여넣어주세요.", true);
        return;
      }
      if (!itemMaster.length) {
        cartToast("아이템 목록을 아직 불러오지 못했어요. 잠시 후 다시 시도해주세요.", true);
        return;
      }
      const defaultLooter = document.getElementById("logDefaultLooter").value.trim();
      const result = LogParser.parse(text, itemMaster, defaultLooter);

      if (!result.matched.length && !result.unmatched.length) {
        cartToast(result.isBlockFormat ? "전리품 섹션을 찾지 못했습니다." : "레이드 로그 형식도, '아이템명 수량' 형식도 인식되지 않습니다.", true);
        return;
      }
      if (!result.matched.length) {
        cartToast("아이템 목록과 매칭되는 전리품이 없습니다.", true);
        return;
      }

      for (const m of result.matched) {
        cart.push({
          _cid: Math.random().toString(36).slice(2, 10),
          item_name: m.item_name,
          grade: m.grade,
          category: GameData.category5(m.item_name, m.category, m.grade),
          quantity: m.quantity,
          looter: m.looter || defaultLooter || "",
          drop_date: m.drop_date || null,
          boss_name: m.boss_name || null,
          raid_type: "결사",
          fuzzy: !!m.fuzzy,
          log_name: m.log_name || "",
          // 정확매칭은 신뢰도가 높아 기본 체크, 유사매칭은 사람이 직접 확인 후 체크해야 등록되도록 기본 해제.
          selected: !m.fuzzy,
        });
      }

      const exactCnt = result.matched.filter((m) => !m.fuzzy).length;
      const fuzzyCnt = result.matched.length - exactCnt;
      let msg = `✓ 총 ${result.matched.length}건 장바구니에 추가됨 (정확 ${exactCnt}건 / 유사매칭 ${fuzzyCnt}건)`;
      if (result.isBlockFormat) msg += ` — ${result.blockCount}개 보스 블록`;
      cartToast(msg, false);
      document.getElementById("logText").value = "";

      unmatchedList = unmatchedList.concat(result.unmatched);
      renderUnmatched();
      renderCart();
    });

    document.getElementById("unmatchedClearBtn").addEventListener("click", () => {
      unmatchedList = [];
      renderUnmatched();
    });
  }

  // ── 미매칭 항목: 파싱 직후 사라지지 않도록 별도 카드에 계속 유지 ──
  function renderUnmatched() {
    const card = document.getElementById("unmatchedCard");
    const listEl = document.getElementById("unmatchedList");
    document.getElementById("unmatchedCount").textContent = unmatchedList.length;
    card.classList.toggle("hidden", unmatchedList.length === 0);
    listEl.innerHTML = "";

    unmatchedList.forEach((u, idx) => {
      const row = document.createElement("div");
      row.className = "irow";
      row.innerHTML = `
        <span class="nm"></span>
        <span class="meta"></span>
        <button type="button" class="btn ghost sm" data-act="fill">✎ 등록폼에 채우기</button>
        <button type="button" class="btn ghost sm" data-act="drop" style="color:#A32D2D">✖</button>`;
      row.querySelector(".nm").textContent = u.name;
      row.querySelector(".meta").textContent = `${u.qty}개${u.boss && u.boss !== "-" ? " · " + u.boss : ""}`;
      row.querySelector('[data-act="fill"]').addEventListener("click", () => {
        const nameInput = document.getElementById("dropName");
        nameInput.value = u.name;
        nameInput.dispatchEvent(new Event("input"));
        document.getElementById("dropQty").value = u.qty || 1;
        nameInput.scrollIntoView({ behavior: "smooth", block: "center" });
        nameInput.focus();
      });
      row.querySelector('[data-act="drop"]').addEventListener("click", () => {
        unmatchedList = unmatchedList.filter((_, i) => i !== idx);
        renderUnmatched();
      });
      listEl.appendChild(row);
    });
  }

  // 체크된 항목만 실제 등록 대상. 정확매칭은 기본 체크, 유사매칭은 기본 해제 — 운영진이 직접 확인 후 체크해야 등록됨.
  function applySelectedStyle(row, item) {
    row.style.opacity = item.selected ? "1" : ".5";
  }

  // 정확매칭: 배지+이름+수량만 보이는 한 줄 요약 행. 유사매칭: 룻자/유형까지 전부 보이는 상세 행 + 경고 표시.
  function buildCartRow(item, compact) {
    const row = document.createElement("div");
    row.className = "irow";
    if (item.fuzzy) row.style.background = "#FFF7E6";

    if (compact) {
      row.style.padding = "7px 18px";
      row.innerHTML = `
        <input type="checkbox" class="cart-check">
        <span class="badge ${gradeClass(item.grade)}"></span>
        <b style="min-width:160px"></b>
        <input type="number" class="cart-qty qty-input" min="1" value="${item.quantity}">
        <button type="button" class="btn sm ghost" data-act="remove" style="margin-left:auto;color:#A32D2D">✖</button>`;
      row.querySelector(".badge").textContent = item.grade || "";
      row.querySelector("b").textContent = item.item_name;
      row.querySelector(".cart-check").checked = item.selected;
      row.querySelector(".cart-check").addEventListener("change", (e) => {
        item.selected = e.target.checked;
        applySelectedStyle(row, item);
        updateCartSummary();
      });
      row.querySelector(".cart-qty").addEventListener("input", (e) => (item.quantity = parseInt(e.target.value, 10) || 1));
      row.querySelector('[data-act="remove"]').addEventListener("click", () => {
        cart = cart.filter((c) => c._cid !== item._cid);
        renderCart();
      });
      applySelectedStyle(row, item);
      return row;
    }

    const meta = [];
    if (item.drop_date) meta.push(`📅${item.drop_date}`);
    if (item.boss_name) meta.push(`👾${item.boss_name}`);
    row.innerHTML = `
      <input type="checkbox" class="cart-check" style="align-self:flex-start;margin-top:3px">
      <span style="min-width:180px">
        <b></b> <span class="badge ${gradeClass(item.grade)}" style="margin-left:4px"></span>
        <span class="meta" style="margin-left:4px"></span>
        <div class="fuzzy-warn meta" style="color:#B8860B;font-weight:600"></div>
        ${meta.length ? `<div class="meta">${meta.join(" ")}</div>` : ""}
      </span>
      <input type="text" class="cart-looter" placeholder="룻자" style="width:100px;border:1px solid var(--line);border-radius:7px;padding:5px 8px;font-size:13px">
      <select class="cart-rt" style="border:1px solid var(--line);border-radius:7px;padding:5px 8px;font-size:13px">
        <option value="결사">결사</option>
        <option value="연합">연합</option>
      </select>
      <input type="number" class="cart-qty qty-input" min="1" value="${item.quantity}">
      <button type="button" class="btn sm ghost" data-act="remove" style="color:#A32D2D;margin-left:auto">✖</button>`;
    row.querySelector("b").textContent = item.item_name;
    row.querySelector(".badge").textContent = item.grade || "";
    row.querySelector(".meta").textContent = item.category || "";
    row.querySelector(".fuzzy-warn").textContent = `⚠️ 유사매칭 (로그: "${item.log_name}") — 확인 필요, 체크해야 등록됩니다`;
    row.querySelector(".cart-rt").value = item.raid_type;
    row.querySelector(".cart-looter").value = item.looter || "";
    row.querySelector(".cart-check").checked = item.selected;
    row.querySelector(".cart-check").addEventListener("change", (e) => {
      item.selected = e.target.checked;
      applySelectedStyle(row, item);
      updateCartSummary();
    });
    row.querySelector(".cart-looter").addEventListener("input", (e) => (item.looter = e.target.value.trim()));
    row.querySelector(".cart-rt").addEventListener("change", (e) => (item.raid_type = e.target.value));
    row.querySelector(".cart-qty").addEventListener("input", (e) => (item.quantity = parseInt(e.target.value, 10) || 1));
    row.querySelector('[data-act="remove"]').addEventListener("click", () => {
      cart = cart.filter((c) => c._cid !== item._cid);
      renderCart();
    });
    applySelectedStyle(row, item);
    return row;
  }

  function updateCartSummary() {
    const selectedCount = cart.filter((c) => c.selected).length;
    document.getElementById("dropCartCount").textContent = `${selectedCount}/${cart.length}`;
  }

  function renderCart() {
    const card = document.getElementById("dropCartCard");
    const listEl = document.getElementById("dropCartList");
    card.classList.toggle("hidden", cart.length === 0);
    listEl.innerHTML = "";
    updateCartSummary();

    const fuzzyItems = cart.filter((c) => c.fuzzy);
    const exactItems = cart.filter((c) => !c.fuzzy);

    if (fuzzyItems.length) {
      const head = document.createElement("div");
      head.style.cssText = "font-weight:700;font-size:13px;color:#B8860B;margin:2px 0 6px";
      head.textContent = `⚠️ 확인 필요 — 유사매칭 (${fuzzyItems.length}건, 체크해야 등록됨)`;
      listEl.appendChild(head);
      fuzzyItems.forEach((item) => listEl.appendChild(buildCartRow(item, false)));
    }

    if (exactItems.length) {
      const totalQty = exactItems.reduce((s, i) => s + (i.quantity || 0), 0);
      const details = document.createElement("details");
      details.style.marginTop = fuzzyItems.length ? "12px" : "0";
      details.open = fuzzyItems.length === 0;
      const summary = document.createElement("summary");
      summary.style.cssText = "cursor:pointer;font-weight:700;font-size:13px;color:var(--green-dk);padding:4px 0";
      summary.textContent = `✅ 정확매칭 (${exactItems.length}건, 총 ${totalQty}개)`;
      details.appendChild(summary);
      const body = document.createElement("div");
      body.style.marginTop = "6px";
      exactItems.forEach((item) => body.appendChild(buildCartRow(item, true)));
      details.appendChild(body);
      listEl.appendChild(details);
    }
  }

  function initCartActions() {
    document.getElementById("dropCartClearBtn").addEventListener("click", () => {
      cart = [];
      renderCart();
    });

    document.getElementById("dropCartSelectAllBtn").addEventListener("click", () => {
      cart.forEach((c) => (c.selected = true));
      renderCart();
    });

    document.getElementById("dropCartSelectNoneBtn").addEventListener("click", () => {
      cart.forEach((c) => (c.selected = false));
      renderCart();
    });

    document.getElementById("dropCartSubmitBtn").addEventListener("click", () => {
      const toSubmit = cart.filter((c) => c.selected);
      if (!toSubmit.length) {
        cartToast("체크된 항목이 없습니다. 등록할 항목을 먼저 체크해주세요.", true);
        return;
      }
      const listEl = document.getElementById("batchConfirmList");
      listEl.innerHTML = toSubmit
        .map(
          (c, i) =>
            `<div style="padding:4px 0;border-top:${i ? "1px solid #eceef1" : "none"}">${i + 1}. [${c.raid_type}] <b>${c.item_name}</b> [${c.grade}] × ${c.quantity} → ${c.looter || "-"}${c.fuzzy ? ` <span style="color:#B8860B">(유사매칭, 로그: "${c.log_name}")</span>` : ""}</div>`
        )
        .join("");
      document.getElementById("batchConfirmBackdrop").classList.add("on");
    });

    document.getElementById("batchConfirmCancelBtn").addEventListener("click", () => {
      document.getElementById("batchConfirmBackdrop").classList.remove("on");
    });

    document.getElementById("batchConfirmYesBtn").addEventListener("click", async () => {
      const btn = document.getElementById("batchConfirmYesBtn");
      btn.disabled = true;
      try {
        const toSubmit = cart.filter((c) => c.selected);
        const submittedCount = toSubmit.length;
        const res = await Api.createInventoryItemsBatch(toSubmit.map((c) => ({
          item_name: c.item_name,
          grade: c.grade,
          category: c.category,
          quantity: c.quantity,
          looter: c.looter,
          drop_date: c.drop_date,
          boss_name: c.boss_name,
          raid_type: c.raid_type,
        })));
        document.getElementById("batchConfirmBackdrop").classList.remove("on");
        // 체크했던(제출한) 항목만 카트에서 제거 — 체크 안 한 항목은 계속 확인할 수 있도록 남겨둠.
        const submittedIds = new Set(toSubmit.map((c) => c._cid));
        cart = cart.filter((c) => !submittedIds.has(c._cid));
        renderCart();
        const inserted = res.inserted != null ? res.inserted : submittedCount;
        const failed = res.failed || 0;
        if (failed > 0) {
          const detail = Array.isArray(res.errors) && res.errors.length ? " (" + res.errors.slice(0, 3).join(", ") + (res.errors.length > 3 ? " 외" : "") + ")" : "";
          dropToast(`⚠️ ${inserted}건 등록, ${failed}건 실패${detail}`, true);
        } else {
          dropToast(`✅ 총 ${inserted}건 등록 완료! 아이템이 재고에 추가되었습니다.`);
        }
        await load();
      } catch (err) {
        cartToast(err.message || "일괄 등록 실패", true);
        document.getElementById("batchConfirmBackdrop").classList.remove("on");
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ── 수정 ──
  function openEdit(it) {
    document.getElementById("editName").value = it.item_name;
    document.getElementById("editGrade").value = it.grade || GRADES[0];
    document.getElementById("editCategory").value = GameData.category5(it.item_name, it.category, it.grade);
    document.getElementById("editQty").value = it.quantity;
    document.getElementById("editLooter").value = it.looter || "";
    document.getElementById("editFree").checked = !!it.free_apply;
    document.getElementById("editForm").dataset.id = it.id;
    document.getElementById("editModalBackdrop").classList.add("on");
  }

  function initEditModal() {
    document.getElementById("editCancelBtn").addEventListener("click", () => {
      document.getElementById("editModalBackdrop").classList.remove("on");
    });
    document.getElementById("editForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = document.getElementById("editForm").dataset.id;
      const payload = {
        item_name: document.getElementById("editName").value.trim(),
        grade: document.getElementById("editGrade").value,
        category: document.getElementById("editCategory").value,
        quantity: parseInt(document.getElementById("editQty").value, 10),
        looter: document.getElementById("editLooter").value.trim(),
        free_apply: document.getElementById("editFree").checked,
      };
      try {
        await Api.updateInventoryItem(id, payload);
        document.getElementById("editModalBackdrop").classList.remove("on");
        toast("✓ 수정 완료");
        await load();
      } catch (err) {
        toast(err.message || "수정 실패", true);
      }
    });
  }

  // ── 삭제 (2단계 확인) ──
  async function requestDelete(it) {
    try {
      const res = await Api.deleteInventoryItem(it.id, false);
      pendingDeleteId = it.id;
      const cnt = (res && res.applicant_count) || 0;
      document.getElementById("deleteModalMsg").textContent =
        cnt > 0
          ? `"${it.item_name}"에 ${cnt}명이 신청 중입니다. 정말 삭제할까요? 신청 내역도 함께 삭제됩니다.`
          : `"${it.item_name}"을(를) 삭제할까요?`;
      document.getElementById("deleteModalBackdrop").classList.add("on");
    } catch (err) {
      toast(err.message || "삭제 확인 실패", true);
    }
  }

  function initDeleteModal() {
    document.getElementById("deleteCancelBtn").addEventListener("click", () => {
      pendingDeleteId = null;
      document.getElementById("deleteModalBackdrop").classList.remove("on");
    });
    document.getElementById("deleteConfirmBtn").addEventListener("click", async () => {
      if (!pendingDeleteId) return;
      try {
        await Api.deleteInventoryItem(pendingDeleteId, true);
        document.getElementById("deleteModalBackdrop").classList.remove("on");
        toast("🗑️ 삭제되었습니다");
        pendingDeleteId = null;
        await load();
      } catch (err) {
        toast(err.message || "삭제 실패", true);
      }
    });
  }

  function init() {
    initSelects();
    initDropForm();
    initEditModal();
    initDeleteModal();
    initLogParse();
    initCartActions();
    autoFillFromItemMaster("dropName", "dropGrade", "dropCategory");
    autoFillFromItemMaster("editName", "editGrade", "editCategory");
  }

  return { init, load, filter, setGrade, loadItemMaster, GRADES, CATEGORIES };
})();
