/* Worker de la web estática: abre la db SQLite con sql.js y responde consultas.
   Protocolo por postMessage: {id, op, args} -> {id, ok, data, ms} o
   {id, ok: false, error}. Toda request recibe respuesta, también si la SQL falla.

   Worker clásico (no module) a propósito: sql.js se publica como script UMD y
   declara `initSqlJs` como global de `var`, así que importScripts() basta para
   tenerlo disponible; en un module worker importScripts no existe y el `var` no
   saldría del ámbito del módulo. Además el worker se instancia con
   new Worker('worker.js') y no necesita ningún import relativo. */

const CDN_SQL = 'https://cdn.jsdelivr.net/npm/sql.js@1.17.0/dist/';

let errorCarga = null;
let promesaSqlJs = null;
let db = null;
let msSql = 0; // tiempo de SQL acumulado por la request en curso

try {
  importScripts(CDN_SQL + 'sql-wasm.js');
} catch (e) {
  // Sin sql.js no hay nada que hacer, pero el worker sigue vivo y responde con
  // error en vez de morir mudo y dejar la UI esperando para siempre.
  errorCarga = e;
}

// initSqlJs() descarga y compila sql-wasm.wasm (locateFile); se hace una vez.
function cargaSqlJs() {
  if (errorCarga) {
    throw new Error('no se pudo cargar sql.js: ' + (errorCarga.message ?? errorCarga));
  }
  promesaSqlJs ??= initSqlJs({ locateFile: fichero => CDN_SQL + fichero });
  return promesaSqlJs;
}

// Ejecuta SQL parametrizada y devuelve las filas como objetos. El tiempo se
// acumula en msSql para informar de lo que cuesta la SQL, no el protocolo.
function sqlFilas(sql, params = []) {
  if (!db) {
    throw new Error('la base de datos no está abierta: falta la op init');
  }
  const inicio = performance.now();
  const consulta = db.prepare(sql, params);
  try {
    const filas = [];
    while (consulta.step()) {
      filas.push(consulta.getAsObject());
    }
    return filas;
  } finally {
    consulta.free();
    msSql += performance.now() - inicio;
  }
}

// WHERE compartido por todas las consultas de la UI (facetas, lista, geojson).
// Cada filtro activo aporta un placeholder: `ensenanza = ?` y una igualdad por
// valor dentro de `IN (?,?)`. Los filtros vacíos o nulos no generan cláusula.
function construyeWhere(filtros = {}) {
  const clausulas = [];
  const params = [];

  if (filtros.ensenanza) {
    clausulas.push('ensenanza = ?');
    params.push(filtros.ensenanza);
  }

  for (const columna of ['grado', 'provincia', 'naturaleza', 'modalidad']) {
    const valores = filtros[columna] ?? [];
    if (valores.length === 0) {
      continue;
    }
    clausulas.push(`${columna} IN (${valores.map(() => '?').join(',')})`);
    params.push(...valores);
  }

  return { sql: clausulas.length > 0 ? ' WHERE ' + clausulas.join(' AND ') : '', params };
}

// ---------------------------------------------------------------- operaciones

// Abre la db (el .sqlite ya descomprimido, transferido como ArrayBuffer) y
// devuelve los conteos de las dos vistas que consume la web.
async function opInit(bytes) {
  const SQL = await cargaSqlJs();
  db = new SQL.Database(new Uint8Array(bytes));
  const [centros] = sqlFilas('SELECT COUNT(*) AS n FROM mapa');
  const [oferta] = sqlFilas('SELECT COUNT(*) AS n FROM oferta_mapa');
  return { centros: centros.n, oferta: oferta.n };
}

// Columnas con faceta en el sidebar. Son literales del módulo, no entrada del
// usuario: se interpolan en la SQL sin placeholder (los valores sí van por ?).
const COLUMNAS_FACETA = ['grado', 'familia', 'provincia', 'naturaleza', 'modalidad'];

// La UI no pinta más de un puñado de valores por faceta; 200 es el tope que
// evita que una columna con cientos de valores hinche la respuesta sin que
// nadie llegue a verlos.
const LIMITE_FACETA = 200;

const COLUMNAS_LISTA = [
  'centro_codigo',
  'denominacion',
  'municipio',
  'localidad',
  'provincia',
  'naturaleza',
  'tipo_centro',
  'domicilio',
  'cod_postal',
  'grado',
  'familia',
  'ensenanza',
  'modalidad',
  'lat',
  'lng',
  'geo_precision',
];

// Conteo de una columna para el sidebar: se ignoran los filtros de la propia
// columna (si no, el GROUP BY solo devolvería el valor ya marcado) y se
// aplican los demás. Los valores vacíos no son una opción de filtro.
function faceta(filtros, columna) {
  const resto = { ...filtros };
  delete resto[columna];
  const { sql, params } = construyeWhere(resto);
  const sinVacios = sql ? `${sql} AND ${columna} <> ''` : ` WHERE ${columna} <> ''`;
  return sqlFilas(
    `SELECT ${columna} AS valor, COUNT(*) AS n FROM oferta_mapa${sinVacios}
     GROUP BY ${columna} ORDER BY n DESC, ${columna} LIMIT ${LIMITE_FACETA}`,
    params,
  ).map(fila => [fila.valor, fila.n]);
}

