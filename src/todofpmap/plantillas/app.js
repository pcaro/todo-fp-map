/* Arranque de la web estática de centros de FP: descarga la db, la descomprime,
   la abre en el worker, y a partir de ahí mantiene el estado de filtros y pinta
   facetas y lista. Sin framework y sin build step.

   — contrato — lo que consumen el resto de piezas de esta carpeta:
     · estado          estado central: {filtros, facetas, filas, ficha, datos}
     · consulta(op, args)  →  Promise<data>   habla el protocolo de worker.js
     · aplicaFiltros() recalcula facetas + lista con estado.filtros y repinta
     · abreFicha(codigo)  carga la ficha de un centro en el panel derecho

   Todo vive en este módulo, que es el único entry point de la página; el mapa
   y la ficha leen de aquí en vez de duplicar estado. */

const DB = 'centros.sqlite.gz';

// Columnas con faceta en el sidebar. Son las mismas que devuelve la op
// `facetas` del worker, y las claves de array de `estado.filtros`.
const FACETAS = ['grado', 'familia', 'provincia', 'naturaleza', 'modalidad'];

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
  ficha: null, // última respuesta de la op ficha ({centro, ofertas})
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
const elFormulario = document.querySelector('.buscador');
const elBuscador = document.querySelector('#buscador');
const elSugerencias = document.querySelector('#sugerencias');
const elFicha = document.querySelector('#ficha');

// Copia del panel de ficha tal y como lo deja el shell: cerrar una ficha es
// volver a este estado, no inventarse un texto que ya vive en index.html.
const fichaVacia = elFicha.cloneNode(true);

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
  renderTitulacionActiva();
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

// ------------------------------------------------------------------ typeahead

// El formulario existe para que el buscador sea un search de verdad; Enter lo
// enviaría recargando la página con ?q=, que es justo lo que no queremos.
elFormulario.addEventListener('submit', evento => evento.preventDefault());

// 150 ms es lo que tarda una persona en encadenar teclas sin que la primera
// consulta salga con media palabra.
const ESPERA_BUSCADOR = 150;
let temporizadorBuscador = 0;
let turnoTitulaciones = 0;
let sugerencias = [];
let sugerenciaActiva = -1;

elBuscador.addEventListener('input', () => {
  clearTimeout(temporizadorBuscador);
  temporizadorBuscador = setTimeout(buscaTitulaciones, ESPERA_BUSCADOR);
});

async function buscaTitulaciones() {
  const q = elBuscador.value.trim();
  const mio = ++turnoTitulaciones;
  if (q === '') {
    cierraSugerencias();
    return;
  }
  try {
    const titulaciones = await consulta('titulaciones', q);
    if (mio === turnoTitulaciones) {
      pintaSugerencias(titulaciones, `Sin titulaciones para «${q}».`);
    }
  } catch (error) {
    if (mio === turnoTitulaciones) {
      console.error(error);
      pintaSugerencias([], 'No se pudieron buscar titulaciones.');
    }
  }
}

/* Pinta el dropdown. Sin resultados no se queda mudo: enseña el estado vacío
   explícito. Reemplaza los hijos enteros, así que no hay sugerencias viejas
   conviviendo con las nuevas. */
function pintaSugerencias(titulaciones, textoVacio) {
  sugerencias = titulaciones;
  sugerenciaActiva = -1;
  elSugerencias.replaceChildren(
    ...(titulaciones.length === 0
      ? [vacio(textoVacio, 'buscador__vacio')]
      : titulaciones.map((titulacion, indice) => opcionSugerida(titulacion, indice))),
  );
  elSugerencias.hidden = false;
  elBuscador.setAttribute('aria-expanded', 'true');
  elBuscador.removeAttribute('aria-activedescendant');
}

function opcionSugerida(titulacion, indice) {
  const li = document.createElement('li');
  li.id = `sugerencia-${indice}`;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', 'false');
  li.dataset.valor = titulacion;
  li.textContent = titulacion;
  return li;
}

elBuscador.addEventListener('keydown', evento => {
  if (evento.key === 'Escape') {
    cierraSugerencias();
    return;
  }
  if (elSugerencias.hidden || sugerencias.length === 0) {
    return;
  }
  if (evento.key === 'ArrowDown' || evento.key === 'ArrowUp') {
    evento.preventDefault();
    mueveSugerencia(evento.key === 'ArrowDown' ? 1 : -1);
  } else if (evento.key === 'Enter' && sugerenciaActiva !== -1) {
    evento.preventDefault();
    eligeTitulacion(sugerencias[sugerenciaActiva]);
  }
});

