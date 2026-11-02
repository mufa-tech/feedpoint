// The maths of the website's three calculators: a line-by-line port of the parts of
// packages/radio_core they use, reading the same data files as the app (packages/radio_data/data
// cables.json and exposure_limits.json, embedded in each page by build.mjs).
//   A1  half-wave dipole        antenna/wire.dart  resonantLength, dipole
//   A9  trim from measurement   antenna/trim.dart  trimToTarget, learnEndEffect
//   F1  matched cable loss      feedline/cable.dart  cableLossPerMetre, matchedLoss
//   F2  loss with mismatch      feedline/mismatch.dart  lossWithMismatch, feedlineRun
//   X   SWR, ρ, return loss     feedline/reflection.dart
//   R   US RF exposure          exposure/limits.dart, formulas.dart, evaluation.dart (far field)
// SI in and out (m, Hz, W, W/m², s). Like the engine, nothing here throws on user input: every
// function returns { value, findings, how }, value null when a finding blocks. Findings carry the
// engine's issue and severity names, so calc.test.mjs compares them with the Dart engine's
// (tools/site/engine-samples.json) to 1e-9. No network, no storage: pure functions.

export const C = 299792458;
export const FOOT = 0.3048;
export const INCH = 0.0254;

// ---- result helpers (radio_core/lib/src/result.dart, guard.dart) ------------------------------

const finding = (issue, severity, { field = null, limit = null, actual = null, ref = null } = {}) => ({ issue, severity, field, limit, actual, ref });
const ok = (value, how = {}, findings = []) => ({ value, how, findings });
const fail = (findings, how = {}) => ({ value: null, how, findings });
export const blocked = (r) => r.findings.some((f) => f.severity === 'block');

/** guard(): positive, then non-negative, then finite entries, each [name, value]. */
function guard({ positive = [], nonNegative = [], finite = [] } = {}) {
  const out = [];
  const check = (list, good) => {
    for (const [field, v] of list) {
      if (!Number.isFinite(v)) out.push(finding('nonFinite', 'block', { field }));
      else if (!good(v)) out.push(finding('invalidInput', 'block', { field, actual: v }));
    }
  };
  check(positive, (v) => v > 0);
  check(nonNegative, (v) => v >= 0);
  check(finite, () => true);
  return out;
}
const finiteOrOverflow = (v, how) => (Number.isFinite(v) ? ok(v, how) : fail([finding('outOfRange', 'block', { field: 'result' })], how));

// ---- A1 dipole, A9 trim (antenna/wire.dart, antenna/trim.dart) ---------------------------------

/** Default end-effect factor K for a thin wire (standards.md A1). */
export const DEFAULT_K = 0.95;
/** The K in the ARRL rule 468/f ft: 468 / (c/2 in ft·MHz) = 0.951662. */
export const ARRL_K = (468 * FOOT * 2e6) / C;
/** Accepted K range, both ends inclusive. */
export const MIN_K = 0.8;
export const MAX_K = 1.1;
/** Above this share of the length a single correction gets a "cut in steps" warning. */
export const TRIM_LARGE = 0.1;

const lambda = (f) => C / f;

function fk(f, k) {
  const bad = guard({ positive: [['frequency', f], ['K', k]] });
  if (!bad.length && (k < MIN_K || k > MAX_K)) return [finding('outOfRange', 'block', { field: 'K', limit: k < MIN_K ? MIN_K : MAX_K, actual: k })];
  return bad;
}

/** K · wavelengths · λ, m. */
export function resonantLength(f, { wavelengths = 0.5, k = DEFAULT_K } = {}) {
  const bad = [...fk(f, k), ...guard({ positive: [['wavelengths', wavelengths]] })];
  if (bad.length) return fail(bad);
  const lam = lambda(f);
  return finiteOrOverflow(k * wavelengths * lam, { f, n: wavelengths, K: k, lambda: lam });
}

