/* Arranque de la web estática de centros de FP: descarga la db, la descomprime,
   la abre en el worker, y a partir de ahí mantiene el estado de filtros y pinta
   facetas y lista. Sin framework y sin build step.

   — contrato — lo que consumen el resto de piezas de esta carpeta:
     · estado          estado central: {filtros, facetas, filas, datos}
     · consulta(op, args)  →  Promise<data>   habla el protocolo de worker.js
     · aplicaFiltros() recalcula facetas + lista con estado.filtros y repinta

   Todo vive en este módulo, que es el único entry point de la página; el mapa
   y la ficha leen de aquí en vez de duplicar estado. */

const DB = 'centros.sqlite.gz';

// Columnas con faceta en el sidebar. Son las mismas que devuelve la op
// `facetas` del worker, y las claves de array de `estado.filtros`.
const FACETAS = ['grado', 'familia', 'provincia', 'naturaleza', 'modalidad'];

// Esqueleto del panel de resultados: T7 sustituye este render por las filas con
// ficha. Se pintan solo las primeras para no meter 35k nodos en el DOM.
const FILAS_PINTADAS = 40;

// ------------------------------------------------------------------ estado

// Estado central. `filtros` es la única fuente de verdad de la UI: los
// checkboxes se pintan a partir de él y nunca al revés. `ensenanza` es escalar
// (una titulación activa o ninguna); lo demás son listas de valores activos.
const estado = {
  filtros: {
    ensenanza: null,
    grado: [],
    familia: [],
    provincia: [],
    naturaleza: [],
    modalidad: [],
  },
  datos: null, // {centros, oferta} de la op init
  facetas: {}, // última respuesta de la op facetas
  filas: [], // última respuesta de la op lista
};

// Miles al estilo español. `useGrouping: 'always'` no es decoración: por defecto
// es-ES no agrupa los números de cuatro cifras (4646), y el resto del proyecto
// (cli.py) los escribe 4.646.
const miles = new Intl.NumberFormat('es-ES', { useGrouping: 'always' });

// Elementos del shell que se actualizan desde aquí.
const elEstadoMapa = document.querySelector('#estado-mapa');
const elCuenta = document.querySelector('#lista-cuenta');
const elResultados = document.querySelector('.lista__resultados');
const elFacetas = document.querySelector('#facetas');
const elFacetasCuerpo = document.querySelector('#facetas-cuerpo');

// ------------------------------------------------------------------ worker

const worker = new Worker('worker.js');

// Peticiones en vuelo: id → {resolve, reject, temporizador}. El worker responde
// siempre (también los errores de SQL), así que un id pendiente solo puede
// quedarse colgado si el worker muere o no contesta.
const pendientes = new Map();
let siguienteId = 1;

worker.onmessage = ({ data }) => {
  const pendiente = pendientes.get(data.id);
  if (!pendiente) {
    return;
  }
  pendientes.delete(data.id);
  clearTimeout(pendiente.temporizador);
  if (data.ok) {
    pendiente.resolve(data.data);
  } else {
    pendiente.reject(new Error(data.error));
  }
};

// Un worker que no arranca (p. ej. 404 de worker.js) no responde a nada: se
// rechazan las peticiones en vuelo para que la UI no espere para siempre.
worker.onerror = evento => {
  evento.preventDefault();
  falla(new Error(`el worker no arrancó: ${evento.message || 'error de carga'}`));
};

/* Envía una op al worker y devuelve su `data`. Rechaza con el `error` de la
   respuesta. `timeout` (ms) solo hace falta donde una op puede quedarse muda:
   init, que descarga el wasm y abre la db. */
function consulta(op, args, { transferir = [], timeout = 0 } = {}) {
  const id = siguienteId++;
  return new Promise((resolve, reject) => {
    const temporizador =
      timeout > 0
        ? setTimeout(() => {
            pendientes.delete(id);
            reject(new Error(`la op ${op} no respondió en ${timeout / 1000} s`));
          }, timeout)
        : 0;
    pendientes.set(id, { resolve, reject, temporizador });
    worker.postMessage({ id, op, args }, transferir);
  });
}

