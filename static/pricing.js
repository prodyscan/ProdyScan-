// ===============================
// PRICING ONLY SCRIPT
// ===============================

const BILLING_KEY = "aliscan_billing_v2";

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}

function getBilling() {
  try {
    return JSON.parse(localStorage.getItem(BILLING_KEY)) || {
      trialLeft: 5,
      packCredits: 0,
      packSaves: 0,
      aiPack: 0,
      aiMonthLimit: 5000,
      aiMonth: { ym: monthKey(), used: 0 },
      freeDay: { date: todayKey(), used: 0 },
      subUntil: 0,
      subPlan: ""
    };
  } catch {
    return {};
  }
}

function setBilling(b) {
  localStorage.setItem(BILLING_KEY, JSON.stringify(b));
}

function isSubActive(b) {
  return (b.subUntil || 0) > Date.now();
}

function refreshPricingUI() {
  const b = getBilling();
  const sub = isSubActive(b);

  const el = id => document.getElementById(id);

  if (el("st-plan"))
    el("st-plan").textContent = sub ? "PRO" : (b.trialLeft > 0 ? "ESSAI" : "FREE");

  if (el("st-trial"))
    el("st-trial").textContent = b.trialLeft || 0;

  if (el("st-packCredits"))
    el("st-packCredits").textContent = b.packCredits || 0;

  if (el("st-packSaves"))
    el("st-packSaves").textContent = b.packSaves || 0;

  if (el("st-aiLeft"))
    el("st-aiLeft").textContent =
      sub ? Math.max(0, b.aiMonthLimit - (b.aiMonth.used || 0))
          : (b.aiPack || 0);

  if (el("st-subUntil"))
    el("st-subUntil").textContent =
      sub ? new Date(b.subUntil).toLocaleDateString("fr-FR") : "—";
}

// ===============================
// ACTIONS
// ===============================

function buyPack100() {
  const b = getBilling();
  b.packCredits += 100;
  b.packSaves += 100;
  b.aiPack += 50;
  setBilling(b);
  refreshPricingUI();
}

function buyPack300() {
  const b = getBilling();
  b.packCredits += 300;
  b.packSaves += 300;
  b.aiPack += 120;
  setBilling(b);
  refreshPricingUI();
}

function activatePro(mode) {
  const b = getBilling();
  const now = Date.now();

  if (mode === "month") {
    b.subUntil = now + 30*24*60*60*1000;
    b.subPlan = "month";
    b.aiMonthLimit = 5000;
    b.aiMonth = { ym: monthKey(), used: 0 };
  }

  if (mode === "year") {
    b.subUntil = now + 365*24*60*60*1000;
    b.subPlan = "year";
    b.aiMonthLimit = 5000;
    b.aiMonth = { ym: monthKey(), used: 0 };
  }

  setBilling(b);
  refreshPricingUI();
}

function cancelPro() {
  const b = getBilling();
  b.subUntil = 0;
  b.subPlan = "";
  setBilling(b);
  refreshPricingUI();
}

document.addEventListener("DOMContentLoaded", () => {

  document.getElementById("buy-pack-10")?.addEventListener("click", buyPack100);
  document.getElementById("buy-pack-100")?.addEventListener("click", buyPack300);
  document.getElementById("buy-pro-month")?.addEventListener("click", () => activatePro("month"));
  document.getElementById("buy-pro-year")?.addEventListener("click", () => activatePro("year"));
  document.getElementById("cancel-pro")?.addEventListener("click", cancelPro);
  document.getElementById("pricing-refresh")?.addEventListener("click", refreshPricingUI);
  document.getElementById("pricing-reset")?.addEventListener("click", () => {
    localStorage.removeItem(BILLING_KEY);
    refreshPricingUI();
  });

  refreshPricingUI();
});
