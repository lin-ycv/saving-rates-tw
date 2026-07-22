
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
let selectedBankSlugs = new Set();

let state = {
  sortMode: "new",
  query: "",
  verification: "all",
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
    ) {
      return false;
    }

    const activeRate = rateFor(bank, state.sortMode);
    if (
      state.minRate > 0 &&
      (activeRate == null || activeRate < state.minRate)
    ) {
      return false;
    }

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

function compactLines(value, maximum = 3) {
  const parts = String(value || "")
    .replace(/(?=[①②③④⑤⑥⑦⑧⑨⑩])/g, "；")
    .split(/；\s*|(?<=。)\s*(?=[^\s])/u)
    .map(part => part.trim().replace(/[；。]+$/u, ""))
    .filter(Boolean);

  const visible = parts.slice(0, maximum);
  const hiddenCount = Math.max(0, parts.length - visible.length);

  return `
    <div class="compact-lines">
      ${visible.map(part => `<div>${escapeHtml(part)}</div>`).join("")}
      ${hiddenCount
        ? `<div class="more-details">另有 ${hiddenCount} 項，請進入詳細頁</div>`
        : ""}
    </div>
  `;
}

function updateSelectionToolbar(visibleItems = filteredBanks()) {
  const count = selectedBankSlugs.size;
  const countElement = document.getElementById("selectedBankCount");
  const clearButton = document.getElementById("clearBankSelection");
  const openButton = document.getElementById("openSelectedBanks");
  const selectAll = document.getElementById("selectAllBanks");
  const visibleSlugs = visibleItems.map(bank => bank.slug);
  const selectedVisible = visibleSlugs.filter(slug =>
    selectedBankSlugs.has(slug)
  ).length;

  countElement.textContent = count;
  clearButton.disabled = count === 0;
  openButton.disabled = count === 0;

  selectAll.checked =
    visibleSlugs.length > 0 && selectedVisible === visibleSlugs.length;
  selectAll.indeterminate =
    selectedVisible > 0 && selectedVisible < visibleSlugs.length;
}

function bindTableSelection(items) {
  document.querySelectorAll("[data-bank-select]").forEach(input => {
    input.addEventListener("change", event => {
      const slug = event.target.dataset.bankSelect;

      if (event.target.checked) {
        selectedBankSlugs.add(slug);
      } else {
        selectedBankSlugs.delete(slug);
      }

      updateSelectionToolbar(items);
    });
  });

  updateSelectionToolbar(items);
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
        <td class="select-cell">
          <input
            type="checkbox"
            data-bank-select="${escapeHtml(bank.slug)}"
            aria-label="選取${escapeHtml(bank.name)}"
            ${selectedBankSlugs.has(bank.slug) ? "checked" : ""}
          >
        </td>
        <td class="rank-cell">${index + 1}</td>
        <td class="name-cell">
          <a href="${bankUrl(bank)}">${escapeHtml(bank.name)}</a><br>
          <span class="status ${statusClass(bank.status)}">${escapeHtml(bank.status)}</span>
        </td>
        <td class="rate-cell">
          <strong>${escapeHtml(bank.new_rate_text)}</strong><br>
          ${rateBadge(bank.new_rate_verified)}
        </td>
        <td class="rate-cell">
          <strong>${escapeHtml(bank.existing_rate_text)}</strong><br>
          ${rateBadge(bank.existing_rate_verified)}
        </td>
        <td class="tier-cell">
          ${compactLines(bank.tier_summary, 3)}
          <div class="compact-secondary">
            <span class="compact-label">額度</span>
            ${escapeHtml(bank.limit)}
          </div>
        </td>
        <td class="conditions-cell">${compactLines(bank.conditions, 3)}</td>
        <td class="period-cell">${compactLines(bank.period, 3)}</td>
        <td class="transfer-cell">${compactLines(bank.transfer, 2)}</td>
        <td class="withdraw-cell">${compactLines(bank.withdraw, 2)}</td>
        <td class="sources-cell"><div class="source-list">${sources}</div></td>
      </tr>
    `;
  }).join("") || `
    <tr>
      <td colspan="11">
        <div class="empty-state">沒有符合目前篩選條件的帳戶。</div>
      </td>
    </tr>
  `;

  bindTableSelection(items);
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

  document.getElementById("minRate").addEventListener("change", event => {
    state.minRate = Number(event.target.value);
    render();
  });

  document.getElementById("selectAllBanks").addEventListener("change", event => {
    const items = filteredBanks();

    items.forEach(bank => {
      if (event.target.checked) {
        selectedBankSlugs.add(bank.slug);
      } else {
        selectedBankSlugs.delete(bank.slug);
      }
    });

    renderTable(items);
  });

  document.getElementById("clearBankSelection").addEventListener("click", () => {
    selectedBankSlugs.clear();
    renderTable(filteredBanks());
  });

  document.getElementById("openSelectedBanks").addEventListener("click", () => {
    if (!selectedBankSlugs.size) return;

    const url = new URL("allocator.html", window.location.href);
    url.searchParams.set("banks", [...selectedBankSlugs].join(","));
    window.location.href = url.href;
  });

  document.getElementById("resetFilters").addEventListener("click", () => {
    state = {
      sortMode: "new",
      query: "",
      verification: "all",
      minRate: 0,
    };
    document.getElementById("bankSearch").value = "";
    document.getElementById("verificationFilter").value = "all";
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
