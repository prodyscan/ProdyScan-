// ============================
// Sélection des éléments
// ============================

const fileInput = document.getElementById("file-input");
const chooseBtn = document.getElementById("choose-btn");
const fileNameEl = document.getElementById("file-name");
const previewWrapper = document.getElementById("preview-wrapper");
const previewImg = document.getElementById("preview-img");

const countrySelect = document.getElementById("country-select");
const shopSelect = document.getElementById("shop-select");
const customShopInput = document.getElementById("custom-shop");
// ============================
// Gestion logique boutique / boutique perso
// ============================

// Si l'utilisateur change la boutique standard
if (shopSelect && customShopInput) {
  shopSelect.addEventListener("change", () => {
    // Si la boutique choisie n'est PAS "personnalisée", on vide et désactive
    if (shopSelect.value !== "custom") {
      customShopInput.value = "";
    }
  });

  // Si l'utilisateur commence à taper sa propre boutique...
  customShopInput.addEventListener("input", () => {
    // Alors on force la valeur du select à "custom"
    if (customShopInput.value.trim().length > 0) {
      shopSelect.value = "custom";
    }
  });
}
const analyseBtn = document.getElementById("analyse-btn");

const errorText = document.getElementById("error-text");
const loader = document.getElementById("loader");

const resultCard = document.getElementById("result-card");
const resultDescription = document.getElementById("result-description");
const resultShop = document.getElementById("result-shop");
const resultCountry = document.getElementById("result-country");
const resultSource = document.getElementById("result-source");
const resultLink = document.getElementById("result-link");
const localResults = document.getElementById("local-results");

// ======================
//  Résultats catalogue local
// ======================

function clearLocalResults() {
  if (!localResults) return;
  localResults.innerHTML = "";
}

function renderLocalResults(results) {
  if (!localResults) return;

  clearLocalResults();

  if (!results || results.length === 0) {
    localResults.innerHTML = "<p>Aucun produit similaire trouvé.</p>";
    return;
  }

  results.forEach((p) => {
    const div = document.createElement("div");
    div.className = "local-product";

    div.innerHTML = `
      <img src="${p.image_url}" alt="${p.title}">
      <h4>${p.title}</h4>
      <p><strong>Prix :</strong> ${p.price} FCFA</p>
      <p><strong>Marque :</strong> ${p.brand}</p>
    `;

    localResults.appendChild(div);
  });
}

const historyList = document.getElementById("history-list");
const clearHistoryBtn = document.getElementById("clear-history");

// ============================
// Utilitaires
// ============================

function setLoading(isLoading) {
  if (!loader || !analyseBtn) return;
  loader.hidden = !isLoading;
  analyseBtn.disabled = isLoading;
  analyseBtn.textContent = isLoading
    ? "Analyse en cours..."
    : "Analyser l’image";
}

function showError(msg) {
  if (!errorText) return;
  errorText.textContent = msg || "";
  errorText.hidden = !msg;
}

function updatePreview() {
  if (!fileInput || !fileNameEl || !previewWrapper || !previewImg) return;

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
  let history = JSON.parse(
    localStorage.getItem("prodyscan_img_history") || "[]",
  );
  history.unshift(entry);
  history = history.slice(0, 10);
  localStorage.setItem("prodyscan_img_history", JSON.stringify(history));
  renderHistory();
}

function renderHistory() {
  if (!historyList) return;

  const history = JSON.parse(
    localStorage.getItem("prodyscan_img_history") || "[]",
  );
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
      // Remplir la carte résultat avec l'entrée d'historique
      if (!resultCard) return;
      resultCard.hidden = false;
      resultDescription.textContent = item.description;
      resultShop.textContent = "Boutique : " + item.shop_label;
      resultCountry.textContent = "Pays : " + item.country_label;
      resultSource.textContent = "Source : " + (item.source || "-");
      resultLink.href = item.url || "#";
    });
    historyList.appendChild(div);
  });
}

// ============================
// Handlers
// ============================

