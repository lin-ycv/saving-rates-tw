
import {
  loadReport,
  escapeHtml,
  rateBadge,
  showPageError,
} from "./common.js";

const STORAGE_KEY = "taiwanSavingsAllocator.v4";
const LEGACY_STORAGE_KEYS = [
  "taiwanSavingsAllocator.v3",
  "taiwanSavingsAllocator.v2",
  "taiwanSavingsAllocator.v1",
];
const STORAGE_VERSION = 4;
const EXPORT_VERSION = 2;
const RATE_EPSILON = 0.000001;

const currency = new Intl.NumberFormat("zh-TW", {
  style: "currency",
  currency: "TWD",
  maximumFractionDigits: 0,
});

let report;
let banksBySlug = new Map();
let plansById = new Map();
let plansByBank = new Map();
let selections = [];
let persistBalances = false;
let unallocatedCash = 0;

function formatMoney(value) {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  return currency.format(Math.max(0, Math.round(amount)));
}

function signedMoney(value) {
  const amount = Math.round(Number(value) || 0);
  if (amount < 0) return `−${formatMoney(Math.abs(amount))}`;
  return formatMoney(amount);
}

function compactMoney(value) {
  const amount = Number(value) || 0;
  if (amount >= 10000) {
    const wan = amount / 10000;
    return `${Number.isInteger(wan) ? wan : wan.toFixed(1)}萬元`;
  }
  return formatMoney(amount);
}


function parseMoney(value) {
  const digits = String(value ?? "").replace(/[^\d]/gu, "");
  if (!digits) return 0;

  const number = Number(digits);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Math.round(number), Number.MAX_SAFE_INTEGER);
}

function formatInputMoney(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(parseMoney(value));
}

function formatMoneyInputElement(input) {
  const raw = input.value;
  const cursor = input.selectionStart ?? raw.length;
  const digitsBeforeCursor = raw
    .slice(0, cursor)
    .replace(/[^\d]/gu, "")
    .length;

  const formatted = formatInputMoney(raw);
  input.value = formatted;

  let nextCursor = 0;
  let seenDigits = 0;

  while (
    nextCursor < formatted.length &&
    seenDigits < digitsBeforeCursor
  ) {
    if (/\d/u.test(formatted[nextCursor])) {
      seenDigits += 1;
    }
    nextCursor += 1;
  }

  try {
    input.setSelectionRange(nextCursor, nextCursor);
  } catch {
    // Ignore browsers that do not expose a selection range.
  }
}