// Conteos por columna para las cinco facetas: una SQL por columna, todas con
// los mismos filtros salvo el de la columna que se cuenta.
function opFacetas(filtros) {
  const facetas = {};
  for (const columna of COLUMNAS_FACETA) {
    facetas[columna] = faceta(filtros, columna);
  }
  return facetas;
}

// Filas del panel lateral, una por centro×titulación. Sin límite: con 35k
// filas el coste de serializar es asumible y recortar rompería los conteos.
function opLista(filtros) {
  const { sql, params } = construyeWhere(filtros);
  return sqlFilas(
    `SELECT ${COLUMNAS_LISTA.join(', ')} FROM oferta_mapa${sql}
     ORDER BY provincia, municipio, denominacion`,
    params,
  );
}

// Puntos del mapa. Una feature por centro×titulación, igual que la lista: el
// mapa no agrega por centro, así que un centro con siete titulaciones aporta
// siete features con la misma coordenada.
//
// `oferta_mapa` ya filtra `c.lat IS NOT NULL`, de modo que aquí no hay nada que
// descartar. Las coordenadas van en orden [lng, lat], que es el de GeoJSON y el
// inverso del de las columnas de la vista: es donde se cuela el bug.
function opGeojson(filtros) {
  const { sql, params } = construyeWhere(filtros);
  const filas = sqlFilas(
    `SELECT centro_codigo, denominacion, municipio, provincia, ensenanza, naturaleza,
            lat, lng
       FROM oferta_mapa${sql}`,
    params,
  );
  return {
    type: 'FeatureCollection',
    features: filas.map(fila => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [fila.lng, fila.lat] },
      properties: {
        codigo: fila.centro_codigo,
        denominacion: fila.denominacion,
        municipio: fila.municipio,
        provincia: fila.provincia,
        ensenanza: fila.ensenanza,
        naturaleza: fila.naturaleza,
      },
    })),
  };
}

// Columnas de la ficha: las mismas que expone la vista `mapa` menos
// n_ensenanzas, que aquí se calcula con la misma expresión que la vista.
const COLUMNAS_FICHA = [
  'codigo',
  'denominacion',
  'municipio',
  'provincia',
  'naturaleza',
  'tipo_centro',
  'domicilio',
  'cod_postal',
  'lat',
  'lng',
  'geo_precision',
];

// Ficha de un centro: sus datos y todas sus titulaciones de FP.
//
// Las dos consultas van a las tablas, no a las vistas: `mapa` y `oferta_mapa`
// empiezan por `lat IS NOT NULL`, así que un centro sin ubicar saldría con la
// ficha vacía de ofertas. La ficha es justo el sitio donde mirar un centro que
// no se ha podido geocodificar, así que el filtro que se replica es el otro,
// `es_fp = 1` (que es lo único que añade la vista aparte de la coordenada).
function opFicha(codigo) {
  // El código es TEXT en la db: si viajara como número, SQLite no encontraría
  // la fila (compara tipos, no convierte).
  const clave = String(codigo);
  const [centro] = sqlFilas(
    `SELECT ${COLUMNAS_FICHA.join(', ')},
            (SELECT count(*) FROM oferta o
              WHERE o.centro_codigo = c.codigo AND o.es_fp = 1) AS n_ensenanzas
       FROM centros c
      WHERE c.codigo = ?`,
    [clave],
  );
  if (!centro) {
    throw new Error(`no hay ningún centro con código ${clave}`);
  }
  const ofertas = sqlFilas(
    `SELECT grado, ensenanza, modalidad
       FROM oferta
      WHERE centro_codigo = ? AND es_fp = 1
      ORDER BY grado, ensenanza`,
    [clave],
  );
  return { centro, ofertas };
}

// La lista de titulaciones es un datalist de sugerencias, no un catálogo: con
// veinte coincidencias se elige en un par de teclas.
const LIMITE_TITULACIONES = 20;

// Titulaciones cuyo nombre contiene `q`, para el autocompletado del filtro.
// Sale de oferta_mapa (la misma fuente que la faceta ensenanza) para que no se
// sugiera una titulación que luego no devuelva ninguna fila. Un q vacío no es
// una consulta: devuelve lista vacía en vez de las veinte primeras, y así el
// datalist no se despliega al enfocar el campo.
function opTitulaciones(q) {
  const patron = (q ?? '').trim();
  if (patron === '') {
    return [];
  }
  return sqlFilas(
    `SELECT DISTINCT ensenanza FROM oferta_mapa WHERE ensenanza LIKE ?
     ORDER BY ensenanza LIMIT ${LIMITE_TITULACIONES}`,
    [`%${patron}%`],
  ).map(fila => fila.ensenanza);
}

const ops = {
  init: opInit,
  facetas: opFacetas,
  lista: opLista,
  geojson: opGeojson,
  ficha: opFicha,
  titulaciones: opTitulaciones,
};

// ---------------------------------------------------------------- despacho

self.onmessage = async ({ data: peticion }) => {
  const { id, op, args } = peticion;
  msSql = 0;

  const manejador = ops[op];
  if (!manejador) {
    self.postMessage({ id, ok: false, error: `op desconocida: ${op}` });
    return;
  }

  try {
    const datos = await manejador(args);
    self.postMessage({ id, ok: true, data: datos, ms: Number(msSql.toFixed(1)) });
  } catch (e) {
    self.postMessage({ id, ok: false, error: e?.message ?? String(e) });
  }
};
