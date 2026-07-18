// 원본 participation_parser.py(게임 출석 로그 파서)를 규칙 그대로 이식한 모듈.
// parse(text) → 세션 배열 [{ok, error, activity_type, log_datetime, log_date, location,
//                          total_participants, commander, members:[{squad_no, member_name}]}]
// 날짜는 DB 저장용 문자열로 반환: log_datetime "YYYY-MM-DD HH:MM:SS", log_date "YYYY-MM-DD".
const ParticipationParser = (() => {
  const ACTIVITY_COMMANDS = {
    "!본토": "본토",
    "!시틈": "시틈",
    "!유니": "유니",
    "!결던": "결던",
    "!별봉": "별봉",
    "!긴급": "긴급",
  };

  // 게임 로그 날짜/시간: 2026.03.23-17.57.33
  const LOG_DATETIME_RE = /(\d{4}\.\d{2}\.\d{2})-(\d{2}\.\d{2}\.\d{2})/;
  const TOTAL_RE = /총\s*참여\s*인원[\t ]+(\d+)/;
  const COMMANDER_RE = /결사\s*부대장[\t ]+(\S+)/;
  // 분대 멤버 라인: "1\t홍길동" 또는 "1   홍길동" (탭/공백만 — \s는 \n 포함이라 제외)
  const MEMBER_LINE_RE = /^(\d+)[\t ]+(\S+)[\t ]*$/;
  const TAG_RE = /!(본토|시틈|유니|결던|별봉|긴급)/g;
  // 카카오톡 메시지 라인: "2026년 3월 23일 오후 5:57, 닉네임 : 내용"
  const KAKAO_MSG_RE = /^(\d{4}년\s*\d{1,2}월\s*\d{1,2}일\s+(?:오전|오후)\s+\d{1,2}:\d{2}),\s*.+?\s*:\s*(.+)$/;
  const BLOCK_START_RE = /저장\s*시간[\t ]+장소[\t ]+총\s*참여\s*인원/;
  // 결던/유니: 두 부대 합산 → !태그 하나 = 세션 하나. 나머지: 저장 시간 헤더별 개별 세션.
  const MERGE_TAG_NAMES = new Set(["결던", "유니"]);

  function parseLogDatetime(text) {
    const m = text.match(LOG_DATETIME_RE);
    if (!m) return { dt: null, date: null, display: null };
    const date = m[1].replace(/\./g, "-"); // 2026-03-23
    const time = m[2].replace(/\./g, ":"); // 17:57:33
    return { dt: `${date} ${time}`, date, display: `${m[1].slice(5)} ${time.slice(0, 5)}` };
  }

  function parseMembers(text) {
    const members = [];
    const seen = new Set();
    for (const line of text.split("\n")) {
      const m = line.match(MEMBER_LINE_RE);
      if (!m) continue;
      const name = m[2].trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      members.push({ squad_no: parseInt(m[1], 10), member_name: name });
    }
    return members;
  }

  function detectActivity(text) {
    for (const [cmd, activity] of Object.entries(ACTIVITY_COMMANDS)) {
      if (text.includes(cmd)) return activity;
    }
    return null;
  }

  function extractMeta(text) {
    let location = "";
    let total = 0;
    let commander = "";

    for (const line of text.split("\n")) {
      if (LOG_DATETIME_RE.test(line)) {
        const parts = line.includes("\t")
          ? line.split("\t").map((p) => p.trim())
          : line.split(/[ ]{2,}/).map((p) => p.trim());
        if (parts.length >= 4) {
          location = parts[1];
          const t = parseInt(parts[2], 10);
          if (!Number.isNaN(t)) total = t;
          commander = parts[3];
        } else if (parts.length === 3) {
          location = parts[1];
          const t = parseInt(parts[2], 10);
          if (!Number.isNaN(t)) total = t;
        }
        break;
      }
    }

    if (!total) {
      const m = text.match(TOTAL_RE);
      if (m) {
        const t = parseInt(m[1], 10);
        if (!Number.isNaN(t)) total = t;
      }
    }
    if (!commander) {
      const m = text.match(COMMANDER_RE);
      if (m) commander = m[1];
    }
    return { location, total, commander };
  }

  function parseSingleBlock(text) {
    text = text.trim();
    if (!text) {
      return { ok: false, error: "텍스트가 비어있습니다.", location: "", log_datetime: null, log_date: null, members: [] };
    }

    const activity = detectActivity(text);
    const { dt, date, display } = parseLogDatetime(text);
    const { location, total, commander } = extractMeta(text);

    if (!dt) {
      return {
        ok: false,
        error: "날짜/시간을 찾을 수 없습니다. (예: 2026.03.23-17.57.33)",
        location, log_datetime: null, log_date: null, members: [],
      };
    }

    const members = parseMembers(text);

    if (!activity) {
      return {
        ok: false,
        error: `활동 태그 없음 — !본토 / !시틈 / !유니 / !결던 / !별봉 / !긴급 중 하나를 메시지 끝에 추가하세요. (장소: ${location || "?"}, 시각: ${display || "?"})`,
        location, log_datetime: dt, log_date: date, total_participants: total, commander, members,
      };
    }

    if (!members.length) {
      return {
        ok: false,
        error: `참여자 목록을 파싱하지 못했습니다. 분대번호 + 이름 형식을 확인하세요. (장소: ${location || "?"})`,
        location, log_datetime: dt, log_date: date, members: [],
      };
    }

    return {
      ok: true, error: null,
      activity_type: activity, log_datetime: dt, log_date: date,
      location, total_participants: total, commander, members,
    };
  }

  // ── 카카오톡 로그 ──
  function splitKakaoMessages(fileText) {
    const messages = [];
    let current = [];
    let inMessage = false;
    for (const line of fileText.split("\n")) {
      const m = line.match(KAKAO_MSG_RE);
      if (m) {
        if (inMessage && current.length) messages.push(current.join("\n"));
        current = [m[2]];
        inMessage = true;
      } else if (inMessage) {
        // 빈 줄, 날짜 구분선("2026년 4월 8일") 스킵
        if (line.trim() && !/^\d{4}년\s*\d{1,2}월\s*\d{1,2}일$/.test(line.trim())) {
          current.push(line);
        }
      }
    }
    if (inMessage && current.length) messages.push(current.join("\n"));
    return messages;
  }

  function parseKakaoLog(fileText) {
    const messages = splitKakaoMessages(fileText);
    const results = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!BLOCK_START_RE.test(msg)) continue;
      let combined = msg;
      let activity = detectActivity(combined);
      let lookahead = 1;
      // 태그가 없으면 직후 메시지에서 탐색(최대 3개) — 단 다음 메시지가 새 로그 블록이면 중단
      while (!activity && lookahead <= 3 && i + lookahead < messages.length) {
        const next = messages[i + lookahead];
        if (BLOCK_START_RE.test(next)) break;
        combined = combined + "\n" + next;
        activity = detectActivity(combined);
        lookahead++;
      }
      results.push(parseSingleBlock(combined));
    }
    return results;
  }

  function parse(text) {
    // 카카오톡 래핑 감지 시 위임 (원본 parse_text_blocks와 동일)
    if (text.split("\n").some((l) => KAKAO_MSG_RE.test(l))) {
      return parseKakaoLog(text);
    }

    const tagMatches = [...text.matchAll(TAG_RE)];
    if (!tagMatches.length) return [parseSingleBlock(text)];

    const results = [];
    let prevEnd = 0;
    for (const match of tagMatches) {
      const sectionBody = text.slice(prevEnd, match.index).trim();
      const tagStr = match[0]; // "!결던"
      const tagName = match[1]; // "결던"
      prevEnd = match.index + match[0].length;

      if (!sectionBody) continue;

      if (MERGE_TAG_NAMES.has(tagName)) {
        // 결던/유니: 구간 전체를 하나의 블록으로 (저장시간 여러 개 = 두 부대 합산)
        results.push(parseSingleBlock(sectionBody + "\n" + tagStr));
      } else {
        const splits = [...sectionBody.matchAll(new RegExp(BLOCK_START_RE.source, "g"))];
        if (!splits.length) {
          results.push(parseSingleBlock(sectionBody + "\n" + tagStr));
        } else {
          for (let idx = 0; idx < splits.length; idx++) {
            const start = splits[idx].index;
            const end = idx + 1 < splits.length ? splits[idx + 1].index : sectionBody.length;
            const block = sectionBody.slice(start, end).trim();
            results.push(parseSingleBlock(block + "\n" + tagStr));
          }
        }
      }
    }
    return results;
  }

  return { parse, parseSingleBlock, ACTIVITY_COMMANDS };
})();
