"""Fuentes de datos por comunidad autónoma (coordenadas oficiales).

Andalucía publica el directorio completo con lat/lng, así que sus centros no
necesitan geocodificación: se copian tal cual.
"""

from __future__ import annotations

import csv
import io
import unicodedata
from pathlib import Path

import httpx

#: Directorio de centros docentes no universitarios de Andalucía, curso 2024/2025.
ANDALUCIA_URL = (
    "https://www.juntadeandalucia.es/datosabiertos/portal/dataset/"
    "e039df22-4b82-4d0d-9884-0ab5952e24e4/resource/"
    "b5924e81-0b53-4418-9d93-b1f39ba1ef65/download/da_centros.csv"
)

#: Caja envolvente de España (incluye Canarias, Ceuta y Melilla).
LAT_MIN, LAT_MAX = 27.0, 44.5
LNG_MIN, LNG_MAX = -18.5, 4.5


def coordenada_valida(lat: float, lng: float) -> bool:
    return LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lng <= LNG_MAX


def _numero(texto: str) -> float | None:
    """Acepta '37,245' y '37.245'; la coma manda si están los dos."""
    limpio = (texto or "").strip()
    if not limpio:
        return None
    if "," in limpio:
        limpio = limpio.replace(".", "").replace(",", ".")
    try:
        return float(limpio)
    except ValueError:
        return None


def sin_acentos(texto: str) -> str:
    normalizado = unicodedata.normalize("NFKD", texto or "")
    return "".join(c for c in normalizado if not unicodedata.combining(c)).lower().strip()


async def coords_andalucia(
    client: httpx.AsyncClient, cache: Path
) -> dict[str, tuple[float, float]]:
    """Devuelve ``{código de centro: (lat, lng)}`` desde el CSV de la Junta."""
    cache.parent.mkdir(parents=True, exist_ok=True)
    if not cache.exists():
        respuesta = await client.get(ANDALUCIA_URL, timeout=120.0, follow_redirects=True)
        respuesta.raise_for_status()
        cache.write_bytes(respuesta.content)

    texto = cache.read_text(encoding="utf-8", errors="replace")
    coords: dict[str, tuple[float, float]] = {}
    for fila in csv.DictReader(io.StringIO(texto), delimiter=";"):
        codigo = (fila.get("codigo") or "").strip()
        lat = _numero(fila.get("N_LATITUD", ""))
        lng = _numero(fila.get("N_LONGITUD", ""))
        if codigo and lat is not None and lng is not None and coordenada_valida(lat, lng):
            coords[codigo] = (lat, lng)
    return coords
