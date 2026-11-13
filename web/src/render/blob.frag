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
  d += sin(w.x + 0.8 * w.y) * sin(w.y - 0.6 * w.z) * sin(w.z + 0.7 * w.x) * uAmp * 0.35;
  if (uLevel > 0.002) d += (noise(p * 1.9 + vec3(0.0, uFlow * 1.3, uFlow * 0.9)) - 0.5) * uLevel * 0.17;
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

// Soft light seen in direction d: centre direction a, tangent axes u and v,
// half sizes (in tangent units) and edge softness. Gnomonic projection on
// a's plane. Fully rounded corners (a pill or a rounded panel) and wide soft
// edges: no straight-edged plates in the mirror.
float softbox(vec3 d, vec3 a, vec3 u, vec3 v, vec2 size, float soft) {
  float c = dot(d, a);
  if (c <= 0.05) return 0.0;
  vec3 q = d / c - a;
  float rc = min(size.x, size.y);
  vec2 e = abs(vec2(dot(q, u), dot(q, v))) - (size - rc);
  float sd = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0) - rc;
  return 1.0 - smoothstep(-soft, soft, sd);
}

// Light frames, folded at compile time: centre direction, then tangent axes.
const vec3 CARD1_A = normalize(vec3(0.55, 0.45, 0.45));
const vec3 CARD1_U = normalize(cross(vec3(0.0, 1.0, 0.0), CARD1_A));
const vec3 CARD1_V = cross(CARD1_A, CARD1_U);
const vec3 CARD2_A = normalize(vec3(-0.6, 0.4, -0.35));
const vec3 CARD2_U = normalize(cross(vec3(0.0, 1.0, 0.0), CARD2_A));
const vec3 CARD2_V = cross(CARD2_A, CARD2_U);
const vec3 KEY_A = normalize(vec3(-0.2, 0.9, 0.35));
const vec3 KEY_U = normalize(cross(vec3(0.0, 0.0, -1.0), KEY_A));
const vec3 KEY_V = cross(KEY_A, KEY_U);
const vec3 STRIP_A = normalize(vec3(0.9, 0.05, 0.2));
const vec3 STRIP_U = normalize(cross(vec3(0.0, 1.0, 0.0), STRIP_A));
const vec3 STRIP_V = cross(STRIP_A, STRIP_U);
const vec3 RIM_A = normalize(vec3(-0.85, -0.2, -0.5));
const vec3 RIM_U = normalize(cross(vec3(0.0, 1.0, 0.0), RIM_A));
const vec3 RIM_V = cross(RIM_A, RIM_U);
const vec3 FILL_A = normalize(vec3(0.38, 0.12, 1.0));
const vec3 FILL_U = normalize(cross(vec3(0.0, 1.0, 0.0), FILL_A));
const vec3 FILL_V = cross(FILL_A, FILL_U);
const vec3 LOW_A = normalize(vec3(0.25, -0.5, -0.85));
const vec3 LOW_U = normalize(cross(vec3(0.0, 1.0, 0.0), LOW_A));
const vec3 LOW_V = cross(LOW_A, LOW_U);

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
  sky += cool * (0.22 * exp(-max(hy, 0.0) * 10.0) + 0.08 * exp(-max(hy, 0.0) * 3.0)); // glow band along the horizon
  // Black cards in the sky break it into bands, as in product shots of chrome.
  float cards = softbox(d, CARD1_A, CARD1_U, CARD1_V, vec2(0.13, 0.9), 0.12);
  cards = max(cards, softbox(d, CARD2_A, CARD2_U, CARD2_V, vec2(0.2, 0.9), 0.15));
  sky *= 1.0 - 0.92 * cards;
  // Floor: near black, a dim pool of gel light further down.
  // Floor: dark under the horizon, then a pool of gel light bouncing up, so
  // the lower half of the blob still shows its volume.
  vec3 floorC = gel * (0.008 + 0.13 * smoothstep(-0.3, -0.95, d.y)) + 0.001;
  vec3 c = mix(floorC, sky, smoothstep(-0.12, 0.06, hy));
  // Lights: a soft overhead key, a wide strip on the right, a gel strip behind.
  c += key * 2.2 * softbox(d, KEY_A, KEY_U, KEY_V, vec2(0.85, 0.4), 0.35);
  c += cool * 2.0 * softbox(d, STRIP_A, STRIP_U, STRIP_V, vec2(0.3, 0.9), 0.2);
  c += gel * 2.5 * softbox(d, RIM_A, RIM_U, RIM_V, vec2(0.18, 0.6), 0.18);
  // A low, wide gel light behind: coloured light wrapping the lower rim.
  c += gel * 1.4 * softbox(d, LOW_A, LOW_U, LOW_V, vec2(1.0, 0.22), 0.35);
  // A broad diffusion panel behind the camera fills the centre of the blob, so
  // it reads as a mirror and never as a see-through lens.
  vec3 fill = mix(gel, key, 0.3) * 0.9;
  // One panel, off centre: a pair would read as eyes.
  c += fill * softbox(d, FILL_A, FILL_U, FILL_V, vec2(0.34, 0.42), 0.3);
