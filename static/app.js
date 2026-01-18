// ==============================
// Aliscan  - app.js
// ==============================

// ===============================
// DEBUG GLOBAL (À METTRE TOUT EN HAUT)
// ===============================
// alert("✅ app.js chargé");

window.addEventListener("error", (e) => {
  alert("❌ JS ERROR : " + e.message + " (ligne " + e.lineno + ")");
});



// --------------------------------------------------
// 1) OUTILS GÉNÉRAUX
// --------------------------------------------------


function parseNumberInput(el) {
  if (!el) return 0;
  const raw = String(el.value || "")
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, ""); // enlève / et tout le reste
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}


function cleanText(value) {
  if (!value) return "";
  return String(value).replace(/\s+/g, " ").trim();
}
function extractFirstUrl(text) {
  const t = String(text || "");
  const m = t.match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0] : "";
}

function extractShopRatingFromSupplierBlock(text) {
  const t = String(text || "");

  // Cas Alibaba mobile : "... ans sur Alibaba.com ... ¥ 4.8"
  let m = t.match(/ans\s+sur\s+Alibaba\.com[\s\S]{0,80}?[¥Y]\s*([0-5](?:[.,]\d)?)/i);
  if (m) return parseFloat(String(m[1]).replace(",", "."));

  // Fallback : ligne fournisseur où on voit Alibaba.com + un 4.8
  m = t.match(/Alibaba\.com[\s\S]{0,80}?([0-5](?:[.,]\d)?)/i);
  if (m) return parseFloat(String(m[1]).replace(",", "."));

  return null;
}

// --------------------------------------------------
// OUTIL : calcul de similarité (Levenshtein simple)
// --------------------------------------------------
function similarity(a, b) {
  if (!a || !b) return 0;
  a = a.toLowerCase();
  b = b.toLowerCase();

  // si identique
  if (a === b) return 1;

  // distance Levenshtein
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
    if (i === 0) {
      for (let j = 0; j < a.length; j++) matrix[0][j] = j;
    }
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[j - 1] === b[i - 1] ? 0 : 1)
      );
    }
  }

  const dist = matrix[b.length][a.length];
  const maxLen = Math.max(a.length, b.length);
  return 1 - dist / maxLen;
}

// ==============================
// ALERTES LIMITÉES (max 5 fois)
// ==============================
const ALI_ALERT_KEY = "aliscan_alibaba_only_alert_count";

// ocr analyse en cours 
let OCR_LOGGER = null; // fonction mutable
let OCR_WORKER = null;
let _ocrWorker = null;
let _ocrProgressCb = null;
let _ocrRunId = 0; // ✅ identifiant de session OCR







function isProbablyAlibabaOcr(rawText) {
  const t = String(rawText || "").toLowerCase();

  // mots-clés Alibaba (FR/EN) + certifications
  const signals = [
    "alibaba",
    "trade assurance",
    "verified supplier",
    "verified",
    "fournisseur vérifié",
    "fournisseur verifie",
    "ans sur alibaba",
    "yrs on alibaba",
    "years on alibaba",

    // ✅ certifications (captures comme ton image)
    "certifications vérifiées",
    "certifications verifiees",
    "certification",
    "certificate",
    "certificate of conformity",
    "conformity",
    "ce",
    "rohs",
    "fcc",
    "iso"
  ];

  // on valide si on trouve au moins 1 signal fort
  return signals.some((k) => t.includes(k));
}


function limitedAlert(key, msg, max = 5) {
  const k = String(key || "limited_alert");
  let count = parseInt(localStorage.getItem(k) || "0", 10);
  if (count < max) {
    alert(msg);
    localStorage.setItem(k, String(count + 1));
  }
}


document.addEventListener("DOMContentLoaded", () => {
  // COST
  showCalcExportButtons(false, "cost");

  // MARGIN
  showCalcExportButtons(false, "margin");

  // OCR (sécurité)
  if (typeof updateOcrExportButtons === "function") {
    updateOcrExportButtons();
  }
});

const lastMargin = {
  costUnit: 0,
  saleUnit: 0,
  marginTotal: 0,
  marginRate: 0,
  currency: "XOF",
};

const lastSavedCalculation = {
  productName: "",
  supplierName: "",
  supplierLink: "",
  currency: "XOF",

  totalFinal: 0,

  costUnit: 0,
  saleUnit: 0,
  marginUnit: 0,
  marginTotal: 0,
  marginRate: 0,

  date: ""
};
// --------------------------------------------------
// 2) ANALYSE DE LIEN + HISTORIQUE LIENS
// --------------------------------------------------

// Champs principaux
const urlInput      = document.getElementById("url-input");
const analyseBtn    = document.getElementById("analyse-btn");
const loader        = document.getElementById("loader");
const errorText     = document.getElementById("error-text");

// ==============================
// OCR : lecture d'une capture
// ==============================
const ocrInput     = document.getElementById("ocr-input");
const ocrBtn       = document.getElementById("ocr-btn");
const ocrStatus    = document.getElementById("ocr-status");
const ocrRawEl     = document.getElementById("ocr-raw");
const ocrResumeEl  = document.getElementById("ocr-resume");
const toggleOcrBtn = document.getElementById("toggle-ocr-btn");
const input = document.getElementById("images-input");
const progressLabel = document.getElementById("progress-label"); // le texte "Lecture..."
const progressBar = document.getElementById("progress-bar");     // si tu as une barre

function setProgress(i, total, pct) {
  if (progressLabel) progressLabel.textContent = `⏳ Lecture... (${i}/${total}) - ${pct}%`;
  if (progressBar) progressBar.value = pct;
}

function resetProgress() {
  const total = input?.files?.length || 0;
  if (total > 0) setProgress(0, total, 0);
  else if (progressLabel) progressLabel.textContent = "";
  if (progressBar) progressBar.value = 0;
}

if (input) {
  input.addEventListener("change", resetProgress);
}
// ==============================
// Mini bouton Alibaba (toujours visible)
// ==============================
const MINI_ALI_KEY = "aliscan_last_alibaba_url";

function openAlibabaFallback() {
  const saved = localStorage.getItem(MINI_ALI_KEY) || "";
  const url = saved && saved.startsWith("http") ? saved : "https://www.alibaba.com/";
  window.open(url, "_blank", "noopener,noreferrer");
}

const miniAlibabaBtn = document.getElementById("mini-alibaba-btn");
if (miniAlibabaBtn) {
  miniAlibabaBtn.addEventListener("click", openAlibabaFallback);
}

// Dernière analyse OCR (pour pré-remplir l’enregistrement)
let lastOcrSnapshot = null;
// ==============================
// DEBUG OCR + Sécurité
// ==============================
function safeSetText(el, txt) {
  try { if (el) el.textContent = txt; } catch(e) {}
}


function safeShow(el) {
  try { if (el) el.hidden = false; } catch(e) {}
}
function safeHide(el) {
  try { if (el) el.hidden = true; } catch(e) {}
}

function ensureProAnimationsCss() {
  if (document.getElementById("pro-anim-css")) return;

  const style = document.createElement("style");
  style.id = "pro-anim-css";
  style.textContent = `
    #pro-card.pop { animation: popIn .35s ease-out; }
    #pro-badge.pulse { animation: pulse .6s ease-out; display:inline-block; }
    #pro-bar.bar-anim { animation: grow .6s ease-out; transform-origin: left; }

    @keyframes popIn {
      0% { transform: scale(.98); opacity: .6; }
      100% { transform: scale(1); opacity: 1; }
    }
    @keyframes pulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.06); }
      100% { transform: scale(1); }
    }
    @keyframes grow {
      0% { transform: scaleX(.6); }
      100% { transform: scaleX(1); }
    }
  `;
  document.head.appendChild(style);
}

function animateProBadge() {
  ensureProAnimationsCss();

  const card  = document.getElementById("pro-card");
  const badge = document.getElementById("pro-badge");
  const bar   = document.getElementById("pro-bar");

  // debug rapide (tu verras dans console si un id manque)
  console.log("ANIM targets:", { card: !!card, badge: !!badge, bar: !!bar });

  // relance propre
  if (card) card.classList.remove("pop");
  if (badge) badge.classList.remove("pulse");
  if (bar) bar.classList.remove("bar-anim");

  // IMPORTANT: lancer après affichage (sinon pas d’anim)
  requestAnimationFrame(() => {
    if (card) card.classList.add("pop");
    if (badge) badge.classList.add("pulse");
    if (bar) bar.classList.add("bar-anim");
  });
}

function resetOcrUI() {
  // 1) cacher la carte résultat (pro-card)
  const proCard = document.getElementById("pro-card");
  if (proCard) proCard.hidden = true;

  // 2) vider les textes résultat / brut
  if (typeof safeSetText === "function") {
    safeSetText(ocrResumeEl, "");
    safeSetText(ocrRawEl, "");
    safeSetText(ocrStatus, "");
  } else {
    if (ocrResumeEl) ocrResumeEl.textContent = "";
    if (ocrRawEl) ocrRawEl.textContent = "";
    if (ocrStatus) ocrStatus.textContent = "";
  }

  // 3) cacher le texte brut + bouton toggle
  if (typeof safeHide === "function") {
    safeHide(ocrRawEl);
    safeHide(toggleOcrBtn);
  } else {
    if (ocrRawEl) ocrRawEl.hidden = true;
    if (toggleOcrBtn) toggleOcrBtn.hidden = true;
  }

  // 4) vider le sélecteur de fichiers (important sinon il garde 3 fichiers)
  if (ocrInput) ocrInput.value = "";

  // 5) vider lien + notes du bloc save (si présents)
  if (ocrLinkInput) ocrLinkInput.value = "";
  if (ocrNotesInput) ocrNotesInput.value = "";

  // 6) masquer le bloc “Enregistrer”
  setSaveSectionVisible(false);

  // 7) reset snapshot
  window.lastOcrSnapshot = null;

  // 8) optionnel: remettre le texte du bouton toggle si tu veux
  if (toggleOcrBtn) toggleOcrBtn.textContent = "📄 Voir le texte brut";
}
 

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("button, a").forEach((el) => {
    el.addEventListener("click", () => {
      closeRecipientModal();
    });
  });
});



// ==============================
// 💳 PAYWALL V2 (Billing v2)
// - Essai 1 fois : 25 analyses (save/export OK+ IA)
// - Après essai : 3 analyses / jour (save/export OFF)
// - Packs cumulables : 100 (500 FCFA) / 300 (1000 FCFA)
// - Abonnements : 2000/mois illimité, 20000/an illimité+IA: 600/ans
// ==============================

const BILLING_KEY = "aliscan_billing_v2";
const PLAN_KEY = "aliscan_plan";
const OCR_USED_KEY = "aliscan_ocr_used";
const CREDITS_KEY = "aliscan_credits";

const TRIAL_KEY = "aliscan_trial_left";
const DAILY_FREE_KEY = "aliscan_daily_free_left";
const DAILY_FREE_DATE_KEY = "aliscan_daily_free_date";

// trial key
// essais gratuits (save+export)


function initPlan() {
  if (!localStorage.getItem(PLAN_KEY)) localStorage.setItem(PLAN_KEY, "free");
  if (!localStorage.getItem(OCR_USED_KEY)) localStorage.setItem(OCR_USED_KEY, "0");
  if (!localStorage.getItem(CREDITS_KEY)) localStorage.setItem(CREDITS_KEY, "0");

  if (!localStorage.getItem(TRIAL_KEY)) localStorage.setItem(TRIAL_KEY, "5"); // ✅ 5 essais
  resetDailyFreeIfNeeded();
}
initPlan();

function getTrialLeft() {
  return parseInt(localStorage.getItem(TRIAL_KEY) || "0", 10) || 0;
}
function decTrial() {
  localStorage.setItem(TRIAL_KEY, String(Math.max(0, getTrialLeft() - 1)));
}

// ✅ 3 gratuits/jour (sans save/export)
function resetDailyFreeIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  const last = localStorage.getItem(DAILY_FREE_DATE_KEY);
  if (last !== today) {
    localStorage.setItem(DAILY_FREE_DATE_KEY, today);
    localStorage.setItem(DAILY_FREE_KEY, "3");
  }
}
function getDailyFreeLeft() {
  resetDailyFreeIfNeeded();
  return parseInt(localStorage.getItem(DAILY_FREE_KEY) || "0", 10) || 0;
}
function decDailyFree() {
  resetDailyFreeIfNeeded();
  localStorage.setItem(DAILY_FREE_KEY, String(Math.max(0, getDailyFreeLeft() - 1)));
}

// ===== BILLING V2 (simple) =====


function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

const TRIAL_MAX = 25;
function getBilling() {
  try {
    const b = JSON.parse(localStorage.getItem(BILLING_KEY) || "{}");

    return {
      // ===== CORE =====
      trialLeft: Number(b.trialLeft ?? TRIAL_MAX),         // 5 essais (save + export)
      packCredits: Number(b.packCredits ?? 0),      // crédits analyses (packs)
      packSaves: Number(b.packSaves ?? 0),          // sauvegardes (packs)

      // ===== IA =====
      aiPack: Number(b.aiPack ?? 0),                // crédits IA achetés
      aiTrialOnce: 0, // désactivé → essai commun via trialLeft

      aiFreeDay: b.aiFreeDay && b.aiFreeDay.date
        ? b.aiFreeDay
        : { date: todayKey(), used: 0 },            // 5 IA / jour (gratuit)

      aiMonth: b.aiMonth && b.aiMonth.ym
        ? b.aiMonth
        : { ym: monthKey(), used: 0 },              // quota IA mensuel PRO

      aiYear: b.aiYear && b.aiYear.y
        ? b.aiYear
        : { y: new Date().getFullYear(), used: 0 }, // quota IA annuel (optionnel)

      // ===== ABONNEMENT =====
      subUntil: Number(b.subUntil ?? 0),            // timestamp fin abonnement
      subPlan: String(b.subPlan ?? ""),             // "month" | "year" | ""

      // ===== GRATUIT / JOUR =====
      freeDay: b.freeDay && b.freeDay.date
        ? b.freeDay
        : { date: todayKey(), used: 0 },            // 3 analyses / jour
    };

  } catch {
    // ===== FALLBACK SÉCURITÉ =====
    return {
      trialLeft: TRIAL_MAX,
      packCredits: 0,
      packSaves: 0,

      aiPack: 0,
      aiTrialOnce: 20,
      aiFreeDay: { date: todayKey(), used: 0 },
      aiMonth: { ym: monthKey(), used: 0 },
      aiYear: { y: new Date().getFullYear(), used: 0 },

      subUntil: 0,
      subPlan: "",

      freeDay: { date: todayKey(), used: 0 },
    };
  }
}

function setBilling(b) {
  localStorage.setItem(BILLING_KEY, JSON.stringify(b));
}

function isSubActive(b) {
  return (b?.subUntil || 0) > Date.now();
}

// 3 analyses gratuites / jour (après essai)
function getFreeRemaining(b) {
  const t = todayKey();
  if (!b.freeDay || b.freeDay.date !== t) {
    b.freeDay = { date: t, used: 0 };
  }
  return Math.max(0, 3 - Number(b.freeDay.used || 0));
}
function consumeFree(b) {
  const left = getFreeRemaining(b);
  if (left <= 0) return false;
  b.freeDay.used = Number(b.freeDay.used || 0) + 1;
  return true;
}


function activatePack(n) {
  const b = getBilling();
  b.packCredits = (b.packCredits || 0) + n;
  b.packSaves   = (b.packSaves   || 0) + n;
  setBilling(b);
}

function activatePro(plan) {
  const b = getBilling();
  const now = Date.now();

  b.subPlan = plan; // "month" | "year"
  const days = (plan === "year") ? 365 : 30;

  // IMPORTANT : on remplace, pas de cumul
  b.subUntil = now + days * 24 * 60 * 60 * 1000;

  setBilling(b);
}

function cancelPro() {
  const b = getBilling();
  b.subUntil = 0;
  b.subPlan = "";
  setBilling(b);
  if (typeof toast === "function") toast("✅ Abonnement Pro désactivé");
}

// ==============================
// SAVE / EXPORT (Billing V2 propre)
// ==============================
function canSaveAndExport() {
  const b = getBilling();
  if (isSubActive(b)) return { ok: true, mode: "sub" };          // Pro
  if ((b.packSaves || 0) > 0) return { ok: true, mode: "pack" }; // Packs
  if ((b.trialLeft || 0) > 0) return { ok: true, mode: "trial" };// Essai
  return { ok: false, reason: "locked" };
}

function consumeSaveExport(mode) {
  const b = getBilling();

  if (mode === "sub") return true;

  if (mode === "pack") {
    if ((b.packSaves || 0) <= 0) return false;
    b.packSaves -= 1;
    setBilling(b);
    return true;
  }

  if (mode === "trial") {
    if ((b.trialLeft || 0) <= 0) return false;
    b.trialLeft -= 1;
    setBilling(b);
    return true;
  }

  return false;
}

// ✅ Export OCR autorisé ?
function canExportOcrNow() {
  const s = canSaveAndExport();
  if (s.ok) return true;
  // optionnel : autoriser export si analyse PRO/PACK/TRIAL a eu lieu
  if (window.lastOcrSnapshot && window.lastOcrSnapshot._exportAllowed === true) return true;
  return false;
}

/*function canUseSaveExport() {
if (isPro()) return { ok: true, mode: "pro" };
const credits = getCredits();
if (credits > 0) return { ok: true, mode: "pack" };
if (getTrialLeft() > 0) return { ok: true, mode: "trial" }; // ✅ essais gratuits
return { ok: false, reason: "locked" };
}

function consumeSaveExport(mode) {
if (mode === "pack") setCredits(getCredits() - 1);
else if (mode === "trial") decTrial();
}*/


function canUseOcr() {
  const b = getBilling();

  if (isSubActive(b)) return { ok: true, mode: "sub" };   // IMPORTANT: "sub"
  if ((b.trialLeft || 0) > 0) return { ok: true, mode: "trial" };
  if ((b.packCredits || 0) > 0) return { ok: true, mode: "pack" };

  const freeLeft = getFreeRemaining(b);
  if (freeLeft > 0) return { ok: true, mode: "free" };

  return { ok: false, reason: "limit" };
}

function consumeOcr() {
  const b = getBilling();

  if (isSubActive(b)) {
    setBilling(b);
    return { ok: true, mode: "sub" };
  }

  if ((b.trialLeft || 0) > 0) {
    b.trialLeft -= 1;
    setBilling(b);
    return { ok: true, mode: "trial" };
  }

  if ((b.packCredits || 0) > 0) {
    b.packCredits -= 1;
    setBilling(b);
    return { ok: true, mode: "pack" };
  }

  const freeLeft = getFreeRemaining(b);
  if (freeLeft > 0) {
    b.freeDay.used = (b.freeDay.used || 0) + 1;
    setBilling(b);
    return { ok: true, mode: "free" };
  }

  setBilling(b);
  return { ok: false, reason: "limit" };
}


// ia 
function monthKey(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}

// 5 réponses IA / jour (optionnel)
function getAiDailyRemaining(b){
  const t = todayKey();
  if (!b.aiFreeDay || b.aiFreeDay.date !== t) b.aiFreeDay = { date: t, used: 0 };
  return Math.max(0, 5 - Number(b.aiFreeDay.used || 0));
}

// quota mensuel PRO (ex: 300/mois)
function getAiMonthRemaining(b){
  const ym = monthKey();
  const limit = 300; // ✅ ton quota pro mensuel
  if (!b.aiMonth || b.aiMonth.ym !== ym) b.aiMonth = { ym, used: 0 };
  return Math.max(0, limit - Number(b.aiMonth.used || 0));
}

function canUseAI(){
  const b = getBilling();

  // PRO actif => quota mensuel
  if (isSubActive(b)) {
    const left = getAiMonthRemaining(b);
    if (left > 0) return { ok: true, mode: "sub", left };
    return { ok: false, reason: "sub_limit" };
  }

  // crédits IA achetés
  if ((b.aiPack || 0) > 0) return { ok: true, mode: "pack", left: b.aiPack };

  // ✅ ESSAI = quota commun
  if ((b.trialLeft || 0) > 0) return { ok: true, mode: "trial", left: b.trialLeft };

  // essai quotidien 5/jour (si tu veux garder)
  const daily = getAiDailyRemaining(b);
  if (daily > 0) return { ok: true, mode: "daily", left: daily };

  return { ok: false, reason: "limit" };
}

