import os
import json
import base64
from io import BytesIO
from typing import List, Dict, Tuple, Optional

from flask import Flask, request, jsonify, render_template
from PIL import Image, ImageOps, ImageEnhance
from urllib.parse import quote_plus

import pytesseract
import numpy as np
import faiss
import torch
import open_clip
from engines.free_embedder import FreeEmbedder

embedder = FreeEmbedder()
# ============================================================
#  FLASK APP
# ============================================================

app = Flask(__name__)

# ============================================================
#  CONFIG GLOBALE
# ============================================================

# Dossiers & fichiers
DATA_DIR = "./data"
ARTIFACT_DIR = "./artifacts/free"

CATALOG_FILE = os.path.join(DATA_DIR, "catalog.json")
EMB_FILE = os.path.join(ARTIFACT_DIR, "embeddings.npy")
FAISS_FILE = os.path.join(ARTIFACT_DIR, "index.faiss")
IDS_FILE = os.path.join(ARTIFACT_DIR, "ids.json")

# ============================================================
#  OPENAI (optionnel) - Vision pour décrire l'image
# ============================================================

try:
    from openai import OpenAI  # nouveau client
    openai_api_key = os.environ.get("OPENAI_API_KEY")
    openai_client = OpenAI(api_key=openai_api_key) if openai_api_key else None
except Exception:
    openai_client = None


def ai_describe_image(image_bytes: bytes) -> Optional[str]:
    """
    Décrit l'image avec le modèle Vision (si disponible).
    Retourne une phrase, ou None si indisponible / erreur.
    """
    if openai_client is None:
        return None

    try:
        b64 = base64.b64encode(image_bytes).decode("utf-8")
        prompt = (
            "Décris en une seule phrase courte le type de produit visible "
            "sur cette photo, pour une recherche e-commerce.")

        completion = openai_client.chat.completions.create(
            model="gpt-4.1-mini",
            messages=[{
                "role":
                "user",
                "content": [
                    {
                        "type": "text",
                        "text": prompt
                    },
                    {
                        "type": "input_image",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{b64}"
                        },
                    },
                ],
            }],
            max_tokens=60,
        )

        text = completion.choices[0].message.content or ""
        text = text.strip()
        if not text:
            return None
        return text
    except Exception:
        return None


# ============================================================
#  OCR (pytesseract)
# ============================================================


def ocr_extract_text(img: Image.Image) -> Optional[str]:
    """Essaye de récupérer du texte dans l'image (ex: étiquette, marque)."""
    try:
        text = pytesseract.image_to_string(img, lang="eng+fra")
        text = text.strip()
        if len(text) < 5:
            return None
        return text
    except Exception:
        return None


# ============================================================
#  PRÉTRAITEMENT IMAGE
# ============================================================


def preprocess_image(raw_bytes: bytes) -> Tuple[Image.Image, bytes]:
    """
    - Charge l'image avec PIL
    - Convertit en RGB, redimensionne si besoin
    - Retourne (PIL_image, bytes_jpeg_compact)
    """
    img = Image.open(BytesIO(raw_bytes)).convert("RGB")

    max_side = 1024
    w, h = img.size
    if max(w, h) > max_side:
        img.thumbnail((max_side, max_side), Image.LANCZOS)

    img = ImageOps.autocontrast(img)
    enhancer = ImageEnhance.Contrast(img)
    img = enhancer.enhance(1.05)

    buf = BytesIO()
    img.save(buf, format="JPEG", quality=90)
    processed_bytes = buf.getvalue()

    return img, processed_bytes


# ============================================================
#  OPENCLIP + FAISS (recherche locale par vecteur)
# ============================================================

clip_model = None
clip_preprocess = None

faiss_index: Optional[faiss.Index] = None
faiss_ids: List[str] = []
faiss_ready = False

# catalogue en mémoire : id -> produit (dict)
catalog_by_id: Dict[str, Dict] = {}


