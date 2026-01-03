import os
import re
import json
import time  # pour le cache (timestamps)

from flask import Flask, request, jsonify, render_template
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse, quote_plus
from difflib import SequenceMatcher

# ============================================================
#  FLASK APP
# ============================================================

app = Flask(__name__)


# ============================================================
#  ROUTE INDEX (page HTML)
# ============================================================

@app.route("/", methods=["GET"])
def index():
    return render_template("index.html")


# ============================================================
#  HELPERS COMMUNS URL / SCRAPING
# ============================================================

HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.8",
}


# ============================================================
#  CACHE INTELLIGENT (produit + fournisseur)
# ============================================================

CACHE = {
    "supplier_name": {},   # { name: { "ts": 12345, "data": {...} } }
    "product_url": {},     # { url:  { "ts": 12345, "data": {...} } }
}

# Durée de vie du cache : 24h
CACHE_TTL_SECONDS = 60 * 60 * 24  # 24 heures


def cache_get(category: str, key: str):
    """
    Récupère une entrée du cache si elle est encore valide.
    category : "supplier_name" ou "product_url"
    key      : nom ou url normalisé
    """
    bucket = CACHE.get(category, {})
    entry = bucket.get(key)
    if not entry:
        return None

    # Si trop vieux → on supprime et on considère que c'est absent
    if time.time() - entry["ts"] > CACHE_TTL_SECONDS:
        del bucket[key]
        return None

    return entry["data"]


def cache_set(category: str, key: str, data: dict):
    """
    Enregistre une entrée dans le cache.
    """
    CACHE.setdefault(category, {})
    CACHE[category][key] = {
        "ts": time.time(),
        "data": data,
    }


def _clean_text(txt):
    if not txt:
        return ""
    return re.sub(r"\s+", " ", txt).strip()


def _guess_shop_from_url(url: str):
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    main = host.split(".")[0] if host else "site"
    shop_code = main
    shop_label = main.capitalize()
    return shop_code, shop_label


def _fetch_soup(url: str):
    try:
        resp = requests.get(url, headers=HTTP_HEADERS, timeout=12)
    except Exception:
        return None

    if resp.status_code != 200 or not resp.text:
        return None

    return BeautifulSoup(resp.text, "html.parser")


def _iter_ldjson_nodes(soup: BeautifulSoup):
    if not soup:
        return
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            raw = script.string or script.get_text(strip=True)
            if not raw:
                continue
            data = json.loads(raw)
        except Exception:
            continue

        candidates = []
        if isinstance(data, dict):
            candidates.append(data)
            if "@graph" in data and isinstance(data["@graph"], list):
                candidates.extend(data["@graph"])
        elif isinstance(data, list):
            candidates.extend(data)

        for node in candidates:
            if isinstance(node, dict):
                yield node


# ============================================================
#  JSON-LD Product générique (Jumia, Amazon, etc.)
# ============================================================

def _extract_product_from_jsonld(soup: BeautifulSoup) -> dict:
    product = {
        "title": "",
        "description": "",
        "price": "",
        "price_min": "",
        "price_max": "",
        "currency": "",
        "rating": "",
        "reviews": "",
    }

    for node in _iter_ldjson_nodes(soup):
        t = node.get("@type")
        if t == "Product" or (isinstance(t, list) and "Product" in t):
            product["title"] = node.get("name") or ""
            product["description"] = node.get("description") or ""

            offers = node.get("offers") or {}
            if isinstance(offers, dict):
                product["price"] = offers.get("price") or ""
                product["currency"] = offers.get("priceCurrency") or ""

            agg = node.get("aggregateRating") or {}
            if isinstance(agg, dict):
                if agg.get("ratingValue") is not None:
                    product["rating"] = str(agg.get("ratingValue"))
                if agg.get("reviewCount") is not None:
                    product["reviews"] = str(agg.get("reviewCount"))
            break

    return product


# ============================================================
#  Extraction produit Alibaba
# ============================================================

def _extract_product_alibaba(soup: BeautifulSoup) -> dict:
    product = {
        "title": "",
        "description": "",
        "price": "",
        "price_min": "",
        "price_max": "",
        "currency": "",
        "moq": "",
        "price_ranges": [],
        "rating": "",
        "reviews": "",
        "sold": "",
        "category": "",
        "features": {},
        "trade_assurance": False,
    }

    if not soup:
        return product

    full = soup.get_text(" ", strip=True)
    lower = full.lower()

    # 1) TITRE
    title_tag = soup.select_one("h1, h1.title, h1.product-title")
    if title_tag:
        product["title"] = _clean_text(title_tag.get_text())

    # 2) JSON __NEXT_DATA__
    try:
        script = soup.find("script", id="__NEXT_DATA__")
        if script and script.string:
            data = json.loads(script.string)
            page_props = data.get("props", {}).get("pageProps", {})
            prod = page_props.get("product") or {}

            price_obj = prod.get("price") or {}
            if isinstance(price_obj, dict):
                pmin = price_obj.get("min")
                pmax = price_obj.get("max")
                cur = price_obj.get("currency") or ""

                if pmin is not None:
                    product["price_min"] = str(pmin)
                if pmax is not None:
                    product["price_max"] = str(pmax)
                if cur:
                    product["currency"] = cur

                ranges = price_obj.get("ranges") or []
                for r in ranges:
                    amount = r.get("price") or r.get("amount") or r.get("value")
                    rmin = r.get("min") or r.get("from") or r.get("start")
                    rmax = r.get("max") or r.get("to") or r.get("end")

                    label_parts = []
                    if amount is not None:
                        label_parts.append(f"{amount} {cur}".strip())
                    if rmin is not None and rmax is not None and rmin != rmax:
                        label_parts.append(f"{rmin}–{rmax} pcs")
                    elif rmin is not None:
                        label_parts.append(f"≥ {rmin} pcs")

                    label = " (".join(label_parts[:1]) + (")" if len(label_parts) > 1 else "")
                    if label:
                        product["price_ranges"].append(label)

            moq = prod.get("moq")
            if moq is not None:
                product["moq"] = str(moq)

            ratings = prod.get("ratings") or {}
            if ratings:
                if not product["rating"] and ratings.get("average") is not None:
                    product["rating"] = str(ratings.get("average"))
                if not product["reviews"] and ratings.get("total") is not None:
                    product["reviews"] = str(ratings.get("total"))

            if prod.get("sold") is not None:
                product["sold"] = str(prod.get("sold"))

            cat = prod.get("category") or {}
            if isinstance(cat, dict) and cat.get("name"):
                product["category"] = _clean_text(cat["name"])

            attrs = prod.get("attributes") or []
            for att in attrs:
                name = att.get("name")
                val = att.get("value")
                if name and val:
                    product["features"][name] = val

            ta = prod.get("tradeAssurance")
            if isinstance(ta, bool):
                product["trade_assurance"] = ta

    except Exception as e:
        print("DEBUG: _extract_product_alibaba NEXT_DATA error:", e)

    # 3) FALLBACK TEXTE
    if not product["rating"]:
        m = re.search(r"(\d\.\d)\s*\(\s*\d+\s*(reviews|avis)", lower)
        if m:
            product["rating"] = m.group(1)

    if not product["reviews"]:
        m = re.search(r"(\d+)\s*(reviews|avis)", lower)
        if m:
            product["reviews"] = m.group(1)

    if not product["sold"]:
        m = re.search(r"(\d+)\s*(sold|vendus)", lower)
        if m:
            product["sold"] = m.group(1)

    if not product["price_min"] or not product["price_max"]:
        price_block = product["price"] or full
        amounts = re.findall(r"\$\s*([0-9]+(?:\.[0-9]+)?)", price_block)
        if amounts:
            try:
                prices = [float(x) for x in amounts]
                pmin = min(prices)
                pmax = max(prices)
                if not product["price_min"]:
                    product["price_min"] = str(pmin)
                if not product["price_max"]:
                    product["price_max"] = str(pmax)
            except Exception:
                pass

    return product