function consumeAI(){
  const b = getBilling();

  // PRO actif => décrémente le mois
  if (isSubActive(b)) {
    if (getAiMonthRemaining(b) <= 0) return { ok:false, reason:"sub_limit" };
    b.aiMonth.used = Number(b.aiMonth.used || 0) + 1;
    setBilling(b);
    return { ok:true, mode:"sub" };
  }

  if ((b.aiPack || 0) > 0) {
    b.aiPack -= 1;
    setBilling(b);
    return { ok:true, mode:"pack" };
  }

  if ((b.trialLeft || 0) > 0) {
    b.trialLeft -= 1;
    setBilling(b);
    return { ok:true, mode:"trial" };
  }
  
  
  const daily = getAiDailyRemaining(b);
  if (daily > 0) {
    b.aiFreeDay.used = Number(b.aiFreeDay.used || 0) + 1;
    setBilling(b);
    return { ok:true, mode:"daily" };
  }

  setBilling(b);
  return { ok:false, reason:"limit" };
}

window.getBilling = getBilling;
window.setBilling = setBilling;
window.canUseAI = canUseAI;
window.consumeAI = consumeAI;

// ✅ Message paywall (affiche aussi ce qu’il reste)
function paywallMsg() {
  const b = getBilling();
  const freeLeft = getFreeRemaining(b);

  const parts = [];
  parts.push("❌ Limite atteinte.");

  // infos restantes
  parts.push(`Essai restant : ${b.trialLeft || 0}/${TRIAL_MAX}`);
  parts.push(`IA (essai) restant : ${b.trialLeft || 0}`);
  parts.push(`Pack restant : ${b.packCredits || 0} analyse(s)`);
  parts.push(`Gratuit/jour restant : ${freeLeft}/3`);
  parts.push(`IA pack restant : ${b.aiPack || 0} réponse(s)`);

  // offres
  parts.push("");
  parts.push("✅ Packs :");
  parts.push("• 500 FCFA → 100 analyses + 100 enregistrements + 50 réponses IA + export PDF/Excel");
  parts.push("• 1000 FCFA → 300 analyses + 300 enregistrements + 120 réponses IA + export PDF/Excel");
  parts.push("");
  parts.push("✅ Abonnements :");
  parts.push("• 2000 FCFA / mois → illimité (analyse + save + export) + IA : 300 réponses / mois");
  parts.push("• 20 000 FCFA / an → illimité (analyse + save + export) + IA : 4000 réponses / an");

  return parts.join("\n");
}






function askRecipient() {
  return new Promise((resolve) => {
    const choice = prompt(
      "Acheter le pack pour qui ?\n\n1 = Moi\n2 = Ami",
      "1"
    );

    resolve(choice === "2" ? "friend" : "self");
  });
}

async function buyPack(amount) {
  const who = await askRecipient();

  if (who === "friend") {
    toast(`🎁 Pack ${amount} payé pour un ami`);
    return;
  }

  const b = getBilling();

  // packs analyses & saves
  b.packCredits = (b.packCredits || 0) + amount;
  b.packSaves   = (b.packSaves || 0) + amount;

  // ✅ AJOUT IA
  if (amount === 100) {        // Pack 500 FCFA
    b.aiPack = (b.aiPack || 0) + 50;
  } else if (amount === 300) { // Pack 1000 FCFA
    b.aiPack = (b.aiPack || 0) + 120;
  }

  setBilling(b);

  toast(`✅ Pack ${amount} ajouté à votre compte`);
  refreshPricingUI();
}
// ------------------------------
// API simple pour tests (comme ton window.Paywall)
// ------------------------------
window.Paywall = {
  status() {
    const b = getBilling();
    return {
      trialLeft: b.trialLeft,
      packCredits: b.packCredits,
      packSaves: b.packSaves,
      freeLeftToday: getFreeRemaining(b),
      subActive: isSubActive(b),
      subUntil: b.subUntil
    };
  },

  resetAll() { 
    localStorage.removeItem(BILLING_KEY);
    alert("Paywall reset");
  },

  // Packs (cumulables)
  addPack500() {
    const b = getBilling();
    b.packCredits = (b.packCredits || 0) + 100;
    b.packSaves = (b.packSaves || 0) + 100;
    setBilling(b);
    alert("✅ Pack 500 ajouté. Credits=" + b.packCredits);
  },
  addPack1000() {
    const b = getBilling();
    b.packCredits = (b.packCredits || 0) + 300;
    b.packSaves = (b.packSaves || 0) + 300;
    setBilling(b);
    alert("✅ Pack 1000 ajouté. Credits=" + b.packCredits);
  },

  // Abonnements (prolonge si déjà actif)
  subMonthly() {
    const b = getBilling();
    const now = Date.now();
    const base = Math.max(now, b.subUntil || 0);
    b.subUntil = base + 30 * 24 * 60 * 60 * 1000;
    setBilling(b);
    alert("✅ Abonnement mensuel activé");
  },
  subYearly() {
    const b = getBilling();
    const now = Date.now();
    const base = Math.max(now, b.subUntil || 0);
    b.subUntil = base + 365 * 24 * 60 * 60 * 1000;
    setBilling(b);
    alert("✅ Abonnement annuel activé");
  }
};



// Init paywall
function initPlan() {
  if (!localStorage.getItem(PLAN_KEY))     localStorage.setItem(PLAN_KEY, "free");
  if (!localStorage.getItem(OCR_USED_KEY)) localStorage.setItem(OCR_USED_KEY, "0");
  if (!localStorage.getItem(CREDITS_KEY))  localStorage.setItem(CREDITS_KEY, "0");
}
initPlan();




        

// bouton close pack pour ami
function closeRecipientModal() {
  const modal = document.getElementById("recipient-modal");
  if (modal) modal.hidden = true;
}

// ==============================
// PRICING (VERSION UNIQUE, PROPRE)
// ==============================

// Badge abonnement
function setActiveBadge(active) {
  ["free", "trial", "pro"].forEach((k) => {
    const el = document.getElementById("badge-" + k);
    if (el) el.hidden = (k !== active);
  });
}

// --- UI uniquement (AUCUN onclick ici) ---
function refreshPricingUI() {
  const b = getBilling();
  const sub = isSubActive(b);
  const freeLeft = getFreeRemaining(b);

  // BADGE
  if (sub) setActiveBadge("pro");
  else if ((b.trialLeft || 0) > 0) setActiveBadge("trial");
  else setActiveBadge("free");

  // TEXTES
  const planLabel = sub ? "PRO" : ((b.trialLeft || 0) > 0 ? "ESSAI" : "FREE");
  const subType = sub ? (b.subPlan === "year" ? "Annuel" : "Mensuel") : "—";

  const el = (id) => document.getElementById(id);

  if (el("st-plan")) el("st-plan").textContent = planLabel;
  if (el("st-subType")) el("st-subType").textContent = subType;

  if (el("st-trial")) el("st-trial").textContent = String(b.trialLeft || 0);
  if (el("st-packCredits")) el("st-packCredits").textContent = String(b.packCredits || 0);
  if (el("st-packSaves")) el("st-packSaves").textContent = String(b.packSaves || 0);
  // 🔥 UI logique ESSAI (robuste)
  const hideLine = (id, hide) => {
    const node = el(id);
    if (!node) return;

    // on tente plusieurs parents possibles
    const line =
      node.closest(".stat-line") ||
      node.closest(".stat") ||
      node.closest(".row") ||
      node.closest("li") ||
      node.parentElement;

    if (line) line.classList.toggle("hidden", !!hide);
  };

  const trialActive = (b.trialLeft || 0) > 0;

  const aiLine = document.getElementById("st-aiLeft")?.closest(".stat-line") 
              || document.getElementById("st-aiLeft")?.parentElement;
  if (aiLine) aiLine.hidden = trialActive;

  // (optionnel) tu peux aussi masquer Free/jour
  const freeLine = document.getElementById("st-freeLeft")?.closest(".stat-line")
                || document.getElementById("st-freeLeft")?.parentElement;
  if (freeLine) freeLine.hidden = trialActive;
  
  // ===== IA restantes =====
  const ai = canUseAI(); // { ok, mode, left }

  if (el("st-aiLeft")) {
    let label = "";

    if (ai.ok) {
      switch (ai.mode) {
        case "sub":
          label = " / mois";
          break;
        case "pack":
          label = " (pack)";
          break;
        case "trial":
          label = " (essai)";
          break;
        case "daily":
          label = " / jour";
          break;
        default:
          label = "";
      }
    }

    el("st-aiLeft").textContent =
      ai.ok
        ? `${ai.left ?? 0}${label}`
        : "0";
  }

// ===== Date fin abonnement =====
if (el("st-subUntil")) {
  el("st-subUntil").textContent = sub
    ? new Date(b.subUntil).toLocaleDateString("fr-FR")
    : "—";
}

  // BOUTONS (état/texte seulement)
  const btnM = el("buy-pro-month");
  const btnY = el("buy-pro-year");
  const btnCancel = el("cancel-pro");

  if (btnM) {
    const active = sub && b.subPlan === "month";
    btnM.textContent = active
      ? "✅ Pro mensuel actif"
      : (sub ? "Passer en Mensuel — 2000 FCFA/mois" : "Activer Mensuel — 2000 FCFA/mois");
    btnM.disabled = false;
    btnM.classList.toggle("btn-active", active);
  }

  if (btnY) {
    const active = sub && b.subPlan === "year";
    btnY.textContent = active
      ? "✅ Pro annuel actif"
      : (sub ? "Passer en Annuel — 20 000 FCFA/an" : "Activer Annuel — 20 000 FCFA/an");
    btnY.disabled = false;
    btnY.classList.toggle("btn-active", active);
  }

  if (btnCancel) {
    btnCancel.hidden = !sub; // ✅ permet de revenir en gratuit
  }

  setBilling(b); // persist reset freeDay si date a changé
}

// --- Modal (Moi / Ami) ---
// ⚠️ Il faut que le HTML existe (ton <div id="recipient-modal"> ...)
/*function askRecipient() {
  return new Promise((resolve) => {
    const modal = document.getElementById("recipient-modal");
    const btnSelf = document.getElementById("recipient-self");
    const btnFriend = document.getElementById("recipient-friend");

    // si le modal n'existe pas, fallback simple
    if (!modal || !btnSelf || !btnFriend) {
      const ok = confirm("Acheter le pack pour :\n\nOK = Moi\nAnnuler = Ami");
      resolve(ok ? "self" : "friend");
      return;
    }

    modal.hidden = false;

    const cleanup = () => {
      modal.hidden = true;
      btnSelf.onclick = null;
      btnFriend.onclick = null;
    };

    btnSelf.onclick = () => { cleanup(); resolve("self"); };
    btnFriend.onclick = () => { cleanup(); resolve("friend"); };
  });
}*/
function askRecipient() {
  return new Promise((resolve) => {
    const modal = document.getElementById("recipient-modal");
    const btnSelf = document.getElementById("recipient-self");
    const btnFriend = document.getElementById("recipient-friend");

    // sécurité
    if (!modal || !btnSelf || !btnFriend) {
      const ok = confirm("Pack pour qui ?\n\nOK = Moi\nAnnuler = Ami");
      return resolve(ok ? "self" : "friend");
    }

    modal.hidden = false;

    const finish = (value) => {
      modal.hidden = true;
      btnSelf.onclick = null;
      btnFriend.onclick = null;
      modal.onclick = null;
      resolve(value);
    };

    btnSelf.onclick = () => finish("self");
    btnFriend.onclick = () => finish("friend");

    // clic en dehors = fermeture
    modal.onclick = (e) => {
      if (e.target === modal) finish("friend");
    };
  });
}

async function buyPack(amount) {
  /*const who = await askRecipient();

  if (who === "friend") {
    if (typeof toast === "function") toast(`🎁 Pack ${amount} payé pour un ami`);
    return;
  }*/

  const b = getBilling();
  b.packCredits = (Number(b.packCredits) || 0) + amount;
  b.packSaves   = (Number(b.packSaves) || 0) + amount;
  // ✅ IA pack (ex: amount=100 => 50 réponses, amount=300 => 120)
if (amount === 100) b.aiPack = (b.aiPack || 0) + 50;
if (amount === 300) b.aiPack = (b.aiPack || 0) + 120;
  setBilling(b);

  if (typeof toast === "function") toast(`✅ Pack ${amount} ajouté à votre compte`);
  refreshPricingUI();
}

// --- Bind des clics (UNE SEULE FOIS) ---
function bindPricingButtons() {
  const btnPack100  = document.getElementById("buy-pack-10");
  const btnPack300 = document.getElementById("buy-pack-100");
  const btnProM    = document.getElementById("buy-pro-month");
  const btnProY    = document.getElementById("buy-pro-year");
  const btnCancel  = document.getElementById("cancel-pro");
  const btnRefresh = document.getElementById("pricing-refresh");
  const btnReset   = document.getElementById("pricing-reset");

  if (btnPack100)  btnPack100.onclick  = () => buyPack(100);
  if (btnPack300) btnPack300.onclick = () => buyPack(300);

  // switch possible (annuel <-> mensuel)
  if (btnProM) btnProM.onclick = () => {
    activatePro("month");
    if (typeof toast === "function") toast("✅ Pro mensuel activé");
    refreshPricingUI();
  };

  if (btnProY) btnProY.onclick = () => {
    activatePro("year");
    if (typeof toast === "function") toast("✅ Pro annuel activé");
    refreshPricingUI();
  };

  // revenir en gratuit
  if (btnCancel) btnCancel.onclick = () => {
    cancelPro();
    if (typeof toast === "function") toast("✅ Retour au gratuit");
    refreshPricingUI();
  };

  if (btnRefresh) btnRefresh.onclick = () => refreshPricingUI();

  // Reset test
  if (btnReset) btnReset.onclick = () => {
    localStorage.removeItem("aliscan_billing_v2");
    if (typeof toast === "function") toast("♻️ Reset OK");
    refreshPricingUI();
  };
}

document.addEventListener("DOMContentLoaded", () => {
  bindPricingButtons();
  refreshPricingUI();
});

function getFreeUsed() {
  return parseInt(localStorage.getItem(OCR_USED_KEY) || "0", 10) || 0;
}
function incFreeUsed() {
  localStorage.setItem(OCR_USED_KEY, String(getFreeUsed() + 1));
}

// ===============================
// EXPORT OCR - VISIBILITÉ BOUTONS
// ===============================

// Cache les boutons Export PDF et Export Excel
// ➜ Avant analyse ou si export non autorisé
function hideOcrExportButtons() {
  const pdfBtn = document.getElementById("ocr-export-pdf-btn");
  const xlsBtn = document.getElementById("ocr-export-xls-btn");

  if (pdfBtn) pdfBtn.hidden = true;
  if (xlsBtn) xlsBtn.hidden = true;
}

// Affiche les boutons Export PDF et Export Excel
// ➜ Après analyse OK si export autorisé
function showOcrExportButtons() {
  const pdfBtn = document.getElementById("ocr-export-pdf-btn");
  const xlsBtn = document.getElementById("ocr-export-xls-btn");

  if (pdfBtn) pdfBtn.hidden = false;
  if (xlsBtn) xlsBtn.hidden = false;
}

function updateOcrExportButtons() {
  // par défaut : cacher
  hideOcrExportButtons();

  // si pas d'analyse -> on laisse caché
  if (!window.lastOcrSnapshot) return;

  // si export autorisé -> afficher
  if (canExportOcrNow()) showOcrExportButtons();
}

function setCalcActionsRowVisible(prefix, show) {
  const row = document.getElementById(`${prefix}-actions`);
  if (row) row.hidden = !show;
}

// ==============================
// 📄 EXPORT (PDF + EXCEL) — Analyse fournisseur
// ==============================

// Affiche/masque les boutons export
function showExportButtons(show) {
  const pdfBtn = document.getElementById("ocr-export-pdf-btn");
  const xlsBtn = document.getElementById("ocr-export-xls-btn");
  if (pdfBtn) pdfBtn.hidden = !show;
  if (xlsBtn) xlsBtn.hidden = !show;
}

// ✅ PDF (sans texte brut, titre sans OCR) — VERSION DESIGN PRO
function exportAnalysisToPDF(snapshot) {
  if (!canExportOcrNow()) {
    toast("🔒 Export réservé (pack ou abonnement).");
    return;
  }

  if (!snapshot) {
    toast("Aucune analyse à exporter.");
    return;
  }
      if (!window.jspdf || !window.jspdf.jsPDF) {
        toast("jsPDF non chargé. Ajoute la librairie PDF dans ton HTML.");
        return;
      }

      const { supplierName, score, label, supplier } = snapshot;

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF();
      let y = 15;

      const line = (txt, size = 11) => {
        doc.setFontSize(size);
        const split = doc.splitTextToSize(String(txt), 180);
        split.forEach(t => {
          doc.text(t, 14, y);
          y += 7;
          if (y > 280) { doc.addPage(); y = 20; }
        });
      };

      const section = (title) => {
        y += 3;
        doc.setFontSize(12);
        doc.text(title, 14, y);
        y += 7;
      };

      // ✅ accepte 0 / false / "0" / "97.3%"
      const addField = (k, v) => {
        if (v === undefined || v === null) return;
        const s = String(v).trim();
        if (s === "") return;
        line(`${k} : ${s}`, 11);
      };

      // Titre
      doc.setFontSize(16);
      doc.text("Analyse de fournisseur", 14, y);
      y += 10;

      addField("Fournisseur", supplierName || "—");
      addField("Score de fiabilité", `${score ?? "—"} / 100`);
      addField("Niveau", label || "—");

      // ✅ IDENTITÉ
      section("Identité");
      addField("Type d’entreprise", supplier?.company_type || supplier?.companyType);
      addField("Trade Assurance", supplier?.trade_assurance ?? supplier?.tradeAssurance);
      addField("Fournisseur vérifié", supplier?.verified);

      // ✅ PERFORMANCE
      section("Performance");
      addField("Taux de livraison", supplier?.delivery_rate || supplier?.deliveryRate);
      addField("Temps de réponse", supplier?.response_time || supplier?.responseTime);
      addField("Années sur Alibaba", supplier?.years_active || supplier?.yearsActive);

      // ✅ AVIS
      section("Avis");
      if (supplier?.rating != null) {
        addField("Avis produit", `${supplier.rating}/5`);
      }
      addField("Nombre d’avis produit", supplier?.reviews);
      addField("Avis boutique", supplier?.shop_reviews || supplier?.shopReviews);
      if (supplier?.shop_rating != null) {
        addField("Note boutique", `${supplier.shop_rating}/5`);
      }

      // ✅ CERTIFICATIONS
      section("Certifications");
      if (Array.isArray(supplier?.certifications) && supplier.certifications.length) {
        addField("Liste", supplier.certifications.join(", "));
      } else {
        addField("Info", "Aucune certification détectée (capture peut être incomplète).");
      }

      y += 8;
      doc.setFontSize(9);
      doc.text("Analyse générée automatiquement – À vérifier avant décision commerciale.", 14, y);

      doc.save(`analyse-fournisseur-${Date.now()}.pdf`);
/*      if (!isPro()) setCredits(getCredits() - 1);*/
    }




// ==============================
// 📄 EXPORT (PDF + EXCEL) — Coût + Marge
// ==============================

// 1) Snapshots globaux
window.lastCostSnapshot = window.lastCostSnapshot || null;
window.lastMarginSnapshot = window.lastMarginSnapshot || null;

// 2) Snapshot final : coût + marge (si dispo)
function getFinalSnapshot() {
  return {
    cost: window.lastCostSnapshot,
    margin: window.lastMarginSnapshot || null
  };
}

