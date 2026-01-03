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
#   AJOUT PRODYSCAN FREE — IMPORTS MOTEUR LOCAL
# ============================
from engines.free_embedder import FreeEmbedder
import numpy as np
import faiss
# =============================================================

# ============================
#   CONFIG GLOBALE
# ============================

UPLOAD_FOLDER = "./uploads"
CACHE_FILE = "cache.json"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

app = Flask(__name__)

app.config["PROPAGATE_EXCEPTIONS"] = True
============================================================

ROUTES PAGES FRONT

============================================================

from flask import redirect  # si pas déjà importé

@app.route("/", methods=["GET"])
def home():
return redirect("/image")

@app.route("/image", methods=["GET"])
def page_image():
return render_template("index.html", page_mode="image")

@app.route("/alibaba", methods=["GET"])
def page_alibaba():
return render_template("index.html", page_mode="alibaba")

# ============================
#   OPENAI VISION (optionnel)
# ============================

from openai import OpenAI

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None
print("DEBUG OPENAI_API_KEY present:", bool(OPENAI_API_KEY))
print("DEBUG client initialisé:", client is not None)


def ai_describe_image(image_bytes: bytes) -> str | None:
    if client is None:
        print("DEBUG ai_describe_image: client is None")
        return None

    try:
        b64 = base64.b64encode(image_bytes).decode("utf-8")

        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{
                "role":
                "user",
                "content": [{
                    "type":
                    "text",
                    "text":
                    "Décris précisément le produit visible sur cette image. "
                    "Une seule phrase courte, optimisée pour recherche."
                }, {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/jpeg;base64,{b64}"
                    }
                }],
            }],
            max_tokens=80,
        )

        content = resp.choices[0].message.content

        if isinstance(content, str):
            text = content.strip()
        elif isinstance(content, list):
            parts = []
            for b in content:
                if hasattr(b, "text") and b.text:
                    parts.append(b.text)
            text = " ".join(parts).strip()
        else:
            text = str(content).strip()

        print("DEBUG query_ia (OpenAI) :", repr(text))
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
        "default": "https://www.jumia.com/catalog/?q={q}"
    },
    "amazon": {
        "fr": "https://www.amazon.fr/s?k={q}",
        "us": "https://www.amazon.com/s?k={q}",
        "default": "https://www.amazon.com/s?k={q}"
    },
    "aliexpress": {
        "default": "https://www.aliexpress.com/wholesale?SearchText={q}"
    },
    "ebay": {
        "default": "https://www.ebay.com/sch/i.html?_nkw={q}"
    },
    "cdiscount": {
        "fr": "https://www.cdiscount.com/search/10/{q}.html",
        "default": "https://www.cdiscount.com/search/10/{q}.html"
    },
    "alibaba": {
        "default": "https://www.alibaba.com/trade/search?SearchText={q}"
    },
}

DEFAULT_SHOP_URL = "https://www.google.com/search?q={q}"


def build_shop_url(shop: str, country: str, query: str) -> str:
    shop = (shop or "").lower().strip()
    country = (country or "").lower().strip()
    q = quote_plus(query)

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
        "fr": "fr"
    }
    country_key = country_aliases.get(country, country)

    conf = SHOP_TEMPLATES.get(shop)
    if isinstance(conf, dict):
        template = conf.get(country_key) or conf.get(
            "default") or DEFAULT_SHOP_URL
        return template.format(q=q)

    if shop:
        return f"https://www.google.com/search?q=site:{quote_plus(shop)}+{q}"

    return DEFAULT_SHOP_URL.format(q=q)


# ============================
#   CACHE
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


def make_cache_key(image_bytes: bytes, shop: str, country: str):
    h = hashlib.md5(image_bytes).hexdigest()
    return f"{shop}|{country}|{h}"


load_cache()

# ============================
#   PRÉ-TRAITEMENT IMAGE
# ============================


def preprocess_image(image_bytes: bytes, max_size: int = 800):
    img = Image.open(BytesIO(image_bytes)).convert("RGB")
    img.thumbnail((max_size, max_size))
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return img, buf.getvalue()


# ============================
#   OCR
# ============================


def ocr_extract_text(pil_img: Image.Image):
    try:
        enhanced = ImageEnhance.Contrast(pil_img).enhance(2.0)
        gray = ImageOps.grayscale(enhanced)
        text = pytesseract.image_to_string(gray)
        return text.strip()
    except Exception as e:
        print("Erreur OCR :", e)
        return ""


