"""Cliente del buscador de centros del Ministerio de Educación.

Endpoints (POST, sin documentar, verificados 2026-11):

- ``exportarListadoCentrosExcel``: listado de centros en .xls (BIFF8). Respeta
  los filtros del formulario, incluido ``idComunidad`` y ``ensenanza``.
- ``detalleCentro``: ficha del centro con la tabla completa de enseñanzas
  impartidas (grado, familia, enseñanza, modalidad).
"""

from __future__ import annotations

import asyncio
import html
import re

import httpx
import xlrd

BASE = "https://www.educacion.gob.es/centros"

#: Campos que acepta el formulario de búsqueda. Los vacíos no filtran.
CAMPOS_FORM = (
    "nivel",
    "idComunidad",
    "idProvincia",
    "naturaleza",
    "concertado",
    "familia",
    "ensenanza",
    "modalidad",
    "tipoCentro",
    "provincial",
    "comarca",
    "pais",
    "localidad",
    "codCentro",
    "nombreCentro",
    "denominacion",
    "ensenanzaFP",
)

#: Códigos de comunidad autónoma que usa el buscador.
CCAA = {
    "01": "Andalucía",
    "02": "Aragón",
    "03": "Principado de Asturias",
    "04": "Illes Balears",
    "05": "Canarias",
    "06": "Cantabria",
    "07": "Castilla y León",
    "08": "Castilla-La Mancha",
    "09": "Cataluña",
    "10": "Extremadura",
    "11": "Galicia",
    "12": "La Rioja",
    "13": "Comunidad de Madrid",
    "14": "Región de Murcia",
    "15": "Comunidad Foral de Navarra",
    "16": "Comunitat Valenciana",
    "17": "País Vasco",
    "18": "Ceuta",
    "19": "Melilla",
    "60": "Centros en el exterior",
}

_COLUMNAS_XLS = {
    "COMUNIDAD AUTÓNOMA": "ccaa",
    "PROVINCIA": "provincia",
    "LOCALIDAD": "localidad",
    "DENOMINACIÓN GENÉRICA": "denominacion_generica",
    "DENOMINACIÓN ESPECÍFICA": "denominacion",
    "CÓDIGO": "codigo",
    "NATURALEZA": "naturaleza",
    "DOMICILIO": "domicilio",
    "CÓD POSTAL": "cod_postal",
    "TELÉFONO": "telefono",
}

_CAMPO_RE = re.compile(
    r"<b>\s*([^<]+?)\s*</b>(?:\s*&nbsp;)+\s*(?:<span>(.*?)</span>|<a\s[^>]*>(.*?)</a>)",
    re.S,
)
_TABLA_RE = re.compile(r"<table.*?</table>", re.S)
_FILA_RE = re.compile(
    r"<tr>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>"
    r"\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>\s*</tr>",
    re.S,
)

#: Etiqueta de la ficha -> columna en la tabla ``centros``.
_CAMPOS_DETALLE = {
    "código de centro": "codigo",
    "denominación específica": "denominacion",
    "teléfono": "telefono",
    "fax": "fax",
    "correo electrónico": "email",
    "página web del centro": "web",
    "autonomía": "ccaa",
    "provincia": "provincia",
    "país": "pais",
    "comarca": "comarca",
    "sub.provincial / isla": "subprovincial",
    "municipio": "municipio",
    "localidad": "localidad",
    "domicilio": "domicilio",
    "código postal": "cod_postal",
    "naturaleza": "naturaleza",
    "concertado": "concertado",
    "tipo de centro": "tipo_centro",
    "denominación genérica": "denominacion_generica",
}


def _texto(fragmento: str) -> str:
    """Quita etiquetas HTML y normaliza espacios."""
    sin_tags = re.sub(r"<[^>]+>", " ", fragmento)
    return re.sub(r"\s+", " ", html.unescape(sin_tags)).strip()