def init_openclip():
    """Charge le modèle CLIP (ViT-B-32 / openai) une seule fois."""
    global clip_model, clip_preprocess
    if clip_model is not None:
        return

    model, preprocess, _ = open_clip.create_model_and_transforms(
        "ViT-B-32",
        pretrained="openai",
    )
    model.eval()
    clip_model = model
    clip_preprocess = preprocess


def embed_image_clip(img: Image.Image) -> np.ndarray:
    """Transforme une image PIL en vecteur CLIP (1, d)."""
    init_openclip()
    assert clip_model is not None and clip_preprocess is not None

    img_t = clip_preprocess(img).unsqueeze(0)  # (1, 3, H, W)
    with torch.no_grad():
        feats = clip_model.encode_image(img_t)
        feats = feats / feats.norm(dim=-1, keepdim=True)

    return feats.cpu().numpy().astype("float32")


def load_catalog() -> bool:
    """Charge le fichier catalog.json en mémoire (id -> produit)."""
    global catalog_by_id

    if catalog_by_id:
        return True

    if not os.path.exists(CATALOG_FILE):
        print("WARN load_catalog: catalog.json introuvable")
        return False

    try:
        with open(CATALOG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)

        catalog_by_id = {}
        for idx, prod in enumerate(data):
            # on essaie plusieurs champs possibles pour l'ID
            pid = prod.get("id") or prod.get("sku") or (idx + 1)
            pid = str(pid)
            catalog_by_id[pid] = prod

        print(f"DEBUG load_catalog: {len(catalog_by_id)} produits chargés")
        return True
    except Exception as e:
        print("ERROR load_catalog:", e)
        catalog_by_id = {}
        return False


def load_faiss_index() -> bool:
    """Charge l'index FAISS et les ids depuis le disque (si dispo)."""
    global faiss_index, faiss_ids, faiss_ready

    if faiss_ready:
        return True

    if not (os.path.exists(FAISS_FILE) and os.path.exists(IDS_FILE)):
        print("WARN load_faiss_index: fichiers FAISS ou ids manquants")
        faiss_ready = False
        return False

    try:
        faiss_index = faiss.read_index(FAISS_FILE)
        with open(IDS_FILE, "r", encoding="utf-8") as f:
            faiss_ids = json.load(f)
        faiss_ready = True
        print(f"DEBUG load_faiss_index: index chargé, {len(faiss_ids)} ids")
        return True
    except Exception as e:
        print("ERROR load_faiss_index:", e)
        faiss_ready = False
        faiss_index = None
        faiss_ids = []
        return False


