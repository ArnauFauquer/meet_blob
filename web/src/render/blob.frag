// Liquid-metal lava lamp: a raymarched signed distance field on one fullscreen
// quad. The surface is a dark, slightly translucent mirror (Schlick fresnel)
// over a procedural studio lit with coloured gels; under it, glowing lava
// lobes rise and sink, push the surface out and merge. No refraction pass.
precision highp float;

// QUALITY (define set by blob.ts): 2 full, 1 lighter, 0 minimal.
#ifndef QUALITY
#define QUALITY 2
#endif
// WEATHER (define set by blob.ts): 1 once the idle blob has shown the sky.
// The weather shape is big and gets inlined at every map() call: software GL
// stalls the page while it compiles, so pages that never show it skip it.
#ifndef WEATHER
#define WEATHER 0
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
// Shape morph. Ids (SHAPE in tables.ts): 0 sphere, 1 triangle, 2 square.
uniform float uShapeA;
uniform float uShapeB;
uniform float uMix;
// Lava face (Look in tables.ts), in units of the blob radius, y up.
uniform vec4 uEyes;   // eye half width, half height (blink applied), height, happy (0 open, 1 arcs)
uniform vec2 uGaze;   // where the face looks
uniform vec3 uMouth;  // curvature (+ smile), opening, face strength
uniform vec4 uMouthShape; // half width, tilt (one corner up), pucker (0 wide lips, 1 round "o"), tongue
// Clock (shape 3, the idle blob at rest): HH:MM as lava digits on a wide pill.
uniform vec4 uDigits;     // the four digits shown
uniform vec4 uDigitsPrev; // the digits before the last change
uniform float uTick;      // 0..1, melts uDigitsPrev into uDigits
uniform vec4 uDigitY;     // vertical bob of each digit (a slow wave across the clock)
uniform float uColon;     // 0..1, the colon's beat once a second
// Weather (shape 4, the idle blob showing the sky outside): weights of each
// part, eased on the CPU so one sky melts into the next.
uniform vec4 uSky;    // sun, moon, cloud, size (scale to the sphere's volume)
uniform vec3 uFall;   // drops falling from the cloud: amount, snow (0 rain, 1 flakes), fall time
uniform vec3 uFaceT;  // where the face sits on the weather shape: offset xy, scale
// Body motion (animateBody() in blob.ts): the body's offset (hops, acts) and
// the linear map from world to body: turns and flips, the jelly lean and the
// squash and stretch, all in one matrix. uBodyK turns a body distance into a
// safe world distance (1 / largest stretch of uBody); uBodyR grows the
// bounding sphere (1 / smallest).
uniform vec3 uBodyPos;
uniform mat3 uBody;
uniform float uBodyK;
uniform float uBodyR;

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

mat2 rot(float a) {
  return mat2(cos(a), -sin(a), sin(a), cos(a));
}

// World point to the body frame: every shape is drawn there.
vec3 body(vec3 p) {
  return uBody * (p - uBodyPos);
}

// Lava lobes pressing on a flat-faced shape from inside: the sphere's lobes,
// squeezed by `sc` into the shape and shrunk to `rs`, so they bulge its faces
// a little as they pass without hiding the shape. Three lobes are enough for
// the bumps, and software GL pays for every shape on every step.
float lobePush(float d, vec3 q, vec3 sc, float rs) {
  for (int i = 0; i < 3; i++) d = smin(d, length(q - uLobes[i].xyz * sc) - uLobes[i].w * rs, 0.22);
  return d;
}

// Slow ripples: three crossed sines, much cheaper than value noise.
float ripple(vec3 p) {
  vec3 w = p * vec3(2.1, 2.6, 2.3) + vec3(uFlow * 0.7, -uFlow * 0.9, uFlow * 0.5);
  return sin(w.x + 0.8 * w.y) * sin(w.y - 0.6 * w.z) * sin(w.z + 0.7 * w.x) * uAmp * 0.35;
}

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
  d += ripple(p);
  if (uLevel > 0.002) d += (noise(p * 1.9 + vec3(0.0, uFlow * 1.3, uFlow * 0.9)) - 0.5) * uLevel * 0.17;
  return d;
}

