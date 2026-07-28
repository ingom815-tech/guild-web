// 스샷 업로드 전처리 유틸.
// 원본 save_uploaded_file(app.py:482-523)의 규칙을 브라우저 canvas로 재현:
// 최대 1280px 비율 유지 리사이즈 + JPEG quality 0.82 재인코딩.
// 저장은 Supabase Storage(URL)로 하되, 기존 DB의 base64(data:) 값도 그대로 표시 가능해야
// 하므로 parseImgUrls는 원본 parse_img_urls와 동일하게 JSON 배열/단일 문자열 모두 처리한다.
const ImageUtil = (() => {
  const MAX_PX = 1280;
  const JPEG_QUALITY = 0.82;
  const MAX_BYTES = 1.5 * 1024 * 1024; // 전처리 후 파일당 상한

  function loadImageFrom(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("decode failed"));
      img.src = src;
    });
  }

  function fileToDataUrlRaw(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error(`이미지를 읽을 수 없습니다: ${file.name}`));
      fr.readAsDataURL(file);
    });
  }

  // File → 리사이즈된 JPEG base64 data URL
  // 1차: objectURL 로드 (빠름). 실패 시 2차: FileReader dataURL로 재시도 —
  // 카카오톡 등 인앱 웹뷰가 objectURL 이미지 로드를 실패시키는 사례가 실제 진단 로그로 확인됨.
  async function fileToResizedDataUrl(file) {
    let img = null;
    const url = URL.createObjectURL(file);
    try {
      img = await loadImageFrom(url);
    } catch (_) {
      img = null; // 아래 FileReader 폴백으로
    } finally {
      URL.revokeObjectURL(url);
    }
    if (!img) {
      const raw = await fileToDataUrlRaw(file);
      try {
        img = await loadImageFrom(raw);
      } catch (_) {
        throw new Error(`이미지를 읽을 수 없습니다: ${file.name}`);
      }
    }

    let { width, height } = img;
    if (Math.max(width, height) > MAX_PX) {
      const scale = MAX_PX / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    // 투명 배경은 흰색으로 합성 (원본 RGBA→RGB 처리와 동일)
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    // base64 크기 검사 (대략 3/4이 실제 바이트)
    const bytes = Math.ceil((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
    if (bytes > MAX_BYTES) {
      throw new Error(`이미지가 너무 큽니다 (${(bytes / 1024 / 1024).toFixed(1)}MB > 1.5MB): ${file.name}`);
    }
    return dataUrl;
  }

  // FileList → base64 배열 (순차 처리)
  async function filesToDataUrls(fileList, maxCount) {
    const files = [...fileList].slice(0, maxCount || 10);
    const out = [];
    for (const f of files) out.push(await fileToResizedDataUrl(f));
    return out;
  }

  // 원본 parse_img_urls와 동일: JSON 배열 문자열 or 단일 문자열 → 배열
  function parseImgUrls(raw) {
    if (!raw) return [];
    const s = String(raw).trim();
    if (s.startsWith("[")) {
      try {
        const arr = JSON.parse(s);
        return Array.isArray(arr) ? arr.filter(Boolean) : [];
      } catch (_) {
        return [];
      }
    }
    return [s];
  }

  return { fileToResizedDataUrl, filesToDataUrls, parseImgUrls };
})();
