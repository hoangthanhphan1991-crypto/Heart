/* =============================================================
   Cupid's Heart — vanilla JS, no build step.

   Tap 1: Cupid shoots. One arrow sticks in the heart and stays there.
   Tap 2: no second arrow — the initials V / H just appear either side.
   Further taps do nothing. Reset clears it all and starts over.

   The one shot:
     draw bow (DRAW_MS) -> release + launch -> string snaps & settles
     arrow flies (FLIGHT_MS) -> sticks in heart -> heart reacts
   ============================================================= */

/* ---------- TWEAKABLES: timings in ms, sizes in px ---------- */
const DRAW_MS    = 200;   // how long Cupid pulls the string back
const SNAP_MS    = 70;    // string snapping forward on release
const SETTLE_MS  = 150;   // string wobbling back to rest
const FLIGHT_MS  = 350;   // arrow travel time. Lower = faster.

// Exactly one arrow is ever fired, straight through the middle of the heart.
// fx is kept shallow so the shaft's tail clears the "V" sitting to the left.
const ARROW_HIT = { fx: -0.20, fy: -0.02 };

const LETTER_V_DELAY = 120;  // ms before "V" pops in
const LETTER_H_DELAY = 320;  // ...then "H"

// Prompts shown under the heart at each stage
const HINT_SHOOT   = 'tap anywhere';
const HINT_LETTERS = 'tap again for the initials';


// The arrow arcs upward mid-flight by this fraction of the distance it covers,
// capped so short shots don't loop absurdly. Set to 0 for a dead-straight shot.
const ARC_RATIO  = 0.12;
const ARC_MAX    = 16;

// Bowstring nock positions, in the SVG's own 0..130 coordinate space
const NOCK_REST  = 104;   // string at rest
const NOCK_DRAWN = 78;    // string pulled fully back
const NOCK_SNAP  = 112;   // overshoot past rest on release

const SPARKLE_COUNT = 10;

/* ---------- Elements ---------- */
const stage      = document.getElementById('stage');
const bow        = document.getElementById('bow');
const bowString  = document.getElementById('bowString');
const nockArrow  = document.getElementById('nockArrow');
const drawArm    = document.getElementById('drawArmPath');
const drawArmSkin= document.getElementById('drawArmSkin');
const drawHand   = document.getElementById('drawHand');
const muzzle     = document.getElementById('muzzle');
const heartImg   = document.getElementById('heartImg');
const heartImpact= document.getElementById('heartImpact');
const stuckLayer = document.getElementById('stuckLayer');
const fxLayer    = document.getElementById('fxLayer');
const hint       = document.getElementById('hint');
const letterV    = document.getElementById('letterV');
const letterH    = document.getElementById('letterH');
const resetBtn   = document.getElementById('resetBtn');
const tabs       = document.getElementById('tabs');
const sheet      = document.getElementById('sheet');
const scrim      = document.getElementById('scrim');
const sheetClose = document.getElementById('sheetClose');

/* ---------- Arrow artwork (golden, tip at the RIGHT edge) ---------- */
const ARROW_LEN = 52;   // full arrow length. Keep ~2/3 of the flight distance.
const ARROW_H   = 20;   // if you change this, update `top` on .flyer svg in CSS

// In flight: feathers, shaft, pointed head.
const ARROW_SVG = `
<svg width="${ARROW_LEN}" height="${ARROW_H}" viewBox="0 0 ${ARROW_LEN} ${ARROW_H}">
  <g stroke="#231F20" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">
    <path d="M2,10 L15,2 L21,4 L8,11 Z" fill="#E8434F"/>
    <path d="M2,10 L15,18 L21,16 L8,9 Z" fill="#C32F39"/>
    <path d="M6,10 L39,10" fill="none" stroke-width="4"/>
    <path d="M6,10 L39,10" fill="none" stroke="#FFD24D" stroke-width="2.6"/>
    <path d="M36,2 L52,10 L36,18 L40,10 Z" fill="#FFD24D"/>
  </g>
</svg>`;