// Flechas: la opción activa va en bucle y se deja a la vista.
function mueveSugerencia(paso) {
  const total = sugerencias.length;
  sugerenciaActiva = (sugerenciaActiva + paso + total) % total;
  for (const [indice, opcion] of [...elSugerencias.children].entries()) {
    opcion.setAttribute('aria-selected', String(indice === sugerenciaActiva));
  }
  const activa = elSugerencias.children[sugerenciaActiva];
  elBuscador.setAttribute('aria-activedescendant', activa.id);
  activa.scrollIntoView({ block: 'nearest' });
}

// mousedown con preventDefault: así el click llega antes de que el blur del
// input cierre el dropdown y se coma la elección.
elSugerencias.addEventListener('mousedown', evento => evento.preventDefault());
elSugerencias.addEventListener('click', evento => {
  const opcion = evento.target.closest('[role="option"]');
  if (opcion) {
    eligeTitulacion(opcion.dataset.valor);
  }
});
elBuscador.addEventListener('blur', cierraSugerencias);

function cierraSugerencias() {
  clearTimeout(temporizadorBuscador);
  turnoTitulaciones++;
  sugerencias = [];
  sugerenciaActiva = -1;
  elSugerencias.hidden = true;
  elSugerencias.replaceChildren();
  elBuscador.setAttribute('aria-expanded', 'false');
  elBuscador.removeAttribute('aria-activedescendant');
}

function eligeTitulacion(valor) {
  estado.filtros.ensenanza = valor;
  elBuscador.value = valor;
  cierraSugerencias();
  aplicaFiltros();
}

/* Chip de la titulación activa en la cabecera. Se pinta desde
   estado.filtros.ensenanza en cada aplicaFiltros(), así que la única forma de
   quitarlo es borrar esa clave. */
let chipTitulacion = null;

function renderTitulacionActiva() {
  chipTitulacion?.remove();
  chipTitulacion = null;
  const valor = estado.filtros.ensenanza;
  if (!valor) {
    return;
  }

  chipTitulacion = document.createElement('p');
  chipTitulacion.className = 'cabecera__activa';

  const texto = document.createElement('span');
  texto.className = 'cabecera__activa-texto';
  texto.textContent = valor;

  const quitar = document.createElement('button');
  quitar.type = 'button';
  quitar.className = 'cabecera__quitar';
  quitar.textContent = '✕';
  quitar.title = 'Quitar la titulación';
  quitar.setAttribute('aria-label', `Quitar la titulación ${valor}`);
  quitar.addEventListener('click', () => {
    estado.filtros.ensenanza = null;
    elBuscador.value = '';
    aplicaFiltros();
  });

  chipTitulacion.append(texto, quitar);
  elFormulario.after(chipTitulacion);
}

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

/* Panel de resultados: una fila por centro, agrupadas por municipio. La op
   `lista` devuelve centro×titulación y sin filtro de titulación el mismo centro
   se repetiría decenas de veces; las filas de un centro se funden en una y el
   total de titulaciones sigue visible en la cabecera. */
function renderLista(filas) {
  estado.filas = filas;
  if (filas.length === 0) {
    elCuenta.textContent = 'Sin resultados';
    elResultados.replaceChildren(vacio('Ningún centro con estos filtros.', 'lista__vacio'));
    return;
  }
  const centros = agrupaCentros(filas);
  elCuenta.textContent =
    `${miles.format(centros.length)} centros · ${miles.format(filas.length)} titulaciones`;
  elResultados.scrollTop = 0;
  elResultados.replaceChildren(...itemsDeLista(centros));
}

// Un Map por código de centro conserva el orden de llegada del worker aunque
// dos centros compartan municipio y denominación (el ORDER BY no desempata por
// código, así que sus filas podrían intercalarse).
function agrupaCentros(filas) {
  const centros = new Map();
  for (const fila of filas) {
    let centro = centros.get(fila.centro_codigo);
    if (!centro) {
      centro = { datos: fila, ensenanzas: [] };
      centros.set(fila.centro_codigo, centro);
    }
    if (!centro.ensenanzas.includes(fila.ensenanza)) {
      centro.ensenanzas.push(fila.ensenanza);
    }
  }
  return [...centros.values()];
}

