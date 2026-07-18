// 분배 후반부: 신청 현황(분배 현황 탭) / 확정 처리(결과 탭) / 분배 이력(이력 탭).
// 원본 app.py _render_request_status / 확정 처리 탭 / _render_distribution_history_mgmt 이식.
const DistManage = (() => {
  const TAB_ORDER = ["브로치", "별빛심연석 및 조각", "찬란한심연석", "전퀴", "나머지"];
  let statusData = null;
  let statusTab = "브로치";
  let resultData = null;
  let staffList = []; // 다이아 지급 대상(룻자) 선택용 — 운영진/관리자만
  let historyData = null;
  let confirmAction = null;

  function toast(sectionId, msg, isErr) {
    const t = document.getElementById(sectionId);
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(t._t);
    t._t = setTimeout(() => (t.style.display = "none"), 5000);
  }

  // ── 공용 확인 모달 ──
  function openConfirm(title, msg, action, yesLabel) {
    confirmAction = action;
    document.getElementById("dmConfirmTitle").textContent = title;
    document.getElementById("dmConfirmMsg").textContent = msg;
    document.getElementById("dmConfirmYesBtn").textContent = yesLabel || "확인";
    document.getElementById("dmConfirmBackdrop").classList.add("on");
  }

  function initConfirmModal() {
    document.getElementById("dmConfirmCancelBtn").addEventListener("click", () => {
      confirmAction = null;
      document.getElementById("dmConfirmBackdrop").classList.remove("on");
    });
    document.getElementById("dmConfirmYesBtn").addEventListener("click", async () => {
      const action = confirmAction;
      confirmAction = null;
      document.getElementById("dmConfirmBackdrop").classList.remove("on");
      if (action) await action();
    });
  }

  function gradeBadge(grade) {
    if (!grade) return "";
    const cls = grade.includes("전설") ? "b-legend" : grade.includes("신화") || grade.includes("절대자") ? "b-myth" : "";
    const span = document.createElement("span");
    span.className = "role-badge " + cls;
    span.textContent = grade;
    return span.outerHTML;
  }

  // ═══════════════ 1) 신청 현황 ═══════════════

  async function loadStatus() {
    try {
      statusData = await Api.getDistStatus();
    } catch (e) {
      toast("statusToast", e.message || "신청 현황 조회 실패", true);
      return;
    }
    // 기본 탭: 신청이 있는 첫 탭
    const withReq = TAB_ORDER.find((t) =>
      (statusData.groups || []).some((g) => g.tab === t && g.requests.length),
    );
    statusTab = withReq || TAB_ORDER[0];
    renderStatus();
  }

  function setStatusTab(tab) {
    statusTab = tab;
    renderStatus();
  }

  function renderStatus() {
    if (!statusData) return;
    const groups = statusData.groups || [];
    const staff = !!statusData.is_staff;
    const totalReq = groups.reduce((s, g) => s + g.requests.length, 0);
    const periodOn = statusData.period && statusData.period.status === "진행중";
    document.getElementById("statusMeta").textContent =
      ` 신청 ${totalReq}건 · 품목 ${groups.filter((g) => g.requests.length).length}개 · ${periodOn ? "🟢 신청 기간 진행중" : "⏸ 신청 기간 아님"}`;

    // 자격 미달 카드 (운영진)
    const ineligRows = [];
    if (staff) {
      groups.forEach((g) => g.requests.forEach((r) => {
        if (r.ineligible) ineligRows.push({ ...r, item_name: g.item_name });
      }));
    }
    const ineligCard = document.getElementById("statusIneligCard");
    ineligCard.classList.toggle("hidden", !ineligRows.length);
    if (ineligRows.length) {
      document.getElementById("statusIneligCount").textContent = ineligRows.length;
      const list = document.getElementById("statusIneligList");
      list.innerHTML = "";
      ineligRows.forEach((r) => {
        const row = document.createElement("div");
        row.className = "irow";
        row.innerHTML = `<b class="nm"></b><span class="meta it"></span><span class="meta rs" style="margin-left:auto"></span>`;
        row.querySelector(".nm").textContent = r.nick;
        row.querySelector(".it").textContent = r.item_name;
        row.querySelector(".rs").textContent = r.inelig_reason || "";
        list.appendChild(row);
      });
      const btn = document.getElementById("statusBulkCancelBtn");
      btn.onclick = () =>
        openConfirm("자격 미달 일괄 취소", `자격 미달 신청 ${ineligRows.length}건을 전부 취소할까요?`, async () => {
          try {
            const res = await Api.bulkCancelRequests(ineligRows.map((r) => r.id));
            toast("statusToast", `✓ ${res.cancelled}건 취소했습니다.`);
            await loadStatus();
          } catch (e) {
            toast("statusToast", e.message || "일괄 취소 실패", true);
          }
        }, "일괄 취소");
    }

    // 탭 칩 (5개 고정 + 건수)
    const tabsEl = document.getElementById("statusTabs");
    tabsEl.innerHTML = "";
    TAB_ORDER.forEach((t) => {
      const cnt = groups.filter((g) => g.tab === t && g.requests.length).length;
      const chip = document.createElement("span");
      chip.className = "fchip" + (statusTab === t ? " on" : "");
      chip.textContent = `${t} (${cnt})`;
      chip.addEventListener("click", () => setStatusTab(t));
      tabsEl.appendChild(chip);
    });

    // 정렬
    const sort = document.getElementById("statusSort").value;
    let tabGroups = groups.filter((g) => g.tab === statusTab);
    if (sort === "comp") {
      tabGroups.sort((a, b) => b.requests.length / Math.max(b.quantity, 1) - a.requests.length / Math.max(a.quantity, 1));
    } else if (sort === "name") {
      tabGroups.sort((a, b) => String(a.item_name).localeCompare(String(b.item_name)));
    } else {
      tabGroups.sort((a, b) => ((b.requests[0] || {}).score || 0) - ((a.requests[0] || {}).score || 0));
    }

    const listEl = document.getElementById("statusList");
    listEl.innerHTML = "";

    // 전퀴 탭: 중복 신청자 경고 (같은 사람이 전설 아퀴 2개 이상 신청 — 정보성, 원본 동일)
    if (statusTab === "전퀴") {
      const perUser = Object.create(null);
      tabGroups.forEach((g) => g.requests.forEach((r) => {
        (perUser[r.nick] = perUser[r.nick] || []).push(g.item_name);
      }));
      const dups = Object.entries(perUser).filter(([, items]) => items.length >= 2);
      if (dups.length) {
        const warn = document.createElement("div");
        warn.className = "card";
        warn.style.cssText = "background:var(--gold-bg);border-color:var(--myth-bd)";
        warn.innerHTML = `<b style="font-size:13px;color:var(--gold-tx)">⚠️ 중복 신청자 (전설 아퀴는 1인 1개)</b><div class="meta dupbody" style="margin-top:6px;white-space:pre-line"></div>`;
        warn.querySelector(".dupbody").textContent = dups.map(([nick, items]) => `${nick}: ${items.join(", ")}`).join("\n");
        listEl.appendChild(warn);
      }
    }

    if (!tabGroups.length) {
      listEl.innerHTML = `<div class="card meta">이 분류에 재고가 없습니다.</div>`;
      return;
    }

    tabGroups.forEach((g) => {
      const card = document.createElement("div");
      card.className = "card";
      const comp = (g.requests.length / Math.max(g.quantity, 1)).toFixed(1);
      card.innerHTML = `
        <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:6px">
          <div><b class="inm" style="font-size:14.5px"></b> ${gradeBadge(g.grade)}
            <span class="meta">수량 ${g.quantity} · 신청 ${g.requests.length}건 · 경쟁률 ${comp}:1</span></div>
          <span class="meta lt"></span>
        </div>
        <div class="reqbody" style="margin-top:8px"></div>`;
      card.querySelector(".inm").textContent = g.item_name;
      card.querySelector(".lt").textContent = g.looters && g.looters.length ? `룻: ${g.looters.join(", ")}` : "";

      const body = card.querySelector(".reqbody");
      if (!g.requests.length) {
        body.innerHTML = `<span class="meta">신청자가 없습니다.</span>`;
      } else {
        // 원본: 상위 quantity명 = 선정 예정(확정권), 이하 = 확정권 밖
        const cut = g.quantity;
        const sub = (label, rows, startIdx, inCut) => {
          if (!rows.length) return;
          const head = document.createElement("div");
          head.className = "meta";
          head.style.cssText = `font-weight:600;margin:6px 0 4px;color:${inCut ? "var(--green-dk)" : "var(--txt3)"}`;
          head.textContent = label;
          body.appendChild(head);
          rows.forEach((r, i) => {
            const line = document.createElement("div");
            line.className = "irow";
            line.style.cssText = inCut ? "background:var(--green-bg);border-radius:8px;margin-bottom:2px" : "";
            line.innerHTML = `
              <span style="width:26px" class="meta">${startIdx + i + 1}.</span>
              <b class="nm"></b>
              <span class="meta sc" style="width:110px"></span>
              <span class="meta qy" style="width:46px"></span>
              <span class="prefs"></span>
              <span class="warn" style="color:#A32D2D;font-size:12px"></span>
              <span style="margin-left:auto" class="act"></span>`;
            line.querySelector(".nm").textContent = r.nick;
            line.querySelector(".sc").textContent = `기여 ${(r.score || 0).toLocaleString()}`;
            line.querySelector(".qy").textContent = `${r.qty}개`;
            if (r.preference_1) {
              const p = document.createElement("span");
              p.className = "meta";
              p.textContent = `1순위 ${r.preference_1}${r.preference_2 ? ` · 2순위 ${r.preference_2}` : ""}`;
              line.querySelector(".prefs").appendChild(p);
            }
            if (r.ineligible) {
              line.querySelector(".warn").textContent = "⚠ 자격 미달";
              line.querySelector(".warn").title = r.inelig_reason || "";
            }
            if (staff) {
              const btn = document.createElement("button");
              btn.className = "btn sm";
              btn.textContent = "확정";
              btn.addEventListener("click", () =>
                openConfirm("분배 확정", `"${r.nick}"님에게 [${g.item_name}] ${r.qty}개를 확정할까요?`, async () => {
                  try {
                    await Api.confirmDistribution(r.item_id, r.user_id);
                    toast("statusToast", `✓ ${r.nick} — ${g.item_name} 확정`);
                    await loadStatus();
                  } catch (e) {
                    toast("statusToast", e.message || "확정 실패", true);
                  }
                }, "확정"),
              );
              line.querySelector(".act").appendChild(btn);
            }
            body.appendChild(line);
          });
        };
        sub(`✅ 선정 예정 (상위 ${Math.min(cut, g.requests.length)}명)`, g.requests.slice(0, cut), 0, true);
        sub("확정권 밖", g.requests.slice(cut), cut, false);
      }
      listEl.appendChild(card);
    });
  }

  // ═══════════════ 2) 결과 (확정 처리) ═══════════════

  async function loadResult() {
    try {
      resultData = await Api.getConfirmedDistributions();
    } catch (e) {
      toast("resultToast", e.message || "확정 목록 조회 실패", true);
      return;
    }
    document.getElementById("resultStaff").classList.toggle("hidden", !resultData.is_staff);
    document.getElementById("resultMine").innerHTML = "";
    if (resultData.is_staff) {
      // 다이아는 룻자(운영진) 계좌로만 지급 — 선택 박스용 운영진 목록
      if (!staffList.length) {
        try {
          const members = await Api.listMembers();
          staffList = members.filter((m) => m.role === "운영진" || m.role === "관리자");
        } catch (e) {
          // 목록 조회 실패 시 선택 박스는 비어 있음 — 다이아 입력 시 검증에서 걸러짐
        }
      }
      renderResultStaff();
    } else {
      renderResultMine();
    }
  }

  function renderResultMine() {
    const box = document.getElementById("resultMine");
    const rows = resultData.rows || [];
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<b style="font-size:15px">🎁 내 확정 내역</b>
      <div class="meta" style="margin:4px 0 8px">확정된 아이템은 운영진이 나감 처리(승인)하면 지급/정산되고 이력에 기록됩니다.</div>
      <div class="list mine" style="border:0"></div>`;
    const list = card.querySelector(".mine");
    if (!rows.length) {
      list.innerHTML = `<div class="irow meta">확정된 신청이 없습니다.</div>`;
    } else {
      rows.forEach((r) => {
        const row = document.createElement("div");
        row.className = "irow";
        row.innerHTML = `<b class="nm"></b> ${gradeBadge(r.grade)}
          <span class="meta">${r.qty}개 · 신청일 ${String(r.request_date || "").slice(0, 10)}</span>
          <span style="margin-left:auto"><span class="role-badge">확정 — 운영진 승인 대기</span></span>`;
        row.querySelector(".nm").textContent = r.item_name;
        list.appendChild(row);
      });
    }
    box.appendChild(card);
  }

  // 충돌 그룹 판정 (원본 _get_conflict_group): 별빛심연석 / 전설 아퀴 — 캐릭터당 1개
  function conflictGroup(r) {
    if (String(r.item_name || "").includes("별빛심연석")) return "별빛심연석";
    if (String(r.category || "").includes("아퀴") && String(r.grade || "").includes("전설")) return "전설 아퀴";
    return null;
  }

  function renderResultStaff() {
    const rows = resultData.rows || [];
    const waitRows = rows;

    // ── 확정 대기 ──
    const waitPane = document.getElementById("resultWaitPane");
    waitPane.innerHTML = "";

    // 충돌 카드: 같은 유저가 같은 충돌 그룹에서 2건 이상 확정
    const byUserGroup = Object.create(null);
    waitRows.forEach((r) => {
      const grp = conflictGroup(r);
      if (!grp) return;
      const key = `${r.user_id}|${grp}`;
      (byUserGroup[key] = byUserGroup[key] || []).push(r);
    });
    Object.entries(byUserGroup)
      .filter(([, arr]) => arr.length >= 2)
      .forEach(([key, arr]) => {
        const grp = key.split("|")[1];
        const card = document.createElement("div");
        card.className = "card";
        card.style.cssText = "background:var(--gold-bg);border-color:var(--myth-bd)";
        card.innerHTML = `<b style="font-size:13.5px;color:var(--gold-tx)">⚠️ 충돌: <span class="nm"></span> — ${grp} ${arr.length}건 확정 (1인 1개)</b>
          <div class="meta" style="margin:4px 0 6px">유지할 아이템 1개를 선택하면 나머지는 반려되고 다음 대기자(기여점수순)가 자동 승격됩니다.</div>
          <div class="opts"></div>
          <div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn sm resolve">선택 항목만 유지</button></div>`;
        card.querySelector(".nm").textContent = arr[0].nick;
        const opts = card.querySelector(".opts");
        arr.forEach((r, i) => {
          const lb = document.createElement("label");
          lb.style.cssText = "display:flex;gap:6px;align-items:center;font-size:13px;margin:2px 0;cursor:pointer";
          lb.innerHTML = `<input type="radio" name="cf_${key.replace(/[^a-zA-Z0-9]/g, "_")}" value="${r.request_id}" ${i === 0 ? "checked" : ""}><span class="it"></span>`;
          lb.querySelector(".it").textContent = `${r.item_name} (${r.qty}개)`;
          opts.appendChild(lb);
        });
        card.querySelector(".resolve").addEventListener("click", () => {
          const keepId = Number(card.querySelector("input:checked").value);
          const declineTargets = arr.filter((r) => r.request_id !== keepId);
          openConfirm(
            "충돌 해결",
            `${arr[0].nick}님의 ${grp} 확정 중 1건만 유지하고 ${declineTargets.length}건을 반려할까요?\n반려된 아이템은 다음 대기자에게 자동 승격됩니다.`,
            async () => {
              try {
                const promoted = [];
                for (const t of declineTargets) {
                  const res = await Api.declineConflict(t.request_id);
                  if (res.promoted) promoted.push(`${t.item_name}→${res.promoted}`);
                }
                toast("resultToast", `✓ 충돌 해결 완료${promoted.length ? ` · 승격: ${promoted.join(", ")}` : ""}`);
                await loadResult();
              } catch (e) {
                toast("resultToast", e.message || "충돌 해결 실패", true);
              }
            },
            "해결",
          );
        });
        waitPane.appendChild(card);
      });

    // 확정 대기 목록 — 다이아/현금 입력 후 "나감 처리(승인)" = 즉시 최종확인
    // (이력 기록 + 재고 차감 + 장비/아퀴 갱신 + 공금 자동 입금 → 이력 탭으로 이동)
    const waitCard = document.createElement("div");
    waitCard.className = "card";
    waitCard.innerHTML = `<div class="row" style="justify-content:space-between">
        <b style="font-size:14.5px">📦 확정 대기 (${waitRows.length}건)</b>
        <button class="btn sm approveSel">선택 나감 처리 (승인)</button>
      </div>
      <div class="meta" style="margin:4px 0 6px">다이아/현금을 입력하고 승인하면 즉시 이력에 기록되고 재고 차감·공금 입금까지 처리됩니다. <b>다이아는 선택한 룻자(운영진) 계좌로</b>, 현금은 결사 금고로 들어갑니다. 되돌리려면 이력 탭에서 분배취소(관리자).</div>
      <div class="list wl" style="border:0"></div>`;
    const wl = waitCard.querySelector(".wl");
    if (!waitRows.length) {
      wl.innerHTML = `<div class="irow meta">확정 대기 건이 없습니다.</div>`;
    } else {
      waitRows.forEach((r) => {
        const row = document.createElement("div");
        row.className = "irow";
        row.style.flexWrap = "wrap";
        row.innerHTML = `
          <input type="checkbox" class="sel">
          <b class="inm"></b> ${gradeBadge(r.grade)}
          <b class="nm" style="width:100px"></b>
          <span class="meta" style="width:110px">기여 ${(r.score || 0).toLocaleString()}</span>
          <span class="meta" style="width:44px">${r.qty}개</span>
          <span class="row" style="gap:6px">
            💎<input type="number" class="dia" min="0" placeholder="다이아" style="width:90px;border:1px solid var(--line);border-radius:8px;padding:6px 8px">
            <select class="loot" title="다이아를 받을 룻자(운영진)" style="border:1px solid var(--line);border-radius:8px;padding:6px 8px;background:var(--card)"></select>
            💵<input type="number" class="cash" min="0" placeholder="현금(원)" style="width:110px;border:1px solid var(--line);border-radius:8px;padding:6px 8px">
          </span>
          <span style="margin-left:auto;display:flex;gap:6px">
            <button class="btn sm ghost del" style="color:#A32D2D">삭제</button>
          </span>`;
        row.querySelector(".inm").textContent = r.item_name;
        row.querySelector(".nm").textContent = r.nick;
        row._entry = r;

        // 룻자(운영진) 선택 — 아이템의 룻자 닉과 일치하는 운영진이 있으면 기본 선택
        const lootSel = row.querySelector(".loot");
        lootSel.innerHTML =
          `<option value="">룻자 선택</option>` +
          staffList.map((m) => `<option value="${m.user_id}">${m.current_id || m.user_id}</option>`).join("");
        const match = staffList.find((m) => (m.current_id || "") === (r.looter || ""));
        if (match) lootSel.value = match.user_id;
        row.querySelector(".del").addEventListener("click", () =>
          openConfirm("확정 삭제", `"${r.nick}"님의 [${r.item_name}] 확정을 삭제할까요? (신청 자체가 제거됩니다)`, async () => {
            try {
              await Api.revertConfirmed(r.request_id);
              toast("resultToast", "✓ 확정을 삭제했습니다.");
              await loadResult();
            } catch (e) {
              toast("resultToast", e.message || "삭제 실패", true);
            }
          }, "삭제"),
        );
        wl.appendChild(row);
      });
    }
    waitCard.querySelector(".approveSel").addEventListener("click", () => {
      const selRows = [...wl.querySelectorAll(".irow")].filter((row) => {
        const c = row.querySelector(".sel");
        return c && c.checked;
      });
      if (!selRows.length) {
        toast("resultToast", "승인할 항목을 선택하세요.", true);
        return;
      }
      const entries = selRows.map((row) => {
        const r = row._entry;
        const lootSel = row.querySelector(".loot");
        return {
          request_id: r.request_id,
          item_id: r.item_id,
          receiver_user_id: r.user_id,
          receiver_name: r.nick,
          diamond: parseInt(row.querySelector(".dia").value, 10) || 0,
          cash: parseInt(row.querySelector(".cash").value, 10) || 0,
          looter_user_id: lootSel.value || null,
          looter_name: lootSel.value ? lootSel.options[lootSel.selectedIndex].text : "",
          item_name: r.item_name,
        };
      });
      // 다이아는 룻자(운영진) 계좌로만 — 다이아 입력이 있는데 룻자 미선택이면 진행 불가
      const missingLoot = entries.filter((e2) => e2.diamond > 0 && !e2.looter_user_id);
      if (missingLoot.length) {
        toast("resultToast", `다이아를 받을 룻자(운영진)를 선택하세요: ${missingLoot.map((e2) => e2.item_name).join(", ")}`, true);
        return;
      }
      const summary = entries
        .map((e2) =>
          `· ${e2.receiver_name} — 💎${e2.diamond.toLocaleString()}${e2.diamond > 0 ? `(→${e2.looter_name})` : ""} / 💵${e2.cash.toLocaleString()}(→금고)`)
        .join("\n");
      openConfirm(
        "나감 처리 (승인)",
        `선택한 ${entries.length}건을 승인할까요?\n즉시 이력 기록·재고 차감·공금 입금이 실행됩니다.\n${summary}`,
        async () => {
          try {
            const res = await Api.finalizeDistributions(entries);
            const fails = (res.results || []).filter((x) => !x.ok);
            const warns = (res.results || []).filter((x) => x.ok && x.warn);
            if (fails.length) toast("resultToast", `일부 실패: ${fails.length}건 — 다시 시도하세요.`, true);
            else if (warns.length) toast("resultToast", `✓ 완료 (경고 ${warns.length}건: ${warns[0].warn})`, true);
            else toast("resultToast", `✓ ${entries.length}건 승인 완료 — 이력 탭에서 확인할 수 있습니다.`);
            await loadResult();
          } catch (e) {
            toast("resultToast", e.message || "승인 실패", true);
          }
        },
        "승인",
      );
    });
    waitPane.appendChild(waitCard);

  }

  // ═══════════════ 3) 분배 이력 ═══════════════

  async function loadHistory() {
    try {
      historyData = await Api.getDistHistory();
    } catch (e) {
      toast("historyToast", e.message || "이력 조회 실패", true);
      return;
    }
    // 필터 옵션 (데이터에서 동적 생성)
    const cats = [...new Set((historyData.rows || []).map((r) => r.category).filter(Boolean))];
    const grades = [...new Set((historyData.rows || []).map((r) => r.grade).filter(Boolean))];
    document.getElementById("hCatFilter").innerHTML =
      `<option value="">구분 전체</option>` + cats.map((c) => `<option>${c}</option>`).join("");
    document.getElementById("hGradeFilter").innerHTML =
      `<option value="">등급 전체</option>` + grades.map((g) => `<option>${g}</option>`).join("");
    renderHistory();
  }

  function renderHistory() {
    if (!historyData) return;
    const q = (document.getElementById("qh").value || "").trim();
    const cat = document.getElementById("hCatFilter").value;
    const grade = document.getElementById("hGradeFilter").value;
    const from = document.getElementById("hFrom").value;
    const to = document.getElementById("hTo").value;
    const admin = !!historyData.is_admin;

    const rows = (historyData.rows || []).filter((r) => {
      const qHit = !q || [r.item_name, r.looter, r.receiver].some((v) => (v || "").includes(q));
      const cHit = !cat || r.category === cat;
      const gHit = !grade || r.grade === grade;
      const d = String(r.distributed_at || "").slice(0, 10);
      const fHit = !from || d >= from;
      const tHit = !to || d <= to;
      return qHit && cHit && gHit && fHit && tHit;
    });

    document.getElementById("hCount").textContent = rows.length;
    document.getElementById("hDiaSum").textContent = rows.reduce((s, r) => s + (r.diamond_amount || 0), 0).toLocaleString();
    document.getElementById("hCashSum").textContent = rows.reduce((s, r) => s + (r.cash_amount || 0), 0).toLocaleString();

    const table = document.getElementById("historyTable");
    table.innerHTML = "";
    const hr = document.createElement("tr");
    hr.innerHTML =
      `<th>분배일시</th><th>구분</th><th>등급</th><th>아이템명</th><th class="num">수량</th>` +
      `<th>룻자</th><th>수령자</th><th class="num">💎다이아</th><th class="num">💵현금</th>` +
      (admin ? `<th>관리</th>` : "");
    table.appendChild(hr);

    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="${admin ? 10 : 9}" style="text-align:center;color:var(--txt3)">분배 이력이 없습니다.</td>`;
      table.appendChild(tr);
      return;
    }

    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="meta">${String(r.distributed_at || "").slice(0, 16)}</td>` +
        `<td class="ct"></td><td>${gradeBadge(r.grade)}</td><td class="it" style="font-weight:600"></td>` +
        `<td class="num">${r.quantity ?? 1}</td><td class="lt"></td><td class="rv"></td>` +
        `<td class="num">${(r.diamond_amount || 0).toLocaleString()}</td>` +
        `<td class="num">${(r.cash_amount || 0).toLocaleString()}</td>` +
        (admin ? `<td><span style="display:flex;gap:4px"><button class="btn sm ghost cancel">↩ 분배취소</button><button class="btn sm ghost del" style="color:#A32D2D">삭제</button></span></td>` : "");
      tr.querySelector(".ct").textContent = r.category || "-";
      tr.querySelector(".it").textContent = r.item_name;
      tr.querySelector(".lt").textContent = r.looter || "-";
      tr.querySelector(".rv").textContent = r.receiver || "-";
      if (admin) {
        tr.querySelector(".cancel").addEventListener("click", () =>
          openConfirm(
            "분배취소",
            `[${r.item_name}] → ${r.receiver} 분배를 취소할까요?\n재고 복원 + 확정 신청 복원 + 공금 역전(다이아 ${(r.diamond_amount || 0).toLocaleString()} / 현금 ${(r.cash_amount || 0).toLocaleString()})이 실행됩니다.`,
            async () => {
              try {
                await Api.cancelDistHistory(r.id);
                toast("historyToast", "✓ 분배를 취소하고 재고/공금을 복원했습니다.");
                await loadHistory();
              } catch (e) {
                toast("historyToast", e.message || "분배취소 실패", true);
              }
            },
            "분배취소",
          ),
        );
        tr.querySelector(".del").addEventListener("click", () =>
          openConfirm("이력 삭제", `[${r.item_name}] 이력을 삭제할까요?\n(복원 없이 기록만 지웁니다 — 되돌릴 수 없음)`, async () => {
            try {
              await Api.deleteDistHistory(r.id);
              toast("historyToast", "🗑️ 이력을 삭제했습니다.");
              await loadHistory();
            } catch (e) {
              toast("historyToast", e.message || "이력 삭제 실패", true);
            }
          }, "삭제"),
        );
      }
      table.appendChild(tr);
    });
  }

  function init() {
    initConfirmModal();
  }

  return { init, loadStatus, renderStatus, setStatusTab, loadResult, loadHistory, renderHistory };
})();