// Ouvrir l’input fichier quand on clique sur le bouton
if (chooseBtn && fileInput) {
  chooseBtn.addEventListener("click", () => {
    fileInput.click();
  });
}

// Quand un fichier est choisi => mise à jour de l’aperçu
if (fileInput) {
  fileInput.addEventListener("change", updatePreview);
}

// Effacer l’historique
if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener("click", () => {
    localStorage.removeItem("prodyscan_img_history");
    renderHistory();
  });
}

// ============================
// Analyse d’image
// ============================

async function handleAnalyse() {
  showError("");
  if (resultCard) resultCard.hidden = true;
  clearLocalResults();

  if (!fileInput) {
    showError("Erreur interne : champ fichier introuvable.");
    return;
  }

  const file = fileInput.files[0];
  if (!file) {
    showError("Choisis d’abord une image de produit.");
    return;
  }

  const country = countrySelect ? countrySelect.value : "global";
  const shop = shopSelect ? shopSelect.value : "google";
  const customShop = customShopInput ? customShopInput.value.trim() : "";

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
    } catch (e) {
      console.error(e);
      throw new Error("Réponse inattendue du serveur.");
    }

    if (!response.ok || data.error) {
      throw new Error(data.error || "Erreur lors de l’analyse.");
    }

    // ---------- On regarde si on est en mode "Catalogue local" ----------
    const isLocalMode = shop === "local" || data.mode === "local";

    // ---------- Afficher la carte résultat ----------
    if (resultCard) resultCard.hidden = false;

    const description =
      (data.description && data.description.trim()) ||
      (isLocalMode ? "photo de produit en ligne" : "(aucune description)");

    const shopLabel = data.shop_label || data.shop || "-";
    const countryLabel = data.country || "global";
    const sourceLabel =
      data.source || (data.openai_enabled ? "vision" : "ocr");

    if (resultDescription) resultDescription.textContent = description;
    if (resultShop) resultShop.textContent = "Boutique : " + shopLabel;
    if (resultCountry) resultCountry.textContent = "Pays : " + countryLabel;
    if (resultSource) resultSource.textContent = "Source : " + sourceLabel;

    // ---------- Cas 1 : Mode "Catalogue local (par image)" ----------
if (isLocalMode) {

    // On affiche les produits du catalogue local
    renderLocalResults(data.local_results || data.results || []);

    // Afficher le lien Jumia si disponible
    if (resultLink) {
        const firstProduct = (data.local_results || data.results || [])[0];

        if (firstProduct && firstProduct.url) {
            // Lien Jumia (ou autre source)
            resultLink.style.display = "inline-flex";
            resultLink.href = firstProduct.url;
            resultLink.target = "_blank";
        } else {
            // Pas de lien → on cache
            resultLink.style.display = "none";
            resultLink.href = "#";
        }
  }
} else {
      // ---------- Cas 2 : Jumia / Google / Amazon / etc. ----------
      // On vide la zone de résultats locaux
      clearLocalResults();

      // On affiche le lien vers la boutique
      if (resultLink) {
        resultLink.style.display = "inline-flex";
        resultLink.href = data.url || "#";
        resultLink.target = "_blank";
      }
    }

    // ---------- Historique ----------
    const now = new Date();
    const dateStr =
      now.toLocaleDateString() + " " + now.toLocaleTimeString().slice(0, 5);

    addToHistory({
      description,
      shop_label: shopLabel,
      country_label: countryLabel,
      url: isLocalMode ? "#" : (data.url || "#"),
      source: sourceLabel,
      date: dateStr,
    });
  } catch (err) {
    console.error(err);
    showError(err.message || "Erreur inconnue pendant l’analyse.");
  } finally {
    setLoading(false);
  }
}
// Lier le bouton "Analyser l’image"
if (analyseBtn) {
  analyseBtn.addEventListener("click", handleAnalyse);
}

// ============================
// Init
// ============================

renderHistory();
updatePreview();
showError("");
setLoading(false);