# ============================================================
#  EXTRACTION : CARTE FOURNISSEUR (VERSION MOBILE)
# ============================================================

def _fetch_mobile_supplier_card(soup: BeautifulSoup) -> dict:
    """
    Analyse la carte 'Présentation de l'entreprise' visible SUR la page produit
    Alibaba (souvent en version mobile / compacte).
    """
    result = {
        "verified": False,
        "rating": "",
        "years_active": "",
        "delivery_rate": "",
        "online_revenue": "",
        "response_time": "",
        "founded_year": "",
        "factory_size": "",
        "employees": "",
        "brand_count": "",
        "supplier_rank": "",
    }

    if not soup:
        return result

    full = soup.get_text(" ", strip=True)
    lower = full.lower()

    # Verified (badge / texte)
    if (
        "fournisseur vérifié" in lower
        or "verified supplier" in lower
        or re.search(r"\bverified\b", lower)
        or re.search(r"\bvérifié\b", lower)
    ):
        result["verified"] = True
            

    # Rating "4.4/5"
    m = re.search(r"(\d(?:\.\d)?)\s*/\s*5", full)
    if m:
        result["rating"] = m.group(1)

    # Years on Alibaba
    m = re.search(
        r"(\d+)\s*(ans sur alibaba(?:\.com)?|yrs on alibaba|years on alibaba)",
        lower,
    )
    if m:
        result["years_active"] = m.group(1)

    # On-time Delivery
    m = re.search(
        r"(\d{1,3}(?:\.\d+)?)%\s*(taux de livraison(?: dans les délais)?|on[- ]time delivery)",
        lower,
    )
    if m:
        result["delivery_rate"] = m.group(1) + "%"

    # Online Revenue
    m = re.search(
        r"us\$ ?([\d,\.]+\+?)\s*(recettes en ligne|online revenue|export revenue)",
        lower,
    )
    if m:
        result["online_revenue"] = "US$ " + m.group(1)

    # Response time
    m = re.search(
        r"(≤?\s*\d+\s*(?:h|heures?|hours?))\s*(temps de réponse|response time)?",
        lower,
    )
    if m:
        txt = m.group(1)
        txt = (
            txt.replace("heures", "h")
            .replace("heure", "h")
            .replace("hours", "h")
            .replace("hour", "h")
        )
        result["response_time"] = _clean_text(txt)

    # Founded year
    m = re.search(r"(année de fondation|founded in)\s*(\d{4})", lower)
    if m:
        result["founded_year"] = m.group(2)

    # Factory size
    m = re.search(r"(\d{2,6}\s*(?:m²|㎡|m2))", lower)
    if m:
        val = m.group(1).replace("m2", "m²")
        result["factory_size"] = _clean_text(val)

    # Employees
    m = re.search(r"(\d{1,5})\s*(employees?|employés?)", lower)
    if m:
        result["employees"] = m.group(1)

    # Brand count
    m = re.search(r"(\d+)\s*(marques? propres?|own brands?)", lower)
    if m:
        result["brand_count"] = m.group(1)

    # Supplier Rank
    m = re.search(r"#\s*(\d+)\s*[^\n#]{0,80}?(populaire|popular|top|ranked)", lower)
    if m:
        result["supplier_rank"] = "#" + m.group(1)

    return result


                            # ============================================================
                            #  EXTRACTION : FOURNISSEUR COMPLET ALIBABA
                            # ============================================================