// 3) Affiche/masque les boutons export d'un bloc (coût OU marge)
function showCalcExportButtons(show, prefix) {
  // prefix = "cost" ou "margin"
  const pdfBtn = document.getElementById(`${prefix}-export-pdf-btn`);
  const xlsBtn = document.getElementById(`${prefix}-export-xls-btn`);
  const saveBtn = document.getElementById(`${prefix}-save-btn`);

  if (pdfBtn) pdfBtn.hidden = !show;
  if (xlsBtn) xlsBtn.hidden = !show;
  if (saveBtn) saveBtn.hidden = !show;
    setCalcActionsRowVisible(prefix, show);
}

//4) PDF
function exportCalcToPDF() {
  // 🔒 BLOQUER SI PAS AUTORISÉ
  const se = canSaveAndExport();
  if (!se.ok) {
    toast("🔒 Export réservé (pack ou abonnement).");
    return;
  }
  const snap = getFinalSnapshot();
  if (!snap.cost) {
    toast("Aucun calcul de coût à exporter.");
    return;
  }
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert("jsPDF non chargé. Ajoute la librairie jsPDF dans ton HTML.");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  let y = 15;

  const cur = snap.cost.currency || "XOF";
  /*const fmt = (n) => {
    const num = Number(String(n ?? 0).replace(/[^\d.-]/g, ""));
    return (Number.isFinite(num) ? num : 0).toLocaleString("fr-FR");
  };*/

  const fmt = (n) => {
  const num = Number(String(n ?? 0).replace(/[^\d.-]/g, ""));
  const s = (Number.isFinite(num) ? num : 0).toLocaleString("fr-FR");
  return s.replace(/[\u202F\u00A0]/g, " "); // ✅ enlève espaces insécables
};

  
  doc.setFontSize(16);
  doc.text("Calcul de coût", 14, y); y += 10;

  doc.setFontSize(11);
  doc.text(`Devise : ${cur}`, 14, y); y += 8;

  
 
  // --- INFOS PRINCIPALES (AVANT DÉTAILS)
  doc.setFontSize(12);
  doc.text("Infos principales", 14, y); y += 8;

  doc.setFontSize(11);
  const addLine = (k, v) => {
    if (v === "" || v === null || v === undefined) return;
    doc.text(`${k} : ${v}`, 14, y);
    y += 7;
    if (y > 280) { doc.addPage(); y = 20; }
  };

  addLine("Produit", snap.cost?.productName || "—");
  addLine("Fournisseur", snap.cost?.supplierName || "—");

  // petit espace
  y += 6;

  // --- COÛT
  doc.setFontSize(12);
  doc.text("Détails du coût", 14, y); y += 8;

  doc.setFontSize(11);
  addLine("Produits", `${fmt(snap.cost.productsTotal)} ${cur}`);
  addLine("Livraison locale", `${fmt(snap.cost.localFees)} ${cur}`);
  addLine("Transport international", `${fmt(snap.cost.shipping)} ${cur}`);
  addLine("Taxes / douane (%)", snap.cost.taxesPct != null ? `${snap.cost.taxesPct}%` : "—");
  addLine("Montant taxes", `${fmt(snap.cost.taxesAmount)} ${cur}`);
  addLine("TOTAL FINAL", `${fmt(snap.cost.totalFinal)} ${cur}`); 

  // --- MARGE (si dispo)
  if (snap.margin) {
    y += 10;
    doc.setFontSize(12);
    doc.text("Détails de marge", 14, y); y += 8;

    doc.setFontSize(11);
    addLine("Prix de vente unitaire", `${fmt(snap.margin.salePriceUnit)} ${cur}`);
    addLine("Quantité", `${fmt(snap.margin.qty)}`);
    addLine("Coût unitaire", `${fmt(snap.margin.costUnit)} ${cur}`);
    addLine("Marge unitaire", `${fmt(snap.margin.marginUnit)} ${cur}`);
    addLine("Marge totale", `${fmt(snap.margin.marginTotal)} ${cur}`);
    addLine("Taux de marge", `${Number(snap.margin.marginRate || 0).toFixed(1)} %`);
  }

  y += 10;
  doc.setFontSize(9);
  doc.text("Généré automatiquement – à vérifier avant décision commerciale.", 14, y);

  doc.save(`calcul-cout-marge-${Date.now()}.pdf`);
  consumeSaveExport(se.mode);
  if (typeof refreshPricingUI === "function") refreshPricingUI();
}

