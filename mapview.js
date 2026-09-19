// Shared by the Control preview and the Presentation window so both draw the map identically.
// View: {scale, tx, ty}; tx/ty are fractions of the stage size. Marks: [{c: '#rrggbb', w, pts: [[x, y], ...]}]
// with x/y as fractions of the stage in un-zoomed space (so marks stay attached to the map).
(function () {
  const VBW = 1600;
  const VBH = 900;
  const NS = 'http://www.w3.org/2000/svg';

  function applyView(world, v) {
    world.style.transform = `translate(${v.tx * 100}%, ${v.ty * 100}%) scale(${v.scale})`;
  }

  function renderMarks(svg, marks) {
    svg.replaceChildren();
    for (const m of marks) {
      const pts = m.pts.length === 1 ? [m.pts[0], m.pts[0]] : m.pts; // a single tap still draws a dot
      const line = document.createElementNS(NS, 'polyline');
      line.setAttribute('points', pts.map((p) => `${(p[0] * VBW).toFixed(1)},${(p[1] * VBH).toFixed(1)}`).join(' '));
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', m.c);
      line.setAttribute('stroke-width', m.w);
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(line);
    }
  }

  window.MapView = { applyView, renderMarks, VBW, VBH };
})();