def _extract_supplier_from_alibaba(soup: BeautifulSoup) -> dict:
                                supplier = {
                                    "name": "",
                                    "country": "",
                                    "years_active": "",
                                    "rating": "",
                                    "reviews": "",
                                    "delivery_rate": "",
                                    "response_rate": "",
                                    "response_time": "",
                                    "business_type": "",
                                    "trade_assurance": None,  # None = inconnu
                                    "verified": None,         # None = inconnu
                                    "export_revenue": "",
                                    "online_revenue": "",
                                    "factory_size": "",
                                    "factory_area": "",
                                    "employees": "",
                                    "founded_year": "",
                                    "services": [],
                                    "brand_count": "",
                                    "supplier_rank": "",
                                }

                                if not soup:
                                    return supplier

                                full = soup.get_text(" ", strip=True)
                                lower = full.lower()

                                # -------------------------------------------------
                                # 0) ESSAYER D'ABORD LE JSON STRUCTURÉ (__NEXT_DATA__)
                                # -------------------------------------------------
                                try:
                                    script = soup.find("script", id="__NEXT_DATA__")
                                    if script and script.string:
                                        data = json.loads(script.string)
                                        page_props = data.get("props", {}).get("pageProps", {})

                                        company = (
                                            page_props.get("company")
                                            or page_props.get("seller")
                                            or page_props.get("shopInfo")
                                            or page_props.get("supplier")
                                            or {}
                                        )

                                        name = (
                                            company.get("companyName")
                                            or company.get("name")
                                            or company.get("shopName")
                                        )
                                        if name and not supplier["name"]:
                                            supplier["name"] = _clean_text(name)

                                        country = (
                                            company.get("country")
                                            or company.get("countryName")
                                            or company.get("region")
                                        )
                                        if country and not supplier["country"]:
                                            supplier["country"] = _clean_text(country)

                                        years = (
                                            company.get("yearsOnAlibaba")
                                            or company.get("yearsOnPlatform")
                                            or company.get("years")
                                        )
                                        if years and not supplier["years_active"]:
                                            try:
                                                supplier["years_active"] = str(int(years))
                                            except Exception:
                                                supplier["years_active"] = str(years)

                                        verified_flags = [
                                            company.get("isVerified"),
                                            company.get("verifiedSupplier"),
                                            company.get("isAuthenticated"),
                                        ]
                                        if any(v is True for v in verified_flags):
                                            supplier["verified"] = True

                                        ta_flags = [
                                            company.get("tradeAssurance"),
                                            company.get("hasTradeAssurance"),
                                            company.get("tradeAssuranceService"),
                                        ]
                                        if any(v is True for v in ta_flags):
                                            supplier["trade_assurance"] = True

                                        employees = (
                                            company.get("employees")
                                            or company.get("employeesCount")
                                            or company.get("staffNumber")
                                        )
                                        if employees and not supplier["employees"]:
                                            supplier["employees"] = str(employees)

                                        area = (
                                            company.get("factorySize")
                                            or company.get("factoryArea")
                                            or company.get("floorSpace")
                                        )
                                        if area and not supplier["factory_area"]:
                                            supplier["factory_area"] = _clean_text(str(area))
                                            supplier["factory_size"] = supplier["factory_area"]

                                        founded = (
                                            company.get("foundedYear")
                                            or company.get("establishedYear")
                                            or company.get("established")
                                        )
                                        if founded and not supplier["founded_year"]:
                                            m_year = re.search(r"(\d{4})", str(founded))
                                            if m_year:
                                                supplier["founded_year"] = m_year.group(1)

                                        rating = (
                                            company.get("rating")
                                            or company.get("supplierRating")
                                            or company.get("score")
                                        )
                                        if rating and not supplier["rating"]:
                                            supplier["rating"] = str(rating)

                                        reviews = (
                                            company.get("reviewsCount")
                                            or company.get("reviewCount")
                                            or company.get("feedbackCount")
                                        )
                                        if reviews and not supplier["reviews"]:
                                            supplier["reviews"] = str(reviews)

                                        services = (
                                            company.get("services")
                                            or company.get("serviceList")
                                        )
                                        if isinstance(services, list) and not supplier["services"]:
                                            labels = []
                                            for s_obj in services:
                                                if isinstance(s_obj, dict):
                                                    lbl = s_obj.get("name") or s_obj.get("label")
                                                    if lbl:
                                                        labels.append(_clean_text(lbl))
                                                elif isinstance(s_obj, str):
                                                    labels.append(_clean_text(s_obj))
                                            supplier["services"] = [s for s in labels if s]

                                except Exception as e:
                                    print("DEBUG: supplier NEXT_DATA error:", e)

                                # -------------------------------------------------
                                # 1) Carte mobile (infos compactes sur la page produit)
                                # -------------------------------------------------
                                mobile = _fetch_mobile_supplier_card(soup)
                                for key, value in mobile.items():
                                    if key in ("verified", "trade_assurance"):
                                        if value is True and supplier.get(key) is None:
                                            supplier[key] = True
                                        continue

                                    if value not in ("", None, [], {}):
                                        if key in supplier and not supplier.get(key):
                                            supplier[key] = value

                                # -------------------------------------------------
                                # 2) VERIFIED : badge ou texte positif
                                # -------------------------------------------------
                                verified_icon = soup.select_one(
                                    ".verified-icon, .icon-verified, img[src*='verified'], "
                                    "img[src*='auth'], img[src*='audited'], [data-spm*='verified']"
                                )
                                if verified_icon:
                                    supplier["verified"] = True
                                else:
                                    if "fournisseur vérifié" in lower or "verified supplier" in lower:
                                        supplier["verified"] = True

                                # -------------------------------------------------
                                # 3) NOM FOURNISSEUR (fallback HTML)
                                # -------------------------------------------------
                                if not supplier["name"]:
                                    name_selectors = [
                                        "[data-role=seller-name]",
                                        ".store-name",
                                        ".company-name",
                                        ".company-title",
                                        "h1",
                                        "h2",
                                    ]
                                    for sel in name_selectors:
                                        tag = soup.select_one(sel)
                                        if not tag:
                                            continue
                                        text = _clean_text(tag.get_text())
                                        if text and len(text) > 4:
                                            supplier["name"] = text
                                            break

                                # -------------------------------------------------
                                # 4) PAYS / LOCALISATION (fallback texte)
                                # -------------------------------------------------
                                if not supplier.get("country"):
                                    m_country = re.search(
                                        r"Situé\s+(?:en|au|aux|à)\s+([A-Za-zÀ-ÖØ-öø-ÿ ,]+)",
                                        full,
                                        flags=re.IGNORECASE,
                                    )

                                    if not m_country:
                                        m_country = re.search(
                                            r"located in\s+([A-Za-zÀ-ÖØ-öø-ÿ ,]+)",
                                            full,
                                            flags=re.IGNORECASE,
                                        )

                                    if not m_country:
                                        m_country = re.search(
                                            r"location\s*[:\-]?\s*([A-Za-zÀ-ÖØ-öø-ÿ ,]+)",
                                            full,
                                            flags=re.IGNORECASE,
                                        )

                                    if m_country:
                                        supplier["country"] = _clean_text(m_country.group(1))

                                if not supplier.get("country"):
                                    m_country2 = re.search(
                                        r"country/region\s*[:\-]?\s*([A-Za-zÀ-ÖØ-öø-ÿ ,]+)",
                                        full,
                                        flags=re.IGNORECASE,
                                    )
                                    if m_country2:
                                        supplier["country"] = _clean_text(m_country2.group(1))

                                # -------------------------------------------------
                                # 5) ANNÉES SUR ALIBABA
                                # -------------------------------------------------
                                if not supplier.get("years_active"):
                                    m_years = re.search(
                                        r"(\d+)\s*(ans sur alibaba(?:\.com)?|yrs on alibaba|years on alibaba)",
                                        lower,
                                    )
                                    if m_years:
                                        supplier["years_active"] = m_years.group(1)

                                # -------------------------------------------------
                                # 6) NOTE MOYENNE
                                # -------------------------------------------------
                                if not supplier.get("rating"):
                                    m_rating = re.search(r"(\d\.\d)\s*/\s*5", full)
                                    if m_rating:
                                        supplier["rating"] = m_rating.group(1)

                                # -------------------------------------------------
                                # 7) NOMBRE D’AVIS
                                # -------------------------------------------------
                                if not supplier.get("reviews"):
                                    m_reviews = re.search(r"(\d+)\s*(reviews|avis)", lower)
                                    if m_reviews:
                                        supplier["reviews"] = m_reviews.group(1)

                                # -------------------------------------------------
                                # 8) TRADE ASSURANCE (True ou None)
                                # -------------------------------------------------
                                if supplier.get("trade_assurance") is None:
                                    if "trade assurance" in lower or "assurance commerciale" in lower:
                                        if not re.search(r"(no|non|sans)\s+trade assurance", lower):
                                            supplier["trade_assurance"] = True

                                    if supplier["trade_assurance"] is None:
                                        ta_icon = soup.select_one(
                                            ".trade-assurance, "
                                            ".icon-trade-assurance, "
                                            ".ta-icon, "
                                            "img[src*='trade_assurance'], "
                                            "img[src*='trade-assurance'], "
                                            "[class*='trade-assurance']"
                                        )
                                        if ta_icon:
                                            supplier["trade_assurance"] = True

                                # -------------------------------------------------
                                # 9) TYPE D’ACTIVITÉ
                                # -------------------------------------------------
                                if "manufacturer" in lower or "fabricant" in lower:
                                    supplier["business_type"] = "Manufacturer"
                                if "trading company" in lower or "société de négoce" in lower:
                                    if supplier["business_type"]:
                                        supplier["business_type"] += " / Trading Company"
                                    else:
                                        supplier["business_type"] = "Trading Company"

                                # -------------------------------------------------
                                # 10) TAUX DE LIVRAISON
                                # -------------------------------------------------
                                if not supplier.get("delivery_rate"):
                                    m_delivery = re.search(
                                        r"(\d{1,3}(?:\.\d+)?%)\s*(taux de livraison(?: dans les délais)?|on[- ]time delivery rate?)",
                                        lower,
                                    )
                                    if not m_delivery:
                                        m_delivery = re.search(
                                            r"(taux de livraison(?: dans les délais)?|on[- ]time delivery rate?)\s*(\d{1,3}(?:\.\d+)?%)",
                                            lower,
                                        )
                                    if m_delivery:
                                        if "%" in m_delivery.group(1):
                                            supplier["delivery_rate"] = m_delivery.group(1)
                                        else:
                                            supplier["delivery_rate"] = m_delivery.group(2)

                                # -------------------------------------------------
                                # 11) TEMPS DE RÉPONSE
                                # -------------------------------------------------
                                if not supplier.get("response_time"):
                                    m_resp_time = re.search(
                                        r"(≤?\s*\d+\s*(?:h|heures?|hours?))\s*(?:temps de réponse|response time)?",
                                        full,
                                        flags=re.IGNORECASE,
                                    )
                                    if m_resp_time:
                                        txt = (
                                            m_resp_time.group(1)
                                            .replace("heures", "h")
                                            .replace("heure", "h")
                                            .replace("hours", "h")
                                            .replace("hour", "h")
                                        )
                                        supplier["response_time"] = _clean_text(txt)

                                # -------------------------------------------------
                                # 12) REVENUS
                                # -------------------------------------------------
                                if not supplier.get("online_revenue"):
                                    m_online = re.search(
                                        r"(us\$ ?[\d,\.]+\+?)\s*(recettes en ligne|online revenue)",
                                        lower,
                                    )
                                    if m_online:
                                        supplier["online_revenue"] = m_online.group(1).upper()

                                if not supplier.get("export_revenue"):
                                    m_export = re.search(r"(us\$|usd)\s*([\d,\.]+\+?)", lower)
                                    if m_export:
                                        supplier["export_revenue"] = f"US$ {m_export.group(2)}"

                                # -------------------------------------------------
                                # 13) SUPERFICIE
                                # -------------------------------------------------
                                if not supplier.get("factory_area"):
                                    m_area = re.search(r"(\d{2,6}\s*(?:m²|㎡))", lower)
                                    if m_area:
                                        supplier["factory_area"] = m_area.group(1)
                                        supplier["factory_size"] = supplier["factory_area"]

                                # -------------------------------------------------
                                # 14) EMPLOYÉS
                                # -------------------------------------------------
                                if not supplier.get("employees"):
                                    m_emp = re.search(r"(\d{1,5})\s*(employees|employés)", lower)
                                    if m_emp:
                                        supplier["employees"] = m_emp.group(1)

                                # -------------------------------------------------
                                # 15) SERVICES
                                # -------------------------------------------------
                                if not supplier.get("services"):
                                    m_services = re.search(
                                        r"services?\s*[:\-]?\s*([A-Za-z0-9À-ÖØ-öø-ÿ ,\-/\(\)]+)",
                                        full,
                                        flags=re.IGNORECASE,
                                    )
                                    if m_services:
                                        txt = _clean_text(m_services.group(1))
                                        supplier["services"] = [s.strip() for s in txt.split(",") if s.strip()]

                                return supplier
            
 
        

        


