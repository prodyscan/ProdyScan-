import os
import re
import json
import requests
from typing import Optional, Dict, Any, List

# -----------------------------
# Config Mistral
# -----------------------------
MISTRAL_API_KEY = (os.getenv("MISTRAL_API_KEY") or "").strip()
MISTRAL_MODEL = (os.getenv("MISTRAL_MODEL") or "mistral-small-latest").strip()
MISTRAL_URL = (os.getenv("MISTRAL_URL") or "https://api.mistral.ai/v1/chat/completions").strip()

# -----------------------------
# Prompt (optimisé Mistral)
# -----------------------------
SYSTEM_PROMPT = """
You are AliScan Assistant.

AliScan is an INDEPENDENT analysis application.
AliScan is NOT affiliated with Alibaba.

Hard rules:
- Never claim AliScan is owned by, built by, or affiliated with Alibaba.
- Never invent capabilities (live web browsing, access to Alibaba systems, real-time verification, notifications, internal databases).
- Use ONLY the user-provided data: text message, OCR text, cost/margin JSON, and user memory.

Conversation:
- Do NOT greet again after the first assistant message.
- Continue naturally from prior context.

Language (strict):
- If the user writes in French -> respond ONLY in French.
- Never switch language unless explicitly asked.
""".strip()

FORBIDDEN_PHRASES = [
    "aliscan est",
    "ali scan est",
    "application alibaba",
    "outil alibaba",
    "fourni par alibaba",
    "développé par alibaba",
    "créé par alibaba",
    "appartenant à alibaba",
]

LEGAL_CORRECTION_FR = (
    "AliScan est une application d’analyse indépendante, non affiliée à Alibaba. "
    "Elle aide à analyser des données issues d’Alibaba (captures, produits, fournisseurs, coûts) "
    "uniquement à partir des informations fournies par l’utilisateur."
)

# -----------------------------
# Helpers
# -----------------------------
def sanitize_answer(answer: str) -> str:
    ans = (answer or "").strip()
    lower = ans.lower()

    if "aliscan" in lower:
        for phrase in FORBIDDEN_PHRASES:
            if phrase in lower:
                return LEGAL_CORRECTION_FR

    return ans

def _normalize_language(lang: Optional[str]) -> str:
    if not lang:
        return "auto"
    lang = lang.strip().lower()
    if lang in ("auto", "detect", "autodetect"):
        return "auto"
    if "-" in lang:
        lang = lang.split("-")[0]
    return lang if lang in {"auto", "fr", "en", "ar", "es", "pt"} else "auto"

def _sanitize_history_messages(
    messages: Optional[List[Dict[str, Any]]],
    max_items: int = 12,
    max_chars_each: int = 900
) -> List[Dict[str, str]]:
    if not messages:
        return []
    cleaned: List[Dict[str, str]] = []
    for m in messages[-max_items:]:
        if not isinstance(m, dict):
            continue
        role = (m.get("role") or "").strip().lower()
        content = m.get("content")
        if role not in ("user", "assistant"):
            continue
        if not isinstance(content, str):
            continue
        content = content.strip()
        if not content:
            continue
        cleaned.append({"role": role, "content": content[:max_chars_each]})
    return cleaned

def _build_user_payload(
    message: str,
    ocr_text: Optional[str],
    cost_json: Optional[Dict[str, Any]],
    margin_json: Optional[Dict[str, Any]],
    user_memory: Optional[Dict[str, Any]],
) -> str:
    parts: List[str] = []

    if user_memory:
        parts.append("[USER_MEMORY]\n" + json.dumps(user_memory, ensure_ascii=False))

    if ocr_text:
        parts.append("[OCR_TEXT]\n" + ocr_text.strip())

    if cost_json:
        parts.append("[COST_DATA]\n" + json.dumps(cost_json, ensure_ascii=False))

    if margin_json:
        parts.append("[MARGIN_DATA]\n" + json.dumps(margin_json, ensure_ascii=False))

    parts.append("[USER_MESSAGE]\n" + (message or "").strip())
    return "\n\n".join(parts)

def _strip_repeated_greeting(answer: str, has_history: bool) -> str:
    if not has_history:
        return answer
    a = answer.lstrip()
    a = re.sub(r"^(bonjour|bonsoir|salut)\s*[!.,:–-]*\s*", "", a, flags=re.I)
    return a.strip()

def _mistral_chat(messages: List[Dict[str, str]], temperature: float, max_tokens: int) -> str:
    if not MISTRAL_API_KEY:
        raise RuntimeError("Missing MISTRAL_API_KEY")

    r = requests.post(
        MISTRAL_URL,
        headers={
            "Authorization": f"Bearer {MISTRAL_API_KEY}",
            "Content-Type": "application/json"
        },
        json={
            "model": MISTRAL_MODEL,
            "messages": messages,
            "temperature": float(temperature),
            "max_tokens": int(max_tokens),
        },
        timeout=60
    )

    if not r.ok:
        raise RuntimeError(f"Mistral HTTP {r.status_code}: {r.text[:500]}")

    data = r.json()
    return (data["choices"][0]["message"]["content"] or "").strip()

# -----------------------------
# Public function (on garde le nom pour éviter de modifier app.py)
# -----------------------------
def ask_qwen(
    message: str,
    language: str = "auto",
    messages: Optional[List[Dict[str, Any]]] = None,        # mémoire courte
    user_memory: Optional[Dict[str, Any]] = None,           # mémoire long terme
    ocr_text: Optional[str] = None,
    cost_json: Optional[Dict[str, Any]] = None,
    margin_json: Optional[Dict[str, Any]] = None,
    temperature: float = 0.4,
    max_tokens: int = 800,
) -> dict:

    language_target = _normalize_language(language)
    system = f"LANGUAGE_TARGET={language_target}\n\n{SYSTEM_PROMPT}"

    history = _sanitize_history_messages(messages, max_items=12)
    has_history = len(history) > 0

    user_payload = _build_user_payload(message, ocr_text, cost_json, margin_json, user_memory)

    chat_messages: List[Dict[str, str]] = [{"role": "system", "content": system}]
    chat_messages.extend(history)
    chat_messages.append({"role": "user", "content": user_payload})

    try:
        answer = _mistral_chat(chat_messages, temperature=temperature, max_tokens=max_tokens)
        answer = sanitize_answer(answer)
        answer = _strip_repeated_greeting(answer, has_history)
        return {"answer": answer, "model": MISTRAL_MODEL}

    except Exception as e:
        return {
            "error": "⏳ Optimisation en cours pour un meilleur résultat… Merci de réessayer dans quelques instants.",
            "detail": str(e),
            "model": MISTRAL_MODEL,
            "has_key": bool(MISTRAL_API_KEY),
        }
