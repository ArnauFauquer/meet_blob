// Liquid-metal lava lamp: a raymarched signed distance field on one fullscreen
// quad. The surface is a dark, slightly translucent mirror (Schlick fresnel)
// over a procedural studio lit with coloured gels; under it, glowing lava
// lobes rise and sink, push the surface out and merge. No refraction pass.
precision highp float;

// QUALITY (define set by blob.ts): 2 full, 1 lighter, 0 minimal.
#ifndef QUALITY
#define QUALITY 2
#endif
#if QUALITY >= 2
#define MARCH_STEPS 96
#define LOBES 5
#elif QUALITY == 1
#define MARCH_STEPS 72
#define LOBES 4
#else
#define MARCH_STEPS 48
#define LOBES 3
#endif

uniform vec2 uRes;
uniform float uFlow;    // integrated motion time (speed applied on the CPU)
uniform float uPhase;   // integrated breathing phase, radians
uniform vec3 uColor;
uniform vec3 uLava;    // colour of the lava under the skin
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

// Lava lobes: centre (xyz, in units of the blob radius) and radius (w).
// blob.ts moves them (lobes() in tables.ts): they rise and sink on slow
// cycles, so they pass, merge and split again. Quality uses the first LOBES.
uniform vec4 uLobes[5];

// A sphere with lava lobes pushing its surface from inside, a slow noise
// displacement, and larger, faster swells driven by the level.
float sphereShape(vec3 p) {
  float r = radius();
  float d = length(p) - r;
#define LOBE(i) d = smin(d, length(p - uLobes[i].xyz * r) - uLobes[i].w * r, 0.28 * r);
  LOBE(0) LOBE(1) LOBE(2)
#if LOBES > 3
  LOBE(3)
#endif
#if LOBES > 4
  LOBE(4)
#endif
  // Slow ripples: three crossed sines, much cheaper than value noise.
  vec3 w = p * vec3(2.1, 2.6, 2.3) + vec3(uFlow * 0.7, -uFlow * 0.9, uFlow * 0.5);
  d += sin(w.x + sin(w.y)) * sin(w.y * 0.9 + sin(w.z)) * sin(w.z * 1.1 + 1.3) * uAmp * 0.35;
  if (uLevel > 0.002) d += (noise(p * 2.4 + vec3(0.0, uFlow * 1.3, uFlow * 0.9)) - 0.5) * uLevel * 0.17;
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

// Soft rectangular light seen in direction d: centre direction a, half sizes
// (in tangent units) and edge softness. Gnomonic projection on a's plane.
float softbox(vec3 d, vec3 a, vec3 up, vec2 size, float soft) {
  float c = dot(d, a);
  if (c <= 0.05) return 0.0;
  vec3 q = d / c - a;
  vec3 u = normalize(cross(up, a));
  vec3 v = cross(a, u);
  vec2 e = abs(vec2(dot(q, u), dot(q, v))) - size;
  float sd = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0);
  return 1.0 - smoothstep(-soft, soft, sd);
}

