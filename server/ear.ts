/**
 * "Writing for the ear" normaliser.
 *
 * Shop text is written to be READ: `RC-1147-B`, `39 Nm`, `0W-20`, bin `A14`.
 * Handed to any TTS verbatim, those render as a smear of letters and digits
 * that a technician under a lift cannot write down and must not guess at. A
 * misheard torque spec is a safety defect, not a UX blemish.
 *
 * So the agent never speaks catalog text directly. Every identifier, spec and
 * grade passes through this module first, which rewrites it into words, groups
 * digits the way a human parts counter says them, and inserts commas as
 * breath-length pauses.
 *
 * Each rule is named. `explain()` returns which rules fired, which is what
 * scripts/pronounce.ts uses to produce before/after evidence with the model and
 * speaker held constant.
 */

const ONES = ['zero','one','two','three','four','five','six','seven','eight','nine','ten',
  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];

export function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10), o = n % 10;
  return o === 0 ? TENS[t] : `${TENS[t]}-${ONES[o]}`;
}

export function numberToWords(n: number): string {
  if (n < 0) return `minus ${numberToWords(-n)}`;
  if (n < 100) return twoDigits(n);
  if (n < 1000) {
    const h = Math.floor(n / 100), r = n % 100;
    return r === 0 ? `${ONES[h]} hundred` : `${ONES[h]} hundred ${twoDigits(r)}`;
  }
  if (n < 1_000_000) {
    const th = Math.floor(n / 1000), r = n % 1000;
    return r === 0 ? `${numberToWords(th)} thousand` : `${numberToWords(th)} thousand ${numberToWords(r)}`;
  }
  return String(n);
}

function decimalToWords(s: string): string {
  const [i, f] = s.split('.');
  const head = numberToWords(parseInt(i, 10));
  if (!f) return head;
  return `${head} point ${f.split('').map((d) => ONES[Number(d)]).join(' ')}`;
}

/** One two-digit group, keeping a leading zero audible: "03" -> "oh three". */
function pairSay(p: string): string {
  if (p.length === 1) return ONES[Number(p)];
  if (p[0] === '0') return `oh ${ONES[Number(p[1])]}`;
  return twoDigits(parseInt(p, 10));
}

/** Say a run of digits the way a parts counter says it: paired, not one by one. */
function digitsAsPairs(d: string): string {
  if (d.length <= 2) return pairSay(d);
  if (d.length === 3) return `${ONES[Number(d[0])]} ${pairSay(d.slice(1))}`;
  if (d.length === 4) {
    // 1147 -> "eleven forty-seven"; 1100 -> "eleven hundred"
    if (d.slice(2) === '00') return `${twoDigits(parseInt(d.slice(0, 2), 10))} hundred`;
    return `${pairSay(d.slice(0, 2))} ${pairSay(d.slice(2))}`;
  }
  // 40312 -> "four, oh three, twelve" -- a leading odd digit, then pairs. That
  // is how a parts counter reads a long number off a shelf label, and how the
  // technician writes it back down.
  const head = d.length % 2 === 1 ? ONES[Number(d[0])] : '';
  const rest = d.length % 2 === 1 ? d.slice(1) : d;
  const groups: string[] = [];
  for (let i = 0; i < rest.length; i += 2) groups.push(pairSay(rest.slice(i, i + 2)));
  return [head, ...groups].filter(Boolean).join(', ');
}

/** Letters are spoken as letters, spaced so they do not fuse into a word. */
function lettersSpaced(s: string): string {
  return s.toUpperCase().split('').join(' ');
}

type Rule = { name: string; re: RegExp; fn: (m: RegExpMatchArray) => string };