# ============================
#   AJOUT PRODYSCAN : CHARGER INDEX LOCAL (FREE)
# ============================

FREE_INDEX_PATH = "artifacts/free/index.faiss"
FREE_IDS_PATH = "artifacts/free/ids.json"
FREE_CATALOG_PATH = "data/catalog.json"

try:
    index = faiss.read_index(FREE_INDEX_PATH)
    with open(FREE_IDS_PATH, "r", encoding="utf-8") as f:
        index_ids = json.load(f)
    with open(FREE_CATALOG_PATH, "r", encoding="utf-8") as f:
        catalog = json.load(f)

    print(f"DEBUG: Index FREE chargé ✔ — {len(index_ids)} produits")
except Exception as e:
    print("DEBUG: Impossible de charger index FREE :", e)
    index = None
    index_ids = []
    catalog = []

# ============================
#   ROUTES
# ============================


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/analyse", methods=["POST"])
def analyse():

    # ============================
    #   RÉCEPTION IMAGE
    # ============================

    if not request.files and not request.get_data():
        return jsonify({"ok": False, "error": "Aucune image reçue."}), 400

    if request.files:
        file = request.files.get("file")
        if not file:
            return jsonify({
                "ok": False,
                "error": "Champ 'file' manquant."
            }), 400
        raw_bytes = file.read()
    else:
        raw_bytes = request.get_data()

    if not raw_bytes:
        return jsonify({"ok": False, "error": "Image vide."}), 400

    # ============================
    #   PARAMÈTRES
    # ============================

    shop = (request.form.get("shop") or request.args.get("shop")
            or "").strip().lower()

    country = (request.form.get("country") or request.args.get("country")
               or "").strip().lower()

    custom_shop = (request.form.get("custom_shop") or "").strip()

    if shop == "custom" and custom_shop:
        shop_for_url = custom_shop
        shop_label = custom_shop
    else:
        shop_for_url = shop
        shop_label = shop or ""

    # ============================
    #   CACHE
    # ============================

    key = make_cache_key(raw_bytes, shop_for_url, country)
    if key in cache:
        data = cache[key]
        data_out = dict(data)
        data_out["ok"] = True
        data_out["from_cache"] = True
        return jsonify(data_out), 200

    # ============================
    #   PRÉTRAITEMENT
    # ============================

    try:
        pil_img, processed_bytes = preprocess_image(raw_bytes)
    except Exception:
        return jsonify({
            "ok": False,
            "error": "Impossible de lire l'image."
        }), 400

    # ============================
    #   IA + OCR
    # ============================

    query_ia = ai_describe_image(processed_bytes)
    query_ocr = ocr_extract_text(pil_img)

    # ============================
    #   6) CHOIX DE LA REQUÊTE
    # ============================

    if query_ia and query_ocr:
        final_query = f"{query_ia} {query_ocr}"
        source = "vision+ocr"
    elif query_ia:
        final_query = query_ia
        source = "vision-only"
    elif query_ocr:
        final_query = query_ocr
        source = "ocr-only"
    else:
        final_query = "photo de produit en ligne"
        source = "default"

    # ============================================================
    #   >>> AJOUT PRODYSCAN FREE : RECHERCHE DANS L’INDEX LOCAL
    # ============================================================

    if shop_for_url == "local":
        if index is None:
            return jsonify({
                "ok": False,
                "error": "Index local indisponible"
            }), 500

        embedder = FreeEmbedder()
        query_vec = embedder.embed_image(pil_img)
        query_vec = np.array(query_vec).astype("float32").reshape(1, -1)

        distances, indices = index.search(query_vec, 5)

        results = []
        for idx in indices[0]:
            if 0 <= idx < len(index_ids):
                pid = index_ids[idx]
                for p in catalog:
                    if str(p["id"]) == str(pid):
                        results.append(p)
                        break

        return jsonify({
            "ok": True,
            "source": "local-index",
            "results": results,
        }), 200

    # ============================
    #   7) URL BOUTIQUE EN LIGNE
    # ============================

    final_url = build_shop_url(shop_for_url, country, final_query)

    # ============================
    #   RÉPONSE CLASSIQUE
    # ============================

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
#   RUN
# ============================

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port, debug=True)