// Dark studio in HDR (values above 1 are lights). Gels tint every light with
// the state colour; the key keeps some white so highlights read as metal.
// Chrome reads through contrast: a bright sky over a dark floor, split by a
// sharp horizon, with tall strips at the sides and a gel rim light behind.
vec3 env(vec3 d) {
  vec3 gel = uColor;
  vec3 key = mix(vec3(1.0), gel, 0.55);
  vec3 cool = mix(vec3(1.0), gel, 0.8);
  // The horizon sits a little below eye level, so it curves low on the blob.
  float hy = d.y + 0.18;
  // Sky: broad and bright, in the gel colour, whiter towards the zenith.
  float zen = smoothstep(0.15, 1.0, d.y);
  vec3 sky = gel * (0.04 + 0.9 * zen) + key * 0.35 * zen * zen * zen;
  sky += cool * (0.45 * exp(-max(hy, 0.0) * 16.0) + 0.1 * exp(-max(hy, 0.0) * 4.0)); // glow band along the horizon
  // Black cards in the sky break it into bands, as in product shots of chrome.
  float cards = softbox(d, normalize(vec3(0.55, 0.45, 0.45)), vec3(0.0, 1.0, 0.0), vec2(0.13, 0.9), 0.08);
  cards = max(cards, softbox(d, normalize(vec3(-0.6, 0.4, -0.35)), vec3(0.0, 1.0, 0.0), vec2(0.2, 0.9), 0.1));
  sky *= 1.0 - 0.92 * cards;
  // Floor: near black, a dim pool of gel light further down.
  vec3 floorC = gel * (0.006 + 0.08 * smoothstep(-0.5, -1.0, d.y)) + 0.0008;
  vec3 c = mix(floorC, sky, smoothstep(-0.03, 0.02, hy));
  // Lights: a soft overhead key, a wide strip on the right, a gel strip behind.
  c += key * 2.2 * softbox(d, normalize(vec3(-0.2, 0.9, 0.35)), vec3(0.0, 0.0, -1.0), vec2(0.85, 0.4), 0.25);
  c += cool * 2.0 * softbox(d, normalize(vec3(0.9, 0.05, 0.2)), vec3(0.0, 1.0, 0.0), vec2(0.3, 0.9), 0.1);
  c += gel * 2.5 * softbox(d, normalize(vec3(-0.85, -0.2, -0.5)), vec3(0.0, 1.0, 0.0), vec2(0.18, 0.6), 0.12);
  // A broad diffusion panel behind the camera fills the centre of the blob, so
  // it reads as a mirror and never as a see-through lens.
  vec3 fill = mix(gel, key, 0.3) * 0.9;
  // One panel, off centre: a pair would read as eyes.
  c += fill * softbox(d, normalize(vec3(0.38, 0.12, 1.0)), vec3(0.0, 1.0, 0.0), vec2(0.34, 0.42), 0.22);
  // Small hard lights: fine glints on the ripples.
  c += vec3(8.0) * pow(max(dot(d, normalize(vec3(0.5, 0.6, 0.62))), 0.0), 1600.0);
  c += key * 5.0 * pow(max(dot(d, normalize(vec3(-0.6, 0.35, 0.72))), 0.0), 1000.0);
  return c;
}

// Reflection direction warped along the flow: the normal leans along the
// upward surface tangent by a slow streak pattern, so reflections stretch
// and drift vertically as the liquid moves (cheap anisotropy, one env tap).
// Fine ripples on top: an analytic bump (two travelling waves) that only
// bends the normal, for glints and flow lines without touching the march.
vec3 reflection(vec3 rd, vec3 n, vec3 p) {
  vec3 t = vec3(0.0, 1.0, 0.0) - n * n.y;
  t *= inversesqrt(max(dot(t, t), 1e-4));
  float streak = sin(dot(p, vec3(2.3, 6.5, 1.7)) - uFlow * 1.4) * sin(dot(p, vec3(-1.9, 4.1, 2.9)) + uFlow * 0.9);
  float s = (0.03 + uAmp * 0.25 + uLevel * 0.08) * streak;
  const vec3 k1 = vec3(4.0, 11.0, 3.0);
  const vec3 k2 = vec3(-7.0, 8.0, 5.0);
  vec3 g = k1 * cos(dot(p, k1) - uFlow * 2.1) + k2 * cos(dot(p, k2) + uFlow * 1.7);
  g -= n * dot(g, n);
  vec3 nb = normalize(n + t * s - g * (0.006 + uLevel * 0.004));
  return env(reflect(rd, nb));
}

