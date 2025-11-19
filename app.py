import os
import base64
import json
import hashlib
from io import BytesIO

from flask import Flask, request, jsonify, render_template
from PIL import Image, ImageOps, ImageEnhance
import pytesseract
from urllib.parse import quote_plus

# ============================
#   CONFIG GLOBALE
# ============================

UPLOAD_FOLDER = "./uploads"
CACHE_FILE = "cache.json"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

app = Flask(__name__)

# ============================
#   OPENAI VISION (optionnel)
# ============================

from openai import OpenAI

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None
print("DEBUG OPENAI_API_KEY present:", bool(OPENAI_API_KEY))
print("DEBUG client initialisé:", client is not None)

def ai_describe_image(image_bytes: bytes) -> str | None:
    """
    Utilise GPT-4o-mini Vision pour décrire le produit.
    Retourne une phrase courte utilisable comme requête de recherche.
    """
    if client is None:
        print("DEBUG ai_describe_image: client is None")
        return None

    try:
        b64 = base64.b64encode(image_bytes).decode("utf-8")

        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "Décris précisément le produit visible sur cette image. "
                                "Donne UNE seule phrase courte, optimisée pour une recherche "
                                "en boutique en ligne. Réponds uniquement par la description du produit."
                            ),
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{b64}"
                            },
                        },
                    ],
                }
            ],
            max_tokens=80,
        )

        # Le SDK renvoie une liste de blocs de contenu
        blocks = resp.choices[0].message.content
        text = ""

        if isinstance(blocks, list):
            parts = []
            for b in blocks:
                # Les blocs texte ont un attribut .text
                if hasattr(b, "text") and b.text:
                    parts.append(b.text)
            text = " ".join(parts).strip()
        else:
            text = str(blocks).strip()

        print("DEBUG ai_text:", repr(text))
        return text or None

    except Exception as e:
        print("Erreur IA :", repr(e))
        return None


# ============================
#   BOUTIQUES & PAYS
# ============================

SHOP_TEMPLATES = {
    "jumia": {
        "ci": "https://www.jumia.ci/catalog/?q={q}",
        "sn": "https://www.jumia.sn/catalog/?q={q}",
        "ma": "https://www.jumia.ma/catalog/?q={q}",
        "default": "https://www.jumia.com/catalog/?q={q}",
    },
    "amazon": {
        "fr": "https://www.amazon.fr/s?k={q}",
        "us": "https://www.amazon.com/s?k={q}",
        "default": "https://www.amazon.com/s?k={q}",
    },
    "aliexpress": {
        "default": "https://www.aliexpress.com/wholesale?SearchText={q}",
    },
    "ebay": {
        "default": "https://www.ebay.com/sch/i.html?_nkw={q}",
    },
    "cdiscount": {
        "fr": "https://www.cdiscount.com/search/10/{q}.html",
        "default": "https://www.cdiscount.com/search/10/{q}.html",
    },
    "alibaba": {
        "default": "https://www.alibaba.com/trade/search?SearchText={q}",
    },
}

DEFAULT_SHOP_URL = "https://www.google.com/search?q={q}"


def build_shop_url(shop: str, country: str, query: str) -> str:
    """
    Construit l'URL de recherche finale.
    """
    shop = (shop or "").lower().strip()
    country = (country or "").lower().strip()
    q = quote_plus(query)

    # Harmoniser les codes pays
    country_aliases = {
        "civ": "ci",
        "côte d’ivoire": "ci",
        "cote d’ivoire": "ci",
        "cote d'ivoire": "ci",
        "sen": "sn",
        "sn": "sn",
        "maroc": "ma",
        "morocco": "ma",
        "france": "fr",
        "fr": "fr",
    }
    country_key = country_aliases.get(country, country)

    conf = SHOP_TEMPLATES.get(shop)
    if isinstance(conf, dict):
        template = conf.get(country_key) or conf.get("default") or DEFAULT_SHOP_URL
        return template.format(q=q)

    # Boutique perso -> Google site:
    if shop:
        return f"https://www.google.com/search?q=site:{quote_plus(shop)}+{q}"

    # Fallback Google simple
    return DEFAULT_SHOP_URL.format(q=q)


# ============================
#   GESTION DU CACHE
# ============================

cache = {}


def load_cache():
    global cache
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                cache = json.load(f)
        except Exception:
            cache = {}
    else:
        cache = {}


def save_cache():
    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print("Erreur sauvegarde cache :", e)


def make_cache_key(image_bytes: bytes, shop: str, country: str) -> str:
    """
    Clé de cache basée sur :
    - contenu de l'image (hash)
    - boutique
    - pays
    """
    h = hashlib.md5(image_bytes).hexdigest()
    return f"{shop}|{country}|{h}"


# Charger le cache au démarrage
load_cache()

# ============================
#   PRÉ-TRAITEMENT IMAGE
# ============================

def preprocess_image(image_bytes: bytes, max_size: int = 800):
    """Ouvre l'image, convertit en RGB, redimensionne, renvoie (PIL, JPEG bytes)."""
    img = Image.open(BytesIO(image_bytes)).convert("RGB")
    img.thumbnail((max_size, max_size))
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return img, buf.getvalue()


