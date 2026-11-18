# todo-fp-map

Centros de FP de España en una base SQLite: **qué imparte cada centro**, con
dirección y coordenadas, listo para montar un mapa.

Solo Formación Profesional: ciclos de grado básico, medio y superior (LOE, LOGSE
y LFP) y cursos de especialización. Se descartan ESO, Bachillerato, Primaria,
Infantil, adultos, idiomas, música, danza, artes plásticas y enseñanzas
deportivas. Para tenerlo todo, `--todo`.

<https://github.com/pcaro/todo-fp-map>

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

oferta(centro_codigo, grado, familia, ensenanza, modalidad, es_fp)  -- PK compuesta

oferta_mapa(centro_codigo, denominacion, municipio, localidad, provincia,
            naturaleza, tipo_centro, domicilio, cod_postal, grado, familia,
            ensenanza, modalidad, lat, lng, geo_precision, geo_fuente)
```

`oferta_mapa` es una **tabla**, no una vista, porque Datasette no ofrece facetas
sobre vistas.

`oferta.es_fp` se calcula con `db.es_fp()` a partir del grado, y `mapa` y
`oferta_mapa` se construyen filtrando por ahí: `mapa` incluye solo centros que
imparten al menos una enseñanza de FP, y `n_ensenanzas` cuenta solo esas.
`todofp mapa` regenera ambas (con `--todo`, sin filtro).

## Verlo en local con Datasette

```bash
uv run todofp lite
uv run datasette data/todofp.sqlite --metadata datasette/metadata.yml --port 8001
# http://127.0.0.1:8001/todofp/oferta_mapa?_facet=provincia&_facet=grado&_facet=ensenanza
```

`datasette-cluster-map` detecta `lat`/`lng` y pinta un mapa con clusters; las
facetas de provincia, grado y enseñanza filtran también el mapa.

## Verlo publicado: Datasette Lite

Dos enlaces listos para abrir (no hace falta instalar nada, Datasette corre en el
navegador con Pyodide):

**Mapa de centros** — una fila por centro, el mapa sale arriba del todo:

<https://lite.datasette.io/?install=datasette-maplibre&s.settings.max_returned_rows=40000&s.plugins.datasette-maplibre.container=div.metadata-description&url=https://gist.githubusercontent.com/pcaro/d63731c6da641fb97b9643cfcb977e2b/raw/centros.sqlite&metadata=https://gist.githubusercontent.com/pcaro/d63731c6da641fb97b9643cfcb977e2b/raw/metadata.yml#/centros/mapa?_facet=provincia&_facet_size=8%23map=6.6/37.4/-4.7&color=provincia>

**Centros por enseñanza** — una fila por centro y enseñanza; filtra por
titulación o grado en las facetas y el mapa se actualiza:

<https://lite.datasette.io/?install=datasette-maplibre&s.settings.max_returned_rows=40000&s.plugins.datasette-maplibre.container=div.metadata-description&url=https://gist.githubusercontent.com/pcaro/d63731c6da641fb97b9643cfcb977e2b/raw/centros.sqlite&metadata=https://gist.githubusercontent.com/pcaro/d63731c6da641fb97b9643cfcb977e2b/raw/metadata.yml#/centros/oferta_mapa?_facet=ensenanza&_facet=grado&_facet_size=8%23map=6.6/37.4/-4.7&color=grado>

La URL tiene cinco partes que importan:

| Parámetro | Para qué |
|---|---|
| `install=datasette-maplibre` | plugin que pinta el mapa (MapLibre + OpenFreeMap). Sin esto no hay mapa |
| `s.plugins.datasette-maplibre.container=div.metadata-description` | mueve el mapa de debajo de las facetas a debajo del título |
| `s.settings.max_returned_rows=40000` | sin esto Datasette corta en 1.000 filas y el mapa sale incompleto |
| `url=` / `metadata=` | la BD y el metadata, desde el gist (sirve CORS abierto) |
| `#/centros/mapa?...` | la tabla y las facetas iniciales. `%23map=z/lat/lng` y `&color=provincia` son del plugin |

Los `?s.*` solo funcionan en Datasette 1.0a8+; por eso **no** se pone `?ref=stable`.
`uv run todofp url <gist>` los genera, y con `--estable` da la variante 0.65.

## Publicar una versión nueva

```bash
uv run todofp lite            # data/centros.sqlite (~5 MB Andalucía, ~25 MB España)
uv run todofp build           # o todo el pipeline antes
```

`gh gist create` **no acepta binarios**, así que el .sqlite se sube con git (un
gist es un repo git) usando el helper de credenciales de `gh`:

```bash
URL=$(gh gist create datasette/metadata.yml \
        --desc "Centros de FP: enseñanzas, dirección y coordenadas" | tail -1)
git clone "$URL.git" /tmp/gist
cp data/centros.sqlite datasette/metadata.yml /tmp/gist/
cd /tmp/gist && git add -A && git commit -m "Añade la base de datos" && git push
uv run todofp url "$URL"
```

### Límites de los gists (medidos, no supuestos)

| Límite | Valor | Comprobación |
|---|---|---|
| Tamaño por fichero | **100 MiB**, bloqueado en el push | 105 MiB → `pre-receive hook declined` |
| Aviso al pasar de 50 MiB | warning `GH001`, pero sube | 60 MiB → push OK en 6 s |
| Subida por la web | 25 MiB | documentación de GitHub |
| Ficheros por gist / gists por cuenta | sin límite documentado | — |
| `raw` de un gist | sirve el fichero entero, con `Range` y CORS `*` | 60 MiB descargados, md5 idéntico, 206 parcial |

Ojo: un gist es un repo git y **el histórico cuenta**. Republicar cada día un
fichero de 25 MB acumula objetos; si vas a iterar mucho, crea un gist nuevo por
versión o publica en un repo normal usando Releases.

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
