
import {
  loadReport,
  escapeHtml,
  statusClass,
  rateBadge,
  formatDetailValue,
  showPageError,
} from "./common.js";

function amountLabel(amount) {
  if (amount >= 10000) return `${amount / 10000}萬`;
  return new Intl.NumberFormat("zh-TW").format(amount);
}

function buildComboChart(diagram) {
  const tiers = diagram.tiers || [];
  const total = tiers.reduce(
    (sum, tier) => sum + Number(tier.range_amount || 0),
    0,
  );
  if (!tiers.length || total <= 0) return "";

  const verified = diagram.verified !== false;
  const rates = tiers.map(tier => Number(tier.rate));
  const samples = [];

  for (let index = 1; index <= 100; index += 1) {
    const amount = total * index / 100;
    let remaining = amount;
    let weighted = 0;

    for (const tier of tiers) {
      const used = Math.min(remaining, Number(tier.range_amount));
      weighted += used * Number(tier.rate);
      remaining -= used;
      if (remaining <= 0) break;
    }
    samples.push([amount, weighted / amount]);
  }

  const maximumRate = Math.max(
    ...rates,
    ...samples.map(([, rate]) => rate),
  );
  const yMaximum = Math.max(1, Math.ceil(maximumRate * 1.2 * 2) / 2);

  const width = 960;
  const height = 380;
  const left = 76;
  const right = 30;
  const top = 28;
  const bottom = 64;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const baseline = top + plotHeight;

  const xPosition = amount => left + amount / total * plotWidth;
  const yPosition = rate => top + plotHeight - rate / yMaximum * plotHeight;

  const grid = [];
  for (let index = 0; index <= 5; index += 1) {
    const rate = yMaximum * index / 5;
    const y = yPosition(rate);
    grid.push(`<line class="chart-grid" x1="${left}" y1="${y}" x2="${width-right}" y2="${y}"/>`);
    grid.push(`<text class="axis-label" x="${left-10}" y="${y+4}" text-anchor="end">${rate.toFixed(rate % 1 ? 1 : 0)}%</text>`);
  }

  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const amount = total * fraction;
    const x = xPosition(amount);
    grid.push(`<line class="chart-grid vertical" x1="${x}" y1="${top}" x2="${x}" y2="${baseline}"/>`);
    grid.push(`<text class="axis-label" x="${x}" y="${baseline+25}" text-anchor="middle">${escapeHtml(amountLabel(amount))}</text>`);
  }

  const palette = ["#2563eb", "#0891b2", "#7c3aed", "#f59e0b"];
  const bars = [];
  const boundaryPoints = [];
  let cursor = 0;
  let weightedSum = 0;

  tiers.forEach((tier, index) => {
    const start = cursor;
    const end = cursor + Number(tier.range_amount);
    cursor = end;

    const x = xPosition(start);
    const segmentWidth = xPosition(end) - x;
    const y = yPosition(Number(tier.rate));
    const segmentHeight = baseline - y;
    const fill = verified
      ? palette[index % palette.length]
      : "url(#unverifiedPattern)";

    bars.push(`<rect class="tier-bar" x="${x}" y="${y}" width="${Math.max(segmentWidth, 1)}" height="${segmentHeight}" fill="${fill}" rx="4"/>`);
    bars.push(`<text class="bar-rate-label" x="${x+segmentWidth/2}" y="${Math.max(y-8, top+14)}" text-anchor="middle">${Number(tier.rate)}%</text>`);
    bars.push(`<text class="bar-range-label" x="${x+segmentWidth/2}" y="${baseline-9}" text-anchor="middle">${escapeHtml(tier.range_label)}</text>`);

    weightedSum += Number(tier.range_amount) * Number(tier.rate);
    const effective = weightedSum / end;
    boundaryPoints.push(`<circle class="effective-point" cx="${xPosition(end)}" cy="${yPosition(effective)}" r="5"/>`);
    boundaryPoints.push(`<text class="effective-label" x="${xPosition(end)}" y="${yPosition(effective)-11}" text-anchor="middle">${effective.toFixed(2)}%</text>`);
  });

  const linePoints = samples
    .map(([amount, rate]) => `${xPosition(amount)},${yPosition(rate)}`)
    .join(" ");
  const overall = tiers.reduce(
    (sum, tier) =>
      sum + Number(tier.range_amount) * Number(tier.rate),
    0,
  ) / total;

  return `
    <div class="combo-chart-wrap">
      <svg class="combo-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="分層利率與累積有效利率">
        <defs>
          <pattern id="unverifiedPattern" patternUnits="userSpaceOnUse" width="12" height="12" patternTransform="rotate(135)">
            <rect width="12" height="12" fill="#f59e0b"></rect>
            <rect width="5" height="12" fill="#fde68a"></rect>
          </pattern>
        </defs>
        ${grid.join("")}
        <line class="chart-axis" x1="${left}" y1="${top}" x2="${left}" y2="${baseline}"></line>
        <line class="chart-axis" x1="${left}" y1="${baseline}" x2="${width-right}" y2="${baseline}"></line>
        ${bars.join("")}
        <polyline class="effective-line ${verified ? "" : "unverified"}" points="${linePoints}"></polyline>
        ${boundaryPoints.join("")}
        <text class="axis-title" transform="translate(20,${top+plotHeight/2}) rotate(-90)" text-anchor="middle">年利率</text>
        <text class="axis-title" x="${left+plotWidth/2}" y="${height-12}" text-anchor="middle">存款金額（新臺幣）</text>
      </svg>
      <div class="chart-key">
        <span><i class="key-box"></i>各級距邊際利率</span>
        <span><i class="key-line"></i>累積／有效利率</span>
        ${verified ? "" : '<span class="unverified-key">含未確認資料／示意範圍</span>'}
      </div>
      <p class="combo-caption">存滿圖示範圍時，整體加權平均約為 <strong>${overall.toFixed(2)}%</strong>。</p>
    </div>
  `;
}