// 5) EXCEL (CSV)
function exportCalcToExcel() {
  // 🔒 BLOQUER SI PAS AUTORISÉ
  const se = canSaveAndExport();
  if (!se.ok) {
    toast("🔒 Export réservé (pack ou abonnement).");
    return;
  }
  const snap = getFinalSnapshot();
  if (!snap.cost) {
    toast("Aucun calcul de coût à exporter.");
    return;
  }

  const cur = snap.cost.currency || "XOF";
  const rows = [];

  // --- COÛT
  rows.push(["Titre", "Calcul de coût"]);
  rows.push(["Devise", cur]);
  rows.push(["Produits", snap.cost.productsTotal ?? ""]);
  rows.push(["Livraison locale", snap.cost.localFees ?? ""]);
  rows.push(["Transport international", snap.cost.shipping ?? ""]);
  rows.push(["Taxes (%)", snap.cost.taxesPct ?? ""]);
  rows.push(["Montant taxes", snap.cost.taxesAmount ?? ""]);
  rows.push(["TOTAL FINAL", snap.cost.totalFinal ?? ""]);

  // --- MARGE (si dispo)
  if (snap.margin) {
    rows.push(["", ""]);
    rows.push(["Titre", "Calcul de marge"]);
    rows.push(["Prix de vente unitaire", snap.margin.salePriceUnit ?? ""]);
    rows.push(["Quantité", snap.margin.qty ?? ""]);
    rows.push(["Coût unitaire", snap.margin.costUnit ?? ""]);
    rows.push(["Marge unitaire", snap.margin.marginUnit ?? ""]);
    rows.push(["Marge totale", snap.margin.marginTotal ?? ""]);
    rows.push(["Taux de marge (%)", snap.margin.marginRate ?? ""]);
  }

  const csv = rows
    .map(r => r.map(cell => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(";"))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `calcul-cout-marge-${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  consumeSaveExport(se.mode);
  if (typeof refreshPricingUI === "function") refreshPricingUI();
  } // ✅ FIN exportCalcToExcel

// 6) Brancher les boutons (coût + marge) — UNE SEULE FOIS
function initCalcExportButtons() {
  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.onclick = fn; // évite doublons addEventListener
  };

  // Boutons sous COÛT
  bind("cost-export-pdf-btn", exportCalcToPDF);
  bind("cost-export-xls-btn", exportCalcToExcel);

  // Boutons sous MARGE
  bind("margin-export-pdf-btn", exportCalcToPDF);
  bind("margin-export-xls-btn", exportCalcToExcel);
}

initCalcExportButtons();

        

//==============================
// 📊 EXPORT EXCEL (CSV)
// ==============================
function exportAnalysisToExcel(snapshot) {
  const se = canSaveAndExport();
  if (!se.ok) {
    toast("🔒 Export réservé (pack ou abonnement).");
    return;
  }

  if (!snapshot) {
    toast("Aucune analyse à exporter.");
    return;
  }

  const { supplierName, score, label, supplier } = snapshot;

  const rows = [
    ["Titre", "Analyse de fournisseur"],
    ["Fournisseur", supplierName || ""],
    ["Score de fiabilité (/100)", score ?? ""],
    ["Niveau", label || ""],
    ["Pays", supplier?.country || ""],
    ["Type d’entreprise", supplier?.company_type || ""],
    ["Taux de livraison", supplier?.delivery_rate || ""],
    ["Temps de réponse", supplier?.response_time || ""],
    ["Années sur Alibaba", supplier?.years_active || ""],
    ["Employés", supplier?.employees || ""],
    ["Superficie", supplier?.factory_size || ""],
    ["Avis (produit)", supplier?.rating ? `${supplier.rating}/5` : ""],
    ["Nombre d’avis (produit)", supplier?.reviews || ""],
    ["Avis boutique", supplier?.shop_reviews || ""],
    ["Note boutique", supplier?.shop_rating ? `${supplier.shop_rating}/5` : ""],
    [
      "Certifications",
      supplier?.certifications?.length
        ? supplier.certifications.join(", ")
        : ""
    ]
  ];

  // CSV compatible Excel (séparateur ;)
  const csv = rows
    .map(row =>
      row
        .map(cell =>
          `"${String(cell ?? "").replace(/"/g, '""')}"`
        )
        .join(";")
    )
    .join("\r\n");

  const blob = new Blob([csv], {
    type: "text/csv;charset=utf-8;"
  });

  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `analyse-fournisseur-${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
/*  if (!isPro()) setCredits(getCredits() - 1);*/
}

// Brancher les boutons
function initExportButtons() {
  const pdfBtn = document.getElementById("ocr-export-pdf-btn");
  const xlsBtn = document.getElementById("ocr-export-xls-btn");

  if (pdfBtn) {
    pdfBtn.addEventListener("click", () => {
      exportAnalysisToPDF(window.lastOcrSnapshot);
    });
  }
  if (xlsBtn) {
    xlsBtn.addEventListener("click", () => {
      exportAnalysisToExcel(window.lastOcrSnapshot);
    });
  }
}

initExportButtons();

function cleanDetailText(raw) {
  let t = String(raw || "");

  // enlève les lignes vides excessives
  t = t.replace(/\n{3,}/g, "\n\n");

  // enlève les décorations type "----- Résumé détecté -----"
  t = t.replace(/-+\s*résumé\s*détecté\s*-+/gi, "");
  t = t.replace(/-{3,}/g, "");

  // uniformise séparateurs " :"
  t = t.replace(/\s*:\s*/g, " : ");

  return t.trim();
}

/**
 * Transforme un bloc texte "Clé : Valeur" en tableau [{k,v}]
 * N'affiche que les lignes utiles.
 */
function parseDetailPairs(text) {
  const t = cleanDetailText(text);
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const out = [];
  for (const line of lines) {
    // ex: "Pays : CN (Chine)"
    const m = line.match(/^(.{2,30}?)\s*:\s*(.+)$/);
    if (m) {
      const k = m[1].trim();
      const v = m[2].trim();
      if (k && v) out.push({ k, v });
    }
  }
  return out;
}


document.addEventListener("DOMContentLoaded", () => {
  // cacher les 2 zones actions au démarrage
  const costActions = document.getElementById("cost-actions");
  const marginActions = document.getElementById("margin-actions");

  if (costActions) costActions.hidden = true;
  if (marginActions) marginActions.hidden = true;

  // et cacher individuellement les boutons
  showCalcExportButtons(false, "cost");
  showCalcExportButtons(false, "margin");
});


// ==============================
// OCR WORKER (réutilisé = plus rapide)
// ==============================


let ocrWorker = null;

async function getOcrWorker(setStatusCb) {
  // ✅ MAJ callback à chaque analyse (même si worker déjà créé)
  _ocrProgressCb = setStatusCb;

  if (ocrWorker) return ocrWorker;

  ocrWorker = await Tesseract.createWorker({
    workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@4.1.4/dist/worker.min.js",
    corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@4.0.4/tesseract-core.wasm.js",
    logger: (m) => {
      if (
        typeof _ocrProgressCb === "function" &&
        m.status === "recognizing text" &&
        m.progress != null
      ) {
        _ocrProgressCb(Math.round(m.progress * 100));
      }
    },
  });

  await ocrWorker.loadLanguage("fra+eng");
  await ocrWorker.initialize("fra+eng");

  await ocrWorker.setParameters({
    preserve_interword_spaces: "1",
    tessedit_pageseg_mode: "11",
  });

  return ocrWorker;
}

// Si ces fonctions n'existent pas encore, on évite le crash
if (typeof setSaveSectionVisible !== "function") {
  window.setSaveSectionVisible = function(){ /* noop */ };
}
if (typeof showAlibabaOnlyAlert !== "function") {
  window.showAlibabaOnlyAlert = function(msg){ alert(msg); };
}
if (typeof isProbablyAlibabaOcr !== "function") {
  window.isProbablyAlibabaOcr = function(text){
    const t = String(text||"").toLowerCase();
    return t.includes("alibaba") || t.includes("trade assurance") || t.includes("verified") || t.includes("fournisseur");
  };
}

// ✅ Fix Tesseract worker/core (sécurité réseau)
if (window.Tesseract) {
  Tesseract.workerPath = "https://cdn.jsdelivr.net/npm/tesseract.js@4.1.4/dist/worker.min.js";
  Tesseract.corePath   = "https://cdn.jsdelivr.net/npm/tesseract.js-core@4.0.4/tesseract-core.wasm.js";
}

// Debug global : voir les erreurs
window.addEventListener("error", (e) => {
  console.log("JS ERROR:", e.message);
});




function countryFromCode(code) {
  const c = String(code || "").toUpperCase().trim();
  const map = {
    CN: "CN (Chine)",
    US: "US (États-Unis)",
    FR: "FR (France)",
    GB: "GB (Royaume-Uni)",
    DE: "DE (Allemagne)",
    IT: "IT (Italie)",
    ES: "ES (Espagne)",
    TR: "TR (Turquie)",
    IN: "IN (Inde)",
    VN: "VN (Vietnam)",
    TH: "TH (Thaïlande)",
    MY: "MY (Malaisie)",
    AE: "AE (Émirats)",
    MA: "MA (Maroc)",
    DZ: "DZ (Algérie)",
    TN: "TN (Tunisie)",
    CI: "CI (Côte d’Ivoire)",
    GH: "GH (Ghana)",
    NG: "NG (Nigéria)"
  };
  return map[c] || c;
}
// Vérifie que le code pays est valide (évite EN, FR, etc.)
function isValidCountryCode(code) {
  const invalid = ["EN", "FR", "ES", "DE", "IT", "PT"];
  return /^[A-Z]{2}$/.test(code) && !invalid.includes(code);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function cleanSupplierName(name) {
  let s = String(name || "").trim();

  // enlève préfixes bruités genre "e," "y" "p 20" etc.
  s = s.replace(/^[^A-Za-z0-9]+/g, "");
  s = s.replace(/^(?:[a-z]\s*,\s*)/i, "");      // "e, "
  s = s.replace(/^(?:[a-z]\s+)/i, "");          // "y "
  s = s.replace(/^\s*p\s*\d+\s+/i, "");         // "p 20 "
  s = s.replace(/\s{2,}/g, " ").trim();

  // coupe les "...", si OCR tronque
  s = s.replace(/\.\.\.$/, "").trim();

  // limite taille pour éviter pavé
  if (s.length > 60) s = s.slice(0, 60).trim();

  return s;
}
function prettyName(name) {
  return String(name || "")
    .replace(/\.\.\.$/, "")
    .replace(/\bManufactu$/i, "Manufacturing")
    .trim();
}

function extractShopReviewsCount(rawText) {
  const t = String(rawText || "");

  // ✅ on accepte seulement un nombre "seul" (pas 1/94)
  const patterns = [
    /avis\s+sur\s+la\s+boutique\s*\(\s*(\d{1,7})\s*\)(?!\s*\/)/i, // (1794)
    /avis\s+boutique\D{0,20}(\d[\d\s.,]{0,10})/i,
    /store\s+reviews\D{0,20}(\d[\d\s.,]{0,10})/i,
    /supplier\s+reviews\D{0,20}(\d[\d\s.,]{0,10})/i,
    /shop\s+reviews\D{0,20}(\d[\d\s.,]{0,10})/i,
  ];

  for (const p of patterns) {
    const m = t.match(p);
    if (m && m[1]) {
      const n = parseInt(String(m[1]).replace(/[^\d]/g, ""), 10);
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

function normalizeRating(ratingStr) {
  const raw = String(ratingStr || "").replace(",", ".").trim();
  const n = parseFloat(raw);
  if (isNaN(n)) return "";
  // Alibaba c’est 0..5
  return String(clamp(n, 0, 5));
}

function cleanCustomizationText(txt) {
  let s = String(txt || "").trim();
  if (!s) return "";

  // garde seulement si ça contient vraiment le mot
  if (!/personnalis/i.test(s)) return "";

  // coupe après des mots qui indiquent qu’on sort du sujet
  s = s.split(/profil de l'entreprise|certifications|présentation de l'entreprise|marqués principaux|marchés principaux|trade assurance/i)[0];

  // nettoie séparateurs
  s = s.replace(/\s{2,}/g, " ").trim();

  // limite longueur
  if (s.length > 90) s = s.slice(0, 90).trim();

  return s;
}

function dedupeCertDetails(certDetails) {
  const seen = new Set();
  const out = [];
  for (const c of (certDetails || [])) {
    const type = String(c?.type || "").trim();
    const num  = c?.number ? String(c.number).trim() : "";
    if (!type) continue;

    const key = (type + "::" + num).toUpperCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push({ type, number: num || null });
  }
  return out;
}





function renderProCard(supplier, rel) {
  const card   = document.getElementById("pro-card");
  const badge  = document.getElementById("pro-badge");
  const score  = document.getElementById("pro-score");
  const level  = document.getElementById("pro-level");
  const bar    = document.getElementById("pro-bar");

  const name   = document.getElementById("pro-name");
  const country= document.getElementById("pro-country");
  const delivery= document.getElementById("pro-delivery");
  const reviews = document.getElementById("pro-rating");

  const details= document.getElementById("pro-details");
  const tags   = document.getElementById("pro-tags");
  const warn   = document.getElementById("pro-warn");

  if (!card) return;

  // reset classes niveau
  card.classList.remove("level-good","level-mid","level-bad");

  const s = rel?.score ?? 0;
  safeSetText(score, String(s));
  safeSetText(level, rel?.level || "—");
  if (bar) bar.style.width = Math.max(0, Math.min(100, s)) + "%";

  // Couleur niveau
  const cls = s >= 80 ? "level-good" : s >= 60 ? "level-mid" : "level-bad";
  card.classList.add(cls);

  // Badge court
  safeSetText(badge, s >= 80 ? "✅ OK" : s >= 60 ? "⚠️ À vérifier" : "❌ Risque");

  // Infos principales
  safeSetText(name, supplier?.name ? prettyName(supplier.name) : "—");
  safeSetText(country, supplier?.country || "—");
  safeSetText(delivery, supplier?.delivery_rate || "—");
  let parts = [];

  // 1) AVIS PRODUIT (prioritaire)
  if (supplier?.rating && Number(supplier?.reviews) > 0) {
    parts.push(`⭐ ${supplier.rating}/5 (${supplier.reviews} avis)`);
  }
  // 2) Sinon AVIS BOUTIQUE
  else if (Number(supplier?.shop_reviews) > 0) {
    parts.push(`🏪 ${supplier.shop_reviews} avis boutique`);
  }
  // 3) Sinon rien
  else {
    parts.push("—");
  }

  // 4) VENDUS (ajout si dispo)
  const sold = Number(String(supplier?.sold || "").replace(/[^\d]/g, ""));
  if (sold > 0) {
    parts.push(`🛒 ${sold} vendus`);
  }

  safeSetText(reviews, parts.join(" • "));
  // Tags
  if (tags) tags.innerHTML = "";
  const t = [];
  if (supplier?.verified) t.push("Verified");
  if (supplier?.trade_assurance) t.push("Trade Assurance");
  if ((supplier?.certification_details || []).length) t.push("Certifs");
  if (supplier?.company_type) t.push(supplier.company_type);

  function iconForTag(x){
    const s = String(x||"").toLowerCase();
    if (s.includes("verified") || s.includes("vérifi")) return "✅";
    if (s.includes("trade")) return "🛡️";
    if (s.includes("cert")) return "📄";
    if (s.includes("fabric")) return "🏭";
    return "🏷️";
  }

  t.forEach(x => {
    const d = document.createElement("span");
    d.className = "tag";
    d.innerHTML = `${iconForTag(x)} <span>${x}</span>`;
    tags?.appendChild(d);
  });

  // Détails score
  if (details) details.innerHTML = "";
  (rel?.reasons || []).slice(0, 10).forEach(r => {
    const li = document.createElement("li");
    li.textContent = r;
    details?.appendChild(li);
  });

  // Warning “pro”
  if (warn) {
    const rating = parseFloat(String(supplier?.rating || "").replace(",", "."));
    const noCert = !(supplier?.certification_details && supplier.certification_details.length);
    const ratingIsZeroFromOCR = /0\.0\s*\/\s*5/i.test(String(supplier?._rawText || "")); // optionnel si tu stockes raw

    let msg = "";
    if (noCert) msg += "⚠️ Aucune certification détectée. ";
    if (!isNaN(rating) && rating <= 2) msg += "⚠️ Avis très faibles. ";
    // si Alibaba affiche 0.0/5.0, souvent “non noté” → on avertit plutôt que condamner
    if (String(supplier?.rating || "") === "0" || String(supplier?.rating || "") === "0.0") {
      msg += "ℹ️ Note 0.0/5 : souvent pas assez de données (à confirmer). ";
    }

    if (msg.trim()) {
      warn.hidden = false;
      warn.textContent = msg.trim();
    } else {
      warn.hidden = true;
      warn.textContent = "";
    }
  }

  card.hidden = false;

// ✅ lancer animation après affichage réel
requestAnimationFrame(() => {
  animateProBadge();
});

} 


// ================================
//  Analyse texte OCR fournisseur
// ================================
function parseOcrSupplier(text) {
  const full  = text || "";
  const lower = full.toLowerCase();
  const lines = full.split(/\r?\n/);

  const supplier = {
  _rawText: full,
  

    // Infos de base
    name: "",
    rating: "",
    reviews: "",
    sold: "",

    // Infos “fournisseur”
    years_active: "",
    delivery_rate: "",
    response_time: "",
    country: "",
    verified: null,
    company_type: "",
    
    // Infos entreprise
    online_revenue: "",
    founded_year: "",
    factory_size: "",
    employees: "",
    main_markets: "",
    services: [],

    // Sécurité / qualité
    trade_assurance: false,
    certifications: [],        // labels uniques : CE, RoHS…
    certification_details: [], // objets détaillés

    // Infos produit (si visibles sur la capture)
    product_price_range: "",
    product_moq: "",
    product_sample_price: ""
  };

  // ---------- NOM FOURNISSEUR (fallback solide) ----------
  let name = "";

  // 1) si tu as un nom “classique”
  let m = full.match(/([A-Za-z0-9 ,.&'’\-]{8,80}(?:Co\.,?\s*Ltd\.|Company|Manufactur\w*|International|Industr\w*))/i);
  if (m) name = m[1].trim();

  // 2) fallback : ligne après "Verified" (souvent OCR coupe le mot)
  if (!name) {
    const idx = lines.findIndex(l => /verified/i.test(l));
    if (idx !== -1) {
      const cand = (lines[idx + 1] || "").trim();
      if (cand && cand.length >= 8) name = cand;
    }
  }

  // 3) fallback : ligne qui contient “Watch Manufactu...” etc.
  if (!name) {
    const cand = lines.find(l => /(manufactu|international trade|technology|factory|industr)/i.test(l));
    if (cand && cand.trim().length >= 8) name = cand.trim();
  }
  supplier.name = cleanSupplierName(name);

  // ---------- NOTE ----------
  // format 1 : "4.8/5"
  let ratingMatch = full.match(/(\d(?:\.\d)?)\s*\/\s*5/);
  if (ratingMatch) {
    supplier.rating = ratingMatch[1];
  } else {
    // format 2 : "5.0 (5)" ou "4.9 (29)"
    ratingMatch = full.match(/(\d(?:\.\d)?)\s*\(\s*(\d+)\s*\)/);
    if (ratingMatch) {
      supplier.rating  = ratingMatch[1];
      supplier.reviews = ratingMatch[2];
    }
  }
  // fallback note : cherche un 4.8 proche de "★" ou "¥" ou "Y"
  if (!supplier.rating) {
    // exemple OCR: "★ 4.8" ou "¥ 4.8" ou "Y 4.8"
    const m2 = full.match(/(?:★|[\u00A5Y¥])\s*(\d(?:[.,]\d)?)/);
    if (m2) supplier.rating = m2[1].replace(",", ".");
  }

  // normalisation (évite 9/5)
  supplier.rating = normalizeRating(supplier.rating);
  // ---------- AVIS / VENDUS ----------
  const reviewsMatch = lower.match(/(\d+)\s*(avis|reviews)/);
  if (reviewsMatch) {
    supplier.reviews = reviewsMatch[1];
  }
  const soldMatch = lower.match(/(\d+)\s*vendus/);
  if (soldMatch) {
    supplier.sold = soldMatch[1];
  }


  // ---------- TAUX DE LIVRAISON (ULTRA ROBUSTE) ----------
  function extractDeliveryRateRobust(fullText) {
    const full = String(fullText || "");

    // mots-clés possibles
    const keys = [
      "taux de livraison",
      "livraison dans les délais",
      "on-time delivery",
      "on time delivery",
      "delivery rate",
      "delivery"
    ];

    const lower = full.toLowerCase();
    const percentRe = /(\d{1,3}(?:[.,]\d{1,2})?)\s*%/;

    // 1) On cherche une zone autour du mot-clé (±250 caractères)
    for (const k of keys) {
      const idx = lower.indexOf(k);
      if (idx !== -1) {
        const start = Math.max(0, idx - 250);
        const end = Math.min(full.length, idx + 250);
        const zone = full.slice(start, end);

        const m = zone.match(percentRe);
        if (m) return m[1].replace(",", ".") + "%";
      }
    }

    // 2) fallback : parfois le % est dans "Présentation de l'entreprise"
    const idx2 = lower.indexOf("présentation de l'entreprise");
    if (idx2 !== -1) {
      const zone = full.slice(idx2, Math.min(full.length, idx2 + 450));
      const m = zone.match(percentRe);
      if (m) return m[1].replace(",", ".") + "%";
    }

    return "";
  }

  // Dans parseOcrSupplier :
  supplier.delivery_rate = extractDeliveryRateRobust(full);

  // ---------- TEMPS DE RÉPONSE ----------
  const respMatch = full.match(/(≤?\s*\d+\s*(?:h|heures?|hours?))/i);
  if (respMatch) {
    supplier.response_time = respMatch[1]
      .replace(/heures?/i, "h")
      .replace(/hours?/i, "h")
      .trim();
  }

  // ---------- PAYS ----------
let country = "";

const normCode = (x) =>
  String(x || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .trim();

// 1) “Situé en/au/aux CN” ou “Located in CN”
m = full.match(/\b(?:situ[eé]\s+(?:en|au|aux)|located\s+in)\s+([A-Z]{2})\b/i);
if (m) {
  const cc = normCode(m[1]);
  if (isValidCountryCode(cc)) country = countryFromCode(cc);
}

// 2) fallback : “..., CN”
if (!country) {
  m = full.match(/,\s*([A-Z]{2})\b/);
  if (m) {
    const cc = normCode(m[1]);
    if (isValidCountryCode(cc)) country = countryFromCode(cc);
  }
}

supplier.country = country || "";
  // ---------- VÉRIFIÉ ? ----------
  if (
    lower.includes("verified") ||
    lower.includes("fournisseur vérifié") ||
    lower.includes("fournisseur verifie")
  ) {
    supplier.verified = true;
  }

  //---------- TYPE D'ENTREPRISE ----------
  if (/trading\s*company/i.test(full)) {
    supplier.company_type = "Trading Company";
}
  if (/(manufacturer|manufacturing|fabricant)/i.test(full)) {
    supplier.company_type = "Fabricant";
}
  
  // ---------- REVENUS EN LIGNE ----------
  const revenueMatch = full.match(/US\$?\s*[\d,.]+\+?/i);
  if (revenueMatch) {
    supplier.online_revenue = revenueMatch[0].replace(/\s+/g, " ").trim();
  }

  // ---------- ANNÉES SUR ALIBABA ----------
  const yearsMatch = lower.match(/(\d+)\s*ans sur alibaba/);
  if (yearsMatch) {
    supplier.years_active = yearsMatch[1];
  }

  // ... plus bas (si tu veux garder un fallback) :
  const yearsMatch2 = full.match(/(\d+)\s*ans\s*sur\s*Alibaba(?:\.com)?/i);
  if (yearsMatch2 && !supplier.years_active) {
    supplier.years_active = yearsMatch2[1];
  }

  // ---------- SUPERFICIE ----------
  const areaMatch = full.match(/(\d{3,6})\s*m[²2?]/i);
  if (areaMatch) {
    supplier.factory_size = areaMatch[1] + " m²";
  }

  // ---------- NOMBRE D’EMPLOYÉS ----------
  let empMatch = full.match(/(\d{2,5})\s*(?:employés|employees|employes)/i);
  if (empMatch) {
    supplier.employees = empMatch[1];
  } else {
    const combo = full.match(
      /((?:19|20)\d{2})\D+(\d{3,6})\s*m[²2?]\D+(\d{2,5})/i
    );
    if (combo) {
      if (!supplier.founded_year) {
        supplier.founded_year = combo[1];
      }
      if (!supplier.factory_size) {
        supplier.factory_size = combo[2] + " m²";
      }
      supplier.employees = combo[3];
    }
  }
  // ---------- PERSONNALISATION (propre) ----------
  function cleanServiceLine(s) {
    return String(s || "")
      .replace(/[•·▪►>]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // on récupère les lignes qui contiennent "Personnalisation"
  const persLines = lines
    .map(l => cleanServiceLine(l))
    .filter(l => /personnalis/i.test(l))
    .filter(l => !/profil de l'entreprise|plus de produits|envoyer demande|discuter ici|magasin|certificat|certification/i.test(l));

  let pers = "";
  if (persLines.length) {
    // on garde max 3 lignes utiles
    pers = persLines.slice(0, 3).join(" • ");
  }

  // fallback : si OCR est trop sale, au moins détecter des mots-clés
  if (!pers) {
    const k = [];
    if (/personnalisation\s+simple/i.test(full)) k.push("Personnalisation simple");
    if (/personnalisation\s+compl[eè]te/i.test(full)) k.push("Personnalisation complète");
    if (/sur\s+mesure|custom|oem|odm/i.test(full)) k.push("Sur mesure (OEM/ODM)");
    if (k.length) pers = k.join(" • ");
  }

  supplier.personalization = pers;
  supplier.personalization = cleanCustomizationText(supplier.personalization);
  
  // ---------- MARCHÉS PRINCIPAUX ----------
  const marketsWordMatch = full.match(
    /(Southern|Northern|Western|Eastern)\s+[A-Za-z]+/i
  );
  if (marketsWordMatch) {
    supplier.main_markets = marketsWordMatch[0].trim();
  } else {
    const idxMarkets = lines.findIndex((l) =>
      /marchés principaux/i.test(l)
    );
    if (idxMarkets !== -1 && lines[idxMarkets + 1]) {
      supplier.main_markets = lines[idxMarkets + 1].trim();
    }
  }

  // ---------- SERVICES ----------
  const servicesMatch = full.match(/Services[\s>:-]*([\s\S]+)/i);
  if (servicesMatch) {
    supplier.services = servicesMatch[1]
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 4);
  }

  // ---------- TRADE ASSURANCE ----------
  if (lower.includes("trade assurance")) {
    supplier.trade_assurance = true;
  }

  // ---------- CERTIFICATIONS (détaillées + simples) ----------
  const raw = full || "";
  const rawUpper = raw.toUpperCase();

  // Contexte “certifications” (évite faux positifs "ce")
  const hasCertContext =
    /certif|certificate|conformit|conformity|certifications?/i.test(raw);

  // ✅ 1) CERTIFICATS DÉTAILLÉS (avec numéro)
  const certDetails = [];

  // helper push sans doublon
  function pushCert(type, number) {
    const key = `${type}:${number || ""}`;
    const exists = certDetails.some(c => `${c.type}:${c.number || ""}` === key);
    if (!exists) certDetails.push({ type, number: number || null });
  }

  // CE + numéro (sans traverser plusieurs lignes)
  (raw.match(/CE[^\n\r]{0,25}\b([A-Z]{2,5}\d{5,20}[A-Z]{0,5})\b/gi) || [])
    .forEach(m => {
      const mm = m.match(/\b[A-Z]{2,5}\d{5,20}[A-Z]{0,5}\b/);
      if (mm) pushCert("CE", mm[0]);
    });

  // RoHS + numéro (sans traverser plusieurs lignes)
  (raw.match(/RoHS[^\n\r]{0,25}\b([A-Z]{2,5}\d{4,20}[A-Z]{0,5})\b/gi) || [])
    .forEach(m => {
      const mm = m.match(/\b[A-Z]{2,5}\d{4,20}[A-Z]{0,5}\b/);
      if (mm) pushCert("RoHS", mm[0]);
    });

  // Certificate of Conformity + numéro
  (raw.match(/Certificate of Conformity[\s\S]{0,60}?\b([A-Z]{2,5}\d{5,20}[A-Z]{0,5})\b/gi) || [])
    .forEach(m => {
      const mm = m.match(/\b[A-Z]{2,5}\d{5,20}[A-Z]{0,5}\b/);
      if (mm) pushCert("Certificate of Conformity", mm[0]);
    });

  // ✅ 2) CERTIFICATS SIMPLES (sans numéro)
  if (hasCertContext && /\bC\s*E\b/.test(rawUpper)) pushCert("CE", null);
  if (hasCertContext && /\bR\s*[0O]\s*H\s*[S5]\b/.test(rawUpper)) pushCert("RoHS", null);
  if (hasCertContext && /\bF\s*C\s*C\b/.test(rawUpper)) pushCert("FCC", null);

  // ISO (avec une priorité ISO 9001 / 14001)
  if (hasCertContext && (/\bI\s*S\s*O\b/.test(rawUpper) || /\b1SO\b/.test(rawUpper))) {
    if (/\b(ISO|1SO)\s*9001\b/.test(rawUpper)) pushCert("ISO 9001", null);
    else if (/\b(ISO|1SO)\s*14001\b/.test(rawUpper)) pushCert("ISO 14001", null);
    else pushCert("ISO", null);
  }

  // autres
  if (hasCertContext && /\bB\s*S\s*C\s*I\b/.test(rawUpper)) pushCert("BSCI", null);
  if (hasCertContext && /\bS\s*G\s*S\b/.test(rawUpper)) pushCert("SGS", null);
  if (hasCertContext && /\bT\s*U\s*V\b/.test(rawUpper)) pushCert("TUV", null);
  if (hasCertContext && /\bC\s*Q\s*C\b/.test(rawUpper)) pushCert("CQC", null);

  if (hasCertContext && /certificate of conformity/i.test(raw)) {
    pushCert("Certificate of Conformity", null);
  }
  // ✅ 3) Remplissage final (certifs)
  supplier.certification_details = dedupeCertDetails(certDetails);

  // Si un type existe avec numéro, on supprime le même type sans numéro
  const hasNumberTypes = new Set(
    supplier.certification_details
      .filter(c => c.number)
      .map(c => String(c.type || "").toUpperCase())
  );

  supplier.certification_details = supplier.certification_details.filter(c => {
    const t = String(c.type || "").toUpperCase();
    if (!c.number && hasNumberTypes.has(t)) return false;
    return true;
  });

  // Liste simple (types uniques)
  supplier.certifications = [...new Set(supplier.certification_details.map(c => c.type))];
  
  

  // ---------- PRIX PRODUIT ----------
  const priceRangeMatch = full.match(
    /(\d[\d\s.,]*)\s*[-–]\s*(\d[\d\s.,]*)\s*([A-Z]{1,4}\s*CFA|US\$|USD|EUR|€)/i
  );
  if (priceRangeMatch) {
    const p1 = priceRangeMatch[1].replace(/\s+/g, " ");
    const p2 = priceRangeMatch[2].replace(/\s+/g, " ");
    supplier.product_price_range = `${p1} - ${p2} ${priceRangeMatch[3]}`;
  }

  const moqMatch = full.match(/Commande minimale\s*:\s*([\d\s,.]+)/i);
  if (moqMatch) {
    supplier.product_moq = moqMatch[1].replace(/\s+/g, " ").trim();
  }

  const sampleMatch = full.match(/Prix de l[’'e]chantillon\s*:?\s*([^\n]+)/i);
  if (sampleMatch) {
    supplier.product_sample_price = sampleMatch[1].trim();
  }
  // ---- Avis Boutique (robuste) ----
  const shop = extractShopInfo(full);
  if (shop.shop_reviews != null) supplier.shop_reviews = shop.shop_reviews;
  if (shop.shop_rating != null) supplier.shop_rating = shop.shop_rating;
  // ✅ Fallback : note boutique visible dans le bloc fournisseur (ex: "… 9 ans sur Alibaba … ★ 4.8")
  if (supplier.shop_rating == null) {
    const sr = extractShopRatingFromSupplierBlock(full);
    if (sr != null) supplier.shop_rating = sr;
  }
  return supplier;
}



function vendorKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(co|co\.|ltd|ltd\.|limited|company|manufacturing|manufacturer|factory|international|trade|technology|industries|industry|group)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseIntSafe(v) {
  const n = parseInt(String(v || "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloatSafe(v) {
  const n = parseFloat(String(v || "").replace(",", ".").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractShopInfo(text) {
  const t = String(text || "");

  // 1) "Note de la boutique : 4.8 (871)"
  let m = t.match(/Note\s+de\s+la\s+boutique\s*[:\-]?\s*([0-5](?:[.,]\d)?)\s*[★⭐]?\s*\(?\s*(\d{1,7})\s*\)?/i);
  if (m) return { shop_rating: parseFloatSafe(m[1]), shop_reviews: parseIntSafe(m[2]) };

  // 2) "Avis sur la boutique (871)"
  m = t.match(/Avis\s+sur\s+la\s+boutique\s*\((\d{1,7})\)/i);
  const shop_reviews = m ? parseIntSafe(m[1]) : null;

  // 3) écran boutique: "4.8/5.0 Satisfait(e)"
  m = t.match(/([0-5](?:[.,]\d)?)\s*\/\s*5\.0\s*(?:Satisfait|Satisfait\(e\)|Excellent|Bon)/i);
  const shop_rating = m ? parseFloatSafe(m[1]) : null;

  // 4) fallback: parfois "4.8/5" sans mot "Satisfait"
  if (shop_rating == null) {
    m = t.match(/([0-5](?:[.,]\d)?)\s*\/\s*5\b/i);
    // Attention: ça peut matcher la note produit aussi → on ne prend que si on a shop_reviews déjà
    if (m && shop_reviews != null) return { shop_rating: parseFloatSafe(m[1]), shop_reviews };
  }

  return { shop_rating, shop_reviews };
}

// ==============================
// SCORE FIABILITÉ + DÉTAILS
// ==============================
    // ==============================
    // SCORE FIABILITÉ (V2) — selon tes priorités
    // ==============================
    function computeReliability(supplier) {
      const s = supplier || {};
      let score = 0;
      const details = [];

      const add = (pts, label) => {
        score += pts;
        details.push(`${pts >= 0 ? "+" : ""}${pts} ${label}`);
      };

      // Helpers
      const toNum = (v) => {
        const n = parseFloat(String(v || "").replace(",", ".").replace(/[^\d.]/g, ""));
        return isNaN(n) ? null : n;
      };

      const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

      // ----------------------------
      // 1) Fournisseur vérifié (priorité #1)
      // Présent : 20 pts | Absent : 5 pts (ton choix)
      // ----------------------------
      if (s.verified) add(20, "Fournisseur vérifié");
      else add(5, "Non vérifié (peut être en attente)");

      // ----------------------------
      // 2) Trade Assurance (priorité #2)
      // Présent : 18 pts | Absent : 0
      // ----------------------------
      if (s.trade_assurance) add(18, "Trade Assurance");
      else add(0, "Trade Assurance non détectée");

// ===== AVIS (PRODUIT prioritaire + BOUTIQUE support) — cap 18 =====
let avisScore = 0;

// Produit
const pr = toNum(s.product_rating ?? s.rating);
const pc = toNum(s.product_reviews ?? s.reviews);
const pv = toNum(s.sold);

if (pr != null) {
  if (pr >= 4.8) avisScore += 10;
  else if (pr >= 4.6) avisScore += 8;
  else if (pr >= 4.4) avisScore += 6;
  else if (pr >= 4.2) avisScore += 4;
  else if (pr >= 4.0) avisScore += 2;
}

if (pc != null) {
  if (pc >= 500) avisScore += 6;
  else if (pc >= 200) avisScore += 5;
  else if (pc >= 50) avisScore += 4;
  else if (pc >= 10) avisScore += 2;
  else if (pc >= 1) avisScore += 1;
}

if (pv != null) {
  if (pv >= 100) avisScore += 2;
  else if (pv >= 20) avisScore += 1;
}

// Boutique (support léger)
let boutiqueScore = 0;
const sr = toNum(s.shop_rating);
const sc = toNum(s.shop_reviews);

if (sc != null) {
  if (sr != null && sr >= 4.5 && sc >= 1000) boutiqueScore = 3;
  else if (sr != null && sr >= 4.0 && sc >= 500) boutiqueScore = 2.5;
  else if (sc >= 100) boutiqueScore = 2;
  else boutiqueScore = 1;
}

avisScore = Math.min(avisScore + boutiqueScore, 18);
add(avisScore, "Avis (produit prioritaire, boutique en support)");



      // ----------------------------
      // 4) Taux de livraison (priorité #4) — max 10
      // ----------------------------
      const delivery = toNum(String(s.delivery_rate || "").replace("%", ""));
      if (delivery != null) {
        let pts = 0;
        if (delivery >= 98) pts = 10;
        else if (delivery >= 95) pts = 8;
        else if (delivery >= 92) pts = 6;
        else if (delivery >= 90) pts = 4;
        else pts = 2;
        add(pts, `Taux de livraison (${delivery}%)`);
      } else {
        add(0, "Taux de livraison non détecté");
      }

      // ----------------------------
      // 5) Avis BOUTIQUE (support) — nb avis (max 3)
      // ➜ On n'affiche la ligne QUE si on a un nombre > 0
      // ----------------------------
      const shopReviews = toNum(s.shop_reviews);

      if (shopReviews != null && shopReviews > 0) {
        let pts = 0;
        if (shopReviews >= 1000) pts = 3;
        else if (shopReviews >= 200) pts = 2.5;
        else if (shopReviews >= 50) pts = 2;
        else if (shopReviews >= 10) pts = 1;
        else pts = 0.5;

        add(pts, `Avis boutique (nb : ${shopReviews})`);
      }
      // ✅ sinon: on ne met rien (pas de "+0 ... non détecté")

      // ----------------------------
      // 6) Certificats (priorité #6) — max 3 (et pas de pénalité si absent)
      // ----------------------------
      const certCount = (s.certification_details || []).filter(c => c && c.type).length;
      if (certCount >= 1) add(3, `Certificats détectés (${certCount})`);
      else add(0, "Certificats non visibles (pas pénalisé)");

      // ----------------------------
      // 7) Temps de réponse — max 3
      // ----------------------------
      const rt = String(s.response_time || "").toLowerCase();
      const hMatch = rt.match(/(\d+)\s*h/);
      if (hMatch) {
        const h = parseInt(hMatch[1], 10);
        let pts = 0;
        if (h <= 2) pts = 3;
        else if (h <= 3) pts = 2;
        else if (h <= 6) pts = 1;
        else pts = 0;
        add(pts, `Temps de réponse (${h}h)`);
      } else {
        add(0, "Temps de réponse non détecté");
      }

      // ----------------------------
      // 8) Autres (bonus) — année / employés / superficie (max 10)
      // ----------------------------
      let otherPts = 0;

      
      
// année (max 5) : founded_year sinon years_active (ans sur Alibaba)
      const fy = toNum(s.founded_year);
      const ya = toNum(s.years_active);

if (fy != null) {
      const nowY = new Date().getFullYear();
      const age = nowY - fy;
  if (age >= 10) otherPts += 5;
  else if (age >= 5) otherPts += 3;
  else if (age >= 2) otherPts += 2;
  else otherPts += 1;
} else if (ya != null) {
  // fallback basé sur “X ans sur Alibaba”
  if (ya >= 10) otherPts += 5;
  else if (ya >= 5) otherPts += 3;
  else if (ya >= 2) otherPts += 2;
  else otherPts += 1;
}

      // employés (max 3)
      const emp = toNum(s.employees);
      if (emp != null) {
        if (emp >= 300) otherPts += 3;
        else if (emp >= 100) otherPts += 2;
        else if (emp >= 20) otherPts += 1;
      }

      // superficie (max 2)
      const area = toNum(String(s.factory_size || "").replace(/[^\d]/g, ""));
      if (area != null) {
        if (area >= 10000) otherPts += 2;
        else if (area >= 2000) otherPts += 1;
      }

      otherPts = clamp(otherPts, 0, 10);
      add(otherPts, "Autres (année + employés + superficie)");

      // ----------------------------
      // Final
      // ----------------------------
      score = clamp(Math.round(score), 0, 100);

      let label = "Risque";
      if (score >= 80) label = "Très fiable";
      else if (score >= 60) label = "Fiable";
      else if (score >= 40) label = "Moyen";

      return { score, label, details };
    }
    




  // =========================================
  // 📸 OCR : lecture + résumé automatique (1 à 5 captures)
  // =========================================
if (ocrBtn && ocrInput) {
    ocrBtn.addEventListener("click", async () => {
      const runId = ++_ocrRunId;

      const check = canUseOcr();
      if (!check.ok) { toast(paywallMsg()); return; }

      hideOcrExportButtons();

      if (!window.Tesseract) {
        safeSetText(ocrStatus, "❌ Analyse impossible (OCR non chargé)");
        setSaveSectionVisible(false);
        return;
      }

      const files = Array.from(ocrInput.files || []);
      const total = files.length;

      if (!total) { toast("Choisis 1 à 5 images d’abord."); return; }
      if (total > 5) {
        safeSetText(ocrStatus, "⚠️ Maximum 5 captures.");
        setSaveSectionVisible(false);
        return;
      }

      // reset UI
      setSaveSectionVisible(false);
      safeSetText(ocrResumeEl, "");
      safeSetText(ocrRawEl, "");
      safeHide(ocrRawEl);
      safeHide(toggleOcrBtn);

      let combinedText = "";
      let combinedRawText = "";
      let refSupplierName = "";
      let currentIndex = 0;

      safeSetText(ocrStatus, `⏳ Lecture… (0/${total}) - 0%`);

      try {
        let lastProg = 0;

        const worker = await getOcrWorker((p) => {
          if (runId !== _ocrRunId) return;

          // ✅ p est déjà un nombre 0..100
          let prog = Number(p);
          if (!Number.isFinite(prog)) return;

          prog = Math.round(Math.max(0, Math.min(100, prog)));

          // ✅ empêche le % de redescendre
          if (prog < lastProg) prog = lastProg;
          lastProg = prog;

          safeSetText(
            ocrStatus,
            `⏳ Lecture… (${currentIndex + 1}/${total}) - ${prog}%`
          );
        });

            for (let i = 0; i < total; i++) {
              currentIndex = i;
              lastProg = 0; // ✅ OBLIGATOIRE

              safeSetText(
                ocrStatus,
                `⏳ Lecture… (${i + 1}/${total}) - 0%`
              );

              const res = await worker.recognize(files[i]);
              
            
          const rawText = String(res?.data?.text || "").trim();

          const tmpSupplier = parseOcrSupplier(rawText);
          const currentName = cleanSupplierName(tmpSupplier?.name || "");

          if (currentName) {
            if (!refSupplierName) refSupplierName = currentName;
            else {
              const a = vendorKey(refSupplierName);
              const b = vendorKey(currentName);
              const sim = similarity(a, b);
              if (a && b && sim < 0.70) {
                safeSetText(ocrStatus, "⚠️ Vendeurs différents détectés. Mets seulement le même fournisseur.");
                setSaveSectionVisible(false);
                return;
              }
            }
          }

          if (rawText) {
            combinedRawText += `\n\n----- IMAGE ${i + 1} -----\n${rawText}`;
            combinedText += `\n${rawText}`;
          }
        }

        safeSetText(ocrStatus, `✅ Lecture terminée (${total}/${total}) - 100%`);

        if (!combinedText.trim()) {
          safeSetText(ocrStatus, "⚠️ Aucun texte détecté sur les captures.");
          setSaveSectionVisible(false);
          return;
        }

        if (!isProbablyAlibabaOcr(combinedText)) {
          safeSetText(ocrStatus, "⚠️ Analyse impossible. Essaie une capture plus nette (même vendeur).");
          setSaveSectionVisible(false);
          return;
        }

        safeSetText(ocrStatus, "⏳ Génération du résumé…");
        
        
          
  
      // ✅ 1. ON CRÉE LE FOURNISSEUR D’ABORD
      const supplier = parseOcrSupplier(combinedText);
      // ✅ AVIS BOUTIQUE — nombre d’avis
      const shopCount = extractShopReviewsCount(combinedText); 
        //finB
      if (shopCount != null) {
  supplier.shop_reviews = shopCount;
}

// ✅ AVIS BOUTIQUE — note (4.8 / 5)
      const shopRating = extractShopRatingFromSupplierBlock(combinedText);
      if (shopRating != null) {
  supplier.shop_rating = shopRating;
}

      // ✅ 2. ENSUITE on extrait les avis boutique (nombre)
      
      if (supplier.shop_rating == null && shopRating != null) {
        supplier.shop_rating = shopRating;
      }
      // ✅ 3. On injecte si trouvé
      if (shopCount != null) {
        supplier.shop_reviews = shopCount;
      }
      // ✅ Avis boutique (fallback si certains écrans n'affichent que le nombre)
      
      if (supplier.shop_reviews == null && shopCount != null) {
        supplier.shop_reviews = shopCount;
      }

      // 6) Fiabilité + UI pro
      const rel = computeReliability(supplier);
      const displayScore = Math.min(rel.score, 98);

      // ===== UI PRO (ta card Pro) =====
      const proCard = document.getElementById("pro-card");
      if (proCard) {
        proCard.hidden = false;

        const score = Number(displayScore || 0);
        const level = rel.label || "—";

        const elScore = document.getElementById("pro-score");
        const elLevel = document.getElementById("pro-level");
        const elBadge = document.getElementById("pro-badge");
        const elBar   = document.getElementById("pro-bar");

        if (elScore) elScore.textContent = String(score);
        if (elLevel) elLevel.textContent = String(level);
        animateProBadge();
        
        function levelIcon(lvl) {
          const t = String(lvl || "").toLowerCase();
          if (t.includes("très")) return "🛡️";
          if (t.includes("fiable")) return "✅";
          if (t.includes("moy")) return "⚠️";
          if (t.includes("risque")) return "❌";
          return "ℹ️";
        }
        if (elBadge) elBadge.textContent = `${levelIcon(level)} ${level}`;
        if (elBar) elBar.style.width = Math.max(0, Math.min(100, score)) + "%";
        
        animateProBadge(score);
        
        const elName    = document.getElementById("pro-name");
        const elCountry = document.getElementById("pro-country");
        const elDelivery= document.getElementById("pro-delivery");
        const elRating  = document.getElementById("pro-rating");
        const supplier = parseOcrSupplier(combinedText);

        const shopCount = extractShopReviewsCount(combinedText);
        if (supplier.shop_reviews == null && shopCount != null) supplier.shop_reviews = shopCount;

        const shopRating = extractShopRatingFromSupplierBlock(combinedText);
        if (supplier.shop_rating == null && shopRating != null) supplier.shop_rating = shopRating;
        if (elName) elName.textContent = supplier.name ? prettyName(supplier.name) : "—";
        if (elCountry) elCountry.textContent = supplier.country || "—";
        if (elDelivery) elDelivery.textContent = supplier.delivery_rate || "—";

        const ratingText =
          supplier.rating
            ? `${supplier.rating}/5${supplier.reviews ? ` (${supplier.reviews} avis)` : ""}`
            : "Aucun avis";
        if (elRating) elRating.textContent = ratingText;

        const ul = document.getElementById("pro-details");
        if (ul) {
          ul.innerHTML = "";
          (rel.details || []).slice(0, 10).forEach((d) => {
            const li = document.createElement("li");
            li.textContent = d;
            ul.appendChild(li);
          });
        }

        const tags = document.getElementById("pro-tags");
        if (tags) {
          tags.innerHTML = "";
          const addTag = (txt, cls) => {
            const s = document.createElement("span");
            s.className = "tag " + (cls || "");
            s.textContent = txt;
            tags.appendChild(s);
          };

          if (supplier.verified) addTag("Vérifié", "good");
          if (supplier.trade_assurance) addTag("Trade Assurance", "good");
          if (supplier.certifications?.length) addTag(`Certifs: ${supplier.certifications.length}`, "warn");
          if (supplier.founded_year && Number(supplier.founded_year) >= 2024) addTag("Entreprise récente", "bad");
        }
      }
      // ===== /UI PRO =====

      // 7) Résumé (COMPLET comme dans ton code)
      const resumeLines = [];

      if (supplier.name) resumeLines.push(`Fournisseur : ${prettyName(supplier.name)}`);
      if (Number(supplier.shop_reviews) > 0) {
        resumeLines.push(`Avis boutique : ${supplier.shop_reviews}`);
      }

      if (supplier.product_rating != null) resumeLines.push(`Note produit : ${supplier.product_rating}/5`);
      if (supplier.product_reviews != null) resumeLines.push(`Avis produit : ${supplier.product_reviews}`);

      if (supplier.shop_rating != null) resumeLines.push(`Note boutique : ${supplier.shop_rating}/5`);

      if (supplier.company_type) resumeLines.push(`Type : ${supplier.company_type}`);

      if (supplier.rating) {
        let l = `Note : ${supplier.rating}/5`;
        if (supplier.reviews) l += ` (${supplier.reviews} avis)`;
        resumeLines.push(l);
      }

      if (supplier.sold) resumeLines.push(`Vendus : ${supplier.sold}`);
      if (supplier.product_moq) resumeLines.push(`Commande minimale : ${supplier.product_moq}`);
      if (supplier.product_sample_price) resumeLines.push(`Prix échantillon : ${supplier.product_sample_price}`);

      if (supplier.delivery_rate) resumeLines.push(`Taux de livraison : ${supplier.delivery_rate}`);
      if (supplier.response_time) resumeLines.push(`Temps de réponse : ${supplier.response_time}`);

      if (supplier.country) resumeLines.push(`Pays : ${supplier.country}`);

      if (supplier.years_active) resumeLines.push(`Ancienneté Alibaba : ${supplier.years_active} an(s)`);
      if (supplier.founded_year) resumeLines.push(`Année de fondation : ${supplier.founded_year}`);
      if (supplier.factory_size) resumeLines.push(`Superficie : ${supplier.factory_size}`);
      if (supplier.employees) resumeLines.push(`Employés : ${supplier.employees}`);

      if (supplier.personalization) resumeLines.push(`Personnalisation : ${supplier.personalization}`);

      if (supplier.certification_details?.length) {
        const certs = supplier.certification_details.filter((c) => {
          if (c.type === "Certificate of Conformity" && !c.number) return false;
          return true;
        });

        certs.forEach((c) => {
          if (c.number) resumeLines.push(`Certificat ${c.type} : ${c.number}`);
          else resumeLines.push(`Certificat : ${c.type}`);
        });
      } else if (supplier.certifications?.length) {
        resumeLines.push(`Certifications : ${supplier.certifications.join(" • ")}`);
      }

      if (supplier.verified) resumeLines.push("Fournisseur vérifié : Oui");
      if (supplier.trade_assurance) resumeLines.push("Trade Assurance : Oui");

      safeSetText(
        ocrResumeEl,
        "----- Résumé détecté -----\n" +
          (resumeLines.length
            ? resumeLines.join("\n")
            : "Aucune information exploitable.")
      );

      // 8) Texte brut + bouton
      safeSetText(ocrRawEl, combinedRawText);
      safeShow(toggleOcrBtn);
      safeSetText(toggleOcrBtn, "📄 Voir le texte brut");

      // 9) Snapshot pour enregistrement/favoris
      lastOcrSnapshot = {
        supplierName: supplier.name || "",
        resumeText:
          (ocrResumeEl && ocrResumeEl.textContent) ? ocrResumeEl.textContent : "",
        rawText: combinedRawText || "",
        yearsActive: supplier.years_active || "",
        country: supplier.country || "",
      };

      console.log("SUPPLIER =", supplier);
      // IMPORTANT : snapshot global pour le bouton Enregistrer

      window.lastOcrSnapshot = {
  supplierName: supplier?.name ?  prettyName(supplier.name) : "",
  score: rel?.score ?? null,
  label: rel?.label || "",
  resumeText: (ocrResumeEl && ocrResumeEl.textContent)
    ? ocrResumeEl.textContent
    : "",
  rawText: combinedRawText || "",
  supplier: supplier || null
};
    /*safeSetText(ocrStatus, "✅ Analyse terminée");
      setSaveSectionVisible(true);
      updateOcrExportButtons();*/   // ✅ affiche seulement si autorisé + si snapshot existe
    safeSetText(ocrStatus, "✅ Analyse terminée");

    // 1) Consommer (après succès seulement)
    const used = consumeOcr();
    if (!used || used.ok === false) {
      if (typeof toast === "function") toast("❌ Erreur quota (consommation impossible)");
      return;
    }

    // 2) Droit Save/Export (trial/pack/sub = OK, free/jour = NON)
    const se = (typeof canSaveAndExport === "function")
      ? canSaveAndExport()              // { ok:true, mode:"sub|pack|trial" } ou { ok:false }
      : { ok: false };

    // 3) Marquer l’autorisation d’export dans le snapshot
    window.lastOcrSnapshot = window.lastOcrSnapshot || {};
    window.lastOcrSnapshot._exportAllowed = !!se.ok;

    // 4) Afficher / cacher le bloc Enregistrer (selon le droit, pas selon used.mode)
    if (typeof setSaveSectionVisible === "function") {
      setSaveSectionVisible(se.ok);
    }

    // 5) Mettre à jour les boutons PDF / Excel
    if (typeof updateOcrExportButtons === "function") {
      updateOcrExportButtons();
    }

    // 6) Rafraîchir UI
    if (typeof refreshPricingUI === "function") {
      refreshPricingUI();
    }
      

    
      
    
 
    // ✅ OCR terminé avec succès → on consomme UNE SEULE FOIS
     

    } catch (err) {
      console.error("ANALYSE ERROR:", err);

      const msg =
        (err && (err.message || (err.stack ? String(err.stack) : ""))) ||
        String(err) ||
        "Erreur inconnue";

      safeSetText(ocrStatus, "❌ Analyse impossible. Détail: " + msg);
      setSaveSectionVisible(false);
      return;
    }
  });
}

// ==============================
// OCR SAVE + HISTORIQUE — VERSION PROPRE & STABLE
// ==============================

// Storage key
const OCR_SAVE_KEY = "aliscan_ocr_records_v1";

// UI elements
const ocrSaveWrap   = document.getElementById("ocr-save-wrap");
const ocrLinkInput  = document.getElementById("ocr-link-input"); // input lien (optionnel)
const ocrNotesInput = document.getElementById("ocr-note");       // textarea notes
const ocrSaveBtn    = document.getElementById("ocr-save-btn");
const ocrSaveCancel = document.getElementById("ocr-save-cancel");
const ocrSaveMsg    = document.getElementById("ocr-save-msg");

const ocrRecordsListEl = document.getElementById("ocr-records-list");
const ocrClearBtn      = document.getElementById("ocr-clear-btn");

// ---------- utils ----------
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ⚠️ IMPORTANT : si extractFirstUrl existe déjà plus haut, NE PAS redéfinir.
// On utilise la fonction existante si elle est là.
function extractFirstUrlSafe(text) {
  if (typeof extractFirstUrl === "function") return extractFirstUrl(text);
  const t = String(text || "");
  const m = t.match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0] : "";
}

// Affiche/masque la zone d’enregistrement
function setSaveSectionVisible(show) {
  if (!ocrSaveWrap) return;
  ocrSaveWrap.hidden = !show;
  if (!show && ocrSaveMsg) ocrSaveMsg.textContent = "";
}

// localStorage helpers
function loadOcrRecords() {
  try {
    const raw = localStorage.getItem(OCR_SAVE_KEY);
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveOcrRecords(arr) {
  try {
    localStorage.setItem(OCR_SAVE_KEY, JSON.stringify(arr || []));
  } catch (e) {}
}

function formatDate(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

// ---------- Render liste ----------
function renderOcrRecords() {
  if (!ocrRecordsListEl) return;

  const items = loadOcrRecords();
  ocrRecordsListEl.innerHTML = "";

  if (!items.length) {
    ocrRecordsListEl.classList.add("empty");
    ocrRecordsListEl.textContent = "Aucun enregistrement.";
    return;
  }

  ocrRecordsListEl.classList.remove("empty");

  items.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "history-item";

    // -------- LEFT
    const left = document.createElement("div");
    left.className = "history-main";

    const title = document.createElement("div");
    title.className = "history-desc";
    const supplier = it?.supplierName || "Fournisseur";
    const score = (it?.score != null) ? `${it.score}/100` : "—";
    const label = it?.label ? ` (${it.label})` : "";
    title.textContent = `${supplier} — ${score}${label}`;

    const meta = document.createElement("div");
    meta.className = "history-meta";
    meta.textContent = `${formatDate(it?.ts)}${it?.link ? " • lien" : ""}${it?.notes ? " • notes" : ""}`;

    left.appendChild(title);
    left.appendChild(meta);

    if (it?.notes) {
      const notesPreview = document.createElement("div");
      notesPreview.style.marginTop = "6px";
      notesPreview.style.fontSize = "0.84rem";
      notesPreview.style.color = "#4b5563";
      const n = String(it.notes);
      notesPreview.textContent = n.length > 120 ? n.slice(0, 120) + "…" : n;
      left.appendChild(notesPreview);
    }

    // -------- RIGHT (boutons)
    const right = document.createElement("div");
    right.className = "history-date";

    if (it?.link) {
      const openBtn = document.createElement("button");
      openBtn.className = "secondary-btn";
      openBtn.type = "button";
      openBtn.textContent = "Ouvrir";
      openBtn.addEventListener("click", () => {
        window.open(it.link, "_blank", "noopener,noreferrer");
      });
      right.appendChild(openBtn);
    }

    const detailsBtn = document.createElement("button");
    detailsBtn.className = "secondary-btn";
    detailsBtn.type = "button";
    detailsBtn.textContent = "🧾 Détails";
    detailsBtn.style.marginLeft = "6px";
    right.appendChild(detailsBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "ghost-btn";
    delBtn.type = "button";
    delBtn.textContent = "Suppr.";
    delBtn.style.marginLeft = "6px";
    delBtn.addEventListener("click", () => {
      const arr = loadOcrRecords();
      arr.splice(idx, 1);
      saveOcrRecords(arr);
      renderOcrRecords();
    });
    right.appendChild(delBtn);

    // -------- HEADER
    const header = document.createElement("div");
    header.className = "history-item-header";
    header.appendChild(left);
    header.appendChild(right);
    row.appendChild(header);

    // ===============================
    // ✅ DETAILS BOX (caché)
    // ===============================
    const detailsBox = document.createElement("div");
    detailsBox.className = "details-box";
    detailsBox.hidden = true;

    // TOP : lien seulement
    const top = document.createElement("div");
    top.className = "details-top";

    const linkRow = document.createElement("div");
    linkRow.className = "details-top-row";

    if (it?.link) {
      const safeLink = escapeHtml(it.link);
      linkRow.innerHTML =
        `🔗 <span class="details-top-k">Lien :</span>
         <a class="details-link" href="${safeLink}" target="_blank" rel="noopener noreferrer">${safeLink}</a>`;
    } else {
      linkRow.innerHTML =
        `🔗 <span class="details-top-k">Lien :</span>
         <span class="details-top-v">—</span>`;
    }

    top.appendChild(linkRow);
    detailsBox.appendChild(top);

    // Titre Résumé
    const resumeTitle = document.createElement("div");
    resumeTitle.className = "details-title";
    resumeTitle.textContent = "📌 Résumé";
    detailsBox.appendChild(resumeTitle);

    // Notes sous Résumé
    const notesUnder = document.createElement("div");
    notesUnder.className = "details-notes-under";
    notesUnder.innerHTML =
      `📝 <span class="details-top-k">Notes :</span>
       <span class="details-top-v">${escapeHtml(it?.notes ? String(it.notes) : "—")}</span>`;
    detailsBox.appendChild(notesUnder);

    // Contenu résumé
    const rawResume = String(it?.resumeText || "").trim();
    const pairs = (typeof parseDetailPairs === "function") ? parseDetailPairs(rawResume) : [];

    if (pairs && pairs.length) {
      const grid = document.createElement("div");
      grid.className = "details-grid";

      pairs.slice(0, 18).forEach(p => {
        const r = document.createElement("div");
        r.className = "details-row";

        const k = document.createElement("div");
        k.className = "details-k";
        k.textContent = p.k;

        const v = document.createElement("div");
        v.className = "details-v";
        v.textContent = p.v;

        r.appendChild(k);
        r.appendChild(v);
        grid.appendChild(r);
      });

      detailsBox.appendChild(grid);
    } else {
      const pre = document.createElement("div");
      pre.className = "details-pre";
      pre.textContent = rawResume || "Aucun détail lisible.";
      detailsBox.appendChild(pre);
    }

    row.appendChild(detailsBox);

    // Toggle détails
    detailsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      detailsBox.hidden = !detailsBox.hidden;
    });

    ocrRecordsListEl.appendChild(row);
  });
}

// ---------- Effacer tout ----------
if (ocrClearBtn) {
  ocrClearBtn.addEventListener("click", (e) => {
    e.preventDefault();
    localStorage.removeItem(OCR_SAVE_KEY);
    renderOcrRecords();
  });
}

// ---------- Annuler ----------
if (ocrSaveCancel) {
  ocrSaveCancel.addEventListener("click", (e) => {
    e.preventDefault();
    setSaveSectionVisible(false);
    if (ocrLinkInput) ocrLinkInput.value = "";
    if (ocrNotesInput) ocrNotesInput.value = "";
    if (ocrSaveMsg) ocrSaveMsg.textContent = "";
  });
}

// ---------- Enregistrer ----------
if (ocrSaveBtn) {
  ocrSaveBtn.type = "button"; // évite submit si dans un <form>

  ocrSaveBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    try {
      const snap = window.lastOcrSnapshot;
      if (!snap) {
        if (ocrSaveMsg) ocrSaveMsg.textContent = "⚠️ Fais une analyse OCR avant d’enregistrer.";
        return;
      }

      const linkRaw = ocrLinkInput ? String(ocrLinkInput.value || "") : "";
      const cleanLink = extractFirstUrlSafe(linkRaw);

      const notes = ocrNotesInput ? String(ocrNotesInput.value || "").trim() : "";

      const record = {
        ts: Date.now(),
        supplierName: snap.supplierName || "",
        score: snap.score ?? null,
        label: snap.label || "",
        resumeText: snap.resumeText || "",
        rawText: snap.rawText || "",
        supplier: snap.supplier || null,
        link: cleanLink || "",
        notes: notes || ""
      };

      const arr = loadOcrRecords();
      arr.unshift(record);
      if (arr.length > 50) arr.length = 50;
      saveOcrRecords(arr);

      renderOcrRecords();

      if (ocrSaveMsg) ocrSaveMsg.textContent = "✅ Enregistré.";
      if (ocrLinkInput) ocrLinkInput.value = "";
      if (ocrNotesInput) ocrNotesInput.value = "";

      // consommer le snapshot
      window.lastOcrSnapshot = null;

      setSaveSectionVisible(false);

      // optionnel : reset UI si ta fonction existe
      if (typeof resetOcrUI === "function") resetOcrUI();

    } catch (err) {
      console.error("❌ SAVE ERROR:", err);
      if (ocrSaveMsg) ocrSaveMsg.textContent = "❌ Erreur lors de l’enregistrement.";
    }
  }, true);
}

// Render au chargement
renderOcrRecords();



  


    
 
    
    

// ----- Toggle texte brut OCR -----
if (toggleOcrBtn && ocrRawEl) {
  toggleOcrBtn.addEventListener("click", () => {
    const visible = !ocrRawEl.hidden;
    ocrRawEl.hidden = visible;
    toggleOcrBtn.textContent = visible
      ? "📄 Voir le texte brut"
      : "🙈 Masquer le texte brut";
  });
}
  




    

// Carte résultat
const resultCard    = document.getElementById("result-card");
const resultTitle   = document.getElementById("result-title");
const resultShop    = document.getElementById("result-shop");
const resultCountry = document.getElementById("result-country");
const resultSource  = document.getElementById("result-source");

// Blocs produit / fournisseur
const productBlock   = document.getElementById("product-block");
const productTitle   = document.getElementById("product-title");
const productPrice   = document.getElementById("product-price");
const productExtra   = document.getElementById("product-extra");
const productRanges  = document.getElementById("product-ranges");

const supplierBlock  = document.getElementById("supplier-block");
const supplierName   = document.getElementById("supplier-name");
const supplierLine1  = document.getElementById("supplier-line1");
const supplierLine2  = document.getElementById("supplier-line2");
const supplierLine3  = document.getElementById("supplier-line3");
const supplierExtra  = document.getElementById("supplier-extra");
const supplierCountry     = document.getElementById("supplier-country");
const supplierVerifiedEl  = document.getElementById("supplier-verified");
const supplierFactorySize = document.getElementById("supplier-factory-size");
const supplierEmployeesEl = document.getElementById("supplier-employees");
const supplierFoundedEl   = document.getElementById("supplier-founded");
const supplierTradeEl     = document.getElementById("supplier-trade-assurance");

// Liens / actions
const supplierLink       = document.getElementById("supplier-link");
const resultLink         = document.getElementById("result-link");
const verifySupplierBtn  = document.getElementById("verify-supplier-btn");

// Pour garder le fournisseur courant (nom)
let currentSupplierForCheck = null;
let currentSupplierProfileUrl = null;

// Historique liens
const historyList     = document.getElementById("history-list");
const clearHistoryBtn = document.getElementById("clear-history");

function setLoading(isLoading) {
  if (!analyseBtn || !loader) return;
  analyseBtn.disabled = isLoading;
  loader.hidden = !isLoading;
  analyseBtn.textContent = isLoading ? "Analyse en cours..." : "Analyser le lien";
}

function showError(msg) {
  if (!errorText) return;
  if (msg) {
    errorText.textContent = msg;
    errorText.hidden = false;
  } else {
    errorText.textContent = "";
    errorText.hidden = true;
  }
}

// --- affichage bloc produit ---

function fillProductBlock(product) {
  if (!productBlock) return;

  const p = product || {};

  const title =
    cleanText(p.title) || cleanText(p.name) || "Produit analysé";

  const priceRanges = Array.isArray(p.price_ranges) ? p.price_ranges : [];

  // Prix
  let priceText = "";
  if (priceRanges.length) {
    priceText = priceRanges.join(" • ");
  } else if (p.price_min && p.price_max && p.price_min !== p.price_max) {
    priceText = `Prix : ${p.price_min} – ${p.price_max} ${p.currency || ""}`;
  } else if (p.price) {
    priceText = `Prix : ${p.price} ${p.currency || ""}`.trim();
  } else if (p.moq) {
    priceText = `Quantité minimale : ${p.moq}`;
  }

  // Infos supplémentaires
  let extraText = "";
  if (p.rating)  extraText += `Note : ${p.rating}/5`;
  if (p.reviews) extraText += (extraText ? " • " : "") + `${p.reviews} avis`;
  if (p.sold)    extraText += (extraText ? " • " : "") + `${p.sold} vendus`;

  // Injection dans le HTML
  productTitle.textContent  = title;
  productPrice.textContent  = priceText;
  productExtra.textContent  = extraText;
  productRanges.textContent =
    !priceRanges.length ? "" : `Tranches : ${priceRanges.join(" • ")}`;

  const hasInfo = title || priceText || extraText || priceRanges.length;
  productBlock.hidden = !hasInfo;
}

// --- affichage bloc fournisseur ---

  function fillSupplierBlock(supplier) {
    if (!supplierBlock) return;

    const s = supplier || {};
    const name = cleanText(s.name) || "Fournisseur Alibaba";

    // 🧩 Ligne 1 : infos principales + vérifié
    const parts1 = [];
    if (s.country)       parts1.push(`Pays : ${s.country}`);
    if (s.business_type) parts1.push(`Type : ${s.business_type}`);
    if (s.trade_assurance) parts1.push(`Trade Assurance active`);
    if (s.verified)      parts1.push(`Fournisseur vérifié ✅`);
    const line1 = parts1.join(" • ");

    // 🧩 Ligne 2 : note + avis + rang
    const parts2 = [];
    if (s.rating)        parts2.push(`Note : ${s.rating}/5`);
    if (s.reviews)       parts2.push(`${s.reviews} avis`);
    if (s.supplier_rank) parts2.push(`Rang : ${s.supplier_rank}`);
    const line2 = parts2.join(" • ");

    // 🧩 Ligne 3 : livraison / réponse
    const parts3 = [];
    if (s.delivery_rate) parts3.push(`Livraison à temps : ${s.delivery_rate}`);
    if (s.response_rate) parts3.push(`Taux de réponse : ${s.response_rate}`);
    if (s.response_time) parts3.push(`Délai de réponse : ${s.response_time}`);
    const line3 = parts3.join(" • ");

    // 🧩 Extra
    const extraParts = [];
    if (s.years_active)  extraParts.push(`${s.years_active} ans sur Alibaba`);
    if (s.founded_year)  extraParts.push(`Fondé en ${s.founded_year}`);
    if (s.employees)     extraParts.push(`${s.employees} employés`);
    if (s.factory_size || s.factory_area)
      extraParts.push(`Superficie : ${s.factory_size || s.factory_area}`);
    if (s.online_revenue || s.export_revenue)
      extraParts.push(`Recettes en ligne : ${s.online_revenue || s.export_revenue}`);
    if (s.brand_count)   extraParts.push(`${s.brand_count} marques propres`);
    if (Array.isArray(s.services) && s.services.length)
      extraParts.push(`Services : ${s.services.join(", ")}`);
    const extra = extraParts.join(" • ");
    
    
    // 💡 Remplir le bloc
    supplierName.textContent  = name;
    supplierLine1.textContent = line1;
    supplierLine2.textContent = line2;
    supplierLine3.textContent = line3;
    supplierExtra.textContent = extra;

    const hasInfo = name || line1 || line2 || line3 || extra;
    supplierBlock.hidden = !hasInfo;

    // Pour Google etc.
    currentSupplierForCheck   = hasInfo ? s : null;
    currentSupplierProfileUrl = s.profile_url || null;

    // 📝 Bouton "Analyser l’entreprise" (ancien "Voir le fournisseur")
    if (supplierLink) {
      if (!s.name) {
        // pas de nom → on cache le bouton
        supplierLink.hidden = true;
        supplierLink.onclick = null;
      } else {
        supplierLink.hidden = false;
        supplierLink.textContent = "📝 Analyser l’entreprise";
        supplierLink.href = "#";
        supplierLink.target = "_self";

        supplierLink.onclick = (e) => {
          e.preventDefault();

          alert(
            "Pour analyser l’entreprise :\n\n" +
            "1️⃣ Ouvre la page du fournisseur sur Alibaba.\n" +
            "2️⃣ Copie l’URL de son profil.\n" +
            "3️⃣ Reviens sur Aliscan Pro, colle ce lien dans la zone d’analyse,\n" +
            "   puis appuie sur « Analyser le lien »."
          );

          // On remet le focus sur le champ d’analyse de lien
          if (urlInput) {
            urlInput.focus();
            urlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        };
      }
    }
  }

// --- Alerte limitée pour les avis (max 5 fois) ---
function showLimitedReviewsAlert() {
    let count = parseInt(localStorage.getItem("reviews_alert_count") || "0");

    if (count < 5) {
        alert("ℹ️ Astuce : une fois sur Alibaba, clique sur les avis du produit pour consulter et vérifier les commentaires.");
        count++;
        localStorage.setItem("reviews_alert_count", count);
    }
}

// --- affichage résultat global ---

  // --- affichage résultat global ---
  function displayResult(data) {
    if (!resultCard) return;

    const description = cleanText(data.description) || "Produit analysé";
    const shopLabel   = data.shop_label || data.shop || "Boutique inconnue";
    const country     = data.country || "global";
    const source      = data.source || "url";

    if (resultTitle)   resultTitle.textContent   = description;
    if (resultShop)    resultShop.textContent    = "Boutique : " + shopLabel;
    if (resultCountry) resultCountry.textContent = "Pays : " + country;
    if (resultSource)  resultSource.textContent  = "Source : " + source;

    if (resultLink) {
      resultLink.href   = data.url || "#";
      resultLink.target = "_blank";
    }

    // Bloc produit & fournisseur
    fillProductBlock(data.product || {});
    fillSupplierBlock(data.supplier || {});

    // ⭐ Bouton "Voir les avis sur Alibaba" (ouvre la page produit)
    const reviewsBtn = document.getElementById("product-reviews-btn");
    if (reviewsBtn) {
      if (data.shop === "alibaba" && data.url) {
        reviewsBtn.hidden = false;

        if (reviewsBtn.tagName === "A") {
          // Lien <a>: on met le href et on affiche l’alerte (max 5 fois)
          reviewsBtn.href = data.url;
          reviewsBtn.target = "_blank";
          reviewsBtn.onclick = () => {
            showLimitedReviewsAlert();
            // on laisse le lien fonctionner normalement
          };
        } else {
          // Bouton classique
          reviewsBtn.onclick = (e) => {
            e.preventDefault();
            showLimitedReviewsAlert();
            window.open(data.url, "_blank");
          };
        }
      } else {
        // Pas Alibaba ou pas d’URL → on cache le bouton
        reviewsBtn.hidden = true;

        // On enlève le href et l'onclick pour éviter l’ancienne recherche Google
        if (reviewsBtn.tagName === "A") {
          reviewsBtn.removeAttribute("href");
          reviewsBtn.removeAttribute("target");
        }
        reviewsBtn.onclick = null;
      }
    }

    resultCard.hidden = false;
    }


// --- Historique liens ---

const HISTORY_KEY = "aliscan_history";

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(list) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list || []));
}

function addToHistory(item) {
  const history = loadHistory();
  history.unshift(item);
  const trimmed = history.slice(0, 20);
  saveHistory(trimmed);
  renderHistory();
}

function renderHistory() {
  if (!historyList) return;
  const history = loadHistory();

  historyList.innerHTML = "";

  if (!history.length) {
    historyList.classList.add("empty");
    historyList.innerHTML =
      '<p class="history-empty">Aucun lien analysé pour l’instant. Colle un lien ci-dessus pour commencer 👆</p>';
    return;
  }

  historyList.classList.remove("empty");

  history.forEach((item) => {
    const div = document.createElement("div");
    div.className = "history-item";

    div.innerHTML = `  
      <div class="history-main">  
        <div class="history-desc">${item.description}</div>  
        <div class="history-meta">  
          ${item.shop_label} • ${item.country}  
        </div>  
      </div>  
      <div class="history-meta history-date">  
        ${item.date}  
      </div>  
    `;

    div.addEventListener("click", () => {  
      if (!resultCard) return;  
      if (resultTitle)   resultTitle.textContent   = item.description;  
      if (resultShop)    resultShop.textContent    = "Boutique : " + item.shop_label;  
      if (resultCountry) resultCountry.textContent = "Pays : " + item.country;  
      if (resultSource)  resultSource.textContent  = "Source : " + (item.source || "url");  
      if (resultLink) {  
        resultLink.href   = item.url || "#";  
        resultLink.target = "_blank";  
      }  
      if (productBlock)  productBlock.hidden  = true;  
      if (supplierBlock) supplierBlock.hidden = true;  
      resultCard.hidden = false;  
    });

    historyList.appendChild(div);
  });
}

// --------------------------------------------------
// Analyse d’un lien
// --------------------------------------------------

async function handleAnalyse() {
  showError("");
  if (resultCard)   resultCard.hidden   = true;
  if (productBlock) productBlock.hidden = true;
  if (supplierBlock) supplierBlock.hidden = true;

  const raw = urlInput ? urlInput.value.trim() : "";
  if (!raw) {
    showError("Colle d’abord un lien de produit.");
    return;
  }

  setLoading(true);

  try {
    const form = new FormData();
    form.append("url", raw);

    const resp = await fetch("/analyse", {
      method: "POST",
      body: form,
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || "Erreur serveur.");
    }

    // Affiche résultat principal
    displayResult(data);

    // Ajouter à l’historique
    const now = new Date();
    const dateStr =
      now.toLocaleDateString() + " " + now.toLocaleTimeString().slice(0, 5);

    addToHistory({
      url: data.url || raw,
      description: cleanText(data.description) || "Produit analysé",
      shop: data.shop || "",
      shop_label: data.shop_label || data.shop || "Alibaba",
      country: data.country || "global",
      source: data.source || "url",
      date: dateStr,
    });
  } catch (err) {
    console.error(err);
    showError(err.message || "Erreur pendant l’analyse.");
  } finally {
    setLoading(false);
  }
}

// --------------------------------------------------
// Vérifier l’entreprise : recherche Google
// --------------------------------------------------

function handleVerifySupplier() {
  if (!currentSupplierForCheck || !currentSupplierForCheck.name) {
    alert("Aucun nom de fournisseur à vérifier.");
    return;
  }

  const rawName = String(currentSupplierForCheck.name || "").trim();
  if (!rawName) {
    alert("Nom de fournisseur vide.");
    return;
  }

  alert(
    "Recherche Google du fournisseur pour vérifier son existence réelle " +
    "et trouver d'éventuels avis."
  );

  const q   = encodeURIComponent(rawName + " Alibaba");
  const url = "https://www.google.com/search?q=" + q;

  window.open(url, "_blank");
}

// --------------------------------------------------
// Events analyse
// --------------------------------------------------

if (analyseBtn) {
  analyseBtn.addEventListener("click", handleAnalyse);
}
if (urlInput) {
  urlInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAnalyse();
    }
  });
}
if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener("click", () => {
    saveHistory([]);
    renderHistory();
  });
}

if (verifySupplierBtn) {
  verifySupplierBtn.addEventListener("click", handleVerifySupplier);
}

// --------------------------------------------------
// 3) CALCULATEUR DE COÛT (UNE SEULE DEVISE)
// --------------------------------------------------

// Champs texte
const calcProductName   = document.getElementById("calc-product-name");
const calcSupplierName  = document.getElementById("calc-supplier-name");
const calcSupplierLink  = document.getElementById("calc-supplier-link");
const calcCurrency      = document.getElementById("calc-currency");
const calcCurrencyInfo  = document.getElementById("calc-currency-info");

// Modes de calcul (total vs détail)
const calcModeRadios       = document.querySelectorAll("input[name='calc-mode']");
const calcModeTotalPanel   = document.getElementById("calc-mode-total");
const calcModeDetailPanel  = document.getElementById("calc-mode-detail");
const costHistoryList = document.getElementById("cost-history-list");
const clearCostHistory = document.getElementById("clear-cost-history");
const saveCostBtn = document.getElementById("cost-save-btn");
const rawSupplierLink =
  document.getElementById("supplier-link")?.value?.trim() || "";
const saveMarginBtn = document.getElementById("margin-save-btn");
const marginActionsEl = document.getElementById("margin-actions");

  


// Champs produits
const calcProductsTotal = document.getElementById("calc-products-total");
const calcPriceUnit     = document.getElementById("calc-price-unit");
const calcQty           = document.getElementById("calc-qty");



// Livraison locale
const calcLocalDelivery = document.getElementById("calc-local-delivery");

// Transport
const calcShipModeRadios = document.querySelectorAll("input[name='calc-ship-mode']");
const calcShipKgBlock    = document.getElementById("calc-ship-kg");
const calcShipCbmBlock   = document.getElementById("calc-ship-cbm");
const calcShipFixeBlock  = document.getElementById("calc-ship-fixe");

const calcPricePerKg   = document.getElementById("calc-price-per-kg");
const calcWeightKg     = document.getElementById("calc-weight-kg");
const calcPricePerCbm  = document.getElementById("calc-price-per-cbm");
const calcVolumeCbm    = document.getElementById("calc-volume-cbm");
const calcShipFixed    = document.getElementById("calc-ship-fixed");

// Taxes
const calcTaxes        = document.getElementById("calc-taxes");

// Résultat
const calcRunBtn       = document.getElementById("calc-run");
console.log("calcRunBtn =", calcRunBtn);

if (calcRunBtn) {
  calcRunBtn.addEventListener("click", (e) => {
    e.preventDefault();
    console.log("CLICK calc-run -> runCalculator()");
    runCalculator();
  });
} else {
  console.warn("calcRunBtn introuvable ❌");
}
const calcResetBtn     = document.getElementById("calc-reset");

const calcLineProducts = document.getElementById("calc-line-products");
const calcLineLocal    = document.getElementById("calc-line-local");
const calcLineShipping = document.getElementById("calc-line-shipping");
const calcLineTotalLoc = document.getElementById("calc-line-total-local");
const calcLineTaxes    = document.getElementById("calc-line-taxes");
const calcLineFinal    = document.getElementById("calc-line-final");
const calcResultEl  = document.getElementById("calc-result");
const costActionsEl = document.getElementById("cost-actions");
if (calcResultEl)  calcResultEl.hidden = true;
if (costActionsEl) costActionsEl.hidden = true;

// Historique des calculs
const calcHistoryList   = document.getElementById("calc-history-list");
const clearCalcHistory  = document.getElementById("clear-calc-history");
const CALC_HISTORY_KEY  = "aliscan_calc_history";

// --- texte "Tous les montants en XXX" ---
if (calcCurrency && calcCurrencyInfo) {
  const updateCurrencyInfo = () => {
    const cur = (calcCurrency.value || "").trim() || "XOF";
    calcCurrencyInfo.textContent =
      "Tous les montants ci-dessous doivent être saisis en " + cur + ".";
  };
  calcCurrency.addEventListener("input", updateCurrencyInfo);
  updateCurrencyInfo();
}

// --- panneaux mode total / détail ---
function updateCalcModePanel() {
  let mode = "total";
  calcModeRadios.forEach((r) => {
    if (r.checked) mode = r.value;
  });

  if (calcModeTotalPanel)  calcModeTotalPanel.hidden  = (mode !== "total");
  if (calcModeDetailPanel) calcModeDetailPanel.hidden = (mode !== "detail");
}
if (calcModeRadios.length) {
  calcModeRadios.forEach((r) => {
    r.addEventListener("change", updateCalcModePanel);
  });
  updateCalcModePanel();
}

// --- champs transport selon le mode ---
function updateShipModeVisibility() {
  if (!calcShipModeRadios) return;

  let mode = "kg";
  calcShipModeRadios.forEach((r) => {
    if (r.checked) mode = r.value;
  });

  if (calcShipKgBlock)   calcShipKgBlock.style.display   = (mode === "kg"   ? "flex" : "none");
  if (calcShipCbmBlock)  calcShipCbmBlock.style.display  = (mode === "cbm"  ? "flex" : "none");
  if (calcShipFixeBlock) calcShipFixeBlock.style.display = (mode === "fixe" ? "flex" : "none");
}
updateShipModeVisibility();
if (calcShipModeRadios.length) {
  calcShipModeRadios.forEach((r) => {
    r.addEventListener("change", updateShipModeVisibility);
  });
}

// --- nettoyage automatique du lien fournisseur ---
if (calcSupplierLink) {
  calcSupplierLink.addEventListener("blur", () => {
    const raw = String(calcSupplierLink.value || "").trim();
    if (!raw) return;

    // Cherche une URL dans le texte
    const urlMatch = raw.match(
      /https?:\/\/\S+|www\.\S+|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\/\S*/
    );

    if (!urlMatch) return;

    let url = urlMatch[0];

    // Si l’URL ne commence pas par http, on ajoute https://
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }

    // On nettoie quelques caractères parasites à la fin
    url = url.replace(/[)\],.;]+$/, "");

    calcSupplierLink.value = url;
  });
}

// --- historique calculs ---
// ===============================
// HISTORIQUE DES CALCULS (localStorage)
// ===============================


// Renvoie toujours un tableau


function loadCalcHistory() {
  try {
    return JSON.parse(localStorage.getItem(CALC_HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveCalcHistory(list) {
  localStorage.setItem(
    CALC_HISTORY_KEY,
    JSON.stringify(list || [])
  );
}

// Ajoute un item au début, garde max 30, sauvegarde, puis refresh UI
function addCalcHistoryItem(item) {
  const list = loadCalcHistory();
  list.unshift(item);
  const trimmed = list.slice(0, 30);
  saveCalcHistory(trimmed);
  renderCalcHistory();
}

function renderCalcHistory() {
  //alert("renderCalcHistory exécuté");
  // alert("renderCalcHistory -> calcHistoryList = " + (calcHistoryList ? "OK" : "NULL"));
  if (!calcHistoryList) return;

  const list = loadCalcHistory();

  // Aucun calcul
  if (list.length === 0) {
    calcHistoryList.classList.add("empty");
    calcHistoryList.innerHTML = `
      <p class="history-empty">
        Aucun calcul enregistré pour l’instant. Fais un calcul pour le voir ici 👇
      </p>
    `;
    return;
  }

  calcHistoryList.classList.remove("empty");
  calcHistoryList.innerHTML = "";

  list.forEach((item) => {
    const div = document.createElement("div");
    div.className = "history-item";

    const supplier = item.supplierName || "Fournisseur inconnu";
    const product = item.productName || "Sans nom de produit";
    const currency = item.currency || "";
    const date = item.date || "";

    // total formaté
    const isMargin = item.type === "margin";

    // lien fournisseur
    let linkHtml = "";
    if (item.supplierLink) {
      linkHtml = `
        <a class="supplier-btn"
           href="${item.supplierLink}"
           target="_blank"
           rel="noopener">
           Voir le fournisseur
        </a>`;
    }

    // texte à droite (coût ou marge)
    // format nombre (0 décimales)
    const fmt = (v) =>
      new Intl.NumberFormat("fr-FR", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
      }).format(Number(v || 0));

    // texte à droite (marge uniquement)
    let rightText = "";

    if (isMargin) {
      rightText =
        `${fmt(item.marginTotal)} ${currency}\n(${Number(item.marginRate || 0).toFixed(1)} %)`;
    }

    // ===============================
// CONTENU PRINCIPAL
// ===============================
      div.innerHTML = `
  <div class="history-main">
    <div class="history-desc"><b>${supplier}</b></div>
    <div class="history-desc">${product}</div>
    ${linkHtml}
  </div>

  <div class="history-meta">
    <div class="history-date">${date}</div>
    <div class="history-total">${rightText}</div>
  </div>
