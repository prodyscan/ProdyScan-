const input = document.getElementById("code-input");
const scanBtn = document.getElementById("scan-btn");
const errorText = document.getElementById("error-text");
const loader = document.getElementById("loader");
const resultCard = document.getElementById("result-card");
const resultCode = document.getElementById("result-code");
const resultName = document.getElementById("result-name");
const resultDetails = document.getElementById("result-details");
const riskLevelEl = document.getElementById("risk-level");
const lastCheckEl = document.getElementById("last-check");
const statusPill = document.getElementById("status-pill");
const historyList = document.getElementById("history-list");
const clearHistoryBtn = document.getElementById("clear-history");

// ---- UTILITAIRES ----
function setLoading(isLoading) {
  loader.hidden = !isLoading;
  scanBtn.disabled = isLoading;
  scanBtn.textContent = isLoading ? "Analyse..." : "Analyser";
}

function showError(msg) {
  errorText.textContent = msg;
  errorText.hidden = !msg;
}

function addToHistory(entry) {
  let history = JSON.parse(localStorage.getItem("prodyscan_history") || "[]");
  history.unshift(entry);
  history = history.slice(0, 10);
  localStorage.setItem("prodyscan_history", JSON.stringify(history));
  renderHistory();
}

function renderHistory() {
  const history = JSON.parse(localStorage.getItem("prodyscan_history") || "[]");

  historyList.innerHTML = "";
  if (!history.length) {
    historyList.classList.add("empty");
    historyList.innerHTML =
      '<p class="history-empty">Aucune analyse encore. Lance ta première vérification 👇</p>';
    return;
  }

  historyList.classList.remove("empty");

  history.forEach((item) => {
    const div = document.createElement("div");
    div.className = "history-item";

    div.innerHTML = `
      <div class="history-main">
        <span class="history-code">${item.code}</span>
        <span class="history-name">${item.product_name}</span>
      </div>
      <div class="${
        item.status === "Authentique" ? "history-status-ok" : "history-status-risk"
      }">
        ${item.status}
      </div>
    `;

    div.addEventListener("click", () => {
      // Remonte les infos dans la carte de résultat
      resultCard.hidden = false;
      resultCode.textContent = item.code;
      resultName.textContent = item.product_name;
      resultDetails.textContent = item.details;
      riskLevelEl.textContent = item.risk_level;
      lastCheckEl.textContent = "Historique";

      statusPill.textContent = item.status;
      statusPill.classList.toggle(
        "status-ok",
        item.status === "Authentique"
      );
      statusPill.classList.toggle(
        "status-risk",
        item.status !== "Authentique"
      );
    });

    historyList.appendChild(div);
  });
}

clearHistoryBtn.addEventListener("click", () => {
  localStorage.removeItem("prodyscan_history");
  renderHistory();
});

// ---- ACTION SCAN ----
async function handleScan() {
  const code = input.value.trim();
  showError("");

  if (!code) {
    showError("Entre un code à analyser.");
    return;
  }

  setLoading(true);
  resultCard.hidden = true;

  try {
    const response = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Erreur lors de l’analyse");
    }

    // Affiche résultat
    resultCard.hidden = false;
    resultCode.textContent = data.code;
    resultName.textContent = data.product_name || "Produit";
    resultDetails.textContent =
      data.details || "Analyse effectuée avec succès.";
    riskLevelEl.textContent = data.risk_level || "-";

    const status = data.status || "Inconnu";
    statusPill.textContent = status;
    statusPill.classList.toggle("status-ok", status === "Authentique");
    statusPill.classList.toggle("status-risk", status !== "Authentique");

    lastCheckEl.textContent = "À l’instant";

    // Historique
    addToHistory({
      code: data.code,
      product_name: data.product_name || "Produit",
      status,
      risk_level: data.risk_level || "-",
      details: data.details || "",
    });
  } catch (err) {
    console.error(err);
    showError(err.message || "Erreur inconnue");
  } finally {
    setLoading(false);
  }
}

// Bouton + Enter
scanBtn.addEventListener("click", handleScan);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    handleScan();
  }
});

// Init
renderHistory();