# ============================================================
#  PROFIL FOURNISSEUR ALIBABA (depuis une page produit)
# ============================================================

def _find_supplier_profile_url(soup: BeautifulSoup, page_url: str):
        """
        Essaie de retrouver l'URL du profil fournisseur à partir d'une page produit.
        On élargit les critères car Alibaba change souvent ses liens (minisite, company_profile, shop, etc.).
        """
        if not soup:
            return None

        # 1) Anciennes URLs "minisite"
        link = soup.find("a", href=lambda h: h and ("minisite" in h or "minisite_store" in h))
        if link and link.get("href"):
            return urljoin(page_url, link["href"])

        # 2) URLs classiques de profil
        link = soup.find(
            "a",
            href=lambda h: h and ("company_profile" in h or "/company/" in h),
        )
        if link and link.get("href"):
            return urljoin(page_url, link["href"])

        # 3) Lien autour du nom du vendeur (desktop / mobile)
        link = soup.select_one(
            "a[data-role='seller-name'], "
            "a.store-name, "
            "a.company-name, "
            ".company-info a, "
            ".store-container a"
        )
        if link and link.get("href"):
            return urljoin(page_url, link["href"])

        # 4) Liens "shop" / "store"
        link = soup.find(
            "a",
            href=lambda h: h and any(
                kw in h
                for kw in [
                    "/shop/",
                    "/store/",
                    "x.alibaba.com",
                ]
            ),
        )
        if link and link.get("href"):
            return urljoin(page_url, link["href"])

        # 5) Dernier recours : tout <a> qui contient "supplier" dans data-spm
        link = soup.find(
            "a",
            attrs={"data-spm": lambda v: v and ("supplier" in v or "minisite" in v)},
        )
        if link and link.get("href"):
            return urljoin(page_url, link["href"])

        return None
    