#if QUALITY >= 1
  // Small hard lights: fine glints on the ripples.
  c += vec3(8.0) * pow(max(dot(d, normalize(vec3(0.5, 0.6, 0.62))), 0.0), 1600.0);
  c += key * 5.0 * pow(max(dot(d, normalize(vec3(-0.6, 0.35, 0.72))), 0.0), 1000.0);
#endif
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
  float s = (0.06 + uAmp * 0.45 + uLevel * 0.1) * streak;
  const vec3 k1 = vec3(4.0, 11.0, 3.0);
  const vec3 k2 = vec3(-7.0, 8.0, 5.0);
  vec3 g = k1 * cos(dot(p, k1) - uFlow * 2.1) + k2 * cos(dot(p, k2) + uFlow * 1.7);
  g -= n * dot(g, n);
  vec3 nb = normalize(n + t * s - g * (0.006 + uLevel * 0.004));
  return env(reflect(rd, nb));
}

// Lava seen through the dark shell: the same lobes that push the surface,
// shrunk and merged into a distance field, sampled a little below the hit
// point (`pull` < 1 draws the lobes towards the centre). Negative inside.
float lavaDist(vec3 q, float r, float pull) {
  float d = 1e3;
  for (int i = 0; i < LOBES; i++) {
    vec3 dq = q - uLobes[i].xyz * r * pull;
    dq.y *= 0.72; // wax stretches as it rises: lobes are taller than wide
    d = smin(d, length(dq) - uLobes[i].w * r * (0.45 + 0.09 * float(i)), 0.16 * r);
  }
  return d;
}

// Glow of one lava sample: a soft halo outside the shape, then brighter
// towards the core, so a slice through a lobe is never a flat disc.
float lavaHeat(float ld, float r) {
  float halo = exp(-max(ld, 0.0) / (0.035 * r));
  float core = smoothstep(0.0, -0.2 * r, ld);
  return halo * (0.18 + 0.82 * core * core);
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
      if (d < 0.0013 * t) { hit = true; break; }
      t += d * mix(0.86, 0.6, uLevel); // the level swells break the distance bound a little
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
      // The samples add up, like light through a volume.
      float heat = lavaHeat(lavaDist(p - n * r * 0.22, r, 1.0), r);
#if QUALITY >= 2
      heat += 0.85 * lavaHeat(lavaDist(p + rd * r * 0.85, r, 0.6), r); // same lobes, pulled inwards
#endif
      float blob = min(heat, 1.0);
      vec3 hotLava = mix(uLava, vec3(1.0), 0.2 * smoothstep(0.8, 1.6, heat)); // whiter in the core
      // Glow compressed per state, so the brightest state never turns flat white.
      float g = uGlow * (1.0 + uLevel * 0.6);
      vec3 inner = uColor * 0.03 * g + hotLava * (1.0 - exp(-heat * 2.0)) * 1.25 * (0.3 + 0.45 * min(g, 1.3)) * (1.0 + 0.45 * uLevel); // the level pulses the lava in every state
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
