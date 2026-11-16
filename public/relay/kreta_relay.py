#!/usr/bin/env python3
"""
KrétaSync relay – a KRÉTA-lekérdezést a TE gépeden (magyar IP-ről) végzi, és a kész órarendet feltölti a KrétaSync-re.

Miért kell? A KRÉTA a Vercel szervereit (külföldi/adatközponti IP) nem engedi el, de otthonról működik.

Használat:
  1. Tedd ezt a fájlt a kreta.py mellé ugyanabba a mappába (a belépést a te kreta.py-d végzi, ugyanúgy, mint eddig).
  2. pip install requests beautifulsoup4
  3. Hozd létre a relay.env fájlt a relay.env.example alapján, majd futtasd:  ./run_relay.sh
"""
import os
import sys
from datetime import date, timedelta

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)            # a kreta.py a refresh_token.txt fájlt a munkamappába írja/olvassa
sys.path.insert(0, HERE)

try:
    from kreta import KretaUtils   # a te kreta.py fájlod
except ImportError:
    sys.exit("Nem található a kreta.py. Másold ezt a fájlt a kreta.py mellé ugyanabba a mappába.")


def need(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(f"Hiányzik a környezeti változó: {name} (lásd relay.env.example)")
    return value


def fetch_items(kreta, start: date, end: date):
    """Nyers órarend a KRÉTA-ból (az egyedi azonosítókkal és státuszokkal); az átalakítást a szerver végzi."""
    response = requests.get(
        f"https://{kreta.klik_id}.e-kreta.hu/ellenorzo/v3/Sajat/OrarendElemek",
        params={"datumTol": start.isoformat(), "datumIg": end.isoformat()},
        headers=kreta.request_headers,
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def push(base_url: str, token: str, start: date, end: date, items):
    response = requests.post(
        f"{base_url}/api/relay/push",
        json={"from": start.isoformat(), "to": end.isoformat(), "items": items},
        headers={"Authorization": f"Bearer {token}", "X-Requested-With": "kretasync"},
        timeout=60,
    )
    if response.status_code != 200:
        try:
            message = response.json().get("error", response.text[:200])
        except ValueError:
            message = response.text[:200]
        sys.exit(f"A KrétaSync elutasította a feltöltést ({response.status_code}): {message}")
    return response.json()


def main():
    base_url = need("KRETASYNC_URL").rstrip("/")
    token = need("KRETASYNC_TOKEN")
    user, password, klik = need("KRETA_USER"), need("KRETA_PASS"), need("KRETA_KLIK")
    days = int(os.environ.get("SYNC_DAYS", "14"))

    try:
        kreta = KretaUtils(user, password, klik)      # ugyanaz a belépés, mint a kreta.py-ban
    except Exception as e:                            # a jelszó nem kerül a hibaüzenetbe
        sys.exit(f"KRÉTA-belépés sikertelen: {str(e).replace(password, '***')}")

    start = date.today()
    end = start + timedelta(days=days)
    items = fetch_items(kreta, start, end)
    result = push(base_url, token, start, end, items)
    print(f"Kész: {result.get('lessons')} óra feltöltve ({start} – {end}).")


if __name__ == "__main__":
    main()
