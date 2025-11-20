import json
from io import BytesIO
from pathlib import Path

import numpy as np
import requests
from PIL import Image

from engines.free_embedder import FreeEmbedder
from engines.index import EmbeddingIndex


CATALOG_PATH = Path("data/catalog.json")
OUT_DIR = Path("artifacts/free")


def download_image(url: str) -> Image.Image:
    resp = requests.get(url, timeout=10)
    resp.raise_for_status()
    img = Image.open(BytesIO(resp.content)).convert("RGB")
    return img


def build_free_index():
    if not CATALOG_PATH.exists():
        print(f"[ERREUR] Catalog introuvable : {CATALOG_PATH}")
        print("Lance d'abord : python scripts/build_catalog.py")
        return

    with CATALOG_PATH.open("r", encoding="utf-8") as f:
        catalog = json.load(f)

    if not catalog:
        print("[ERREUR] Catalog vide.")
        return

    embedder = FreeEmbedder()

    embeddings = []
    ids = []

    for p in catalog:
        pid = str(p["id"])
        url = p["image_url"]
        try:
            print(f"Téléchargement image pour produit {pid}...")
            img = download_image(url)
            vec = embedder.embed_image(img)
            embeddings.append(vec)
            ids.append(pid)
        except Exception as e:
            print(f"[WARN] Produit {pid} ignoré (erreur image ou embedding) :", e)

    if not embeddings:
        print("[ERREUR] Aucun embedding généré.")
        return

    emb_array = np.stack(embeddings, axis=0)
    index = EmbeddingIndex(dim=emb_array.shape[1])
    index.add(ids, emb_array)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    index.save(OUT_DIR)

    # Optionnel : sauvegarder aussi les embeddings bruts
    np.save(OUT_DIR / "embeddings.npy", emb_array)

    print(f"[OK] Index FREE créé avec {len(ids)} produits dans {OUT_DIR}")


if __name__ == "__main__":
    build_free_index()
