// Liquid-metal blob: a raymarched signed distance field on one fullscreen quad.
// No refraction pass: transparency is a fresnel term over a procedural dark
// studio environment, tinted by the state colour.
precision highp float;

uniform vec2 uRes;
uniform float uFlow;    // integrated motion time (speed applied on the CPU)
uniform float uPhase;   // integrated breathing phase, radians
uniform vec3 uColor;
uniform float uAmp;
uniform float uBreath;
uniform float uLevel;   // mic or playback level, 0..1, already scaled by the state gain
uniform float uGlow;
uniform float uBright;
uniform float uFlash;   // short brightness flash (busy)
uniform float uRadius;
// S4: shape morph. Ids: 0 sphere; triangle and square come with alerts.
uniform float uShapeA;
uniform float uShapeB;
uniform float uMix;

out vec4 fragColor;

float hash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}

// Value noise, 0..1, smooth (quintic) interpolation.
float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float radius() {
  return uRadius * (1.0 + uBreath * sin(uPhase) + uLevel * 0.05);
}

// A sphere with three soft lobes drifting under its surface (lava-lamp bulges)
// and a slow noise displacement. The level adds larger, faster swells.
float sphereShape(vec3 p) {
  float r = radius();
  float d = length(p) - r;
  float off = r * (0.12 + uAmp * 1.3);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec3 c = off * vec3(sin(uFlow * 0.71 + fi * 2.1), sin(uFlow * 0.53 + fi * 1.7 + 1.0), cos(uFlow * 0.61 + fi * 2.6));
    d = smin(d, length(p - c) - r * 0.62, 0.32);
  }
  d += (noise(p * 1.7 + vec3(0.0, uFlow * 0.5, uFlow * 0.3)) - 0.5) * uAmp * 0.7;
  d += (noise(p * 2.2 + vec3(0.0, uFlow * 1.3, uFlow * 0.9)) - 0.5) * uLevel * 0.2;
  return d;
}

float shape(vec3 p, float id) {
  return sphereShape(p); // S4: triangle and square distance functions by id
}

float map(vec3 p) {
  float a = shape(p, uShapeA);
  if (uMix < 0.001) return a;
  return mix(a, shape(p, uShapeB), uMix); // S4: march step shortened to about 0.7 while morphing
}

vec3 normalAt(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.002;
  return normalize(k.xyy * map(p + k.xyy * e) + k.yyx * map(p + k.yyx * e) +
                   k.yxy * map(p + k.yxy * e) + k.xxx * map(p + k.xxx * e));
}

// Dark studio: near-black walls, one soft key light, one tall strip light, a
// faint horizon, a dim backdrop behind the blob (it lights the fresnel rim) and
// a coloured floor bounce. Tinted by the state colour.
vec3 env(vec3 d) {
  vec3 tint = mix(vec3(1.0), uColor, 0.6);
  vec3 c = vec3(0.006) + vec3(0.012) * (d.y * 0.5 + 0.5);
  c += smoothstep(0.93, 0.99, dot(d, normalize(vec3(-0.55, 0.7, 0.6)))) * 2.6;
  c += pow(smoothstep(0.88, 0.99, dot(normalize(vec3(d.x, d.y * 0.2, d.z)), normalize(vec3(1.0, 0.0, 0.55)))), 2.0) * 1.4;
    c += 0.35 * smoothstep(0.1, 0.9, -d.z) * (0.6 + 0.4 * d.y);
  c += uColor * 0.4 * smoothstep(-0.2, -0.9, d.y);
  return c * tint;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y * 2.0;
  vec3 ro = vec3(0.0, 0.0, 3.4);
  vec3 rd = normalize(vec3(uv, -2.4));

  // Background: near black, a faint coloured haze around the blob, a vignette.
  float r = radius();
  float b = -dot(ro, rd); // ray distance to the point closest to the centre
  float closest = length(ro + rd * b);
  vec3 col = vec3(0.0003, 0.0003, 0.0006);
  col += uColor * uGlow * 0.022 * exp(-max(closest - r, 0.0) * 5.0);

  // Bounding sphere: rays that miss it skip the march.
  float rb = r * 1.5 + 0.1;
  float h = b * b - (dot(ro, ro) - rb * rb);
  if (h > 0.0) {
    float t = b - sqrt(h);
    float tEnd = b + sqrt(h);
    bool hit = false;
    for (int i = 0; i < 80; i++) {
      float d = map(ro + rd * t);
      if (d < 0.0008 * t) { hit = true; break; }
      t += d * 0.8;
      if (t > tEnd) break;
    }
    if (hit) {
      vec3 p = ro + rd * t;
      vec3 n = normalAt(p);
      float ndv = clamp(dot(n, -rd), 0.0, 1.0);
      float fres = pow(1.0 - ndv, 2.5);
      // Metal: the reflection is coloured by the state, the rim turns white.
      // Strong highlights go towards white, as on real metal.
      vec3 refl = env(reflect(rd, n));
      float hot = smoothstep(0.4, 2.0, dot(refl, vec3(0.3, 0.5, 0.2)));
      vec3 metal = refl * mix(uColor * 0.95 + 0.05, vec3(1.0), max(fres, hot)) * mix(0.4, 1.0, fres);
      // Inner glow seen through the shell: a soft core plus slow lava shapes
      // sampled a little inside the surface, so they move with some depth.
      float chord = sqrt(max(1.0 - (closest * closest) / (r * r), 0.0));
      vec3 q = p + rd * r * 0.45;
      float lava = smoothstep(0.45, 0.78, noise(q * 1.6 + vec3(0.0, -uFlow * 0.6, uFlow * 0.25)));
      vec3 inner = uColor * uGlow * (0.01 + 0.16 * chord * chord * chord + 0.45 * lava * chord * chord);
      float alpha = mix(0.6, 1.0, fres);
      col = col * (1.0 - alpha) + metal + inner;
    }
  }

  col *= uBright * (1.0 + uFlash * 0.6);
  col = 1.0 - exp(-col * 1.5);              // soft tone map, no hard clip
  col = pow(col, vec3(1.0 / 2.2));
  col += (hash(vec3(gl_FragCoord.xy, uFlow)) - 0.5) / 255.0; // dither the dark gradients
  fragColor = vec4(col, 1.0);
}
