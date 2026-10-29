/*
lu.js: the Life Unit quoting library. Plain script, no dependencies.

In a browser it exposes window.LU. In node it is require()-able.

What it does: read a published fix (the JSON the formula engine
publishes once a day) and quote any price in Life Units and in time of
an abundant day. It never fetches a source and never computes a fix.
The fix is the input; the engine in lucalc/ is what makes one.

Rules implemented, with their sections:
  Life Unit Standard Methodology v0.9: 2 (one LU is one day), 3 (the
  trimmed mean, provisional below five cities), 3a (the numeraire,
  B_X and the quote line), 6 (the everyday readings), 9.7 (chain-linked
  series, cumulative factor).
  Life Unit Node Protocol v0.2: 5 (trim as a share, rounded down; B_X
  as the trimmed mean of the cities' basket prices in X).
  Calculator specification v0.9: "Formula" items 9 to 13, "The page".

Fix format this library reads (specification "Formula" item 13):
  {
    version, code_version, catalog_version, catalog_hash, inputs_hash,
    rulebook_hash, date, status ("provisional" or "fixed"),
    lu, lu_ex_income_tax, cumulative_factor,
    chain: { base_period, basis_hash, history }, placeholder (boolean),
    rulebook: { trim_share, min_cities, ... }   (optional; defaults 0.2 and 5)
    readings: [ { city, name, currency, S, income_tax_per_day, C, C_ex,
                  B, B_linked, R, R_ex, included, excluded, flags, clip,
                  carried_lines, seller_drops } ... ]
                                              (an array, or an object keyed by city id)
    b_x: { USD: number, ... }, b_x_cities: [ ... ],
    reference_rates: { source, usd_per_unit: { USD: 1, GBP: ..., BTC: ... } },
    quote_currencies: [ "USD", ... ],
    coverage: { fresh_share, carried_share, flags },
    fix_hash
  }
Published LU = raw trimmed mean of the readings times cumulative_factor
(item 10). A reading's B is the raw basket price in the day's basket and
B_linked is B times the fix's basket_factor, the quoting basket's own
chain (3a, 9.7: 1 / factor at a basket change, the basket set-link
factor when a city leaves or joins the live set; a fix written before
review round 3 divided by cumulative_factor instead); this library reads
B_linked for B_X (falling back to B when a fix has no linked field) and
keeps the raw one as B_raw for display. A reading marked excluded (the
failing-city rule, methodology 3) has no R, publishes no B_linked
(review round 4) and takes no part in LU or B_X. b_x_cities is the set
the USD pass of the trim kept (review round 4), and verify compares it
with that pass.

JSON.parse rounds an integer literal above 2^53 before this library
sees it, where the engine refuses to publish one; checkIntegerLiterals
takes the raw JSON text and names such a literal, so the page reports
the reason and not a fix_hash mismatch (review round 4).
*/
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.LU = api;
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function () {
  "use strict";

  var VERSION = "0.9.0";

  /* Methodology section 3: drop the top and bottom 20 percent by count,
     rounded down; fewer than five cities is provisional. These defaults
     apply only when the fix carries no rulebook block. */
  var DEFAULT_TRIM_SHARE = 0.2;
  var DEFAULT_MIN_CITIES = 5;

  /* Methodology section 2: one Life Unit is one day of abundant life.
     Specification item 12: 1 LU = 1 day = 86400 life-seconds. */
  var SECONDS_PER_DAY = 86400;

  /* Specification item 11: SAT = BTC / 1e8. */
  var SAT_PER_BTC = 100000000;

  /* Specification item 12: largest two of years, months, days, hours,
     minutes, seconds. A month is 30 days and a year 365 days, as in
     lucalc/formula.py (methodology 2, 6), so the page and the engine
     print the same words for the same quote. */
  var TIME_UNITS = [
    { name: "year", seconds: 365 * SECONDS_PER_DAY },
    { name: "month", seconds: 30 * SECONDS_PER_DAY },
    { name: "day", seconds: SECONDS_PER_DAY },
    { name: "hour", seconds: 3600 },
    { name: "minute", seconds: 60 },
    { name: "second", seconds: 1 }
  ];

  /* Specification "The page": the World Clock list of everyday things,
     priced in USD, quoted through the fix's B_USD. */
  var EVERYDAY_ITEMS_USD = [
    { id: "coffee", label: "A coffee", usd: 5.5 },
    { id: "dinner", label: "Dinner for two", usd: 85 },
    { id: "rent", label: "A month's rent on a 3,000 USD home", usd: 3000 },
    { id: "car", label: "A new car", usd: 49500 },
    { id: "wage_hour", label: "One hour at the US median wage", usd: 30.5 }
  ];

  /* ---------- small helpers ---------- */

  function isNum(x) {
    return typeof x === "number" && isFinite(x);
  }

  function num(x) {
    if (x === null || x === undefined || x === "") {
      return NaN;
    }
    var n = Number(x);
    return isFinite(n) ? n : NaN;
  }

  function first() {
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i] !== undefined && arguments[i] !== null) {
        return arguments[i];
      }
    }
    return undefined;
  }

  function list(x) {
    if (Array.isArray(x)) {
      return x;
    }
    if (x === undefined || x === null || x === "") {
      return [];
    }
    return [x];
  }

  /* "To 1e-9": absolute for values near one, relative for large values,
     so a basket price in satoshis (about 1e8) is held to the same
     precision as a reading (about 1e-2). */
  function closeEnough(a, b, tol) {
    tol = isNum(tol) ? tol : 1e-9;
    if (!isNum(a) || !isNum(b)) {
      return false;
    }
    var scale = Math.max(1, Math.abs(a), Math.abs(b));
    return Math.abs(a - b) <= tol * scale;
  }

  function fixedString(x, decimals) {
    if (!isNum(x)) {
      return "n/a";
    }
    return x.toFixed(decimals);
  }

  /* Thousands separators with plain commas, ASCII only, no locale. */
  function withCommas(x, decimals) {
    if (!isNum(x)) {
      return "n/a";
    }
    var s = Math.abs(x).toFixed(decimals);
    var parts = s.split(".");
    var intPart = parts[0];
    var out = "";
    while (intPart.length > 3) {
      out = "," + intPart.slice(-3) + out;
      intPart = intPart.slice(0, -3);
    }
    out = intPart + out;
    if (parts.length > 1) {
      out += "." + parts[1];
    }
    return (x < 0 ? "-" : "") + out;
  }

  function plural(count, unit) {
    return count + " " + unit + (count === 1 ? "" : "s");
  }

  /* ---------- reading the fix ---------- */

  function rulebookOf(fix) {
    fix = fix || {};
    return fix.rulebook || fix.parameters || {};
  }

  function trimShareOf(fix) {
    var v = num(first(rulebookOf(fix).trim_share, (fix || {}).trim_share));
    return isNum(v) ? v : DEFAULT_TRIM_SHARE;
  }

  function minCitiesOf(fix) {
    var v = num(first(rulebookOf(fix).min_cities, (fix || {}).min_cities));
    return isNum(v) ? v : DEFAULT_MIN_CITIES;
  }

  /* Methodology 9.7, specification item 10: published LU is the raw
     trimmed mean times the cumulative chain factor; 1.0 before any link. */
  function cumulativeFactorOf(fix) {
    var v = num((fix || {}).cumulative_factor);
    return isNum(v) ? v : 1.0;
  }

  /* The quoting basket's own chain factor (methodology 3a; lucalc/chain.py
     basket_factor_of): B_linked = B times it. A fix from before review
     round 3 has none and divided by the cumulative factor. */
  function basketFactorOf(fix) {
    fix = fix || {};
    var v = num(first(fix.basket_factor, (fix.chain || {}).basket_factor));
    if (isNum(v)) {
      return v;
    }
    var cf = cumulativeFactorOf(fix);
    return cf !== 0 ? 1 / cf : 1.0;
  }

  /* The base period lives under chain in the engine's fix (methodology
     9.7); an older shape put it at the top level. */
  function basePeriodOf(fix) {
    fix = fix || {};
    var v = first(fix.base_period, (fix.chain || {}).base_period);
    return v === undefined ? null : v;
  }

  /* The fix's published B_X for a currency, or NaN when it has none. A
     quote goes through the published number (specification item 12,
     lucalc/quote.py); recomputing it from the readings is Verify's job. */
  function publishedBasketPrice(fix, X) {
    X = String(X || "").toUpperCase();
    return num(((fix || {}).b_x || {})[X]);
  }

  function luOf(fix) {
    return num((fix || {}).lu);
  }

  function normalizeReading(raw, key) {
    var r = raw || {};
    var inc = first(r.included, r.included_in_trim);
    return {
      city: String(first(r.city, r.id, r.city_id, key, "")),
      name: String(first(r.name, r.city_name, r.city, key, "")),
      currency: String(first(r.currency, r.ccy, "")).toUpperCase(),
      S: num(first(r.S, r.s, r.spending_subtotal)),
      income_tax_per_day: num(first(r.income_tax_per_day, r.tax_per_day)),
      C: num(first(r.C, r.c, r.day_cost)),
      C_ex: num(first(r.C_ex, r.c_ex)),
      B: num(first(r.B_linked, r.B, r.b, r.basket)),
      B_raw: num(first(r.B, r.b, r.basket)),
      R: num(first(r.R, r.r, r.reading)),
      R_ex: num(first(r.R_ex, r.r_ex)),
      included: typeof inc === "boolean" ? inc : null,
      excluded: r.excluded === true,
      flags: list(r.flags),
      clip: num(r.clip),
      carried_lines: list(first(r.carried_lines, r.carried)),
      seller_drops: list(r.seller_drops)
    };
  }

  /* The fix's readings as an array, whatever shape the engine wrote. */
  function readings(fix) {
    fix = fix || {};
    var raw = first(fix.readings, fix.cities, []);
    var out = [];
    if (Array.isArray(raw)) {
      for (var i = 0; i < raw.length; i++) {
        out.push(normalizeReading(raw[i], undefined));
      }
    } else if (typeof raw === "object") {
      var keys = Object.keys(raw);
      for (var j = 0; j < keys.length; j++) {
        out.push(normalizeReading(raw[keys[j]], keys[j]));
      }
    }
    return out;
  }

  function referenceRates(fix) {
    fix = fix || {};
    var rr = fix.reference_rates || {};
    return rr.usd_per_unit || rr.rates || {};
  }

  /* USD per one unit of X at the fix's reference rates (methodology 3a:
     reference rates are a scratch variable for quoting, never an input
     to the unit). SAT derives from BTC (specification item 11). */
  function rateUsdPerUnit(fix, X) {
    X = String(X || "").toUpperCase();
    var rates = referenceRates(fix);
    if (X === "USD" && !isNum(num(rates.USD))) {
      return 1;
    }
    if (isNum(num(rates[X]))) {
      return num(rates[X]);
    }
    if (X === "SAT" && isNum(num(rates.BTC))) {
      return num(rates.BTC) / SAT_PER_BTC;
    }
    return NaN;
  }

  function convert(amount, fromX, toX, fix) {
    var a = num(amount);
    var rf = rateUsdPerUnit(fix, fromX);
    var rt = rateUsdPerUnit(fix, toX);
    if (!isNum(a) || !isNum(rf) || !isNum(rt) || rt === 0) {
      return NaN;
    }
    return (a * rf) / rt;
  }

  function quoteCurrencies(fix) {
    fix = fix || {};
    if (Array.isArray(fix.quote_currencies) && fix.quote_currencies.length) {
      return fix.quote_currencies.map(function (c) { return String(c).toUpperCase(); });
    }
    if (fix.b_x && typeof fix.b_x === "object") {
      return Object.keys(fix.b_x);
    }
    var keys = Object.keys(referenceRates(fix));
    if (keys.indexOf("BTC") >= 0 && keys.indexOf("SAT") < 0) {
      keys.push("SAT");
    }
    return keys;
  }

  function isPlaceholder(fix) {
    fix = fix || {};
    if (fix.placeholder === true) {
      return true;
    }
    var fields = [fix.catalog_version, fix.data_status, fix.status_note];
    for (var i = 0; i < fields.length; i++) {
      if (typeof fields[i] === "string" && fields[i].toLowerCase().indexOf("placeholder") >= 0) {
        return true;
      }
    }
    return false;
  }

  /* ---------- the formula pieces ---------- */

  /* How many readings the trim drops from each end: trimShare times n,
     "rounded down" (protocol 5), counted in integers as lucalc/formula.py
     trim_count does. The share has at most ten decimals (the engine
     rounds every input to ten), so the share in units of 1e-10 times n
     is an exact integer below 2^53, and dividing it by 1e10 and flooring
     is exact: 0.29 x 100 gives 29, 0.2727272727 x 11 gives 2 (a 1e-9
     nudge gave 3) and 0.4999999999 x 2 gives 0 (review round 3). */
  function trimCount(trimShare, n) {
    return Math.floor(Math.round(trimShare * 1e10) * n / 1e10);
  }

  /* Trimmed mean as a share (methodology 3, protocol 5, specification
     item 9): sort the values, drop trimCount(trimShare, n) from each end,
     average the rest, summing left to right in ascending order as the
     engine does. Returns the kept values and, when the caller passes
     labels, which labels were kept. Ties sort by label in code-point
     order, as the engine sorts by city id, so both keep the same cities;
     without labels ties keep input order. */
  function trimmedMean(values, trimShare, labels) {
    trimShare = isNum(num(trimShare)) ? num(trimShare) : DEFAULT_TRIM_SHARE;
    var idx = [];
    for (var i = 0; i < values.length; i++) {
      if (isNum(values[i])) {
        idx.push(i);
      }
    }
    idx.sort(function (a, b) {
      if (values[a] < values[b]) { return -1; }
      if (values[a] > values[b]) { return 1; }
      return labels ? compareCodePoints(String(labels[a]), String(labels[b])) : a - b;
    });
    var n = idx.length;
    var k = trimCount(trimShare, n);
    var keptIdx = idx.slice(k, n - k);
    var sum = 0;
    for (var j = 0; j < keptIdx.length; j++) {
      sum += values[keptIdx[j]];
    }
    var kept = keptIdx.map(function (i) { return values[i]; });
    var dropped = idx.slice(0, k).concat(idx.slice(n - k));
    return {
      mean: keptIdx.length ? sum / keptIdx.length : NaN,
      n: n,
      dropped_each_end: k,
      kept: kept,
      kept_indexes: keptIdx,
      dropped_indexes: dropped,
      kept_labels: labels ? keptIdx.map(function (i) { return labels[i]; }) : undefined,
      dropped_labels: labels ? dropped.map(function (i) { return labels[i]; }) : undefined
    };
  }

  /* Methodology 3: fewer than min_cities readings is provisional. */
  function statusForCount(n, minCities) {
    minCities = isNum(num(minCities)) ? num(minCities) : DEFAULT_MIN_CITIES;
    return n < minCities ? "provisional" : "fixed";
  }

  /* B_X (methodology 3a "B_X is one number", protocol 5, specification
     item 11): the trimmed mean over the cities with a reading of each
     city's chain-linked basket price B_i converted to X at the reference
     rates. A city the fix excluded for the day (no R) is not a qualifying
     city and takes no part, as in the engine (lucalc/fix.py). The trim is
     by basket price, so the kept set can differ from the LU trim's; the
     engine publishes it as b_x_cities. X cancels up to the rates
     themselves, so B_X = B_USD / usd_per_unit[X] to floating point. */
  function basketPriceIn(fix, X) {
    X = String(X || "USD").toUpperCase();
    var rs = readings(fix);
    var rateX = rateUsdPerUnit(fix, X);
    var values = [];
    var labels = [];
    var missing = [];
    var excluded = [];
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i];
      if (r.excluded || !isNum(r.R)) {
        excluded.push(r.city);
        continue;
      }
      var rLocal = rateUsdPerUnit(fix, r.currency);
      if (!isNum(r.B) || !isNum(rLocal) || !isNum(rateX) || rateX === 0) {
        missing.push(r.city);
        continue;
      }
      values.push((r.B * rLocal) / rateX);
      labels.push(r.city);
    }
    var tm = trimmedMean(values, trimShareOf(fix), labels);
    return {
      currency: X,
      value: tm.mean,
      n: tm.n,
      kept_cities: tm.kept_labels,
      dropped_cities: tm.dropped_labels,
      excluded_cities: excluded,
      city_values: values,
      city_labels: labels,
      missing: missing,
      method: "trimmed mean by basket price over the cities with a reading, of the chain-linked basket prices"
    };
  }

  /* ---------- time ---------- */

  /* Python's round(): half to even, on the exact value. */
  function roundHalfEven(x) {
    var f = Math.floor(x);
    var d = x - f;
    if (d < 0.5) { return f; }
    if (d > 0.5) { return f + 1; }
    return f % 2 === 0 ? f : f + 1;
  }

  /* x written with exactly `decimals` decimals, rounded half to even on
     the exact binary value, as Python's "%.*f" does. toFixed(100) gives
     the exact decimal expansion of a double (a tie at the eleventh
     decimal is an odd multiple of 2^-11, whose expansion ends within
     eleven decimals, so a hundred digits decide every case); toFixed
     with the target decimals would round a tie half away from zero and
     differ from the engine on values such as 1000000 + 1/2048. */
  function fixedHalfEven(x, decimals) {
    var negative = x < 0;
    var exact = Math.abs(x).toFixed(100);
    var point = exact.indexOf(".");
    var intPart = point >= 0 ? exact.slice(0, point) : exact;
    var frac = point >= 0 ? exact.slice(point + 1) : "";
    var keep = frac.slice(0, decimals);
    var rest = frac.slice(decimals);
    var digits = (intPart + keep).split("");
    var roundUp = false;
    if (rest.length && rest.charAt(0) > "5") {
      roundUp = true;
    } else if (rest.length && rest.charAt(0) === "5") {
      if (/[1-9]/.test(rest.slice(1))) {
        roundUp = true;
      } else {
        roundUp = (Number(digits[digits.length - 1]) % 2) === 1;
      }
    }
    if (roundUp) {
      var i = digits.length - 1;
      while (i >= 0) {
        if (digits[i] === "9") {
          digits[i] = "0";
          i -= 1;
        } else {
          digits[i] = String(Number(digits[i]) + 1);
          break;
        }
      }
      if (i < 0) {
        digits.unshift("1");
      }
    }
    var intLen = digits.length - decimals;
    var out = digits.slice(0, intLen).join("");
    if (decimals > 0) {
      out += "." + digits.slice(intLen).join("");
    }
    return (negative ? "-" : "") + out;
  }

  /* Specification item 12: 1 LU = 1 day = 86400 life-seconds, shown as
     the largest two units, always both ("1 day 0 hours"), under one
     second with two decimals. Same rule and words as format_time in
     lucalc/formula.py: a second-unit count that rounds to a whole first
     unit (12 months, 30 days, 24 hours, 60 minutes, 60 seconds) is
     formatted as the rounded total ("1 hour 0 minutes", "2 years 0
     months"), and 59.6 seconds read "1 minute 0 seconds". The words are
     formed from the total in seconds (formatSeconds); a roll-up
     re-enters with a whole number of seconds, never through Life Units,
     whose conversion back to seconds is not exact (review round 2:
     780 / 86400 * 86400 is 779.9999999999999 and re-entered without
     end). Minus zero reads as zero. */
  function formatTime(luDays) {
    var lu = num(luDays);
    if (!isNum(lu)) {
      return "n/a";
    }
    var sign = lu < 0 ? "minus " : "";
    return sign + formatSeconds(Math.abs(lu) * SECONDS_PER_DAY);
  }

  /* formatTime's body over a non-negative total in seconds. A whole
     multiple of a unit's size is at least that size with no remainder,
     so a roll-up ends in one step. */
  function formatSeconds(total) {
    if (total < 1) {
      return fixedHalfEven(total, 2) + " seconds";
    }
    for (var i = 0; i < TIME_UNITS.length; i++) {
      var big = TIME_UNITS[i];
      if (total >= big.seconds) {
        var bigCount = Math.floor(total / big.seconds);
        var rest = total - bigCount * big.seconds;
        if (i + 1 >= TIME_UNITS.length) {
          var secs = roundHalfEven(total);
          if (secs >= 60) {
            return formatSeconds(60);
          }
          return plural(secs, big.name);
        }
        var small = TIME_UNITS[i + 1];
        var smallCount = roundHalfEven(rest / small.seconds);
        if (smallCount >= Math.floor(big.seconds / small.seconds)) {
          return formatSeconds((bigCount + 1) * big.seconds);
        }
        return plural(bigCount, big.name) + " " + plural(smallCount, small.name);
      }
    }
    return "0 seconds";
  }

  /* ---------- quoting ---------- */

  /* Methodology 3a: Price in LU = (price in X / B_X) / LU.
     opts.coinPrice = { price, currency }: a manual or live price of one
     BTC in a fiat currency. When given and X is BTC or SAT, the amount
     is turned into that fiat currency first and quoted through it, in
     place of the fix's reference rate for BTC. */
  function quote(fix, amount, currency, opts) {
    opts = opts || {};
    var X = String(currency || "USD").toUpperCase();
    var lu = luOf(fix);
    var priceX = num(amount);
    var via = X;
    var notes = [];
    var cp = opts.coinPrice;
    if (cp && (X === "BTC" || X === "SAT") && isNum(num(cp.price)) && num(cp.price) > 0) {
      var perBtc = num(cp.price);
      var fiat = String(cp.currency || "USD").toUpperCase();
      var btcAmount = X === "SAT" ? priceX / SAT_PER_BTC : priceX;
      priceX = btcAmount * perBtc;
      via = fiat;
      notes.push("Coin priced at " + withCommas(perBtc, 2) + " " + fiat + " per BTC from the entered price, not the fix's reference rate");
    }
    var pubBx = publishedBasketPrice(fix, via);
    var bx = isNum(pubBx) ? { value: pubBx, source: "published" }
                          : basketPriceIn(fix, via);
    if (!isNum(pubBx)) {
      bx.source = "recomputed from the readings; the fix publishes no b_x." + via;
    }
    var luDays = NaN;
    if (isNum(priceX) && isNum(bx.value) && bx.value !== 0 && isNum(lu) && lu !== 0) {
      luDays = (priceX / bx.value) / lu;
    }
    return {
      amount: num(amount),
      currency: X,
      via: via,
      price_via: priceX,
      b_x: bx.value,
      b_x_source: bx.source,
      lu: lu,
      lu_days: luDays,
      lu_text: fixedString(luDays, 6),
      time: formatTime(luDays),
      notes: notes
    };
  }

  /* Specification item 12: "satoshis per Life Unit". One LU costs
     B_SAT * LU satoshis, from the quote line solved for the price,
     through the published B_SAT. */
  function satoshisPerLifeUnit(fix) {
    var pubBx = publishedBasketPrice(fix, "SAT");
    var bxValue = isNum(pubBx) ? pubBx : basketPriceIn(fix, "SAT").value;
    var lu = luOf(fix);
    return isNum(bxValue) && isNum(lu) ? bxValue * lu : NaN;
  }

  /* Specification item 12: "one Bitcoin in Life Units". */
  function bitcoinInLifeUnits(fix) {
    return quote(fix, 1, "BTC").lu_days;
  }

  /* Specification "The page": the everyday things, through B_USD. */
  function everydayItems(fix) {
    var out = [];
    for (var i = 0; i < EVERYDAY_ITEMS_USD.length; i++) {
      var it = EVERYDAY_ITEMS_USD[i];
      var q = quote(fix, it.usd, "USD");
      out.push({
        id: it.id,
        label: it.label,
        usd: it.usd,
        lu_days: q.lu_days,
        lu_text: q.lu_text,
        time: q.time
      });
    }
    return out;
  }

  /* ---------- canonical form ---------- */

  /* The canonical JSON every hash in a fix is over (methodology 8.5:
     two honest implementations hash the same bytes; lucalc/formula.py
     canonical_json). Keys sorted by code point, no spaces, strings
     escaped to ASCII the way Python's json.dumps(ensure_ascii=True)
     does, and every number written with ten decimals rounded half to
     even on its exact value (fixedHalfEven, the same digits as Python's
     "%.10f"), trailing zeros and a trailing point removed, minus zero
     as 0, never in exponent form. An integer above 2^53 is not held
     exactly by a double, so the engine refuses to publish one. */
  function canonicalNumber(x) {
    if (!isNum(x)) {
      throw new Error("a published number must be finite");
    }
    if (Math.abs(x) >= 1e21) {
      throw new Error("a published number must be below 1e21");
    }
    var text = fixedHalfEven(x, 10);
    if (text.indexOf(".") >= 0) {
      text = text.replace(/0+$/, "").replace(/\.$/, "");
    }
    if (text === "-0" || text === "" || text === "-") {
      text = "0";
    }
    return text;
  }

  /* Python sorts keys by code point; Array.prototype.sort compares
     UTF-16 code units, which puts a character above U+FFFF before
     U+E000. Compare by code point so both sides write the same order. */
  function compareCodePoints(a, b) {
    var i = 0;
    var j = 0;
    while (i < a.length && j < b.length) {
      var ca = a.codePointAt(i);
      var cb = b.codePointAt(j);
      if (ca !== cb) {
        return ca < cb ? -1 : 1;
      }
      i += ca > 0xFFFF ? 2 : 1;
      j += cb > 0xFFFF ? 2 : 1;
    }
    if (i < a.length) {
      return 1;
    }
    if (j < b.length) {
      return -1;
    }
    return 0;
  }

  function canonicalString(s) {
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var c = s.charCodeAt(i);
      if (ch === '"') {
        out += '\\"';
      } else if (ch === "\\") {
        out += "\\\\";
      } else if (c === 8) {
        out += "\\b";
      } else if (c === 12) {
        out += "\\f";
      } else if (c === 10) {
        out += "\\n";
      } else if (c === 13) {
        out += "\\r";
      } else if (c === 9) {
        out += "\\t";
      } else if (c < 32 || c >= 127) {
        out += "\\u" + ("0000" + c.toString(16)).slice(-4);
      } else {
        out += ch;
      }
    }
    return out + '"';
  }

  function canonical(obj) {
    if (obj === null || obj === undefined) {
      return "null";
    }
    if (obj === true) {
      return "true";
    }
    if (obj === false) {
      return "false";
    }
    if (typeof obj === "number") {
      return canonicalNumber(obj);
    }
    if (typeof obj === "string") {
      return canonicalString(obj);
    }
    if (Array.isArray(obj)) {
      var items = [];
      for (var i = 0; i < obj.length; i++) {
        items.push(canonical(obj[i]));
      }
      return "[" + items.join(",") + "]";
    }
    if (typeof obj === "object") {
      var keys = Object.keys(obj).filter(function (k) { return obj[k] !== undefined; }).sort(compareCodePoints);
      var parts = [];
      for (var j = 0; j < keys.length; j++) {
        parts.push(canonicalString(keys[j]) + ":" + canonical(obj[keys[j]]));
      }
      return "{" + parts.join(",") + "}";
    }
    throw new Error("cannot publish a value of type " + typeof obj);
  }

  /* The bytes fix_hash is over: the canonical form of the fix without
     its fix_hash field (specification item 13). The caller hashes them
     with SHA-256 (node's crypto, or crypto.subtle in a browser). */
  function fixHashBody(fix) {
    var body = {};
    Object.keys(fix || {}).forEach(function (k) {
      if (k !== "fix_hash") {
        body[k] = fix[k];
      }
    });
    return canonical(body);
  }

  /* An integer literal above 2^53 in the raw JSON text, which
     JSON.parse would round before this library could refuse it as the
     engine does (formula.round_floats). Strings are blanked first; a
     run of sixteen or more digits that is not part of a decimal or an
     exponent is read back through Number, and one whose digits do not
     come back is named. Returns the text unchanged, or throws. */
  function checkIntegerLiterals(text) {
    var stripped = String(text).replace(/"(?:[^"\\]|\\.)*"/g, '""');
    var re = /(^|[^0-9.eE+-])(-?[0-9]{16,})(?![0-9.eE])/g;
    var m;
    while ((m = re.exec(stripped)) !== null) {
      var digits = m[2].replace(/^(-?)0+(?=[0-9])/, "$1");
      if (String(Number(digits)) !== digits) {
        throw new Error("integer " + m[2] + " is not held exactly by a double");
      }
    }
    return text;
  }

  /* ---------- verification ---------- */

  function check(name, published, recomputed, tol) {
    var ok = closeEnough(published, recomputed, tol);
    return {
      name: name,
      published: published,
      recomputed: recomputed,
      diff: isNum(published) && isNum(recomputed) ? recomputed - published : NaN,
      ok: ok
    };
  }

  function sameSet(a, b) {
    if (a.length !== b.length) {
      return false;
    }
    var sa = a.slice().sort();
    var sb = b.slice().sort();
    for (var i = 0; i < sa.length; i++) {
      if (sa[i] !== sb[i]) {
        return false;
      }
    }
    return true;
  }

  /* Recompute what a verifier can recompute from the fix alone
     (methodology 8.5: anyone can recompute at home): the trimmed mean
     of the readings and the published LU (items 9 and 10), the set of
     included cities, LU without income tax, the status rule, and B_X
     for every quote currency (item 11). Every number is held to tol
     (default 1e-9). The engine's own verify (lucalc/verify.py) goes
     further and rebuilds the readings from the inputs; this one takes
     the readings as published. */
  function verify(fix, tol) {
    tol = isNum(num(tol)) ? num(tol) : 1e-9;
    var checks = [];
    var notes = [];
    var rs = readings(fix);
    var trimShare = trimShareOf(fix);
    var minCities = minCitiesOf(fix);
    var factor = cumulativeFactorOf(fix);
    var labels = rs.map(function (r) { return r.city; });

    if (!rulebookOf(fix).trim_share && !(fix || {}).trim_share) {
      notes.push("fix carries no trim_share; using the methodology's 0.2");
    }

    /* LU: items 9 and 10. A day on which every city is excluded publishes
       lu as null, and recomputes to no mean: that is agreement, not a
       difference (review round 3). */
    var tm = trimmedMean(rs.map(function (r) { return r.R; }), trimShare, labels);
    var pubLu = luOf(fix);
    if (!isNum(pubLu) && !isNum(tm.mean) && ((fix || {}).lu === null || (fix || {}).lu === undefined)) {
      checks.push({ name: "lu", published: "null", recomputed: "null (no live city)", diff: "", ok: true });
    } else {
      checks.push(check("lu", pubLu, tm.mean * factor, tol));
    }
    if (isNum(num((fix || {}).lu_raw))) {
      checks.push(check("lu_raw", num(fix.lu_raw), tm.mean, tol));
    }

    /* Which cities the trim kept, against the fix's included marks. */
    var marked = rs.filter(function (r) { return r.included === true; }).map(function (r) { return r.city; });
    var anyMarked = rs.some(function (r) { return r.included !== null; });
    if (anyMarked) {
      var setOk = sameSet(marked, tm.kept_labels);
      checks.push({
        name: "included cities",
        published: marked.slice().sort().join(","),
        recomputed: tm.kept_labels.slice().sort().join(","),
        diff: setOk ? "" : "differs",
        ok: setOk
      });
    } else {
      notes.push("fix marks no city as included; the trim kept " + tm.kept_labels.join(", "));
    }

    /* LU without the income-tax line (methodology 2, item 5). */
    if (isNum(num((fix || {}).lu_ex_income_tax))) {
      var tmEx = trimmedMean(rs.map(function (r) { return r.R_ex; }), trimShare);
      checks.push(check("lu_ex_income_tax", num(fix.lu_ex_income_tax), tmEx.mean * factor, tol));
    }

    /* Status rule (methodology 3): below min_cities is provisional. A
       fix may be provisional for other reasons, so only "fixed" with
       too few cities is a failure. */
    var status = String((fix || {}).status || "");
    var expected = statusForCount(tm.n, minCities);
    var statusOk = !(status === "fixed" && expected === "provisional");
    checks.push({
      name: "status",
      published: status || "(none)",
      recomputed: expected + " (" + tm.n + " readings, min " + minCities + ")",
      diff: statusOk ? "" : "fix says fixed with fewer than min_cities readings",
      ok: statusOk
    });

    /* B_X for each quote currency (item 11): one rule, the engine's
       (basketPriceIn). The cities the trim by basket price kept in the
       USD pass are compared with the fix's b_x_cities when it publishes
       them; the engine takes that set from its USD pass, whether or not
       USD is a quote currency (review round 4: the last quote currency
       in catalog order could keep another set on an ulp tie). */
    var published = (fix || {}).b_x || {};
    var currencies = quoteCurrencies(fix);
    var bxChecks = 0;
    var keptCities = null;
    for (var c = 0; c < currencies.length; c++) {
      var X = currencies[c];
      var pub = num(published[X]);
      if (!isNum(pub)) {
        continue;
      }
      var rec = basketPriceIn(fix, X);
      checks.push(check("b_x." + X, pub, rec.value, tol));
      bxChecks += 1;
    }
    if (bxChecks > 0) {
      keptCities = basketPriceIn(fix, "USD").kept_cities || [];
    }
    if (bxChecks === 0) {
      notes.push("fix publishes no b_x to check");
    }
    if (keptCities !== null && Array.isArray((fix || {}).b_x_cities)) {
      var pubKept = fix.b_x_cities.map(String);
      var keptOk = sameSet(pubKept, keptCities);
      checks.push({
        name: "b_x cities",
        published: pubKept.slice().sort().join(","),
        recomputed: keptCities.slice().sort().join(","),
        diff: keptOk ? "" : "differs",
        ok: keptOk
      });
    }

    var ok = checks.every(function (x) { return x.ok; });
    return {
      ok: ok,
      tolerance: tol,
      trim_share: trimShare,
      min_cities: minCities,
      cumulative_factor: factor,
      readings_count: tm.n,
      dropped_each_end: tm.dropped_each_end,
      b_x_method: basketPriceIn(fix, currencies[0] || "USD").method,
      checks: checks,
      notes: notes
    };
  }

  /* Plain-text report: "matches" or the differences, one per line. */
  function formatVerify(result) {
    var lines = [];
    if (result.ok) {
      lines.push("matches: this page recomputed LU, the included cities, LU without income tax, the status and B_X for every quote currency from the readings above; all " + result.checks.length + " agree with the published fix to " + result.tolerance);
    } else {
      lines.push("DIFFERS: " + result.checks.filter(function (c) { return !c.ok; }).length + " check(s) outside " + result.tolerance);
    }
    lines.push("trim share " + result.trim_share + ", " + result.readings_count + " readings, " + result.dropped_each_end + " dropped each end, cumulative factor " + result.cumulative_factor);
    lines.push("B_X rule: " + result.b_x_method);
    for (var i = 0; i < result.checks.length; i++) {
      var c = result.checks[i];
      /* A passing line shows the recomputed value at the ten decimals the
         engine publishes and no difference, so a double's last digits do
         not read as a mismatch; a failing line keeps the raw double and
         the difference, which are the evidence (review round 3). */
      var pub = c.ok && isNum(c.published)
        ? fixedHalfEven(c.published, 10).replace(/\.?0+$/, "")
        : String(c.published);
      var rec = c.ok && isNum(c.recomputed)
        ? fixedHalfEven(c.recomputed, 10).replace(/\.?0+$/, "")
        : String(c.recomputed);
      var tail = c.ok ? "" : (isNum(c.diff) ? ("diff " + (c.diff === 0 ? "0" : c.diff.toExponential(3))) : String(c.diff || ""));
      lines.push((c.ok ? "  ok   " : "  FAIL ") + c.name + ": published " + pub + ", recomputed " + rec + (tail ? ", " + tail : ""));
    }
    for (var j = 0; j < result.notes.length; j++) {
      lines.push("  note: " + result.notes[j]);
    }
    return lines.join("\n");
  }

  return {
    VERSION: VERSION,
    DEFAULT_TRIM_SHARE: DEFAULT_TRIM_SHARE,
    DEFAULT_MIN_CITIES: DEFAULT_MIN_CITIES,
    SECONDS_PER_DAY: SECONDS_PER_DAY,
    SAT_PER_BTC: SAT_PER_BTC,
    EVERYDAY_ITEMS_USD: EVERYDAY_ITEMS_USD,
    closeEnough: closeEnough,
    withCommas: withCommas,
    fixedString: fixedString,
    readings: readings,
    trimShareOf: trimShareOf,
    minCitiesOf: minCitiesOf,
    cumulativeFactorOf: cumulativeFactorOf,
    basketFactorOf: basketFactorOf,
    basePeriodOf: basePeriodOf,
    publishedBasketPrice: publishedBasketPrice,
    luOf: luOf,
    referenceRates: referenceRates,
    rateUsdPerUnit: rateUsdPerUnit,
    convert: convert,
    quoteCurrencies: quoteCurrencies,
    isPlaceholder: isPlaceholder,
    trimCount: trimCount,
    trimmedMean: trimmedMean,
    statusForCount: statusForCount,
    basketPriceIn: basketPriceIn,
    formatTime: formatTime,
    fixedHalfEven: fixedHalfEven,
    compareCodePoints: compareCodePoints,
    canonicalNumber: canonicalNumber,
    checkIntegerLiterals: checkIntegerLiterals,
    canonical: canonical,
    fixHashBody: fixHashBody,
    quote: quote,
    satoshisPerLifeUnit: satoshisPerLifeUnit,
    bitcoinInLifeUnits: bitcoinInLifeUnits,
    everydayItems: everydayItems,
    verify: verify,
    formatVerify: formatVerify
  };
});