/** A1: flat half-wave dipole K·λ/2 (468/f ft when K = ARRL_K). */
export function dipole(f, k = DEFAULT_K) {
  const r = resonantLength(f, { k });
  if (r.value == null) return fail(r.findings, r.how);
  return ok({ length: r.value, leg: r.value / 2, k, freeSpaceHalfWave: lambda(f) / 2 }, r.how);
}

const action = (change) => (change < 0 ? 'cut' : change > 0 ? 'add' : 'none');
const large = (change, length) => (Math.abs(change) > TRIM_LARGE * length ? [finding('ruleOfThumb', 'warning', { field: 'change', limit: TRIM_LARGE * length, actual: change })] : []);

/** A9: L_new = L · f_measured / f_target; the change is shared between `legs`. */
export function trimToTarget({ length, measured, target, legs = 1 }) {
  const bad = [
    ...guard({ positive: [['length', length], ['measured', measured], ['target', target]] }),
    ...(legs < 1 ? [finding('invalidInput', 'block', { field: 'legs', limit: 1, actual: legs })] : []),
  ];
  if (bad.length) return fail(bad);
  const newLength = measured === target ? length : (length * measured) / target;
  const how = { L: length, fMeas: measured, fTarget: target, legs, Lnew: newLength };
  if (!Number.isFinite(newLength) || !(newLength > 0)) return fail([finding('outOfRange', 'block', { field: 'result' })], how);
  const change = newLength - length;
  return ok({ length, newLength, legs, change, perLeg: change / legs, action: action(change) }, how, large(change, length));
}

/** The antenna's own end-effect factor from one measurement: K = L / (n·c/f). */
export function learnEndEffect({ length, resonance, wavelengths = 0.5 }) {
  const bad = guard({ positive: [['L', length], ['f', resonance], ['n', wavelengths]] });
  if (bad.length) return fail(bad);
  const r = finiteOrOverflow(length / (wavelengths * lambda(resonance)), { L: length, f: resonance, n: wavelengths });
  const v = r.value;
  if (v == null || (v >= MIN_K && v <= MAX_K)) return r;
  return ok(v, r.how, [finding('outOfRange', 'warning', { field: 'K', limit: v < MIN_K ? MIN_K : MAX_K, actual: v })]);
}

// ---- F1 cables (feedline/cable.dart) ------------------------------------------------------------

/** Lowest frequency any cable loss is given for (inclusive), Hz. */
export const CABLE_MIN_F = 1e6;
/** Total loss at or above which a high-loss warning is attached, dB. */
export const HIGH_LOSS_DB = 3.0;
const M_PER_100FT = 30.48;

/** cables.json → cables in SI (frequencies Hz, loss dB/m), as parseCables does. The file is the
 *  app's own and schema-tested there; here it is only converted. */
export function readCables(json) {
  return json.cables.map((r) => {
    const per = r.table.unit === 'dB/100ft' ? 1 / M_PER_100FT : 1 / 100;
    return {
      id: r.id, name: r.name, maker: r.maker, impedance: r.impedanceOhm, velocityFactor: r.velocityFactor,
      model: r.model, k1: r.model === 'coefficients' ? r.k1 : 0, k2: r.model === 'coefficients' ? r.k2 : 0,
      table: r.table.points.map(([f, a]) => ({ frequency: f * 1e6, lossPerMetre: a * per })),
      maxFrequency: r.maxFrequencyMHz * 1e6, source: r.source,
    };
  });
}