// Alert shapes (S4). Rounded triangular prism (timer) and rounded box (other
// sources), facing the camera with a slow sway so the flat faces catch the
// light. They pulse with the breathing radius.
// Exact distance to an equilateral triangle prism (point up, inradius
// r / sqrt(3), half depth h): exact, so subtracting a radius rounds every
// edge and corner evenly.
float sdTriPrism(vec3 p, float r, float h) {
  const float k = 1.7320508;
  vec2 q = vec2(abs(p.x) - r, p.y + r / k);
  if (q.x + k * q.y > 0.0) q = vec2(q.x - k * q.y, -k * q.x - q.y) / 2.0;
  q.x -= clamp(q.x, -2.0 * r, 0.0);
  vec2 w = vec2(-length(q) * sign(q.y), abs(p.z) - h);
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0));
}

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

// Alert frame: undo the breathing scale and turn with the slow sway.
vec3 alertFrame(vec3 p) {
  p /= radius() / uRadius;
  float a = 0.35 * sin(uFlow * 0.6);
  p.xz = rot(a) * p.xz;
  p.yz = mat2(0.98, -0.2, 0.2, 0.98) * p.yz;
  return p;
}

// One body, one volume: every shape is scaled so that it holds the sphere's
// volume (4/3 pi uRadius^3), so a morph only moves the liquid around instead
// of growing or shrinking it. Measured by counting voxels inside each
// distance function (static, without lobes or ripples); the weather's comes
// per sky from skyParts() in tables.ts (uSky.w).
const float VOL_TRIANGLE = 1.562;
const float VOL_SQUARE = 1.407;
const float VOL_CLOCK = 0.919;

// Both alert shapes at once: (triangle, square). They share the transform and the shimmer.
vec2 alertShapes(vec3 p) {
  float s = radius() / uRadius;
  p = alertFrame(p);
  // Soft, well rounded bodies (a smaller core, a thick rounding) that still
  // read as a triangle and a square; the lava lobes push bumps out of their
  // faces and edges, and the sphere's slow ripples keep them liquid.
  vec3 t = p / VOL_TRIANGLE + vec3(0.0, 0.15, 0.0);
  vec3 q = p / VOL_SQUARE;
  vec2 d = vec2(sdTriPrism(t, 0.46, 0.14) - 0.17, sdRoundBox(q, vec3(0.58, 0.58, 0.34), 0.3));
  d.x = lobePush(d.x, t, vec3(0.5, 0.42, 0.45), 0.42) + ripple(t) * 1.6;
  d.y = lobePush(d.y, q, vec3(0.85, 0.8, 0.5), 0.5) + ripple(q) * 1.6;
  return d * vec2(VOL_TRIANGLE, VOL_SQUARE) * s;
}

// Clock size: larger than the blob, to be read from across the room. It
// breathes with the radius and shrinks to fit a narrow screen.
float clockScale() {
  return radius() / uRadius * 1.3 * VOL_CLOCK * min(1.0, uRes.x / uRes.y / 1.3);
}

// The clock body: a wide pill facing the camera, still liquid on its surface.
// It stays inside the clock's bounding sphere in main().
float clockShape(vec3 p) {
  float s = clockScale();
  p /= s;
  float d = lobePush(sdRoundBox(p, vec3(1.2, 0.5, 0.3), 0.3), p, vec3(2.2, 0.8, 0.9), 0.4);
  return (d + ripple(p)) * s;
}

float smax(float a, float b, float k) {
  return -smin(-a, -b, k);
}

// Weather size: like the clock, larger than the blob and fitted to a narrow screen.
float weatherScale() {
  return radius() / uRadius * 0.85 * uSky.w * min(1.0, uRes.x / uRes.y / 0.9);
}

