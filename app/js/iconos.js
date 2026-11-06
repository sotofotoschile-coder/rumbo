// Íconos de línea propios (24x24), sin depender de fuentes externas.
const P = {
  buscar: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/>',
  capas: '<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/>',
  norte: '<path d="M12 3l4 9h-8z" fill="#e5484d" stroke="#e5484d"/><path d="M12 21l4-9H8z" fill="currentColor" stroke="currentColor" opacity=".35"/>',
  ubicacion: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22"/>',
  seguir: '<path d="M20 4L4 11l7 2 2 7z" fill="currentColor"/>',
  rumbo: '<path d="M12 2l6 18-6-4-6 4z" fill="currentColor"/>',
  track: '<path d="M4 19c3-7 6 1 8-6s5-2 8-8"/><circle cx="4" cy="19" r="1.6" fill="currentColor"/><circle cx="20" cy="5" r="1.6" fill="currentColor"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0113 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  brujula: '<circle cx="12" cy="12" r="9"/><path d="M15.8 8.2l-2.3 5.3-5.3 2.3 2.3-5.3z"/>',
  mapa: '<path d="M9 4L3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
  cerrar: '<path d="M6 6l12 12M18 6L6 18"/>',
  grabar: '<circle cx="12" cy="12" r="6" fill="currentColor"/>',
  pausa: '<path d="M8.5 5v14M15.5 5v14"/>',
  reanudar: '<path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor"/>',
  detener: '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/>',
  basura: '<path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 13h11l1-13M9 7V4h6v3"/>',
  compartir: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v8h14v-8"/>',
  mas: '<path d="M12 5v14M5 12h14"/>',
  ver: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  importar: '<path d="M12 3v12M8 11l4 4 4-4"/><path d="M5 15v5h14v-5"/>',
  descargar: '<path d="M7 18a5 5 0 01-.6-9.96A6 6 0 0118 9a4 4 0 01-1 9"/><path d="M12 12v8M9 17l3 3 3-3"/>',
  // Glifos rellenos (estilo «Sólido moderno»): se usan sobre las baldosas de color.
  'ruta-r': '<circle cx="6" cy="18" r="3" fill="currentColor" stroke="none"/><circle cx="18" cy="6" r="3" fill="currentColor" stroke="none"/><path d="M9 18h6a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6" stroke-width="2.6"/>',
  'track-r': '<path d="M4 19c3-7 6 1 8-6s5-2 8-8" stroke-width="2.8"/><circle cx="4" cy="19" r="2.6" fill="currentColor" stroke="none"/><circle cx="20" cy="5" r="2.6" fill="currentColor" stroke="none"/>',
  'pin-r': '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M12 2a7.5 7.5 0 0 0-7.5 7.5c0 5.6 7.5 12.5 7.5 12.5s7.5-6.9 7.5-12.5A7.5 7.5 0 0 0 12 2zm0 10.3a2.8 2.8 0 1 1 0-5.6 2.8 2.8 0 0 1 0 5.6z"/>',
  'brujula-r': '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19zm4.2 5.3-2.4 6-6 2.4 2.4-6z"/>',
  'mapa-r': '<path fill="currentColor" stroke="none" d="M2.5 6.6 8.3 4v15.4l-5.8 2.6zM9.7 4l4.6 2.3v15.4l-4.6-2.3zM15.7 6.3 21.5 3.7v15.4l-5.8 2.6z"/>',
  'capas-r': '<path fill="currentColor" stroke="none" d="M12 3 21.5 8 12 13 2.5 8z"/><path d="M3 12.3 12 17l9-4.7M3 16.3 12 21l9-4.7" stroke-width="2.4"/>',
  'globo-r': '<circle cx="12" cy="12" r="9.5" fill="currentColor" stroke="none"/><path d="M3.5 9h17M3.5 15h17M12 2.5c3 3.2 3 15.8 0 19M12 2.5c-3 3.2-3 15.8 0 19" stroke="#fff" stroke-opacity=".55" stroke-width="1.4"/>',
  sos: '<text x="12" y="16.2" text-anchor="middle" font-size="10" font-weight="800" fill="currentColor" stroke="none" font-family="-apple-system,system-ui,sans-serif">SOS</text>',
  // Categorías de lugares
  campamento: '<path d="M2.5 20 12 4l9.5 16z" fill="currentColor" stroke="none"/><path d="M12 20l-3-5h6z" fill="#fff" stroke="none" opacity=".9"/>',
  agua: '<path fill="currentColor" stroke="none" d="M12 2.5s6.5 7.3 6.5 11.7a6.5 6.5 0 0 1-13 0C5.5 9.8 12 2.5 12 2.5z"/>',
  mirador: '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M12 5C6.5 5 2.5 12 2.5 12S6.5 19 12 19s9.5-7 9.5-7S17.5 5 12 5zm0 10.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>',
  peligro: '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M12 2.8 22 20.5H2zm-1.1 6.2h2.2l-.3 6h-1.6zm1.1 7.3a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6z"/>',
  refugio: '<path fill="currentColor" stroke="none" d="M12 3 2.5 11.5h2.8V21h5v-5.5h3.4V21h5v-9.5h2.8z"/>',
  foto: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  bateria: '<rect x="3" y="7" width="16" height="10" rx="2.5"/><path d="M21 10.5v3"/><path d="M6 10v4M9.5 10v4" stroke-width="2.4"/>',
  ruta:'<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.8"/>',
  auto: '<path d="M5 17h14v-4l-2-5H7l-2 5z"/><path d="M5 13h14"/><circle cx="8" cy="17" r="1.6" fill="currentColor"/><circle cx="16" cy="17" r="1.6" fill="currentColor"/>',
  caminar: '<circle cx="13" cy="4.5" r="1.8"/><path d="M9 21l2.5-6.5L14 17v4M11.5 14.5l1-5 3 2.5 2.5 1M12.5 9.5L9 11l-1 3"/>',
  voz: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  silencio: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/>',
  intercambiar: '<path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/>',
  globo:'<circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17M12 3a13.5 13.5 0 010 18M12 3a13.5 13.5 0 000 18"/>',
  montana:'<path d="M3 20l6-10 4 6 2-3 6 7z"/>',
};

export function icono(nombre) {
  return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${P[nombre] || ''}</svg>`;
}

// Trazos SVG de un ícono (para dibujarlo dentro de otra imagen, p. ej. los lugares del mapa).
export const trazo = (nombre) => P[nombre] || '';

export function pintarIconos(raiz = document) {
  raiz.querySelectorAll('[data-icono]').forEach((el) => {
    el.innerHTML = icono(el.dataset.icono);
  });
}
