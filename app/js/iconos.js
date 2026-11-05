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
  montana: '<path d="M3 20l6-10 4 6 2-3 6 7z"/>',
};

export function icono(nombre) {
  return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${P[nombre] || ''}</svg>`;
}

export function pintarIconos(raiz = document) {
  raiz.querySelectorAll('[data-icono]').forEach((el) => {
    el.innerHTML = icono(el.dataset.icono);
  });
}