// The sky outside, in units of the blob radius: a sun with rays that turn and
// pulse, a crescent moon, a cloud of merged puffs, and drops (or flakes) that
// drip out of the cloud's belly and fall. Each part grows or melts away with
// its weight in uSky and uFall, so one sky morphs into the next.
float weatherShape(vec3 p) {
#if WEATHER == 0
  return length(p) - radius();
#else
  float s = uRadius * weatherScale();
  vec3 q = p / s;
  float cw = uSky.z;
  // Sun or moon: centred alone, smaller and behind the cloud's top left with one.
  float orb = max(uSky.x, uSky.y);
  vec3 o = q - mix(vec3(0.0), vec3(-0.5, 0.42, -0.35), cw);
  float sr = mix(0.74, 0.5, cw);
  float d = length(o) - sr * mix(0.2, 1.0, orb) + (1.0 - orb) * 0.6;
  // Rays: eight capsules in the face plane, each on its own pulse.
  if (uSky.x > 0.01) {
    const float SECTOR = 0.7853982;
    float ang = atan(o.y, o.x) + uFlow * 0.5;
    float id = floor(ang / SECTOR + 0.5);
    float a = ang - id * SECTOR;
    vec2 rp = length(o.xy) * vec2(cos(a), sin(a));
    float rr = sr * mix(0.3, 1.0, uSky.x); // the rays retract into the orb as the sun goes
    float len = rr * (0.29 + 0.06 * sin(uFlow * 5.0 + id * 1.9)) * uSky.x;
    vec3 rq = vec3(rp.x - clamp(rp.x, rr * 0.8, rr * 1.1 + len), rp.y, o.z);
    d = smin(d, length(rq) - sr * 0.13 * uSky.x, 0.1);
  }
  d = lobePush(d, q, vec3(0.6), 0.32); // the orb only: the lobes would fill the moon's bite
  // Moon: a bite through the orb (a cylinder along the view), up and to the right.
  if (uSky.y > 0.01) {
    float bite = length(o.xy - sr * vec2(0.5, 0.3)) - sr * 0.78 + (1.0 - uSky.y) * 0.8;
    d = smax(d, -bite, 0.08);
  }
  // Cloud: four puffs that breathe out of step, a flatter belly.
  if (cw > 0.01) {
    float f = uFlow * 2.0;
    float c = length(q - vec3(0.0, 0.06, 0.0)) - 0.6 - 0.03 * sin(f);
    c = smin(c, length(q - vec3(-0.62, -0.2, 0.06)) - 0.4 - 0.03 * sin(f + 2.1), 0.2);
    c = smin(c, length(q - vec3(0.64, -0.16, 0.0)) - 0.44 - 0.03 * sin(f + 4.2), 0.2);
    c = smin(c, length(q - vec3(0.28, 0.36, -0.12)) - 0.38 - 0.03 * sin(f + 1.0), 0.2);
    c = smax(c, -(q.y + 0.5), 0.14);
    d = smin(d, c + (1.0 - cw) * 1.2, 0.12);
  }
  // Drops: fall from the belly; each swells as it drips, so it pulls a neck
  // out of the cloud (smin), and shrinks as it lands. Flakes are rounder,
  // slower and sway.
  if (uFall.x > 0.01) {
    for (int i = 0; i < LOBES; i++) {
      float fi = float(i);
      // One speed for all, fixed offsets, so they never line up; each fall
      // drops from a new spot and with a new size.
      float cyc = uFall.z + fi * 0.618;
      float ph = fract(cyc);
      vec3 rn = vec3(hash(vec3(floor(cyc), fi, 1.0)), hash(vec3(floor(cyc), fi, 2.0)), hash(vec3(floor(cyc), fi, 3.0)));
      float x = (fi - float(LOBES - 1) * 0.5) * (1.5 / float(LOBES)) + 0.16 * (rn.x - 0.5);
      x += uFall.y * 0.09 * sin(uFall.z * 9.0 + fi * 2.0);
      vec3 dq = q - vec3(x, -0.36 - ph * 0.9, 0.24 * (rn.y - 0.5));
      dq.y *= mix(0.62, 1.0, uFall.y); // raindrops are long
      float rad = mix(0.08, 0.095, uFall.y) * (0.8 + 0.4 * rn.z) * uFall.x * smoothstep(0.0, 0.18, ph) * (1.0 - smoothstep(0.78, 1.0, ph));
      d = smin(d, length(dq) - rad, 0.16);
    }
  }
  return (d + ripple(q)) * s;
#endif
}