# ============================================================
#  RECHERCHE FOURNISSEUR PAR NOM (Alibaba)
# ============================================================

def build_alibaba_company_search_url(name: str) -> str:
    """
    Construit l'URL de recherche Alibaba pour un fournisseur
    en fonction du nom de l'entreprise.
    """
    q = quote_plus(name.strip())
    return (
        "https://www.alibaba.com/trade/search?"
        "fsb=y&IndexArea=company_en&SearchText=" + q
    )


def _find_supplier_profile_from_search(soup: BeautifulSoup, search_url: str):
    """
    Sur la page de recherche 'company_en', on essaie de trouver
    le premier lien vers un profil fournisseur.
    """
    if not soup:
        return None

    link = soup.find(
        "a",
        href=lambda h: h and (
            "company_profile" in h
            or "/company/" in h
            or "minisite" in h
        ),
    )
    if link and link.get("href"):
        return urljoin(search_url, link["href"])

    return None

def analyse_supplier_by_name(supplier_name: str) -> dict:
        """
        Flux :
          1. construire l'URL de recherche entreprise Alibaba
          2. charger la page de recherche
          3. essayer de récupérer un profil fournisseur
          4. si trouvé → on scrape le profil
                         sinon → on renvoie quand même la search_url
        """

        # --- CACHE : lecture avant de scraper ---
        cache_key = supplier_name.lower().strip()
        cached = cache_get("supplier_name", cache_key)
        if cached:
            return cached

        # 1) URL de recherche Alibaba
        search_url = build_alibaba_company_search_url(supplier_name)

        # 2) Charger la page de résultats
        soup_search = _fetch_soup(search_url)
        if not soup_search:
            raise RuntimeError("Impossible de charger la recherche Alibaba.")

        # 3) Essayer de trouver un lien de profil dans les résultats
        profile_url = _find_supplier_profile_from_search(soup_search, search_url)

        supplier = {}
        description = supplier_name

        # 4) Si on a trouvé un profil, on le scrape
        if profile_url:
            soup_supplier = _fetch_soup(profile_url)
            if soup_supplier:
                supplier = _extract_supplier_from_alibaba(soup_supplier)
                if supplier.get("name"):
                    description = supplier["name"]

        # ⚠ Très important :
        # On ne lève PLUS d'erreur si profile_url est None.
        # On envoie quand même ok=True avec la search_url.
        result = {
            "ok": True,
            "mode": "supplier-name",
            "source": "alibaba-name-search",
            "search_url": search_url,
            "profile_url": profile_url,  # peut être None
            "description": description,
            "supplier": supplier,
        }

        # --- CACHE : écriture après scraping ---
        cache_set("supplier_name", cache_key, result)

        return result

# ============================================================
#  RECHERCHE MULTIPLE DE FOURNISSEURS PAR NOM (Alibaba)
# ============================================================


def search_alibaba_suppliers_by_name(name: str, max_results: int = 10):
    """
    Recherche plusieurs fournisseurs par nom sur Alibaba
    et renvoie les meilleurs résultats avec un score de similarité.
    """
    base_url = build_alibaba_company_search_url(name)
    soup = _fetch_soup(base_url)
    if not soup:
        raise RuntimeError("Impossible de charger la recherche Alibaba.")

    results = []
    seen = set()

    for link in soup.find_all("a", href=True):
        href = link["href"]
        text = _clean_text(link.get_text())
        if not text or len(text) < 4:
            continue
        if not any(x in href for x in ["company_profile", "/company/", "minisite"]):
            continue

        url = urljoin(base_url, href)
        if url in seen:
            continue
        seen.add(url)

        # calcul de similarité entre le nom trouvé et le nom recherché
        sim = SequenceMatcher(None, name.lower(), text.lower()).ratio()

        results.append({
            "name": text,
            "url": url,
            "similarity": round(sim * 100, 1),
        })

        if len(results) >= max_results:
            break

    return {
        "ok": True,
        "source": "alibaba-company-search",
        "query": name,
        "results": sorted(results, key=lambda x: x["similarity"], reverse=True)
    }


