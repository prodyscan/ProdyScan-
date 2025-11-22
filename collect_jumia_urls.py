import os
import time
import urllib.parse

import requests
from bs4 import BeautifulSoup

DATA_DIR = "./data"
URLS_FILE = os.path.join(DATA_DIR, "jumia_urls.txt")

# Catégorie téléphones & tablettes Jumia Côte d'Ivoire
CATEGORY_URL = "https://www.jumia.ci/telephone-tablette/"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    )
}


def ensure_data_dir():
    os.makedirs(DATA_DIR, exist_ok=True)


def get_product_urls_from_page(url: str):
    print(f"📄 Page : {url}")
    resp = requests.get(url, headers=HEADERS, timeout=20)
    if resp.status_code != 200:
        print(f"⚠️ Statut HTTP {resp.status_code}, on arrête.")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")

    urls = []

    # Sur Jumia, les produits sont souvent dans <article class="prd ...">
    for a in soup.select("article.prd a.core"):
        href = a.get("href")
        if not href:
            continue

        # Si l'URL est relative, on la convertit en absolue
        if href.startswith("/"):
            href = urllib.parse.urljoin("https://www.jumia.ci", href)

        # On évite les ancres / tracking trop bizarres
        if href.startswith("https://www.jumia.ci"):
            urls.append(href)

    print(f"✅ {len(urls)} produits trouvés sur cette page.")
    return urls


def crawl_category(max_pages: int = 5, sleep_seconds: float = 2.0):
    """
    Parcourt plusieurs pages de la catégorie Jumia et récupère les URLs produits.
    max_pages : nombre max de pages à visiter (pour ne pas abuser)
    """
    ensure_data_dir()

    all_urls = set()

    for page in range(1, max_pages + 1):
        if page == 1:
            page_url = CATEGORY_URL
        else:
            # Jumia utilise souvent ?page=2, ?page=3, ...
            page_url = f"{CATEGORY_URL}?page={page}"

        try:
            urls = get_product_urls_from_page(page_url)
        except Exception as e:
            print(f"⚠️ Erreur sur la page {page} :", e)
            break

        if not urls:
            print("ℹ️ Aucune URL trouvée, on suppose la fin de la pagination.")
            break

        for u in urls:
            all_urls.add(u)

        # Petite pause pour ne pas spammer Jumia
        time.sleep(sleep_seconds)

    return sorted(all_urls)


def save_urls(urls):
    ensure_data_dir()
    with open(URLS_FILE, "w", encoding="utf-8") as f:
        for u in urls:
            f.write(u.strip() + "\n")

    print(f"💾 {len(urls)} URLs sauvegardées dans {URLS_FILE}")


def main():
    print("🚀 Récupération des produits Jumia (téléphones & tablettes)…")
    urls = crawl_category(max_pages=5)  # tu peux augmenter plus tard
    if not urls:
        print("😕 Aucune URL récupérée.")
        return
    save_urls(urls)
    print("🎉 Terminé !")


if __name__ == "__main__":
    main()