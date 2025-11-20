import csv
import json
from pathlib import Path

CSV_PATH = Path("data/products.csv")
OUT_PATH = Path("data/catalog.json")


def build_catalog():
    if not CSV_PATH.exists():
        print(f"[ERREUR] Fichier CSV introuvable : {CSV_PATH}")
        print("Crée data/products.csv avec les colonnes : id,title,image_url,price,category,brand")
        return

    products = []

    with CSV_PATH.open("r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            product = {
                "id": row.get("id") or row.get("product_id"),
                "title": row.get("title", "").strip(),
                "image_url": row.get("image_url", "").strip(),
                "price": row.get("price"),
                "category": row.get("category"),
                "brand": row.get("brand"),
            }

            # On ignore les lignes sans id ou image
            if not product["id"] or not product["image_url"]:
                continue

            products.append(product)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(products, f, ensure_ascii=False, indent=2)

    print(f"[OK] Catalog.json généré avec {len(products)} produits -> {OUT_PATH}")


if __name__ == "__main__":
    build_catalog()