// Shape ids (SHAPE in tables.ts): 0 sphere, 1 triangle, 2 square, 3 clock, 4 weather.
float pickShape(float id, float sphere, vec2 alerts, float clock, float weather) {
  return id < 0.5 ? sphere : (id < 1.5 ? alerts.x : (id < 2.5 ? alerts.y : (id < 3.5 ? clock : weather)));
}

bool isAlert(float id) {
  return id > 0.5 && id < 2.5;
}

bool isClock(float id) {
  return id > 2.5 && id < 3.5;
}

bool isWeather(float id) {
  return id > 3.5;
}

// Distance in the body frame: main() marches the ray already moved into it
// (the transform is affine, so the ray stays a line with the same t).
float map(vec3 p) {
  bool morph = uMix > 0.001;
  // Each distance function appears once here (not once per shape slot), so the
  // compiled shader stays small: software GL stalls the page while it compiles.
  float sphere = (uShapeA < 0.5 || (morph && uShapeB < 0.5)) ? sphereShape(p) : 0.0;
  vec2 alerts = (isAlert(uShapeA) || (morph && isAlert(uShapeB))) ? alertShapes(p) : vec2(0.0);
  float clock = (isClock(uShapeA) || (morph && isClock(uShapeB))) ? clockShape(p) : 0.0;
  float weather = (isWeather(uShapeA) || (morph && isWeather(uShapeB))) ? weatherShape(p) : 0.0;
  float a = pickShape(uShapeA, sphere, alerts, clock, weather);
  if (!morph) return a;
  // A mix of two distance fields is not a true distance: scaling it by 0.875
  // turns the usual 0.8 march step into about 0.7 while morphing.
  return mix(a, pickShape(uShapeB, sphere, alerts, clock, weather), uMix) * 0.875;
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
// Chrome reads through contrast: a sky that brightens upwards, tall strips at
// the sides and a gel rim light behind. There is no horizon: any edge or
// ridge at that height mirrors as a line that cuts the blob in two.
vec3 env(vec3 d) {
  vec3 gel = uColor;
  vec3 key = mix(vec3(1.0), gel, 0.55);
  vec3 cool = mix(vec3(1.0), gel, 0.8);
  // Sky: broad and bright, in the gel colour, whiter towards the zenith.
  float zen = smoothstep(0.15, 1.0, d.y);
  vec3 sky = gel * (0.04 + 0.9 * zen) + key * 0.35 * zen * zen * zen + cool * 0.09;
  // Black cards in the sky break it into bands, as in product shots of chrome.
  float cards = softbox(d, CARD1_A, CARD1_U, CARD1_V, vec2(0.13, 0.9), 0.12);
  cards = max(cards, softbox(d, CARD2_A, CARD2_U, CARD2_V, vec2(0.2, 0.9), 0.15));
  sky *= 1.0 - 0.92 * cards;
  // A pool of gel light bouncing up from below, so the lower half of the blob
  // still shows its volume.
  vec3 c = sky + gel * 0.13 * smoothstep(-0.3, -0.95, d.y);
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
  // Alert shapes have flat faces that would mirror one flat colour: stronger
  // ripples keep them liquid.
  float faceted = smoothstep(0.5, 1.0, mix(uShapeA, uShapeB, uMix));
  vec3 nb = normalize(n + t * s * (1.0 + faceted) - g * (0.006 + uLevel * 0.004 + 0.008 * faceted));
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

// Face plane for shape id: the sphere's face sits on its front in screen
// space; on an alert shape it turns with the sway, lower and smaller on the
// triangle so it fits inside.
vec2 faceSpace(vec3 p, float id) {
  if (id < 0.5) return p.xy / radius();
  if (isWeather(id)) return (p.xy / (uRadius * weatherScale()) - uFaceT.xy) / uFaceT.z;
  if (isClock(id)) return p.xy / (uRadius * clockScale());
  vec2 f = alertFrame(p).xy / uRadius;
  return id < 1.5 ? (f / VOL_TRIANGLE + vec2(0.0, 0.3)) / 0.62 : f / VOL_SQUARE / 0.95;
}

// Approximate ellipse distance (exact on the axes), good enough for a glow.
float sdEllipse(vec2 q, vec2 ab) {
  float k0 = length(q / ab);
  float k1 = length(q / (ab * ab));
  return k0 * (k0 - 1.0) / k1;
}

// An arc of radius ra and thickness rb, centred on +y, half aperture given by sc = (sin, cos).
float sdArc(vec2 q, vec2 sc, float ra, float rb) {
  q.x = abs(q.x);
  return ((sc.y * q.x > sc.x * q.y) ? length(q - sc * ra) : abs(length(q) - ra)) - rb;
}

// The mouth: two lips between corners at +-w (uMouthShape.x). The upper lip
// follows the smile; the lower one drops by the opening, round in the middle,
// so a closed mouth is one stroke and an open one a "D" that a pucker narrows
// into an "o". x: distance to the lips' outline, y: the dark inside (0..1),
// z: the tongue (0..1).
vec3 mouthDist(vec2 m) {
  float w = uMouthShape.x;
  float open = uMouth.y;
  m.y -= uMouthShape.y * m.x; // tilt: a lopsided grin, a "hmm"
  float lift = uMouth.x * 0.2 * w * (1.0 - 0.7 * uMouthShape.z); // corner height; a pucker flattens it
  float xc = clamp(m.x, -w, w);
  float u = xc / w;
  float arch = sqrt(max(1.0 - u * u, 0.0));
  float up = lift * u * u + open * 0.3 * arch * (0.4 + 0.6 * uMouthShape.z);
  float lo = lift * u * u - open * mix(arch, sqrt(arch), 0.5 - 0.5 * uMouthShape.z);
  // Signed distances to each lip, corrected by its slope (an approximation, plenty for a glow).
  float su = (2.0 * lift * u) / w;
  float sl = su + open * u / (w * max(arch, 0.25));
  float dUp = (m.y - up) * inversesqrt(1.0 + su * su);
  float dLo = (lo - m.y) * inversesqrt(1.0 + sl * sl);
  float inside = max(dUp, dLo);
  float dx = abs(m.x) - w;
  float fill = dx > 0.0 ? length(vec2(dx, max(inside, 0.0))) : inside;
  float cavity = smoothstep(0.012, -0.012, fill);
  // Tongue: a soft bump resting on the lower lip, inside the cavity only.
  vec2 tq = (m - vec2(0.0, lo * 0.8 - open * 0.15)) / vec2(w * 0.62, open * 0.55 + 0.001);
  float tongue = cavity * smoothstep(1.0, 0.7, length(tq)) * uMouthShape.w * smoothstep(0.02, 0.06, open);
  return vec3(abs(fill) - 0.032, cavity, tongue);
}

// Distance to the face strokes (x): two eyes (ellipses blending into happy
// arcs) and the mouth's outline; y, z: the mouth's inside and tongue.
vec3 faceDist(vec2 q) {
  float d = 1e3;
  for (int i = 0; i < 2; i++) {
    vec2 e = q - vec2(i == 0 ? -0.3 : 0.3, uEyes.z) - uGaze;
    float eye = sdEllipse(e, uEyes.xy);
    float arc = sdArc(e + vec2(0.0, 0.07), vec2(0.8, 0.6), 0.14, 0.035);
    d = min(d, mix(eye, arc, uEyes.w));
  }
  vec3 mouth = mouthDist(q - vec2(0.0, -0.35) - uGaze * 0.5);
  return vec3(min(d, mouth.x), mouth.yz);
}

// Seven-segment digits. SEG: lit segments of 0..9, bit s is segment s.
// SEG_LINE: the ends of segment s (xy to zw) in units of the digit half size.
const int SEG[10] = int[10](63, 6, 91, 79, 102, 109, 125, 7, 127, 111);
const vec4 SEG_LINE[7] = vec4[7](vec4(-1, 1, 1, 1), vec4(1, 1, 1, 0), vec4(1, 0, 1, -1), vec4(-1, -1, 1, -1),
                                 vec4(-1, 0, -1, -1), vec4(-1, 1, -1, 0), vec4(-1, 0, 1, 0));

// Distance to the clock strokes: HH:MM, in the same units as the face. A
// minute change mixes the distance to the old digits into the new ones, so
// the strokes that change melt away and grow back.
float clockDist(vec2 q) {
  const vec2 hs = vec2(0.15, 0.32); // digit half size
  vec2 d = vec2(1e3); // x: the digits shown, y: the digits before
  for (int i = 0; i < 4; i++) {
    vec2 c = q - vec2((float(i) - 1.5) * 0.48 + (i < 2 ? -0.22 : 0.22), uDigitY[i]);
    int now = SEG[clamp(int(uDigits[i] + 0.5), 0, 9)];
    int was = SEG[clamp(int(uDigitsPrev[i] + 0.5), 0, 9)];
    for (int s = 0; s < 7; s++) {
      vec2 pa = c - SEG_LINE[s].xy * hs;
      vec2 ba = (SEG_LINE[s].zw - SEG_LINE[s].xy) * hs;
      float ds = length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
      if (((now >> s) & 1) == 1) d.x = min(d.x, ds);
      if (((was >> s) & 1) == 1) d.y = min(d.y, ds);
    }
  }
  float colon = length(vec2(q.x, abs(q.y) - 0.15)) - 0.012 - 0.03 * uColon;
  return min(mix(d.y, d.x, smoothstep(0.0, 1.0, uTick)), colon) - 0.045;
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
  vec3 rc = ro - uBodyPos; // the body moves; its glow and bound follow it
  float b = -dot(rc, rd); // ray distance to the point closest to the centre
  float closest = length(rc + rd * b);
  float out_ = max(closest - r, 0.0);
  vec3 col = vec3(0.0004, 0.0004, 0.0007);
  col += uColor * min(uGlow, 1.2) * (0.026 * exp(-out_ * 5.0) + 0.0025 * exp(-out_ * 1.8));

  // Bounding sphere: rays that miss it skip the march.
  // The clock and the weather are wider; the alert shapes reach further at their corners.
  float rb = (uShapeA > 2.5 || uShapeB > 2.5) ? 1.9 : (isAlert(uShapeA) || isAlert(uShapeB)) ? 1.5 : r * 1.5 + 0.1;
  rb *= uBodyR;
  float h = b * b - (dot(rc, rc) - rb * rb);
  if (h > 0.0) {
    float t = b - sqrt(h);
    float tEnd = b + sqrt(h);
    bool hit = false;
    float d = 1.0;
    float near = 1e3; // closest pass of the ray, as distance over ray length
    float tNear = t;
    // The ray in the body frame, same t. A body distance times k bounds the
    // world distance: the squash stretches one axis.
    vec3 bo = body(ro);
    vec3 bd = uBody * rd;
    float k = uBodyK;
    for (int i = 0; i < MARCH_STEPS; i++) {
      d = map(bo + bd * t) * k;
      if (d < 0.0013 * t) { hit = true; break; }
      if (d < near * t) { near = d / t; tNear = t; }
      t += d * mix(0.86, 0.6, uLevel); // the level swells break the distance bound a little
      if (t > tEnd) break;
    }
    // A ray grazing a swell can run out of steps just above the surface;
    // counting it as a miss leaves a dark seam inside the silhouette.
    hit = hit || (d < 0.01 && t < tEnd);
    // Antialiased silhouette: a ray that only grazes the blob is shaded at its
    // closest point and blended over the background by how near it passed.
    float px = 0.83 / uRes.y; // one pixel, per unit of ray length
    float cov = hit ? 1.0 : 1.0 - smoothstep(0.0013, 0.0013 + 2.0 * px, near);
    if (cov > 0.0) {
      if (!hit) t = tNear;
      vec3 p = ro + rd * t;
      vec3 bp = bo + bd * t;
      vec3 bn = normalAt(bp); // normal in the body frame (face, lava)
      vec3 n = normalize(transpose(uBody) * bn); // the gradient back in the world
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
      float heat = lavaHeat(lavaDist(bp - bn * r * 0.22, r, 1.0), r);
#if QUALITY >= 2
      heat += 0.85 * lavaHeat(lavaDist(bp + bd * r * 0.85, r, 0.6), r); // same lobes, pulled inwards
#endif
      // The face, on the front only: a lava halo under the skin, then a near
      // white core drawn over the mirror, which goes dark around it. Light on
      // dark, so no reflection or lobe behind can hide the eyes.
      float face = 0.0;
      float cavity = 0.0;
      float tongue = 0.0;
      if (uMouth.z > 0.001) {
        vec2 fq = faceSpace(bp, uShapeA);
        if (uMix > 0.001) fq = mix(fq, faceSpace(bp, uShapeB), uMix);
        vec3 fm = faceDist(fq);
        float fd = fm.x;
        // The face melts into the digits (and back) with the shape morph.
        float ck = (isClock(uShapeA) ? 1.0 - uMix : 0.0) + (isClock(uShapeB) ? uMix : 0.0);
        if (ck > 0.001) fd = mix(fd, clockDist(fq), ck);
        float front = uMouth.z * smoothstep(0.0, 0.5, bn.z);
        cavity = min(front, 1.0) * fm.y * (1.0 - ck);
        tongue = min(front, 1.0) * fm.z * (1.0 - ck);
        heat += front * 0.4 * exp(-max(fd, 0.0) / 0.04);
        spec *= 1.0 - 0.75 * min(front, 1.0) * max(exp(-max(fd, 0.0) / 0.09), fm.y * (1.0 - ck));
        face = min(front, 1.0) * smoothstep(0.012, -0.012, fd);
      }
      float blob = min(heat, 1.0);
      vec3 hotLava = mix(uLava, vec3(1.0), 0.2 * smoothstep(0.8, 1.6, heat)); // whiter in the core
      // Glow compressed per state, so the brightest state never turns flat white.
      float g = uGlow * (1.0 + uLevel * 0.6);
      vec3 inner = uColor * 0.03 * g + hotLava * (1.0 - exp(-heat * 2.0)) * 1.25 * (0.3 + 0.45 * min(g, 1.3)) * (1.0 + 0.45 * uLevel); // the level pulses the lava in every state
      // Thin rim lit from behind: the shell is slightly translucent there.
      float rim = pow(1.0 - ndv, 3.0);
      // Where lava presses on the skin the mirror thins and the glow comes through.
      vec3 lit = spec * (1.0 - 0.15 * blob) + inner * (1.0 - 0.8 * F * (1.0 - 0.5 * blob)) + uColor * uGlow * 0.12 * rim;
      // Inside the mouth: a dim lava glow, deeper towards the top; the tongue a warmer pink.
      lit = mix(lit, uLava * 0.22, cavity);
      lit = mix(lit, mix(uLava, vec3(1.0, 0.42, 0.5), 0.6) * 0.85, tongue);
      lit = mix(lit, mix(uLava, vec3(1.0), 0.7) * 1.1, face);
      col = mix(col, lit, cov);
    }
  }

  col *= uBright * (1.0 + uFlash * 0.6);
  col = 1.0 - exp(-col * 1.4);              // soft tone map, no hard clip
  col = pow(col, vec3(1.0 / 2.2));
  col += (hash(vec3(gl_FragCoord.xy, uFlow)) - 0.5) / 255.0; // dither the dark gradients
  fragColor = vec4(col, 1.0);
}
