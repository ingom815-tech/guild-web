// 공금 관리 화면: 잔액 조회(전 회원) + 수동 입출금(운영진 이상) + 이력(삭제는 관리자만)
const Treasury = (() => {
  let history = [];
  let activeHistoryFilter = "전체";
  let staffOwners = []; // 다이아 지급 대상 select용 — [{user_id, current_id}]
  let pendingDeleteId = null;

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

    try {
      const [balances, hist] = await Promise.all([Api.getTreasuryBalances(), Api.getTreasuryHistory({})]);
      renderBalances(balances);
      history = hist;
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
    document.getElementById("cashBalance").textContent = (data.cash.balance || 0).toLocaleString() + " 원";
    document.getElementById("diamondTotal").textContent = (data.diamond_total || 0).toLocaleString() + " 개";

    const listEl = document.getElementById("diamondList");
    document.querySelectorAll("#diamondList .irow[data-owner]").forEach((el) => el.remove());
    const emptyRow = document.getElementById("diamondEmpty");
    const diamonds = data.diamonds || [];
    emptyRow.style.display = diamonds.length ? "none" : "flex";

    diamonds
      .slice()
      .sort((a, b) => (b.balance || 0) - (a.balance || 0))
      .forEach((d) => {
        const row = document.createElement("div");
        row.className = "irow";
        row.dataset.owner = d.owner_user_id;
        row.innerHTML = `<span class="nm"></span><span style="margin-left:auto"></span>`;
        row.querySelector(".nm").textContent = d.owner_name || d.owner_user_id;
        row.querySelector("span:last-child").textContent = (d.balance || 0).toLocaleString() + " 개";
        listEl.appendChild(row);
      });
  }

  function renderHistory() {
    const listEl = document.getElementById("treasuryHistoryList");
    document.querySelectorAll("#treasuryHistoryList .irow[data-id]").forEach((el) => el.remove());
    const emptyRow = document.getElementById("treasuryHistoryEmpty");

    const rows = history.filter((h) => activeHistoryFilter === "전체" || h.direction === activeHistoryFilter);
    emptyRow.style.display = rows.length ? "none" : "flex";

    const isAdmin = (Auth.getUser() || {}).role === "관리자";
    rows.forEach((h) => {
      const row = document.createElement("div");
      row.className = "irow";
      row.dataset.id = h.id;
      const sign = h.direction === "입금" ? "+" : "-";
      const color = h.direction === "입금" ? "var(--green-dk)" : "#A32D2D";
      const unit = h.asset_type === "현금" ? "원" : "개";
      row.innerHTML = `
        <span class="badge b-gray" style="width:32px;text-align:center"></span>
        <span class="nm" style="min-width:70px"></span>
        <span style="font-weight:700;color:${color}">${sign}${(h.amount || 0).toLocaleString()} ${unit}</span>
        <span class="meta desc" style="flex:1"></span>
        <span class="meta owner" style="width:90px"></span>
        <span class="meta date" style="width:120px"></span>
        ${isAdmin ? `<button class="btn sm ghost" data-act="del" style="color:#A32D2D">삭제</button>` : ""}`;
      row.querySelector(".badge").textContent = h.asset_type;
      row.querySelector(".nm").textContent = h.direction;
      row.querySelector(".desc").textContent = h.description || "-";
      row.querySelector(".owner").textContent = h.owner_name || "-";
      row.querySelector(".date").textContent = h.created_at ? new Date(h.created_at).toLocaleString("ko-KR") : "";
      if (isAdmin) {
        row.querySelector('[data-act="del"]').addEventListener("click", () => requestDelete(h));
      }
      listEl.appendChild(row);
    });
  }

  function setHistoryFilter(el) {
    document.querySelectorAll(".fchip[data-hi]").forEach((c) => c.classList.remove("on"));
    el.classList.add("on");
    activeHistoryFilter = el.dataset.hi;
    renderHistory();
  }

  function initForms() {
    document.getElementById("cashTxForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("cashTxSubmitBtn");
      btn.disabled = true;
      try {
        await Api.createTreasuryTransaction({
          asset_type: "현금",
          direction: document.getElementById("cashDirection").value,
          amount: parseInt(document.getElementById("cashAmount").value, 10),
          description: document.getElementById("cashDesc").value.trim(),
        });
        document.getElementById("cashTxForm").reset();
        toast("✓ 현금 처리 완료");
        await load();
      } catch (err) {
        toast(err.message || "처리 실패", true);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("diamondTxForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("diamondTxSubmitBtn");
      btn.disabled = true;
      try {
        const ownerSel = document.getElementById("diamondOwner");
        const owner = staffOwners.find((m) => m.user_id === ownerSel.value);
        await Api.createTreasuryTransaction({
          asset_type: "다이아",
          direction: document.getElementById("diamondDirection").value,
          amount: parseInt(document.getElementById("diamondAmount").value, 10),
          owner_user_id: ownerSel.value,
          owner_name: owner ? owner.current_id || owner.user_id : ownerSel.value,
          description: document.getElementById("diamondDesc").value.trim(),
        });
        document.getElementById("diamondTxForm").reset();
        toast("✓ 다이아 처리 완료");
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

  return { init, load, setHistoryFilter };
})();