/* Cabecera de municipio + una fila por centro. La lista llega ordenada por
   provincia y municipio, así que basta comparar con el grupo anterior para
   insertar el separador. */
function itemsDeLista(centros) {
  const items = [];
  let grupo = null;
  for (const centro of centros) {
    const { municipio, provincia } = centro.datos;
    const clave = `${municipio}\u0000${provincia}`;
    if (clave !== grupo) {
      grupo = clave;
      const cabecera = document.createElement('li');
      cabecera.className = 'lista__grupo';
      cabecera.textContent = `${municipio} (${provincia})`;
      items.push(cabecera);
    }
    items.push(itemDeCentro(centro));
  }
  return items;
}

function itemDeCentro({ datos, ensenanzas }) {
  const boton = document.createElement('button');
  boton.type = 'button';
  boton.className = 'lista__fila';
  boton.dataset.codigo = datos.centro_codigo;

  const nombre = document.createElement('span');
  nombre.className = 'lista__denominacion';
  nombre.textContent = datos.denominacion;

  const meta = document.createElement('span');
  meta.className = 'lista__meta';
  meta.textContent =
    estado.filtros.ensenanza ??
    (ensenanzas.length === 1 ? ensenanzas[0] : `${ensenanzas.length} titulaciones`);

  boton.append(nombre, meta);

  // Defensa: `oferta_mapa` filtra lat IS NOT NULL, pero si algún día vuelven
  // centros sin geocodificar, la fila se marca en vez de romperse.
  if (datos.lat == null || datos.lng == null) {
    const sinUbicar = document.createElement('span');
    sinUbicar.className = 'lista__sin-ubicar';
    sinUbicar.textContent = 'sin ubicar';
    boton.append(sinUbicar);
  }

  const li = document.createElement('li');
  li.className = 'lista__item';
  li.append(boton);
  return li;
}

// Delegación en el contenedor: sobrevive a los repintados de la lista.
elResultados.addEventListener('click', evento => {
  const fila = evento.target.closest('button[data-codigo]');
  if (fila) {
    abreFicha(fila.dataset.codigo);
  }
});

// ------------------------------------------------------------------ ficha

// Cada apertura invalida la anterior: dos clics seguidos no pueden dejar en el
// panel la ficha de un centro con el botón de otro.
let turnoFicha = 0;

/* Carga la ficha de un centro y la pinta en el panel. Este es también el punto
   de entrada que usará el mapa al pinchar un punto. */
async function abreFicha(codigo) {
  const mio = ++turnoFicha;
  marcaFila(codigo);
  try {
    const ficha = await consulta('ficha', codigo);
    if (mio === turnoFicha) {
      estado.ficha = ficha;
      renderFicha(ficha);
    }
  } catch (error) {
    if (mio === turnoFicha) {
      console.error(error);
      elFicha.replaceChildren(cabeceraFicha('Ficha del centro'), avisoFicha(error.message));
    }
  }
}

function marcaFila(codigo) {
  for (const boton of elResultados.querySelectorAll('button[data-codigo]')) {
    if (boton.dataset.codigo === codigo) {
      boton.setAttribute('aria-current', 'true');
    } else {
      boton.removeAttribute('aria-current');
    }
  }
}

/* Toda la ficha se construye con nodos y textContent: denominaciones,
   domicilios y webs vienen del scraper y aquí no se interpreta HTML ajeno. */
function renderFicha({ centro, ofertas }) {
  const datos = document.createElement('dl');
  datos.className = 'ficha__datos';
  datos.append(...datosDeCentro(centro));

  const subtitulo = document.createElement('h3');
  subtitulo.className = 'ficha__subtitulo';
  subtitulo.textContent = `Enseñanzas (${miles.format(ofertas.length)})`;

  const grados = new Map();
  for (const oferta of ofertas) {
    if (!grados.has(oferta.grado)) {
      grados.set(oferta.grado, []);
    }
    grados.get(oferta.grado).push(oferta);
  }

  const contenido = [cabeceraFicha(centro.denominacion), datos, subtitulo];
  for (const [grado, ensenanzas] of grados) {
    const titulo = document.createElement('h4');
    titulo.className = 'ficha__grado';
    titulo.textContent = grado || 'Sin grado';

    const lista = document.createElement('ul');
    lista.className = 'ficha__ensenanzas';
    for (const oferta of ensenanzas) {
      const li = document.createElement('li');
      li.textContent = oferta.ensenanza;
      if (oferta.modalidad) {
        const modalidad = document.createElement('span');
        modalidad.className = 'ficha__modalidad';
        modalidad.textContent = oferta.modalidad;
        li.append(modalidad);
      }
      lista.append(li);
    }
    contenido.push(titulo, lista);
  }

  elFicha.replaceChildren(...contenido);
  elFicha.scrollTop = 0;
}