// Stuck in the heart: the same arrow minus the head. The head is "buried", so
// we simply don't draw it — shaft and feathers stay out at the flight angle.
const STUCK_SVG = `
<svg width="${ARROW_LEN}" height="${ARROW_H}" viewBox="0 0 ${ARROW_LEN} ${ARROW_H}">
  <g stroke="#231F20" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">
    <path d="M2,10 L15,2 L21,4 L8,11 Z" fill="#E8434F"/>
    <path d="M2,10 L15,18 L21,16 L8,9 Z" fill="#C32F39"/>
    <path d="M6,10 L50,10" fill="none" stroke-width="4"/>
    <path d="M6,10 L50,10" fill="none" stroke="#FFD24D" stroke-width="2.6"/>
  </g>
</svg>`;

/* ---------- Small helpers ---------- */
const rand = (a, b) => a + Math.random() * (b - a);
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeOutQuad  = t => 1 - (1 - t) * (1 - t);
// damped wobble, for the string settling back to rest
const easeWobble   = t => 1 - Math.cos(t * Math.PI * 1.5) * Math.exp(-t * 4);

/** requestAnimationFrame tween; resolves when done. */
function tween(from, to, duration, ease, onUpdate) {
  return new Promise(resolve => {
    const t0 = performance.now();
    (function frame(now) {
      const p = Math.min(1, (now - t0) / duration);
      onUpdate(from + (to - from) * ease(p));
      p < 1 ? requestAnimationFrame(frame) : resolve();
    })(t0);
  });
}

/** Move the bowstring's middle point; arrow and draw-hand follow it. */
function setNock(x) {
  bowString.setAttribute('points', `104,26 ${x.toFixed(1)},72 104,118`);
  nockArrow.setAttribute('transform', `translate(${(x - NOCK_REST).toFixed(1)},0)`);
  // The hand stays gripping the string, so the arm stretches as he pulls.
  // The arm is drawn twice — a fat black stroke under a skin-coloured one —
  // so both paths need the same geometry.
  drawHand.setAttribute('cx', x.toFixed(1));
  const d = `M64,84 C80,82 ${(x - 10).toFixed(1)},78 ${x.toFixed(1)},72`;
  drawArm.setAttribute('d', d);
  drawArmSkin.setAttribute('d', d);
}

/* ---------- Quadratic bezier, for the arrow's slight arc ---------- */
const qbez = (p0, p1, p2, t) => ({
  x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x,
  y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y,
});
const qtan = (p0, p1, p2, t) => ({            // derivative = direction of travel
  x: 2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x),
  y: 2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y),
});
const degOf = v => Math.atan2(v.y, v.x) * 180 / Math.PI;

/* =============================================================
   The shot
   ============================================================= */