// ------------------------------------------------------------------ boot

const megas = bytes =>
  `${(bytes / 1_048_576).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`;

// Texto del cartel sobre el mapa, que es donde el shell deja el hueco para
// decir en qué va la carga.
function pintaCarga(texto) {
  elEstadoMapa.textContent = texto;
  elEstadoMapa.hidden = false;
}

/* Descarga centros.sqlite.gz y devuelve la db descomprimida como ArrayBuffer.
   El progreso se cuenta en la rama comprimida de un tee() porque es la única
   que se puede comparar con el content-length; la descompresión corre en
   paralelo por la otra rama. */
async function descargaDb() {
  const respuesta = await fetch(DB);
  if (!respuesta.ok) {
    throw new Error(`no se pudo descargar ${DB} (HTTP ${respuesta.status})`);
  }
  const total = Number(respuesta.headers.get('content-length')) || 0;
  const [comprimido, paraDescomprimir] = respuesta.body.tee();

  const progreso = cuentaDescarga(comprimido, total);
  const gzip = paraDescomprimir.pipeThrough(new DecompressionStream('gzip'));
  let bytes;
  try {
    bytes = await new Response(gzip).arrayBuffer();
    await progreso;
  } catch {
    // Chrome resume el fallo del flujo como "Failed to fetch", que no dice nada
    // útil: el caso real es un despliegue con el .gz corrupto o a medias.
    throw new Error(`${DB} no se pudo descomprimir (¿fichero gzip corrupto o truncado?)`);
  }
  return bytes;
}

async function cuentaDescarga(flujo, total) {
  let leidos = 0;
  try {
    for await (const trozo of flujo) {
      leidos += trozo.byteLength;
      pintaCarga(
        total > 0
          ? `Descargando base de datos… ${megas(leidos)} de ${megas(total)}`
          : `Descargando base de datos… ${megas(leidos)}`,
      );
    }
  } catch {
    // Si la descarga se rompe, el error real lo lanza la otra rama del tee.
  }
}

async function arranca() {
  try {
    pintaCarga('Descargando base de datos…');
    const bytes = await descargaDb();

    pintaCarga('Abriendo base de datos…');
    // init es la única op con timeout: el worker descarga y compila el wasm de
    // sql.js antes de poder abrir la db.
    estado.datos = await consulta('init', bytes, { transferir: [bytes], timeout: 30_000 });

    const { centros, oferta } = estado.datos;
    pintaCarga(`${miles.format(centros)} centros · ${miles.format(oferta)} titulaciones`);

    await aplicaFiltros();
  } catch (error) {
    falla(error);
  }
}

/* Deja la página en un estado honesto cuando no hay datos: la causa se lee en
   el cartel del mapa y en el panel de resultados, no solo en la consola. */
let roto = false;

function falla(error) {
  if (roto) {
    return;
  }
  roto = true;
  const causa = error?.message ?? String(error);
  console.error(error);

  for (const pendiente of pendientes.values()) {
    clearTimeout(pendiente.temporizador);
    pendiente.reject(new Error(`petición cancelada: ${causa}`));
  }
  pendientes.clear();

  elEstadoMapa.classList.add('mapa__estado--error');
  pintaCarga(`No se pudo cargar la base de datos: ${causa}`);
  elCuenta.textContent = 'Sin datos';
  elResultados.replaceChildren(vacio('No se pudo cargar la base de datos.', 'lista__vacio'));
  for (const lista of elFacetasCuerpo.querySelectorAll('.faceta__opciones')) {
    lista.replaceChildren(vacio('Sin datos'));
  }
}

// ------------------------------------------------------------------ filtros

// Descarta respuestas de un repintado anterior: dos clics seguidos lanzan dos
// pares facetas+lista y solo el último puede pintar.
let turno = 0;

/* Recalcula facetas y lista con los filtros vigentes. Las dos consultas van en
   paralelo (son independientes) y el repintado es todo o nada: los conteos del
   sidebar y las filas siempre corresponden al mismo estado. */
