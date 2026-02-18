import os
import re
import json
import requests
from typing import Optional, Dict, Any, List

# -----------------------------
# Config (Render / Github)
# -----------------------------
MISTRAL_API_KEY = (os.getenv("MISTRAL_API_KEY") or "").strip()
MODEL_ID = (os.getenv("MISTRAL_MODEL") or "mistral-small-latest").strip()
MISTRAL_URL = (os.getenv("MISTRAL_URL") or "https://api.mistral.ai/v1/chat/completions").strip()

# -----------------------------
# Prompt (optimisé Mistral)
# -----------------------------
SYSTEM_PROMPT = """
Tu es AliScan Assistant.

AliScan est une application d’analyse INDÉPENDANTE.
AliScan n’est PAS affiliée à Alibaba.

Règles obligatoires :
- Alibaba = marketplace.
- AliScan = outil indépendant qui analyse uniquement les données fournies par l’utilisateur (captures, texte OCR, infos produit, coûts, marge).
- Ne dis JAMAIS qu’AliScan vient d’Alibaba.
- N’invente JAMAIS d’accès à Alibaba (prix en temps réel, comptes, commandes, notifications, bases internes, etc.).
- Si une info manque, pose 1 question courte ou propose une hypothèse clairement marquée.

Conversation :
- Ne répète pas “Bonjour” si la discussion a déjà commencé.
- Continue naturellement avec le contexte.

Langue (strict) :
- Si l’utilisateur écrit en français -> réponds uniquement en français.
- Ne change pas de langue sauf demande explicite.
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


def _call_mistral_chat(messages: List[Dict[str, str]], temperature: float, max_tokens: int) -> str:
    if not MISTRAL_API_KEY:
        raise RuntimeError("MISTRAL_API_KEY manquant (Render env var).")

    headers = {
        "Authorization": f"Bearer {MISTRAL_API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    payload = {
        "model": MODEL_ID,
        "messages": messages,
        "temperature": float(temperature),
        "max_tokens": int(max_tokens),
    }

    r = requests.post(MISTRAL_URL, headers=headers, json=payload, timeout=60)

    if r.status_code >= 400:
        try:
            detail = r.json()
        except Exception:
            detail = {"raw": r.text}
        raise RuntimeError(f"Mistral HTTP {r.status_code}: {detail}")

    data = r.json()
    # format attendu: choices[0].message.content
    return (data.get("choices", [{}])[0].get("message", {}) or {}).get("content", "") or ""


# -----------------------------
# Public function (GARDER LE NOM)
# -----------------------------
def ask_qwen(
    message: str,
    language: str = "auto",
    messages: Optional[List[Dict[str, Any]]] = None,
    user_memory: Optional[Dict[str, Any]] = None,
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
        answer = _call_mistral_chat(chat_messages, temperature=temperature, max_tokens=max_tokens)
        answer = sanitize_answer(answer)
        answer = _strip_repeated_greeting(answer, has_history)
        return {"answer": answer, "model": MODEL_ID}

    except Exception as e:
        return {
            "error": "⏳ Impossible de contacter l'IA pour le moment. Réessaie dans quelques instants.",
            "detail": str(e),
            "model": MODEL_ID,
            "has_key": bool(MISTRAL_API_KEY),
        }
