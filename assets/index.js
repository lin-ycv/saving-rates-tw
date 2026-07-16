
import {
  loadReport,
  escapeHtml,
  statusClass,
  verificationGroup,
  allSources,
  rateBadge,
  showPageError,
} from "./common.js";

let banks = [];
let state = {
  sortMode: "new",
  query: "",
  verification: "all",
  tieredOnly: false,
  minRate: 0,
};

function rateFor(bank, mode) {
  return mode === "new" ? bank.new_rate_value : bank.existing_rate_value;
}

function sortBanks(items) {
  return [...items].sort((a, b) => {
    const aValue = rateFor(a, state.sortMode);
    const bValue = rateFor(b, state.sortMode);

    if (aValue == null && bValue == null) {
      return a.name.localeCompare(b.name, "zh-Hant");
    }
    if (aValue == null) return 1;
    if (bValue == null) return -1;
    if (bValue !== aValue) return bValue - aValue;
    return a.name.localeCompare(b.name, "zh-Hant");
  });
}

function filteredBanks() {
  const query = state.query.trim().toLowerCase();

  return sortBanks(banks.filter(bank => {
    const searchText = [
      bank.name,
      bank.promo_summary,
      bank.conditions,
      bank.tier_summary,
      bank.benefits,
    ].join(" ").toLowerCase();

    if (query && !searchText.includes(query)) return false;
    if (
      state.verification !== "all" &&
      verificationGroup(bank) !== state.verification
    ) return false;
    if (state.tieredOnly && !(bank.tier_diagrams || []).length) return false;

    const activeRate = rateFor(bank, state.sortMode);
    if (
      state.minRate > 0 &&
      (activeRate == null || activeRate < state.minRate)
    ) return false;

    return true;
  }));
}

function bankUrl(bank) {
  return `bank.html?bank=${encodeURIComponent(bank.slug)}`;
}

function renderChart(items) {
  const wrapper = document.getElementById("barList");
  const values = items
    .flatMap(bank => [bank.new_rate_value, bank.existing_rate_value])
    .filter(value => value != null);
  const maximum = values.length ? Math.max(...values) : 1;

  wrapper.innerHTML = items.map(bank => {
    const lines = [
      {
        label: "新戶",
        value: bank.new_rate_value,
        text: bank.new_rate_text,
        verified: bank.new_rate_verified,
        className: "new",
      },
      {
        label: "既有戶",
        value: bank.existing_rate_value,
        text: bank.existing_rate_text,
        verified: bank.existing_rate_verified,
        className: "existing",
      },
    ].map(item => {
      const width =
        item.value == null ? 0 : Math.max(3, item.value / maximum * 100);

      return `
        <div class="dual-line">
          <div class="dual-label">
            <span class="dot ${item.className}"></span>${item.label}
          </div>
          <div class="track">
            ${item.value == null
              ? '<div class="no-value">無數字</div>'
              : `<div class="fill ${item.className} ${item.verified ? "" : "unverified"}" style="width:${width}%"></div>`}
          </div>
          <div class="dual-value">
            <strong>${escapeHtml(item.text)}</strong>
            ${rateBadge(item.verified)}
          </div>
        </div>
      `;
    }).join("");

    return `
      <article class="bar-row">
        <div class="bank-meta">
          <a href="${bankUrl(bank)}"><strong>${escapeHtml(bank.name)}</strong></a>
          <div>
            <span class="status ${statusClass(bank.status)}">${escapeHtml(bank.status)}</span>
          </div>
          <div class="bar-note">${escapeHtml(bank.tier_summary)}</div>
        </div>
        <div class="dual-bars">${lines}</div>
      </article>
    `;
  }).join("") || '<div class="empty-state">沒有符合目前篩選條件的帳戶。</div>';
}

function renderTable(items) {
  const body = document.getElementById("comparisonBody");

  body.innerHTML = items.map((bank, index) => {
    const sources = allSources(bank).map(source => `
      <a
        class="source-chip ${source.thirdParty ? "third-party" : ""}"
        href="${escapeHtml(source.url)}"
        target="_blank"
        rel="noopener noreferrer"
      >${source.thirdParty ? "第三方：" : ""}${escapeHtml(source.label)}</a>
    `).join("");

    return `
      <tr>
        <td>${index + 1}</td>
        <td class="name-cell">
          <a href="${bankUrl(bank)}">${escapeHtml(bank.name)}</a><br>
          <span class="status ${statusClass(bank.status)}">${escapeHtml(bank.status)}</span>
        </td>
        <td>
          <strong>${escapeHtml(bank.new_rate_text)}</strong><br>
          ${rateBadge(bank.new_rate_verified)}
        </td>
        <td>
          <strong>${escapeHtml(bank.existing_rate_text)}</strong><br>
          ${rateBadge(bank.existing_rate_verified)}
        </td>
        <td>${escapeHtml(bank.tier_summary)}</td>
        <td>${escapeHtml(bank.conditions)}</td>
        <td>${escapeHtml(bank.period)}</td>
        <td>${escapeHtml(bank.interest)}</td>
        <td>${escapeHtml(bank.transfer)}</td>
        <td>${escapeHtml(bank.withdraw)}</td>
        <td>${escapeHtml(bank.change)}</td>
        <td><div class="source-list">${sources}</div></td>
      </tr>
    `;
  }).join("") || `
    <tr>
      <td colspan="12">
        <div class="empty-state">沒有符合目前篩選條件的帳戶。</div>
      </td>
    </tr>
  `;
}

function render() {
  const items = filteredBanks();

  document.querySelectorAll("[data-sort-mode]").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.sortMode === state.sortMode,
    );
  });

  document.getElementById("currentSortLabel").textContent =
    state.sortMode === "new" ? "新戶最高利率" : "既有戶最高利率";
  document.getElementById("resultCount").textContent =
    `${items.length} / ${banks.length} 家`;

  renderChart(items);
  renderTable(items);
}

function bindControls() {
  document.querySelectorAll("[data-sort-mode]").forEach(button => {
    button.addEventListener("click", () => {
      state.sortMode = button.dataset.sortMode;
      render();
    });
  });

  document.getElementById("bankSearch").addEventListener("input", event => {
    state.query = event.target.value;
    render();
  });

  document.getElementById("verificationFilter").addEventListener("change", event => {
    state.verification = event.target.value;
    render();
  });

  document.getElementById("tieredOnly").addEventListener("change", event => {
    state.tieredOnly = event.target.checked;
    render();
  });

  document.getElementById("minRate").addEventListener("change", event => {
    state.minRate = Number(event.target.value);
    render();
  });

  document.getElementById("resetFilters").addEventListener("click", () => {
    state = {
      sortMode: "new",
      query: "",
      verification: "all",
      tieredOnly: false,
      minRate: 0,
    };
    document.getElementById("bankSearch").value = "";
    document.getElementById("verificationFilter").value = "all";
    document.getElementById("tieredOnly").checked = false;
    document.getElementById("minRate").value = "0";
    render();
  });
}

async function start() {
  try {
    const report = await loadReport();
    banks = report.banks;
    document.querySelectorAll("[data-report-date]").forEach(element => {
      element.textContent = report.report_date;
    });
    bindControls();
    render();
  } catch (error) {
    showPageError(document.querySelector("main"), error);
  }
}

start();