/** Matched loss per metre, dB/m (SWR 1, the maker's reference temperature). */
export function cableLossPerMetre(cable, f) {
  const bad = guard({ positive: [['frequency', f]] });
  if (bad.length) return fail(bad);
  if (f < CABLE_MIN_F || f > cable.maxFrequency) {
    return fail([finding('outOfRange', 'block', { field: 'frequency', limit: f < CABLE_MIN_F ? CABLE_MIN_F : cable.maxFrequency, actual: f })], { f });
  }
  if (cable.model === 'coefficients') {
    const mhz = f / 1e6;
    const a = (cable.k1 * Math.sqrt(mhz) + cable.k2 * mhz) / M_PER_100FT;
    return ok(a, { model: 'coefficients', f, k1: cable.k1, k2: cable.k2, result: a });
  }
  const t = cable.table;
  let i = 0;
  while (i < t.length - 2 && f > t[i + 1].frequency) i++;
  const p0 = t[i], p1 = t[i + 1];
  const exponent = Math.log(p1.lossPerMetre / p0.lossPerMetre) / Math.log(p1.frequency / p0.frequency);
  const a = f === p0.frequency ? p0.lossPerMetre : f === p1.frequency ? p1.lossPerMetre : p0.lossPerMetre * (f / p0.frequency) ** exponent;
  return ok(a, { model: 'table', f, f0: p0.frequency, A0: p0.lossPerMetre, f1: p1.frequency, A1: p1.lossPerMetre, p: exponent, result: a },
    f < t[0].frequency ? [finding('outOfRange', 'warning', { field: 'frequency', limit: t[0].frequency, actual: f })] : []);
}

/** Matched loss of `length` metres, dB; high-loss warning at or above 3 dB. */
export function matchedLoss(cable, f, length) {
  const per = cableLossPerMetre(cable, f);
  const bad = guard({ nonNegative: [['length', length]] });
  const how = { ...per.how, length };
  if (bad.length || per.value == null) return fail([...per.findings, ...bad], how);
  const loss = per.value * length;
  if (!Number.isFinite(loss)) return fail([finding('outOfRange', 'block', { field: 'result' })], how);
  return ok(loss, { ...how, result: loss }, [
    ...per.findings,
    ...(loss >= HIGH_LOSS_DB ? [finding('highLoss', 'warning', { field: 'matchedLoss', limit: HIGH_LOSS_DB, actual: loss })] : []),
  ]);
}

// ---- F2 mismatch, X reflection (feedline/mismatch.dart, reflection.dart) ------------------------

/** F2: total loss with a mismatched load. `measuredAt` 'load' (antenna) or 'input' (radio).
 *  `power`, if given, is the net power into the line, W. */
export function lossWithMismatch({ matchedLoss: ml, swr, measuredAt = 'load', power = null }) {
  const bad = [
    ...guard({ positive: power == null ? [] : [['power', power]], nonNegative: [['matchedLoss', ml]], finite: [['swr', swr]] }),
    ...(Number.isFinite(swr) && swr < 1 ? [finding('invalidInput', 'block', { field: 'swr', limit: 1, actual: swr })] : []),
  ];
  if (bad.length) return fail(bad);
  const a = 10 ** (ml / 10);
  const rho = (swr - 1) / (swr + 1);
  const rhoLoad = measuredAt === 'load' ? rho : rho * a;
  const rhoInput = measuredAt === 'load' ? rho / a : rho;
  if (!Number.isFinite(a)) return fail([finding('outOfRange', 'block', { field: 'matchedLoss', actual: ml })]);
  if (rhoLoad >= 1) {
    const maxRho = 1 / a;
    return fail([finding('noSolution', 'block', { field: 'swr', limit: (1 + maxRho) / (1 - maxRho), actual: swr })]);
  }
  const tl = (10 * Math.log((a * a - rhoLoad * rhoLoad) / (a * (1 - rhoLoad * rhoLoad)))) / Math.LN10;
  const toLoad = power == null ? null : power * 10 ** (-tl / 10);
  const value = {
    matchedLoss: ml, totalLoss: tl, extraLoss: tl - ml, rhoLoad, rhoInput,
    swrLoad: (1 + rhoLoad) / (1 - rhoLoad), swrInput: (1 + rhoInput) / (1 - rhoInput),
    power, toLoad, lost: power == null ? null : power - toLoad,
  };
  return ok(value, { ML: ml, SWR: swr, a, rhoLoad, rhoIn: rhoInput, TL: tl },
    tl >= HIGH_LOSS_DB ? [finding('highLoss', 'warning', { field: 'totalLoss', limit: HIGH_LOSS_DB, actual: tl })] : []);
}

