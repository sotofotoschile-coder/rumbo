// GPS, brújula y pantalla siempre encendida.

export class Gps extends EventTarget {
  constructor() {
    super();
    this.ultima = null;
    this.idVigilancia = null;
  }

  iniciar() {
    if (this.idVigilancia !== null) return;
    if (!('geolocation' in navigator)) {
      this.#error('Este navegador no tiene acceso al GPS.');
      return;
    }
    this.idVigilancia = navigator.geolocation.watchPosition(
      (p) => {
        this.ultima = p;
        this.dispatchEvent(new CustomEvent('posicion', { detail: p }));
      },
      (e) => {
        // Sin permiso, la vigilancia queda muerta: se suelta para poder reintentar después.
        if (e.code === 1) this.detener();
        const textos = {
          1: 'Sin permiso de ubicación. Actívalo en Ajustes → Privacidad y seguridad → Localización → Sitios web de Safari.',
          2: 'Buscando señal GPS. Al aire libre y sin datos móviles puede tardar un par de minutos.',
          3: 'Buscando señal GPS…',
        };
        this.#error(textos[e.code] || 'No se pudo obtener la ubicación.', e.code);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 },
    );
  }

  detener() {
    if (this.idVigilancia !== null) navigator.geolocation.clearWatch(this.idVigilancia);
    this.idVigilancia = null;
  }

  reiniciar() {
    this.detener();
    this.iniciar();
  }

  #error(texto, codigo = 0) {
    this.dispatchEvent(new CustomEvent('error', { detail: { texto, codigo } }));
  }
}

export class Brujula extends EventTarget {
  constructor() {
    super();
    this.activa = false;
    this.rumbo = null;
  }

  get necesitaPermiso() {
    return typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  // En iOS debe llamarse desde un toque del usuario.
  async activar() {
    if (this.activa) return true;
    if (typeof DeviceOrientationEvent === 'undefined') return false;
    if (this.necesitaPermiso) {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') return false;
    }
    const manejar = (e) => {
      let h = null;
      if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) h = e.webkitCompassHeading;
      else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
      if (h == null) return;
      const giro = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      h = (((h + giro) % 360) + 360) % 360;
      // Suavizado circular para que la aguja no tiemble.
      if (this.rumbo == null) this.rumbo = h;
      else {
        let d = h - this.rumbo;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        this.rumbo = (((this.rumbo + d * 0.25) % 360) + 360) % 360;
      }
      this.dispatchEvent(new CustomEvent('rumbo', { detail: this.rumbo }));
    };
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', manejar);
    else window.addEventListener('deviceorientation', manejar);
    this.activa = true;
    return true;
  }
}

// Mantiene la pantalla encendida mientras haya algún motivo (app abierta, navegar, grabar…).
// 1) Wake Lock del navegador. 2) Respaldo para iPhone: en las apps instaladas desde Safari el Wake Lock a veces
// no funciona o se suelta solo; un video mínimo, negro, mudo y en bucle hace que iOS no bloquee la pantalla.
// El video solo puede empezar tras un toque, así que se reintenta con cada toque mientras haga falta.
export class PantallaEncendida {
  constructor() {
    this.motivos = new Set();
    this.bloqueo = null;
    this.video = null;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.#actualizar();
    });
    const alTocar = () => { if (this.motivos.size) this.#actualizar(); };
    for (const ev of ['pointerdown', 'touchend', 'click']) document.addEventListener(ev, alTocar, { capture: true, passive: true });
  }

  pedir(motivo) { this.motivos.add(motivo); this.#actualizar(); }
  soltar(motivo) { this.motivos.delete(motivo); this.#actualizar(); }
  get activa() { return !!this.bloqueo || !!(this.video && !this.video.paused); }

  #videoRespaldo() {
    if (!this.video) {
      const v = document.createElement('video');
      v.src = new URL('../assets/despierto.mp4', import.meta.url).href;
      v.muted = true;
      v.defaultMuted = true;
      v.loop = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('muted', '');
      v.setAttribute('aria-hidden', 'true');
      v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
      document.body.appendChild(v);
      this.video = v;
    }
    return this.video;
  }

  async #actualizar() {
    const hace = this.motivos.size > 0;
    if (document.visibilityState !== 'visible') return;
    // Wake Lock
    if ('wakeLock' in navigator) {
      try {
        if (hace && !this.bloqueo) {
          this.bloqueo = await navigator.wakeLock.request('screen');
          this.bloqueo.addEventListener('release', () => { this.bloqueo = null; });
        } else if (!hace && this.bloqueo) {
          await this.bloqueo.release();
          this.bloqueo = null;
        }
      } catch (_) {
        this.bloqueo = null;
      }
    }
    // Respaldo con video (siempre en iPhone, donde el Wake Lock no es confiable en apps instaladas)
    const v = this.#videoRespaldo();
    if (hace && v.paused) v.play().catch(() => { /* sin toque todavía: se reintenta con el próximo */ });
    else if (!hace && !v.paused) v.pause();
  }
}