`;

// ===============================
// DÉTAILS (COST + MARGIN)
// ===============================
const detailsDiv = document.createElement("div");

// ✅ DÉTAILS POUR COST
if (item.type === "cost") {
  detailsDiv.innerHTML = `
    <div class="history-details">
      <div class="history-section-title">Détails du coût</div>
      <div>Produits : ${fmt(item.productsTotal)} ${currency}</div>
      <div>Livraison locale : ${fmt(item.localFees)} ${currency}</div>
      <div>Transport international : ${fmt(item.shipping)} ${currency}</div>
      <div>Total hors taxes : ${fmt(
        (item.productsTotal || 0) +
        (item.localFees || 0) +
        (item.shipping || 0)
      )} ${currency}</div>
      <div>Taxes / douane : ${
        item.taxesPct ? item.taxesPct + " %" : "non renseignées"
      }</div>
      <div><b>TOTAL FINAL : ${fmt(item.totalFinal)} ${currency}</b></div>
    </div>
  `;
}

// ✅ DÉTAILS POUR MARGIN (ton bloc actuel)
if (item.type === "margin") {
  detailsDiv.innerHTML = `
    <div class="history-details">
      <div class="history-section-title">Résultat du calcul</div>
      <div>Produits : ${fmt(item.productsTotal)} ${currency}</div>
      <div>Livraison locale : ${fmt(item.localFees)} ${currency}</div>
      <div>Transport international : ${fmt(item.shipping)} ${currency}</div>
      <div>Total hors taxes : ${fmt(
        (item.productsTotal || 0) +
        (item.localFees || 0) +
        (item.shipping || 0)
      )} ${currency}</div>
      <div>Taxes / douane : ${
        item.taxesPct ? item.taxesPct + " %" : "non renseignées"
      }</div>
      <div><b>TOTAL FINAL : ${fmt(item.totalFinal)} ${currency}</b></div>

      <hr />

      <div class="history-section-title">Résultat marge</div>
      <div>Prix de vente (unité) : ${fmt(item.salePriceUnit)} ${currency}</div>
      <div>Quantité : ${item.qty}</div>
      <div>Coût unitaire : ${fmt(item.costUnit)} ${currency}</div>
      <div>Marge unitaire : ${fmt(item.marginUnit)} ${currency}</div>
      <div><b>Marge totale : ${fmt(item.marginTotal)} ${currency}</b></div>
      <div><b>TAUX DE MARGE : ${Number(item.marginRate || 0).toFixed(1)} %</b></div>
    </div>
  `;
}

// ⬇️ TOUJOURS APRÈS innerHTML
div.appendChild(detailsDiv);

// ⬇️ TOUJOURS À LA FIN
calcHistoryList.appendChild(div);
  });
}

if (clearCalcHistory) {
  clearCalcHistory.addEventListener("click", () => {
    saveCalcHistory([]);
    renderCalcHistory();
  });
}

// --- reset du calculateur ---
function resetCalculator() {
  // vider les champs
  [
    calcProductsTotal,
    calcPriceUnit,
    calcQty,
    calcLocalDelivery,
    calcPricePerKg,
    calcWeightKg,
    calcPricePerCbm,
    calcVolumeCbm,
    calcShipFixed,
    calcTaxes,
  ].forEach((el) => {
    if (el) el.value = "";
  });

  // radios calcul par défaut
  if (calcModeRadios.length) {
    calcModeRadios.forEach((r) => (r.checked = r.value === "total"));
    updateCalcModePanel();
  }

  // transport par défaut
  if (calcShipModeRadios.length) {
    calcShipModeRadios.forEach((r) => (r.checked = r.value === "kg"));
    updateShipModeVisibility();
  }

  // cacher résultat + actions
  if (calcResultEl) calcResultEl.hidden = true;
  if (costActionsEl) costActionsEl.hidden = true;

  if (typeof showCalcExportButtons === "function") {
    showCalcExportButtons(false, "cost");
    showCalcExportButtons(false, "margin");
  }

  // reset marge (sans crash)
  if (marginBox) marginBox.hidden = true;
  if (marginResult) marginResult.hidden = true;

  if (salePriceUnitEl) salePriceUnitEl.value = "";
  if (saleQtyEl) saleQtyEl.value = "";

  lastCalc.totalFinal = 0;
  lastCalc.qtySuggested = 0;

  window.lastCostSnapshot = null;
  window.lastMarginSnapshot = null;
}

// --- calcul principal ---
  function runCalculator() {
    console.log("runCalculator() start", { calcResultEl });

    if (!calcResultEl) {
      alert("calcResultEl introuvable");
      return;
    }

    

  const cur = (calcCurrency && calcCurrency.value
    ? calcCurrency.value.trim()
    : "XOF") || "XOF";

  // 1) Produits
  const totalFromSupplier = parseNumberInput(calcProductsTotal);
  let productsTotal = 0;
  let modeUsed = "detail";

  if (totalFromSupplier > 0) {
    productsTotal = totalFromSupplier;
    modeUsed = "total";
  } else {
    const unit = parseNumberInput(calcPriceUnit);
    const qty  = parseNumberInput(calcQty);
    productsTotal = unit * qty;
    modeUsed = "detail";
  }

  if (productsTotal <= 0) {
    toast("Renseigne au moins un montant pour les produits (total ou prix unitaire + quantité).");
    return;
  }

  // 2) Livraison locale
  const localFees = parseNumberInput(calcLocalDelivery);

  // 3) Transport international
  let shipMode = "kg";
  calcShipModeRadios.forEach((r) => {
    if (r.checked) shipMode = r.value;
  });

  let shipping = 0;
  if (shipMode === "kg") {
    const pKg = parseNumberInput(calcPricePerKg);
    const wKg = parseNumberInput(calcWeightKg);
    shipping = pKg * wKg;
  } else if (shipMode === "cbm") {
    const pCbm = parseNumberInput(calcPricePerCbm);
    const vCbm = parseNumberInput(calcVolumeCbm);
    shipping = pCbm * vCbm;
  } else if (shipMode === "fixe") {
    shipping = parseNumberInput(calcShipFixed);
  }

  // 4) Total hors taxes
  const totalBase = productsTotal + localFees + shipping;

  // 5) Taxes
  let taxesPct = 0;
  if (calcTaxes && String(calcTaxes.value).trim() !== "") {
    taxesPct = parseNumberInput(calcTaxes);
  }
  const taxesAmount = totalBase * (taxesPct / 100);
  const finalTotal  = totalBase + taxesAmount;

  const fmt = (v) =>
    Number(v).toLocaleString("fr-FR", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });

  if (calcLineProducts)
    calcLineProducts.textContent = `Produits : ${fmt(productsTotal)} ${cur}`;
  if (calcLineLocal)
    calcLineLocal.textContent    = `Livraison locale : ${fmt(localFees)} ${cur}`;
  if (calcLineShipping)
    calcLineShipping.textContent = `Transport international : ${fmt(shipping)} ${cur}`;
  if (calcLineTotalLoc)
    calcLineTotalLoc.textContent = `Total hors taxes : ${fmt(totalBase)} ${cur}`;
  if (calcLineTaxes)
    calcLineTaxes.textContent =
      taxesPct > 0
        ? `Taxes / douane : ${taxesPct.toFixed(2)} % • ${fmt(taxesAmount)} ${cur}`
        : `Taxes / douane : non renseignées`;

  if (calcLineFinal)
    calcLineFinal.textContent = `TOTAL FINAL : ${fmt(finalTotal)} ${cur}`;

  calcResultEl.hidden = false;
    // 📸 SNAPSHOT DU COÛT
    

    window.lastCostSnapshot = {
      type: "cost",
      date: new Date().toLocaleDateString() + " " + new Date().toLocaleTimeString().slice(0,5),

      supplierName: document.getElementById("calc-supplier-name")?.value?.trim() || "Fournisseur habituel",
      productName: document.getElementById("calc-product-name")?.value?.trim() || "Sans nom",
      supplierLink: document.getElementById("calc-supplier-link")?.value?.trim() || "",
      currency: document.getElementById("calc-currency")?.value?.trim() || "XOF",

      productsTotal,
      localFees,
      shipping,
      taxesPct,
      taxesAmount,
      totalFinal: finalTotal
    };
    
  //🔗 Active le calcul de marge
  let qtySuggested = 0;

  if (modeUsed === "detail") {
  qtySuggested = parseNumberInput(calcQty);
}

  onCostCalculated(finalTotal, cur, qtySuggested);
  document.getElementById("cost-actions")?.removeAttribute("hidden");
document.getElementById("cost-save-btn")?.removeAttribute("hidden");
    
  // Historique calculs
  
  const now = new Date();
const dateStr =
  now.toLocaleDateString() + " " + now.toLocaleTimeString().slice(0, 5);


    window.lastCostSnapshot = {
      supplierName: document.getElementById("calc-supplier-name")?.value?.trim() || "Fournisseur habituel",
      productName: document.getElementById("calc-product-name")?.value?.trim() || "Sans nom",
      supplierLink: document.getElementById("calc-supplier-link")?.value?.trim() || "",

      productsTotal,
      localFees,
      shipping,
      taxesPct,
      taxesAmount,
      totalFinal: finalTotal,
      currency: cur
    };

    // ✅ Garde aussi une copie dans lastSavedCalculation
    lastSavedCalculation.totalFinal = finalTotal;
    lastSavedCalculation.currency = cur;


    // ✅ Infos produit / fournisseur
    lastSavedCalculation.productName =
      document.getElementById("product-name")?.value || "";

    lastSavedCalculation.supplierName =
      document.getElementById("supplier-name")?.value || "";

// extrait uniquement l’URL si l’utilisateur colle un texte Alibaba
    const rawSupplierLink =
      document.getElementById("calc-supplier-link")?.value?.trim() || "";

    lastSavedCalculation.supplierLink =
      rawSupplierLink.match(/https?:\/\/[^\s]+/)?.[0] || "";

  // ✅ Affiche boutons export (coût)

  if (calcResultEl) calcResultEl.hidden = false;
  if (costActionsEl) costActionsEl.hidden = false;
}




//=====================================================
// ✅ MARGE — BLOC FINAL (REMPLACE TON ANCIEN BLOC)
// =====================================================

// ===== Helpers marge

function toNum(v) {
  const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function fmtMoney(n, currency) {
  return Number(n || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }) + " " + (currency || "");
}

// ===== Elements marge (IDs HTML requis)
const marginBox       = document.getElementById("margin-box");
const salePriceUnitEl = document.getElementById("sale-price-unit");
const saleQtyEl       = document.getElementById("sale-qty");
const marginRunBtn    = document.getElementById("margin-run");
const marginResult    = document.getElementById("margin-result");
const lineCostUnit    = document.getElementById("line-cost-unit");
const lineMarginUnit  = document.getElementById("line-margin-unit");
const lineMarginTotal = document.getElementById("line-margin-total");
const lineMarginRate  = document.getElementById("line-margin-rate");
// ===== Alerte marge =====
const marginAlert = document.getElementById("margin-alert");
const marginAlertTitle = document.getElementById("margin-alert-title");
const marginAlertText = document.getElementById("margin-alert-text");

const costSaveBtn = document.getElementById("cost-save-btn");





function showMarginAlert(marginTotal, marginRate, costUnit, saleUnit){
  if (!marginAlert) return;

  marginAlert.hidden = false;
  marginAlert.classList.remove("good", "bad");

  if (marginTotal >= 0) {
    marginAlert.classList.add("good");
    marginAlertTitle.textContent = "✅ Marge positive";
    marginAlertText.textContent =
      `Tu gagnes environ ${marginRate.toFixed(1)}% par vente.`;
  } else {
    marginAlert.classList.add("bad");
    marginAlertTitle.textContent = "⚠️ Vente à perte";
    marginAlertText.textContent =
      `Tu perds environ ${Math.abs(marginRate).toFixed(1)}%. ` +
      `Coût unitaire ≈ ${costUnit.toFixed(2)} / Vente ≈ ${saleUnit.toFixed(2)}.`;
  }
}




// ===== Dernier calcul coût
const lastCalc = {
  totalFinal: 0,
  currency: "XOF",
  qtySuggested: 0
};

// ✅ À appeler à la fin de runCalculator() (après finalTotal calculé)
function onCostCalculated(totalFinal, currency, qtySuggested) {
  lastCalc.totalFinal = toNum(totalFinal);
  lastCalc.currency = (currency || "XOF").trim() || "XOF";
  lastCalc.qtySuggested = Math.max(0, Math.floor(toNum(qtySuggested)));

  // Afficher bloc marge
  if (marginBox) marginBox.hidden = false;
  if (marginResult) marginResult.hidden = true;

  //Pré-remplir quantité si dispo
  if (saleQtyEl && lastCalc.qtySuggested > 0) {
    saleQtyEl.value = String(lastCalc.qtySuggested);
  }
}

// ===== Calcul marge (bouton)
if (marginRunBtn) {
  marginRunBtn.addEventListener("click", () => {
    const totalFinal = toNum(lastCalc.totalFinal);
    const currency = lastCalc.currency || "XOF";

    const salePriceUnit = toNum(salePriceUnitEl ? salePriceUnitEl.value : 0);
    const qty = Math.max(0, Math.floor(toNum(saleQtyEl ? saleQtyEl.value : 0)));

    if (totalFinal <= 0) {
        toast("Calcule d'abord le TOTAL FINAL.");
      return;
    }
    if (qty <= 0) {
        toast("Renseigne la quantité (nombre de pièces).");
      return;
    }
    if (salePriceUnit <= 0) {
        toast("Renseigne le prix de vente unitaire.");
      return;
    }

    const costUnit = totalFinal / qty;
    const marginUnit = salePriceUnit - costUnit;
    const marginTotal = marginUnit * qty;
  
    // Taux de marge (marge / prix de vente)
    const marginRate = salePriceUnit > 0 ? (marginUnit / salePriceUnit) * 100 : 0;
    // 🔐 mémorisation pour "Enregistrer"

    lastMargin.costUnit = costUnit;
    lastMargin.saleUnit = salePriceUnit;
    lastMargin.marginTotal = marginTotal;
    lastMargin.marginRate = marginRate;
    lastMargin.currency = currency;
    showMarginAlert(marginTotal, marginRate, costUnit, salePriceUnit);
    console.log("lastMargin MAJ ✅", lastMargin);
    
    if (marginResult) marginResult.hidden = false;

    if (lineCostUnit)   lineCostUnit.textContent   = `Coût unitaire : ${fmtMoney(costUnit, currency)}`;
    if (lineMarginUnit) lineMarginUnit.textContent = `Marge unitaire : ${fmtMoney(marginUnit, currency)}`;
    if (lineMarginTotal)lineMarginTotal.textContent= `Marge totale : ${fmtMoney(marginTotal, currency)}`;
    if (lineMarginRate) lineMarginRate.textContent = `TAUX DE MARGE : ${marginRate.toFixed(1)} %`;
    
    // ✅ Snapshot marge (pour PDF / Excel)
    window.lastMarginSnapshot = {
      salePriceUnit: salePriceUnit,
      qty: qty,
      costUnit: costUnit,
      marginUnit: marginUnit,
      marginTotal: marginTotal,
      marginRate: marginRate,
      currency: currency
    };

    // ✅ Affiche les boutons Export/Enregistrer du bloc MARGE
    showCalcExportButtons(true, "margin");
  });
}

// events calculateur

if (calcResetBtn) {
  calcResetBtn.addEventListener("click", resetCalculator);
}

// Recalcul auto si on modifie après un premier résultat
[
  calcProductsTotal,
  calcPriceUnit,
  calcQty,
  calcLocalDelivery,
  calcPricePerKg,
  calcWeightKg,
  calcPricePerCbm,
  calcVolumeCbm,
  calcShipFixed,
  calcTaxes,
].forEach((el) => {
  if (!el) return;
  el.addEventListener("input", () => {
    if (calcResultEl && !calcResultEl.hidden) {
      runCalculator();
    }
  });
});

function getCalcMeta() {
  const supplierName = document.getElementById("calc-supplier-name")?.value?.trim() || "";
  const productName  = document.getElementById("calc-product-name")?.value?.trim() || "";
  const supplierLink = document.getElementById("calc-supplier-link")?.value?.trim() || "";
  const currency     = document.getElementById("calc-currency")?.value?.trim() || "XOF";

  return {
    supplierName: supplierName || "Fournisseur inconnu",
    productName: productName || "Sans nom de produit",
    supplierLink,
    currency
  };
}

let lastToastAt = 0;

function toast(message, ms = 2500) {
  const now = Date.now();
  if (now - lastToastAt < 400) return; // anti-spam léger
  lastToastAt = now;

  // supprime l'ancien
  const old = document.getElementById("app-toast");
  if (old) old.remove();

  const el = document.createElement("div");
  el.id = "app-toast";
  el.textContent = message;

  // STYLE DIRECT (visible partout)
  el.style.position = "fixed";
  el.style.left = "50%";
  el.style.bottom = "24px";
  el.style.transform = "translateX(-50%)";
  el.style.zIndex = "99999";
  el.style.background = "#e0f2fe"; // bleu clair
  el.style.color = "#075985";      // texte bleu
  el.style.padding = "12px 14px";
  el.style.borderRadius = "14px";
  el.style.fontSize = "14px";
  el.style.fontWeight = "600";
  el.style.maxWidth = "92vw";
  el.style.textAlign = "center";
  el.style.boxShadow = "0 10px 30px rgba(0,0,0,0.25)";
  el.style.opacity = "0";
  el.style.transition = "opacity 180ms ease";

  document.body.appendChild(el);

  // animation
  requestAnimationFrame(() => {
    el.style.opacity = "1";
  });

  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 220);
  }, ms);
}

function saveMargin() {
  const access = canSaveAndExport();
  if (!access.ok) {
    toast("🔒 Sauvegarde réservée (pack ou abonnement).");
    return;
  }
  if (!window.lastCostSnapshot || !window.lastMarginSnapshot) {
      toast("Calcule le coût et la marge avant d’enregistrer.");
    return;
  }

  const c = window.lastCostSnapshot;
  const m = window.lastMarginSnapshot;
  const now = new Date();

  addCalcHistoryItem({
    type: "margin",
    date: now.toLocaleDateString() + " " + now.toLocaleTimeString().slice(0,5),

    supplierName: c.supplierName || "Fournisseur habituel",
    productName: c.productName || "Sans nom",
    supplierLink: c.supplierLink || "",
    currency: c.currency || "XOF",

    // coût
    productsTotal: c.productsTotal,
    localFees: c.localFees,
    shipping: c.shipping,
    taxesPct: c.taxesPct,
    taxesAmount: c.taxesAmount,
    totalFinal: c.totalFinal,

    // marge
    salePriceUnit: m.salePriceUnit,
    qty: m.qty,
    costUnit: m.costUnit,
    marginUnit: m.marginUnit,
    marginTotal: m.marginTotal,
    marginRate: m.marginRate
  });

    toast("✅ Marge enregistrée avec détails");
      consumeSaveExport(access.mode);
    if (typeof refreshPricingUI === "function") refreshPricingUI();
}

function saveCost() {
    const access = canSaveAndExport();
    if (!access.ok) {
      toast("🔒 Sauvegarde réservée (pack ou abonnement).");
      return;
    }
  
  if (!window.lastCostSnapshot) {
    toast("Calcule le coût avant d’enregistrer.");
    return;
  }

  const c = window.lastCostSnapshot;
  const now = new Date();

  addCalcHistoryItem({
    type: "cost",
    date: now.toLocaleDateString() + " " + now.toLocaleTimeString().slice(0,5),

    supplierName: c.supplierName,
    productName: c.productName,
    supplierLink: c.supplierLink,
    currency: c.currency,

    productsTotal: c.productsTotal,
    localFees: c.localFees,
    shipping: c.shipping,
    taxesPct: c.taxesPct,
    taxesAmount: c.taxesAmount,
    totalFinal: c.totalFinal
  });

    toast("✅ Coût enregistré");
    consumeSaveExport(access.mode);
    if (typeof refreshPricingUI === "function") refreshPricingUI();
}


const MARGIN_HISTORY_KEY = "aliscan_margin_history";
const marginHistoryList = document.getElementById("margin-history-list");
const clearMarginHistory = document.getElementById("clear-margin-history");

function loadMarginHistory() {
  try { return JSON.parse(localStorage.getItem(MARGIN_HISTORY_KEY) || "[]"); }
  catch { return []; }
}

function saveMarginHistory(list) {
  localStorage.setItem(MARGIN_HISTORY_KEY, JSON.stringify(list || []));
}


    

  
        
    




// --------------------------------------------------
// 4) CONVERTISSEUR GOOGLE (multi-devise + montant)
// --------------------------------------------------

const googleAmount  = document.getElementById("google-amount");
const googleFrom    = document.getElementById("google-from");
const googleTo      = document.getElementById("google-to");
const googleRateBtn = document.getElementById("google-rate-btn");
// 🔄 Bouton inverser les devises
const googleSwapBtn = document.getElementById("google-swap");

if (googleSwapBtn) {
  googleSwapBtn.addEventListener("click", () => {
    const oldFrom = googleFrom.value.trim();
    googleFrom.value = googleTo.value.trim();
    googleTo.value = oldFrom;

    // Petite animation visuelle
    googleFrom.classList.add("flash");
    googleTo.classList.add("flash");
    setTimeout(() => {
      googleFrom.classList.remove("flash");
      googleTo.classList.remove("flash");
    }, 400);
  });
}

if (googleRateBtn) {
  googleRateBtn.addEventListener("click", () => {
    // Montant (par défaut 1 si vide ou invalide)
    let amount = parseFloat((googleAmount && googleAmount.value) || "1");
    if (isNaN(amount) || amount <= 0) {
      amount = 1;
    }

    // Devise de départ / arrivée
    const from = (googleFrom && googleFrom.value ? googleFrom.value : "USD")
      .trim()
      .toUpperCase();
    const to = (googleTo && googleTo.value ? googleTo.value : "XOF")
      .trim()
      .toUpperCase();

    if (!from || !to) {
      alert("Renseigne la devise de départ et la devise d’arrivée.");
      return;
    }

    // Exemple de requête : "250 USD en XOF"
    const query = encodeURIComponent(`${amount} ${from} en ${to}`);
    const url = `https://www.google.com/search?q=${query}`;
    window.open(url, "_blank");
  });
}

