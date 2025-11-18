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

# ... le reste de ton code au-dessus ne change pas

@app.route("/")
def home():
    # Affiche la page HTML
    return render_template("index.html")
@app.route("/api/scan", methods=["POST"])
def api_scan():
    # On récupère le JSON envoyé par le front
    data = request.get_json(silent=True) or {}
    code = (data.get("code") or "").strip()

    if not code:
        return jsonify({
            "ok": False,
            "error": "Code produit manquant."
        }), 400

    # --- LOGIQUE D'EXEMPLE ---
    # Ici tu peux mettre ta vraie logique métier plus tard.
    # Pour l'instant on fait un petit algo simple :

    status = "Authentique"
    risk_level = "faible"
    details = "Produit jugé authentique (exemple de logique)."

    # Si le code contient 'FAKE' on le marque comme suspect, juste pour la démo
    if "FAKE" in code.upper():
        status = "Suspect"
        risk_level = "élevé"
        details = "Ce code semble invalide ou suspect."

    response = {
        "ok": True,
        "code": code,
        "product_name": f"Produit {code}",
        "status": status,
        "risk_level": risk_level,
        "details": details,
    }

    return jsonify(response), 200
# Client OpenAI
import os
from openai import OpenAI

# on lit la clé dans les variables d'environnement
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None

# ============================
#   BOUTIQUES & URL
# ============================

SHOP_TEMPLATES = {
    # Afrique / général
    "jumia": "https://www.google.com/search?q=site:jumia+{q}",

    # International
    "amazon": "https://www.amazon.com/s?k={q}",
    "aliexpress": "https://www.aliexpress.com/wholesale?SearchText={q}",
    "ebay": "https://www.ebay.com/sch/i.html?_nkw={q}",
    "cdiscount": "https://www.cdiscount.com/search/10/{q}.html",
    "alibaba": "https://www.alibaba.com/trade/search?SearchText={q}",
}

# Si la boutique est inconnue → recherche Google classique
DEFAULT_SHOP_URL = "https://www.google.com/search?q={q}"


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
        print("Erreur sauvegarde cache:", e)


def make_cache_key(image_bytes, shop):
    h = hashlib.md5(image_bytes).hexdigest()
    return f"{shop}|{h}"


# ============================
#   PRÉ-TRAITEMENT IMAGE
# ============================

def preprocess_image(image_bytes, max_size=800):
    """
    - Convertit l'image en RGB
    - La redimensionne à max 800x800 (moins cher / plus rapide)
    - Retourne (pil_image, bytes_compressés)
    """
    img = Image.open(BytesIO(image_bytes)).convert("RGB")
    img.thumbnail((max_size, max_size))
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return img, buf.getvalue()


# ============================
#   IA VISION – DESCRIPTION PRODUIT
# ============================

def ai_describe_image(image_bytes):
    """
    Utilise OpenAI Vision si possible.
    Retourne une description texte ou None si échec.
    """
    if client is None:
        # Pas de clé → on ne tente même pas
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
                                "Regarde cette image et décris précisément le produit : "
                                "type, style, couleur, genre (homme/femme/enfant), "
                                "matière si possible. Donne une phrase courte qui pourrait "
                                "servir de requête de recherche pour l'acheter en ligne."
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

        # Nouveau SDK : message.content est une liste de blocs
        content_blocks = resp.choices[0].message.content
        if isinstance(content_blocks, list):
            text_parts = [b.text for b in content_blocks if hasattr(b, "text")]
            description = " ".join(text_parts).strip()
        else:
            # Au cas où ce soit déjà une string
            description = str(content_blocks).strip()

        return description or None

    except Exception as e:
        print("Erreur IA :", e)
        return None


# ============================
#   OCR (SECOURS GRATUIT)
# ============================

def ocr_extract_text(pil_img):
    try:
        enhanced = ImageEnhance.Contrast(pil_img).enhance(2.0)
        gray = ImageOps.grayscale(enhanced)
        text = pytesseract.image_to_string(gray)
        return text.strip()
    except Exception as e:
        print("Erreur OCR :", e)
        return ""


# ============================
#   ROUTE /analyse
# ============================

@app.route("/analyse", methods=["POST"])
def analyse():
    # 1) Vérifier l'image reçue
    if not request.files and not request.get_data():
        return jsonify({"error": "Aucune image reçue."}), 400

    if request.files:
        file = request.files.get("file")
        if not file:
            return jsonify({"error": "Champ 'file' manquant."}), 400
        raw_bytes = file.read()
    else:
        raw_bytes = request.get_data()

    if not raw_bytes:
        return jsonify({"error": "Image vide."}), 400

    # 2) Boutique demandée (peut être vide)
    shop = request.args.get("shop", "").lower().strip()

    # 3) Vérifier le cache
    key = make_cache_key(raw_bytes, shop)
    if key in cache:
        data = cache[key]
        # On ajoute juste une info pour toi (source=cache)
        data_with_source = dict(data)
        data_with_source["source"] = "cache"
        return jsonify(data_with_source), 200

    # 4) Pré-traitement image
    try:
        pil_img, processed_bytes = preprocess_image(raw_bytes)
    except Exception:
        return jsonify({"error": "Impossible de lire l'image."}), 400

    # 5) IA Vision (payant)
    ai_text = ai_describe_image(processed_bytes)

    # 6) OCR (gratuit) en secours ou pour compléter
    ocr_text = ocr_extract_text(pil_img)

    # Choix du texte final
    if ai_text:
        final_query = ai_text
        ai_used = True
    elif ocr_text:
        final_query = ocr_text
        ai_used = False
    else:
        return jsonify({"error": "Impossible de reconnaître le produit."}), 400

    # 7) Construire l'URL de recherche
    url_template = SHOP_TEMPLATES.get(shop, DEFAULT_SHOP_URL)
    final_url = url_template.format(q=quote_plus(final_query))

    # 8) Préparer la réponse
    response_data = {
        "description": final_query,
        "shop": shop if shop else "google",
        "url": final_url,
        "source": "ai+ocr" if ai_used else "ocr-only",
    }

    # 9) Sauvegarder dans le cache
    cache[key] = {
        "description": response_data["description"],
        "shop": response_data["shop"],
        "url": response_data["url"],
    }
    save_cache()

    return jsonify(response_data), 200


# ============================
#   LANCEMENT
# ============================

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