def local_search_with_faiss(img: Image.Image,
                            k: int = 5) -> Tuple[List[Dict], str]:
    """
    Recherche les produits similaires dans le catalogue local, via FAISS + CLIP.
    Retourne toujours une liste de produits si l'index existe :
      - résultats triés par similarité
      - ou, en dernier recours, les premiers produits du catalogue.
    """
    global faiss_index, faiss_ids, embedder

    # 0) S'assurer que l'index est chargé
    if not load_faiss_index():
        print("DEBUG local_search_with_faiss: index introuvable sur le disque")
        return [], "local-missing"

    # 1) Index indisponible / vide
    if faiss_index is None or faiss_ids is None or not len(faiss_ids):
        print("DEBUG local_search_with_faiss: index vide")
        return [], "local-empty"

    # 2) Embedding de l'image requête
    try:
        vec = embedder.embed_image(img)  # (1, d)
        if isinstance(vec, np.ndarray):
            arr = vec
        else:
            arr = np.array(vec)

        if arr.ndim == 1:
            arr = arr[None, :]

        vec = arr.astype("float32")
    except Exception as e:
        print("ERROR local_search_with_faiss: échec embedding :", e)
        # 🔁 En cas d'erreur d'embed, on renvoie quand même les premiers produits
        fallback: List[Dict] = []
        for idx, item in enumerate(faiss_ids[:k]):
            item = item or {}
            fallback.append({
                "title":
                item.get("title") or item.get("name") or f"Produit {idx+1}",
                "brand":
                item.get("brand") or item.get("marque") or "",
                "price":
                item.get("price"),
                "image_url":
                item.get("image_url") or item.get("image") or "",
                "url":
                item.get("url") or item.get("link") or "",
                "score":
                0.0,
            })
        return fallback, "local-fallback-embed"

    # 3) Recherche FAISS
    try:
        D, I = faiss_index.search(vec, k)  # D: distances, I: indices
        print("DEBUG FAISS distances:", D, "indices:", I)

        results: List[Dict] = []

        neighbors = zip(D[0], I[0])
        for dist, idx in neighbors:
            if idx < 0 or idx >= len(faiss_ids):
                continue

            item = faiss_ids[idx] or {}
            result = {
                "title": item.get("title") or item.get("name")
                or f"Produit {idx+1}",
                "brand": item.get("brand") or item.get("marque") or "",
                "price": item.get("price"),  # peut être None
                "image_url": item.get("image_url") or item.get("image") or "",
                "url": item.get("url") or item.get("link") or "",
                "score": float(dist),
            }
            results.append(result)

        # 4) Si FAISS renvoie rien, on renvoie au moins quelques produits du catalogue
        if not results:
            print(
                "DEBUG local_search_with_faiss: aucun voisin, fallback sur premiers produits"
            )
            fallback: List[Dict] = []
            for idx, item in enumerate(faiss_ids[:k]):
                item = item or {}
                fallback.append({
                    "title":
                    item.get("title") or item.get("name")
                    or f"Produit {idx+1}",
                    "brand":
                    item.get("brand") or item.get("marque") or "",
                    "price":
                    item.get("price"),
                    "image_url":
                    item.get("image_url") or item.get("image") or "",
                    "url":
                    item.get("url") or item.get("link") or "",
                    "score":
                    0.0,
                })
            return fallback, "local-faiss-fallback"

        return results, "local-faiss"

    except Exception as e:
        print("ERROR local_search_with_faiss: erreur FAISS :", e)
        # 🔁 En cas d'erreur FAISS, on renvoie aussi les premiers produits
        fallback: List[Dict] = []
        for idx, item in enumerate(faiss_ids[:k]):
            item = item or {}
            fallback.append({
                "title":
                item.get("title") or item.get("name") or f"Produit {idx+1}",
                "brand":
                item.get("brand") or item.get("marque") or "",
                "price":
                item.get("price"),
                "image_url":
                item.get("image_url") or item.get("image") or "",
                "url":
                item.get("url") or item.get("link") or "",
                "score":
                0.0,
            })
        return fallback, "local-error-faiss"


# ============================================================
#  CONSTRUCTION URL BOUTIQUE EXTERNE
# ============================================================


def build_shop_url(query: str, shop_for_url: str, country: str) -> str:
    """Construit l'URL finale pour Amazon / Google / Jumia / custom."""
    q = quote_plus(query)

    shop = (shop_for_url or "").lower()
    country = (country or "global").lower()

    if shop == "amazon":
        return f"https://www.amazon.com/s?k={q}"

    if shop == "jumia":
        domain = "ci"
        return f"https://www.jumia.{domain}/catalog/?q={q}"

    if shop in ("google", "", None):
        return f"https://www.google.com/search?q={q}"

    if "." in shop:
        base = shop
    else:
        base = f"{shop}.com"

    return f"https://{base}/search?q={q}"


# ============================================================
#  ROUTES
# ============================================================


@app.route("/", methods=["GET"])
def index():
    return render_template("index.html")