@app.route("/search_fournisseurs", methods=["POST"])
def search_fournisseurs():
    name = (request.form.get("name") or request.args.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "Aucun nom reçu."}), 400

    try:
        data = search_alibaba_suppliers_by_name(name)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify(data), 200

# ============================================================
#  ANALYSE COMPLÈTE D’UN LIEN ALIBABA (produit + fournisseur)
# ============================================================

def expand_alibaba_short_url(url: str) -> str:
    """
    Résout les liens courts Alibaba (ex: https://www.alibaba.com/x/B1CIEG ).
    """
    try:
        resp = requests.get(url, headers=HTTP_HEADERS, timeout=10, allow_redirects=True)
        if resp.url and "alibaba.com" in resp.url.lower():
            return resp.url
    except Exception as e:
        print("Erreur redirection Alibaba :", e)

    return url


def analyse_alibaba_url(product_url: str) -> dict:
    # --- CACHE : lecture avant scraping ---
    cache_key = product_url.strip()
    cached = cache_get("product_url", cache_key)
    if cached:
        return cached

    # Charger la page (produit ou profil)
    soup = _fetch_soup(product_url)
    if not soup:
        raise RuntimeError("Impossible de charger la page Alibaba.")

    # On essaie d’extraire les 2 : produit + fournisseur
    product = _extract_product_alibaba(soup)
    supplier = _extract_supplier_from_alibaba(soup)

    # Essayer de trouver un lien vers le profil fournisseur
    supplier_profile_url = _find_supplier_profile_url(soup, product_url)
    if supplier_profile_url:
        soup_supplier = _fetch_soup(supplier_profile_url)
        if soup_supplier:
            detailed = _extract_supplier_from_alibaba(soup_supplier)
            # On laisse les infos du profil écraser celles du produit
            for key, value in detailed.items():
                if value not in ("", None, [], {}):
                    supplier[key] = value
            supplier["profile_url"] = supplier_profile_url
        else:
            supplier["profile_url"] = supplier_profile_url
    else:
        # Aucun profil trouvé :
        # - si c’est une vraie URL de profil (company_profile / company), on NE touche PAS
        # - sinon, c’est juste une page produit → on ne fait pas confiance au temps de réponse
        if "company_profile" not in product_url and "/company/" not in product_url:
            supplier["response_time"] = ""
        supplier["profile_url"] = None

    # Description pour la carte produit
    description = (
        product.get("title")
        or product.get("name")
        or product.get("description")
        or "Produit Alibaba"
    )

    result = {
        "ok": True,
        "mode": "url",
        "country": "global",
        "shop": "alibaba",
        "shop_label": "Alibaba",
        "source": "alibaba-url",
        "url": product_url,
        "description": description,
        "product": product,
        "supplier": supplier,
    }

    # --- CACHE : écriture ---
    cache_set("product_url", cache_key, result)

    return result
     



# ============================================================
#  ROUTE /analyse – analyse par LIEN
# ============================================================

@app.route("/analyse", methods=["POST"])
def analyse():
    raw_url = (request.form.get("url") or request.args.get("url") or "").strip()
    if not raw_url:
        return jsonify({"ok": False, "error": "Aucun lien reçu."}), 400

    # On extrait une vraie URL au cas où l'utilisateur colle tout un texte
    m = re.search(r"https?://\S+", raw_url)
    product_url = m.group(0) if m else raw_url

    # Si c'est un lien court Alibaba → on l'étend
    product_url = expand_alibaba_short_url(product_url)

    try:
        if "alibaba.com" in product_url.lower():
            # Cette fonction gère :
            # - lien de produit
            # - lien de profil fournisseur (company_profile, /company/…)
            data = analyse_alibaba_url(product_url)
        else:
            raise RuntimeError(
                "Cette boutique n’est pas supportée. Seuls les liens Alibaba sont acceptés."
            )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify(data), 200

# ============================================================
#  ROUTE /analyse_fournisseur – analyse par NOM
# ============================================================

@app.route("/analyse_fournisseur", methods=["POST"])
def analyse_fournisseur():
    name = (request.form.get("name") or request.args.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "Aucun nom de fournisseur reçu."}), 400

    try:
        data = analyse_supplier_by_name(name)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify(data), 200

# ============================================================
#  ANALYSE D'UN PROFIL FOURNISSEUR DIRECT (par URL)
# ============================================================

@app.route("/analyse_fournisseur_url", methods=["POST"])
def analyse_fournisseur_url():
    url = (request.form.get("url") or request.args.get("url") or "").strip()
    if not url:
        return jsonify({"ok": False, "error": "Aucune URL reçue."}), 400

    try:
        soup = _fetch_soup(url)
        if not soup:
            raise RuntimeError("Impossible de charger le profil fournisseur.")

        supplier = _extract_supplier_from_alibaba(soup)
        supplier["profile_url"] = url

        return jsonify({
            "ok": True,
            "mode": "supplier-profile",
            "source": "alibaba-profile",
            "url": url,
            "supplier": supplier
        }), 200

    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
        
# ============================================================
#  ROUTE DEBUG /debug_extract
# ============================================================

@app.route("/debug_extract")
def debug_extract():
    url = (request.args.get("url") or "").strip()
    if not url:
        return jsonify({"error": "Missing url"}), 400

    soup = _fetch_soup(url)
    if not soup:
        return jsonify({"error": "Impossible de charger la page"}), 500

    product = _extract_product_alibaba(soup)
    supplier = _extract_supplier_from_alibaba(soup)

    return jsonify(
        {
            "url": url,
            "product": product,
            "supplier": supplier,
        }
    ), 200

# ============================================================
#  SUIVI DE COMMANDE (tracking : Chine, DHL, UPS, FedEx, Air, Mer, ChoiceXpress)
# ============================================================

