import os
import json
import io

import numpy as np
import faiss
import requests
from PIL import Image

from engines.free_embedder import FreeEmbedder

# ⚙️ Même chemins que dans app.py
CATALOG_FILE = "./data/catalog.json"
ARTIFACT_DIR = "./artifacts/free"

EMB_FILE = os.path.join(ARTIFACT_DIR, "embeddings.npy")
FAISS_FILE = os.path.join(ARTIFACT_DIR, "index.faiss")
IDS_FILE = os.path.join(ARTIFACT_DIR, "ids.json")

os.makedirs(ARTIFACT_DIR, exist_ok=True)


def main():
    # 1) Charger le catalogue
    print("Chargement du catalogue :", CATALOG_FILE)
    with open(CATALOG_FILE, "r", encoding="utf-8") as f:
        catalog = json.load(f)

    print(f"➡ {len(catalog)} produits dans le catalogue")

    # 2) Initialiser l'embedder CLIP
    print("Initialisation de FreeEmbedder...")
    embedder = FreeEmbedder()

    vecs = []
    faiss_items = []  # ici on stocke les DICTS produits, pas seulement l'id

    # 3) Boucle sur les produits et téléchargement des images
    for p in catalog:
        pid = str(p.get("id"))
        img_url = p.get("image_url")

        if not pid or not img_url:
            print("⏭ Produit sans id ou sans image, ignoré :", p)
            continue

        try:
            print(f"📥 Produit {pid} - téléchargement de l'image...")
            resp = requests.get(img_url, timeout=20)
            resp.raise_for_status()

            img = Image.open(io.BytesIO(resp.content)).convert("RGB")

            # 4) Embedding de l'image
            vec = embedder.embed_image(img)
            vec = np.array(vec, dtype="float32")
            if vec.ndim == 1:
                vec = vec[np.newaxis, :]

            vecs.append(vec)

            # on stocke une copie "propre" du produit pour l'API
            prod_copy = dict(p)
            prod_copy["id"] = pid  # on force l'id en string
            faiss_items.append(prod_copy)

            print(f"✅ OK pour le produit {pid}")

        except Exception as e:
            print(f"⚠️ Erreur pour le produit {pid} ({img_url}) :", e)

    if not vecs:
        raise RuntimeError("Aucun vecteur généré. Vérifie les URLs d'images.")

    # 5) Empiler tous les vecteurs
    embeddings = np.concatenate(vecs, axis=0)
    print("Tenseur final embeddings :", embeddings.shape)

    # 🔍 DEBUG : afficher un aperçu du 1er embedding
    print("➡ Exemple d'embedding :", embeddings[0][:20])

    # 6) Sauvegarde des embeddings
    np.save(EMB_FILE, embeddings)
    print("💾 embeddings sauvegardés dans", EMB_FILE)

    # 7) Construction de l'index FAISS
    print("📦 Construction de l'index FAISS…")
    embeddings = embeddings.astype("float32")
    d = embeddings.shape[1]

    index = faiss.IndexFlatL2(d)
    index.add(embeddings)

    faiss.write_index(index, FAISS_FILE)
    print("💾 index FAISS sauvegardé dans", FAISS_FILE)

    # 8) Sauvegarde des produits (pas seulement les ids)
    with open(IDS_FILE, "w", encoding="utf-8") as f:
        json.dump(faiss_items, f, ensure_ascii=False, indent=2)
    print("💾 ids (objets produits) sauvegardés dans", IDS_FILE)

    print("🎉 Reconstruction terminée !")
    print(f"→ {len(faiss_items)} produits indexés, dimension = {d}")


if __name__ == "__main__":
    main()