/** A whole run: `length` m of `cable` at `f` with an SWR read at `measuredAt`. */
export function feedlineRun(cable, { frequency, length, swr, measuredAt = 'load', power = null }) {
  const ml = matchedLoss(cable, frequency, length);
  if (ml.value == null) return fail(ml.findings, ml.how);
  const r = lossWithMismatch({ matchedLoss: ml.value, swr, measuredAt, power });
  const pre = ml.findings.filter((f) => f.issue !== 'highLoss');
  const how = { ...ml.how, ...r.how };
  if (r.value == null) return fail([...r.findings, ...pre], how);
  return ok(r.value, how, [...pre, ...r.findings]);
}

/** X: ρ, return loss and mismatch loss for an SWR ≥ 1 (RL = +∞ at SWR 1). */
export function reflection(swr) {
  if (!Number.isFinite(swr) || swr < 1) return null;
  const rho = (swr - 1) / (swr + 1);
  return {
    rho,
    returnLoss: rho === 0 ? Infinity : -20 * (Math.log(rho) / Math.LN10),
    mismatchLoss: rho === 1 ? Infinity : -10 * (Math.log(1 - rho * rho) / Math.LN10),
  };
}

// ---- R exposure (exposure/limits.dart, formulas.dart, evaluation.dart) --------------------------

/** Z0 = 120π Ω (BNetzA eq. (4)); turns E or H into a plane-wave equivalent S. */
export const Z0 = 120 * Math.PI;
/** EPA ground reflection: power density × 2.56 (OET-65 eq. (7)). */
export const GROUND = 2.56;
/** Half-wave dipole gain over isotropic, dB (ERP = EIRP / 10^(2.15/10)). */
export const DIPOLE_DBI = 2.15;

const NUM = '(\\d+(?:\\.\\d+)?)';
const EXPR = [
  [new RegExp(`^${NUM}$`), (m) => [Number(m[1]), 0]],
  [new RegExp(`^${NUM}/f(?:\\^${NUM})?$`), (m) => [Number(m[1]), -(m[2] == null ? 1 : Number(m[2]))]],
  [new RegExp(`^${NUM}\\*f(?:\\^${NUM})?$`), (m) => [Number(m[1]), m[2] == null ? 1 : Number(m[2])]],
  [new RegExp(`^f(?:\\^${NUM})?/${NUM}$`), (m) => [1 / Number(m[2]), m[1] == null ? 1 : Number(m[1])]],
];
/** `k·f^p` (f in MHz) from texts like `900/f^2`, `0.0128*f`, `f/300`, `614` (ExposureExpr.parse). */
export function parseExpr(s) {
  if (s == null) return null;
  for (const [re, kp] of EXPR) {
    const m = re.exec(s);
    if (m) { const [k, p] = kp(m); return { k, p, text: s, at: (fMHz) => k * fMHz ** p }; }
  }
  throw new Error(`exposure expression ${s}`);
}

function readTable(t, exemption) {
  const u = t.units || {};
  const eScale = u.E === 'kV/m' ? 1000 : 1;
  const hScale = u.H === 'uT' ? 1e-6 / (4e-7 * Math.PI) : 1;
  const sScale = exemption ? 1 : u.S === 'mW/cm2' ? 10 : 1;
  const rows = t.rows.map((r) => ({
    fMinHz: r.fMinMHz * 1e6, fMaxHz: r.fMaxMHz * 1e6, minExclusive: r.minExclusive === true, maxExclusive: r.maxExclusive === true,
    e: parseExpr(r.E), h: parseExpr(r.H), s: parseExpr(exemption ? r.erpPerR2 : r.S), eScale, hScale, sScale,
  }));
  return { id: t.id, clause: t.clause, source: t.source, averagingS: exemption ? 0 : t.averagingMin * 60, rows };
}