# ============================
#   IA VISION – DESCRIPTION
# ============================

def ai_describe_image(image_bytes: bytes) -> str | None:
    """Décrit le produit sur l'image avec OpenAI Vision (si dispo)."""
    if client is None:
        return None

    try:
        b64 = base64.b64encode(image_bytes).decode("utf-8")

        resp = client.chat.completions.create(
            model="gpt-4o-mini-vision",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "Regarde cette image et décris précisément le produit : "
                                "type, style, couleur, genre (homme/femme/enfant), "
                                "usage (sport, casual, bureau, etc.). "
                                "Donne une phrase courte qui pourrait servir "
                                "de requête pour trouver ce produit en boutique en ligne."
                            ),
                        },
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
                        },
                    ],
                }
            ],
            max_tokens=120,
        )

        content_blocks = resp.choices[0].message.content
        if isinstance(content_blocks, list):
            text_parts = [b.text for b in content_blocks if hasattr(b, "text")]
            description = " ".join(text_parts).strip()
        else:
            description = str(content_blocks).strip()

        return description or None

    except Exception as e:
        print("Erreur IA :", e)
        return None


# ============================
#   OCR (TEXTE DANS L’IMAGE)
# ============================

def ocr_extract_text(pil_img: Image.Image) -> str:
    """OCR basique avec pytesseract (gratuit)."""
    try:
        enhanced = ImageEnhance.Contrast(pil_img).enhance(2.0)
        gray = ImageOps.grayscale(enhanced)
        text = pytesseract.image_to_string(gray)
        return text.strip()
    except Exception as e:
        print("Erreur OCR :", e)
        return ""


# ============================
#   ROUTES FLASK
# ============================

@app.route("/")
def home():
    return render_template("index.html")


@app.route("/analyse", methods=["POST"])
def analyse():
    """
    Endpoint principal :
    - Reçoit une image (form-data "file")
    - Paramètres envoyés dans le FormData : country, shop, custom_shop
    """

    # 1) Récupérer l'image
    if not request.files and not request.get_data():
        return jsonify({"ok": False, "error": "Aucune image reçue."}), 400

    if request.files:
        file = request.files.get("file")
        if not file:
            return jsonify({"ok": False, "error": "Champ 'file' manquant."}), 400
        raw_bytes = file.read()
    else:
        raw_bytes = request.get_data()

    if not raw_bytes:
        return jsonify({"ok": False, "error": "Image vide."}), 400

    # 2) Boutique & pays (FormData d'abord, sinon query)
    shop = (request.form.get("shop")
            or request.args.get("shop")
            or "").strip().lower()

    country = (request.form.get("country")
               or request.args.get("country")
               or "").strip().lower()

    custom_shop = (request.form.get("custom_shop") or "").strip()

    # Ce qui sera utilisé pour l'URL
    if shop == "custom" and custom_shop:
        shop_for_url = custom_shop
        shop_label = custom_shop
    else:
        shop_for_url = shop
        shop_label = shop or ""

    # 3) Cache
    key = make_cache_key(raw_bytes, shop_for_url, country)
    if key in cache:
        data = cache[key]
        data_out = dict(data)
        data_out["ok"] = True
        data_out["from_cache"] = True
        data_out["source"] = data_out.get("source", "cache")
        return jsonify(data_out), 200

    # 4) Pré-traitement image
    try:
        pil_img, processed_bytes = preprocess_image(raw_bytes)
    except Exception:
        return jsonify({"ok": False, "error": "Impossible de lire l'image."}), 400

    # 5) IA Vision
    ai_text = ai_describe_image(processed_bytes)

    # 6) OCR
    ocr_text = ocr_extract_text(pil_img)

    # 7) Choix du texte final + source
    print("DEBUG ai_text (analyse):", repr(ai_text))
    print("DEBUG ocr_text (analyse):", repr(ocr_text))

    if ai_text:
        final_query = ai_text
        source = "ai-only"
    elif ocr_text:
        final_query = ocr_text
        source = "ocr-only"
    else:
        # Ici on NE FAIT PLUS de fallback générique silencieux
        return jsonify({
            "ok": False,
            "error": "Impossible de décrire le produit (IA et OCR vides).",
        }), 500

    # 8) Construire l'URL de recherche
    final_url = build_shop_url(shop_for_url, country, final_query)

    # 9) Préparer la réponse
    response_data = {
        "ok": True,
        "description": final_query,
        "shop": shop_for_url or None,
        "shop_label": shop_label or None,
        "country": country or "global",
        "url": final_url,
        "source": source,
        "from_cache": False,
        "openai_enabled": client is not None,
    }

    # 10) Sauvegarder dans le cache
    cache[key] = {
        "description": response_data["description"],
        "shop": response_data["shop"],
        "shop_label": response_data["shop_label"],
        "country": response_data["country"],
        "url": response_data["url"],
        "source": response_data["source"],
    }
    save_cache()

    return jsonify(response_data), 200


# ============================
#   LANCEMENT LOCAL / RENDER
# ============================

if __name__ == "__main__":
    # Render fournit toujours la variable d'environnement PORT (par défaut 10000)
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port, debug=False)