def guess_china_carrier(tracking_number: str) -> dict:
    """
    Devine le transporteur local chinois PROBABLE à partir du format du numéro.
    C'est heuristique (meilleure estimation), pas garanti à 100 %.
    Retourne : {carrier_code, carrier_name, confidence}
    """
    if not tracking_number:
        return {
            "carrier_code": None,
            "carrier_name": None,
            "confidence": 0.0
        }

    tn = tracking_number.strip().upper()
    length = len(tn)

    # YunExpress (très fréquent pour Alibaba)
    # Ex: YT123456789000, YT1234567896
    if tn.startswith("YT") and 10 <= length <= 16:
        return {
            "carrier_code": "YUNEXPRESS",
            "carrier_name": "YunExpress / YT-line",
            "confidence": 0.8
        }

    # SF Express - souvent commence par SF + chiffres
    if tn.startswith("SF"):
        return {
            "carrier_code": "SF",
            "carrier_name": "SF Express",
            "confidence": 0.9
        }

    # Yunda - parfois 'YD' ou 'YDH'
    if tn.startswith("YD") or tn.startswith("YDH"):
        return {
            "carrier_code": "YUNDA",
            "carrier_name": "Yunda Express",
            "confidence": 0.7
        }

    # ZTO Express - parfois 'ZTO'
    if tn.startswith("ZTO"):
        return {
            "carrier_code": "ZTO",
            "carrier_name": "ZTO Express",
            "confidence": 0.8
        }

    # Numéro digital 10–14 chiffres : souvent YTO, mais incertain
    if tn.isdigit() and 10 <= length <= 14:
        return {
            "carrier_code": "YTO",
            "carrier_name": "YTO Express (probable)",
            "confidence": 0.5
        }

    # Par défaut : inconnu → on laisse Cainiao / 17Track deviner
    return {
        "carrier_code": None,
        "carrier_name": None,
        "confidence": 0.0
    }


def build_china_tracking_links(tracking_number: str) -> dict:
    """
    Génère des liens externes pour le suivi local Chine.
    Compatible Cainiao, 17Track et Kuaidi100 (version mobile).
    """
    if not tracking_number:
        return {}

    return {
      "cainiao": f"https://global.cainiao.com/detail.htm?mailNoList={tracking_number}",
      "17track": f"https://www.17track.net/en/track?nums={tracking_number}",
      "kuaidi100": f"https://m.kuaidi100.com/app/query?nu={tracking_number}",
    }


def build_dhl_tracking_link(tracking_number: str) -> str:
    """
    Lien officiel DHL tracking.
    """
    return (
        "https://www.dhl.com/global-en/home/tracking.html"
        f"?tracking-id={tracking_number}"
    )


def build_ups_tracking_link(tracking_number: str) -> str:
    """
    Lien officiel UPS tracking.
    """
    return (
        "https://www.ups.com/track"
        f"?loc=en_US&tracknum={tracking_number}"
    )


def build_fedex_tracking_link(tracking_number: str) -> str:
    """
    Lien officiel FedEx tracking.
    """
    return (
        "https://www.fedex.com/fedextrack/"
        f"?trknbr={tracking_number}"
    )


def build_generic_17track_link(tracking_number: str) -> str:
    """
    Lien générique 17Track (prend en charge beaucoup de transporteurs).
    """
    return f"https://www.17track.net/en/track?nums={tracking_number}"


# ---------- ChoiceXpress (air + mer) ----------

def build_choice_air_link(code: str) -> str:
    """
    Lien de suivi aérien ChoiceXpress.
    Ex : MCO25023774
    """
    c = code.strip()
    return (
        "https://air.choicexp.com/air/webpage/com/jeecg/"
        f"milestone/milestone.jsp?codeid={c}"
    )


def build_choice_sea_link(code: str) -> str:
    """
    Lien de suivi maritime ChoiceXpress.
    Ex : KA30218
    """
    c = code.strip()
    return (
        "https://www.choicexp.com/query/milestone.html"
        f"?type=2&codeid={c}&baseCodeId={c}"
    )


def build_air_awb_links(awb_number: str) -> dict:
    """
    Liens génériques pour suivi aérien (AWB) + intégration ChoiceXpress
    si le numéro est de type MCO...
    """
    tn = awb_number.strip().upper()
    links = {
        "track_trace_air": f"https://www.track-trace.com/aircargo?number={tn}",
        "17track": build_generic_17track_link(tn),
    }

    # Si on détecte un code ChoiceXpress AIR (MCO...)
    if re.match(r"^MCO\d{8}$", tn):
        links["choice_air"] = build_choice_air_link(tn)

    return links


def build_sea_tracking_links(number: str) -> dict:
    """
    Liens pour suivi maritime (conteneur / BL) + ChoiceXpress mer
    si le numéro est de type KA...
    """
    tn = number.strip().upper()
    links = {}

    # Conteneur ? ex: MSCU1234567
    if re.match(r"^[A-Z]{4}\d{7}$", tn):
        links["track_trace_container"] = (
            "https://www.track-trace.com/container?number=" + tn
        )
    else:
        # Bill of Lading / BL / HBL
        links["track_trace_bl"] = (
            "https://www.track-trace.com/bill-of-lading?number=" + tn
        )

    # Si on détecte un code ChoiceXpress MER (KA...)
    if re.match(r"^KA\d{5,10}$", tn):
        links["choice_sea"] = build_choice_sea_link(tn)

    return links