/** exposure_limits.json → the rule set `id` with its tables and mode factors. */
export function readExposureRules(json, id = 'us') {
  const rs = json.ruleSets.find((r) => r.id === id);
  if (!rs) throw new Error(`no exposure rule set ${id}`);
  const limit = (tid) => readTable(json.limitTables.find((t) => t.id === tid), false);
  const modes = json.modeTables.find((m) => m.id === rs.modeTable);
  return {
    id: rs.id, version: rs.version, method: rs.method, asOf: json.asOf,
    tiers: rs.tiers.map((t) => ({ tier: t.tier, table: limit(t.table), also: t.also ? limit(t.also) : null })),
    modeTable: { id: modes.id, clause: modes.clause, source: modes.source, factors: Object.fromEntries(modes.factors.map((f) => [f.mode, { factor: f.factor, grade: f.grade }])) },
    modes: modes.factors.map((f) => f.mode),
    exemption: rs.exemptionTable ? readTable(json.exemptionTables.find((t) => t.id === rs.exemptionTable), true) : null,
    assessment: rs.assessment || null,
    sources: rs.sources.map((sid) => json.source.find((s) => s.id === sid)),
  };
}

const covers = (r, f) => (r.minExclusive ? f > r.fMinHz : f >= r.fMinHz) && (r.maxExclusive ? f < r.fMaxHz : f <= r.fMaxHz);
export const rowAt = (table, f) => table.rows.find((r) => covers(r, f)) || null;

/** ExposureLimit at f: E V/m, H A/m, S W/m², sEq = min(S, E²/Z0, Z0·H²) and the governing quantity. */
export function limitOfRow(row, f) {
  const mhz = f / 1e6;
  const e = row.e ? row.e.at(mhz) * row.eScale : null;
  const h = row.h ? row.h.at(mhz) * row.hScale : null;
  const s = row.s ? row.s.at(mhz) * row.sScale : null;
  let best = ['s', Infinity];
  if (s != null) best = ['s', s];
  if (e != null && (e * e) / Z0 < best[1]) best = ['e', (e * e) / Z0];
  if (h != null && Z0 * h * h < best[1]) best = ['h', Z0 * h * h];
  return { e, h, s, sEq: best[1], governing: best[0] };
}

/** The limit table at f: blocks outside the table. */
export function tableLimit(table, f) {
  if (!Number.isFinite(f)) return fail([finding('nonFinite', 'block', { field: 'f' })]);
  if (f <= 0) return fail([finding('invalidInput', 'block', { field: 'f', actual: f })]);
  const row = rowAt(table, f);
  if (!row) return fail([finding('outOfRange', 'block', { field: 'f', actual: f })]);
  return ok(limitOfRow(row, f));
}

/** λ/2π, the reactive near-field boundary, m. */
export const nearFieldBoundary = (f) => C / f / (2 * Math.PI);

/** R = √(g·EIRP/(4π·S)) (OET-65 eq. (4) with g = 1, eq. (7) with g = 2.56). */
export function farFieldDistance({ eirpW, limitWm2, groundFactor = GROUND }) {
  const bad = guard({ positive: [['EIRP', eirpW], ['S_limit', limitWm2], ['g', groundFactor]] });
  if (bad.length) return fail(bad);
  return finiteOrOverflow(Math.sqrt((groundFactor * eirpW) / (4 * Math.PI * limitWm2)));
}

