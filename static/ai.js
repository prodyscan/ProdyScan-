document.addEventListener("DOMContentLoaded", () => {
  const sendBtn = document.getElementById("ai-send");
  const input = document.getElementById("ai-text");
  const box = document.getElementById("ai-messages");

  const historyBtn = document.getElementById("ai-history-btn");
  const sidebar = document.getElementById("ai-sidebar");
  const overlay = document.getElementById("ai-overlay");
  const closeSidebarBtn = document.getElementById("ai-close-sidebar");

  const chatListEl = document.getElementById("ai-chat-list");
  const newChatBtn = document.getElementById("ai-new-chat");

  (function enforceNewSession() {
    const SESSION_KEY = "aliscan_session_id";
    const CURRENT_SESSION = crypto.randomUUID();

    const savedSession = sessionStorage.getItem(SESSION_KEY);

const helpBtn = document.getElementById("ai-help-btn");
const helpOverlay = document.getElementById("ai-help-overlay");
const helpClose = document.getElementById("ai-help-close");


// ===============================
// 💳 BILLING IA GLOBAL
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
    const b = JSON.parse(localStorage.getItem(BILLING_KEY) || "{}");
    return {
      aiPack: Number(b.aiPack ?? 0),
      aiTrialOnce: Number(b.aiTrialOnce ?? 20),
      aiFreeDay: b.aiFreeDay?.date ? b.aiFreeDay : { date: todayKey(), used: 0 },
      aiMonth: b.aiMonth?.ym ? b.aiMonth : { ym: monthKey(), used: 0 },
      subUntil: Number(b.subUntil ?? 0),
      subPlan: String(b.subPlan ?? ""),
      ...b
    };
  } catch {
    return {
      aiPack: 0,
      aiTrialOnce: 20,
      aiFreeDay: { date: todayKey(), used: 0 },
      aiMonth: { ym: monthKey(), used: 0 },
      subUntil: 0,
      subPlan: ""
    };
  }
}

function setBilling(b) {
  localStorage.setItem(BILLING_KEY, JSON.stringify(b));
}

function isSubActive(b) {
  return (b.subUntil || 0) > Date.now();
}

function canUseAI() {
  const b = getBilling();

  if (isSubActive(b)) {
    const left = Math.max(0, 300 - (b.aiMonth.used || 0));
    return left > 0 ? { ok: true, mode: "sub", left } : { ok: false };
  }

  if (b.aiPack > 0) return { ok: true, mode: "pack", left: b.aiPack };
  if (b.aiTrialOnce > 0) return { ok: true, mode: "trial", left: b.aiTrialOnce };

  const daily = Math.max(0, 5 - (b.aiFreeDay.used || 0));
  return daily > 0 ? { ok: true, mode: "daily", left: daily } : { ok: false };
}

function consumeAI() {
  const b = getBilling();

  if (isSubActive(b)) {
    b.aiMonth.used = (b.aiMonth.used || 0) + 1;
    setBilling(b);
    return { ok: true };
  }

  if (b.aiPack > 0) {
    b.aiPack--;
    setBilling(b);
    return { ok: true };
  }


  b.aiFreeDay.used = (b.aiFreeDay.used || 0) + 1;
  setBilling(b);
  return { ok: true };
}

/*window.getBilling = getBilling;
window.setBilling = setBilling;
window.canUseAI = canUseAI;
window.consumeAI = consumeAI;*/

    
function openHelp(){
  helpOverlay.classList.add("open");
  helpOverlay.setAttribute("aria-hidden", "false");
}

function closeHelp(){
  helpOverlay.classList.remove("open");
  helpOverlay.setAttribute("aria-hidden", "true");
}

if (helpBtn && helpOverlay && helpClose) {
  helpBtn.addEventListener("click", openHelp);
  helpClose.addEventListener("click", closeHelp);

  // clique sur le fond = ferme
  helpOverlay.addEventListener("click", (e) => {
    if (e.target === helpOverlay) closeHelp();
  });

  // ESC = ferme (PC)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeHelp();
  });
}

    // Nouvelle session navigateur → reset total
    if (!savedSession) {
      sessionStorage.setItem(SESSION_KEY, CURRENT_SESSION);

      // 🔥 RESET IA + HISTORIQUE
      localStorage.removeItem("aliscan_ai_chats_v1");
      localStorage.removeItem("aliscan_ai_current_chat_id_v1");
    }
  })();

  // Guard (évite crash si élément manquant)
  if (!sendBtn || !input || !box || !historyBtn || !sidebar || !overlay || !closeSidebarBtn || !chatListEl || !newChatBtn) {
    console.error("Aliscan AI: éléments DOM manquants");
    return;
  }

  // ----------------------------
  // Sidebar open/close
  // ----------------------------
  function openSidebar() {
    sidebar.classList.add("open");
    overlay.classList.add("show");
  }
  function closeSidebar() {
    sidebar.classList.remove("open");
    overlay.classList.remove("show");
  }

  historyBtn.addEventListener("click", openSidebar);
  closeSidebarBtn.addEventListener("click", closeSidebar);
  overlay.addEventListener("click", closeSidebar);

  // ----------------------------
  // Storage (Chats)
  // ----------------------------
  const STORAGE_KEY = "aliscan_ai_chats_v1";
  const CURRENT_KEY = "aliscan_ai_current_chat_id_v1";
  let currentChatId = localStorage.getItem(CURRENT_KEY) || null;

  function loadChats() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
    catch { return []; }
  }
  function saveChats(chats) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
  }

  function createChat() {
    const chat = {
      id: "chat_" + Date.now() + "_" + Math.random().toString(16).slice(2),
      title: "Nouvelle discussion",
      createdAt: Date.now(),
      messages: []
    };
    const chats = loadChats();
    chats.unshift(chat);
    saveChats(chats);
    currentChatId = chat.id;
    localStorage.setItem(CURRENT_KEY, currentChatId);
    return chat;
  }

  function getCurrentChat() {
    const chats = loadChats();
    if (!currentChatId) {
      if (chats.length === 0) return createChat();
      currentChatId = chats[0].id;
      localStorage.setItem(CURRENT_KEY, currentChatId);
    }
    let chat = chats.find(c => c.id === currentChatId);
    if (!chat) chat = createChat();
    return chat;
  }

  function updateChat(updated) {
    const chats = loadChats();
    const idx = chats.findIndex(c => c.id === updated.id);
    if (idx >= 0) chats[idx] = updated;
    else chats.unshift(updated);
    saveChats(chats);
  }

  function addToChat(role, text) {
    const chat = getCurrentChat();
    chat.messages.push({ role, text, ts: Date.now() });

    if ((chat.title === "Nouvelle discussion" || !chat.title) && role === "user") {
      chat.title = text.slice(0, 32);
    }
    updateChat(chat);
    return chat;
  }

  // prenom

  // ===== Mémoire utilisateur (long terme) =====
  const USER_MEMORY_KEY = "aliscan_user_memory_v1";

  function loadUserMemory(){
    try { return JSON.parse(localStorage.getItem(USER_MEMORY_KEY) || "{}"); }
    catch { return {}; }
  }

  function saveUserMemory(mem){
    localStorage.setItem(USER_MEMORY_KEY, JSON.stringify(mem || {}));
  }

  // Détection simple du prénom
  function extractName(text){
    const t = (text || "").trim();
    let m = t.match(/je m[' ]appelle\s+([A-Za-zÀ-ÿ-]{2,30})/i);
    if (m) return m[1];
    m = t.match(/je suis\s+([A-Za-zÀ-ÿ-]{2,30})/i);
    if (m) return m[1];
    return null;
  }
  
  // ----------------------------
  // Cache IA (réponses)
  // ----------------------------
  const AI_CACHE_KEY = "aliscan_ai_cache_v1";
  const AI_CACHE_MAX = 80;

  function loadAiCache() {
    try { return JSON.parse(localStorage.getItem(AI_CACHE_KEY) || "[]"); }
    catch { return []; }
  }
  function saveAiCache(arr) {
    localStorage.setItem(AI_CACHE_KEY, JSON.stringify(arr.slice(0, AI_CACHE_MAX)));
  }
  
  function makeCacheKey(payload) {
    return JSON.stringify({
      m: payload.message || "",
      l: payload.language || "auto",        // ✅ AJOUT IMPORTANT
      msgs: (payload.messages || []).slice(-10),
      mem: payload.user_memory || null,
      o: payload.ocr_text || "",
      c: payload.cost_json || null,
      g: payload.margin_json || null
    });
  }
  
  function cacheGet(key) {
    const cache = loadAiCache();
    const hit = cache.find(x => x.key === key);
    return hit ? hit.answer : null;
  }
  function cacheSet(key, answer) {
    const cache = loadAiCache();
    cache.unshift({ key, answer, ts: Date.now() });
    saveAiCache(cache);
  }

  // ----------------------------
  // UI
  // ----------------------------
  function addBubble(text, cls) {
    const div = document.createElement("div");
    div.className = cls;
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  function renderCurrentChat() {
    const chat = getCurrentChat();
    box.innerHTML = "";

    if (!chat.messages || chat.messages.length === 0) {
      addBubble("💬 Bonjour ! Pose ta question, je t’aide.", "ai-msg ai-bot");
      return;
    }

    chat.messages.forEach(m => {
      const cls = m.role === "user" ? "ai-msg ai-me" : "ai-msg ai-bot";
      const prefix = m.role === "user" ? "🧑 " : "💬 ";
      addBubble(prefix + m.text, cls);
    });
  }

  function renderChatList() {
    const chats = loadChats();
    chatListEl.innerHTML = "";

    chats.forEach(c => {
      const row = document.createElement("div");
      row.className = "ai-chat-row" + (c.id === currentChatId ? " active" : "");

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "ai-chat-open";
      openBtn.textContent = c.title || "Discussion";
      openBtn.onclick = () => {
        currentChatId = c.id;
        localStorage.setItem(CURRENT_KEY, currentChatId);
        renderCurrentChat();
        renderChatList();
        closeSidebar(); // ✅ ferme menu après sélection
      };

      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "ai-chat-icon";
      renameBtn.title = "Renommer";
      renameBtn.textContent = "✏️";
      renameBtn.onclick = (e) => {
        e.stopPropagation();
        const name = prompt("Nouveau nom :", c.title || "Discussion");
        if (!name) return;
        c.title = name.trim().slice(0, 40);
        updateChat(c);
        renderChatList();
      };

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "ai-chat-icon";
      delBtn.title = "Supprimer";
      delBtn.textContent = "🗑️";
      delBtn.onclick = (e) => {
        e.stopPropagation();
        if (!confirm("Supprimer cette discussion ?")) return;

        const chats2 = loadChats().filter(x => x.id !== c.id);
        saveChats(chats2);

        if (currentChatId === c.id) {
          currentChatId = chats2[0]?.id || null;
          if (!currentChatId) createChat();
          localStorage.setItem(CURRENT_KEY, currentChatId || "");
        }
        renderCurrentChat();
        renderChatList();
      };

      row.appendChild(openBtn);
      row.appendChild(renameBtn);
      row.appendChild(delBtn);
      chatListEl.appendChild(row);
    });
  }

// helpers IA
  function buildHistoryForAI(limit = 10) {
    const chats = JSON.parse(localStorage.getItem("aliscan_ai_chats_v1") || "[]");

    // accepte les 2 clés (selon ton code)
    const currentId =
      localStorage.getItem("aliscan_ai_current_chat_id_v1") ||
      localStorage.getItem("aliscan_ai_current_chat_id");

    const chat = chats.find(c => c.id === currentId) || chats[0];

    return (chat?.messages || []).slice(-limit).map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.text || "")
    }));
  }


