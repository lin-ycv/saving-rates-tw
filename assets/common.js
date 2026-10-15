
let reportPromise;

export async function loadReport() {
  if (!reportPromise) {
    const url = new URL("../data.json", import.meta.url);
    reportPromise = fetch(url, { cache: "no-store" }).then(async response => {
      if (!response.ok) {
        throw new Error(`無法載入 data.json（HTTP ${response.status}）`);
      }
      const report = await response.json();
      if (!report || !Array.isArray(report.banks)) {
        throw new Error("data.json 格式不正確：找不到 banks 陣列。");
      }
      return report;
    });
  }
  return reportPromise;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function statusClass(status) {
  if (String(status).includes("未能確認")) return "unknown";
  if (String(status).includes("部分")) return "partial";
  return "ok";
}

export function verificationGroup(bank) {
  if ((bank.third_party_sources || []).length) return "third-party";
  if (String(bank.status).includes("部分")) return "incomplete";
  return "official";
}

export function allSources(bank) {
  // Keep one clickable link per URL and preserve third-party disclosure even
  // when a fallback was also copied into the main sources array.
  const unique = new Map();
  for (const source of bank.sources || []) {
    if (source?.url) unique.set(source.url, { ...source, thirdParty: false });
  }
  for (const source of bank.third_party_sources || []) {
    if (source?.url) unique.set(source.url, { ...source, thirdParty: true });
  }
  return [...unique.values()];
}

export function rateBadge(verified) {
  return verified
    ? '<span class="rate-source official">官方確認</span>'
    : '<span class="rate-source third">未驗證／參考值</span>';
}

export function splitClauses(value) {
  let text = String(value ?? "").trim();
  if (!text) return [];

  text = text.replace(/(?=[①②③④⑤⑥⑦⑧⑨⑩])/g, "；");
  return text
    .split(/；\s*|(?<=。)\s*(?=[^\s])/u)
    .map(part => part.trim().replace(/[；。]+$/u, ""))
    .filter(Boolean);
}

function emphasizePrefix(value) {
  const text = String(value).trim();
  const match = text.match(/^([^：:]{1,28}[：:])\s*(.*)$/u);
  if (!match) return escapeHtml(text);
  return `<strong>${escapeHtml(match[1])}</strong>${escapeHtml(match[2])}`;
}

const LIST_FIELDS = new Set([
  "資格與任務",
  "計息與付息",
  "免費跨行轉帳",
  "免費跨行提款",
  "其他福利",
  "本期變動",
  "限制與注意事項",
]);

const PARAGRAPH_FIELDS = new Set([
  "一般利率",
  "優惠摘要",
  "級距摘要",
  "優惠額度",
  "促銷期間",
]);

export function formatDetailValue(label, value) {
  const parts = splitClauses(value);

  if (LIST_FIELDS.has(label) && parts.length > 1) {
    return `<ul class="field-list">${parts
      .map(part => `<li>${emphasizePrefix(part)}</li>`)
      .join("")}</ul>`;
  }

  if (PARAGRAPH_FIELDS.has(label) && parts.length > 1) {
    return parts
      .map(part => `<p class="field-paragraph">${emphasizePrefix(part)}</p>`)
      .join("");
  }

  return `<p class="field-paragraph">${emphasizePrefix(value)}</p>`;
}

export function showPageError(container, error) {
  container.innerHTML = `
    <section class="page-error">
      <h1>無法載入頁面資料</h1>
      <p>${escapeHtml(error?.message || error)}</p>
      <p>請確認網站是透過本機 HTTP 伺服器開啟，而且 data.json 與 HTML 檔案位於同一個網站根目錄。</p>
    </section>
  `;
}