/** Worst-case share of any `windowS` window on the air: { fraction } or { onS, offS }. */
export function onFraction(timing, windowS) {
  if (timing.fraction != null) {
    const fr = timing.fraction;
    const bad = guard({ positive: [['fraction', fr], ['window', windowS]] });
    if (bad.length) return fail(bad);
    if (fr > 1) return fail([finding('invalidInput', 'block', { field: 'fraction', limit: 1, actual: fr })]);
    return ok(fr);
  }
  const { onS: on, offS: off } = timing;
  const bad = guard({ positive: [['on', on], ['window', windowS]], nonNegative: [['off', off]] });
  if (bad.length) return fail(bad);
  const period = on + off;
  const n = Math.floor(windowS / period);
  const r = windowS - n * period;
  const onTime = n * on + Math.min(r, on);
  return finiteOrOverflow(onTime / windowS, { onTime });
}

/** §1.1307(b)(3)(i)(C) threshold ERP (W) at R: R² · expr; not usable inside λ/2π. */
export function exemptionErp(table, f, distanceM) {
  const bad = guard({ positive: [['f', f], ['R', distanceM]] });
  if (bad.length) return fail(bad);
  const row = rowAt(table, f);
  if (!row) return fail([finding('outOfRange', 'block', { field: 'f', actual: f })]);
  const nf = nearFieldBoundary(f);
  if (distanceM < nf) return fail([finding('exemptionNotApplicable', 'block', { field: 'R', limit: nf, actual: distanceM })], { nf });
  return finiteOrOverflow(distanceM * distanceM * row.s.at(f / 1e6), { nf });
}

const lin = (db) => 10 ** (db / 10);
export const erpFromEirp = (eirp) => eirp / lin(DIPOLE_DBI);

function part(l, on, c, modeFactor) {
  const avg = c.pepW * modeFactor * on;
  const antennaW = avg * 10 ** (-c.feedlineLossDb / 10);
  const eirp = antennaW * 10 ** (c.gainDbi / 10);
  const g = farFieldDistance({ eirpW: eirp, limitWm2: l.sEq });
  if (blocked(g)) return null;
  const free = farFieldDistance({ eirpW: eirp, limitWm2: l.sEq, groundFactor: 1 }).value;
  return { limit: l, avg, antennaW, eirp, distance: g.value, free };
}

/** One configuration under a far-field rule set (evaluation.dart _config). `c`: { frequencyHz, pepW,
 *  mode, modeFactor?, timing, feedlineLossDb, gainDbi, magneticLoop, separationM? }. */
