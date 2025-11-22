import os
import json
import time
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin

DATA_DIR = "./data"
URL_FILE = os.path.join(DATA_DIR, "jumia_urls.txt")
CATALOG_FILE = os.path.join(DATA_DIR, "catalog.json")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    )
}

def load_urls():
    if not os.path.exists(URL_FILE):
        print("❌ Aucun fichier jumia_urls.txt trouvé.")
        return []

    with open(URL_FILE, "r") as f:
        return [line.strip() for line in f if line.strip()]

def save_catalog(data):
    with open(CATALOG_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"💾 Catalogue mis à jour ({len(data)} produits).")

def scrape_product(url):
    print(f"🔎 Scraping : {url}")
    try:
        html = requests.get(url, headers=HEADERS, timeout=15)
        if html.status_code != 200:
            print(f"⚠️ Erreur HTTP {html.status_code}")
            return None

        soup = BeautifulSoup(html.text, "html.parser")

        # Nom du produit
        title = soup.find("h1", class_="-fs20").get_text(strip=True)

        # Prix
        price_tag = soup.find("span", class_="-b")
        price = price_tag.get_text(strip=True) if price_tag else "N/A"

        # Image principale
        img = soup.find("img", class_="-fw")
        img_url = urljoin(url, img["data-src"]) if img else None

        # Prépare l'objet produit
        product = {
            "title": title,
            "price": price,
            "url": url,
            "image_url": img_url,
            "source": "jumia",
            "active": True
        }

        print("✅ OK : ", title)
        return product

    except Exception as e:
        print("❌ Erreur :", e)
        return None

def main():
    urls = load_urls()
    print(f"📌 {len(urls)} URLs à scraper…")

    catalog = []

    for u in urls:
        product = scrape_product(u)
        if product:
            catalog.append(product)
        time.sleep(1)  # éviter d'être bloqué par Jumia

    save_catalog(catalog)
    print("🎉 Scraping terminé !")

if __name__ == "__main__":
    main()