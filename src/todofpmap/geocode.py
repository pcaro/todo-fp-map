"""Geocodificación con CartoCiudad (IGN-CNIG, sin API key).

El endpoint ``findJsonp`` devuelve lat/lng para todos los niveles de precisión
(portal, callejero, población, municipio), a diferencia de ``candidatesJsonp``,
que devuelve 0,0 salvo para portales.

Las coincidencias se validan contra la provincia del centro (los dos primeros
dígitos del código de centro son el código INE de provincia, el mismo que
devuelve CartoCiudad). Sin esa comprobación, un nombre de calle repetido acaba
colocando el centro a 300 km.
"""

from __future__ import annotations

import asyncio
import json
import re
import urllib.parse

import httpx

from .fuentes import coordenada_valida, sin_acentos

CARTOCIUDAD = "https://www.cartociudad.es/geocoder/api/geocoder/findJsonp"

#: Basura habitual en el campo domicilio del registro oficial.
_RUIDO_RE = re.compile(
    r"(?i)(?:<[^>]+>|"
    r"\b(?:s/n|s/n\.|sn|s\.n\.|sin\s+n[uú]mero|sin\s+especificar|"
    r"no\s+consta|desconocid[oa]|99/<[^>]*>)\b)"
)

#: precisión devuelta -> etiqueta que guardamos en la BD
_PRECISION = {
    "portal": "portal",
    "callejero": "callejero",
    "poblacion": "localidad",
    "municipio": "municipio",
    "provincia": "provincia",
}

#: orden de preferencia (menor es mejor)
_RANGO = {"portal": 0, "callejero": 1, "localidad": 2, "municipio": 3, "provincia": 4}


def normaliza_direccion(domicilio: str) -> str:
    """Limpia 's/n', restos de HTML y puntuación colgante."""
    limpio = _RUIDO_RE.sub(" ", domicilio or "")
    limpio = re.sub(r"\s+", " ", limpio)
    return limpio.strip(" ,;.-")


def _consultas(domicilio: str, localidad: str, provincia: str, cod_postal: str) -> list[str]:
    """Consultas de más a menos específica, sin repetir."""
    via = normaliza_direccion(domicilio)
    calle = normaliza_direccion(via.split(",")[0]) if via else ""
    poblacion = localidad or ""
    consultas = []
    if via and poblacion:
        consultas.append(f"{via}, {poblacion}")
    if via and cod_postal:
        consultas.append(f"{via}, {cod_postal} {poblacion}".strip())
    if via:
        consultas.append(f"{via}, {provincia}")
    if calle and calle != via and poblacion:
        consultas.append(f"{calle}, {poblacion}")
    if poblacion and provincia:
        consultas.append(f"{poblacion}, {provincia}")
    vistas: list[str] = []
    for consulta in consultas:
        if consulta and consulta not in vistas:
            vistas.append(consulta)
    return vistas


async def _busca(client: httpx.AsyncClient, consulta: str) -> dict | None:
    url = f"{CARTOCIUDAD}?{urllib.parse.urlencode({'q': consulta})}"
    try:
        respuesta = await client.get(url, timeout=30.0)
        respuesta.raise_for_status()
        texto = respuesta.text
        inicio, fin = texto.find("("), texto.rfind(")")
        resultado = json.loads(texto[inicio + 1 : fin])
    except (httpx.HTTPError, ValueError):
        return None
    if not isinstance(resultado, dict) or not resultado.get("lat"):
        return None
    return resultado


class CartoCiudad:
    """Cliente de CartoCiudad con pausa entre consultas."""

    def __init__(self, client: httpx.AsyncClient, pausa: float = 0.2) -> None:
        self._client = client
        self._pausa = pausa

    async def geocodifica(
        self,
        domicilio: str,
        localidad: str,
        provincia: str,
        cod_postal: str,
        provincia_codigo: str = "",
        municipio: str = "",
    ) -> tuple[float, float, str] | None:
        """Devuelve ``(lat, lng, precision)``, quedándose con la mejor coincidencia."""
        mejor: tuple[int, dict] | None = None
        for consulta in _consultas(domicilio, localidad, provincia, cod_postal):
            await asyncio.sleep(self._pausa)
            resultado = await _busca(self._client, consulta)
            if resultado is None:
                continue
            precision = _PRECISION.get(str(resultado.get("type", "")).lower(), "municipio")
            lat, lng = float(resultado["lat"]), float(resultado["lng"])
            if not coordenada_valida(lat, lng):
                continue
            if provincia_codigo and str(resultado.get("provinceCode") or "") != provincia_codigo:
                continue
            if preciso(precision) and not _mismo_municipio(resultado, municipio, localidad):
                continue
            # penaliza si el código postal no cuadra con el del centro
            cp = str(resultado.get("postalCode") or "")
            desajuste = 1 if cod_postal and cp and cp != cod_postal else 0
            rango = _RANGO[precision] + desajuste * 10
            if mejor is None or rango < mejor[0]:
                mejor = (rango, {**resultado, "_precision": precision})
            if rango == 0:
                break
        if mejor is None:
            return None
        datos = mejor[1]
        return float(datos["lat"]), float(datos["lng"]), datos["_precision"]


def preciso(precision: str) -> bool:
    """Calle o mejor: en esos niveles exigimos que el municipio cuadre."""
    return precision in ("portal", "callejero")


def _mismo_municipio(resultado: dict, *candidatos: str) -> bool:
    obtenido = sin_acentos(str(resultado.get("muni") or ""))
    if not obtenido:
        return True
    for candidato in candidatos:
        esperado = sin_acentos(candidato)
        if esperado and (esperado in obtenido or obtenido in esperado):
            return True
    return False