export function evaluateExposure(rs, c) {
  const sep = c.separationM ?? null;
  const mf = c.modeFactor ?? null;
  const bad = guard({ positive: [['frequency', c.frequencyHz], ['pep', c.pepW]], nonNegative: [['feedlineLoss', c.feedlineLossDb], ['attenuation', 0]], finite: [['gain', c.gainDbi]] });
  if (mf != null && !(mf > 0 && mf <= 1)) bad.push(finding(Number.isFinite(mf) ? 'invalidInput' : 'nonFinite', 'block', { field: 'modeFactor', limit: 1, actual: Number.isFinite(mf) ? mf : null }));
  if (sep != null) bad.push(...guard({ positive: [['separation', sep]] }));
  const empty = { nearField: null, modeFactor: null, grade: null, peakEirp: null, tiers: [], exemption: null };
  if (bad.length) return { ...empty, findings: bad };

  const entry = rs.modeTable.factors[c.mode];
  const modeFactor = mf ?? entry.factor;
  const grade = mf == null ? entry.grade : null;
  const nf = nearFieldBoundary(c.frequencyHz);
  const peakEirp = c.pepW * lin(c.gainDbi - c.feedlineLossDb);
  if (!Number.isFinite(peakEirp)) return { ...empty, findings: [finding('outOfRange', 'block', { field: 'result' })] };

  const findings = [];
  const tiers = [];
  for (const tt of rs.tiers) {
    const limit = tableLimit(tt.table, c.frequencyHz);
    const on = onFraction(c.timing, tt.table.averagingS);
    const blocking = [...limit.findings, ...on.findings];
    if (blocking.length) return { ...empty, nearField: nf, modeFactor, grade, findings: blocking };
    const main = part(limit.value, on.value, c, modeFactor);
    const alsoRow = tt.also ? rowAt(tt.also, c.frequencyHz) : null;
    const also = alsoRow ? part(limitOfRow(alsoRow, c.frequencyHz), 1, c, modeFactor) : null;
    if (main == null || (alsoRow && also == null)) return { ...empty, nearField: nf, findings: [finding('outOfRange', 'block', { field: 'result' })] };
    const distance = Math.max(main.distance, also?.distance ?? 0);
    const tier = {
      tier: tt.tier, clause: tt.table.clause, averagingS: tt.table.averagingS, onFraction: on.value,
      average: main.avg, antennaW: main.antennaW, eirp: main.eirp, erp: erpFromEirp(main.eirp),
      limit: main.limit, sEq: main.limit.sEq, governing: main.limit.governing,
      distance, distanceFree: main.free == null ? null : Math.max(main.free, also?.free ?? 0),
      alsoClause: also ? tt.also.clause : null, alsoDistance: also?.distance ?? null,
      meets: sep == null ? null : sep >= distance,
    };
    tiers.push(tier);
    if (tier.meets === false) findings.push(finding('limitExceeded', 'warning', { field: 'separation', limit: distance, actual: sep, ref: tt.tier }));
  }

  const nearest = Math.min(...tiers.map((t) => t.distance));
  if (c.magneticLoop) {
    findings.unshift(finding('nearField', nearest < nf ? 'block' : 'warning', { field: 'distance', limit: nf, actual: nearest, ref: 'BNetzA §1.2.1 magnetic loop' }));
  } else if (nearest < nf) {
    findings.unshift(finding('nearField', 'warning', { field: 'distance', limit: nf, actual: nearest, ref: rs.method === 'bnetza' ? 'BNetzA §1.2.1' : 'OET-65 p. 19' }));
  }

  let exemption = null;
  if (rs.exemption && sep != null) {
    const th = exemptionErp(rs.exemption, c.frequencyHz, sep);
    if (blocked(th)) {
      const f = th.findings[0];
      findings.push(finding(f.issue, 'warning', { field: f.field, limit: f.limit, actual: f.actual, ref: '47 CFR §1.1307(b)(3)(i)(C)' }));
    } else {
      const longest = tiers.reduce((a, b) => (a.averagingS >= b.averagingS ? a : b));
      exemption = { distance: sep, threshold: th.value, erp: longest.erp, exempt: longest.erp <= th.value };
      if (!exemption.exempt) findings.push(finding('assessmentRequired', 'info', { field: 'erp', limit: th.value, actual: longest.erp, ref: '47 CFR §1.1307(b)(3)(i)(C)' }));
    }
  }
  return { nearField: nf, modeFactor, grade, peakEirp, tiers, exemption, findings };
}

// ---- reading what people type --------------------------------------------------------------------

/** A decimal number as people type it: spaces and NBSP ignored, comma or dot as the decimal mark.
 *  A comma followed by exactly three digits (and no dot) is a thousands separator where the page's
 *  decimal mark is a dot ("1,296" = 1296 on an English page) and a decimal mark otherwise. NaN for
 *  anything else (two marks, letters, empty). */