function cabeceraFicha(texto) {
  const cabecera = document.createElement('header');
  cabecera.className = 'ficha__cabecera';

  const titulo = document.createElement('h2');
  titulo.id = 'ficha-titulo';
  titulo.className = 'ficha__titulo';
  titulo.textContent = texto;

  const cerrar = document.createElement('button');
  cerrar.type = 'button';
  cerrar.className = 'ficha__cerrar';
  cerrar.textContent = '✕';
  cerrar.title = 'Cerrar la ficha';
  cerrar.setAttribute('aria-label', 'Cerrar la ficha');
  cerrar.addEventListener('click', cierraFicha);

  cabecera.append(titulo, cerrar);
  return cabecera;
}

// Pares <dt>/<dd>; las filas sin dato no se pintan.
function datosDeCentro(centro) {
  const pares = [];
  const par = (etiqueta, valor) => {
    if (!valor) {
      return;
    }
    const dt = document.createElement('dt');
    dt.textContent = etiqueta;
    const dd = document.createElement('dd');
    dd.append(valor);
    pares.push(dt, dd);
  };

  const concertado = centro.concertado === 'Sí' && centro.naturaleza !== 'Centro concertado';
  const naturaleza = [centro.naturaleza, concertado && 'Concertado'].filter(Boolean).join(' · ');
  par('Naturaleza', naturaleza);

  const tipo = centro.denominacion_generica || centro.tipo_centro;
  par('Tipo', tipo);

  const localidad = [centro.cod_postal, centro.municipio].filter(Boolean).join(' ');
  const direccion = [
    centro.domicilio,
    `${localidad}${centro.provincia ? ` (${centro.provincia})` : ''}`.trim(),
  ]
    .filter(Boolean)
    .join(', ');
  par('Dirección', direccion);

  // El campo de teléfono del scraper trae a veces dos números («A/B»): cada
  // uno va a su propio enlace tel: en vez de concatenarlos en uno falso.
  const telefonos = (centro.telefono ?? '')
    .split(/[/;]/)
    .map(telefono => telefono.trim())
    .filter(Boolean)
    .map(telefono => {
      const enlace = document.createElement('a');
      enlace.href = `tel:${telefono.replace(/[^+\d]/g, '')}`;
      enlace.textContent = telefono;
      return enlace;
    });
  if (telefonos.length > 0) {
    const dd = document.createElement('dd');
    telefonos.forEach((enlace, indice) => {
      if (indice > 0) {
        dd.append(' · ');
      }
      dd.append(enlace);
    });
    const dt = document.createElement('dt');
    dt.textContent = 'Teléfono';
    pares.push(dt, dd);
  }

  const web = urlWeb(centro.web);
  if (web) {
    const enlace = document.createElement('a');
    enlace.href = web;
    enlace.textContent = centro.web;
    enlace.target = '_blank';
    enlace.rel = 'noopener';
    par('Web', enlace);
  }

  return pares;
}

// Las webs del scraper vienen sin esquema y no son de fiar: solo se enlaza
// http(s), que descarta un javascript: colado en el dato.
function urlWeb(web) {
  const limpia = (web ?? '').trim();
  if (limpia === '') {
    return null;
  }
  try {
    const url = new URL(/^https?:\/\//i.test(limpia) ? limpia : `https://${limpia}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function avisoFicha(mensaje) {
  const aviso = document.createElement('p');
  aviso.className = 'ficha__aviso';
  aviso.textContent = mensaje;
  return aviso;
}

function cierraFicha() {
  turnoFicha++;
  estado.ficha = null;
  elFicha.replaceChildren(...[...fichaVacia.cloneNode(true).childNodes]);
  marcaFila(null);
}

// ------------------------------------------------------------------ exports

export { estado, consulta, aplicaFiltros, abreFicha };

arranca();