function renderTierSection(bank) {
  const diagrams = bank.tier_diagrams || [];
  const tabs = diagrams.map((diagram, index) => `
    <button
      type="button"
      class="${index === 0 ? "active" : ""}"
      data-tier-tab="tier-${index}"
    >${escapeHtml(diagram.label)}${diagram.verified === false ? "（含未確認資料）" : ""}</button>
  `).join("");

  const panels = diagrams.map((diagram, index) => {
    const rows = (diagram.tiers || []).map(tier => `
      <tr>
        <td>${escapeHtml(tier.range_label)}</td>
        <td>${escapeHtml(tier.rate)}%</td>
        <td>${escapeHtml(tier.note)}</td>
      </tr>
    `).join("");

    return `
      <div
        class="tier-panel ${index === 0 ? "active" : ""}"
        data-tier-panel="tier-${index}"
      >
        ${diagram.verified === false
          ? '<div class="third-party-alert"><strong>注意：</strong>此圖包含第三方數字、未知額度的示意範圍，或尚未由官方完整確認的級距。</div>'
          : ""}
        <p class="intro">${escapeHtml(diagram.description)}</p>
        ${buildComboChart(diagram)}
        <div class="table-wrap compact-table" style="margin-top:15px">
          <table>
            <thead>
              <tr><th>本金級距</th><th>邊際利率</th><th>說明</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }).join("");

  return `
    <section class="detail-card" data-tier-group>
      <h2>利率級距與有效利率</h2>
      <p class="intro">單一利率方案顯示水平有效利率；無上限方案使用明確標示的示意金額範圍。</p>
      <div class="tier-tabs">${tabs}</div>
      ${panels}
    </section>
  `;
}

function renderDetailFields(bank, reportDate) {
  const fields = [
    ["新戶最高利率", `${escapeHtml(bank.new_rate_text)}<br>${rateBadge(bank.new_rate_verified)}`],
    ["既有戶最高利率", `${escapeHtml(bank.existing_rate_text)}<br>${rateBadge(bank.existing_rate_verified)}`],
    ["一般利率", bank.general_rate],
    ["優惠摘要", bank.promo_summary],
    ["級距摘要", bank.tier_summary],
    ["優惠額度", bank.limit],
    ["資格與任務", bank.conditions],
    ["促銷期間", bank.period],
    ["計息與付息", bank.interest],
    ["免費跨行轉帳", bank.transfer],
    ["免費跨行提款", bank.withdraw],
    ["其他福利", bank.benefits],
    ["本期變動", bank.change],
    ["限制與注意事項", bank.notes],
    ["查核日期", reportDate],
  ];

  return fields.map(([label, value], index) => {
    const renderedValue = index < 2
      ? value
      : formatDetailValue(label, value);

    return `
      <div class="field-label">${escapeHtml(label)}</div>
      <div class="field-value">${renderedValue}</div>
    `;
  }).join("");
}

function renderSources(bank) {
  const official = (bank.sources || []).map(source => `
    <li>
      <a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(source.label)}
      </a>
    </li>
  `).join("");

  const thirdParty = (bank.third_party_sources || []).map(source => `
    <li>
      <a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(source.label)}
      </a>
    </li>
  `).join("");

  return `
    <section class="detail-card sources">
      <h2>官方資料來源</h2>
      <ul>${official}</ul>
      ${thirdParty
        ? `<h2 style="margin-top:24px">第三方暫補來源</h2><ul>${thirdParty}</ul>`
        : ""}
    </section>
  `;
}

function bindTierTabs() {
  document.querySelectorAll("[data-tier-group]").forEach(group => {
    const buttons = group.querySelectorAll("[data-tier-tab]");
    const panels = group.querySelectorAll("[data-tier-panel]");

    buttons.forEach(button => {
      button.addEventListener("click", () => {
        const key = button.dataset.tierTab;
        buttons.forEach(item =>
          item.classList.toggle("active", item === button)
        );
        panels.forEach(panel =>
          panel.classList.toggle(
            "active",
            panel.dataset.tierPanel === key,
          )
        );
      });
    });
  });
}

function renderBankPage(bank, reportDate) {
  document.title = `${bank.name}｜台灣數位帳戶比較`;

  const thirdPartyAlert = (bank.third_party_sources || []).length
    ? `<div class="third-party-alert"><strong>第三方暫補：</strong>${escapeHtml(bank.third_party_note || "")}</div>`
    : "";

  document.getElementById("bankPage").innerHTML = `
    <header class="detail-hero">
      <div class="detail-container">
        <div class="detail-hero-panel">
          <a class="back-link" href="index.html">← 返回完整比較</a>
          <div class="detail-title-row">
            <div>
              <h1>${escapeHtml(bank.name)}</h1>
              <p>${escapeHtml(bank.promo_summary)}</p>
            </div>
            <span class="status detail-status">${escapeHtml(bank.status)}</span>
          </div>
          <div class="detail-kpis">
            <div class="detail-kpi">
              <div class="label">新戶最高</div>
              <div class="value">${escapeHtml(bank.new_rate_text)}</div>
            </div>
            <div class="detail-kpi">
              <div class="label">既有戶最高</div>
              <div class="value">${escapeHtml(bank.existing_rate_text)}</div>
            </div>
            <div class="detail-kpi">
              <div class="label">免費跨轉</div>
              <div class="value">${escapeHtml(bank.transfer)}</div>
            </div>
            <div class="detail-kpi">
              <div class="label">免費跨提</div>
              <div class="value">${escapeHtml(bank.withdraw)}</div>
            </div>
          </div>
        </div>
      </div>
    </header>

    <main class="detail-container detail-main">
      ${thirdPartyAlert}
      ${renderTierSection(bank)}
      <section class="detail-card">
        <h2>詳細資料</h2>
        <p class="intro">所有資料均從 data.json 即時載入；長條件使用分段與條列呈現。</p>
        <div class="kv">${renderDetailFields(bank, reportDate)}</div>
      </section>
      ${renderSources(bank)}
    </main>

    <footer class="detail-container detail-footer">
      此頁由共用 bank.html 模板與 data.json 動態產生。
    </footer>
  `;

  bindTierTabs();
}

async function start() {
  const container = document.getElementById("bankPage");

  try {
    const report = await loadReport();
    const slug = new URLSearchParams(window.location.search).get("bank");
    const bank = report.banks.find(item => item.slug === slug);

    if (!slug || !bank) {
      container.innerHTML = `
        <main class="detail-container detail-main">
          <section class="page-error">
            <h1>找不到銀行資料</h1>
            <p>網址需要包含有效的 bank 參數，例如：</p>
            <p><code>bank.html?bank=hncb-sny</code></p>
            <p><a href="index.html">返回完整比較</a></p>
          </section>
        </main>
      `;
      return;
    }

    renderBankPage(bank, report.report_date);
  } catch (error) {
    showPageError(container, error);
  }
}

start();
