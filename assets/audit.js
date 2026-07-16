
import {
  loadReport,
  escapeHtml,
  showPageError,
} from "./common.js";

let gaps = [];
let query = "";
let severity = "";

function renderCards(items) {
  const wrapper = document.getElementById("gaps");

  wrapper.innerHTML = items.map(gap => {
    const sources = (gap.sources || []).map(source => `
      <a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(source.label)}
      </a>
    `).join("");

    return `
      <article class="gap-card">
        <div class="gap-head">
          <div>
            <span class="severity sev-${escapeHtml(gap.severity)}">${escapeHtml(gap.severity)}</span>
            <h2>${escapeHtml(gap.bank)}</h2>
          </div>
          <div class="field-name">${escapeHtml(gap.field)}</div>
        </div>
        <dl>
          <dt>狀態</dt><dd>${escapeHtml(gap.status)}</dd>
          <dt>已確認</dt><dd>${escapeHtml(gap.known)}</dd>
          <dt>仍缺少</dt><dd>${escapeHtml(gap.missing)}</dd>
          <dt>已查找</dt><dd>${escapeHtml(gap.checked)}</dd>
          <dt>來源</dt><dd class="gap-sources">${sources}</dd>
        </dl>
      </article>
    `;
  }).join("");

  document.getElementById("empty").style.display =
    items.length ? "none" : "block";
}

function render() {
  const normalizedQuery = query.trim().toLowerCase();
  const visible = gaps.filter(gap => {
    const text = [
      gap.bank,
      gap.field,
      gap.status,
      gap.known,
      gap.missing,
      gap.checked,
    ].join(" ").toLowerCase();

    return (
      (!normalizedQuery || text.includes(normalizedQuery)) &&
      (!severity || gap.severity === severity)
    );
  });

  document.getElementById("visibleCount").textContent = visible.length;
  renderCards(visible);
}

async function start() {
  try {
    const report = await loadReport();
    gaps = report.missing_data || [];

    document.getElementById("reportDate").textContent = report.report_date;
    document.getElementById("totalCount").textContent = gaps.length;
    document.getElementById("visibleCount").textContent = gaps.length;

    for (const level of ["高", "中", "低"]) {
      document.getElementById(`count-${level}`).textContent =
        gaps.filter(gap => gap.severity === level).length;
    }

    document.getElementById("q").addEventListener("input", event => {
      query = event.target.value;
      render();
    });

    document.getElementById("sev").addEventListener("change", event => {
      severity = event.target.value;
      render();
    });

    document.getElementById("reset").addEventListener("click", () => {
      query = "";
      severity = "";
      document.getElementById("q").value = "";
      document.getElementById("sev").value = "";
      render();
    });

    render();
  } catch (error) {
    showPageError(document.querySelector(".wrap"), error);
  }
}

start();
