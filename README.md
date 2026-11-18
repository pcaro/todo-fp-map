# todo-fp-map

Centros de FP de España en una base SQLite: **qué imparte cada centro**, con
dirección y coordenadas, listo para montar un mapa.

La fuente principal es el [buscador de centros del Ministerio de Educación
(todofp.es)](https://todofp.es/que-estudiar/grados-d.html), que expone el
registro estatal completo en unos endpoints POST sin documentar. Este proyecto
los consume, añade coordenadas (CSV oficial de la Junta de Andalucía +
[CartoCiudad](https://www.cartociudad.es/)) y genera una tabla desnormalizada
pensada para [Datasette](https://datasette.io) y Datasette Lite.

## Instalación

Necesitas [uv](https://docs.astral.sh/uv/). Nada más.

```bash
uv sync
```

## Uso

Andalucía (por defecto: `--ccaa 01`):

```bash
# 1) listado de centros + ficha de cada uno (enseñanzas incluidas)
uv run todofp fetch --ccaa 01

# 2) coordenadas: CSV oficial de la Junta y, para lo que falte, CartoCiudad
uv run todofp geocode --ccaa 01

# 3) tabla oferta_mapa lista para Datasette
uv run todofp mapa
uv run todofp stats
```

Todo en uno:

```bash
uv run todofp build --ccaa 01
```

Toda España es lo mismo con `--ccaa ""` (son ~35.000 fichas; con la
concurrencia por defecto tarda media hora).

Prueba rápida con un puñado de centros:

```bash
uv run todofp build --ccaa 01 --limite 20
```

### ¿Qué hace cada paso?

| Paso | Peticiones | Qué obtiene |
|---|---|---|
| `fetch` | 1 + una por centro | Listado (código, denominación, domicilio, CP, teléfono) y ficha con grado, familia, enseñanza y modalidad |
| `geocode` | 1 descarga + ~1 por centro | `lat`/`lng` con precisión: `oficial`, `portal`, `callejero`, `localidad`, `municipio` |
| `mapa` | 0 | Tabla `oferta_mapa`: una fila por centro y enseñanza, con coordenadas |

Reanudable: si cortas `fetch`, vuelve a lanzarlo y sigue donde lo dejó
(`detalle_ok` marca las fichas ya descargadas). `--refrescar` las vuelve a bajar.

## Esquema

```sql
centros(codigo PK, ccaa, provincia, municipio, localidad, denominacion,
        denominacion_generica, naturaleza, concertado, tipo_centro, domicilio,
        cod_postal, telefono, fax, email, web, lat, lng, geo_fuente,
        geo_precision, detalle_ok, actualizado)

oferta(centro_codigo, grado, familia, ensenanza, modalidad)   -- PK compuesta

oferta_mapa(centro_codigo, denominacion, municipio, localidad, provincia,
            naturaleza, tipo_centro, domicilio, cod_postal, grado, familia,
            ensenanza, modalidad, lat, lng, geo_precision, geo_fuente)
```

`oferta_mapa` es una **tabla**, no una vista, porque Datasette no ofrece facetas
sobre vistas.

## Verlo en local con Datasette

```bash
uv run todofp lite
uv run datasette data/todofp.sqlite --metadata datasette/metadata.yml --port 8001
# http://127.0.0.1:8001/todofp/oferta_mapa?_facet=provincia&_facet=grado&_facet=ensenanza
```

`datasette-cluster-map` detecta `lat`/`lng` y pinta un mapa con clusters; las
facetas de provincia, grado y enseñanza filtran también el mapa.

## Publicarlo: gist + Datasette Lite

```bash
uv run todofp lite                      # data/todofp.sqlite (~12 MB, sin tabla oferta)
```

`gh gist create` **no acepta binarios**, así que el .sqlite se sube con git (un
gist es un repo git). El helper de credenciales de `gh` se encarga del push:

```bash
# 1) crea el gist con el metadata
URL=$(gh gist create datasette/metadata.yml \
        --desc "Centros de FP: enseñanzas, dirección y coordenadas" | tail -1)

# 2) clona el gist, mete la BD y empuja
git clone "$URL.git" /tmp/gist-todofp
cp data/todofp.sqlite /tmp/gist-todofp/
cd /tmp/gist-todofp && git add -A && git commit -m "Añade la base de datos" && git push
```

La URL `raw` del gist (`https://gist.githubusercontent.com/<usuario>/<id>/raw/todofp.sqlite`)
sirve CORS abierto, que es lo que Datasette Lite necesita. Genera la URL lista
para abrir:

```bash
uv run todofp url "$URL"
```

Queda así (partida en líneas):

```
https://lite.datasette.io/?install=datasette-cluster-map
  &s.plugins.datasette-cluster-map.max_limit=40000
  &s.settings.max_returned_rows=40000
  &url=https://gist.githubusercontent.com/<usuario>/<id>/raw/todofp.sqlite
  &metadata=https://gist.githubusercontent.com/<usuario>/<id>/raw/metadata.yml
  #/todofp/oferta_mapa?_facet=provincia&_facet=grado&_facet=ensenanza
```

Detalles que importan:

- **Sin `?ref=stable`** para que cargue Datasette 1.0 alpha, que es la única que
  entiende los ajustes `?s.*`. Son los que suben el tope de filas: sin ellos
  Datasette corta en 1.000 y el mapa solo pinta una parte (verificado: con los
  ajustes, un `_size=20000` devuelve 20.000 filas). `--estable` genera la
  variante 0.65, sin ajustes.
- El nombre del fichero manda: `todofp.sqlite` → base de datos `todofp` en las URLs.
- Gist secreto (por defecto) vale igual: la URL `raw` funciona para quien la tenga.

## Notas sobre las fuentes

- **Ministerio** (`www.educacion.gob.es/centros`): sin `robots.txt`, pero es un
  servicio público. El script manda `User-Agent` identificable, 4 peticiones
  simultáneas y reintentos con espera. No lo subas de ahí sin motivo.
- **CartoCiudad** devuelve 0,0 en `candidatesJsonp` para todo lo que no sea un
  portal; por eso usamos `findJsonp`, que sí trae centroide de calle y municipio.
  El campo `domicilio` del registro viene con `s/n`, `NO CONSTA` y similares:
  `normaliza_direccion()` los limpia antes de consultar.
- **Andalucía** publica su directorio con `N_LATITUD`/`N_LONGITUD` oficiales
  (curso 2024/2025), así que esos centros no pasan por el geocodificador.

## Pendiente

- Añadir coordenadas oficiales del resto de CCAA (Euskadi, Catalunya, Valencia,
  Madrid, Galicia… publican CSV/Shapefile con geometría).
- Mapear los códigos `ensenanza` del formulario (270) a los enlaces de todofp
  (`ensenanzaFP=121_2101`) para cruzar con la oferta formativa publicada.
- Enriquecer con OSM (`amenity=school`) para validar coordenadas dudosas.
