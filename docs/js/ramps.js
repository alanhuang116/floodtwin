// Colour ramps for the analysis layers. Each is one hue, light to dark, built
// in OKLCH and checked for monotone lightness and visible steps. Hex values are
// sRGB (legends); the GLSL versions are converted to linear for the shaders.

export const RAMPS = {
  depth: { stops: ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b'], max: 3, unit: 'm' },
  speed: { stops: ['#ffe0c8', '#fab27b', '#e2832d', '#b95e00', '#8b4000'], max: 3, unit: 'm/s' },
  damage: { stops: ['#ffdee1', '#f7a3ad', '#e5657b', '#bf2f52', '#881334'], max: 0.6, unit: '' },
  // early arrival is the dark end
  arrival: { stops: ['#562c8b', '#7a4aba', '#9d79d7', '#c0abe9', '#e5dcf9'] },
};

// DEFRA / Environment Agency FD2320 hazard rating classes, HR = d (v + 0.5) + DF
export const HAZARD = [
  { max: 0.75, color: '#fcc0b8', label: 'Low', note: 'Caution' },
  { max: 1.25, color: '#ef7f74', label: 'Moderate', note: 'Danger for some' },
  { max: 2.0, color: '#cf413a', label: 'Significant', note: 'Danger for most' },
  { max: Infinity, color: '#9b1f1d', label: 'Extreme', note: 'Danger for all' },
];

const lin = (hex) => {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map(c => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
};
const v3 = (hex) => `vec3(${lin(hex).map(x => x.toFixed(4)).join(', ')})`;

function rampFn(name, stops) {
  const n = stops.length - 1;
  const cs = stops.map((h, k) => `c${k} = ${v3(h)}`).join(', ');
  let body = `float s = clamp(t, 0.0, 1.0) * ${n.toFixed(1)};\n`;
  for (let k = 0; k < n; k++) body += `  if (s < ${(k + 1).toFixed(1)}) return mix(c${k}, c${k + 1}, s - ${k.toFixed(1)});\n`;
  return `vec3 ${name}01(float t) {\n  vec3 ${cs};\n  ${body}  return c${n};\n}`;
}

export const RAMPS_GLSL = /* glsl */`
${rampFn('rampDepth', RAMPS.depth.stops)}
${rampFn('rampSpeed', RAMPS.speed.stops)}
${rampFn('rampDamage', RAMPS.damage.stops)}
${rampFn('rampArrivalT', RAMPS.arrival.stops)}
vec3 rampDepth(float d) { return rampDepth01(d / ${RAMPS.depth.max.toFixed(1)}); }
vec3 rampSpeed(float v) { return rampSpeed01(v / ${RAMPS.speed.max.toFixed(1)}); }
vec3 rampDamage(float r) { return rampDamage01(r / ${RAMPS.damage.max.toFixed(2)}); }
vec3 rampArrival(float t, float tEnd) { return rampArrivalT01(t / max(tEnd, 1.0)); }
vec3 rampHazard(float hr) {
  if (hr < ${HAZARD[0].max.toFixed(2)}) return ${v3(HAZARD[0].color)};
  if (hr < ${HAZARD[1].max.toFixed(2)}) return ${v3(HAZARD[1].color)};
  if (hr < ${HAZARD[2].max.toFixed(2)}) return ${v3(HAZARD[2].color)};
  return ${v3(HAZARD[3].color)};
}`;

/** CSS linear-gradient for a ramp legend. */
export function cssGradient(stops, dir = 'to right') {
  return `linear-gradient(${dir}, ${stops.map((c, k) => `${c} ${(k / (stops.length - 1)) * 100}%`).join(', ')})`;
}
