import json
import os
import numpy as np
import faiss
import requests
from PIL import Image
from io import BytesIO
from engines.free_embedder import FreeEmbedder

CATALOG_PATH = "data/catalog.json"

# ⚠️ IMPORTANT :
# - TON app.py utilise encore artifacts/free  -> téléphones
# - On ajoute artifacts/accessoires        -> accessoires
ART_DIR_PHONES = "artifacts/free"
ART_DIR_ACCESS = "artifacts/accessoires"

os.makedirs(ART_DIR_PHONES, exist_ok=True)
os.makedirs(ART_DIR_ACCESS, exist_ok=True)


def download_and_convert(url):
    """Télécharge l'image et la convertit en Image PIL"""
    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        img = Image.open(BytesIO(resp.content)).convert("RGB")
        return img
    except Exception as e:
        print("Erreur image :", e)
        return None


def is_accessory(product: dict) -> bool:
    """
    Heuristique simple pour distinguer accessoires / téléphones
    (basé sur le titre du produit).
    """
    title = (product.get("title") or "").lower()

    KEYWORDS_ACCESS = [
        "coque",
        "housse",
        "étui",
        "etui",
        "case",
        "cover",
        "verre trempé",
        "verre trempe",
        "film",
        "glass",
        "protecteur",
        "protection écran",
        "protection ecran",
        "chargeur",
        "charge rapide",
        "câble",
        "cable",
        "écouteur",
        "ecouteur",
        "écouteurs",
        "ecouteurs",
        "earphone",
        "earphones",
        "earbud",
        "earbuds",
        "power bank",
    ]

    return any(kw in title for kw in KEYWORDS_ACCESS)


def save_index(vectors, ids, art_dir):
    """
    Sauvegarde embeddings + ids + index.faiss dans un dossier donné.
    """
    if not vectors:
        print(f"⚠ Aucun embedding pour {art_dir} → index vide.")
        embedding_dim = 512
        empty = np.zeros((0, embedding_dim), dtype="float32")
        index = faiss.IndexFlatL2(embedding_dim)
        faiss.write_index(index, os.path.join(art_dir, "index.faiss"))
        np.save(os.path.join(art_dir, "embeddings.npy"), empty)
        with open(os.path.join(art_dir, "ids.json"), "w", encoding="utf-8") as f:
            json.dump([], f, ensure_ascii=False)
        return

    vectors = np.stack(vectors).astype("float32")
    np.save(os.path.join(art_dir, "embeddings.npy"), vectors)

    with open(os.path.join(art_dir, "ids.json"), "w", encoding="utf-8") as f:
        json.dump(ids, f, ensure_ascii=False)

    index = faiss.IndexFlatL2(vectors.shape[1])
    index.add(vectors)
    faiss.write_index(index, os.path.join(art_dir, "index.faiss"))

    print(f"✅ Index sauvegardé dans {art_dir} ({len(ids)} produits)")


def main():
    print(f"Chargement du catalogue : {CATALOG_PATH}")
    with open(CATALOG_PATH, "r", encoding="utf-8") as f:
        catalog = json.load(f)

    print(f"→ {len(catalog)} produits dans le catalogue")

    # Filtrage des produits actifs (avec image_url non vide)
    catalog = [p for p in catalog if "image_url" in p and p["image_url"]]
    print(f"✨ Filtrage : {len(catalog)} produits avec image")

    if len(catalog) == 0:
        print("⚠ Aucun produit actif → création d'index vides.")
        save_index([], [], ART_DIR_PHONES)
        save_index([], [], ART_DIR_ACCESS)
        return

    print("Initialisation FreeEmbedder…")
    embedder = FreeEmbedder()

    # Deux jeux d'index : téléphones vs accessoires
    phone_vectors = []
    phone_ids = []
    access_vectors = []
    access_ids = []

    for i, product in enumerate(catalog, start=1):
        img = download_and_convert(product["image_url"])
        if img is None:
            continue

        try:
            vec = embedder.embed_image(img)  # (512,) ou (1,512)
            vec = np.array(vec).astype("float32")
            if vec.ndim == 2:
                vec = vec[0]
        except Exception as e:
            print("Erreur embedding :", e)
            continue

        if is_accessory(product):
            access_vectors.append(vec)
            access_ids.append(product)
        else:
            phone_vectors.append(vec)
            phone_ids.append(product)

        if i % 100 == 0:
            print(f"→ {i} produits traités…")

    print("------ RÉCAP ------")
    print(f"Téléphones :  {len(phone_ids)}")
    print(f"Accessoires : {len(access_ids)}")

    print("\n💾 Sauvegarde index TÉLÉPHONES (utilisé par app.py)…")
    save_index(phone_vectors, phone_ids, ART_DIR_PHONES)

    print("\n💾 Sauvegarde index ACCESSOIRES…")
    save_index(access_vectors, access_ids, ART_DIR_ACCESS)

    print("\n🎉 Reconstruction terminée !")


if __name__ == "__main__":
    main()