@app.route("/analyse", methods=["POST"])
def analyse():
    # 1) Image brute
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
        return jsonify({"ok": False, "error": "Image vide ou invalide."}), 400

    # 2) Paramètres boutique / pays
    shop = (request.form.get("shop") or request.args.get("shop")
            or "").strip().lower()

    country = (request.form.get("country") or request.args.get("country")
               or "global").strip().lower()

    custom_shop = (request.form.get("custom_shop") or "").strip()

    if shop == "custom" and custom_shop:
        shop_for_url = custom_shop
        shop_label = custom_shop
    elif shop == "local":
        shop_for_url = "local"
        shop_label = "Catalogue local (par image)"
    elif shop:
        shop_for_url = shop
        mapping = {
            "amazon": "Amazon",
            "google": "Google Shopping",
            "jumia": "Jumia",
        }
        shop_label = mapping.get(shop, shop)
    else:
        shop_for_url = "google"
        shop_label = "Google Shopping"

    # 3) Prétraitement image
    try:
        pil_img, processed_bytes = preprocess_image(raw_bytes)
    except Exception:
        return jsonify({
            "ok": False,
            "error": "Impossible de lire l'image."
        }), 400

        
# 4) MODE CATALOGUE LOCAL (par image) -> FAISS
    if shop_for_url == "local":
        # Recherche FAISS / fallback local
        results, local_source = local_search_with_faiss(pil_img, k=5)

        # DEBUG pour vérifier ce que FAISS retourne
        print(
            "DEBUG /analyse local -> nb_resultats =",
            len(results),
            "source =",
            local_source,
        )

        # Cas : index vraiment indisponible ou vide
        if (not results) and local_source in ("local-missing", "local-empty"):
            return jsonify(
                {
                    "ok": False,
                    "error": "Index local indisponible (aucun produit).",
                    "source": local_source,
                }
            ), 200

        # Si pour une raison bizarre on a quand même 0 résultat ici,
        # on renvoie un message d'erreur simple.
        if not results:
            return jsonify(
                {
                    "ok": False,
                    "error": "Aucun produit du catalogue local n'a pu être renvoyé.",
                    "source": local_source,
                }
            ), 200

        # URL principale du 1er résultat (pour le gros bouton violet)
        main_url = results[0].get("url") or "#"

    # Préparer le payload pour debug + réponse

    # 👉 On prend l'URL du produit le plus similaire (1er résultat FAISS),
    # si elle existe dans le catalogue
    best_url = None
    if results:
        try:
            best_url = results[0].get("url")
        except Exception:
            best_url = None

    debug_payload = {
        "ok": True,
        "description": "photo de produit en ligne",
        "mode": "local",              # on indique qu'on est en mode catalogue local
        "shop": shop,                 # "local" OU "jumia"
        "shop_label": shop_label,
        "country": country,
        # 👉 si boutique = Jumia → lien vers le meilleur produit,
        # sinon on garde ton main_url (ou None)
        "url": best_url if shop == "jumia" else main_url,
        "source": local_source,
        "openai_enabled": openai_client is not None,
        "results": results,           # on renvoie les résultats locaux ici
    }
    print("DEBUG /analyse local -> payload =", debug_payload)

    return jsonify(debug_payload), 200
        
    # 5) IA + OCR (pour boutiques externes)
    query_ia = ai_describe_image(processed_bytes)
    query_ocr = ocr_extract_text(pil_img)

    print("DEBUG query_ia:", repr(query_ia))
    print("DEBUG query_ocr:", repr(query_ocr))

    if query_ia:
        final_query = query_ia
        source_text = "vision-only"
    elif query_ocr:
        final_query = query_ocr
        source_text = "ocr-only"
    else:
        final_query = "photo de produit en ligne"
        source_text = "fallback"

    # 6) Construction URL boutique
    search_url = build_shop_url(final_query, shop_for_url, country)

    # 7) Réponse finale
    return jsonify({
        "ok": True,
        "description": final_query,
        "shop": shop_for_url,
        "shop_label": shop_label,
        "country": country,
        "url": search_url,
        "source": source_text,
        "openai_enabled": openai_client is not None,
    }), 200


# ============================================================
#  LANCEMENT LOCAL / REPLIT
# ============================================================

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