/** Fly the arrow from the bow into the heart. */
function launchArrow() {
  const box = stage.getBoundingClientRect();

  // Launch point: wherever the invisible muzzle marker currently is. It moves
  // with Cupid's float, so arrows always leave the bow itself.
  const m = muzzle.getBoundingClientRect();
  const p0 = { x: m.left + m.width / 2 - box.left, y: m.top + m.height / 2 - box.top };

  const { fx, fy } = ARROW_HIT;

  // Screen target uses the LIVE rect, which includes the current beat scale...
  const r = heartImg.getBoundingClientRect();
  const p2 = {
    x: r.left + r.width  * (0.5 + fx) - box.left,
    y: r.top  + r.height * (0.5 + fy) - box.top,
  };
  // ...while the stuck arrow uses the UNSCALED layout size, because it lives
  // inside the heart and gets scaled by the heartbeat itself.
  const localX = heartImg.offsetWidth  * (0.5 + fx);
  const localY = heartImg.offsetHeight * (0.5 + fy);

  // Control point lifted above the midpoint gives the flight its gentle arc.
  const dist = Math.hypot(p2.x - p0.x, p2.y - p0.y);
  const lift = Math.min(ARC_MAX, dist * ARC_RATIO);
  const p1 = { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 - lift };

  const flyer = document.createElement('div');
  flyer.className = 'flyer';
  flyer.innerHTML = ARROW_SVG;
  fxLayer.appendChild(flyer);

  // Sample the curve into keyframes, rotating each to face along the path.
  const STEPS = 12;
  const frames = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const p = qbez(p0, p1, p2, t);
    frames.push({
      transform: `translate(${p.x}px, ${p.y}px) rotate(${degOf(qtan(p0, p1, p2, t))}deg)`,
      offset: t,
    });
  }
  const impactAngle = degOf(qtan(p0, p1, p2, 1));

  // If Reset runs while this arrow is in the air, the generation changes and
  // the landing is discarded instead of adding a stray arrow afterwards.
  const gen = generation;

  const anim = flyer.animate(frames, { duration: FLIGHT_MS, easing: 'linear', fill: 'forwards' });
  anim.finished
    .then(() => {
      flyer.remove();
      if (gen !== generation) return;
      stickArrow(localX, localY, impactAngle);
      hitHeart();
      sparkle(p2.x, p2.y);
      resetBtn.classList.add('show');        // there's now something to clear
      arrowLanded = true;
      if (lettersWanted) revealLetters();    // they already asked, mid-flight
      else showHint(HINT_LETTERS);           // invite the second tap
    })
    .catch(() => flyer.remove());   // animation cancelled (e.g. tab backgrounded)
}

/** Pin a headless arrow into the heart. It rides the heartbeat and stays
 *  there until Reset — nothing removes it on a timer any more. */
function stickArrow(x, y, angle) {
  const el = document.createElement('div');
  el.className = 'stuck';
  el.innerHTML = STUCK_SVG;
  el.style.left = x + 'px';
  el.style.top  = y + 'px';
  el.style.transform = `rotate(${angle}deg)`;   // rotates about the tip (see CSS)
  stuckLayer.appendChild(el);
}

/** "V" on the left, then "H" on the right, a beat apart. */
function revealLetters() {
  hint.classList.add('gone');
  setTimeout(() => letterV.classList.add('show'), LETTER_V_DELAY);
  setTimeout(() => letterH.classList.add('show'), LETTER_H_DELAY);
}

function showHint(text) {
  hint.textContent = text;
  hint.classList.remove('gone');
}

/** Big pulse + shake. Restarts cleanly if an arrow lands mid-reaction. */
function hitHeart() {
  heartImpact.classList.remove('hit');
  void heartImpact.offsetWidth;        // force reflow so the animation replays
  heartImpact.classList.add('hit');
  // Android/Chrome only — iOS Safari ignores vibrate(), so it's a silent no-op.
  if (navigator.vibrate) navigator.vibrate(12);
}

