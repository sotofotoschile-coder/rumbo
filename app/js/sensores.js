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

// Mantiene la pantalla encendida mientras haya algún motivo (seguir, grabar).
export class PantallaEncendida {
  constructor() {
    this.motivos = new Set();
    this.bloqueo = null;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.#actualizar();
    });
  }

  pedir(motivo) { this.motivos.add(motivo); this.#actualizar(); }
  soltar(motivo) { this.motivos.delete(motivo); this.#actualizar(); }

  async #actualizar() {
    if (!('wakeLock' in navigator)) return;
    try {
      if (this.motivos.size && !this.bloqueo) {
        this.bloqueo = await navigator.wakeLock.request('screen');
        this.bloqueo.addEventListener('release', () => { this.bloqueo = null; });
      } else if (!this.motivos.size && this.bloqueo) {
        await this.bloqueo.release();
        this.bloqueo = null;
      }
    } catch (_) {
      this.bloqueo = null;
    }
  }
}
