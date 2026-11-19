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

const ops = {
  init: opInit,
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
