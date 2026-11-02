// Calculator wiring for the three calculator pages. Strings and data come from the page's JSON block
// (#calc-data, written by build.mjs); the maths is radio.js, the engine port. Comma or dot decimals,
// feet and inches with fractions, a unit switch that converts what is typed, results with the
// formula and the source, and every status as icon + word + colour. Builds DOM nodes with text
// only (user input never becomes markup). Nothing is sent or stored. Pattern from Notchline
// tools/site/static/calc-ui.js (studio §12).
import * as R from './radio.js';

const ICON = {
  good: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 22 20.5H2z"/><path d="M12 10v4.5M12 17.6v.1"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="m8.5 8.5 7 7m0-7-7 7"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.4v.1"/></svg>',
};

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
const svg = (kind) => { const s = document.createElement('span'); s.innerHTML = ICON[kind]; return s.firstChild; };

function init(form, D) {
  const T = D.t;
  const NB = ' ';
  const res = document.getElementById('res');
  document.getElementById('calc-nojs')?.setAttribute('hidden', '');
  res.hidden = false;
  let units = form.querySelector('input[name="units"]:checked')?.value || D.units;

  // ---- formatting ----
  const nf = (d, min = 0, grouping = true) => new Intl.NumberFormat(D.locale, { maximumFractionDigits: d, minimumFractionDigits: min, useGrouping: grouping });
  const num = (x, d, min = 0) => nf(d, min).format(Math.abs(x) < 0.5 * 10 ** -d ? 0 : x);
  const fill = (s, o) => String(s).replace(/\{([a-z0-9]+)\}/gi, (m, k) => (k in o ? o[k] : m));
  const mhz = (f) => `${num(f / 1e6, 4)}${NB}${T.mhz}`;
  const db = (x, d = 2) => `${num(x, d, d)}${NB}${T.db}`;
  const watts = (x) => `${num(x, x < 10 ? 2 : x < 100 ? 1 : 0)}${NB}${T.w}`;
  const metres = (m) => (Math.abs(m) < 1 ? `${num(m * 100, 1, 1)}${NB}${T.cm}` : `${num(m, 2, 2)}${NB}${T.m}`);
  const feet = (m) => (Math.abs(m) < R.FOOT ? R.formatFeet(m / R.FOOT).replace(/^(-?)0′ /, '$1') : R.formatFeet(m / R.FOOT));
  const len = (m) => (units === 'ft' ? feet(m) : metres(m));
  const lenAlt = (m) => (units === 'ft' ? metres(m) : feet(m));
  /** Lengths inside formula lines (monospaced: no fraction glyphs). */
  const lenPlain = (m) => (units === 'ft' ? R.formatFeet(m / R.FOOT, { ascii: true }) : metres(m));
  const lenInput = (m) => (units === 'ft' ? R.formatFeet(m / R.FOOT, { ascii: true }) : nf(3, 0, false).format(m));
  const input = (x, d = 4) => nf(d, 0, false).format(x);

  // ---- reading inputs: undefined = invalid (message shown), null = empty optional field ----
  const errOf = (el) => document.getElementById(`${el.id}-err`);
  function bad(el, msg) { el.setAttribute('aria-invalid', 'true'); const e = errOf(el); if (e) { e.textContent = msg; e.hidden = false; } return undefined; }
  function clear(el) { el.removeAttribute('aria-invalid'); const e = errOf(el); if (e) { e.textContent = ''; e.hidden = true; } }
  function read(id, { length = false, optional = false, min = 'positive' } = {}) {
    const el = document.getElementById(id);
    const raw = el.value.trim();
    if (!raw) { if (optional) { clear(el); return null; } return bad(el, T.errEmpty); }
    const feetMode = length && units === 'ft';
    const v = feetMode ? R.parseFeet(raw, D.decimal) : R.parseNumber(raw, D.decimal);
    if (!Number.isFinite(v)) return bad(el, feetMode ? T.errFeet : T.errNumber);
    if ((min === 'positive' && !(v > 0)) || (min === 'zero' && v < 0)) return bad(el, T.errPositive);
    clear(el);
    return length && feetMode ? v * R.FOOT : v;
  }
  const radio = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;

  // ---- result pieces ----
  const flag = (kind, word, text) => h('div', { class: `flag ${kind}` }, svg(kind), h('p', null, h('span', { class: 'flag-word' }, word), text));
  const kv = (rows) => h('ul', { class: 'kv' }, rows.filter(Boolean).map(([a, b]) => h('li', null, h('span', null, a), h('b', null, b))));
  const how = (...lines) => h('div', { class: 'how' }, h('p', { class: 'how-h' }, T.howTitle), lines.filter(Boolean).map((l) => (l instanceof Node ? l : h('p', null, l))));
  const show = (...nodes) => res.replaceChildren(...nodes.flat().filter(Boolean));
  const waiting = (msg) => show(h('p', { class: 'res-what' }, msg));

  // ---- shared controls ----
  form.addEventListener('submit', (e) => e.preventDefault());
  for (const group of form.querySelectorAll('[data-band-for]')) {
    const target = document.getElementById(group.dataset.bandFor);
    const sync = () => {
      const v = R.parseNumber(target.value, D.decimal);
      for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.f) - v) < 1e-9));
    };
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      target.value = input(Number(b.dataset.f));
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
    target.addEventListener('input', sync);
    sync();
  }
  for (const el of form.querySelectorAll('input[name="units"]')) {
    el.addEventListener('change', () => {
      const next = radio('units');
      if (next === units) return;
      const values = [...form.querySelectorAll('input[data-kind="length"]')].map((f) => [f, f.value.trim() ? read(f.id, { length: true, optional: true, min: 'zero' }) : null]);
      units = next;
      for (const [f, m] of values) if (m != null) { f.value = lenInput(m); clear(f); }
      for (const u of form.querySelectorAll('[data-unit="len"]')) u.textContent = units === 'ft' ? 'ft-in' : 'm';
      run();
    });
  }

  const calcs = { dipole: dipoleCalc, coax: coaxCalc, rf: rfCalc };
  const run = calcs[form.dataset.calc]();
  form.addEventListener('input', run);
  form.addEventListener('change', run);
  run();

  // ---- dipole + trim ------------------------------------------------------------------------
  function dipoleCalc() {
    const kEl = document.getElementById('d-k');
    const arrlBtn = document.getElementById('d-arrl');
    const lenEl = document.getElementById('t-len');
    let arrl = false;
    let lenTyped = false;
    arrlBtn.addEventListener('click', () => {
      arrl = !arrl;
      arrlBtn.setAttribute('aria-pressed', String(arrl));
      kEl.value = input(arrl ? D.arrlK : D.defaultK, arrl ? 4 : 2);
      run();
    });
    kEl.addEventListener('input', () => { arrl = false; arrlBtn.setAttribute('aria-pressed', 'false'); });
    lenEl.addEventListener('input', () => { lenTyped = lenEl.value.trim() !== ''; });

    return () => {
      const f = read('d-f');
      const kTyped = read('d-k');
      const k = arrl ? D.arrlK : kTyped;
      if (f === undefined || k === undefined) return waiting(T.waiting);
      const d = R.dipole(f * 1e6, k);
      if (d.value == null) {
        if (d.findings.some((x) => x.field === 'K')) bad(kEl, T.kRange);
        return show(flag('stop', T.stop, d.findings.some((x) => x.field === 'K') ? T.kRange : T.waiting));
      }
      const v = d.value;
      if (!lenTyped) { lenEl.value = lenInput(v.length); clear(lenEl); }
      const design = h('section', null,
        h('h3', null, T.total),
        h('p', { class: 'big' }, len(v.length)),
        h('p', { class: 'alt' }, lenAlt(v.length)),
        kv([[T.leg, `${len(v.leg)} · ${lenAlt(v.leg)}`], [T.halfWave, `${len(v.freeSpaceHalfWave)} · ${lenAlt(v.freeSpaceHalfWave)}`]]),
        how(fill(T.lengthFormula, { k: num(k, 4), f: num(f, 4), l: metres(v.length) }), Math.abs(k - D.arrlK) < 1e-12 ? fill(T.arrlNote, { k: num(k, 4) }) : null),
      );

      const L = read('t-len', { length: true });
      const fm = read('t-meas', { optional: true });
      let trim;
      if (L === undefined || fm === undefined) trim = h('section', null, h('p', { class: 'res-what' }, T.trimWaiting));
      else if (fm === null) trim = h('section', null, h('p', { class: 'res-what' }, T.trimWaiting));
      else {
        const t = R.trimToTarget({ length: L, measured: fm * 1e6, target: f * 1e6, legs: 2 });
        const kk = R.learnEndEffect({ length: L, resonance: fm * 1e6 });
        if (t.value == null) trim = h('section', null, flag('stop', T.stop, T.trimWaiting));
        else {
          const s = t.value;
          trim = h('section', null,
            s.action === 'none'
              ? flag('good', T.onTarget, fill(T.onTargetDetail, { target: mhz(f * 1e6) }))
              : [h('h3', null, s.action === 'cut' ? T.cutLegs : T.addLegs), h('p', { class: 'big' }, len(Math.abs(s.perLeg))), h('p', { class: 'alt' }, lenAlt(Math.abs(s.perLeg)))],
            t.findings.some((x) => x.issue === 'ruleOfThumb') ? flag('warn', T.warning, T.large) : null,
            kv([[T.newLength, `${len(s.newLength)} · ${lenAlt(s.newLength)}`], kk.value != null ? [T.learnedK, num(kk.value, 4)] : null]),
            kk.findings.length ? flag('warn', T.warning, fill(T.learnedKOut, { k: num(kk.value, 3) })) : h('p', { class: 'note' }, T.learnedKNote),
            how(fill(T.trimFormula, { l: lenPlain(L), fm: mhz(fm * 1e6), ft: mhz(f * 1e6), lnew: lenPlain(s.newLength) })),
          );
        }
      }
      show(design, trim);
    };
  }

  // ---- coax loss + SWR ----------------------------------------------------------------------
  function coaxCalc() {
    const cables = Object.fromEntries(R.readCables({ cables: D.cables }).map((c) => [c.id, c]));
    const sel = document.getElementById('c-cable');
    const hint = document.getElementById('c-cable-hint');
    return () => {
      const c = cables[sel.value];
      hint.textContent = fill(T.cableLine, { z: num(c.impedance, 0), vf: num(c.velocityFactor, 2, 2), maker: c.maker });
      const f = read('c-f');
      const L = read('c-len', { length: true });
      const swrEl = document.getElementById('c-swr');
      let swr = read('c-swr', { optional: true, min: 'zero' });
      if (swr != null && swr < 1) swr = bad(swrEl, T.swrBelowOne);
      const p = read('c-p', { optional: true });
      if (f === undefined || L === undefined || swr === undefined || p === undefined) return waiting(T.waiting);
      const at = radio('c-at') || 'input';
      const ml = R.matchedLoss(c, f * 1e6, L);
      const source = h('p', null, h('a', { href: `#src-cable-${c.id}` }, `${T.datasheet}: ${c.name}`));
      if (ml.value == null) {
        return show(flag('stop', T.stop, fill(T.range, { cable: c.name, min: mhz(R.CABLE_MIN_F), max: mhz(c.maxFrequency) })), how(source));
      }
      const per = R.cableLossPerMetre(c, f * 1e6);
      const lossLine = per.how.model === 'coefficients'
        ? fill(T.makerFormula, { k1: num(c.k1, 5), k2: num(c.k2, 5), f: num(f, 4), a: num(per.value * 30.48, 3) })
        : fill(T.makerTable, { f0: mhz(per.how.f0), f1: mhz(per.how.f1), a: num(per.value * 100, 2) });
      const below = ml.findings.some((x) => x.issue === 'outOfRange') ? flag('warn', T.warning, fill(T.belowTable, { f: mhz(c.table[0].frequency) })) : null;
      const r = R.feedlineRun(c, { frequency: f * 1e6, length: L, swr: swr ?? 1, measuredAt: at, power: p });
      if (r.value == null) {
        const ns = r.findings.find((x) => x.issue === 'noSolution');
        return show(
          h('h3', null, T.matched), h('p', { class: 'big' }, db(ml.value)),
          ns ? flag('stop', T.stop, fill(T.rigSwr, { max: num(ns.limit, 2, 2) })) : flag('stop', T.stop, T.waiting),
          below, how(lossLine, source),
        );
      }
      const v = r.value;
      const x = R.reflection(v.swrLoad);
      const high = r.findings.some((y) => y.issue === 'highLoss') || ml.findings.some((y) => y.issue === 'highLoss');
      show(
        h('section', null,
          h('h3', null, T.matched),
          h('p', { class: 'big' }, db(ml.value)),
          kv([[T.total, db(v.totalLoss)]]),
          h('div', { class: 'pair' },
            h('div', null, h('span', null, T.swrRadio), h('b', null, num(v.swrInput, 2, 2))),
            h('div', null, h('span', null, T.swrAntenna), h('b', null, num(v.swrLoad, 2, 2)))),
          kv([
            p != null ? [T.reaches, fill(T.reachesOf, { p: watts(v.toLoad), sent: watts(p) })] : null,
            p != null ? [T.heat, watts(v.lost)] : null,
            [T.returnLoss, Number.isFinite(x.returnLoss) ? (x.returnLoss > 60 ? `> 60${NB}${T.db}` : db(x.returnLoss, 1)) : `> 60${NB}${T.db}`],
            [T.mismatch, db(x.mismatchLoss)],
          ]),
          below,
          high ? flag('warn', T.warning, T.highLoss) : null,
          how(lossLine, fill(T.totalFormula, { a: num(10 ** (ml.value / 10), 4), rho: num(v.rhoLoad, 4) }), source),
        ),
      );
    };
  }

  // ---- RF exposure (US) ---------------------------------------------------------------------
  function rfCalc() {
    const rules = R.readExposureRules(D.exposure, 'us');
    const modeSel = document.getElementById('r-mode');
    const modeHint = document.getElementById('r-mode-hint');
    const groups = form.querySelectorAll('[data-time]');
    return () => {
      const time = radio('r-time') || 'share';
      for (const g of groups) g.hidden = g.dataset.time !== time;
      const entry = rules.modeTable.factors[modeSel.value];
      modeHint.textContent = `${fill(T.modeFactor, { f: num(entry.factor, 1, 1) })} · ${entry.grade === 'sourced' ? 'OET-65 Supplement B, Table 2' : T.estimate}`;
      const f = read('r-f');
      const pep = read('r-pep');
      let timing = { fraction: 1 };
      let timeBad = false;
      if (time === 'share') {
        const s = read('r-share');
        if (s === undefined) timeBad = true;
        else if (s > 100) { bad(document.getElementById('r-share'), T.badShare); timeBad = true; } else timing = { fraction: s / 100 };
      } else if (time === 'cycle') {
        const on = read('r-on');
        const off = read('r-off', { min: 'zero' });
        if (on === undefined || off === undefined) timeBad = true; else timing = { onS: on * 60, offS: off * 60 };
      }
      const loss = read('r-loss', { min: 'zero' });
      const gain = read('r-gain', { min: 'any' });
      const sep = read('r-sep', { length: true, optional: true });
      if (f === undefined || pep === undefined || timeBad || loss === undefined || gain === undefined || sep === undefined) return waiting(T.waiting);
      const e = R.evaluateExposure(rules, {
        frequencyHz: f * 1e6, pepW: pep, mode: modeSel.value, timing, feedlineLossDb: loss, gainDbi: gain,
        magneticLoop: document.getElementById('r-loop').checked, separationM: sep,
      });
      const near = e.findings.find((x) => x.issue === 'nearField');
      if (R.blocked(e)) {
        const out = e.findings.find((x) => x.issue === 'outOfRange' && x.field === 'f');
        if (out) return show(flag('stop', T.stop, fill(T.outOfRange, { f: mhz(f * 1e6) })));
        if (near) return show(flag('stop', T.nearTitle, fill(T.loopBlock, { b: len(near.limit) })));
        return show(flag('stop', T.stop, T.bad));
      }
      // Neighbours first: the uncontrolled distance is the one that usually decides.
      const order = { uncontrolled: 0, generalPublic: 0, controlled: 1 };
      const tiers = [...e.tiers].sort((a, b) => order[a.tier] - order[b.tier]).map((t) => h('div', { class: 'tier' },
        h('h4', null, T[`tier_${t.tier}`]),
        h('p', { class: 'who' }, T[`tierHelp_${t.tier}`]),
        h('p', { class: 'big' }, len(t.distance)),
        h('p', { class: 'alt' }, `${T.minDistance} · ${lenAlt(t.distance)}`),
        t.meets === true ? flag('good', fill(T.meets, { d: len(sep) }), '') : null,
        t.meets === false ? flag('stop', fill(T.tooClose, { d: len(sep) }), '') : null,
        h('p', { class: 'note' }, fill(T.limitLine, { limit: `${num(t.sEq / 10, 4)}${NB}mW/cm²`, window: num(t.averagingS / 60, 0), clause: t.clause })),
        h('p', { class: 'note' }, fill(T.freeSpace, { d: len(t.distanceFree) })),
        how(
          fill(T.stepAverage, { pep: watts(pep), mode: num(e.modeFactor, 2), on: `${num(t.onFraction * 100, 1)}${NB}%`, avg: watts(t.average) }),
          fill(T.stepAntenna, { loss: db(loss, 1), p: watts(t.antennaW) }),
          fill(T.stepEirp, { gain: `${num(gain, 2)}${NB}dBi`, eirp: watts(t.eirp), erp: watts(t.erp) }),
          fill(T.distanceFormula, { eirp: num(t.eirp, 2), s: `${num(t.sEq, 4)}${NB}W/m²`, r: metres(t.distance) }),
        ),
      ));
      const notes = [];
      if (near) notes.push(flag('info', T.nearTitle, fill(document.getElementById('r-loop').checked ? T.loopWarn : T.near, { b: len(near.limit) })));
      if (e.exemption) {
        notes.push(e.exemption.exempt
          ? flag('good', fill(T.exempt, { d: len(sep) }), fill(T.exemptText, { erp: watts(e.exemption.erp), t: watts(e.exemption.threshold) }))
          : flag('info', fill(T.notExempt, { d: len(sep) }), fill(T.notExemptText, { erp: watts(e.exemption.erp), t: watts(e.exemption.threshold) })));
      }
      const na = e.findings.find((x) => x.issue === 'exemptionNotApplicable');
      if (na) notes.push(flag('info', T.exemptNa, fill(T.exemptNaText, { d: len(sep), b: len(na.limit) })));
      show(tiers, notes);
    };
  }
}

const form = document.getElementById('calc-form');
const dataEl = document.getElementById('calc-data');
if (form && dataEl) init(form, JSON.parse(dataEl.textContent));
