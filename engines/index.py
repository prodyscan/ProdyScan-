import json
from pathlib import Path
from typing import List, Tuple

import faiss
import numpy as np


class EmbeddingIndex:
    """
    Classe pour gérer :
    - L'ajout d'embeddings
    - La recherche des produits les plus similaires
    - La sauvegarde et le chargement de l'index
    """

    def __init__(self, dim: int):
        self.index = faiss.IndexFlatIP(dim)  # FAISS pour similarité cosinus
        self.ids: List[str] = []

    def add(self, product_ids: List[str], embeddings: np.ndarray):
        emb = embeddings.astype("float32")
        faiss.normalize_L2(emb)  # normalisation pour cosinus
        self.index.add(emb)
        self.ids.extend(product_ids)

    def search(self, query_emb: np.ndarray, k: int = 10):
        if query_emb.ndim == 1:
            query_emb = query_emb[None, :]

        emb = query_emb.astype("float32")
        faiss.normalize_L2(emb)

        scores, indices = self.index.search(emb, k)

        results = []
        for idx, score in zip(indices[0], scores[0]):
            if idx < 0 or idx >= len(self.ids):
                continue
            results.append((self.ids[idx], float(score)))

        return results

    def save(self, folder: str):
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True)

        faiss.write_index(self.index, str(folder / "faiss.index"))
        with open(folder / "ids.json", "w") as f:
            json.dump(self.ids, f)

    @classmethod
    def load(cls, folder: str):
        folder = Path(folder)
        index = faiss.read_index(str(folder / "faiss.index"))
        with open(folder / "ids.json", "r") as f:
            ids = json.load(f)

        obj = cls(index.d)
        obj.index = index
        obj.ids = ids
        return obj