// --------------------------------------------------
// 5) NAVIGATION ENTRE LES ÉCRANS + MENU
// --------------------------------------------------

// Écrans
const screens = {
  "screen-ocr":     document.getElementById("screen-ocr"),   
  "screen-analyse": document.getElementById("screen-analyse"),
  "screen-calc":    document.getElementById("screen-calc"),
  "screen-conv":    document.getElementById("screen-conv"),
  "screen-tracking": document.getElementById("screen-tracking"),
  
  "screen-pricing": document.getElementById("screen-pricing"),
};

const menuButtons = document.querySelectorAll(".menu-btn");
// alert("📌 menuButtons trouvés = " + menuButtons.length);
const menuToggle  = document.getElementById("menu-toggle");
const mainMenu    = document.getElementById("main-menu");

function showScreen(name) {
// alert("📌 showScreen appelée : " + name);
  // afficher / cacher les écrans
  Object.entries(screens).forEach(([key, el]) => {
    if (!el) return;
    el.hidden = key !== name;
  });

  // état visuel des boutons du menu
  menuButtons.forEach((btn) => {
    if (btn.dataset.screen === name) {
      btn.classList.add("menu-btn-active");
    } else {
      btn.classList.remove("menu-btn-active");
    }
  });
}

// Clic sur les boutons du menu
if (menuButtons.length) {
  menuButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const screen = btn.dataset.screen;
      if (screen) showScreen(screen);

      // refermer le menu mobile
      if (mainMenu) {
        mainMenu.classList.remove("menu-open");
        mainMenu.classList.add("menu-closed");
      }
    });
  });
}