/** Burst of little hearts and golden sparkles at the impact point. */
function sparkle(x, y) {
  for (let i = 0; i < SPARKLE_COUNT; i++) {
    const el = document.createElement('div');
    const isHeart = i % 2 === 0;
    el.className = isHeart ? 'spark spark-heart' : 'spark';
    if (isHeart) el.textContent = '♥';
    fxLayer.appendChild(el);

    const ang  = rand(-Math.PI, Math.PI);
    const dist = rand(28, 78);
    el.animate([
      { transform: `translate(${x}px, ${y}px) translate(-50%,-50%) scale(.3)`, opacity: 1 },
      { transform: `translate(${x + Math.cos(ang) * dist}px, ${y + Math.sin(ang) * dist - 18}px)`
                 + ` translate(-50%,-50%) scale(1)`, opacity: 0 },
    ], { duration: rand(520, 780), easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' })
      .finished.then(() => el.remove()).catch(() => el.remove());
  }
}

/** One complete draw-and-release. */
async function doShot() {
  nockArrow.setAttribute('opacity', '1');            // arrow appears on the string
  await tween(NOCK_REST, NOCK_DRAWN, DRAW_MS, easeOutCubic, setNock);

  // Release: arrow leaves, bow recoils, string snaps forward past rest...
  nockArrow.setAttribute('opacity', '0');
  launchArrow();
  bow.classList.remove('wobble');
  void bow.getBoundingClientRect();                  // force reflow to replay
  bow.classList.add('wobble');

  await tween(NOCK_DRAWN, NOCK_SNAP, SNAP_MS, easeOutQuad, setNock);
  // ...then wobbles back to rest.
  await tween(NOCK_SNAP, NOCK_REST, SETTLE_MS, easeWobble, setNock);
  nockArrow.setAttribute('opacity', '1');            // he nocks a fresh arrow
}

/* =============================================================
   Tap handling

   phase 0 -> first tap fires the one arrow
   phase 1 -> second tap reveals the initials (no arrow)
   phase 2 -> done; only Reset does anything
   ============================================================= */
let phase = 0;
let busy = false;          // true while Cupid is drawing/releasing
let arrowLanded = false;
let lettersWanted = false; // second tap arrived while the arrow was still flying
let generation = 0;        // bumped by Reset, to orphan an in-flight arrow

async function fireArrow() {
  if (busy) return;
  busy = true;
  await doShot();
  busy = false;
}

function onTap(e) {
  // the buttons, tabs and info sheet all handle their own taps
  if (e.target.closest &&
      e.target.closest('#resetBtn, #tabs, #sheet, #scrim')) return;
  // don't shoot through an open sheet (sheet may be absent — guard it, or a
  // missing panel would throw here and kill tapping entirely)
  if (sheet && sheet.classList.contains('open')) return;

  if (phase === 0) {
    phase = 1;
    hint.classList.add('gone');
    fireArrow();
  } else if (phase === 1) {
    phase = 2;
    // If the arrow is still in the air, hold the reveal until it lands.
    if (arrowLanded) revealLetters();
    else lettersWanted = true;
  }
  // phase 2: nothing left to do
}

/** Back to a clean heart: no arrow, no initials, ready to shoot again. */
function reset() {
  generation++;                       // any arrow mid-flight is now void
  stuckLayer.replaceChildren();
  fxLayer.replaceChildren();
  letterV.classList.remove('show');
  letterH.classList.remove('show');
  resetBtn.classList.remove('show');
  phase = 0;
  arrowLanded = false;
  lettersWanted = false;
  showHint(HINT_SHOOT);
  setNock(NOCK_REST);
  nockArrow.setAttribute('opacity', '1');
}

resetBtn.addEventListener('click', reset);

/* The core interaction is wired FIRST and on its own. Nothing optional below
   may run before this — if it threw, the app would silently stop responding
   to taps altogether. */
// pointerdown fires immediately, unlike click's settle delay on some setups
window.addEventListener('pointerdown', onTap, { passive: true });
// Belt and braces: stop iOS double-tap zoom and long-press menus.
window.addEventListener('dblclick', e => e.preventDefault());
window.addEventListener('contextmenu', e => e.preventDefault());

setNock(NOCK_REST);          // put the string at rest on load

/* =============================================================
   Info tabs — "The Heart" and "The Arrow"

   Tapping a tab slides the sheet up with that panel. Tapping the
   active tab again, the X, or the dimmed backdrop closes it.

   Guarded: if any of this markup is missing the tabs just do
   nothing, rather than taking the whole app down with them.
   ============================================================= */
let openPanel = null;

function showPanel(name) {
  openPanel = name;
  document.querySelectorAll('.panel').forEach(p =>
    p.classList.toggle('active', p.id === 'panel-' + name));
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.panel === name));
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  scrim.classList.add('show');
  sheet.scrollTop = 0;
}

function closeSheet() {
  openPanel = null;
  if (!sheet) return;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  scrim.classList.remove('show');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
}

if (tabs && sheet && scrim && sheetClose) {
  tabs.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    // tapping the tab that's already open closes the sheet
    if (tab.dataset.panel === openPanel) closeSheet();
    else showPanel(tab.dataset.panel);
  });

  sheetClose.addEventListener('click', closeSheet);
  scrim.addEventListener('click', closeSheet);
  window.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
}