export function parseNumber(text, decimal = '.') {
  let t = String(text ?? '').replace(/[\s  ]/g, '').replace(/^\+/, '').replace(/^[−–]/, '-');
  if (!t) return NaN;
  if (t.includes(',') && t.includes('.')) {
    // 1,296.5 (en) or 1.296,5 (de): the last mark is the decimal one, the other groups thousands.
    const dec = t.lastIndexOf(',') > t.lastIndexOf('.') ? ',' : '.';
    const grp = dec === ',' ? '.' : ',';
    if (!new RegExp(`^-?\\d{1,3}(\\${grp}\\d{3})+\\${dec}\\d+$`).test(t)) return NaN;
    t = t.split(grp).join('').replace(dec, '.');
  } else if (t.includes(',')) {
    if ((t.match(/,/g) || []).length > 1) {
      if (decimal !== '.' || !/^-?\d{1,3}(,\d{3})+$/.test(t)) return NaN;
      t = t.replace(/,/g, '');
    } else if (decimal === '.' && /^-?\d{1,3},\d{3}$/.test(t)) t = t.replace(',', '');
    else t = t.replace(',', '.');
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
  return Number(t);
}

/** Feet and inches as people type them: 66.5 (feet), 66' 2", 66'2-5/8", 66 ft 2 1/2 in, 2 5/8" (inches
 *  only). Returns feet, NaN when it cannot be read. */
export function parseFeet(text, decimal = '.') {
  const t = String(text ?? '').trim()
    .replace(/[½¼¾⅛⅜⅝⅞]/g, (g) => ` ${{ '½': '1/2', '¼': '1/4', '¾': '3/4', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8' }[g]}`)
    .replace(/([⁰¹²³⁴⁵⁶⁷⁸⁹]+)⁄([₀₁₂₃₄₅₆₇₈₉]+)/g, (_, n, d) => ` ${[...n].map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c)).join('')}/${[...d].map((c) => '₀₁₂₃₄₅₆₇₈₉'.indexOf(c)).join('')}`)
    .replace(/\u00a0/g, ' ').replace(/[′’]/g, "'").replace(/[″”]/g, '"').replace(/\s*(ft|feet)\b\.?/gi, "'").replace(/\s*(in|inch|inches)\b\.?/gi, '"');
  if (!t) return NaN;
  const frac = (s) => {
    const m = /^(?:(\d+(?:[.,]\d+)?)[\s-]+)?(\d+)\/(\d+)$/.exec(s.trim());
    if (m) { const d = Number(m[3]); if (!d) return NaN; return (m[1] ? parseNumber(m[1], decimal) : 0) + Number(m[2]) / d; }
    return parseNumber(s, decimal);
  };
  const m = /^(-?[\d.,\s]+)'(?:[\s-]*(.*?)"?)?$/.exec(t);
  if (m) {
    const ft = parseNumber(m[1], decimal);
    const rest = (m[2] || '').trim();
    const inches = rest ? frac(rest) : 0;
    if (!Number.isFinite(ft) || !Number.isFinite(inches) || inches < 0) return NaN;
    return ft + (ft < 0 ? -inches : inches) / 12;
  }
  if (t.endsWith('"')) { const inches = frac(t.slice(0, -1)); return inches / 12; }
  return frac(t);
}

/** Feet as 66′ 2 ⅝″ to the nearest sixteenth (the app's tape-measure format); `ascii` gives 66' 2-5/8". */
export function formatFeet(feet, { ascii = false } = {}) {
  const sign = feet < 0 ? '-' : '';
  let sixteenths = Math.round(Math.abs(feet) * 12 * 16);
  const ft = Math.floor(sixteenths / (12 * 16));
  sixteenths -= ft * 12 * 16;
  const inch = Math.floor(sixteenths / 16);
  let n = sixteenths - inch * 16, d = 16;
  while (n && n % 2 === 0) { n /= 2; d /= 2; }
  const glyph = { '1/2': '½', '1/4': '¼', '3/4': '¾', '1/8': '⅛', '3/8': '⅜', '5/8': '⅝', '7/8': '⅞' };
  const sup = (x) => String(x).replace(/\d/g, (c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[c]);
  const sub = (x) => String(x).replace(/\d/g, (c) => '₀₁₂₃₄₅₆₇₈₉'[c]);
  const fr = n ? (ascii ? `${n}/${d}` : glyph[`${n}/${d}`] || `${sup(n)}⁄${sub(d)}`) : '';
  if (ascii) return `${sign}${ft}' ${inch}${fr ? `-${fr}` : ''}"`;
  return `${sign}${ft}′ ${inch}${fr ? ` ${fr}` : ''}″`;
}
