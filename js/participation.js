// 참여율 관리 화면: 시즌 설정/마감 + 출석 로그 파싱·매칭·저장 + 참여 현황 + 입력 이력
const Participation = (() => {
  // 점수 활동 5종 — 쟁(구 긴급)은 점수·참여율과 분리된 별도 지표 (jaeng_* 컬럼)
  const ACTIVITIES = ["본토", "시틈", "유니", "결던", "별봉"];
  const ACTIVITY_COLS = { 본토: "bontu_score", 시틈: "siteum_score", 유니: "uni_score", 결던: "gyeoldun_score", 별봉: "byeolbong_score" };
  const isJaeng = (a) => a === "쟁" || a === "긴급"; // 긴급 = 레거시 표기 호환

  // 쟁 로그 시간대 분류 (표시용 — 저장 집계는 서버 RPC가 동일 규칙으로 수행)
  // 오전 09:00~17:00 / 오후 17:01~23:00 / 새벽 23:01~08:59
  function jaengSlot(logDatetime) {
    const h = parseInt(String(logDatetime).slice(11, 13), 10);
    const mi = parseInt(String(logDatetime).slice(14, 16), 10);
    if (Number.isNaN(h) || Number.isNaN(mi)) return null;
    const t = h * 100 + mi;
    if (t >= 900 && t <= 1700) return "오전";
    if (t >= 1701 && t <= 2300) return "오후";
    return "새벽";
  }

  let status = null; // GET view=status 응답
  let logs = [];
  let parsedSessions = []; // 분석 결과 (매칭 포함)
  let confirmAction = null; // 확인 모달에서 실행할 콜백

  function toast(msg, isErr) {
    const t = document.getElementById("partToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 5000);
  }

  async function load() {
    try {
      const [st, lg] = await Promise.all([Api.getParticipationStatus(), Api.getParticipationLogs()]);
      status = st;
      logs = lg;
    } catch (e) {
      toast(e.message || "참여율 정보 조회 실패", true);
      return;
    }
    renderSeason();
    renderStatusTable();
    renderLogs();
    loadGuildFilter(); // 결사 필터 칩 — 실패해도 나머지 화면 유지
    loadSeasonScores(); // 시즌별 기록은 별도 조회 — 실패해도 나머지 화면은 유지
  }

  // ── 시즌별 참여 기록 (season_participation 스냅샷 조회) ──
  // 필터: 시즌 복수 선택(점수·횟수 합산, 율은 단순 평균) + 결사 복수 선택 + 정렬(참여점수/전투력)
  const ss = {
    seasons: [], current: null,
    selected: new Set(),   // 선택된 시즌 (최소 1개)
    guilds: [], guildSel: new Set(),
    cache: new Map(),      // season → rows (마감 시즌은 불변 — 캐시 재사용)
    meta: null,            // user_id → {guild, power} (결사 필터·전투력 정렬용)
  };

  async function ssEnsureMeta() {
    if (ss.meta) return;
    const all = await Api.listMembers().catch(() => []);
    ss.meta = new Map(all.map((m) => [m.user_id, { guild: m.guild_name || "(미지정)", power: m.power || 0 }]));
  }

  async function ssFetch(season) {
    if (!ss.cache.has(season)) {
      const d = await Api.getSeasonScores(season);
      ss.cache.set(season, d.rows || []);
    }
    return ss.cache.get(season);
  }

  async function loadSeasonScores() {
    let data;
    try {
      data = await Api.getSeasonScores();
      await ssEnsureMeta();
    } catch (e) {
      document.getElementById("partSeasonNote").textContent =
        `시즌별 기록 조회 실패: ${e.message || ""} — participation 함수가 최신 버전인지 확인해주세요.`;
      return;
    }
    ss.seasons = (data.seasons || []).length ? data.seasons : [data.season];
    ss.current = data.current_season;
    ss.cache.set(data.season, data.rows || []); // 현재 시즌은 진입 때마다 최신으로 갱신
    if (!ss.selected.size) ss.selected.add(data.season);
    const gset = new Set([...ss.meta.values()].map((v) => v.guild));
    ss.guilds = [...gset].sort((a, b) => a.localeCompare(b, "ko"));
    if (!ss.guildSel.size) ss.guilds.forEach((g) => ss.guildSel.add(g));
    renderSeasonFilters();
    await renderSeasonScores();
  }

  function ssChip(label, on, onClick) {
    const c = document.createElement("span");
    c.className = "fchip" + (on ? " on" : "");
    c.textContent = label;
    c.style.cursor = "pointer";
    c.addEventListener("click", onClick);
    return c;
  }

  function renderSeasonFilters() {
    const sBox = document.getElementById("partSeasonChips");
    sBox.innerHTML = "";
    ss.seasons.forEach((s) => {
      sBox.appendChild(ssChip(`시즌 ${s}${s === ss.current ? "(현재)" : ""}`, ss.selected.has(s), async () => {
        if (ss.selected.has(s)) {
          if (ss.selected.size === 1) return; // 최소 1개 유지
          ss.selected.delete(s);
        } else ss.selected.add(s);
        renderSeasonFilters();
        await renderSeasonScores();
      }));
    });
    // 주의: 참여 현황 카드에 #partGuildChips가 이미 존재 — 시즌별 기록용은 별도 id 사용
    const gBox = document.getElementById("partSsGuildChips");
    gBox.innerHTML = "";
    ss.guilds.forEach((g) => {
      gBox.appendChild(ssChip(g, ss.guildSel.has(g), async () => {
        if (ss.guildSel.has(g)) ss.guildSel.delete(g);
        else ss.guildSel.add(g);
        renderSeasonFilters();
        await renderSeasonScores();
      }));
    });
  }

  async function renderSeasonScores() {
    const sortMode = document.getElementById("partSeasonSort").value || "score";
    const seasons = [...ss.selected].sort((a, b) => a - b);
    let perSeason;
    try {
      perSeason = await Promise.all(seasons.map((s) => ssFetch(s)));
    } catch (e) {
      document.getElementById("partSeasonNote").textContent = `시즌별 기록 조회 실패: ${e.message || ""}`;
      return;
    }
    // 시즌 병합: 점수·횟수는 합산, 참여율·쟁률은 시즌별 값의 단순 평균
    const SUM_COLS = ["bontu_score", "siteum_score", "uni_score", "gyeoldun_score", "byeolbong_score",
      "participation_score", "jaeng_count", "jaeng_morning", "jaeng_evening", "jaeng_dawn"];
    const merged = new Map();
    perSeason.forEach((rowsInSeason) => {
      rowsInSeason.forEach((r) => {
        let m = merged.get(r.user_id);
        if (!m) {
          m = { user_id: r.user_id, current_id: r.current_id, class: r.class, rates: [], jrates: [] };
          SUM_COLS.forEach((k) => (m[k] = 0));
          merged.set(r.user_id, m);
        }
        SUM_COLS.forEach((k) => (m[k] += r[k] || 0));
        if (r.participation_rate != null) m.rates.push(r.participation_rate);
        if (r.jaeng_rate != null) m.jrates.push(r.jaeng_rate);
      });
    });
    const meta = ss.meta || new Map();
    let rows = [...merged.values()].map((m) => ({
      ...m,
      guild: meta.get(m.user_id) ? meta.get(m.user_id).guild : "(미지정)",
      power: meta.get(m.user_id) ? meta.get(m.user_id).power : 0,
      participation_rate: m.rates.length ? m.rates.reduce((s, v) => s + v, 0) / m.rates.length : null,
      jaeng_rate: m.jrates.length ? m.jrates.reduce((s, v) => s + v, 0) / m.jrates.length : null,
    }));
    rows = rows.filter((r) => ss.guildSel.has(r.guild));
    const q = (document.getElementById("partSsSearch").value || "").trim().toLowerCase();
    if (q) rows = rows.filter((r) => (r.current_id || r.user_id || "").toLowerCase().includes(q));
    rows.sort((a, b) => {
      if (sortMode === "power") return (b.power || 0) - (a.power || 0);
      if (sortMode === "jaeng") return (b.jaeng_rate ?? -1) - (a.jaeng_rate ?? -1); // 쟁률 없음(—)은 맨 뒤
      return (b.participation_score || 0) - (a.participation_score || 0);
    });

    document.getElementById("partSeasonNote").textContent = seasons.length > 1
      ? `시즌 ${seasons.join("+")} 합산 기록입니다 — 점수·횟수는 합계, 참여율·쟁률은 시즌별 값의 단순 평균.`
      : (seasons[0] === ss.current
          ? "현재 진행 중인 시즌의 스냅샷입니다 (로그 저장·삭제 시 갱신)."
          : `시즌 ${seasons[0]} 마감 시점의 확정 기록입니다.`);

    document.getElementById("partSeasonEmpty").style.display = rows.length ? "none" : "block";
    const table = document.getElementById("partSeasonTable");
    let html = `<tr><th>닉네임</th><th>결사</th><th>직업</th><th class="num">전투력</th>${ACTIVITIES.map((a) => `<th class="num">${a}</th>`).join("")}<th class="num">쟁</th><th class="num">쟁률</th><th class="num">참여점수</th><th class="num">참여율</th></tr>`;
    html += rows
      .map((r) => {
        const rateV = r.participation_rate != null ? Math.round(r.participation_rate) : null;
        const rate = rateV != null ? `${rateV}%` : "—";
        const rateHtml = rateV != null && rateV < 50 ? `<span class="low">${rate}</span>` : rate;
        const jaengTitle = `오전 ${r.jaeng_morning || 0} · 오후 ${r.jaeng_evening || 0} · 새벽 ${r.jaeng_dawn || 0}`;
        return `<tr>
          <td><b class="nm"></b></td>
          <td class="gtext gld"></td>
          <td class="gtext cls"></td>
          <td class="num gtext">${(r.power || 0).toLocaleString()}</td>
          ${ACTIVITIES.map((a) => `<td class="num gtext">${r[ACTIVITY_COLS[a]] || 0}</td>`).join("")}
          <td class="num" title="${jaengTitle}"><b>${r.jaeng_count || 0}</b></td>
          <td class="num gtext" title="${jaengTitle}">${r.jaeng_rate != null ? `${Math.round(r.jaeng_rate)}%` : "—"}</td>
          <td class="num"><b>${(r.participation_score || 0).toLocaleString()}</b></td>
          <td class="num">${rateHtml}</td>
        </tr>`;
      })
      .join("");
    table.innerHTML = html;
    const trs = table.querySelectorAll("tr");
    rows.forEach((r, i) => {
      trs[i + 1].querySelector(".nm").textContent = r.current_id || r.user_id;
      trs[i + 1].querySelector(".gld").textContent = r.guild;
      trs[i + 1].querySelector(".cls").textContent = r.class || "-";
    });
  }

  function renderSeason() {
    document.getElementById("partSeasonLabel").textContent =
      `시즌 ${status.season} ${status.closed ? "🔒 (마감됨)" : "🟢 (진행중)"}`;
    document.getElementById("partSeasonInfo").textContent =
      `이번 시즌 세션 ${status.total_sessions}회 · 쟁 ${status.total_jaeng || 0}회 입력됨 · 1회 참여 = 100점 (쟁 제외) · 참여율 = 참석 세션/전체 세션(쟁 제외)`;
    document.getElementById("partSeasonInput").value = status.season;
    document.getElementById("partResetBtn").classList.toggle("hidden", (Auth.getUser() || {}).role !== "관리자");
  }

  // ── 매칭 사전: 닉네임 이력 → current_id → user_id (원본 우선순위, 먼저 등록된 값 우선) ──
  function buildMatchMap() {
    const map = new Map();
    for (const nh of status.nick_history || []) {
      const k = (nh.nickname || "").trim();
      if (k && !map.has(k)) map.set(k, nh.user_id);
    }
    for (const m of status.members || []) {
      const k = (m.current_id || "").trim();
      if (k && !map.has(k)) map.set(k, m.user_id);
    }
    for (const m of status.members || []) {
      const k = (m.user_id || "").trim();
      if (k && !map.has(k)) map.set(k, m.user_id);
    }
    return map;
  }

  // ── 출석 입력 ──
  function initAttendance() {
    document.getElementById("partParseBtn").addEventListener("click", () => {
      const text = document.getElementById("partLogText").value;
      if (!text.trim()) {
        toast("텍스트를 붙여넣어주세요.", true);
        return;
      }
      if (!status) {
        toast("시즌 정보를 아직 불러오지 못했습니다.", true);
        return;
      }
      const map = buildMatchMap();
      const existing = new Set(logs.map((l) => `${l.activity_type}|${String(l.log_datetime).replace("T", " ").slice(0, 19)}`));

      parsedSessions = ParticipationParser.parse(text).map((s) => {
        if (!s.ok) return s;
        const members = s.members.map((mm) => {
          const uid = map.get(mm.member_name.trim()) || null;
          return { ...mm, user_id: uid, matched: !!uid };
        });
        const dup = existing.has(`${s.activity_type}|${s.log_datetime}`);
        return { ...s, members, duplicate: dup };
      });
      renderPreview();
    });

    document.getElementById("partSaveBtn").addEventListener("click", async () => {
      const toSave = parsedSessions.filter((s) => s.ok && !s.duplicate);
      if (!toSave.length) {
        toast("저장할 세션이 없습니다.", true);
        return;
      }
      const btn = document.getElementById("partSaveBtn");
      btn.disabled = true;
      try {
        const res = await Api.saveParticipationLogs(
          toSave.map((s) => ({
            activity_type: s.activity_type,
            log_datetime: s.log_datetime,
            log_date: s.log_date,
            location: s.location,
            total_participants: s.total_participants || 0,
            commander: s.commander || "",
            members: s.members,
          })),
        );
        let msg = `✅ ${res.inserted}건 저장, 점수 재계산 완료 (시즌 총 ${res.total_sessions}세션)`;
        if (res.skipped_duplicates) msg += ` · 중복 ${res.skipped_duplicates}건 스킵`;
        if (res.errors && res.errors.length) msg += ` · 실패 ${res.errors.length}건`;
        toast(msg, !!(res.errors && res.errors.length));
        document.getElementById("partLogText").value = "";
        parsedSessions = [];
        renderPreview();
        await load();
      } catch (err) {
        toast(err.message || "저장 실패", true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function renderPreview() {
    const el = document.getElementById("partPreview");
    el.innerHTML = "";
    const saveBtn = document.getElementById("partSaveBtn");

    if (!parsedSessions.length) {
      saveBtn.classList.add("hidden");
      return;
    }

    let savable = 0;
    parsedSessions.forEach((s) => {
      const box = document.createElement("div");
      box.style.cssText = "border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px";
      if (!s.ok) {
        box.style.borderColor = "#F3B9B9";
        box.style.background = "var(--red-bg)";
        box.innerHTML = `<b style="color:var(--red-tx)">⚠️ 파싱 실패</b><div class="meta err-detail" style="margin-top:4px"></div>`;
        box.querySelector(".err-detail").textContent = s.error;
        el.appendChild(box);
        return;
      }
      const matched = s.members.filter((m) => m.matched);
      const unmatched = s.members.filter((m) => !m.matched);
      if (s.duplicate) {
        box.style.opacity = ".6";
      } else {
        savable++;
      }
      const slot = isJaeng(s.activity_type) ? jaengSlot(s.log_datetime) : null;
      box.innerHTML = `
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <span class="badge b-green">!${s.activity_type}</span>
          ${slot ? `<span class="badge b-legend">⚔️ ${slot}</span>` : ""}
          <b class="dtv"></b>
          <span class="meta locv"></span>
          <span class="meta">참여 ${s.members.length}명 (매칭 ${matched.length} / 미매칭 ${unmatched.length})</span>
          ${s.duplicate ? `<span class="badge b-gray">이미 입력된 로그 — 저장 시 제외</span>` : ""}
        </div>
        ${unmatched.length ? `<div class="meta unm" style="color:#B8860B;margin-top:4px"></div>` : ""}`;
      box.querySelector(".dtv").textContent = s.log_datetime;
      box.querySelector(".locv").textContent = s.location || "-";
      if (unmatched.length) {
        box.querySelector(".unm").textContent = `⚠️ 미매칭(점수 미반영): ${unmatched.map((m) => m.member_name).join(", ")}`;
      }
      el.appendChild(box);
    });

    saveBtn.classList.toggle("hidden", savable === 0);
    saveBtn.textContent = `💾 ${savable}개 세션 저장`;
  }

  // ── 결사 필터 (합병 준비 — guilds 목록 + 회원 결사 매핑은 클라이언트 조인) ──
  let guildByUid = new Map();
  let guildNames = [];
  let activeGuildFilter = "전체";

  async function loadGuildFilter() {
    try {
      const [guilds, mems] = await Promise.all([Api.getGuilds(), Api.listMembers()]);
      guildNames = (guilds || []).map((g) => g.name);
      guildByUid = new Map((mems || []).map((m) => [m.user_id, m.guild_name || ""]));
    } catch (e) {
      guildNames = [];
      guildByUid = new Map();
    }
    renderGuildChips();
  }

  function renderGuildChips() {
    const wrap = document.getElementById("partGuildChips");
    if (!guildNames.length) {
      wrap.style.display = "none";
      return;
    }
    wrap.style.display = "flex";
    wrap.innerHTML = "";
    const names = ["전체", ...guildNames];
    if (!names.includes(activeGuildFilter)) activeGuildFilter = "전체";
    names.forEach((n) => {
      const chip = document.createElement("span");
      chip.className = "fchip" + (activeGuildFilter === n ? " on" : "");
      const cnt = n === "전체"
        ? (status && status.members ? status.members.length : 0)
        : (status && status.members ? status.members.filter((m) => guildByUid.get(m.user_id) === n).length : 0);
      chip.textContent = n;
      const c = document.createElement("span");
      c.className = "cnt";
      c.textContent = cnt;
      chip.appendChild(c);
      chip.addEventListener("click", () => {
        activeGuildFilter = n;
        renderGuildChips();
        renderStatusTable();
      });
      wrap.appendChild(chip);
    });
  }

  // ── 참여 현황 표 ──
  function renderStatusTable() {
    const q = (document.getElementById("qp").value || "").trim();
    const rows = (status.members || [])
      .filter((m) => !q || (m.current_id || "").includes(q))
      .filter((m) => activeGuildFilter === "전체" || guildByUid.get(m.user_id) === activeGuildFilter)
      .slice()
      .sort((a, b) => (b.participation_score || 0) - (a.participation_score || 0));

    const table = document.getElementById("partStatusTable");
    let html = `<tr><th>닉네임</th>${ACTIVITIES.map((a) => `<th class="num">${a}</th>`).join("")}<th class="num">쟁</th><th class="num">쟁률</th><th class="num">참여점수</th><th class="num">참여율</th><th class="num">기여점수</th></tr>`;
    html += rows
      .map((m) => {
        const rate = m.participation_rate != null ? `${m.participation_rate}%` : "—";
        const rateHtml = m.participation_rate != null && m.participation_rate < 50 ? `<span class="low">${rate}</span>` : rate;
        const jaengTitle = `오전 ${m.jaeng_morning || 0} · 오후 ${m.jaeng_evening || 0} · 새벽 ${m.jaeng_dawn || 0}`;
        return `<tr>
          <td><b class="nm"></b></td>
          ${ACTIVITIES.map((a) => `<td class="num gtext">${m[ACTIVITY_COLS[a]] || 0}</td>`).join("")}
          <td class="num" title="${jaengTitle}"><b>${m.jaeng_count || 0}</b></td>
          <td class="num gtext" title="${jaengTitle}">${m.jaeng_rate != null ? `${m.jaeng_rate}%` : "—"}</td>
          <td class="num"><b>${(m.participation_score || 0).toLocaleString()}</b></td>
          <td class="num">${rateHtml}</td>
          <td class="num">${(m.contribution_score || 0).toLocaleString()}</td>
        </tr>`;
      })
      .join("");
    table.innerHTML = html;
    const trs = table.querySelectorAll("tr");
    rows.forEach((m, i) => (trs[i + 1].querySelector(".nm").textContent = m.current_id || m.user_id));
  }

  // ── 입력 이력 ──
  function renderLogs() {
    const listEl = document.getElementById("partLogList");
    document.querySelectorAll("#partLogList .irow[data-id]").forEach((el) => el.remove());
    document.getElementById("partLogEmpty").style.display = logs.length ? "none" : "flex";

    logs.forEach((l) => {
      const row = document.createElement("div");
      row.className = "irow";
      row.dataset.id = l.id;
      const lslot = isJaeng(l.activity_type) ? jaengSlot(String(l.log_datetime).replace("T", " ")) : null;
      row.innerHTML = `
        <span class="badge b-green">!${l.activity_type}</span>
        ${lslot ? `<span class="badge b-legend">⚔️ ${lslot}</span>` : ""}
        <b class="dt" style="font-size:13px"></b>
        <span class="meta loc"></span>
        <span class="meta">매칭 ${l.matched_count}명${l.unmatched_count ? ` · 미매칭 ${l.unmatched_count}` : ""}</span>
        <button type="button" class="btn sm ghost" data-act="del" style="margin-left:auto;color:#A32D2D">삭제</button>`;
      row.querySelector(".dt").textContent = String(l.log_datetime).replace("T", " ").slice(0, 16);
      row.querySelector(".loc").textContent = l.location || "-";
      row.querySelector('[data-act="del"]').addEventListener("click", () => {
        openConfirm("로그 삭제", `[!${l.activity_type}] ${String(l.log_datetime).replace("T", " ").slice(0, 16)} 로그를 삭제할까요? 삭제 후 점수가 자동 재계산됩니다.`, async () => {
          await Api.deleteParticipationLog(l.id);
          toast("🗑️ 삭제 및 재계산 완료");
          await load();
        });
      });
      listEl.appendChild(row);
    });
  }

  // ── 시즌 설정 ──
  function initSeasonActions() {
    document.getElementById("partSetSeasonBtn").addEventListener("click", async () => {
      const season = parseInt(document.getElementById("partSeasonInput").value, 10);
      if (!season || season < 1) {
        toast("시즌 번호를 확인해주세요.", true);
        return;
      }
      try {
        await Api.participationSeasonOp("set_season", { season });
        toast(`✓ 현재 시즌이 ${season}으로 설정되었습니다.`);
        await load();
      } catch (err) {
        toast(err.message || "시즌 설정 실패", true);
      }
    });

    document.getElementById("partCloseSeasonBtn").addEventListener("click", () => {
      openConfirm("시즌 마감", `시즌 ${status ? status.season : "?"}을(를) 마감할까요? 최종 재계산 후 마감 플래그가 저장됩니다.`, async () => {
        const res = await Api.participationSeasonOp("close_season");
        toast(`🔒 시즌 ${res.season} 마감 완료`);
        await load();
      });
    });

    document.getElementById("partResetBtn").addEventListener("click", () => {
      openConfirm("참여점수 초기화", "전체 회원의 활동/참여/기여 점수를 모두 0으로 초기화합니다. 되돌릴 수 없습니다. 진행할까요?", async () => {
        await Api.participationSeasonOp("reset_scores");
        toast("참여점수가 초기화되었습니다.");
        await load();
      });
    });
  }

  // ── 공용 확인 모달 ──
  function openConfirm(title, msg, action) {
    confirmAction = action;
    document.getElementById("partConfirmTitle").textContent = title;
    document.getElementById("partConfirmMsg").textContent = msg;
    document.getElementById("partConfirmBackdrop").classList.add("on");
  }

  function initConfirmModal() {
    document.getElementById("partConfirmCancelBtn").addEventListener("click", () => {
      confirmAction = null;
      document.getElementById("partConfirmBackdrop").classList.remove("on");
    });
    document.getElementById("partConfirmYesBtn").addEventListener("click", async () => {
      const action = confirmAction;
      confirmAction = null;
      document.getElementById("partConfirmBackdrop").classList.remove("on");
      if (!action) return;
      try {
        await action();
      } catch (err) {
        toast(err.message || "처리 실패", true);
      }
    });
  }

  function filter() {
    renderStatusTable();
  }

  function init() {
    initAttendance();
    initSeasonActions();
    initConfirmModal();
    document.getElementById("qp").addEventListener("input", filter);
  }

  return { init, load, filter, loadSeasonScores, renderSeasonScores };
})();