// Lava seen through the dark shell: the same lobes that push the surface,
// shrunk and merged into a distance field, sampled a little below the hit
// point. Negative inside a lava shape.
float lavaDist(vec3 q, float r) {
  float d = 1e3;
  for (int i = 0; i < LOBES; i++) {
    d = smin(d, length(q - uLobes[i].xyz * r) - uLobes[i].w * r * 0.8, 0.25 * r);
  }
  return d;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y * 2.0;
  vec3 ro = vec3(0.0, 0.0, 3.4);
  vec3 rd = normalize(vec3(uv, -2.4));

  // Background: near black with a soft coloured glow bleeding out of the blob.
  float r = radius();
  float b = -dot(ro, rd); // ray distance to the point closest to the centre
  float closest = length(ro + rd * b);
  float out_ = max(closest - r, 0.0);
  vec3 col = vec3(0.0004, 0.0004, 0.0007);
  col += uColor * min(uGlow, 1.2) * (0.026 * exp(-out_ * 5.0) + 0.0025 * exp(-out_ * 1.8));

  // Bounding sphere: rays that miss it skip the march.
  float rb = r * 1.5 + 0.1;
  float h = b * b - (dot(ro, ro) - rb * rb);
  if (h > 0.0) {
    float t = b - sqrt(h);
    float tEnd = b + sqrt(h);
    bool hit = false;
    float d = 1.0;
    for (int i = 0; i < MARCH_STEPS; i++) {
      d = map(ro + rd * t);
      if (d < 0.0008 * t) { hit = true; break; }
      t += d * mix(0.8, 0.6, uLevel); // the level swells break the distance bound a little
      if (t > tEnd) break;
    }
    // A ray grazing a swell can run out of steps just above the surface;
    // counting it as a miss leaves a dark seam inside the silhouette.
    hit = hit || (d < 0.01 && t < tEnd);
    if (hit) {
      vec3 p = ro + rd * t;
      vec3 n = normalAt(p);
      float ndv = clamp(dot(n, -rd), 0.0, 1.0);
      float fr = pow(1.0 - ndv, 5.0);
      // Dark liquid metal: Schlick fresnel with a high base reflectance and a
      // slight coloured reflectance; strong highlights stay near white.
      float F = 0.68 + 0.32 * fr;
      vec3 refl = reflection(rd, n, p);
      float hot = smoothstep(1.0, 4.0, dot(refl, vec3(0.3, 0.5, 0.2)));
      vec3 tint = mix(mix(vec3(1.0), uColor, 0.3), vec3(1.0), hot);
      // A trace of thin-film colour at the rim only.
      vec3 film = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + 1.6 * (1.0 - ndv) + uFlow * 0.03));
      tint *= mix(vec3(1.0), 0.6 + 0.8 * film, 0.18 * smoothstep(0.35, 0.95, 1.0 - ndv));
      vec3 spec = refl * tint * F;

      // Lava under the shell, sampled a little inside so it moves with depth.
      // Just under the skin (lobes that push the surface glow through it) and,
      // deeper along the ray, dimmer lava further inside.
      float ld = lavaDist(p - n * r * 0.22, r);
#if QUALITY >= 1
      ld = min(ld, lavaDist(p + rd * r * 0.5, r) + 0.03 * r);
#endif
      // Volumetric look: a soft skin, then brighter the deeper inside the lava.
      float blob = smoothstep(0.06 * r, -0.08 * r, ld);
      float depth = clamp(-ld / (0.35 * r), 0.0, 1.0);
      float heat = blob * (0.35 + 0.65 * depth * depth);
      vec3 hotLava = mix(uLava, vec3(1.0), 0.3 * depth); // whiter in its core
      // Glow compressed per state, so the brightest state never turns flat white.
      float g = uGlow * (1.0 + uLevel * 0.6);
      vec3 inner = uColor * 0.03 * g + hotLava * (1.0 - exp(-heat * 2.2)) * (0.15 + 0.3 * min(g, 1.3));
      // Thin rim lit from behind: the shell is slightly translucent there.
      float rim = pow(1.0 - ndv, 3.0);
      // Where lava presses on the skin the mirror thins and the glow comes through.
      col = spec * (1.0 - 0.15 * blob) + inner * (1.0 - 0.8 * F * (1.0 - 0.5 * blob)) + uColor * uGlow * 0.12 * rim;
    }
  }

  col *= uBright * (1.0 + uFlash * 0.6);
  col = 1.0 - exp(-col * 1.4);              // soft tone map, no hard clip
  col = pow(col, vec3(1.0 / 2.2));
  col += (hash(vec3(gl_FragCoord.xy, uFlow)) - 0.5) / 255.0; // dither the dark gradients
  fragColor = vec4(col, 1.0);
}