// Bouton ☰ pour ouvrir / fermer le menu
if (menuToggle && mainMenu) {
  menuToggle.addEventListener("click", () => {
    if (mainMenu.classList.contains("menu-open")) {
      mainMenu.classList.remove("menu-open");
      mainMenu.classList.add("menu-closed");
    } else {
      mainMenu.classList.remove("menu-closed");
      mainMenu.classList.add("menu-open");
    }
  });
}

// Écran par défaut : analyse de images
showScreen("screen-ocr");

// --------------------------------------------------
// 5 bis) TRACKING DE COLIS (appel /track)
// --------------------------------------------------

const trackingInput  = document.getElementById("tracking-input");
const trackingBtn    = document.getElementById("tracking-btn");
const trackingResult = document.getElementById("tracking-result");

function renderTrackingResult(data) {
  if (!trackingResult) return;

  trackingResult.hidden = false;

  if (!data || data.ok === false) {
    trackingResult.innerHTML = `
      <p class="error">
        Erreur : ${(data && data.error) || "Impossible de suivre ce numéro."}
      </p>`;
    return;
  }

  let html = "";

  html += `<p><strong>Numéro :</strong> ${data.tracking_number}</p>`;
  if (data.detected_type) {
    html += `<p><strong>Type détecté :</strong> ${data.detected_type}</p>`;
  }

  if (data.extra && data.extra.carrier_guess && data.extra.carrier_guess.carrier_name) {
    const g = data.extra.carrier_guess;
    html += `<p><strong>Transporteur probable :</strong> ${g.carrier_name}`;
    if (typeof g.confidence === "number") {
      html += ` (${Math.round(g.confidence * 100)}% confiance)`;
    }
    html += `</p>`;
  }

  if (data.note) {
    html += `<p class="note">${data.note}</p>`;
  }

  if (data.links && Object.keys(data.links).length) {
    html += `<p><strong>Suivre sur :</strong></p><div class="track-links">`;

    const labelMap = {
      cainiao: "Cainiao",
      "17track": "17Track",
      kuaidi100: "Kuaidi100",
      dhl: "DHL",
      ups: "UPS",
      fedex: "FedEx",
      track_trace_air: "Track-Trace Air Cargo",
      track_trace_bl: "Track-Trace BL",
      track_trace_container: "Track-Trace Container",
    };

    Object.entries(data.links).forEach(([key, url]) => {
      if (!url) return;
      const label = labelMap[key] || key;
      html += `<a href="${url}" target="_blank" class="link-button">${label}</a> `;
    });

    html += `</div>`;
  }

  trackingResult.innerHTML = html;
}

