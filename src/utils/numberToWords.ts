const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

export function moneyToWords(amount: number, currency: string): string {
  if (currency === 'INR') return rupeesToWords(amount);
  if (!Number.isFinite(amount)) return '';
  if (currency !== 'USD') return `${currency} ${amount.toFixed(2)}`;
  const cents = Math.round(Math.abs(amount) * 100);
  let dollars = Math.floor(cents / 100);
  const parts: string[] = [];
  for (const [divisor, label] of [
    [1000000000, 'Billion'],
    [1000000, 'Million'],
    [1000, 'Thousand'],
  ] as const) {
    const group = Math.floor(dollars / divisor);
    if (group) parts.push(`${threeDigits(group)} ${label}`);
    dollars %= divisor;
  }
  if (dollars) parts.push(threeDigits(dollars));
  return `${amount < 0 ? 'Minus ' : ''}${parts.join(' ') || 'Zero'} Dollars and ${String(cents % 100).padStart(2, '0')}/100`;
}

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return TENS[t] + (o ? ' ' + ONES[o] : '');
}

function threeDigits(n: number): string {
  if (n === 0) return '';
  if (n < 100) return twoDigits(n);
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return ONES[h] + ' Hundred' + (rest ? ' ' + twoDigits(rest) : '');
}

/**
 * Convert a rupee amount to words in Indian numbering (Lakh, Crore).
 * Examples: 12345.67 → "Twelve Thousand Three Hundred Forty Five and Sixty Seven Paise Only"
 */
export function rupeesToWords(amount: number): string {
  if (!Number.isFinite(amount)) return '';
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);

  let result = '';
  if (rupees === 0) {
    result = 'Zero';
  } else {
    const crore = Math.floor(rupees / 10000000);
    const lakh = Math.floor((rupees % 10000000) / 100000);
    const thousand = Math.floor((rupees % 100000) / 1000);
    const hundred = rupees % 1000;
    const parts: string[] = [];
    if (crore) parts.push(twoDigits(crore) + ' Crore');
    if (lakh) parts.push(twoDigits(lakh) + ' Lakh');
    if (thousand) parts.push(twoDigits(thousand) + ' Thousand');
    if (hundred) parts.push(threeDigits(hundred));
    result = parts.join(' ').trim();
  }

  let out = `${result} Rupees`;
  if (paise > 0) out += ` and ${twoDigits(paise)} Paise`;
  out += ' Only';
  if (negative) out = `Minus ${out}`;
  return out;
}
