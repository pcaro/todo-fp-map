"""Script del proyecto: descarga, geocodifica y prepara la BD para Datasette."""

from __future__ import annotations

import argparse
import asyncio
import sqlite3
import sys
import time
from pathlib import Path

import httpx

from . import db, fuentes, mefp
from .geocode import CartoCiudad

UA = "todofp-map/0.1 (github.com/pcaro/todo-fp-map)"
DB_POR_DEFECTO = Path("centros.sqlite")
CACHE_ANDALUCIA = Path("data/andalucia_centros_24_25.csv")


def _cliente(concurrencia: int = 4) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        headers={"User-Agent": UA},
        limits=httpx.Limits(max_connections=concurrencia * 2),
        follow_redirects=True,
    )


def _consola(texto: str) -> None:
    print(texto, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- fetch


async def cmd_fetch(args: argparse.Namespace) -> None:
    conn = db.conectar(args.db)
    async with _cliente(args.concurrencia) as client:
        filtros = {"idComunidad": args.ccaa} if args.ccaa else {}
        etiqueta = mefp.CCAA.get(args.ccaa or "", "todo el Estado")
        _consola(f"→ listado de centros ({etiqueta})")
        filas = await mefp.listado(client, **filtros)
        _consola(f"  {len(filas)} centros en el listado")
        db.guarda_listado(conn, filas)

        if args.solo_lista:
            return

        hechos = {
            fila[0] for fila in conn.execute("SELECT codigo FROM centros WHERE detalle_ok = 1")
        }
        pendientes = [f["codigo"] for f in filas if args.refrescar or f["codigo"] not in hechos]
        if args.limite:
            pendientes = pendientes[: args.limite]
        _consola(f"→ fichas de centro a descargar: {len(pendientes)}")
        if not pendientes:
            return

        semaforo = asyncio.Semaphore(args.concurrencia)
        inicio = time.monotonic()
        completados = 0
        errores: list[str] = []

        async def tarea(codigo: str) -> None:
            nonlocal completados
            async with semaforo:
                try:
                    campos, ofertas = await mefp.detalle(client, codigo)
                    db.guarda_detalle(conn, codigo, campos, ofertas)
                except Exception as error:  # noqa: BLE001 - se reporta al final
                    errores.append(f"{codigo}: {error}")
                completados += 1
                if completados % 100 == 0 or completados == len(pendientes):
                    ritmo = completados / max(time.monotonic() - inicio, 0.001)
                    _consola(f"  {completados}/{len(pendientes)} fichas ({ritmo:.1f}/s)")

        await asyncio.gather(*(tarea(codigo) for codigo in pendientes))
        if errores:
            _consola(f"  {len(errores)} errores; reintenta con el mismo comando")
            for linea in errores[:10]:
                _consola(f"    {linea}")


# -------------------------------------------------------------- geocode


async def cmd_geocode(args: argparse.Namespace) -> None:
    conn = db.conectar(args.db)
    if args.rehacer:
        conn.execute(
            "UPDATE centros SET lat = NULL, lng = NULL, geo_fuente = NULL, geo_precision = NULL"
        )
        conn.commit()
        _consola("→ coordenadas borradas (--rehacer)")
    async with _cliente(args.concurrencia) as client:
        if not args.solo_cartociudad and (args.ccaa in (None, "01")):
            coords = await fuentes.coords_andalucia(client, args.cache)
            aplicados = 0
            for codigo, (lat, lng) in coords.items():
                if args.limite and aplicados >= args.limite:
                    break
                cursor = conn.execute(
                    "UPDATE centros SET lat = ?, lng = ?, geo_fuente = 'junta-andalucia',"
                    " geo_precision = 'oficial' WHERE codigo = ? AND lat IS NULL",
                    (lat, lng, codigo),
                )
                aplicados += cursor.rowcount
            conn.commit()
            _consola(f"→ coordenadas oficiales de Andalucía aplicadas: {aplicados}")

        consulta = "SELECT codigo, domicilio, localidad, municipio, provincia, cod_postal"
        consulta += " FROM centros WHERE lat IS NULL"
        if args.ccaa:
            consulta += " AND ccaa LIKE ?"
        # LIKE solo ignora mayúsculas en ASCII: se compara todo en mayúsculas
        parametros = () if not args.ccaa else (f"%{mefp.CCAA[args.ccaa].upper()}%",)
        pendientes = conn.execute(consulta + " ORDER BY codigo", parametros).fetchall()
        if args.limite:
            pendientes = pendientes[: args.limite]
        _consola(f"→ centros a geocodificar con CartoCiudad: {len(pendientes)}")
        if not pendientes:
            return

        geo = CartoCiudad(client, pausa=args.pausa)
        semaforo = asyncio.Semaphore(args.concurrencia)
        inicio = time.monotonic()
        completados = 0
        con_coords = 0
        sin_coords: list[str] = []

        async def tarea(fila: sqlite3.Row) -> None:
            nonlocal completados, con_coords
            async with semaforo:
                resultado = await geo.geocodifica(
                    fila["domicilio"] or "",
                    fila["localidad"] or fila["municipio"] or "",
                    fila["provincia"] or "",
                    fila["cod_postal"] or "",
                    provincia_codigo=fila["codigo"][:2],
                    municipio=fila["municipio"] or "",
                )
                if resultado:
                    lat, lng, precision = resultado
                    db.guarda_coords(conn, fila["codigo"], lat, lng, "cartociudad", precision)
                    con_coords += 1
                else:
                    sin_coords.append(fila["codigo"])
                completados += 1
                if completados % 100 == 0 or completados == len(pendientes):
                    ritmo = completados / max(time.monotonic() - inicio, 0.001)
                    _consola(f"  {completados}/{len(pendientes)} ({ritmo:.1f}/s, {con_coords} ok)")

        await asyncio.gather(*(tarea(fila) for fila in pendientes))
        if sin_coords:
            _consola(f"  sin coordenadas: {len(sin_coords)} centros")


# ---------------------------------------------------------- mapa y stats


def cmd_mapa(args: argparse.Namespace) -> None:
    conn = db.conectar(args.db)
    if args.todo:
        centros, ofertas = db.crea_vistas(conn, solo_fp=False, sufijo="_todo")
        _consola(f"→ vistas mapa_todo / oferta_mapa_todo: {centros} centros, {ofertas} filas")
    centros, ofertas = db.crea_vistas(conn)
    _consola(f"→ vistas mapa / oferta_mapa (solo FP): {centros} centros, {ofertas} filas")


def cmd_stats(args: argparse.Namespace) -> None:
    conn = db.conectar(args.db)
    print(db.estadisticas(conn))


def cmd_build(args: argparse.Namespace) -> None:
    asyncio.run(cmd_fetch(args))
    asyncio.run(cmd_geocode(args))
    cmd_mapa(args)
    cmd_stats(args)


# ------------------------------------------------------------------ lite


def cmd_lite(args: argparse.Namespace) -> None:
    """Genera una BD reducida para subir a un gist y abrir en Datasette Lite."""
    origen = sqlite3.connect(args.db)
    destino = args.salida
    if destino.exists():
        destino.unlink()
    copia = sqlite3.connect(destino)
    origen.backup(copia)
    origen.close()

    # Las vistas necesitan sus tablas, así que se recortan filas: fuera las
    # enseñanzas que no son FP y los centros que no imparten FP o no tienen
    # coordenadas. 5 decimales de lat/lng son 1 m: de sobra y ahorra bytes.
    copia.executescript(
        """
        PRAGMA foreign_keys = OFF;
        -- hay que soltar las vistas antes de recrear las tablas que leen
        DROP VIEW IF EXISTS oferta_mapa;
        DROP VIEW IF EXISTS mapa;
        DELETE FROM oferta WHERE es_fp = 0;
        DELETE FROM centros
         WHERE lat IS NULL
            OR codigo NOT IN (SELECT centro_codigo FROM oferta);
        UPDATE centros SET lat = round(lat, 5), lng = round(lng, 5);
        -- la PK compuesta de 5 columnas cuesta tanto como la tabla y en un
        -- artefacto de solo lectura no sirve de nada
        CREATE TABLE oferta_sin_pk AS SELECT * FROM oferta;
        DROP TABLE oferta;
        ALTER TABLE oferta_sin_pk RENAME TO oferta;
        DROP INDEX IF EXISTS idx_oferta_ensenanza;
        DROP INDEX IF EXISTS idx_centros_provincia;
        VACUUM;
        """
    )
    db.crea_vistas(copia)
    copia.commit()
    copia.close()
    megas = destino.stat().st_size / 1_048_576
    _consola(f"→ {destino} ({megas:.1f} MB)")
    if megas > 20:
        _consola("  aviso: >20 MB, Datasette Lite tardará en cargar; limita con --ccaa")


# ------------------------------------------------------------------- url


def cmd_url(args: argparse.Namespace) -> None:
    """Compone la URL de Datasette Lite a partir de la URL del gist."""
    base = args.gist.rstrip("/")
    if "gist.github.com" in base:
        partes = base.split("gist.github.com/", 1)[1].split("/")
        usuario, ident = partes[0], partes[1]
        base = f"https://gist.githubusercontent.com/{usuario}/{ident}/raw"
    elif base.endswith("/raw"):
        pass
    elif "/raw/" in base:
        base = base.split("/raw/")[0] + "/raw"
    if args.estable:
        # Datasette 0.65 no entiende ?s.* ni datasette-maplibre (que pide 1.0a43+)
        comun = (
            "https://lite.datasette.io/?ref=stable&install=datasette-cluster-map"
            f"&url={base}/{args.nombre}"
            f"&metadata={base}/metadata.yml"
        )
        print("Mapa (Datasette 0.65, se queda en 1.000 puntos):")
        print(f"{comun}#/centros/mapa?_facet=provincia&_facet_size=8")
        return

    # datasette-maplibre exige Datasette 1.0a43+, que es lo que carga Lite por defecto.
    # container mueve el mapa de "debajo de las facetas" a "debajo del título":
    # sin eso hay que hacer scroll para verlo.
    comun = (
        "https://lite.datasette.io/?install=datasette-maplibre"
        "&s.settings.max_returned_rows=40000"
        "&s.plugins.datasette-maplibre.container=div.metadata-description"
        f"&url={base}/{args.nombre}"
        f"&metadata={base}/metadata.yml"
    )
    print("Centros por titulación (una fila por centro y enseñanza):")
    print(
        f"{comun}#/centros/oferta_mapa?_facet=ensenanza&_facet=provincia&_facet=naturaleza"
        "&_facet_size=8%23map=5.3/40.2/-3.7&color=ensenanza"
    )
    print()
    print("Mapa de centros (un punto por centro):")
    print(f"{comun}#/centros/mapa?_facet=provincia&_facet_size=8%23map=5.3/40.2/-3.7&color=provincia")


# -------------------------------------------------------------------- CLI


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="todofp", description="Centros de FP de España → SQLite → mapa"
    )
    parser.add_argument("--db", type=Path, default=DB_POR_DEFECTO, help="ruta de la BD SQLite")
    sub = parser.add_subparsers(dest="comando", required=True)

    def comun(p: argparse.ArgumentParser) -> None:
        p.add_argument("--ccaa", default="01", help="código de CCAA (01=Andalucía, vacío=todo)")
        p.add_argument("--limite", type=int, default=0, help="máximo de centros a procesar")
        p.add_argument("--concurrencia", type=int, default=4, help="peticiones simultáneas")

    fetch = sub.add_parser("fetch", help="listado de centros + fichas con sus enseñanzas")
    comun(fetch)
    fetch.add_argument("--solo-lista", action="store_true", help="no descargar fichas")
    fetch.add_argument("--refrescar", action="store_true", help="volver a bajar fichas ya hechas")
    fetch.set_defaults(func=cmd_fetch, asincrono=True)

    geo = sub.add_parser("geocode", help="rellena lat/lng (Andalucía oficial + CartoCiudad)")
    comun(geo)
    geo.add_argument("--pausa", type=float, default=0.2, help="segundos entre consultas")
    geo.add_argument("--solo-cartociudad", action="store_true", help="ignora el CSV de la Junta")
    geo.add_argument("--rehacer", action="store_true", help="borra las coordenadas actuales")
    geo.add_argument("--cache", type=Path, default=CACHE_ANDALUCIA)
    geo.set_defaults(func=cmd_geocode, asincrono=True)

    mapa = sub.add_parser("mapa", help="recrea las vistas mapa y oferta_mapa (solo FP)")
    mapa.add_argument("--todo", action="store_true", help="incluye también ESO, idiomas, música…")
    mapa.set_defaults(func=cmd_mapa, asincrono=False)

    stats = sub.add_parser("stats", help="resumen de la BD")
    stats.set_defaults(func=cmd_stats, asincrono=False)

    build = sub.add_parser("build", help="fetch + geocode + mapa + stats")
    comun(build)
    build.add_argument("--pausa", type=float, default=0.2)
    build.add_argument("--solo-cartociudad", action="store_true")
    build.add_argument("--cache", type=Path, default=CACHE_ANDALUCIA)
    build.add_argument("--solo-lista", action="store_true")
    build.add_argument("--refrescar", action="store_true")
    build.add_argument("--rehacer", action="store_true")
    build.add_argument("--todo", action="store_true")
    build.set_defaults(func=cmd_build, asincrono=False)

    lite = sub.add_parser("lite", help="BD reducida para gist + Datasette Lite")
    lite.add_argument("--salida", type=Path, default=Path("data/centros.sqlite"))
    lite.set_defaults(func=cmd_lite, asincrono=False)

    url = sub.add_parser("url", help="imprime la URL de Datasette Lite para un gist")
    url.add_argument("gist", help="URL del gist (gist.github.com/... o .../raw)")
    url.add_argument("--nombre", default="centros.sqlite", help="nombre del fichero en el gist")
    url.add_argument(
        "--estable",
        action="store_true",
        help="fija Datasette 0.65 (sin los ajustes de 1.0: el mapa corta a 1000 puntos)",
    )
    url.set_defaults(func=cmd_url, asincrono=False)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if getattr(args, "asincrono", False):
        asyncio.run(args.func(args))
    else:
        args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