function formatRate(value, digits = 3) {
  const number = Number(value) || 0;
  return `${number.toFixed(digits).replace(/0+$/u, "").replace(/\.$/u, "")}%`;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isPostedRateTier(tier) {
  const text = [
    tier.range_label,
    tier.note,
  ].join(" ");

  return /牌告|基本利率|一般活|活期儲蓄存款|存簿儲金|回到基本/u.test(text);
}

function classifyTierCapacity(tier) {
  const text = [tier.range_label, tier.note].join(" ");
  const amount = Number(tier.range_amount);

  const isUnknown =
    /額度未明|額度未知|本金範圍未確認|額度未確認/u.test(text);
  const isIllustrative = /示意/u.test(text);
  const isExplicitlyUnlimited =
    /無上限|未載上限|以上適用/u.test(text);
  const isOverflow =
    /超過|超額|回到基本/u.test(text);

  if (isUnknown) return "unknown";
  if (isExplicitlyUnlimited) return "unlimited";
  if (isIllustrative && isOverflow) return "unlimited";
  if (isIllustrative) return "unknown";
  if (Number.isFinite(amount) && amount > 0) return "finite";
  return "unknown";
}

function createPlan(bank, diagram, diagramIndex) {
  let finiteBefore = 0;

  const tiers = (diagram.tiers || []).map((tier, tierIndex) => {
    const capacityMode = classifyTierCapacity(tier);
    const capacity = capacityMode === "finite"
      ? Number(tier.range_amount)
      : null;
    const startAmount = finiteBefore;

    if (capacityMode === "finite") {
      finiteBefore += capacity;
    }

    const displayLabel = capacityMode === "unlimited"
      ? `${compactMoney(startAmount)}以上`
      : tier.range_label;

    return {
      index: tierIndex,
      label: tier.range_label,
      displayLabel,
      note: tier.note,
      rate: Number(tier.rate),
      capacityMode,
      capacity,
      startAmount,
      isPostedRate: isPostedRateTier(tier),
      isTrailingPostedOverflow: false,
    };
  });

  const promotionalIndexes = tiers
    .filter(tier => !tier.isPostedRate)
    .map(tier => tier.index);
  const hasPromotionalTier = promotionalIndexes.length > 0;
  const lastPromotionalIndex = hasPromotionalTier
    ? Math.max(...promotionalIndexes)
    : -1;

  let trailingPostedStart = -1;
  if (
    hasPromotionalTier &&
    lastPromotionalIndex < tiers.length - 1
  ) {
    const trailing = tiers.slice(lastPromotionalIndex + 1);
    if (trailing.length && trailing.every(tier => tier.isPostedRate)) {
      trailingPostedStart = lastPromotionalIndex + 1;
      trailing.forEach(tier => {
        tier.isTrailingPostedOverflow = true;
      });
    }
  }

  const hasPostedOverflow = trailingPostedStart >= 0;
  const recommendationTiers = hasPostedOverflow
    ? tiers.slice(0, trailingPostedStart)
    : tiers;

  function orderedKnownLimit(inputTiers) {
    let sum = 0;

    for (const tier of inputTiers) {
      if (tier.capacityMode === "finite") {
        sum += tier.capacity;
        continue;
      }
      if (tier.capacityMode === "unlimited") return Infinity;
      return sum;
    }

    return sum;
  }

  const promotionalLimit = hasPostedOverflow
    ? orderedKnownLimit(recommendationTiers)
    : null;
  const knownAutoLimit = orderedKnownLimit(recommendationTiers);

  const hasUnknown = tiers.some(tier => tier.capacityMode === "unknown");
  const hasUnlimited = tiers.some(tier => tier.capacityMode === "unlimited");
  const capacityMode = hasPostedOverflow
    ? "posted-overflow"
    : hasUnknown
      ? "unknown"
      : hasUnlimited
        ? "unlimited"
        : "finite";

  const finiteCapacity = tiers
    .filter(tier => tier.capacityMode === "finite")
    .reduce((sum, tier) => sum + tier.capacity, 0);

  const economicSignature = tiers.map(tier => {
    const mode = tier.capacityMode === "finite"
      ? `f${tier.capacity}`
      : tier.capacityMode === "unlimited"
        ? "u"
        : "x";
    const overflow = tier.isTrailingPostedOverflow ? "p" : "";
    return `${mode}@${Number(tier.rate)}${overflow}`;
  }).join("|");

  const id = `${bank.slug}::${diagramIndex}`;
  const fingerprint = hashString(JSON.stringify({
    schemaVersion: report.schema_version,
    bankSlug: bank.slug,
    bankPeriod: bank.period,
    label: diagram.label,
    description: diagram.description,
    verified: diagram.verified !== false,
    tiers: diagram.tiers,
    postedOverflowStart: trailingPostedStart,
  }));

  return {
    id,
    bankSlug: bank.slug,
    bankName: bank.name,
    label: diagram.label,
    description: diagram.description,
    verified: diagram.verified !== false,
    tiers,
    recommendationTiers,
    capacityMode,
    finiteCapacity,
    knownAutoLimit,
    hasPromotionalTier,
    hasPostedOverflow,
    trailingPostedStart,
    promotionalLimit,
    maxRate: tiers.length
      ? Math.max(...tiers.map(tier => tier.rate))
      : 0,
    fingerprint,
    economicSignature,
  };
}

function buildCatalog() {
  banksBySlug = new Map(report.banks.map(bank => [bank.slug, bank]));
  plansById.clear();
  plansByBank.clear();

  report.banks.forEach(bank => {
    const plans = (bank.tier_diagrams || []).map((diagram, index) => {
      const plan = createPlan(bank, diagram, index);
      plansById.set(plan.id, plan);
      return plan;
    });

    plansByBank.set(bank.slug, plans);
  });
}

function planCapacityLabel(plan) {
  if (plan.hasPostedOverflow) {
    return `優惠上限 ${formatMoney(plan.promotionalLimit)}；超額按牌告`;
  }
  if (plan.capacityMode === "unlimited") return "無上限";
  if (plan.capacityMode === "unknown") {
    return plan.finiteCapacity > 0
      ? `至少 ${formatMoney(plan.finiteCapacity)}；其後未確認`
      : "總額度未確認";
  }
  return formatMoney(plan.finiteCapacity);
}

function tierRateSummary(plan) {
  return plan.tiers
    .map(tier => {
      const overflow = tier.isTrailingPostedOverflow ? "（牌告超額）" : "";
      return `${tier.displayLabel} ${formatRate(tier.rate)}${overflow}`;
    })
    .join("；");
}

function selectedPlanForBank(bankSlug) {
  const selection = selections.find(item => {
    const plan = plansById.get(item.planId);
    return plan?.bankSlug === bankSlug;
  });
  return selection ? plansById.get(selection.planId) : null;
}

function currentSelection(planId) {
  return selections.find(selection => selection.planId === planId);
}


function planLooksExisting(plan) {
  const text = `${plan.label} ${plan.description}`;

  if (/新戶/u.test(text) && !/既有戶|舊戶/u.test(text)) {
    return false;
  }

  return /既有戶|舊戶|既有客戶|舊客戶|大戶|大大|薪轉|基本|一般|任務/u.test(text);
}

function chooseConservativePlan(bankSlug) {
  const plans = [...(plansByBank.get(bankSlug) || [])];
  if (!plans.length) return null;

  const existingPlans = plans.filter(planLooksExisting);
  const candidates = existingPlans.length ? existingPlans : plans;

  return candidates.sort((a, b) => {
    if (a.maxRate !== b.maxRate) return a.maxRate - b.maxRate;
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    return a.label.localeCompare(b.label, "zh-Hant");
  })[0];
}

function populateBankSelect() {
  const select = document.getElementById("allocatorBank");
  const banks = [...report.banks].sort((a, b) =>
    a.name.localeCompare(b.name, "zh-Hant")
  );

  select.innerHTML = `
    <option value="">選擇銀行</option>
    ${banks.map(bank => `
      <option value="${escapeHtml(bank.slug)}">${escapeHtml(bank.name)}</option>
    `).join("")}
  `;

  const params = new URLSearchParams(window.location.search);
  const requestedBank = params.get("bank");
  const requestedPlanIndex = Number(params.get("plan"));

  if (requestedBank && banksBySlug.has(requestedBank)) {
    select.value = requestedBank;
    populatePlanSelect(
      requestedBank,
      Number.isInteger(requestedPlanIndex) && requestedPlanIndex >= 0
        ? requestedPlanIndex
        : null,
    );
  }
}

function populatePlanSelect(bankSlug, preferredPlanIndex = null) {
  const select = document.getElementById("allocatorPlan");
  const button = document.getElementById("addAllocatorPlan");

  if (!bankSlug) {
    select.disabled = true;
    button.disabled = true;
    select.innerHTML = '<option value="">先選擇銀行</option>';
    return;
  }

  const plans = plansByBank.get(bankSlug) || [];
  const currentPlan = selectedPlanForBank(bankSlug);
  const preferredPlan = Number.isInteger(preferredPlanIndex)
    ? plans.find(plan => planIndexFromId(plan.id) === preferredPlanIndex)
    : null;

  select.disabled = false;
  button.disabled = !plans.length;

  select.innerHTML = plans.length
    ? plans.map(plan => `
        <option value="${escapeHtml(plan.id)}">
          ${escapeHtml(plan.label)}｜最高 ${formatRate(plan.maxRate)}｜${escapeHtml(planCapacityLabel(plan))}
        </option>
      `).join("")
    : '<option value="">此銀行沒有可用方案</option>';

  if (preferredPlan) {
    select.value = preferredPlan.id;
  } else if (currentPlan) {
    select.value = currentPlan.id;
  }
}

function setNotice(message, tone = "info") {
  const notice = document.getElementById("allocatorNotice");
  notice.hidden = !message;
  notice.className = `allocator-notice tone-${tone}`;
  notice.textContent = message;
}


function saveState() {
  const payload = {
    version: STORAGE_VERSION,
    saveBalances: persistBalances,
    selections: selections.map(selection => {
      const plan = plansById.get(selection.planId);
      return {
        planId: selection.planId,
        bankSlug: plan.bankSlug,
        fingerprint: plan.fingerprint,
        economicSignature: plan.economicSignature,
        ignoreOverflowReallocation:
          Boolean(selection.ignoreOverflowReallocation),
        ...(persistBalances ? { balance: selection.balance } : {}),
      };
    }),
    ...(persistBalances ? { unallocatedCash } : {}),
    savedAt: new Date().toISOString(),
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    setNotice("瀏覽器無法儲存設定；目前變更只會保留到本次頁面關閉。", "warning");
  }
}

function findEquivalentPlan(record) {
  if (!record.economicSignature) return null;

  const matches = (plansByBank.get(record.bankSlug) || [])
    .filter(plan =>
      plan.economicSignature === record.economicSignature
    );

  if (!matches.length) return null;

  const sameIndex = matches.find(plan => plan.id === record.planId);
  return sameIndex || matches[0];
}

function resolvePlanRecord(record) {
  const exact = plansById.get(record.planId);

  if (
    exact &&
    exact.bankSlug === record.bankSlug &&
    exact.fingerprint === record.fingerprint
  ) {
    return { plan: exact, mode: "exact" };
  }

  const equivalent = findEquivalentPlan(record);
  if (equivalent) {
    return { plan: equivalent, mode: "equivalent" };
  }

  const conservative = chooseConservativePlan(record.bankSlug);
  if (conservative) {
    return { plan: conservative, mode: "conservative" };
  }

  return { plan: null, mode: "unallocated" };
}

function readSavedPayload() {
  const keys = [STORAGE_KEY, ...LEGACY_STORAGE_KEYS];

  for (const key of keys) {
    try {
      const payload = JSON.parse(localStorage.getItem(key) || "null");
      if (payload && Array.isArray(payload.selections)) {
        return { payload, key };
      }
    } catch {
      try {
        localStorage.removeItem(key);
      } catch {}
    }
  }

  return null;
}

function loadState() {
  const savedResult = readSavedPayload();
  if (!savedResult) return;

  const { payload: saved, key: sourceKey } = savedResult;
  persistBalances = Boolean(saved.saveBalances);
  document.getElementById("persistBalances").checked = persistBalances;

  let recoveredUnallocated = persistBalances
    ? parseMoney(saved.unallocatedCash)
    : 0;
  const restored = [];
  const seenBanks = new Set();
  const equivalentBanks = [];
  const conservativeBanks = [];
  const movedBanks = [];

  for (const item of saved.selections) {
    const bankSlug = item.bankSlug;
    if (!bankSlug || seenBanks.has(bankSlug)) continue;
    seenBanks.add(bankSlug);

    const balance = persistBalances
      ? parseMoney(item.balance)
      : 0;
    const resolved = resolvePlanRecord({
      planId: item.planId,
      bankSlug,
      fingerprint: item.fingerprint,
      economicSignature: item.economicSignature,
    });

    if (!resolved.plan) {
      recoveredUnallocated += balance;
      movedBanks.push(
        banksBySlug.get(bankSlug)?.name || bankSlug
      );
      continue;
    }

    restored.push({
      planId: resolved.plan.id,
      balance,
      ignoreOverflowReallocation:
        resolved.mode === "conservative"
          ? false
          : Boolean(item.ignoreOverflowReallocation),
    });

    if (resolved.mode === "equivalent") {
      equivalentBanks.push(resolved.plan.bankName);
    } else if (resolved.mode === "conservative") {
      conservativeBanks.push(resolved.plan.bankName);
    }
  }

  selections = restored;
  unallocatedCash = recoveredUnallocated;
  document.getElementById("unallocatedCash").value =
    formatInputMoney(unallocatedCash);

  try {
    LEGACY_STORAGE_KEYS.forEach(key => localStorage.removeItem(key));
  } catch {}

  saveState();

  const messages = [];
  if (equivalentBanks.length) {
    messages.push(
      `${equivalentBanks.join("、")} 已改用級距與利率相同的新版本方案`
    );
  }
  if (conservativeBanks.length) {
    messages.push(
      `${conservativeBanks.join("、")} 已改用保守的既有戶低利率方案，請確認資格`
    );
  }
  if (movedBanks.length) {
    messages.push(
      `${movedBanks.join("、")} 已無可用方案，原金額已移至待配置現金`
    );
  }

  if (messages.length) {
    setNotice(messages.join("；") + "。", "warning");
  } else if (sourceKey !== STORAGE_KEY) {
    setNotice("已將舊版配置安全升級至目前格式。", "info");
  }
}

function calculatePlanInterest(plan, balance) {
  let remaining = Math.max(0, balance);
  let annualInterest = 0;
  let knownPrincipal = 0;
  let unknownAmount = 0;
  let overAmount = 0;
  let postedOverflowAmount = 0;
  let postedOverflowInterest = 0;
  const allocations = [];

  for (const tier of plan.tiers) {
    if (remaining <= 0) break;

    if (tier.capacityMode === "finite") {
      const used = Math.min(remaining, tier.capacity);
      const interest = used * tier.rate / 100;
      annualInterest += interest;
      knownPrincipal += used;
      remaining -= used;
      if (tier.isTrailingPostedOverflow) {
        postedOverflowAmount += used;
        postedOverflowInterest += interest;
      }
      allocations.push({ tier, used, interest });
      continue;
    }

    if (tier.capacityMode === "unlimited") {
      const used = remaining;
      const interest = used * tier.rate / 100;
      annualInterest += interest;
      knownPrincipal += used;
      remaining = 0;
      if (tier.isTrailingPostedOverflow) {
        postedOverflowAmount += used;
        postedOverflowInterest += interest;
      }
      allocations.push({ tier, used, interest });
      break;
    }

    unknownAmount += remaining;
    allocations.push({ tier, used: remaining, interest: null });
    remaining = 0;
    break;
  }

  if (remaining > 0) overAmount += remaining;

  const complete = unknownAmount === 0 && overAmount === 0;
  const effectiveRate = knownPrincipal > 0
    ? annualInterest / knownPrincipal * 100
    : 0;
  const postedOverflowRate = postedOverflowAmount > 0
    ? postedOverflowInterest / postedOverflowAmount * 100
    : 0;

  return {
    balance,
    annualInterest,
    knownPrincipal,
    unknownAmount,
    overAmount,
    postedOverflowAmount,
    postedOverflowInterest,
    postedOverflowRate,
    complete,
    effectiveRate,
    allocations,
  };
}

function planStatus(plan, calculation) {
  const balance = calculation.balance;

  if (plan.hasPostedOverflow) {
    const promotionalRemaining = Math.max(
      0,
      plan.promotionalLimit - balance,
    );

    if (calculation.postedOverflowAmount > 0) {
      return {
        className: "is-over",
        title: `超出優惠額度 ${formatMoney(calculation.postedOverflowAmount)}`,
        detail: `超出部分目前按牌告約 ${formatRate(calculation.postedOverflowRate)} 計息。`,
        remaining: 0,
      };
    }

    if (promotionalRemaining === 0) {
      return {
        className: "is-maxed",
        title: "已剛好填滿優惠額度",
        detail: `已完整使用 ${formatMoney(plan.promotionalLimit)} 的促銷級距。`,
        remaining: 0,
      };
    }

    return {
      className: "is-available",
      title: `尚可存入 ${formatMoney(promotionalRemaining)}`,
      detail: "尚未進入促銷方案後方的牌告利率區段。",
      remaining: promotionalRemaining,
    };
  }

  if (plan.capacityMode === "finite") {
    const remaining = plan.finiteCapacity - balance;

    if (remaining === 0) {
      return {
        className: "is-maxed",
        title: "已剛好填滿方案級距",
        detail: `已完整使用 ${formatMoney(plan.finiteCapacity)} 的已知利率容量。`,
        remaining: 0,
      };
    }

    if (remaining < 0) {
      return {
        className: "is-over",
        title: `超出 ${formatMoney(Math.abs(remaining))}`,
        detail: "超出部分沒有可用的結構化利率資料。",
        remaining: 0,
      };
    }

    return {
      className: "is-available",
      title: `尚可存入 ${formatMoney(remaining)}`,
      detail: "新增本金會自動依序進入下一個利率級距。",
      remaining,
    };
  }

  if (plan.capacityMode === "unlimited") {
    return {
      className: "is-unlimited",
      title: plan.hasPromotionalTier
        ? "促銷方案沒有已知上限"
        : "此帳戶僅使用牌告／基本利率",
      detail: plan.hasPromotionalTier
        ? "最後一個促銷級距可繼續承接本金。"
        : "因沒有促銷級距，不會被標示為優惠超額。",
      remaining: null,
    };
  }

  const knownRemaining = Math.max(0, plan.finiteCapacity - balance);
  return {
    className: "is-unknown",
    title: "方案總額度未確認",
    detail: knownRemaining > 0
      ? `已知級距內尚可存入 ${formatMoney(knownRemaining)}；其後不自動估算。`
      : "目前本金已到達或超過可確認範圍，其後不自動估算。",
    remaining: knownRemaining,
  };
}

function renderTierBreakdown(plan, calculation) {
  return plan.tiers.map(tier => {
    const allocation = calculation.allocations.find(
      item => item.tier.index === tier.index
    );
    const used = allocation?.used || 0;

    return `
      <div class="allocator-tier-chip ${used > 0 ? "has-balance" : ""} ${tier.capacityMode} ${tier.isTrailingPostedOverflow ? "posted-overflow-tier" : ""}">
        <span>${escapeHtml(tier.displayLabel)}</span>
        <strong>${formatRate(tier.rate)}</strong>
        <small>${used > 0 ? `目前 ${formatMoney(used)}` : "目前未使用"}</small>
      </div>
    `;
  }).join("");
}

function interestLabel(calculation) {
  const overflowText = calculation.postedOverflowAmount > 0
    ? `；其中 ${formatMoney(calculation.postedOverflowAmount)} 為牌告超額`
    : "";

  if (calculation.complete) {
    return {
      title: formatMoney(calculation.annualInterest),
      detail: `有效年利率 ${formatRate(calculation.effectiveRate)}${overflowText}`,
    };
  }

  return {
    title: `已知部分 ${formatMoney(calculation.annualInterest)}`,
    detail: calculation.unknownAmount > 0
      ? `${formatMoney(calculation.unknownAmount)} 的額度或利率未確認${overflowText}`
      : `${formatMoney(calculation.overAmount)} 超出已知級距${overflowText}`,
  };
}

function renderOverflowControl(plan, selection, calculation) {
  if (!plan.hasPostedOverflow) return "";

  return `
    <label
      class="overflow-ignore-toggle"
      data-overflow-control
      ${calculation.postedOverflowAmount > 0 ? "" : "hidden"}
    >
      <input
        type="checkbox"
        data-ignore-overflow="${escapeHtml(plan.id)}"
        ${selection.ignoreOverflowReallocation ? "checked" : ""}
      >
      <span>
        <strong>保留此超額，不納入轉出建議</strong>
        <small>仍會顯示紅色超額與牌告利率，但待配置建議不會動用這筆錢。</small>
      </span>
    </label>
  `;
}

function renderSelections() {
  const wrapper = document.getElementById("allocatorRows");
  const empty = document.getElementById("allocatorEmpty");

  empty.hidden = selections.length > 0;

  wrapper.innerHTML = selections.map(selection => {
    const plan = plansById.get(selection.planId);
    const calculation = calculatePlanInterest(plan, selection.balance);
    const status = planStatus(plan, calculation);
    const interest = interestLabel(calculation);

    return `
      <article class="allocator-row plan-row ${status.className}" data-plan-id="${escapeHtml(plan.id)}">
        <div class="allocator-row-heading">
          <h3>${escapeHtml(plan.bankName)}</h3>
          <p>${escapeHtml(plan.label)}</p>
          <button class="allocator-remove" type="button" data-remove-plan="${escapeHtml(plan.id)}" aria-label="移除${escapeHtml(plan.bankName)}">移除</button>
        </div>

        <div class="allocator-rate-block">
          <span class="allocator-rate">最高 ${formatRate(plan.maxRate)}</span>
          ${rateBadge(plan.verified)}
          <small>${escapeHtml(tierRateSummary(plan))}</small>
        </div>

        <div class="allocator-capacity-block">
          <span>方案優惠容量</span>
          <strong>${escapeHtml(planCapacityLabel(plan))}</strong>
        </div>

        <label class="allocator-balance-field">
          <span>此帳戶總餘額</span>
          <div class="money-input-wrap">
            <span>NT$</span>
            <input
              type="text"
              inputmode="numeric"
              autocomplete="off"
              value="${formatInputMoney(selection.balance)}"
              data-balance-plan="${escapeHtml(plan.id)}"
            >
          </div>
        </label>

        <div class="allocator-status">
          <strong>${escapeHtml(status.title)}</strong>
          <span>${escapeHtml(status.detail)}</span>
        </div>

        <div class="allocator-interest-block">
          <span>預估一年利息</span>
          <strong>${escapeHtml(interest.title)}</strong>
          <small>${escapeHtml(interest.detail)}</small>
        </div>

        <a class="allocator-bank-detail" href="bank.html?bank=${encodeURIComponent(plan.bankSlug)}&plan=${planIndexFromId(plan.id)}">
          查看資格與完整方案
        </a>

        <div class="allocator-tier-breakdown">
          ${renderTierBreakdown(plan, calculation)}
        </div>

        ${renderOverflowControl(plan, selection, calculation)}
      </article>
    `;
  }).join("");

  wrapper.querySelectorAll("[data-balance-plan]").forEach(input => {
    input.addEventListener("input", event => {
      const selection = currentSelection(event.target.dataset.balancePlan);
      const plan = plansById.get(event.target.dataset.balancePlan);
      const row = event.target.closest(".allocator-row");
      if (!selection || !plan || !row) return;

      selection.balance = parseMoney(event.target.value);
      formatMoneyInputElement(event.target);
      refreshPlanRow(row, plan, selection);
      saveState();
      renderSummary();
      renderRecommendations();
    });
  });

  wrapper.querySelectorAll("[data-ignore-overflow]").forEach(input => {
    input.addEventListener("change", event => {
      const selection = currentSelection(event.target.dataset.ignoreOverflow);
      if (!selection) return;
      selection.ignoreOverflowReallocation = event.target.checked;
      saveState();
      renderRecommendations();
    });
  });

  wrapper.querySelectorAll("[data-remove-plan]").forEach(button => {
    button.addEventListener("click", () => {
      selections = selections.filter(
        selection => selection.planId !== button.dataset.removePlan
      );
      saveState();
      renderAll();
    });
  });
}

function refreshPlanRow(row, plan, selection) {
  const calculation = calculatePlanInterest(plan, selection.balance);
  const status = planStatus(plan, calculation);
  const interest = interestLabel(calculation);

  row.classList.remove(
    "is-unlimited",
    "is-unknown",
    "is-maxed",
    "is-over",
    "is-available",
  );
  row.classList.add(status.className);

  const statusTitle = row.querySelector(".allocator-status strong");
  const statusDetail = row.querySelector(".allocator-status span");
  const interestTitle = row.querySelector(".allocator-interest-block strong");
  const interestDetail = row.querySelector(".allocator-interest-block small");
  const breakdown = row.querySelector(".allocator-tier-breakdown");
  const overflowControl = row.querySelector("[data-overflow-control]");

  if (statusTitle) statusTitle.textContent = status.title;
  if (statusDetail) statusDetail.textContent = status.detail;
  if (interestTitle) interestTitle.textContent = interest.title;
  if (interestDetail) interestDetail.textContent = interest.detail;
  if (breakdown) breakdown.innerHTML = renderTierBreakdown(plan, calculation);
  if (overflowControl) {
    overflowControl.hidden = calculation.postedOverflowAmount <= 0;
  }
}

function calculateSummary() {
  let accountTotal = 0;
  let annualInterest = 0;
  let knownPrincipal = 0;
  let remainingTotal = 0;
  let overTotal = 0;
  let incompleteAccounts = 0;

  selections.forEach(selection => {
    const plan = plansById.get(selection.planId);
    const calculation = calculatePlanInterest(plan, selection.balance);
    const status = planStatus(plan, calculation);

    accountTotal += selection.balance;
    annualInterest += calculation.annualInterest;
    knownPrincipal += calculation.knownPrincipal;
    overTotal += calculation.overAmount;
    overTotal += calculation.postedOverflowAmount;

    if (!calculation.complete) incompleteAccounts += 1;
    if (Number.isFinite(status.remaining)) {
      remainingTotal += status.remaining;
    }
  });

  return {
    accountTotal,
    annualInterest,
    knownPrincipal,
    remainingTotal,
    overTotal,
    incompleteAccounts,
    grandTotal: accountTotal + unallocatedCash,
    effectiveRate: knownPrincipal > 0
      ? annualInterest / knownPrincipal * 100
      : 0,
  };
}

function renderSummary() {
  const summary = calculateSummary();

  document.getElementById("accountCashTotal").textContent =
    formatMoney(summary.accountTotal);
  document.getElementById("unallocatedCashSummary").textContent =
    formatMoney(unallocatedCash);
  document.getElementById("cashGrandTotal").textContent =
    formatMoney(summary.grandTotal);
  document.getElementById("annualInterestTotal").textContent =
    formatMoney(summary.annualInterest);
  document.getElementById("annualInterestNote").textContent =
    summary.incompleteAccounts
      ? `${summary.incompleteAccounts} 個帳戶只計已知部分`
      : "未計稅與複利";
  document.getElementById("portfolioEffectiveRate").textContent =
    formatRate(summary.effectiveRate);
  document.getElementById("remainingCapacityTotal").textContent =
    formatMoney(summary.remainingTotal);
  document.getElementById("overCapacityTotal").textContent =
    formatMoney(summary.overTotal);
}

function nextRecommendationSegment(plan, balance) {
  let remainingBalance = Math.max(0, balance);

  for (const tier of plan.recommendationTiers) {
    if (tier.capacityMode === "finite") {
      if (remainingBalance < tier.capacity) {
        return {
          plan,
          tier,
          available: tier.capacity - remainingBalance,
          rate: tier.rate,
        };
      }
      remainingBalance -= tier.capacity;
      continue;
    }

    if (tier.capacityMode === "unlimited") {
      return {
        plan,
        tier,
        available: Infinity,
        rate: tier.rate,
      };
    }

    return null;
  }

  return null;
}

function allocateMarginalPool({
  amount,
  virtualBalances,
  minimumRate = -Infinity,
  sourceLabel = "",
}) {
  let remaining = amount;
  const deposits = [];

  while (remaining > 0) {
    const candidates = selections
      .map(selection => {
        const plan = plansById.get(selection.planId);
        const balance = virtualBalances.get(plan.id) || 0;
        const segment = nextRecommendationSegment(plan, balance);
        if (!segment || segment.rate <= minimumRate + RATE_EPSILON) {
          return null;
        }
        return {
          ...segment,
          balance,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.rate !== a.rate) return b.rate - a.rate;
        if (a.plan.verified !== b.plan.verified) {
          return a.plan.verified ? -1 : 1;
        }
        return a.plan.bankName.localeCompare(b.plan.bankName, "zh-Hant");
      });

    const best = candidates[0];
    if (!best) break;

    const depositAmount = Number.isFinite(best.available)
      ? Math.min(remaining, best.available)
      : remaining;

    if (depositAmount <= 0) break;

    const targetBalance = best.balance + depositAmount;
    const addedInterest = depositAmount * best.rate / 100;

    deposits.push({
      type: "deposit",
      plan: best.plan,
      tier: best.tier,
      amount: depositAmount,
      rate: best.rate,
      targetBalance,
      addedInterest,
      sourceLabel,
    });

    virtualBalances.set(best.plan.id, targetBalance);
    remaining -= depositAmount;
  }

  return {
    deposits,
    allocated: amount - remaining,
    remaining,
  };
}

function overflowSources() {
  return selections
    .map(selection => {
      const plan = plansById.get(selection.planId);
      const calculation = calculatePlanInterest(plan, selection.balance);

      if (
        !plan.hasPostedOverflow ||
        calculation.postedOverflowAmount <= 0 ||
        selection.ignoreOverflowReallocation
      ) {
        return null;
      }

      return {
        plan,
        selection,
        amount: calculation.postedOverflowAmount,
        rate: calculation.postedOverflowRate,
        targetBalance: selection.balance - calculation.postedOverflowAmount,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.rate !== b.rate) return a.rate - b.rate;
      return a.plan.bankName.localeCompare(b.plan.bankName, "zh-Hant");
    });
}

function buildRecommendations() {
  const virtualBalances = new Map(
    selections.map(selection => [selection.planId, selection.balance])
  );

  const sourceOverflows = overflowSources();

  // Temporarily remove all eligible posted-rate overflow before testing
  // whether it can be moved to a higher currently available marginal tier.
  sourceOverflows.forEach(source => {
    virtualBalances.set(source.plan.id, source.targetBalance);
  });

  const actions = [];

  const unallocatedResult = allocateMarginalPool({
    amount: unallocatedCash,
    virtualBalances,
    sourceLabel: "待配置現金",
  });
  actions.push(...unallocatedResult.deposits);

  const retainedOverflow = [];

  sourceOverflows.forEach(source => {
    const result = allocateMarginalPool({
      amount: source.amount,
      virtualBalances,
      minimumRate: source.rate,
      sourceLabel: `由 ${source.plan.bankName} 牌告超額轉入`,
    });

    if (result.allocated > 0) {
      actions.push({
        type: "withdraw",
        plan: source.plan,
        amount: result.allocated,
        rate: source.rate,
        targetBalance: source.selection.balance - result.allocated,
      });
      actions.push(...result.deposits);
    }

    if (result.remaining > 0) {
      retainedOverflow.push({
        source,
        amount: result.remaining,
      });
      virtualBalances.set(
        source.plan.id,
        source.targetBalance + result.remaining,
      );
    }
  });

  return {
    actions,
    unassignedCash: unallocatedResult.remaining,
    retainedOverflow,
  };
}

function renderRecommendations() {
  const wrapper = document.getElementById("recommendationList");
  const empty = document.getElementById("recommendationEmpty");
  const unassigned = document.getElementById("unassignedCash");
  const result = buildRecommendations();

  empty.hidden = result.actions.length > 0;

  wrapper.innerHTML = result.actions.map((item, index) => {
    if (item.type === "withdraw") {
      return `
        <article class="recommendation-item plan-recommendation withdrawal-recommendation">
          <span class="recommendation-rank">−</span>
          <div class="recommendation-name">
            <strong>${escapeHtml(item.plan.bankName)}</strong>
            <span>${escapeHtml(item.plan.label)}｜牌告超額轉出</span>
          </div>
          <div class="recommendation-rate">
            <span>目前牌告利率</span>
            <strong>${formatRate(item.rate)}</strong>
          </div>
          <div class="recommendation-amount">
            <span>建議轉出</span>
            <strong>${signedMoney(-item.amount)}</strong>
          </div>
          <div class="recommendation-target">
            <span>轉出後帳戶餘額</span>
            <strong>${formatMoney(item.targetBalance)}</strong>
          </div>
          <div class="recommendation-interest">
            <span>用途</span>
            <strong>改放更高利率級距</strong>
          </div>
        </article>
      `;
    }

    return `
      <article class="recommendation-item plan-recommendation">
        <span class="recommendation-rank">${index + 1}</span>
        <div class="recommendation-name">
          <strong>${escapeHtml(item.plan.bankName)}</strong>
          <span>${escapeHtml(item.plan.label)}｜${escapeHtml(item.tier.displayLabel)}</span>
        </div>
        <div class="recommendation-rate">
          <span>下一段邊際利率</span>
          <strong>${formatRate(item.rate)}</strong>
        </div>
        <div class="recommendation-amount">
          <span>建議存入</span>
          <strong>${formatMoney(item.amount)}</strong>
        </div>
        <div class="recommendation-target">
          <span>配置後帳戶餘額</span>
          <strong>${formatMoney(item.targetBalance)}</strong>
        </div>
        <div class="recommendation-interest">
          <span>新增預估年息</span>
          <strong>${formatMoney(item.addedInterest)}</strong>
        </div>
        <div class="recommendation-tier-path">
          <span>${escapeHtml(item.sourceLabel)}</span>
          <span>${escapeHtml(item.tier.displayLabel)}：${formatMoney(item.amount)} × ${formatRate(item.rate)}</span>
        </div>
      </article>
    `;
  }).join("");

  const messages = [];

  if (result.unassignedCash > 0) {
    messages.push(
      `仍有 ${formatMoney(result.unassignedCash)} 待配置現金尚未分配。`
    );
  }

  result.retainedOverflow.forEach(item => {
    messages.push(
      `${item.source.plan.bankName} 仍保留 ${formatMoney(item.amount)} 牌告超額，因目前沒有更高利率的可用下一級距。`
    );
  });

  unassigned.hidden = messages.length === 0;
  unassigned.innerHTML = messages
    .map(message => `<div>${escapeHtml(message)}</div>`)
    .join("");
}

function renderAll() {
  renderSelections();
  renderSummary();
  renderRecommendations();
}

function addSelectedPlan() {
  const planId = document.getElementById("allocatorPlan").value;
  const plan = plansById.get(planId);
  if (!plan) return;

  const existingIndex = selections.findIndex(selection => {
    const existingPlan = plansById.get(selection.planId);
    return existingPlan?.bankSlug === plan.bankSlug;
  });

  if (existingIndex >= 0) {
    const previousPlan = plansById.get(selections[existingIndex].planId);

    if (previousPlan.id === plan.id) {
      setNotice("這個銀行方案已經在配置清單中。", "info");
      return;
    }

    selections.splice(existingIndex, 1, {
      planId: plan.id,
      balance: 0,
      ignoreOverflowReallocation: false,
    });
    setNotice(
      `已用「${plan.label}」取代 ${plan.bankName} 原本的「${previousPlan.label}」，原金額已清空。`,
      "warning",
    );
  } else {
    selections.push({
      planId: plan.id,
      balance: 0,
      ignoreOverflowReallocation: false,
    });
    setNotice("已加入銀行方案。", "success");
  }

  saveState();
  renderAll();
}


function planIndexFromId(planId) {
  const parts = String(planId).split("::");
  const index = Number(parts.at(-1));
  return Number.isInteger(index) && index >= 0 ? index : null;
}


function buildExportPayload() {
  const payload = {
    v: EXPORT_VERSION,
    d: report.report_date,
    s: selections.map(selection => {
      const plan = plansById.get(selection.planId);
      const record = [
        plan.bankSlug,
        planIndexFromId(plan.id),
        plan.fingerprint,
        plan.economicSignature,
        selection.balance,
      ];

      if (selection.ignoreOverflowReallocation) {
        record.push(1);
      }

      return record;
    }),
  };

  if (persistBalances) payload.p = 1;
  if (unallocatedCash > 0) payload.u = unallocatedCash;

  return payload;
}

function downloadAllocatorExport() {
  const payload = buildExportPayload();
  const json = JSON.stringify(payload);
  const blob = new Blob([json], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const date = report.report_date || new Date().toISOString().slice(0, 10);

  link.href = url;
  link.download = `cash-allocation-${date}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  setNotice(
    `已匯出 ${selections.length} 家銀行設定；檔案大小約 ${blob.size} bytes。`,
    "success",
  );
}

function parseImportRecord(record, version) {
  if (!Array.isArray(record)) {
    throw new Error("設定紀錄格式不正確。");
  }

  if (version === 1) {
    if (record.length < 4) {
      throw new Error("舊版設定紀錄格式不正確。");
    }

    const [bankSlug, planIndexValue, fingerprint, balanceValue, ignoreValue] =
      record;
    const planIndex = Number(planIndexValue);

    if (
      typeof bankSlug !== "string" ||
      !Number.isInteger(planIndex) ||
      planIndex < 0 ||
      typeof fingerprint !== "string"
    ) {
      throw new Error("舊版設定紀錄包含無效欄位。");
    }

    return {
      bankSlug,
      planId: `${bankSlug}::${planIndex}`,
      fingerprint,
      economicSignature: "",
      balance: parseMoney(balanceValue),
      ignoreOverflowReallocation: ignoreValue === 1,
    };
  }

  if (version !== EXPORT_VERSION || record.length < 5) {
    throw new Error("設定紀錄格式不正確。");
  }

  const [
    bankSlug,
    planIndexValue,
    fingerprint,
    economicSignature,
    balanceValue,
    ignoreValue,
  ] = record;
  const planIndex = Number(planIndexValue);

  if (
    typeof bankSlug !== "string" ||
    !Number.isInteger(planIndex) ||
    planIndex < 0 ||
    typeof fingerprint !== "string" ||
    typeof economicSignature !== "string"
  ) {
    throw new Error("設定紀錄包含無效欄位。");
  }

  return {
    bankSlug,
    planId: `${bankSlug}::${planIndex}`,
    fingerprint,
    economicSignature,
    balance: parseMoney(balanceValue),
    ignoreOverflowReallocation: ignoreValue === 1,
  };
}

function validateImportedPayload(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    ![1, EXPORT_VERSION].includes(payload.v) ||
    !Array.isArray(payload.s)
  ) {
    throw new Error("不支援或無效的匯出檔格式。");
  }

  const seenBanks = new Set();
  const importedSelections = [];
  const equivalentBanks = [];
  const conservativeBanks = [];
  const movedBanks = [];
  let recoveredUnallocated = parseMoney(payload.u);

  for (const rawRecord of payload.s) {
    const record = parseImportRecord(rawRecord, payload.v);

    if (seenBanks.has(record.bankSlug)) {
      throw new Error(`匯入檔重複包含銀行：${record.bankSlug}`);
    }
    seenBanks.add(record.bankSlug);

    const resolved = resolvePlanRecord(record);

    if (!resolved.plan) {
      recoveredUnallocated += record.balance;
      movedBanks.push(
        banksBySlug.get(record.bankSlug)?.name || record.bankSlug
      );
      continue;
    }

    importedSelections.push({
      planId: resolved.plan.id,
      balance: record.balance,
      ignoreOverflowReallocation:
        resolved.mode === "conservative"
          ? false
          : record.ignoreOverflowReallocation,
    });

    if (resolved.mode === "equivalent") {
      equivalentBanks.push(resolved.plan.bankName);
    } else if (resolved.mode === "conservative") {
      conservativeBanks.push(resolved.plan.bankName);
    }
  }

  return {
    selections: importedSelections,
    persistBalances: payload.p === 1,
    unallocatedCash: recoveredUnallocated,
    equivalentBanks,
    conservativeBanks,
    movedBanks,
  };
}

async function importAllocatorFile(file) {
  if (!file) return;

  let payload;

  try {
    const text = await file.text();

    if (text.length > 1024 * 1024) {
      throw new Error("設定檔異常過大；請確認選擇的是本工具匯出的JSON檔。");
    }

    payload = JSON.parse(text);
  } catch (error) {
    setNotice(
      `匯入失敗：${error?.message || "無法讀取JSON檔案。"}`,
      "warning",
    );
    return;
  }

  let imported;

  try {
    imported = validateImportedPayload(payload);
  } catch (error) {
    setNotice(`匯入失敗：${error.message}`, "warning");
    return;
  }

  if (
    !imported.selections.length &&
    imported.unallocatedCash <= 0 &&
    payload.s.length > 0
  ) {
    setNotice(
      "匯入檔沒有可安全還原的方案或金額，因此沒有取代目前設定。",
      "warning",
    );
    return;
  }

  selections = imported.selections;
  persistBalances = imported.persistBalances;
  unallocatedCash = imported.unallocatedCash;

  document.getElementById("persistBalances").checked = persistBalances;
  document.getElementById("unallocatedCash").value =
    formatInputMoney(unallocatedCash);

  saveState();
  renderAll();

  const messages = [
    `已匯入 ${imported.selections.length} 家銀行設定`,
  ];

  if (imported.equivalentBanks.length) {
    messages.push(
      `${imported.equivalentBanks.join("、")} 套用相同級距／利率的新版本方案`
    );
  }
  if (imported.conservativeBanks.length) {
    messages.push(
      `${imported.conservativeBanks.join("、")} 改用保守既有戶方案`
    );
  }
  if (imported.movedBanks.length) {
    messages.push(
      `${imported.movedBanks.join("、")} 的金額移至待配置現金`
    );
  }

  setNotice(
    messages.join("；") + "。",
    imported.equivalentBanks.length ||
    imported.conservativeBanks.length ||
    imported.movedBanks.length
      ? "warning"
      : "success",
  );
}


function applyRequestedBanks() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("banks");
  if (!raw) return;

  const requestedSlugs = [...new Set(
    raw.split(",").map(value => value.trim()).filter(Boolean)
  )];

  const existingBanks = new Set(
    selections
      .map(selection => plansById.get(selection.planId)?.bankSlug)
      .filter(Boolean)
  );
  const added = [];
  const unavailable = [];

  for (const slug of requestedSlugs) {
    if (existingBanks.has(slug)) continue;

    const plan = chooseConservativePlan(slug);
    if (!plan) {
      unavailable.push(banksBySlug.get(slug)?.name || slug);
      continue;
    }

    selections.push({
      planId: plan.id,
      balance: 0,
      ignoreOverflowReallocation: false,
    });
    existingBanks.add(slug);
    added.push(`${plan.bankName}（${plan.label}）`);
  }

  if (added.length || unavailable.length) {
    saveState();

    const messages = [];
    if (added.length) {
      messages.push(
        `已用保守的既有戶／最低利率方案加入：${added.join("、")}，請逐一確認`
      );
    }
    if (unavailable.length) {
      messages.push(`沒有可用方案：${unavailable.join("、")}`);
    }

    setNotice(
      messages.join("；") + "。",
      unavailable.length ? "warning" : "info",
    );
  }
}

function resetEverything() {
  const confirmed = window.confirm(
    "確定要清除所有銀行方案與已儲存金額嗎？"
  );
  if (!confirmed) return;

  try {
    localStorage.removeItem(STORAGE_KEY);
    LEGACY_STORAGE_KEYS.forEach(key => localStorage.removeItem(key));
  } catch {}

  selections = [];
  persistBalances = false;
  unallocatedCash = 0;
  document.getElementById("persistBalances").checked = false;
  document.getElementById("unallocatedCash").value = "0";
  setNotice("所有本機設定已清除。", "success");
  renderAll();
}

function bindControls() {
  document.getElementById("allocatorBank").addEventListener("change", event => {
    populatePlanSelect(event.target.value);
  });

  document.getElementById("allocatorPlan").addEventListener("change", event => {
    document.getElementById("addAllocatorPlan").disabled = !event.target.value;
  });

  document.getElementById("addAllocatorPlan").addEventListener(
    "click",
    addSelectedPlan,
  );

  document.getElementById("persistBalances").addEventListener("change", event => {
    persistBalances = event.target.checked;
    saveState();
    setNotice(
      persistBalances
        ? "各帳戶金額與待配置現金將儲存在此瀏覽器。"
        : "已停止儲存金額；銀行與方案選擇仍會保留。",
      persistBalances ? "success" : "info",
    );
  });

  document.getElementById("unallocatedCash").addEventListener("input", event => {
    unallocatedCash = parseMoney(event.target.value);
    formatMoneyInputElement(event.target);
    saveState();
    renderSummary();
    renderRecommendations();
  });

  document.getElementById("exportAllocator").addEventListener(
    "click",
    downloadAllocatorExport,
  );

  document.getElementById("importAllocator").addEventListener(
    "change",
    async event => {
      const file = event.target.files?.[0];
      await importAllocatorFile(file);
      event.target.value = "";
    },
  );

  document.getElementById("resetAllocator").addEventListener(
    "click",
    resetEverything,
  );
}

async function start() {
  const page = document.getElementById("allocatorPage");

  try {
    report = await loadReport();
    document.getElementById("allocatorReportDate").textContent =
      report.report_date;
    buildCatalog();
    populateBankSelect();
    bindControls();
    loadState();
    applyRequestedBanks();
    renderAll();
  } catch (error) {
    showPageError(page, error);
  }
}

start();