def _form(**filtros: str) -> dict[str, str]:
    datos = dict.fromkeys(CAMPOS_FORM, "")
    desconocidos = set(filtros) - set(CAMPOS_FORM)
    if desconocidos:
        raise ValueError(f"filtros no soportados: {sorted(desconocidos)}")
    datos.update({k: str(v) for k, v in filtros.items()})
    return datos


def _celda(valor: object) -> str:
    if isinstance(valor, float) and valor.is_integer():
        return str(int(valor))
    return _texto(str(valor)) if isinstance(valor, str) else str(valor).strip()


def _parsea_xls(contenido: bytes) -> list[dict[str, str]]:
    libro = xlrd.open_workbook(file_contents=contenido)
    hoja = libro.sheet_by_index(0)
    columnas = [_COLUMNAS_XLS.get(_texto(str(hoja.cell_value(0, c)))) for c in range(hoja.ncols)]
    filas: list[dict[str, str]] = []
    for i in range(1, hoja.nrows):
        fila = {
            destino: _celda(hoja.cell_value(i, c))
            for c, destino in enumerate(columnas)
            if destino is not None
        }
        if fila.get("codigo"):
            fila["codigo"] = fila["codigo"].zfill(8)
            # el .xls repite la fila de cabecera cada cierto número de páginas
            if len(fila["codigo"]) == 8 and fila["codigo"].isdigit():
                filas.append(fila)
    return filas


async def listado(client: httpx.AsyncClient, **filtros: str) -> list[dict[str, str]]:
    """Descarga el listado de centros que cumple los filtros (una sola petición)."""
    respuesta = await client.post(
        f"{BASE}/exportarListadoCentrosExcel",
        data=_form(**filtros),
        timeout=httpx.Timeout(300.0),
    )
    respuesta.raise_for_status()
    return await asyncio.to_thread(_parsea_xls, respuesta.content)


def parsea_detalle(pagina: str) -> tuple[dict[str, str], list[dict[str, str]]]:
    """Extrae los campos del centro y sus enseñanzas de la ficha HTML."""
    limpio = re.sub(r"<!--.*?-->", "", pagina, flags=re.S)

    campos: dict[str, str] = {}
    for match in _CAMPO_RE.finditer(limpio):
        etiqueta = _texto(match.group(1)).rstrip(":").lower()
        columna = _CAMPOS_DETALLE.get(etiqueta)
        if columna:
            campos.setdefault(columna, _texto(match.group(2) or match.group(3) or ""))

    ofertas: list[dict[str, str]] = []
    for tabla in _TABLA_RE.findall(limpio):
        for fila in _FILA_RE.findall(tabla):
            grado, familia, ensenanza, modalidad = (_texto(celda) for celda in fila)
            if not ensenanza:
                continue
            ofertas.append(
                {
                    "grado": grado,
                    "familia": familia,
                    "ensenanza": ensenanza,
                    "modalidad": modalidad,
                }
            )
    return campos, ofertas


async def detalle(
    client: httpx.AsyncClient, codigo: str, intentos: int = 3
) -> tuple[dict[str, str], list[dict[str, str]]]:
    """Descarga y parsea la ficha de un centro."""
    ultimo_error: Exception | None = None
    for intento in range(intentos):
        try:
            respuesta = await client.post(
                f"{BASE}/detalleCentro", data={"codCentro": codigo}, timeout=60.0
            )
            respuesta.raise_for_status()
            campos, ofertas = parsea_detalle(respuesta.text)
            if "Error en la aplicación" in respuesta.text or not campos.get("codigo"):
                raise ValueError("ficha vacía o página de error")
            return campos, ofertas
        except Exception as error:  # noqa: BLE001 - reintento genérico
            ultimo_error = error
            await asyncio.sleep(1.5 * (intento + 1))
    raise RuntimeError(f"detalle de {codigo} falló: {ultimo_error}")
