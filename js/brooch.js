// 브로치 분배 체크 — 분배 하위탭. 전 회원이 기여점수순 명단(순번·전투력·쟁참여율·기여점수)을
// 조회하고, 브로치를 분배받은 결사원 체크는 운영진만 편집·저장한다 (app_settings JSON 통째 교체).
const Brooch = (() => {
  let data = null; // {members, checked, updated_at, updated_by, is_staff, me}
  let checkedSet = new Set();

  function toast(msg, isErr) {
    const t = document.getElementById("broochToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 4000);
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

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // 탭 진입 시 항상 재조회 — 운영진이 저장한 체크를 결사원이 바로 보도록 (조회가 가벼워 캐시 불필요)
  async function open() {
    await load();
  }

  async function load() {
    const table = document.getElementById("broochTable");
    table.innerHTML = '<tr><td style="padding:20px;color:var(--txt3)"><span class="spinner"></span>불러오는 중...</td></tr>';
    try {
      data = await Api.getBroochBoard();
    } catch (e) {
      data = null;
      table.innerHTML = `<tr><td style="padding:20px;color:#A32D2D">명단을 불러오지 못했습니다. (${esc(e.message || "오류")})</td></tr>`;
      return;
    }
    // 구버전 함수(브로치 미지원)가 응답하면 members 필드가 없다 — 재배포 안내
    if (!Array.isArray(data.members)) {
      data = null;
      table.innerHTML = '<tr><td style="padding:20px;color:#A32D2D">서버(distribution 함수)가 아직 브로치 조회를 지원하지 않습니다. 함수 재배포 후 새로고침해 주세요.</td></tr>';
      return;
    }
    checkedSet = new Set(data.checked || []);
    render();
  }

  function render() {
    if (!data) return;
    const staff = !!data.is_staff;
    const mems = data.members || [];
    const doneCnt = mems.filter((m) => checkedSet.has(m.user_id)).length;

    // 상단 메타: 분배 완료 수 + 마지막 저장 정보
    const metaEl = document.getElementById("broochMeta");
    const savedInfo = data.updated_at ? ` · 마지막 저장 ${fmtWhen(data.updated_at)}${data.updated_by ? " (" + esc(data.updated_by) + ")" : ""}` : "";
    metaEl.innerHTML = `분배 완료 <b>${doneCnt}</b> / ${mems.length}명${savedInfo}`;

    document.getElementById("broochNote").textContent = staff
      ? "기여점수 순 명단입니다. 브로치를 분배한 결사원을 체크하고 저장을 누르세요."
      : "기여점수 순 명단입니다. ✔ 표시는 브로치 분배를 받은 결사원입니다. (체크는 운영진이 관리)";
    document.getElementById("broochStaffBar").classList.toggle("hidden", !staff);

    const rows = mems
      .map((m, i) => {
        const on = checkedSet.has(m.user_id);
        const me = m.user_id === data.me;
        const cell = staff
          ? `<input type="checkbox" data-uid="${esc(m.user_id)}" ${on ? "checked" : ""} onchange="Brooch.toggle(this)">`
          : on
            ? '<span style="color:var(--green-dk);font-weight:700">✔</span>'
            : "";
        return `<tr class="${on ? "br-done" : ""}${me ? " br-me" : ""}">
          <td class="num" style="color:var(--txt3)">${i + 1}</td>
          <td><b>${esc(m.nick)}</b>${me ? ' <span class="br-mebadge">나</span>' : ""}<small style="color:var(--txt3);margin-left:6px">${esc(m.guild)}</small></td>
          <td class="num">${m.power.toLocaleString()}</td>
          <td class="num">${Math.round(m.jaeng_rate)}%</td>
          <td class="num"><b>${m.contribution_score.toLocaleString()}</b></td>
          <td style="text-align:center">${cell}</td>
        </tr>`;
      })
      .join("");
    document.getElementById("broochTable").innerHTML = `
      <thead><tr>
        <th style="width:44px">순번</th><th>닉네임</th>
        <th class="num">전투력</th><th class="num">쟁참여율</th><th class="num">기여점수</th>
        <th style="width:56px;text-align:center">브로치</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="6" style="padding:20px;color:var(--txt3)">결사원이 없습니다.</td></tr>'}</tbody>`;
  }

  // 체크 토글 (운영진) — 저장 전까지는 로컬 상태만 변경
  function toggle(el) {
    const uid = el.dataset.uid;
    if (el.checked) checkedSet.add(uid);
    else checkedSet.delete(uid);
    el.closest("tr").classList.toggle("br-done", el.checked);
    const doneCnt = (data.members || []).filter((m) => checkedSet.has(m.user_id)).length;
    const metaEl = document.getElementById("broochMeta");
    metaEl.innerHTML = metaEl.innerHTML.replace(/분배 완료 <b>\d+<\/b>/, `분배 완료 <b>${doneCnt}</b>`);
  }

  async function save() {
    const btn = document.getElementById("broochSaveBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>저장 중...';
    try {
      await Api.saveBroochChecks([...checkedSet]);
      data = null; // 서버 저장본(updated_at 포함) 기준으로 재조회
      await load();
      toast("브로치 분배 체크를 저장했습니다.");
    } catch (e) {
      toast(e.message || "저장에 실패했습니다.", true);
    } finally {
      btn.disabled = false;
      btn.textContent = "체크 저장";
    }
  }

  function init() {
    document.getElementById("broochSaveBtn").addEventListener("click", save);
  }

  return { init, open, toggle };
})();
