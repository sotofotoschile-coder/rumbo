// Pronóstico guardado para la salida: con internet se descarga de Open-Meteo (gratis, sin cuenta) y queda
// en el iPhone para consultarlo sin señal. En la Patagonia lo clave es el viento y las ráfagas.
import { db, nuevoId } from './db.js';

const URL = 'https://api.open-meteo.com/v1/forecast';
const DIAS = 7;

export async function descargar({ nombre, lon, lat }) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: 'auto', forecast_days: String(DIAS), wind_speed_unit: 'kmh',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset',
    hourly: 'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day',
  });
  const r = await fetch(`${URL}?${q}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Open-Meteo respondió ${r.status}`);
  const datos = await r.json();
  const p = { id: nuevoId(), nombre, lon, lat, guardado: Date.now(), datos };
  // Uno por lugar: si ya había un pronóstico para el mismo punto, se reemplaza.
  for (const v of await listar()) {
    if (Math.abs(v.lon - lon) < 0.01 && Math.abs(v.lat - lat) < 0.01) await db.borrar('pronosticos', v.id);
  }
  await db.guardar('pronosticos', p);
  return p;
}

export const listar = async () => (await db.todos('pronosticos').catch(() => [])).sort((a, b) => b.guardado - a.guardado);
export const obtener = (id) => db.obtener('pronosticos', id);
export const borrar = (id) => db.borrar('pronosticos', id);

// Códigos WMO → texto corto y símbolo.
const CLIMA = [
  [0, '☀︎', 'Despejado'], [1, '🌤', 'Mayormente despejado'], [2, '⛅', 'Parcial'], [3, '☁︎', 'Nublado'], [45, '🌫', 'Niebla'], [48, '🌫', 'Niebla'],
  [51, '🌦', 'Llovizna'], [53, '🌦', 'Llovizna'], [55, '🌧', 'Llovizna'], [56, '🌧', 'Llovizna helada'], [57, '🌧', 'Llovizna helada'],
  [61, '🌧', 'Lluvia débil'], [63, '🌧', 'Lluvia'], [65, '🌧', 'Lluvia fuerte'], [66, '🌧', 'Lluvia helada'], [67, '🌧', 'Lluvia helada'],
  [71, '🌨', 'Nieve débil'], [73, '🌨', 'Nieve'], [75, '❄︎', 'Nieve fuerte'], [77, '🌨', 'Granizo fino'], [80, '🌦', 'Chubascos'],
  [81, '🌧', 'Chubascos'], [82, '⛈', 'Chubascos fuertes'], [85, '🌨', 'Chubascos de nieve'], [86, '❄︎', 'Chubascos de nieve'],
  [95, '⛈', 'Tormenta'], [96, '⛈', 'Tormenta con granizo'], [99, '⛈', 'Tormenta con granizo'],
];
export const clima = (c) => CLIMA.find((x) => x[0] === c) || [c, '·', ''];
// De noche, cielo despejado o parcial se muestra con luna.
export const simbolo = (c, dia = 1) => (!dia && c <= 2 ? (c === 0 ? '☾' : '☁︎☾') : clima(c)[1]);
const PUNTOS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
export const direccion = (g) => PUNTOS[Math.round(((g % 360) + 360) % 360 / 45) % 8];
// Flecha hacia donde sopla el viento (viene de «g»).
export const flecha = (g) => `<span class="flecha-viento" style="transform:rotate(${(g + 180) % 360}deg)">↑</span>`;
export const nivelViento = (rafaga) => (rafaga >= 80 ? 'extremo' : rafaga >= 60 ? 'fuerte' : rafaga >= 40 ? 'moderado' : '');