const RULES: Rule[] = [
  {
    // 0W-20, 5W-30, 10W-40 -- oil grades. Never "zero double-you dash twenty".
    name: 'oil-grade',
    re: /\b(\d{1,2})W-(\d{2})\b/g,
    fn: (m) => `${numberToWords(Number(m[1]))} W ${numberToWords(Number(m[2]))}`,
  },
  {
    // RC-1147-B, WP-40312-A, SP-9RY-C -- alphanumeric SKUs.
    // Commas are deliberate: ws3 renders them as short pauses, which gives the
    // tech time to write each group down.
    name: 'sku',
    re: /\b([A-Z]{2,3})-([0-9]{2,6})(?:-([A-Z]{1,2}))?\b/g,
    fn: (m) =>
      `${lettersSpaced(m[1])}, ${digitsAsPairs(m[2])}${m[3] ? `, ${lettersSpaced(m[3])}` : ''}`,
  },
  {
    // SP-9RY-C style mixed middle groups.
    name: 'sku-mixed',
    re: /\b([A-Z]{2,3})-([0-9][A-Z]{1,3})-([A-Z])\b/g,
    fn: (m) => `${lettersSpaced(m[1])}, ${ONES[Number(m[2][0])]} ${lettersSpaced(m[2].slice(1))}, ${lettersSpaced(m[3])}`,
  },
  {
    // Model years. "2019 Civic" is "twenty nineteen Civic" in a shop, never
    // "two thousand and nineteen". Runs after the SKU rules, whose output
    // contains no digits, so it cannot eat part-number groups.
    name: 'model-year',
    re: /\b(19|20)(\d{2})\b(?=\s+[A-Z])/g,
    fn: (m) => {
      const c = m[1] === '19' ? 'nineteen' : 'twenty';
      const yy = parseInt(m[2], 10);
      if (yy === 0) return `${c} hundred`;
      return `${c} ${yy < 10 ? `oh ${ONES[yy]}` : twoDigits(yy)}`;
    },
  },
  {
    name: 'torque-nm',
    re: /\b(\d+(?:\.\d+)?)\s*Nm\b/gi,
    fn: (m) => `${decimalToWords(m[1])} newton metres`,
  },
  {
    name: 'torque-ftlb',
    re: /\b(\d+(?:\.\d+)?)\s*(?:ft-?lbs?|lb-?ft)\b/gi,
    fn: (m) => `${decimalToWords(m[1])} foot pounds`,
  },
  {
    name: 'bar-pressure',
    re: /\b(\d+(?:\.\d+)?)\s*bar\b/gi,
    fn: (m) => `${decimalToWords(m[1])} bar`,
  },
  {
    name: 'litres',
    re: /\b(\d+(?:\.\d+)?)\s*L\b/g,
    fn: (m) => `${decimalToWords(m[1])} litres`,
  },
  {
    // Bin A14, D19 -- shelf locations.
    name: 'bin',
    re: /\bbin\s+([A-Z])([0-9]{1,3})\b/gi,
    fn: (m) => `bin ${lettersSpaced(m[1])} ${numberToWords(Number(m[2]))}`,
  },
  {
    // 1.5T engine code.
    name: 'engine-code',
    re: /\b(\d\.\d)T\b/g,
    fn: (m) => `${decimalToWords(m[1])} turbo`,
  },
  {
    // Bare decimals that survived the rules above.
    name: 'decimal',
    re: /\b(\d+\.\d+)\b/g,
    fn: (m) => decimalToWords(m[1]),
  },
  {
    // Bare counts: "6 on the shelf" -> "six on the shelf". Runs last, so every
    // rule above has already claimed the digits it cares about. Capped at 99 so
    // it cannot touch a year or a part-number fragment that slipped through.
    name: 'small-count',
    re: /(?<![\w.-])(\d{1,2})(?![\w.-])/g,
    fn: (m) => numberToWords(Number(m[1])),
  },
];

export type EarResult = { text: string; rulesFired: string[] };

/** Rewrite catalog text into text meant to be heard once, under a car. */
export function forTheEar(input: string): EarResult {
  let out = input;
  const fired: string[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    if (!rule.re.test(out)) continue;
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpMatchArray;
      return rule.fn(m);
    });
    fired.push(rule.name);
  }
  // Long sentences are hard to follow at arm's length from a speaker. Split on
  // semicolons, which read as full stops to the ear anyway.
  out = out.replace(/;\s*/g, '. ');
  out = out.replace(/\s{2,}/g, ' ').trim();
  return { text: out, rulesFired: fired };
}

export function explain(input: string): EarResult & { before: string } {
  const r = forTheEar(input);
  return { ...r, before: input };
}
