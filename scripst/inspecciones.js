/**
 * @file inspecciones.js
 * @description Lógica principal del módulo de inspecciones vehiculares.
 *              Maneja el formulario, preview en tiempo real, captura de imágenes
 *              y generación/descarga del reporte en formato PNG.
 *
 * Patrón: IIFE (Immediately Invoked Function Expression) para encapsular
 *         el estado y las funciones, evitando contaminar el scope global.
 */

const Inspecciones = (() => {

  // ============================================================
  // CONFIGURACIÓN CENTRALIZADA
  // ============================================================

  /**
   * Mapa de campos del formulario que disparan la actualización del preview.
   * Centraliza los IDs para facilitar cambios futuros.
   */
  const FORM_FIELDS = ["placa", "ciudad", "coordenadas", "fecha", "observacion"];

  /**
   * Configuración de los toggles del checklist.
   * Define el texto a mostrar según el estado (activo/inactivo) de cada control.
   * Permite agregar nuevos toggles sin modificar la lógica del switch.
   */
  const TOGGLE_CONFIG = {
    chkGps:        { on: "On Line",      off: "Off Line"    },
    chkCctv:       { on: "On Line",      off: "Off Line"    },
    chkCerradura:  { on: "Cerrada",      off: "Abierta"     },
    chkExpuestos:  { on: "No",           off: "Si"          },
    chkTripulacion:{ on: "Sin Novedad",  off: "Con Novedad" },
  };

  /**
   * Mapa de relación entre chips del preview y checkboxes del formulario.
   * Usado por actualizarChecklistPreview() para sincronizar el estado visual.
   */
  const CHECKLIST_MAP = {
    pvChkGps:        ["chkGps",        "lblGps"],
    pvChkCctv:       ["chkCctv",       "lblCctv"],
    pvChkCerradura:  ["chkCerradura",  "lblCerradura"],
    pvChkExpuestos:  ["chkExpuestos",  "lblExpuestos"],
    pvChkTripulacion:["chkTripulacion","lblTripulacion"],
  };

  // ============================================================
  // UTILIDADES GENERALES
  // ============================================================

  /**
   * Obtiene un elemento del DOM por su ID.
   * @param {string} id - ID del elemento.
   * @returns {HTMLElement|null}
   */
  const getEl = (id) => document.getElementById(id);

  /**
   * Establece el texto visible de un elemento del DOM de forma segura.
   * @param {string} id - ID del elemento a modificar.
   * @param {string} value - Texto a asignar.
   */
  const setText = (id, value) => {
    const el = getEl(id);
    if (el) el.innerText = value;
  };

  /**
   * Formatea un string de fecha ISO a formato local colombiano (dd/mm/yyyy hh:mm).
   * @param {string} rawDate - Valor crudo del input datetime-local.
   * @returns {string} Fecha formateada o "—" si no hay valor.
   */
  const formatearFecha = (rawDate) => {
    if (!rawDate) return "—";
    return new Date(rawDate).toLocaleString("es-CO", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  };

  /**
   * Genera el timestamp actual formateado para mostrar en el footer del preview.
   * @returns {string} "Generado: dd/mm/yyyy hh:mm"
   */
  const timestampGenerado = () =>
    "Generado: " + new Date().toLocaleString("es-CO");

  // ============================================================
  // PREVIEW EN TIEMPO REAL
  // ============================================================

  /**
   * Recopila los valores del formulario y actualiza todos los elementos
   * del panel de vista previa (textos, chips del checklist e imágenes).
   * Se invoca cada vez que el usuario modifica cualquier campo.
   */
  const actualizarPreview = () => {
    const placa       = getEl("placa")?.value.trim()       || "—";
    const ciudad      = getEl("ciudad")?.value.trim()      || "—";
    const coords      = getEl("coordenadas")?.value.trim() || "—";
    const observacion = getEl("observacion")?.value.trim() || "Sin observaciones.";
    const tipoRuta    = document.querySelector(".tipo-chip.selected")?.dataset.value || "—";
    const fechaStr    = formatearFecha(getEl("fecha")?.value);

    setText("pvPlaca",      placa);
    setText("pvCiudad",     ciudad);
    setText("pvCoords",     coords);
    setText("pvObservacion",observacion);
    setText("pvFecha",      fechaStr);
    setText("pvTipoRuta",   "RUTA " + tipoRuta.toUpperCase());
    setText("pvGenerado",   timestampGenerado());

    actualizarChecklistPreview();
    actualizarImgPreview("boxUbicacion", "pvImgUbicacion");
    actualizarImgPreview("boxCctv",      "pvImgCctv", "No Video");
  };

  /**
   * Recorre el mapa del checklist y sincroniza el texto y estilo
   * de cada chip en el preview según el estado del checkbox correspondiente.
   */
  const actualizarChecklistPreview = () => {
    Object.entries(CHECKLIST_MAP).forEach(([pvId, [chkId, lblId]]) => {
      const chip = getEl(pvId);
      if (!chip) return;

      const checked = getEl(chkId)?.checked;
      const label   = getEl(lblId)?.innerText || "";

      chip.innerText  = label;
      chip.className  = "rpt-chip " + (checked ? "on" : "off");
    });
  };

  /**
   * Actualiza el contenedor de imagen del preview con la imagen actual del box
   * o muestra un mensaje de placeholder si no hay imagen cargada.
   * @param {string} boxId - ID del contenedor de imagen del formulario.
   * @param {string} pvId  - ID del contenedor de imagen en el preview.
   * @param {string} [textoDefault="Sin imagen"] - Texto a mostrar si no hay imagen.
   */
  const actualizarImgPreview = (boxId, pvId, textoDefault = "Sin imagen") => {
    const src = document.querySelector(`#${boxId} img`)?.src;
    const box = getEl(pvId);
    if (!box) return;

    box.innerHTML = src
      ? `<img src="${src}" style="width:100%;height:100%;object-fit:cover;">`
      : `<span class="rpt-img-empty">${textoDefault}</span>`;
  };

  // ============================================================
  // CANVAS — GENERACIÓN DEL REPORTE PNG
  // ============================================================

  /**
   * Dibuja un campo con etiqueta y valor en el canvas del reporte.
   * @param {CanvasRenderingContext2D} ctx - Contexto 2D del canvas.
   * @param {string} label - Nombre del campo (se muestra en mayúsculas).
   * @param {string} value - Valor del campo.
   * @param {number} x - Posición horizontal en píxeles.
   * @param {number} y - Posición vertical en píxeles.
   */
  const drawCampo = (ctx, label, value, x, y) => {
    ctx.fillStyle = "#94a3b8";
    ctx.font = "10px sans-serif";
    ctx.fillText(label.toUpperCase(), x, y);

    ctx.fillStyle = "#fff";
    ctx.font = "13px sans-serif";
    ctx.fillText(value, x, y + 16);
  };

  /**
   * Dibuja texto multilínea en el canvas, cortando líneas cuando superan el ancho máximo.
   * @param {CanvasRenderingContext2D} ctx - Contexto 2D del canvas.
   * @param {string} text       - Texto completo a renderizar.
   * @param {number} x          - Posición horizontal inicial.
   * @param {number} y          - Posición vertical inicial.
   * @param {number} maxWidth   - Ancho máximo en píxeles antes de hacer salto de línea.
   * @param {number} lineHeight - Altura entre líneas en píxeles.
   */
  const wrapText = (ctx, text, x, y, maxWidth, lineHeight) => {
    const words = text.split(" ");
    let line = "";

    words.forEach((word, index) => {
      const testLine = line + word + " ";
      if (ctx.measureText(testLine).width > maxWidth && index > 0) {
        ctx.fillText(line, x, y);
        line = word + " ";
        y += lineHeight;
      } else {
        line = testLine;
      }
    });

    ctx.fillText(line, x, y);
  };

  /**
   * Genera el reporte de inspección como imagen PNG usando Canvas API
   * y lo descarga automáticamente en el navegador del usuario.
   * También muestra un toast de confirmación al finalizar.
   */
  const generarReporte = () => {
    const canvas    = document.createElement("canvas");
    canvas.width    = 420;
    canvas.height   = 900;
    const ctx       = canvas.getContext("2d");

    const placa       = getEl("placa")?.value       || "—";
    const ciudad      = getEl("ciudad")?.value      || "—";
    const coords      = getEl("coordenadas")?.value || "—";
    const observacion = getEl("observacion")?.value || "Sin observaciones.";
    const fechaStr    = formatearFecha(getEl("fecha")?.value);

    // Fondo oscuro
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let y = 20;

    // Título del reporte
    ctx.fillStyle = "#00bcd4";
    ctx.font = "bold 16px sans-serif";
    ctx.fillText("REPORTE DE INSPECCIÓN", 20, y);
    y += 30;

    // Datos del vehículo
    const campos = [
      ["Vehículo", placa],
      ["Ciudad",   ciudad],
      ["Ubicación",coords],
      ["Fecha",    fechaStr],
    ];

    campos.forEach(([label, value]) => {
      drawCampo(ctx, label, value, 20, y);
      y += 40;
    });

    y += 10;

    // Sección de observación
    ctx.fillStyle = "#00bcd4";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText("OBSERVACIÓN", 20, y);
    y += 20;

    ctx.fillStyle = "#fff";
    ctx.font = "12px sans-serif";
    wrapText(ctx, observacion, 20, y, 360, 16);

    // Descarga automática
    const link      = document.createElement("a");
    link.download   = "reporte.png";
    link.href       = canvas.toDataURL();
    link.click();

    mostrarToast("Reporte generado correctamente");
  };

  // ============================================================
  // COPIAR PREVIEW AL PORTAPAPELES
  // ============================================================

  /**
   * Captura el panel de preview HTML como imagen PNG usando html2canvas
   * y la copia al portapapeles del sistema.
   * Requiere que la librería html2canvas esté disponible globalmente.
   */
  const copiarPreview = () => {
    const preview = getEl("previewHtml");
    if (!preview) {
      mostrarToast("No se encontró el preview");
      return;
    }

    html2canvas(preview, { scale: 2 })
      .then((canvas) => canvas.toBlob((blob) => {
        if (!blob) {
          mostrarToast("Error al copiar");
          return;
        }

        const item = new ClipboardItem({ "image/png": blob });
        navigator.clipboard.write([item])
          .then(()  => mostrarToast("Imagen copiada"))
          .catch(()  => mostrarToast("No se pudo copiar"));
      }));
  };

  // ============================================================
  // TOAST DE NOTIFICACIONES
  // ============================================================

  /**
   * Muestra una notificación temporal (toast) en la interfaz.
   * La notificación desaparece automáticamente después de 2 segundos.
   * @param {string} msg - Mensaje a mostrar al usuario.
   */
  const mostrarToast = (msg) => {
    const toast = getEl("toast");
    if (!toast) return;

    toast.innerText   = msg;
    toast.classList.add("show");

    setTimeout(() => { toast.classList.remove("show"); }, 2000);
  };

  // ============================================================
  // TOGGLES DEL CHECKLIST
  // ============================================================

  /**
   * Actualiza el texto y el estilo visual de un toggle al cambiar su estado.
   * Usa la configuración centralizada en TOGGLE_CONFIG para determinar el texto.
   * @param {HTMLInputElement} el - Elemento checkbox que disparó el cambio.
   */
  const updateToggle = (el) => {
    const config = TOGGLE_CONFIG[el.id];
    const label  = el.closest(".toggle-wrap")?.querySelector(".toggle-estado");

    if (!config || !label) return;

    label.innerText = el.checked ? config.on : config.off;
    label.className = `toggle-estado ${el.checked ? "on" : "off"}`;

    actualizarPreview();
  };

  // ============================================================
  // MANEJO DE IMÁGENES (PEGAR / LIMPIAR)
  // ============================================================

  /**
   * Enfoca el contenedor de imagen para habilitar el evento de pegado (Ctrl+V).
   * @param {string} id - ID del contenedor a enfocar.
   */
  const focoImagen = (id) => getEl(id)?.focus();

  /**
   * Procesa el evento de pegado en un contenedor de imagen.
   * Si el portapapeles contiene una imagen, la muestra dentro del contenedor
   * reemplazando cualquier imagen previa y ocultando el placeholder.
   * @param {ClipboardEvent} e - Evento de pegado del navegador.
   * @param {string} id        - ID del contenedor de destino.
   */
  const pegarImagen = (e, id) => {
    e.preventDefault();
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find((item) => item.type.startsWith("image"));

    if (!imageItem) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const box = getEl(id);
      if (!box) return;

      // Remover imagen anterior y ocultar placeholder
      box.querySelector("img")?.remove();
      const ph = box.querySelector(".img-placeholder");
      if (ph) ph.style.display = "none";

      // Insertar nueva imagen
      const img = Object.assign(document.createElement("img"), {
        src: event.target.result,
      });
      img.style.cssText = "width:100%;height:100%;object-fit:cover;";
      box.appendChild(img);

      actualizarPreview();
    };

    reader.readAsDataURL(imageItem.getAsFile());
  };

  /**
   * Elimina la imagen del contenedor especificado y restaura el placeholder.
   * @param {string} id - ID del contenedor de imagen a limpiar.
   */
  const limpiarImagen = (id) => {
    const box = getEl(id);
    if (!box) return;

    box.querySelector("img")?.remove();
    const ph = box.querySelector(".img-placeholder");
    if (ph) ph.style.display = "flex";

    actualizarPreview();
  };

  // ============================================================
  // SELECTOR DE TIPO DE RUTA
  // ============================================================

  /**
   * Maneja la selección del tipo de ruta (chip buttons).
   * Desactiva todos los chips y activa únicamente el seleccionado.
   * @param {HTMLElement} el - Elemento chip que fue clicado.
   */
  const seleccionarTipo = (el) => {
    document.querySelectorAll(".tipo-chip").forEach((chip) =>
      chip.classList.remove("selected")
    );
    el.classList.add("selected");
    actualizarPreview();
  };

  // ============================================================
  //  LIMPIAR FORMULARIO
  // ============================================================
  const limpiarFormulario = () => {
    // Limpiar campos de texto
    FORM_FIELDS.forEach((id) => {
      const el = getEl(id);
      if (el) el.value = "";
    });

    // Restaurar fecha actual
    inicializarFecha();

    // Resetear todos los toggles
    Object.keys(TOGGLE_CONFIG).forEach((id) => {
      const checkbox = getEl(id);
      if (checkbox) {
        checkbox.checked = false;
        updateToggle(checkbox);
      }
    });

    // Seleccionar primer chip de tipo de ruta
    const primerChip = document.querySelector(".tipo-chip");
    if (primerChip) seleccionarTipo(primerChip);

    // Limpiar imágenes
    limpiarImagen("boxUbicacion");
    limpiarImagen("boxCctv");

    actualizarPreview();
  };

  // ============================================================
  // INICIALIZACIÓN
  // ============================================================

  /**
   * Establece la fecha y hora actuales en el campo datetime-local del formulario.
   * Ajusta al timezone local del usuario.
   */
  const inicializarFecha = () => {
    const ahora = new Date();
    const local = new Date(ahora.getTime() - ahora.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);

    const campoFecha = getEl("fecha");
    if (campoFecha) campoFecha.value = local;
  };

  /**
   * Registra los event listeners para los campos del formulario
   * que deben actualizar el preview en tiempo real.
   */
  const registrarEventListeners = () => {
    FORM_FIELDS.forEach((id) => {
      getEl(id)?.addEventListener("input", actualizarPreview);
    });
  };

  /**
   * Punto de entrada del módulo.
   * Se ejecuta cuando el DOM está completamente cargado.
   */
  const init = () => {
    inicializarFecha();
    registrarEventListeners();
    actualizarPreview();
  };

  document.addEventListener("DOMContentLoaded", init);

  // ============================================================
  // API PÚBLICA — funciones expuestas al HTML
  // ============================================================

  /**
   * Expone solo las funciones necesarias para ser llamadas
   * desde los atributos inline del HTML (onclick, onchange, etc.).
   */
  return {
    actualizarPreview,
    updateToggle,
    focoImagen,
    pegarImagen,
    limpiarImagen,
    seleccionarTipo,
    generarReporte,
    copiarPreview,
    limpiarFormulario,
  };

})();