function detectLang(text) {
  const t = (text || "").toLowerCase();

  // Arabe
  if (/[؀-ۿ]/.test(text)) return "ar";

  // Anglais (mots courts fréquents)
  if (/\b(hi|hello|hey|thanks|please|good|fine|ok|how|what|why)\b/.test(t)) {
    return "en";
  }

  // Français par défaut
  return "fr";
}

  // ----------------------------
  // Send to AI
  // ----------------------------

async function sendToAI() {
  const msg = (input.value || "").trim();
  if (!msg) return;

  // 🔒 Vérification quota IA
  const check = window.canUseAI?.();
  if (!check?.ok) {
    alert("❌ Limite IA atteinte");
    return;
  }

  const bBefore = window.getBilling ? 
  window.getBilling() : null;
  
  // UI message utilisateur
  input.value = "";
  addBubble("🧑 " + msg, "ai-msg ai-me");
  addToChat("user", msg);
  renderChatList();

  const loading = addBubble("⏳ Réflexion...", "ai-msg ai-bot typing");
  sendBtn.disabled = true;

  // ✅ Historique
  let ctxMessages = buildHistoryForAI(10);
  const last = ctxMessages[ctxMessages.length - 1];
  if (!last || last.role !== "user" || last.content !== msg) {
    ctxMessages.push({ role: "user", content: msg });
  }

  // ✅ Mémoire long terme
  const mem = loadUserMemory();
  const name = extractName(msg);
  if (name) {
    mem.name = name;
    saveUserMemory(mem);
  }

  const lang = detectLang(msg);

  const payload = {
    message: msg,
    messages: ctxMessages,
    user_memory: mem,
    language: lang, // ✅ fr | en | ar
    ocr_text: window.lastOcrText || null,
    cost_json: window.lastCost || null,
    margin_json: window.lastMargin || null
  };

  const key = makeCacheKey(payload);
  const cached = cacheGet(key);
  if (cached) {
    loading.classList.remove("typing");
    loading.textContent = "💬 " + cached;
    addToChat("assistant", cached);
    renderChatList();
    sendBtn.disabled = false;
    input.focus();
    return;
  }

  try {
    const r = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!r.ok) throw new Error("HTTP " + r.status);

    const data = await r.json();
    const answer = (data.answer || data.error || "Pas de réponse.");
    // ✅ Consommer seulement si succès
    const use = window.consumeAI?.();
    if (!use?.ok) {
  alert("❌ Limite IA atteinte");
  return;
    }
    if (typeof refreshPricingUI === "function") refreshPricingUI();
    
    loading.classList.remove("typing");
    loading.textContent = "💬 " + answer;

    cacheSet(key, answer);
    addToChat("assistant", answer);
    renderChatList();

  } catch (e) {
    console.error("AI error:", e);

    // 🔁 Remboursement si l'appel a échoué
    if (bBefore && window.setBilling) {
      window.setBilling(bBefore);
      if (typeof refreshPricingUI === "function") refreshPricingUI();
    }

    loading.classList.remove("typing");
    loading.textContent = "Erreur: Impossible de contacter l'IA";
    addToChat("assistant", "Erreur: Impossible de contacter l'IA");
    renderChatList();

  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}



  sendBtn.addEventListener("click", sendToAI);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendToAI();
    }
  });

  newChatBtn.addEventListener("click", () => {
    createChat();
    renderCurrentChat();
    renderChatList();
    closeSidebar();
    input.focus();
  });

  // Init
  if (loadChats().length === 0) createChat();
  renderCurrentChat();
  renderChatList();
});