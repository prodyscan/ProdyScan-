import os
import re
from typing import Optional, Dict, Any, List

from huggingface_hub import InferenceClient

# -----------------------------
# Config
# -----------------------------
HF_TOKEN = (os.getenv("HF_TOKEN") or "").strip()
MODEL_ID = (os.getenv("QWEN_MODEL_ID") or "Qwen/Qwen2.5-7B-Instruct").strip()

client = InferenceClient(
    model=MODEL_ID,
    token=HF_TOKEN if HF_TOKEN else None
)

# -----------------------------
# Prompt (renforcé)
# -----------------------------
SYSTEM_PROMPT = """
You are AliScan Assistant.

AliScan is an INDEPENDENT analysis application.
AliScan is NOT affiliated with Alibaba.

IMPORTANT:
- Alibaba = marketplace
- AliScan = independent analysis app that analyzes USER-PROVIDED data.

YOU MUST NOT say AliScan is from Alibaba.
YOU MUST NOT invent features (live price search, notifications, access Alibaba systems, etc).

CONVERSATION RULE:
- Do NOT greet again after the first assistant message.
- Continue naturally from prior context.

LANGUAGE RULE (STRICT):
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

        # ⚠️ Corriger UNIQUEMENT si AliScan est concerné
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
        parts.append("[USER_MEMORY]\n" + str(user_memory))

    if ocr_text:
        parts.append("[OCR_TEXT]\n" + ocr_text.strip())

    if cost_json:
        parts.append("[COST_DATA]\n" + str(cost_json))

    if margin_json:
        parts.append("[MARGIN_DATA]\n" + str(margin_json))

    parts.append("[USER_MESSAGE]\n" + (message or "").strip())
    return "\n\n".join(parts)

def _strip_repeated_greeting(answer: str, has_history: bool) -> str:
    """
    Si on a déjà un historique, évite "Bonjour" au début.
    (petite rustine qui marche très bien en prod)
    """
    if not has_history:
        return answer

    a = answer.lstrip()
    # supprime "Bonjour ..." en tout début
    a = re.sub(r"^(bonjour|bonsoir|salut)\s*[!.,:–-]*\s*", "", a, flags=re.I)
    return a.strip()

# -----------------------------
# Public function
# -----------------------------
def ask_qwen(
    message: str,
    language: str = "auto",
    messages: Optional[List[Dict[str, Any]]] = None,        # ✅ mémoire courte
    user_memory: Optional[Dict[str, Any]] = None,           # ✅ mémoire long terme
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
        completion = client.chat_completion(
            messages=chat_messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        answer = completion.choices[0].message["content"]

        answer = sanitize_answer(answer)
        answer = _strip_repeated_greeting(answer, has_history)

        return {"answer": answer, "model": MODEL_ID}

    except Exception as e:
        # fallback text_generation
        try:
            prompt = system
            if history:
                hist_txt = "\n".join([f"{m['role'].upper()}: {m['content']}" for m in history])
                prompt += "\n\n" + hist_txt
            prompt += "\n\n" + user_payload + "\n\nAssistant:"

            out = client.text_generation(
                prompt,
                max_new_tokens=max_tokens,
                temperature=temperature,
                do_sample=True,
                return_full_text=False,
            )

            if isinstance(out, str):
                answer = out
            elif isinstance(out, dict) and "generated_text" in out:
                answer = out["generated_text"]
            else:
                answer = str(out)

            answer = sanitize_answer(answer)
            answer = _strip_repeated_greeting(answer, has_history)

            return {"answer": answer.strip(), "model": MODEL_ID}

        except Exception as e2:
            return {
                "error": "⏳ Optimisation en cours pour un meilleur résultat… Merci de réessayer dans quelques instants.",
                "detail": str(e),
                "detail2": str(e2),
                "model": MODEL_ID,
                "has_token": bool(HF_TOKEN),
            }