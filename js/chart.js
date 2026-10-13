// Stacked column chart in plain SVG, with a legend, a tap/hover tooltip and a
// table view. Colors come from CSS variables, so light/dark mode just works.

import { svg, h, clear, fmtNum, compactNum } from './util.js';

function niceStep(raw) {
  const exp = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * exp >= raw) return m * exp;
  return 10 * exp;
}

// Column with a 4px rounded top and a square base.
function roundTop(x, y, w, hgt, r) {
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

const observed = new WeakMap();

// spec: { periods: [{key, label, long}], series: [{key, label, color}], table: Map(period -> Map(series -> value)),
//         unit: '권', title: 'aria label' }
export function stackedBars(container, spec) {
  if (!observed.has(container)) {
    let lastWidth = 0;
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      if (w && Math.abs(w - lastWidth) > 4) {
        lastWidth = w;
        draw(container, observed.get(container));
      }
    });
    ro.observe(container);
    document.addEventListener('click', () => container.hideTip?.());
  }
  observed.set(container, spec);
  draw(container, spec);
}

function draw(container, { periods, series: allSeries, table, unit, title }) {
  clear(container);
  container.classList.add('chart');
  const val = (p, s) => table.get(p)?.get(s) || 0;
  const series = allSeries.filter((s) => periods.some((p) => val(p.key, s.key) > 0));
  const totals = periods.map((p) => series.reduce((sum, s) => sum + val(p.key, s.key), 0));
  const maxTotal = Math.max(0, ...totals);

  if (series.length > 1) {
    container.append(h('div', { class: 'legend' },
      series.map((s) => h('span', { class: 'legend-item' },
        h('span', { class: 'swatch', style: `background:${s.color}` }), s.label))));
  }

  const width = Math.max(260, container.clientWidth || 340);
  const height = 200;
  const m = { top: 20, right: 4, bottom: 24, left: 34 };
  const pw = width - m.left - m.right;
  const ph = height - m.top - m.bottom;
  const step = Math.max(1, niceStep(maxTotal / 4 || 1));
  const top = Math.max(step, Math.ceil(maxTotal / step) * step);
  const y = (v) => m.top + ph - (v / top) * ph;
  const slot = pw / periods.length;
  const bw = Math.min(24, Math.max(4, slot * 0.62));

  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title || '' });
  for (let v = 0; v <= top; v += step) {
    const yy = Math.round(y(v)) + 0.5;
    root.append(svg('line', { x1: m.left, x2: width - m.right, y1: yy, y2: yy, class: v === 0 ? 'axis' : 'grid' }));
    root.append(svg('text', { x: m.left - 6, y: yy + 4, class: 'tick', 'text-anchor': 'end' }, compactNum(v)));
  }

  const groups = [];
  const labelEvery = Math.ceil(40 / slot);
  const maxIndex = totals.indexOf(maxTotal);
  periods.forEach((p, i) => {
    const cx = m.left + slot * (i + 0.5);
    const g = svg('g', { class: 'bar' });
    const segs = series.map((s) => ({ s, v: val(p.key, s.key) })).filter((x) => x.v > 0);
    let acc = 0;
    segs.forEach(({ s, v }, j) => {
      const y0 = y(acc);
      const y1 = y(acc + v);
      acc += v;
      const hgt = y0 - y1 - (j > 0 ? 2 : 0); // 2px surface gap between stacked segments
      if (hgt < 0.5) return;
      const x = cx - bw / 2;
      const el = j === segs.length - 1
        ? svg('path', { d: roundTop(x, y1, bw, hgt, Math.min(4, hgt, bw / 2)) })
        : svg('rect', { x, y: y1, width: bw, height: hgt });
      el.style.fill = s.color;
      g.append(el);
    });
    if (totals[i] > 0 && (i === maxIndex || i === periods.length - 1)) {
      g.append(svg('text', { x: cx, y: y(totals[i]) - 6, class: 'cap', 'text-anchor': 'middle' }, compactNum(totals[i])));
    }
    if ((periods.length - 1 - i) % labelEvery === 0) {
      g.append(svg('text', { x: cx, y: height - 6, class: 'tick', 'text-anchor': 'middle' }, p.label));
    }
    root.append(g);
    groups.push(g);
  });

  // Tooltip: one per chart. Tap (or hover/focus) a column to see its numbers.
  const tip = h('div', { class: 'tip', hidden: true });
  const show = (i) => {
    groups.forEach((g, j) => g.classList.toggle('on', j === i));
    root.classList.add('hovering');
    const p = periods[i];
    const rows = series.length > 1 ? series.filter((s) => val(p.key, s.key) > 0).reverse() : [];
    clear(tip).append(
      h('div', { class: 'tip-head' }, p.long || p.label),
      h('div', { class: 'tip-total' }, `${fmtNum(totals[i])}${unit}`),
      ...rows.map((s) => h('div', { class: 'tip-row' },
        h('span', { class: 'key', style: `background:${s.color}` }),
        h('b', null, fmtNum(val(p.key, s.key))), ` ${s.label}`)),
    );
    tip.hidden = false;
    const cx = m.left + slot * (i + 0.5);
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(0, cx - tw / 2), width - tw)}px`;
    tip.style.top = `${Math.max(0, y(totals[i]) - tip.offsetHeight - 8) + root.getBoundingClientRect().top - container.getBoundingClientRect().top}px`;
  };
  const hide = () => {
    tip.hidden = true;
    root.classList.remove('hovering');
    groups.forEach((g) => g.classList.remove('on'));
  };
  periods.forEach((p, i) => {
    const hit = svg('rect', {
      x: m.left + slot * i, y: m.top, width: slot, height: ph + m.bottom,
      class: 'hit', tabindex: 0, 'aria-label': `${p.long || p.label} ${fmtNum(totals[i])}${unit}`,
    });
    hit.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && show(i));
    hit.addEventListener('click', (e) => {
      e.stopPropagation();
      show(i);
    });
    hit.addEventListener('focus', () => show(i));
    root.append(hit);
  });
  root.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && hide());
  container.hideTip = hide;

  container.append(root, tip);
  if (maxTotal === 0) container.append(h('div', { class: 'chart-empty' }, '이 기간에는 기록이 없어요'));

  // Same numbers without the chart (newest first).
  container.append(h('details', { class: 'table-view' },
    h('summary', null, '표로 보기'),
    h('div', { class: 'table-scroll' },
      h('table', null,
        h('thead', null, h('tr', null, h('th', null, '기간'), series.map((s) => h('th', null, s.label)), h('th', null, '합계'))),
        h('tbody', null, [...periods].reverse().map((p) => h('tr', null,
          h('th', null, p.long || p.label),
          series.map((s) => h('td', null, fmtNum(val(p.key, s.key)))),
          h('td', null, fmtNum(series.reduce((sum, s) => sum + val(p.key, s.key), 0))))))))));
}
