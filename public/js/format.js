// Formatting helpers. Dates are 'YYYY-MM-DD' strings throughout; they are
// parsed as local calendar dates so nothing shifts by a timezone.

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function money(n, { whole = false } = {}) {
  const v = Number(n) || 0;
  return (whole ? usd0 : usd).format(v === 0 ? 0 : v);
}

/** Signed for transactions: +$20.00 in, $20.00 out (no minus sign, like a statement). */
export function txnAmount(amount) {
  const v = Number(amount) || 0;
  return v > 0 ? `+${usd.format(v)}` : usd.format(Math.abs(v));
}

/** Compact for axis ticks: $0, $500, $1.2K, $12K. */
export function moneyAxis(n) {
  const v = Math.abs(Number(n) || 0);
  const sign = n < 0 ? '−' : '';
  if (v >= 1_000_000) return `${sign}$${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1000) return `${sign}$${(v / 1000).toFixed(v >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return `${sign}$${Math.round(v)}`;
}

export function pct(n, digits = 0) {
  return n == null || !Number.isFinite(Number(n)) ? '—' : `${Number(n).toFixed(digits)}%`;
}

export function parseDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function currentMonthKey() {
  return todayISO().slice(0, 7);
}

export function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export function monthShort(key, withYear = false) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', withYear ? { month: 'short', year: '2-digit' } : { month: 'short' });
}

export function shortDate(iso) {
  if (!iso) return '—';
  return parseDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function longDate(iso) {
  if (!iso) return '—';
  return parseDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Today", "Yesterday", or "Fri, Sep 12" (with year when not this year). */
export function dayHeading(iso) {
  const today = todayISO();
  if (iso === today) return 'Today';
  const y = parseDate(today);
  y.setDate(y.getDate() - 1);
  const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  if (iso === yesterday) return 'Yesterday';
  const d = parseDate(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "in 3 days", "tomorrow", "today", "2 days ago". */
export function relativeDay(iso) {
  const diff = Math.round((parseDate(iso) - parseDate(todayISO())) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
}

export function timeAgo(ts) {
  if (!ts) return 'never';
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function cadenceLabel(c) {
  return {
    weekly: 'Weekly', biweekly: 'Every 2 weeks', semimonthly: 'Twice a month', monthly: 'Monthly',
    bimonthly: 'Every 2 months', quarterly: 'Quarterly', semiannual: 'Twice a year', annual: 'Yearly',
  }[c] || c;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
