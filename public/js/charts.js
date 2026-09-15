// Hand-built SVG charts, following the house chart rules: 2px lines, bars
// capped at 24px with a 4px rounded data-end, hairline solid gridlines, a
// legend whenever there are two series, a hover/focus layer on every chart,
// and text in ink tokens rather than series colours. Tooltip text is set with
// textContent — labels come from data.

import { moneyAxis, money } from './format.js';

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.append(el);
  return el;
}

function cssVar(el, name) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** Round the top of a scale to a clean number and give 4 evenly spaced ticks. */
function niceScale(max) {
  if (!(max > 0)) return { top: 100, ticks: [0, 25, 50, 75, 100] };
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) || 10 * pow;
  const top = step * Math.ceil(max / step);
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  return { top, ticks };
}

// --- tooltip ------------------------------------------------------------------

const tip = () => document.getElementById('chart-tooltip');

function showTooltip(title, rows, x, y) {
  const el = tip();
  el.replaceChildren();
  const t = document.createElement('div');
  t.className = 'tt-title';
  t.textContent = title;
  el.append(t);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tt-row';
    const key = document.createElement('span');
    key.className = 'key-line';
    key.style.background = r.color;
    const value = document.createElement('span');
    value.className = 'tt-value';
    value.textContent = r.value;
    const name = document.createElement('span');
    name.className = 'tt-name';
    name.textContent = r.name;
    row.append(key, value, name);
    el.append(row);
  }
  el.hidden = false;
  const rect = el.getBoundingClientRect();
  let left = x + 14;
  if (left + rect.width > window.innerWidth - 8) left = x - rect.width - 14;
  let top = y - rect.height - 12;
  if (top < 8) top = y + 16;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${top}px`;
}

function hideTooltip() {
  tip().hidden = true;
}

export function legend(items, shape = 'line') {
  return `<div class="legend">${items.map((i) => `
    <span class="legend-item"><span class="${shape === 'line' ? 'key-line' : 'key-rect'}" style="background:${i.color}"></span>${i.label}</span>`).join('')}</div>`;
}

function observe(container, draw) {
  let lastWidth = 0;
  const ro = new ResizeObserver(() => {
    const w = Math.round(container.clientWidth);
    if (w && w !== lastWidth) { lastWidth = w; draw(w); }
  });
  ro.observe(container);
  return () => ro.disconnect();
}

// --- cumulative line chart ------------------------------------------------------

/**
 * @param container element to render into
 * @param opts.series [{ name, colorVar, points: [{ x, y }], emphasis }]
 *        The emphasised series is drawn in colour with an area wash and an
 *        end label; the others recede to the muted tone.
 * @param opts.xMax    last x value on the axis
 * @param opts.xLabel  x -> tick/tooltip label
 * @param opts.height
 */
export function lineChart(container, { series, xMax, xLabel, height = 190 }) {
  container.classList.add('chart');
  container.tabIndex = 0;
  container.setAttribute('role', 'img');

  const draw = (width) => {
    container.replaceChildren();
    const pad = { top: 14, right: 16, bottom: 26, left: 48 };
    const w = Math.max(width, 240);
    const h = height;
    const iw = w - pad.left - pad.right;
    const ih = h - pad.top - pad.bottom;
    const maxY = Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.y)));
    const { top, ticks } = niceScale(maxY);
    const sx = (x) => pad.left + ((x - 1) / Math.max(1, xMax - 1)) * iw;
    const sy = (y) => pad.top + ih - (Math.max(0, y) / top) * ih;

    const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, height: h }, container);

    for (const t of ticks) {
      svgEl('line', { x1: pad.left, x2: w - pad.right, y1: sy(t), y2: sy(t), class: t === 0 ? 'base-line' : 'grid-line' }, svg);
      const label = svgEl('text', { x: pad.left - 8, y: sy(t) + 4, 'text-anchor': 'end' }, svg);
      label.textContent = moneyAxis(t);
    }
    const tickXs = [1, Math.round(xMax / 2), xMax];
    for (const x of tickXs) {
      const label = svgEl('text', { x: sx(x), y: h - 6, 'text-anchor': x === 1 ? 'start' : x === xMax ? 'end' : 'middle' }, svg);
      label.textContent = xLabel(x);
    }

    const ordered = [...series].sort((a, b) => Number(a.emphasis) - Number(b.emphasis));
    for (const s of ordered) {
      if (!s.points.length) continue;
      const color = s.emphasis ? cssVar(container, s.colorVar) : cssVar(container, '--series-muted');
      const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
      if (s.emphasis) {
        const last = s.points[s.points.length - 1];
        svgEl('path', {
          d: `${d}L${sx(last.x).toFixed(1)},${sy(0)}L${sx(s.points[0].x).toFixed(1)},${sy(0)}Z`,
          fill: color, 'fill-opacity': 0.1, stroke: 'none',
        }, svg);
      }
      svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      if (s.emphasis) {
        const last = s.points[s.points.length - 1];
        svgEl('circle', { cx: sx(last.x), cy: sy(last.y), r: 4, fill: color, stroke: cssVar(container, '--surface'), 'stroke-width': 2 }, svg);
      }
    }

    // Crosshair layer: snaps to the nearest day; one tooltip lists every series.
    const cross = svgEl('line', { y1: pad.top, y2: pad.top + ih, class: 'crosshair', visibility: 'hidden' }, svg);
    const dots = series.map((s) => svgEl('circle', {
      r: 4, visibility: 'hidden', stroke: cssVar(container, '--surface'), 'stroke-width': 2,
      fill: s.emphasis ? cssVar(container, s.colorVar) : cssVar(container, '--series-muted'),
    }, svg));
    const hit = svgEl('rect', { x: pad.left, y: 0, width: iw, height: h, fill: 'transparent' }, svg);

    const showAt = (x, clientX, clientY) => {
      const px = sx(x);
      cross.setAttribute('x1', px);
      cross.setAttribute('x2', px);
      cross.setAttribute('visibility', 'visible');
      const rows = [];
      series.forEach((s, i) => {
        const p = s.points.find((pt) => pt.x === x);
        if (!p) { dots[i].setAttribute('visibility', 'hidden'); return; }
        dots[i].setAttribute('cx', px);
        dots[i].setAttribute('cy', sy(p.y));
        dots[i].setAttribute('visibility', 'visible');
        rows.push({ name: s.name, value: money(p.y), color: s.emphasis ? cssVar(container, s.colorVar) : cssVar(container, '--series-muted') });
      });
      showTooltip(xLabel(x, true), rows, clientX, clientY);
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
      hideTooltip();
    };
    const xFromClient = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const local = ((clientX - rect.left) / rect.width) * w;
      return Math.min(xMax, Math.max(1, Math.round(1 + ((local - pad.left) / iw) * (xMax - 1))));
    };
    hit.addEventListener('pointermove', (e) => showAt(xFromClient(e.clientX), e.clientX, e.clientY));
    hit.addEventListener('pointerleave', hide);

    let focusX = null;
    container.onkeydown = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const lastEmph = (series.find((s) => s.emphasis) || series[0]).points.length || xMax;
      focusX = Math.min(xMax, Math.max(1, (focusX ?? lastEmph) + (e.key === 'ArrowRight' ? 1 : -1)));
      const rect = svg.getBoundingClientRect();
      showAt(focusX, rect.left + (sx(focusX) / w) * rect.width, rect.top + pad.top);
    };
    container.onblur = () => { focusX = null; hide(); };
  };

  return observe(container, draw);
}

// --- grouped column chart ------------------------------------------------------

/**
 * @param opts.labels  x categories (e.g. month keys)
 * @param opts.labelFor key -> short axis label
 * @param opts.titleFor key -> tooltip title
 * @param opts.series  [{ name, colorVar, values: [] }]
 * @param opts.selected index of the highlighted group, or null
 * @param opts.onSelect(index)
 */
export function columnChart(container, { labels, labelFor, titleFor, series, selected = null, onSelect, height = 220 }) {
  container.classList.add('chart');

  const draw = (width) => {
    container.replaceChildren();
    const pad = { top: 12, right: 8, bottom: 26, left: 48 };
    const w = Math.max(width, 260);
    const h = height;
    const iw = w - pad.left - pad.right;
    const ih = h - pad.top - pad.bottom;
    const maxY = Math.max(0, ...series.flatMap((s) => s.values));
    const { top, ticks } = niceScale(maxY);
    const sy = (y) => pad.top + ih - (Math.max(0, y) / top) * ih;
    const band = iw / labels.length;
    const gap = 2;
    const barW = Math.max(3, Math.min(24, (band * 0.72 - gap * (series.length - 1)) / series.length));
    const groupW = barW * series.length + gap * (series.length - 1);

    const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, height: h }, container);
    for (const t of ticks) {
      svgEl('line', { x1: pad.left, x2: w - pad.right, y1: sy(t), y2: sy(t), class: t === 0 ? 'base-line' : 'grid-line' }, svg);
      const label = svgEl('text', { x: pad.left - 8, y: sy(t) + 4, 'text-anchor': 'end' }, svg);
      label.textContent = moneyAxis(t);
    }

    const every = Math.ceil(labels.length / Math.max(1, Math.floor(iw / 44)));
    labels.forEach((key, i) => {
      const gx = pad.left + band * i + (band - groupW) / 2;
      const isSel = selected === i;

      if (isSel) {
        svgEl('rect', { x: pad.left + band * i + 1, y: pad.top, width: band - 2, height: ih, rx: 6, fill: cssVar(container, '--surface-2') }, svg);
      }
      series.forEach((s, si) => {
        const v = Math.max(0, s.values[i] || 0);
        const bh = (v / top) * ih;
        const x = gx + si * (barW + gap);
        const y = pad.top + ih - bh;
        const r = Math.min(4, barW / 2, bh);
        const color = cssVar(container, s.colorVar);
        if (bh > 0) {
          svgEl('path', {
            d: `M${x},${y + bh}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW - r}Q${x + barW},${y} ${x + barW},${y + r}V${y + bh}Z`,
            fill: color, opacity: selected == null || isSel ? 1 : 0.55,
          }, svg);
        }
      });
      if (i % every === 0 || i === labels.length - 1) {
        const label = svgEl('text', { x: pad.left + band * i + band / 2, y: h - 6, 'text-anchor': 'middle' }, svg);
        label.textContent = labelFor(key);
        if (isSel) label.setAttribute('style', `fill:${cssVar(container, '--ink')};font-weight:650`);
      }

      // The whole band is the hit target, bigger than the bars.
      const hit = svgEl('rect', {
        x: pad.left + band * i, y: 0, width: band, height: h, fill: 'transparent',
        tabindex: 0, role: 'button', 'aria-label': `${titleFor(key)}: ${series.map((s) => `${s.name} ${money(s.values[i] || 0)}`).join(', ')}`,
        style: onSelect ? 'cursor:pointer' : '',
      }, svg);
      const show = (cx, cy) => showTooltip(titleFor(key), series.map((s) => ({
        name: s.name, value: money(s.values[i] || 0), color: cssVar(container, s.colorVar),
      })), cx, cy);
      hit.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
      hit.addEventListener('pointerleave', hideTooltip);
      hit.addEventListener('focus', () => {
        const rect = hit.getBoundingClientRect();
        show(rect.left + rect.width / 2, rect.top + 20);
      });
      hit.addEventListener('blur', hideTooltip);
      if (onSelect) {
        hit.addEventListener('click', () => { hideTooltip(); onSelect(i); });
        hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(i); } });
      }
    });
  };

  return observe(container, draw);
}
