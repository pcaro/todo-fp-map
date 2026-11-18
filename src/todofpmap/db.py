"""Esquema y escrituras de la base SQLite."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

ESQUEMA = """
CREATE TABLE IF NOT EXISTS centros (
    codigo               TEXT PRIMARY KEY,
    ccaa                 TEXT,
    provincia            TEXT,
    municipio            TEXT,
    localidad            TEXT,
    denominacion         TEXT,
    denominacion_generica TEXT,
    naturaleza           TEXT,
    concertado           TEXT,
    tipo_centro          TEXT,
    domicilio            TEXT,
    cod_postal           TEXT,
    telefono             TEXT,
    fax                  TEXT,
    email                TEXT,
    web                  TEXT,
    lat                  REAL,
    lng                  REAL,
    geo_fuente           TEXT,
    geo_precision        TEXT,
    detalle_ok           INTEGER NOT NULL DEFAULT 0,
    actualizado          TEXT
);

CREATE TABLE IF NOT EXISTS oferta (
    centro_codigo TEXT NOT NULL REFERENCES centros(codigo) ON DELETE CASCADE,
    grado         TEXT NOT NULL DEFAULT '',
    familia       TEXT NOT NULL DEFAULT '',
    ensenanza     TEXT NOT NULL,
    modalidad     TEXT NOT NULL DEFAULT '',
    es_fp         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (centro_codigo, grado, familia, ensenanza, modalidad)
);

CREATE INDEX IF NOT EXISTS idx_oferta_ensenanza ON oferta (ensenanza);
CREATE INDEX IF NOT EXISTS idx_centros_provincia ON centros (provincia);
"""

#: Tabla desnormalizada lista para el mapa (una fila por centro y enseñanza).
#: Es una tabla real, no una vista, porque Datasette no ofrece facetas en vistas.
TABLA_MAPA = """
DROP TABLE IF EXISTS oferta_mapa;
CREATE TABLE oferta_mapa AS
SELECT
    c.codigo        AS centro_codigo,
    c.denominacion,
    c.municipio,
    c.localidad,
    c.provincia,
    c.naturaleza,
    c.tipo_centro,
    c.domicilio,
    c.cod_postal,
    o.grado,
    o.familia,
    o.ensenanza,
    o.modalidad,
    c.lat,
    c.lng,
    c.geo_precision,
    c.geo_fuente
FROM oferta o
JOIN centros c ON c.codigo = o.centro_codigo
WHERE c.lat IS NOT NULL /*FILTRO_FP*/;

CREATE INDEX idx_mapa_provincia ON oferta_mapa (provincia);
CREATE INDEX idx_mapa_grado ON oferta_mapa (grado);
CREATE INDEX idx_mapa_ensenanza ON oferta_mapa (ensenanza);
"""

#: Una fila por centro: es la tabla de aterrizaje del mapa.
#: Con oferta_mapa el mapa queda enterrado bajo las facetas y el navegador
#: tiene que pintar 4 veces más marcadores.
TABLA_CENTROS_MAPA = """
DROP TABLE IF EXISTS mapa;
CREATE TABLE mapa AS
SELECT
    c.codigo,
    c.denominacion,
    c.municipio,
    c.provincia,
    c.naturaleza,
    c.tipo_centro,
    c.domicilio,
    c.cod_postal,
    (SELECT count(*) FROM oferta o
      WHERE o.centro_codigo = c.codigo /*FILTRO_FP*/) AS n_ensenanzas,
    c.lat,
    c.lng,
    c.geo_precision
FROM centros c
WHERE c.lat IS NOT NULL
  AND EXISTS (SELECT 1 FROM oferta o
               WHERE o.centro_codigo = c.codigo /*FILTRO_FP*/);