def guess_tracking_type(tracking_number: str) -> str:
    """
    Essaie de deviner le TYPE de numéro de suivi :
      - china_local
      - dhl
      - ups
      - fedex_or_express
      - air_awb
      - sea_container
      - sea_bl
      - choice_air
      - choice_sea
      - unknown
    """
    if not tracking_number:
        return "unknown"

    tn = tracking_number.strip().upper()
    length = len(tn)

    # --- ChoiceXpress PRIORITAIRE sur le reste ---
    # Air : MCO + 8 chiffres (ex : MCO25023774)
    if re.match(r"^MCO\d{8}$", tn):
        return "choice_air"

    # Mer : KA + chiffres (ex : KA30218)
    if re.match(r"^KA\d{5,10}$", tn):
        return "choice_sea"

    # Local Chine ? (YT..., SF..., ZTO..., YD..., etc.)
    if tn.startswith(("YT", "SF", "YD", "YDH", "ZTO")) or (
        tn.isdigit() and 10 <= length <= 14
    ):
        return "china_local"

    # DHL : JD..., JJD..., JVGL..., ou 10–11 chiffres
    if tn.startswith(("JD", "JJD", "JVGL")) or (
        tn.isdigit() and length in (10, 11)
    ):
        return "dhl"

    # UPS : 1Z...
    if tn.startswith("1Z"):
        return "ups"

    # Air AWB : 11 chiffres (3 + 8)
    if tn.isdigit() and length == 11:
        return "air_awb"

    # Conteneur maritime : 4 lettres + 7 chiffres
    if re.match(r"^[A-Z]{4}\d{7}$", tn):
        return "sea_container"

    # BL / HBL : mélange lettres/chiffres, longueur moyenne
    if 8 <= length <= 18 and re.search(r"[A-Z]", tn) and re.search(r"\d", tn):
        return "sea_bl"

    # Express générique (FedEx ou autre)
    if tn.isdigit() and length in (12, 15, 20):
        return "fedex_or_express"

    return "unknown"


@app.route("/track", methods=["POST"])
def track():
    """
    Endpoint générique de suivi.
    JSON attendu :
    {
      "tracking_number": "...",
      "mode": "auto" | "china_local" | "dhl" | "ups" | "air" | "sea"
                               | "choice_air" | "choice_sea",
      "hint": "info facultative (ex: 'groupage', 'container', 'awb')"
    }
    """
    data = request.json or {}
    tracking_number = (data.get("tracking_number") or "").strip()
    mode = (data.get("mode") or "auto").strip().lower()
    hint = (data.get("hint") or "").strip().lower()

    if not tracking_number:
        return jsonify({"ok": False, "error": "Merci d'envoyer 'tracking_number'"}), 400

    # Si mode=auto → on essaie de deviner
    if mode == "auto":
        ttype = guess_tracking_type(tracking_number)
    else:
        # mode imposé par l'utilisateur
        ttype = mode

    result = {
        "ok": True,
        "tracking_number": tracking_number,
        "mode": mode,
        "detected_type": ttype,
        "hint": hint,
        "links": {},
        "extra": {},
        "note": "",
    }

    # --- CAS ChoiceXpress AIR (MCO...) ---
    if ttype == "choice_air":
        result["links"]["choice_air"] = build_choice_air_link(tracking_number)
        # En complément, outils génériques
        result["links"]["track_trace_air"] = (
            "https://www.track-trace.com/aircargo?number=" + tracking_number
        )
        result["links"]["17track"] = build_generic_17track_link(tracking_number)
        result["note"] = (
            "Numéro ChoiceXpress AIR (MCO...). "
            "Utilise d’abord le lien ChoiceXpress Air, puis les autres si besoin."
        )
        return jsonify(result), 200

    # --- CAS ChoiceXpress MER (KA...) ---
    if ttype == "choice_sea":
        result["links"]["choice_sea"] = build_choice_sea_link(tracking_number)
        # En complément, outils génériques BL
        result["links"]["track_trace_bl"] = (
            "https://www.track-trace.com/bill-of-lading?number=" + tracking_number
        )
        result["note"] = (
            "Numéro ChoiceXpress MARITIME (KA...). "
            "Utilise en priorité le lien ChoiceXpress Sea."
        )
        return jsonify(result), 200

    # --- CAS LOCAL CHINE ---
    if ttype == "china_local":
        carrier_guess = guess_china_carrier(tracking_number)
        links = build_china_tracking_links(tracking_number)
        result["links"] = links
        result["extra"]["carrier_guess"] = carrier_guess
        result["note"] = (
            "Suivi local en Chine. Certains numéros ne sont visibles que sur Cainiao. "
            "Si un lien ne fonctionne pas, essayez d'abord Cainiao, puis 17Track."
        )
        return jsonify(result), 200

    # --- CAS DHL ---
    if ttype == "dhl":
        result["links"]["dhl"] = build_dhl_tracking_link(tracking_number)
        result["links"]["17track"] = build_generic_17track_link(tracking_number)
        result["note"] = (
            "Numéro de type DHL/Express. Le lien DHL est prioritaire, "
            "17Track peut servir de vérification complémentaire."
        )
        return jsonify(result), 200

    # --- CAS UPS ---
    if ttype == "ups":
        result["links"]["ups"] = build_ups_tracking_link(tracking_number)
        result["note"] = "Numéro UPS (1Z...)."
        return jsonify(result), 200

    # --- CAS EXPRESS GÉNÉRIQUE (FedEx ou autre) ---
    if ttype == "fedex_or_express":
        result["links"]["fedex"] = build_fedex_tracking_link(tracking_number)
        result["links"]["17track"] = build_generic_17track_link(tracking_number)
        result["note"] = (
            "Numéro Express générique (FedEx ou autre). Le lien FedEx peut fonctionner, "
            "sinon utilisez 17Track."
        )
        return jsonify(result), 200

    # --- CAS AÉRIEN (AWB) ---
    if ttype == "air_awb" or mode == "air":
        result["links"] = build_air_awb_links(tracking_number)
        result["note"] = (
            "Numéro de type AWB (aérien). Utilisez track-trace ou 17Track en mode cargo."
        )
        return jsonify(result), 200

    # --- CAS MARITIME (conteneur / BL) ---
    if ttype in ("sea_container", "sea_bl") or mode == "sea":
        result["links"] = build_sea_tracking_links(tracking_number)
        result["note"] = (
            "Suivi maritime (conteneur ou BL/HBL). "
            "Les infos dépendent de la compagnie maritime."
        )
        return jsonify(result), 200

    # --- CAS INCONNU : au moins 17Track pour essayer ---
    result["links"]["17track"] = build_generic_17track_link(tracking_number)
    result["note"] = (
        "Type de numéro non reconnu. 17Track tentera d'identifier automatiquement "
        "le transporteur."
    )
    return jsonify(result), 200




# ============================================================
#  LANCEMENT LOCAL
# ============================================================

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)

    