async function runTracking() {
  if (!trackingInput || !trackingBtn || !trackingResult) return;

  const num = (trackingInput.value || "").trim();
  if (!num) {
    alert("Entre un numéro de suivi.");
    return;
  }

  try {
    trackingBtn.disabled = true;
    const oldText = trackingBtn.textContent;
    trackingBtn.textContent = "Analyse en cours...";
    trackingResult.hidden = false;
    trackingResult.innerHTML = "⏳ Recherche...";

    const resp = await fetch("/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tracking_number: num,
        mode: "auto",
      }),
    });

    const data = await resp.json().catch(() => null);

    if (!resp.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || "Erreur serveur.");
    }

    renderTrackingResult(data);

    // ⭐ Ajouter à l'historique avec le bon numéro :
    addToTrackingHistory(data.tracking_number || num);

    trackingBtn.textContent = oldText;
    trackingBtn.disabled = false;
  } catch (err) {
    console.error(err);
    trackingResult.hidden = false;
    trackingResult.innerHTML =
      `<p class="error">Erreur : ${err.message || "Impossible de suivre ce numéro."}</p>`;
    trackingBtn.disabled = false;
    trackingBtn.textContent = "Rechercher";
  }
}

// --- HISTORIQUE TRACKING ---
function addToTrackingHistory(number) {
  const list = document.getElementById("tracking-history-list");
  const container = document.getElementById("tracking-history");

  const now = new Date();
  const date = now.toLocaleDateString();
  const time = now.toLocaleTimeString();

  const item = document.createElement("div");
  item.className = "history-item";

  item.innerHTML = `
    <div class="history-main">
      <div class="history-desc">🔎 ${number}</div>
      <div class="history-meta">${date} - ${time}</div>
    </div>
  `;

  list.prepend(item);
  container.hidden = false;
}

// Bouton reset historique
const trackingClearBtn = document.getElementById("tracking-clear");
if (trackingClearBtn) {
  trackingClearBtn.addEventListener("click", () => {
    const list = document.getElementById("tracking-history-list");
    const container = document.getElementById("tracking-history");
    if (list) list.innerHTML = "";
    if (container) container.hidden = true;
  });
}

// événements tracking
if (trackingBtn) {
  trackingBtn.addEventListener("click", runTracking);
}
if (trackingInput) {
  trackingInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runTracking();
    }
  });
}

// --------------------------------------------------
// 6) INIT GLOBALE
// --------------------------------------------------
// Render au chargement

  
document.addEventListener("DOMContentLoaded", () => {
  renderCalcHistory();
  renderHistory();
  showError("");
  setLoading(false);

  const saveCostBtn = document.getElementById("cost-save-btn");
  const saveMarginBtn = document.getElementById("margin-save-btn");

  if (saveCostBtn) {
    saveCostBtn.addEventListener("click", (e) => {
      e.preventDefault();
      saveCost();
    });
  }

  if (saveMarginBtn) {
    saveMarginBtn.addEventListener("click", (e) => {
      e.preventDefault();
      saveMargin();
    });
  }
});