"""


def es_fp(grado: str) -> int:
    """1 si el grado es Formación Profesional.

    Quedan fuera ESO, Bachillerato, Primaria/Infantil, adultos, idiomas, música,
    danza, artes plásticas y diseño y enseñanzas deportivas (régimen especial).
    Los cursos de especialización de FP sí entran.
    """
    g = (grado or "").strip().casefold()
    return int(
        "formación profesional" in g
        or g.startswith("grado d. ciclos formativos")
        or "formativos de fp" in g
    )


def conectar(ruta: Path) -> sqlite3.Connection:
    ruta.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(ruta)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(ESQUEMA)
    columnas = {fila[1] for fila in conn.execute("PRAGMA table_info(oferta)")}
    if "es_fp" not in columnas:
        conn.execute("ALTER TABLE oferta ADD COLUMN es_fp INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    pendientes = conn.execute("SELECT DISTINCT grado FROM oferta WHERE es_fp = 0").fetchall()
    for (grado,) in pendientes:
        if es_fp(grado):
            conn.execute("UPDATE oferta SET es_fp = 1 WHERE grado = ?", (grado,))
    conn.commit()
    return conn


def _ahora() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


_CAMPOS_LISTA = (
    "codigo",
    "ccaa",
    "provincia",
    "localidad",
    "denominacion",
    "denominacion_generica",
    "naturaleza",
    "domicilio",
    "cod_postal",
    "telefono",
)


def guarda_listado(conn: sqlite3.Connection, filas: list[dict[str, str]]) -> int:
    """Inserta/actualiza los campos del listado sin pisar geocodificación ni ficha."""
    sql = f"""
        INSERT INTO centros ({", ".join(_CAMPOS_LISTA)}, actualizado)
        VALUES ({", ".join("?" * len(_CAMPOS_LISTA))}, ?)
        ON CONFLICT(codigo) DO UPDATE SET
            {", ".join(f"{c} = excluded.{c}" for c in _CAMPOS_LISTA if c != "codigo")},
            actualizado = excluded.actualizado
    """
    ahora = _ahora()
    conn.executemany(
        sql, [tuple(fila.get(c, "") for c in _CAMPOS_LISTA) + (ahora,) for fila in filas]
    )
    conn.commit()
    return len(filas)


_CAMPOS_DETALLE = (
    "denominacion",
    "denominacion_generica",
    "naturaleza",
    "concertado",
    "tipo_centro",
    "domicilio",
    "cod_postal",
    "telefono",
    "fax",
    "email",
    "web",
    "ccaa",
    "provincia",
    "municipio",
    "localidad",
)


def guarda_detalle(
    conn: sqlite3.Connection, codigo: str, campos: dict[str, str], ofertas: list[dict[str, str]]
) -> None:
    valores = {c: campos.get(c, "") for c in _CAMPOS_DETALLE}
    conn.execute(
        f"""
        INSERT INTO centros (codigo, {", ".join(_CAMPOS_DETALLE)}, detalle_ok, actualizado)
        VALUES (?, {", ".join("?" * len(_CAMPOS_DETALLE))}, 1, ?)
        ON CONFLICT(codigo) DO UPDATE SET
            {", ".join(f"{c} = excluded.{c}" for c in _CAMPOS_DETALLE)},
            detalle_ok = 1,
            actualizado = excluded.actualizado
        """,
        (codigo, *valores.values(), _ahora()),
    )
    conn.execute("DELETE FROM oferta WHERE centro_codigo = ?", (codigo,))
    conn.executemany(
        """
        INSERT OR IGNORE INTO oferta
            (centro_codigo, grado, familia, ensenanza, modalidad, es_fp)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        [
            (
                codigo,
                o.get("grado", ""),
                o.get("familia", ""),
                o.get("ensenanza", ""),
                o.get("modalidad", ""),
                es_fp(o.get("grado", "")),
            )
            for o in ofertas
        ],
    )
    conn.commit()


def guarda_coords(
    conn: sqlite3.Connection,
    codigo: str,
    lat: float,
    lng: float,
    fuente: str,
    precision: str,
) -> None:
    conn.execute(
        "UPDATE centros SET lat = ?, lng = ?, geo_fuente = ?, geo_precision = ? WHERE codigo = ?",
        (lat, lng, fuente, precision, codigo),
    )
    conn.commit()


def crea_tabla_mapa(conn: sqlite3.Connection, solo_fp: bool = True) -> tuple[int, int]:
    filtro = "AND o.es_fp = 1" if solo_fp else ""
    sql = (TABLA_MAPA + TABLA_CENTROS_MAPA).replace("/*FILTRO_FP*/", filtro)
    conn.executescript(sql)
    conn.commit()
    centros = conn.execute("SELECT count(*) FROM mapa").fetchone()[0]
    ofertas = conn.execute("SELECT count(*) FROM oferta_mapa").fetchone()[0]
    return centros, ofertas


def estadisticas(conn: sqlite3.Connection) -> dict[str, object]:
    uno = lambda sql: conn.execute(sql).fetchone()[0]  # noqa: E731
    return {
        "centros": uno("SELECT count(*) FROM centros"),
        "con_detalle": uno("SELECT count(*) FROM centros WHERE detalle_ok = 1"),
        "con_coords": uno("SELECT count(*) FROM centros WHERE lat IS NOT NULL"),
        "oferta": uno("SELECT count(*) FROM oferta"),
        "oferta_fp": uno("SELECT count(*) FROM oferta WHERE es_fp = 1"),
        "provincias": uno("SELECT count(DISTINCT provincia) FROM centros"),
        "geocodificacion": [
            dict(fila)
            for fila in conn.execute(
                "SELECT geo_fuente, geo_precision, count(*) AS n FROM centros"
                " WHERE lat IS NOT NULL GROUP BY 1, 2 ORDER BY n DESC"
            )
        ],
    }
