const fileInput = document.getElementById("file-input");
const chooseBtn = document.getElementById("choose-btn");
const fileNameEl = document.getElementById("file-name");
const previewWrapper = document.getElementById("preview-wrapper");
const previewImg = document.getElementById("preview-img");

const countrySelect = document.getElementById("country-select");
const shopSelect = document.getElementById("shop-select");
const customShopInput = document.getElementById("custom-shop");

const analyseBtn = document.getElementById("analyse-btn");

const errorText = document.getElementById("error-text");
const loader = document.getElementById("loader");

const resultCard = document.getElementById("result-card");
const resultDescription = document.getElementById("result-description");
const resultShop = document.getElementById("result-shop");
const resultCountry = document.getElementById("result-country");
const resultSource = document.getElementById("result-source");
const resultLink = document.getElementById("result-link");

const historyList = document.getElementById("history-list");
const clearHistoryBtn = document.getElementById("clear-history");

// ------------------ UTILITAIRES ------------------ //

function setLoading(isLoading) {
  loader.hidden = !isLoading;
  analyseBtn.disabled = isLoading;
  analyseBtn.textContent = isLoading ? "Analyse en cours..." : "Analyser l’image";
}

function showError(msg) {
  errorText.textContent = msg || "";
  errorText.hidden = !msg;
}

function updatePreview() {
  const file = fileInput.files[0];
  if (!file) {
    fileNameEl.textContent = "Aucune image sélectionnée";
    previewWrapper.hidden = true;
    previewImg.src = "";
    return;
  }
  fileNameEl.textContent = file.name;
  const url = URL.createObjectURL(file);
  previewImg.src = url;
  previewWrapper.hidden = false;
}

function addToHistory(entry) {
  let history = JSON.parse(localStorage.getItem("prodyscan_img_history") || "[]");
  history.unshift(entry);
  history = history.slice(0, 10);
  localStorage.setItem("prodyscan_img_history", JSON.stringify(history));
  renderHistory();
}

function renderHistory() {
  const history = JSON.parse(localStorage.getItem("prodyscan_img_history") || "[]");
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
        <div class="history-desc">${item.description}</div>
        <div class="history-meta">
          ${item.shop_label} • ${item.country_label}
        </div>
      </div>
      <div class="history-meta">
        ${item.date}
      </div>
    `;
    div.addEventListener("click", () => {
      resultCard.hidden = false;
      resultDescription.textContent = item.description;
      resultShop.textContent = "Boutique : " + item.shop_label;
      resultCountry.textContent = "Pays : " + item.country_label;
      resultSource.textContent = "Source : " + item.source;
      resultLink.href = item.url;
    });
    historyList.appendChild(div);
  });
}

// ------------------ HANDLERS ------------------ //

// Quand on clique sur le bouton => on ouvre l’input fichier
pickImageBtn.addEventListener("click", () => {
  fileInput.click();
});

// Quand un fichier est choisi => on affiche le nom
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileNameEl.textContent = file ? file.name : "Aucune image sélectionnée";
});

setLoading(true);

try {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("country", country);
  formData.append("shop", shop);
  formData.append("custom_shop", customShop);

  const response = await fetch("/analyse", {
    method: "POST",
    body: formData,
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Réponse inattendue du serveur.");
  }

  if (!response.ok || data.error) {
    throw new Error(data.error || "Erreur lors de l’analyse.");
  }

  // ... (le reste inchangé)

  const file = fileInput.files[0];
  if (!file) {
    showError("Choisis d’abord une image de produit.");
    return;
  }

  const country = countrySelect.value;
  const shop = shopSelect.value;
  const customShop = customShopInput.value.trim();

  setLoading(true);

  try:
    const formData = new FormData();
    formData.append("file", file);
    formData.append("country", country);
    formData.append("shop", shop);
    formData.append("custom_shop", customShop);

    const response = await fetch("/analyse", {
      method: "POST",
      body: formData,
    });

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("Réponse inattendue du serveur.");
    }

    if (!response.ok || data.error) {
      throw new Error(data.error || "Erreur lors de l’analyse.");
    }

    // Affiche résultat
    resultCard.hidden = false;
    resultDescription.textContent = data.description || "(aucune description)";
    resultShop.textContent = "Boutique : " + (data.shop_label || "-");
    resultCountry.textContent = "Pays : " + (data.country || "global");
    resultSource.textContent =
      "Source : " + (data.source || (data.openai_enabled ? "vision" : "ocr"));

    if (data.url) {
      resultLink.href = data.url;
    } else {
      resultLink.href = "#";
    }

    // Historique
    const now = new Date();
    const dateStr =
      now.toLocaleDateString() + " " + now.toLocaleTimeString().slice(0, 5);

    addToHistory({
      description: data.description || "",
      shop_label: data.shop_label || data.shop || "-",
      country_label: data.country || "global",
      url: data.url || "#",
      source: data.source || "",
      date: dateStr,
    });
  } catch (err) {
    console.error(err);
    showError(err.message || "Erreur inconnue pendant l’analyse.");
  } finally {
    setLoading(false);
  }
}

analyseBtn.addEventListener("click", handleAnalyse);

// Init
renderHistory();
updatePreview();
showError("");
