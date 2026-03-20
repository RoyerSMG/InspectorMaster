/**
 * @file index3.js
 * @description Lógica principal del módulo de Gestión de Puntos por Ruta.
 *              Maneja la importación de archivos Excel, almacenamiento en IndexedDB
 *              (via Dexie), filtros de búsqueda, resumen estadístico y paginación.
 *
 * Patrón: IIFE encapsulado que expone solo las funciones necesarias al HTML.
 * Dependencias externas: Dexie.js, xlsx.full.min.js
 */

const Rutas = (() => {

  // ============================================================
  // ⚙️ CONFIGURACIÓN
  // ============================================================

  /** Número de filas visibles por página en la tabla de resultados. */
  const FILAS_POR_PAGINA = 100;

  /**
   * Configuración de los estados posibles de una parada.
   * Centraliza los criterios de clasificación y los estilos asociados.
   * Para agregar un nuevo estado: solo añadir una entrada aquí.
   */
  const ESTADOS = {
    realizada:   { test: e => e.includes('realizada'),
              chip: 'chip-realizada', 
              fila: 'fila-realizada' },
    cancelado:   { test: e => e.startsWith('cancelado') || e.startsWith('cance') || e.includes('no efect'), 
              chip: 'chip-cancelado', 
              fila: 'fila-cancelado' },
    noEfectivo: { test: e => e.includes('no efectivo') || e.includes('no efect'),
              chip: 'chip-no-efectivo', 
              fila: 'fila-no-efectivo' },
    porRealizar: { test: e => e.includes('por realizar'),
              chip: 'chip-vacio',     
              fila: 'fila-vacio'     },
  };

  /**
   * Mapa de abreviaciones para la normalización de direcciones colombianas.
   * Permite comparar "Calle 5 # 10" con "cll5#10" correctamente.
   */
  const ABREVIACIONES = [
    [/\bcalle\b/g,       'cll'], [/\bcl\b/g,      'cll'],
    [/\bcarrera\b/g,     'cra'], [/\bcrr\b/g,     'cra'],
    [/\bkra\b/g,         'cra'], [/\bkr\b/g,      'cra'],
    [/\bcr\b/g,          'cra'],
    [/\bdiagonal\b/g,    'dg'],  [/\bdiag\b/g,    'dg'],
    [/\btransversal\b/g, 'tv'],  [/\btransv\b/g,  'tv'],
    [/\btr\b/g,          'tv'],
    [/\bavenida\b/g,     'av'],  [/\bave\b/g,     'av'],
    [/\bautopista\b/g,   'aut'],
  ];

  // ============================================================
  // 🗄️ ESTADO INTERNO DEL MÓDULO
  // ============================================================

  /** Instancia de Dexie (IndexedDB). Se inicializa en init(). */
  let db;

  /** Página actualmente visible en la tabla. */
  let paginaActual = 1;

  /** Resultados completos de la última búsqueda (sin paginar). */
  let resultadosGlobales = [];

  // ============================================================
  // 🔧 UTILIDADES
  // ============================================================

  /**
   * Obtiene un elemento del DOM por su ID de forma segura.
   * @param {string} id
   * @returns {HTMLElement|null}
   */
  const getEl = (id) => document.getElementById(id);

  /**
   * Normaliza un texto de dirección colombiana para comparación.
   * Elimina caracteres especiales, convierte abreviaciones y elimina espacios.
   * @param {string} texto - Texto de dirección a normalizar.
   * @returns {string} Texto normalizado en minúsculas y sin espacios.
   */
  const normalizar = (texto) => {
    let t = texto.toLowerCase()
      .replace(/[-#.,°/]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    ABREVIACIONES.forEach(([regex, abrev]) => { t = t.replace(regex, abrev); });

    return t.replace(/\s+/g, '');
  };

  /**
   * Comparador de ordenación por prioridad de estado de parada.
   * Orden resultante: Por realizar (1) → Realizada (2) → Cancelada/No efectiva (3).
   * Úsalo como comparador: resultados.sort(ordenarPorPrioridad)
   * @param {Object} a - Registro A.
   * @param {Object} b - Registro B.
   * @returns {number} Diferencia de pesos para Array.sort().
   */
  const ordenarPorPrioridad = (a, b) => {
    const peso = (f) => {
      const s = (f.estado_parada || '').toLowerCase().trim();
      if (s.startsWith('cancelado') || s.startsWith('cance') || s.includes('no efect')) return 3;
      if (s.includes('realizada')) return 2;
      return 1; // por realizar u otro estado sin clasificar → va primero
    };
    return peso(a) - peso(b);
  };

  /**
   * Clasifica un estado de parada según la configuración en ESTADOS.
   * @param {string} estadoRaw - Texto del estado tal como viene del Excel.
   * @returns {{ key: string, chip: string, fila: string }} Clasificación del estado.
   */
  const clasificarEstado = (estadoRaw) => {
    const estadoLow = (estadoRaw || '').toLowerCase().trim();
    const entrada = Object.entries(ESTADOS).find(([, cfg]) => cfg.test(estadoLow));
    if (entrada) return { key: entrada[0], ...entrada[1] };
    return { key: 'otro', chip: 'chip-pendiente', fila: '' };
  };

  /**
   * Formatea la fecha y hora actual en formato legible para Colombia.
   * @returns {string} Ej: "19 mar 2026, 10:30"
   */
  const formatearFechaActual = () =>
    new Date().toLocaleDateString('es-CO', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

  // ============================================================
  // 📊 BARRA DE PROGRESO
  // ============================================================

  /**
   * Actualiza visualmente la barra de progreso de importación.
   * @param {number} valor - Porcentaje de avance (0–100).
   * @param {string} texto - Mensaje descriptivo del paso actual.
   */
  const setProgress = (valor, texto) => {
    getEl('progressFill').style.width = valor + '%';
    getEl('progressPct').innerText    = valor + '%';
    getEl('progressLabel').innerText  = texto;
  };

  // ============================================================
  // 📥 IMPORTACIÓN DE EXCEL
  // ============================================================

  /**
   * Maneja el evento de selección de un archivo Excel.
   * Lee el archivo, lo parsea con XLSX, limpia la base de datos
   * e inserta los nuevos registros en lotes para no bloquear el hilo principal.
   * @param {Event} e - Evento change del input[type=file].
   */
  const importarExcel = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const status = getEl('statusMsg');
    const wrap   = getEl('progressWrap');

    status.style.display = 'none';
    wrap.classList.add('visible');

    setProgress(5, 'Leyendo archivo...');

    const reader = new FileReader();
    reader.onload = async (event) => {
      setProgress(25, 'Parseando Excel...');
      await delay(30);

      const data     = new Uint8Array(event.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheet    = workbook.Sheets[workbook.SheetNames[0]];
      const filas    = XLSX.utils.sheet_to_json(sheet);

      setProgress(50, 'Limpiando base de datos...');
      await delay(30);

      try {
        await db.puntos.clear();
        await insertarEnLotes(filas);

        setProgress(100, '¡Carga completada!');
        await delay(600);

        wrap.classList.remove('visible');
        status.style.display  = '';
        status.innerText      = `✅ ¡Éxito! ${filas.length.toLocaleString()} filas cargadas correctamente.`;
        status.className      = 'status-bar success';

        mostrarInfoArchivo(file.name);
        await ejecutarBusqueda();

      } catch (err) {
        console.error(err);
        wrap.classList.remove('visible');
        status.style.display = '';
        status.innerText     = '❌ Error al guardar en la base de datos.';
        status.className     = 'status-bar';
      }
    };

    reader.readAsArrayBuffer(file);
  };

  /**
   * Inserta un array de filas en la base de datos en lotes de 1000
   * para evitar bloquear el hilo principal en archivos grandes.
   * @param {Object[]} filas - Array de objetos parsed del Excel.
   */
  const insertarEnLotes = async (filas) => {
    const LOTE  = 1000;
    const total = filas.length;

    for (let i = 0; i < total; i += LOTE) {
      const lote  = filas.slice(i, i + LOTE);
      await db.puntos.bulkAdd(lote);

      const avance = 50 + Math.round(((i + lote.length) / total) * 50);
      setProgress(avance, `Guardando filas ${(i + lote.length).toLocaleString()} de ${total.toLocaleString()}...`);
      await delay(10);
    }
  };

  /**
   * Muestra el panel de info del archivo con nombre y fecha de carga.
   * @param {string} nombre - Nombre del archivo importado.
   */
  const mostrarInfoArchivo = (nombre) => {
    getEl('fileName').innerText = nombre;
    getEl('fileDate').innerText = formatearFechaActual();
    getEl('fileInfo').classList.add('visible');
  };

  /**
   * Pequeña utilidad para crear pausas asíncronas sin bloquear el hilo.
   * Permite que el navegador actualice la UI entre lotes pesados.
   * @param {number} ms - Milisegundos a esperar.
   * @returns {Promise<void>}
   */
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  // ============================================================
  // 🔍 BÚSQUEDA Y FILTROS
  // ============================================================

  /**
   * Ejecuta la búsqueda de puntos según los filtros activos.
   * Aplica filtro de ruta via índice Dexie, y los demás con normalización
   * de texto para manejar variantes de escritura de direcciones.
   */
  const ejecutarBusqueda = async () => {
    const rutaVal  = getEl('filtroRuta').value.trim();
    const dirVal   = getEl('filtroDir').value.toLowerCase().trim();
    const aliasVal = getEl('filtroAlias').value.toLowerCase().trim();
    const tbody    = getEl('tablaTbody');

    // Validar longitud mínima antes de buscar por texto
    const textoCorto = (v) => v && v.length < 3;
    if (!rutaVal && (textoCorto(dirVal) || textoCorto(aliasVal)) && (dirVal || aliasVal)) {
      getEl('contador').innerHTML = '<span style="font-size:0.82rem;color:var(--muted)">Escribe al menos 3 letras para buscar.</span>';
      tbody.innerHTML = '';
      return;
    }

    // Consulta base: por ruta (usa índice) o todos
    let resultados = rutaVal
      ? await db.puntos.filter(f => f.ruta?.toString().trim().toLowerCase() === rutaVal.toLowerCase()).toArray()
      : await db.puntos.toArray();

    // Filtro por dirección o ciudad
    if (dirVal) {
      const dirNorm = normalizar(dirVal);
      resultados = resultados.filter(f =>
        normalizar(f.direccion || '').includes(dirNorm) ||
        normalizar(f.ciudad    || '').includes(dirNorm)
      );
    }

    // Filtro por alias
    if (aliasVal) {
      const aliasNorm = normalizar(aliasVal);
      resultados = resultados.filter(f =>
        normalizar(f.alias_punto || '').includes(aliasNorm)
      );
    }

    resultados.sort(ordenarPorPrioridad);
    resultadosGlobales = resultados;
    paginaActual = 1;

    const count = resultados.length;
    getEl('contador').innerHTML = count > 0
      ? `<span class="contador-badge">🔍 ${count.toLocaleString()} registros</span>`
      : `<span style="font-size:0.82rem;color:var(--muted)">Sin resultados</span>`;

    if (count === 0) {
      tbody.innerHTML = `
        <tr><td colspan="7">
          <div class="empty-state">
            <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <p>No se encontraron registros con los filtros actuales.</p>
          </div>
        </td></tr>`;
      getEl('paginacion').innerHTML = '';
      actualizarResumen([]);
      return;
    }

    actualizarResumen(resultados);
    renderPagina(1);
  };

  // ============================================================
  // 📈 RESUMEN ESTADÍSTICO
  // ============================================================

  /**
   * Calcula y muestra las estadísticas de estados en las summary cards.
   * Usa la configuración centralizada de ESTADOS para los conteos.
   * @param {Object[]} resultados - Array de puntos filtrados.
   */
  const actualizarResumen = (resultados) => {
    const total = resultados.length;

    const contarEstado = (key) =>
      resultados.filter(f => clasificarEstado(f.estado_parada).key === key).length;

    const realizadas  = contarEstado('realizada');
    const canceladas  = contarEstado('cancelado');
    const porRealizar = contarEstado('porRealizar');

    getEl('scTotal').innerText      = total.toLocaleString();
    getEl('scRealizadas').innerText = realizadas.toLocaleString();
    getEl('scCanceladas').innerText = canceladas.toLocaleString();
    getEl('scPorRealizar').innerText = porRealizar.toLocaleString();

    const pct = (v) => total > 0 ? Math.round((v / total) * 100) + '%' : '0%';
    getEl('scBarRealizadas').style.width  = pct(realizadas);
    getEl('scBarCanceladas').style.width  = pct(canceladas);
    getEl('scBarPorRealizar').style.width = pct(porRealizar); // ✅ Bug corregido: usaba scPorRealizar en lugar de scBarPorRealizar

    getEl('summaryCards').classList.add('visible');
  };

  // ============================================================
  // 📋 RENDERIZADO DE TABLA
  // ============================================================

  /**
   * Construye el HTML de una fila de la tabla a partir de un registro.
   * @param {Object} f - Registro de punto de la base de datos.
   * @returns {string} HTML de la fila <tr>.
   */
  const construirFila = (f) => {
    const { chip, fila } = clasificarEstado(f.estado_parada);
    const estado = f.estado_parada || '';

    return `
      <tr class="${fila}">
        <td>${f.alias_punto    || '—'}</td>
        <td>${f.direccion      || '—'}</td>
        <td><span class="chip-ruta">${f.ruta || '—'}</span></td>
        <td>${f.ciudad         || '—'}</td>
        <td>${f.tipo_servicio  ? `<span class="chip-tipo">${f.tipo_servicio}</span>` : '—'}</td>
        <td>${f.codigo_cliente || '—'}</td>
        <td><span class="${chip}">${estado}</span></td>
      </tr>`;
  };

  /**
   * Renderiza la página indicada de la tabla de resultados.
   * Actualiza el contenido del tbody y re-renderiza la paginación.
   * @param {number} pagina - Número de página a mostrar (base 1).
   */
  const renderPagina = (pagina) => {
    paginaActual = pagina;
    const inicio = (pagina - 1) * FILAS_POR_PAGINA;
    const slice  = resultadosGlobales.slice(inicio, inicio + FILAS_POR_PAGINA);

    getEl('tablaTbody').innerHTML = slice.map(construirFila).join('');
    renderPaginacion();
    getEl('tablaScroll').scrollTop = 0;
  };

  /**
   * Renderiza los controles de paginación con navegación por ventana deslizante.
   * Muestra hasta 5 páginas alrededor de la actual con puntos suspensivos.
   */
  const renderPaginacion = () => {
    const total   = resultadosGlobales.length;
    const paginas = Math.ceil(total / FILAS_POR_PAGINA);
    const cont    = getEl('paginacion');

    if (paginas <= 1) { cont.innerHTML = ''; return; }

    const inicio = (paginaActual - 1) * FILAS_POR_PAGINA + 1;
    const fin    = Math.min(paginaActual * FILAS_POR_PAGINA, total);

    // Calcular rango de páginas a mostrar
    const rango = [];
    for (let i = 1; i <= paginas; i++) {
      if (i === 1 || i === paginas || (i >= paginaActual - 2 && i <= paginaActual + 2)) {
        rango.push(i);
      }
    }

    let html = `<button class="page-btn" onclick="Rutas.renderPagina(${paginaActual - 1})" ${paginaActual === 1 ? 'disabled' : ''}>‹</button>`;

    let prev = null;
    for (const p of rango) {
      if (prev && p - prev > 1) html += `<span class="page-info">…</span>`;
      html += `<button class="page-btn ${p === paginaActual ? 'active' : ''}" onclick="Rutas.renderPagina(${p})">${p}</button>`;
      prev = p;
    }

    html += `<button class="page-btn" onclick="Rutas.renderPagina(${paginaActual + 1})" ${paginaActual === paginas ? 'disabled' : ''}>›</button>`;
    html += `<span class="page-info">${inicio.toLocaleString()}–${fin.toLocaleString()} de ${total.toLocaleString()}</span>`;

    cont.innerHTML = html;
  };

  // ============================================================
  // 🚀 INICIALIZACIÓN
  // ============================================================

  /**
   * Inicializa la base de datos Dexie y registra todos los event listeners.
   * Se invoca automáticamente cuando el DOM está listo.
   */
  const init = () => {
    if (typeof Dexie === 'undefined') {
      alert('Error: No se pudo cargar la librería Dexie. Revisa tu conexión a internet.');
      return;
    }

    db = new Dexie('LogisticaDB');
    db.version(1).stores({
      puntos: '++id, ruta, direccion, [ruta+direccion], [ruta+alias]',
    });

    getEl('excelInput').addEventListener('change', importarExcel);
    getEl('btnBuscar').addEventListener('click', ejecutarBusqueda);

    ['filtroRuta', 'filtroDir', 'filtroAlias'].forEach((id) =>
      getEl(id).addEventListener('input', ejecutarBusqueda)
    );
  };

  window.addEventListener('DOMContentLoaded', init);

  // ============================================================
  // 📤 API PÚBLICA
  // ============================================================

  return {
    renderPagina,   // Expuesta para los botones de paginación generados dinámicamente
    ejecutarBusqueda,
  };

})();