async function aplicaFiltros() {
  const mio = ++turno;
  elCuenta.textContent = 'Filtrando…';
  try {
    const [facetas, filas] = await Promise.all([
      consulta('facetas', estado.filtros),
      consulta('lista', estado.filtros),
    ]);
    if (mio !== turno) {
      return;
    }
    estado.facetas = facetas;
    renderFacetas(facetas);
    renderLista(filas);
    // El cartel sobre el mapa es solo información de carga: con datos ya
    // pintados, los números viven en el sidebar y en #lista-cuenta.
    elEstadoMapa.hidden = true;
  } catch (error) {
    if (mio === turno) {
      falla(error);
    }
  }
}

// Un checkbox cambia un valor de su columna en `estado.filtros` y dispara el
// recálculo. La delegación en el contenedor sobrevive a los repintados.
elFacetasCuerpo.addEventListener('change', evento => {
  const casilla = evento.target;
  if (!(casilla instanceof HTMLInputElement) || !casilla.dataset.faceta) {
    return;
  }
  const columna = casilla.dataset.faceta;
  const activos = estado.filtros[columna];
  const posicion = activos.indexOf(casilla.value);
  if (casilla.checked && posicion === -1) {
    activos.push(casilla.value);
  } else if (!casilla.checked && posicion !== -1) {
    activos.splice(posicion, 1);
  }
  aplicaFiltros();
});

// ------------------------------------------------------------------ render

const vacio = (texto, clase = 'faceta__vacio') => {
  const li = document.createElement('li');
  li.className = clase;
  li.textContent = texto;
  return li;
};

/* Pinta las cinco columnas de facetas. Cada valor es un checkbox con su conteo;
   los activos se marcan a partir de `estado.filtros`, no del DOM anterior. */
function renderFacetas(facetas) {
  const scroll = elFacetas.scrollTop;
  for (const columna of FACETAS) {
    const lista = elFacetasCuerpo.querySelector(`ul[data-faceta="${columna}"]`);
    const valores = facetas[columna] ?? [];
    lista.replaceChildren(
      ...(valores.length === 0
        ? [vacio('Sin valores')]
        : valores.map(([valor, n]) => opcion(columna, valor, n))),
    );
  }
  elFacetas.scrollTop = scroll;
}

function opcion(columna, valor, n) {
  const etiqueta = document.createElement('label');
  etiqueta.className = 'faceta__etiqueta';

  const casilla = document.createElement('input');
  casilla.type = 'checkbox';
  casilla.value = valor;
  casilla.dataset.faceta = columna;
  casilla.checked = estado.filtros[columna].includes(valor);

  const texto = document.createElement('span');
  texto.className = 'faceta__valor';
  texto.textContent = valor;

  const cuenta = document.createElement('span');
  cuenta.className = 'faceta__cuenta';
  cuenta.textContent = miles.format(n);

  etiqueta.append(casilla, texto, cuenta);

  const li = document.createElement('li');
  li.className = 'faceta__opcion';
  li.append(etiqueta);
  return li;
}

/* Esqueleto del panel de resultados: el recuento de la cabecera y unas pocas
   filas en texto plano. T7 lo sustituye por las filas navegables. */
function renderLista(filas) {
  estado.filas = filas;
  if (filas.length === 0) {
    elCuenta.textContent = 'Sin resultados';
    elResultados.replaceChildren(vacio('Ningún centro con estos filtros.', 'lista__vacio'));
    return;
  }
  const centros = new Set(filas.map(fila => fila.centro_codigo)).size;
  elCuenta.textContent =
    `${miles.format(centros)} centros · ${miles.format(filas.length)} titulaciones`;
  elResultados.replaceChildren(
    ...filas.slice(0, FILAS_PINTADAS).map(fila => {
      const li = document.createElement('li');
      li.className = 'lista__fila';
      li.textContent =
        `${fila.denominacion} — ${fila.municipio} (${fila.provincia}) · ${fila.ensenanza}`;
      return li;
    }),
  );
}

// ------------------------------------------------------------------ exports

export { estado, consulta, aplicaFiltros };

arranca();
