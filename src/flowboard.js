/*!
 * FlowBoard — a dependency-free pan/zoom whiteboard for nodes + connectors.
 * Vanilla JS, no build step, CSP-safe (no external requests).
 *
 *   const board = new FlowBoard('#app', { theme:'auto', minimap:true });
 *   board.setNodes([{ id:'a', x:40, y:40, title:'Hello', body:'world', variant:'accent' }]);
 *   board.setEdges([{ from:'a', to:'b', dir:'h', arrow:true, label:'next' }]);
 *   board.fit();
 *
 * Events: 'change','nodemove','nodeclick','select','connect','edgeclick','zoom','theme','edit'
 */
(function (global) {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var CDN = 'https://cdn.jsdelivr.net/gh/PalmarHealer/flowboard@v1.1.0/dist/flowboard.auto.js';
  function el(tag, cls, parent) { var d = document.createElement(tag); if (cls) d.className = cls; if (parent) parent.appendChild(d); return d; }
  function svg(tag, parent) { var e = document.createElementNS(SVGNS, tag); if (parent) parent.appendChild(e); return e; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function FlowBoard(target, options) {
    if (!(this instanceof FlowBoard)) return new FlowBoard(target, options);
    var host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) throw new Error('FlowBoard: target not found');

    this.options = Object.assign({
      theme: 'light', grid: true, gridStyle: 'dots', gridSize: 26, gridHideBelow: 0.75,
      snap: 0, clickToEdit: true, toolbar: true, minimap: true, inspector: true, controls: true,
      readOnly: true, connectable: true,
      minZoom: 0.2, maxZoom: 2.4, zoomStep: 1.15, defaultNodeWidth: 280, fitPadding: 60
    }, options || {});

    this._host = host;
    this._nodes = []; this._edges = []; this._nodeIndex = {};
    this._sel = {}; this._selEdge = null;
    this._view = { x: 0, y: 0, s: 1 };
    this._listeners = {};
    this._drag = this._pan = this._connect = this._editing = this._edrag = this._marquee = null;
    this._uid = 0;
    this._hist = []; this._histAt = -1; this._histSuspended = false; this._histTimer = null;

    this._build();
    this.setTheme(this.options.theme);
    this._bind();
    var self = this; this.on('change', function () { self._scheduleHistory(); });
    this._updateControls();
  }

  FlowBoard.prototype = {

    /* ---------- DOM ---------- */
    _build: function () {
      var o = this.options, host = this._host;
      host.classList.add('fb');
      if (!o.grid || o.gridStyle === 'none') host.classList.add('fb--nogrid');
      else if (o.gridStyle === 'lines') host.classList.add('fb--grid-lines');
      if (o.readOnly) host.classList.add('fb--readonly');

      this._viewport = el('div', 'fb__viewport', host);
      this._world = el('div', 'fb__world', this._viewport);
      this._svg = svg('svg', this._world); this._svg.setAttribute('class', 'fb__edges');
      var defs = svg('defs', this._svg), mk = svg('marker', defs);
      this._arrowId = 'fb-arrow-' + (++FlowBoard._n);
      mk.setAttribute('id', this._arrowId); mk.setAttribute('viewBox', '0 0 10 10');
      mk.setAttribute('refX', '8'); mk.setAttribute('refY', '5'); mk.setAttribute('markerWidth', '7'); mk.setAttribute('markerHeight', '7'); mk.setAttribute('orient', 'auto-start-reverse');
      var ap = svg('path', mk); ap.setAttribute('d', 'M0,0 L10,5 L0,10 z'); ap.setAttribute('fill', 'context-stroke');
      this._edgeLayer = svg('g', this._svg); this._tempLayer = svg('g', this._svg); this._handleLayer = svg('g', this._svg);
      this._marqueeEl = el('div', 'fb__marquee', this._world); this._marqueeEl.style.display = 'none';

      if (o.toolbar) this._buildToolbar();
      if (o.controls !== false) this._buildControls();
      if (o.minimap) this._buildMinimap();
      this._buildRTE();
      if (o.inspector) this._inspector = el('div', 'fb__inspector', host);
    },

    _buildToolbar: function () {
      var self = this, tb = el('div', 'fb__toolbar', this._host);
      function btn(label, title, fn) { var b = el('button', null, tb); b.type = 'button'; b.innerHTML = label; b.title = title; b.addEventListener('click', fn); return b; }
      btn(ICON('zoom-out'), 'Verkleinern', function () { self.zoomBy(1 / self.options.zoomStep); });
      this._zoomLabel = el('span', 'fb__zoom', tb); this._zoomLabel.textContent = '100%';
      btn(ICON('zoom-in'), 'Vergrößern', function () { self.zoomBy(self.options.zoomStep); });
      el('span', 'fb__sep', tb);
      btn(ICON('maximize'), 'Alles einpassen', function () { self.fit(); });
      this._snapBtn = btn(ICON('grid-dots'), 'Am Raster einrasten', function () { self.toggleSnap(); });
      if (this.options.snap) this._snapBtn.classList.add('is-active');
      this._themeBtn = btn(ICON('moon'), 'Theme umschalten', function () { self.setTheme(self.getTheme() === 'dark' ? 'light' : 'dark'); });
    },

    _buildMinimap: function () {
      var self = this, wrap = el('div', 'fb__minimap', this._host), c = el('canvas', null, wrap);
      c.width = 180; c.height = 120; this._mini = c; this._miniCtx = c.getContext('2d');
      function toWorld(e) { var r = c.getBoundingClientRect(), m = self._miniMap; if (!m) return null; return { x: (e.clientX - r.left - m.ox) / m.s, y: (e.clientY - r.top - m.oy) / m.s }; }
      wrap.addEventListener('pointerdown', function (e) { var p = toWorld(e); if (!p) return; self._miniDrag = true; self.centerOn(p.x, p.y); wrap.setPointerCapture(e.pointerId); e.stopPropagation(); });
      wrap.addEventListener('pointermove', function (e) { if (self._miniDrag) { var p = toWorld(e); if (p) self.centerOn(p.x, p.y); } });
      function end(e) { self._miniDrag = false; try { wrap.releasePointerCapture(e.pointerId); } catch (_) {} }
      wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', end);
    },

    _buildRTE: function () {
      var bar = el('div', 'fb__rte', this._host); this._rte = bar;
      function cmd(label, title, command, val) {
        var b = el('button', null, bar); b.type = 'button'; b.innerHTML = label; b.title = title;
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function () { document.execCommand(command, false, val || null); });
      }
      cmd(ICON('bold'), 'Fett', 'bold'); cmd(ICON('italic'), 'Kursiv', 'italic'); cmd(ICON('underline'), 'Unterstrichen', 'underline');
      cmd(ICON('list'), 'Aufzählung', 'insertUnorderedList'); cmd(ICON('list-numbers'), 'Nummerierte Liste', 'insertOrderedList');
      cmd(ICON('heading'), 'Überschrift', 'formatBlock', '<h4>'); cmd(ICON('clear-formatting'), 'Formatierung entfernen', 'removeFormat');
    },

    _buildControls: function () {
      var self = this, bar = el('div', 'fb__controls', this._host); this._controls = bar;
      function b(html, title, fn) { var x = el('button', null, bar); x.type = 'button'; x.innerHTML = html; x.title = title; x.addEventListener('click', fn); return x; }
      this._editBtn = b(ICON('pencil') + '<span>Edit</span>', 'Bearbeiten', function () { self.setReadOnly(!self.options.readOnly); });
      this._undoBtn = b(ICON('arrow-back-up'), 'Rückgängig (Strg+Z)', function () { self.undo(); });
      this._redoBtn = b(ICON('arrow-forward-up'), 'Wiederholen (Strg+Umschalt+Z)', function () { self.redo(); });
      this._addBtn = b(ICON('plus') + '<span>Card</span>', 'Neue Karte', function () { self._addAtCenter(); });
      this._saveBtn = b(ICON('device-floppy') + '<span>Save</span>', 'Speichern', function () {
        if ((self._listeners.save || []).length) self.emit('save', self.toJSON()); else self._downloadHTML();
      });
    },
    _updateControls: function () {
      if (!this._controls) return;
      var ro = this.options.readOnly;
      this._editBtn.innerHTML = ICON(ro ? 'pencil' : 'check') + '<span>' + (ro ? 'Edit' : 'Done') + '</span>';
      this._editBtn.title = ro ? 'Bearbeiten' : 'Fertig (Präsentationsmodus)';
      var show = ro ? 'none' : '';
      if (this._addBtn) this._addBtn.style.display = show;
      if (this._undoBtn) this._undoBtn.style.display = show;
      if (this._redoBtn) this._redoBtn.style.display = show;
      if (this._saveBtn) this._saveBtn.style.display = (!ro && this._histAt > 0) ? '' : 'none';
    },
    _addAtCenter: function () {
      var r = this._viewport.getBoundingClientRect(), v = this._view;
      var wx = (r.width / 2 - v.x) / v.s, wy = (r.height / 2 - v.y) / v.s;
      var n = this.addNode({ x: wx - 100, y: wy - 40, width: 220, title: 'New card', body: '' });
      this._clearSel(); this._select(n.id, true); return n;
    },
    _downloadHTML: function () {
      var data = JSON.stringify(this.toJSON());
      var html = '<!doctype html>\n<meta charset="utf-8">\n<title>FlowBoard</title>\n' +
        '<div id="app" style="position:fixed;inset:0"></div>\n' +
        '<script src="' + CDN + '"><\/script>\n' +
        '<script>new FlowBoard("#app",{readOnly:true,theme:"' + this.getTheme() + '"}).fromJSON(' + data + ');<\/script>\n';
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      a.download = 'flowboard.html'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    },

    /* ---------- data API ---------- */
    setNodes: function (list) { this._clearNodes(); (list || []).forEach(this.addNode, this); this._drawEdges(); this.emit('change'); return this; },
    addNode: function (n) {
      n = Object.assign({}, n);
      if (n.id == null) n.id = 'n' + (++this._uid);
      if (n.width == null) n.width = this.options.defaultNodeWidth;
      if (n.x == null) n.x = 40; if (n.y == null) n.y = 40;
      this._nodes.push(n); this._nodeIndex[n.id] = n;
      this._renderNode(n); this._drawEdges(); this._drawMinimap(); this.emit('change'); return n;
    },
    updateNode: function (id, patch) { var n = this._nodeIndex[id]; if (!n) return this; Object.assign(n, patch); if (n._el) { n._el.remove(); n._el = null; this._renderNode(n); } this._drawEdges(); this._drawMinimap(); this.emit('change'); return this; },
    removeNode: function (id) {
      var n = this._nodeIndex[id]; if (!n) return this; if (n._el) n._el.remove();
      this._nodes = this._nodes.filter(function (x) { return x.id !== id; }); delete this._nodeIndex[id]; delete this._sel[id];
      this._edges = this._edges.filter(function (e) { var k = e.from !== id && e.to !== id; if (!k) { if (e._path) e._path.remove(); if (e._label) e._label.remove(); } return k; });
      this._drawEdges(); this._drawMinimap(); this._refreshInspector(); this.emit('change'); return this;
    },
    getNode: function (id) { return this._nodeIndex[id]; },

    setEdges: function (list) { this._edges.forEach(function (e) { if (e._path) e._path.remove(); if (e._label) e._label.remove(); }); this._edges = []; (list || []).forEach(this.addEdge, this); this._drawEdges(); this.emit('change'); return this; },
    addEdge: function (e) { e = Object.assign({ arrow: true }, e); if (e.style == null) e.style = e.dashed ? 'dashed' : 'solid'; if (e.id == null) e.id = 'e' + (++this._uid); this._edges.push(e); this._drawEdges(); this.emit('change'); return e; },
    updateEdge: function (id, patch) { var e = this._getEdge(id); if (!e) return this; Object.assign(e, patch); this._drawEdges(); this.emit('change'); return this; },
    removeEdge: function (id) { this._edges = this._edges.filter(function (e) { if (e.id === id) { if (e._path) e._path.remove(); if (e._label) e._label.remove(); if (e._hs) e._hs.forEach(function (c) { c.remove(); }); return false; } return true; }); this.emit('change'); return this; },
    _getEdge: function (id) { for (var i = 0; i < this._edges.length; i++) if (this._edges[i].id === id) return this._edges[i]; return null; },

    /* ---------- node rendering ---------- */
    _clearNodes: function () { this._nodes.forEach(function (n) { if (n._el) n._el.remove(); }); this._nodes = []; this._nodeIndex = {}; this._sel = {}; },
    _renderAllNodes: function () { var self = this; this._nodes.forEach(function (n) { if (n._el) n._el.remove(); n._el = null; self._renderNode(n); }); },
    _renderNode: function (n) {
      var d = el('div', 'fb-node' + (n.variant ? ' fb-node--' + n.variant : '') + (n.className ? ' ' + n.className : ''));
      d.style.left = n.x + 'px'; d.style.top = n.y + 'px'; d.style.width = n.width + 'px'; d.setAttribute('data-id', n.id);
      if (n.tag) el('div', 'fb-node__tag', d).textContent = n.tag;
      if (n.title != null) el('div', 'fb-node__title', d).textContent = n.title;
      var b = el('div', 'fb-node__body', d); b.setAttribute('data-placeholder', 'Klick zum Bearbeiten'); if (n.body != null) b.innerHTML = n.body;
      if (this.options.connectable && !this.options.readOnly) ['r', 'l', 't', 'b'].forEach(function (s) { el('span', 'fb-port fb-port--' + s, d).setAttribute('data-side', s); });
      n._el = d; this._world.appendChild(d); n._h = d.offsetHeight; this._applyNodeStyle(n);
      if (this._sel[n.id]) d.classList.add('is-selected');
    },
    _applyNodeStyle: function (n) { var d = n._el; if (!d) return; d.style.background = n.bg || ''; d.style.borderColor = n.border || ''; d.style.borderWidth = (n.borderWidth != null ? n.borderWidth + 'px' : ''); d.style.borderStyle = n.borderStyle || ''; n._h = d.offsetHeight; },

    /* ---------- edges ---------- */
    _anchor: function (n, side) { var h = n._h || (n._el ? n._el.offsetHeight : 60); switch (side) { case 'r': return { x: n.x + n.width, y: n.y + h / 2 }; case 'l': return { x: n.x, y: n.y + h / 2 }; case 't': return { x: n.x + n.width / 2, y: n.y }; default: return { x: n.x + n.width / 2, y: n.y + h }; } },
    _sideBetween: function (from, to) { var dx = to.x - from.x, dy = to.y - from.y; if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'r' : 'l'; return dy >= 0 ? 'b' : 't'; },
    _resolveEnds: function (e) {
      var self = this;
      function end(which) {
        if (self._edrag && self._edrag.edge === e.id && self._edrag.which === which) return { free: true, x: self._edrag.x, y: self._edrag.y };
        var id = e[which], xy = e[which + 'XY'], n = id != null ? self._nodeIndex[id] : null;
        if (n) { var h = n._h || 60; return { node: n, cx: n.x + n.width / 2, cy: n.y + h / 2 }; }
        if (xy) return { free: true, x: xy.x, y: xy.y };
        return null;
      }
      var A = end('from'), B = end('to'); if (!A || !B) return null;
      var aRef = A.free ? A : { x: A.cx, y: A.cy }, bRef = B.free ? B : { x: B.cx, y: B.cy };
      var sA = this._sideBetween(aRef, bRef), sB = this._sideBetween(bRef, aRef);
      if (e.dir === 'h') { sA = 'r'; sB = 'l'; } else if (e.dir === 'v') { sA = 'b'; sB = 't'; }
      if (e.fromSide) sA = e.fromSide; if (e.toSide) sB = e.toSide;
      return { p1: A.free ? { x: A.x, y: A.y } : this._anchor(A.node, sA), s1: sA, p2: B.free ? { x: B.x, y: B.y } : this._anchor(B.node, sB), s2: sB };
    },
    _pathD: function (p1, s1, p2) { if (s1 === 'r' || s1 === 'l') { var cx = (p1.x + p2.x) / 2; return 'M' + p1.x + ',' + p1.y + ' C' + cx + ',' + p1.y + ' ' + cx + ',' + p2.y + ' ' + p2.x + ',' + p2.y; } var cy = (p1.y + p2.y) / 2; return 'M' + p1.x + ',' + p1.y + ' C' + p1.x + ',' + cy + ' ' + p2.x + ',' + cy + ' ' + p2.x + ',' + p2.y; },
    _dash: function (style, w) { if (style === 'dashed') return (w * 2.2) + ' ' + (w * 2); if (style === 'dotted') return '1 ' + (w * 2.4); return ''; },
    _drawEdges: function () {
      var self = this;
      this._edges.forEach(function (e) {
        var ends = self._resolveEnds(e);
        if (!ends) { if (e._path) e._path.remove(); if (e._label) e._label.remove(); self._removeHandles(e); e._path = e._label = null; return; }
        var p1 = ends.p1, p2 = ends.p2, w = e.width || 2.4, sel = (e.id === self._selEdge);
        if (!e._path) {
          e._path = svg('path', self._edgeLayer); e._path.setAttribute('class', 'fb-edge'); e._path.setAttribute('fill', 'none');
          e._path.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); self._selectEdge(e.id); });
          e._path.addEventListener('click', function () { self.emit('edgeclick', e); });
        }
        e._path.setAttribute('d', self._pathD(p1, ends.s1, p2));
        e._path.setAttribute('stroke', e.color || (ends.s1 === 'r' || ends.s1 === 'l' ? 'var(--fb-accent)' : 'var(--fb-wire)'));
        e._path.setAttribute('stroke-width', sel ? w + 1.5 : w);
        e._path.setAttribute('stroke-linecap', e.style === 'dotted' ? 'round' : 'butt');
        var dash = self._dash(e.style, w); if (dash) e._path.setAttribute('stroke-dasharray', dash); else e._path.removeAttribute('stroke-dasharray');
        if (e.arrow) e._path.setAttribute('marker-end', 'url(#' + self._arrowId + ')'); else e._path.removeAttribute('marker-end');
        if (e.label) { if (!e._label) { e._label = svg('text', self._edgeLayer); e._label.setAttribute('text-anchor', 'middle'); } e._label.setAttribute('x', (p1.x + p2.x) / 2); e._label.setAttribute('y', (p1.y + p2.y) / 2 - 6); e._label.textContent = e.label; }
        else if (e._label) { e._label.remove(); e._label = null; }
        self._removeHandles(e);
      });
      this._drawMinimap();
    },
    _ensureHandles: function (e, p1, p2) {
      var self = this;
      if (!e._hs) e._hs = ['from', 'to'].map(function (which) {
        var c = svg('circle', self._handleLayer); c.setAttribute('r', 6); c.setAttribute('class', 'fb-handle');
        c.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); self._edrag = { edge: e.id, which: which, x: p1.x, y: p1.y }; try { self._viewport.setPointerCapture(ev.pointerId); } catch (_) {} });
        return c;
      });
      e._hs[0].setAttribute('cx', p1.x); e._hs[0].setAttribute('cy', p1.y);
      e._hs[1].setAttribute('cx', p2.x); e._hs[1].setAttribute('cy', p2.y);
    },
    _removeHandles: function (e) { if (e._hs) { e._hs.forEach(function (c) { c.remove(); }); e._hs = null; } },

    /* ---------- view ---------- */
    _apply: function () {
      var v = this._view, g = this.options.gridSize || 26;
      this._world.style.transform = 'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.s + ')';
      this._viewport.style.backgroundSize = (g * v.s) + 'px ' + (g * v.s) + 'px';
      this._viewport.style.backgroundPosition = v.x + 'px ' + v.y + 'px';
      if (this.options.gridHideBelow) this._host.classList.toggle('fb--grid-hidden', v.s < this.options.gridHideBelow);
      if (this._zoomLabel) this._zoomLabel.textContent = Math.round(v.s * 100) + '%';
      if (this._editing) this._openRTE(this._editing.node);
      this._drawMinimap();
    },
    _zoomAt: function (ns, cx, cy) { ns = clamp(ns, this.options.minZoom, this.options.maxZoom); var v = this._view; v.x = cx - (cx - v.x) * (ns / v.s); v.y = cy - (cy - v.y) * (ns / v.s); v.s = ns; this._apply(); this.emit('zoom', v.s); },
    zoomBy: function (f) { var r = this._viewport.getBoundingClientRect(); this._zoomAt(this._view.s * f, r.width / 2, r.height / 2); },
    setZoom: function (s) { var r = this._viewport.getBoundingClientRect(); this._zoomAt(s, r.width / 2, r.height / 2); },
    centerOn: function (wx, wy) { var r = this._viewport.getBoundingClientRect(), v = this._view; v.x = r.width / 2 - wx * v.s; v.y = r.height / 2 - wy * v.s; this._apply(); },
    _bounds: function () { if (!this._nodes.length) return null; var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; this._nodes.forEach(function (n) { var h = n._h || (n._el ? n._el.offsetHeight : 60); x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.width); y1 = Math.max(y1, n.y + h); }); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; },
    fit: function () { var b = this._bounds(); if (!b) return this; var r = this._viewport.getBoundingClientRect(), p = this.options.fitPadding; var s = clamp(Math.min((r.width - p) / b.w, (r.height - p) / b.h), this.options.minZoom, this.options.maxZoom); this._view.s = s; this._view.x = (r.width - b.w * s) / 2 - b.x * s; this._view.y = (r.height - b.h * s) / 2 - b.y * s; this._apply(); return this; },
    _toWorld: function (e) { var r = this._viewport.getBoundingClientRect(), v = this._view; return { x: (e.clientX - r.left - v.x) / v.s, y: (e.clientY - r.top - v.y) / v.s }; },

    /* ---------- minimap ---------- */
    _drawMinimap: function () {
      if (!this._mini) return;
      var ctx = this._miniCtx, W = this._mini.width, H = this._mini.height; ctx.clearRect(0, 0, W, H);
      var b = this._bounds(); if (!b) { this._miniMap = null; return; }
      var pad = 8, s = Math.min((W - pad * 2) / b.w, (H - pad * 2) / b.h);
      var ox = pad - b.x * s + (W - pad * 2 - b.w * s) / 2, oy = pad - b.y * s + (H - pad * 2 - b.h * s) / 2;
      this._miniMap = { ox: ox, oy: oy, s: s };
      var css = getComputedStyle(this._host);
      ctx.fillStyle = (css.getPropertyValue('--fb-accent-line') || '#b9d0f2').trim();
      this._nodes.forEach(function (n) { var h = n._h || 60; ctx.fillRect(ox + n.x * s, oy + n.y * s, Math.max(2, n.width * s), Math.max(2, h * s)); });
      var v = this._view, r = this._viewport.getBoundingClientRect();
      ctx.strokeStyle = (css.getPropertyValue('--fb-accent') || '#2f6fd6').trim(); ctx.lineWidth = 1.5;
      ctx.strokeRect(ox + (-v.x / v.s) * s, oy + (-v.y / v.s) * s, (r.width / v.s) * s, (r.height / v.s) * s);
    },

    /* ---------- rich-text editing ---------- */
    startEdit: function (id, which) {
      if (this.options.readOnly) return; var n = this._nodeIndex[id]; if (!n || !n._el) return;
      this.endEdit(); which = which || 'body';
      var t = n._el.querySelector(which === 'title' ? '.fb-node__title' : '.fb-node__body'); if (!t) t = el('div', 'fb-node__body', n._el);
      n._el.classList.add('is-editing'); t.setAttribute('contenteditable', 'true'); t.focus();
      try { var range = document.createRange(); range.selectNodeContents(t); range.collapse(false); var s = window.getSelection(); s.removeAllRanges(); s.addRange(range); } catch (_) {}
      if (which !== 'title') this._openRTE(n);
      this._editing = { node: n, which: which, target: t }; this.emit('edit', n);
    },
    _openRTE: function (n) { var bar = this._rte, hostR = this._host.getBoundingClientRect(), nodeR = n._el.getBoundingClientRect(); bar.classList.add('is-open'); var top = nodeR.top - hostR.top - bar.offsetHeight - 8; if (top < 6) top = nodeR.bottom - hostR.top + 8; bar.style.left = clamp(nodeR.left - hostR.left, 6, hostR.width - bar.offsetWidth - 6) + 'px'; bar.style.top = top + 'px'; },
    endEdit: function () { var e = this._editing; if (!e) return; var n = e.node, t = e.target; t.removeAttribute('contenteditable'); n._el.classList.remove('is-editing'); if (e.which === 'title') n.title = t.textContent; else n.body = t.innerHTML; this._rte.classList.remove('is-open'); this._editing = null; this._applyNodeStyle(n); this._drawEdges(); this.emit('change'); },

    /* ---------- interaction ---------- */
    _bind: function () {
      var self = this, vp = this._viewport;

      vp.addEventListener('pointerdown', function (e) {
        var port = e.target.closest ? e.target.closest('.fb-port') : null;
        var nodeEl = e.target.closest ? e.target.closest('.fb-node') : null;

        if (self._editing && nodeEl && nodeEl === self._editing.node._el) return;
        if (self._editing) self.endEdit();

        if (port && self.options.connectable && !self.options.readOnly) {
          self._connect = { from: nodeEl.getAttribute('data-id'), side: port.getAttribute('data-side') };
          self._tempPath = svg('path', self._tempLayer); self._tempPath.setAttribute('fill', 'none');
          self._tempPath.setAttribute('stroke', 'var(--fb-accent)'); self._tempPath.setAttribute('stroke-width', '2.4'); self._tempPath.setAttribute('stroke-dasharray', '4 4');
          vp.setPointerCapture(e.pointerId); e.stopPropagation(); return;
        }

        if (nodeEl && !self.options.readOnly) {
          var nid = nodeEl.getAttribute('data-id');
          if (e.shiftKey) { if (self._sel[nid]) { self._select(nid, false); return; } self._select(nid, true); }
          else if (!self._sel[nid]) { self._clearSel(); self._select(nid, true); }
          var ids = Object.keys(self._sel), items = ids.map(function (id) { var m = self._nodeIndex[id]; return { node: m, ox: m.x, oy: m.y }; });
          var primary = null; items.forEach(function (it) { if (it.node.id === nid) primary = it; });
          self._drag = { items: items, primary: primary, sx: e.clientX, sy: e.clientY, moved: false, shift: e.shiftKey, nid: nid, tgtTitle: !!(e.target.closest && e.target.closest('.fb-node__title')) };
          nodeEl.classList.add('is-dragging'); vp.setPointerCapture(e.pointerId); e.stopPropagation(); return;
        }

        // empty canvas: shift => marquee select, else pan
        if (e.shiftKey && !self.options.readOnly) {
          var p = self._toWorld(e); self._marquee = { x0: p.x, y0: p.y, add: {} };
          if (!e.shiftKey) self._clearSel();
          self._marqueeEl.style.display = 'block'; self._updateMarquee(p.x, p.y);
          vp.setPointerCapture(e.pointerId); return;
        }
        self._clearSel();
        self._pan = { sx: e.clientX, sy: e.clientY, vx: self._view.x, vy: self._view.y };
        vp.classList.add('is-panning'); vp.setPointerCapture(e.pointerId);
      });

      vp.addEventListener('pointermove', function (e) {
        if (self._edrag) {
          var p = self._toWorld(e); self._edrag.x = p.x; self._edrag.y = p.y;
          self._hover(e); self._drawEdges(); return;
        }
        if (self._connect) {
          var a = self._nodeIndex[self._connect.from], p1 = self._anchor(a, self._connect.side), pw = self._toWorld(e);
          self._tempPath.setAttribute('d', self._pathD(p1, self._connect.side, pw)); self._hover(e); return;
        }
        if (self._marquee) { var pm = self._toWorld(e); self._updateMarquee(pm.x, pm.y); return; }
        if (self._drag) {
          var d = self._drag, s = self._view.s, snap = self.options.snap;
          var dx = (e.clientX - d.sx) / s, dy = (e.clientY - d.sy) / s;
          if (snap && d.primary) { var nx = Math.round((d.primary.ox + dx) / snap) * snap, ny = Math.round((d.primary.oy + dy) / snap) * snap; dx = nx - d.primary.ox; dy = ny - d.primary.oy; }
          d.items.forEach(function (it) { it.node.x = it.ox + dx; it.node.y = it.oy + dy; it.node._el.style.left = it.node.x + 'px'; it.node._el.style.top = it.node.y + 'px'; });
          d.moved = Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3; self._drawEdges(); return;
        }
        if (self._pan) { self._view.x = self._pan.vx + (e.clientX - self._pan.sx); self._view.y = self._pan.vy + (e.clientY - self._pan.sy); self._apply(); }
      });

      function up(e) {
        if (self._edrag) {
          var ed = self._getEdge(self._edrag.edge), tgt = self._nodeAt(e); self._clearHover();
          if (ed) { if (tgt && tgt !== self._edrag.otherNode) { ed[self._edrag.which] = tgt.getAttribute('data-id'); ed[self._edrag.which + 'XY'] = null; } else { ed[self._edrag.which] = null; ed[self._edrag.which + 'XY'] = { x: self._edrag.x, y: self._edrag.y }; } }
          self._edrag = null; self._drawEdges(); self.emit('change'); try { vp.releasePointerCapture(e.pointerId); } catch (_) {} return;
        }
        if (self._connect) {
          var t = self._nodeAt(e); self._clearHover();
          if (t && t.getAttribute('data-id') !== self._connect.from) { var edge = self.addEdge({ from: self._connect.from, to: t.getAttribute('data-id'), arrow: true }); self.emit('connect', edge); }
          else if (!t && !self.options.readOnly) { var pw = self._toWorld(e), nn = self.addNode({ x: pw.x - 20, y: pw.y - 24, width: 200, title: 'Neue Karte', body: '' }); var ed2 = self.addEdge({ from: self._connect.from, to: nn.id, arrow: true }); self.emit('connect', ed2); self._clearSel(); self._select(nn.id, true); }
          if (self._tempPath) self._tempPath.remove(); self._tempPath = null; self._connect = null; try { vp.releasePointerCapture(e.pointerId); } catch (_) {} return;
        }
        if (self._marquee) { self._commitMarquee(); self._marqueeEl.style.display = 'none'; self._marquee = null; try { vp.releasePointerCapture(e.pointerId); } catch (_) {} return; }
        if (self._drag) {
          var d = self._drag; if (d.primary) d.primary.node._el.classList.remove('is-dragging'); d.items.forEach(function (it) { it.node._el.classList.remove('is-dragging'); });
          if (d.moved) self.emit('nodemove', d.primary && d.primary.node);
          else if (!d.shift) {
            if (Object.keys(self._sel).length > 1) { self._clearSel(); self._select(d.nid, true); }
            else { self.emit('nodeclick', self._nodeIndex[d.nid]); if (self.options.clickToEdit && !self.options.readOnly) self.startEdit(d.nid, d.tgtTitle ? 'title' : 'body'); }
          }
          self._drag = null; self.emit('change');
        }
        if (self._pan) { vp.classList.remove('is-panning'); self._pan = null; }
        try { vp.releasePointerCapture(e.pointerId); } catch (_) {}
      }
      vp.addEventListener('pointerup', up); vp.addEventListener('pointercancel', up);

      vp.addEventListener('dblclick', function (e) { if (self.options.readOnly) return; var nodeEl = e.target.closest ? e.target.closest('.fb-node') : null; if (!nodeEl) return; var which = (e.target.closest && e.target.closest('.fb-node__title')) ? 'title' : 'body'; self.startEdit(nodeEl.getAttribute('data-id'), which); });
      vp.addEventListener('wheel', function (e) { e.preventDefault(); var r = vp.getBoundingClientRect(); var f = e.deltaY < 0 ? self.options.zoomStep : 1 / self.options.zoomStep; self._zoomAt(self._view.s * f, e.clientX - r.left, e.clientY - r.top); }, { passive: false });

      this._keyHandler = function (e) {
        if (self._editing) { if (e.key === 'Escape') self.endEdit(); return; }
        if (self.options.readOnly) return;
        if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) self.redo(); else self.undo(); return; }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); self.redo(); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable) return;
          var ids = Object.keys(self._sel);
          if (ids.length) { e.preventDefault(); ids.forEach(function (id) { self.removeNode(id); }); self.emit('select', []); }
          else if (self._selEdge) { e.preventDefault(); self.removeEdge(self._selEdge); self._selEdge = null; self._refreshInspector(); }
        }
      };
      document.addEventListener('keydown', this._keyHandler);
      this._resizeHandler = function () { self._drawMinimap(); };
      window.addEventListener('resize', this._resizeHandler);
    },

    _nodeAt: function (e) { var over = document.elementFromPoint(e.clientX, e.clientY); return over && over.closest ? over.closest('.fb-node') : null; },
    _hover: function (e) { var tgt = this._nodeAt(e); if (this._ctHi && (!tgt || tgt !== this._ctHi)) { this._ctHi.classList.remove('is-connect-target'); this._ctHi = null; } if (tgt) { tgt.classList.add('is-connect-target'); this._ctHi = tgt; } },
    _clearHover: function () { if (this._ctHi) { this._ctHi.classList.remove('is-connect-target'); this._ctHi = null; } },
    _updateMarquee: function (x, y) { var m = this._marquee, el2 = this._marqueeEl; var x0 = Math.min(m.x0, x), y0 = Math.min(m.y0, y), w = Math.abs(x - m.x0), h = Math.abs(y - m.y0); el2.style.left = x0 + 'px'; el2.style.top = y0 + 'px'; el2.style.width = w + 'px'; el2.style.height = h + 'px'; m.rect = { x: x0, y: y0, w: w, h: h }; },
    _commitMarquee: function () {
      var r = this._marquee.rect; if (!r) return; var self = this;
      this._nodes.forEach(function (n) { var h = n._h || 60; var hit = n.x < r.x + r.w && n.x + n.width > r.x && n.y < r.y + r.h && n.y + h > r.y; if (hit) self._select(n.id, true); });
    },

    /* ---------- selection + inspector ---------- */
    _select: function (id, on) { var n = this._nodeIndex[id]; if (!n) return; this._selEdge = null; if (on) { this._sel[id] = true; if (n._el) n._el.classList.add('is-selected'); } else { delete this._sel[id]; if (n._el) n._el.classList.remove('is-selected'); } this._drawEdges(); this._refreshInspector(); this.emit('select', Object.keys(this._sel)); },
    _selectEdge: function (id) { this._clearSelNodes(); this._selEdge = id; this._drawEdges(); this._refreshInspector(); },
    _clearSelNodes: function () { var self = this; Object.keys(this._sel).forEach(function (id) { var n = self._nodeIndex[id]; if (n && n._el) n._el.classList.remove('is-selected'); }); this._sel = {}; },
    _clearSel: function () { var had = Object.keys(this._sel).length || this._selEdge; this._clearSelNodes(); this._selEdge = null; this._drawEdges(); this._refreshInspector(); if (had) this.emit('select', []); },
    getSelection: function () { return Object.keys(this._sel); },

    _refreshInspector: function () {
      var ins = this._inspector; if (!ins) return;
      if (this.options.readOnly) { ins.classList.remove('is-open'); return; }
      var self = this, selNodes = Object.keys(this._sel);
      function row(label, ctrl) { return '<div class="fb__row"><label>' + label + '</label>' + ctrl + '</div>'; }
      function pick(k, val) { return '<span class="cp-mount" data-k="' + k + '" data-val="' + val + '"></span>'; }
      function sel(k, cur, opts) { return '<select data-k="' + k + '">' + opts.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>'; }
      var STYLES = [['solid', 'durchgezogen'], ['dashed', 'gestrichelt'], ['dotted', 'gepunktet']];

      if (this._selEdge) {
        var e = this._getEdge(this._selEdge);
        ins.innerHTML = '<h5>Verbindung</h5>' + row('Farbe', pick('color', toHex(e.color, '#2f6fd6'))) +
          row('Dicke', '<input type="range" min="1" max="8" step="0.5" data-k="width" value="' + (e.width || 2.4) + '">') +
          row('Stil', sel('style', e.style || 'solid', STYLES)) +
          row('Pfeil', '<input type="checkbox" data-k="arrow"' + (e.arrow ? ' checked' : '') + '>');
        ins.classList.add('is-open');
        wire(ins, function (k, val) { var p = {}; p[k] = val; self.updateEdge(self._selEdge, p); });
        mountPickers(ins, function (k, hex) { var p = {}; p[k] = hex; self.updateEdge(self._selEdge, p); });
        return;
      }
      if (selNodes.length >= 1) {
        var many = selNodes.length > 1, n = this._nodeIndex[selNodes[0]];
        var bgv = toHex(n.bg, themeHex(this, '--fb-surface')), bdv = toHex(n.border, themeHex(this, '--fb-border'));
        ins.innerHTML = '<h5>' + (many ? selNodes.length + ' Karten' : 'Karte') + '</h5>' +
          row('Hintergrund', pick('bg', bgv)) + row('Rahmen', pick('border', bdv)) +
          row('Rahmenbreite', '<input type="range" min="0" max="6" step="1" data-k="borderWidth" value="' + (n.borderWidth != null ? n.borderWidth : 1) + '">') +
          row('Rahmenstil', sel('borderStyle', n.borderStyle || 'solid', STYLES)) +
          '<div class="fb__hint">' + (many ? 'Änderungen gelten für alle ' + selNodes.length + ' Karten.' : 'Klick auf die Karte bearbeitet den Text.') + '</div>';
        ins.classList.add('is-open');
        function applyAll(k, val) { selNodes.forEach(function (id) { var m = self._nodeIndex[id]; m[k] = val; self._applyNodeStyle(m); }); self._drawEdges(); self.emit('change'); }
        wire(ins, applyAll); mountPickers(ins, applyAll);
        return;
      }
      ins.classList.remove('is-open');
    },

    /* ---------- theme / mode ---------- */
    setTheme: function (t) { if (t === 'auto') this._host.removeAttribute('data-theme'); else this._host.setAttribute('data-theme', t); if (this._themeBtn) this._themeBtn.innerHTML = ICON(this.getTheme() === 'dark' ? 'sun' : 'moon'); this._drawMinimap(); this.emit('theme', this.getTheme()); return this; },
    getTheme: function () { var t = this._host.getAttribute('data-theme'); return t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); },
    setReadOnly: function (v) { this.options.readOnly = !!v; this._host.classList.toggle('fb--readonly', !!v); if (v) this.endEdit(); this._renderAllNodes(); this._drawEdges(); this._refreshInspector(); this._updateControls(); return this; },
    setSnap: function (px) { this.options.snap = px || 0; if (this._snapBtn) this._snapBtn.classList.toggle('is-active', !!this.options.snap); return this; },
    toggleSnap: function () { return this.setSnap(this.options.snap ? 0 : (this.options.gridSize || 26)); },

    /* ---------- undo / redo ---------- */
    _scheduleHistory: function () { if (this._histSuspended) return; var self = this; clearTimeout(this._histTimer); this._histTimer = setTimeout(function () { self._pushHistory(); }, 250); },
    _pushHistory: function () {
      var snap = JSON.stringify({ nodes: this.toJSON().nodes, edges: this.toJSON().edges });
      if (snap === this._hist[this._histAt]) return;
      this._hist = this._hist.slice(0, this._histAt + 1); this._hist.push(snap); this._histAt = this._hist.length - 1;
      if (this._hist.length > 100) { this._hist.shift(); this._histAt--; }
      this._updateHistButtons();
    },
    _applyHistory: function (snap) { this._histSuspended = true; var data = JSON.parse(snap); this.setNodes(data.nodes); this.setEdges(data.edges); this._histSuspended = false; this._clearSel(); this._updateHistButtons(); },
    undo: function () { clearTimeout(this._histTimer); if (this._histAt <= 0) return this; this._histAt--; this._applyHistory(this._hist[this._histAt]); return this; },
    redo: function () { clearTimeout(this._histTimer); if (this._histAt >= this._hist.length - 1) return this; this._histAt++; this._applyHistory(this._hist[this._histAt]); return this; },
    _updateHistButtons: function () { if (this._undoBtn) this._undoBtn.disabled = this._histAt <= 0; if (this._redoBtn) this._redoBtn.disabled = this._histAt >= this._hist.length - 1; this._updateControls(); },

    /* ---------- serialization / events ---------- */
    toJSON: function () {
      return {
        nodes: this._nodes.map(function (n) { return { id: n.id, x: n.x, y: n.y, width: n.width, title: n.title, tag: n.tag, body: n.body, variant: n.variant, className: n.className, bg: n.bg, border: n.border, borderWidth: n.borderWidth, borderStyle: n.borderStyle, data: n.data }; }),
        edges: this._edges.map(function (e) { return { id: e.id, from: e.from, to: e.to, fromXY: e.fromXY, toXY: e.toXY, dir: e.dir, fromSide: e.fromSide, toSide: e.toSide, arrow: e.arrow, style: e.style, label: e.label, color: e.color, width: e.width }; }),
        view: { x: this._view.x, y: this._view.y, s: this._view.s }
      };
    },
    fromJSON: function (data) { data = data || {}; this.setNodes(data.nodes || []); this.setEdges(data.edges || []); if (data.view) { this._view = Object.assign({ x: 0, y: 0, s: 1 }, data.view); this._apply(); } return this; },
    on: function (ev, cb) { (this._listeners[ev] = this._listeners[ev] || []).push(cb); return this; },
    off: function (ev, cb) { if (this._listeners[ev]) this._listeners[ev] = this._listeners[ev].filter(function (f) { return f !== cb; }); return this; },
    emit: function (ev, payload) { (this._listeners[ev] || []).forEach(function (cb) { cb(payload); }); },
    destroy: function () { document.removeEventListener('keydown', this._keyHandler); window.removeEventListener('resize', this._resizeHandler); this._host.innerHTML = ''; this._host.classList.remove('fb', 'fb--nogrid', 'fb--grid-lines', 'fb--readonly', 'fb--grid-hidden'); this._host.removeAttribute('data-theme'); }
  };

  /* ---------- helpers ---------- */
  function toHex(v, fallback) { if (!v) return fallback; if (/^#[0-9a-f]{6}$/i.test(v)) return v; if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]; return fallback; }
  function themeHex(board, varName) { try { return toHex(getComputedStyle(board._host).getPropertyValue(varName).trim(), '#ffffff'); } catch (_) { return '#ffffff'; } }
  function wire(root, apply) { Array.prototype.forEach.call(root.querySelectorAll('[data-k]'), function (inp) { var ev = inp.tagName === 'SELECT' ? 'change' : 'input'; inp.addEventListener(ev, function () { var k = inp.getAttribute('data-k'); var val = inp.type === 'checkbox' ? inp.checked : (inp.type === 'range' ? parseFloat(inp.value) : inp.value); apply(k, val); }); }); }
  function mountPickers(root, apply) { Array.prototype.forEach.call(root.querySelectorAll('.cp-mount'), function (m) { var k = m.getAttribute('data-k'), val = m.getAttribute('data-val'); var cp = createColorPicker(val, function (hex) { apply(k, hex); }); m.parentNode.replaceChild(cp, m); }); }

  /* color math */
  function hexToRgb(h) { h = String(h).replace('#', ''); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; if (!/^[0-9a-f]{6}$/i.test(h)) return null; return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }; }
  function rgbToHex(c) { function h(x) { x = Math.round(clamp(x, 0, 255)).toString(16); return x.length === 1 ? '0' + x : x; } return '#' + h(c.r) + h(c.g) + h(c.b); }
  function rgbToHsv(c) { var r = c.r / 255, g = c.g / 255, b = c.b / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0; if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; } return { h: h, s: mx ? d / mx : 0, v: mx }; }
  function hsvToRgb(h, s, v) { var c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c, r = 0, g = 0, b = 0; if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; } return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }; }

  /* Tabler Icons (https://tabler.io/icons) — MIT licensed, inlined for CSP safety */
  var TABLER = {
    'zoom-in': '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 0 0 -14 0"/><path d="M21 21l-6 -6"/><path d="M7 10h6"/><path d="M10 7v6"/>',
    'zoom-out': '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 0 0 -14 0"/><path d="M7 10h6"/><path d="M21 21l-6 -6"/>',
    'maximize': '<path d="M16 4l4 0l0 4"/><path d="M14 10l6 -6"/><path d="M8 20l-4 0l0 -4"/><path d="M4 20l6 -6"/><path d="M16 20l4 0l0 -4"/><path d="M14 14l6 6"/><path d="M8 4l-4 0l0 4"/><path d="M4 4l6 6"/>',
    'grid-dots': '<path d="M5 5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M12 5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M19 5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M5 19m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M12 19m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M19 19m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/>',
    'moon': '<path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z"/>',
    'sun': '<path d="M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7"/>',
    'bold': '<path d="M7 5h6a3.5 3.5 0 0 1 0 7h-6z"/><path d="M13 12h1a3.5 3.5 0 0 1 0 7h-7v-7"/>',
    'italic': '<path d="M11 5l6 0"/><path d="M7 19l6 0"/><path d="M14 5l-4 14"/>',
    'underline': '<path d="M7 5v5a5 5 0 0 0 10 0v-5"/><path d="M5 19h14"/>',
    'list': '<path d="M9 6l11 0"/><path d="M9 12l11 0"/><path d="M9 18l11 0"/><path d="M5 6l0 .01"/><path d="M5 12l0 .01"/><path d="M5 18l0 .01"/>',
    'list-numbers': '<path d="M11 6h9"/><path d="M11 12h9"/><path d="M12 18h8"/><path d="M4 16a2 2 0 1 1 4 0c0 .591 -.5 1 -1 1.5l-3 2.5h4"/><path d="M6 10v-6l-2 2"/>',
    'heading': '<path d="M7 12h10"/><path d="M7 5v14"/><path d="M17 5v14"/><path d="M15 19h4"/><path d="M15 5h4"/><path d="M5 19h4"/><path d="M5 5h4"/>',
    'clear-formatting': '<path d="M17 15l4 4m0 -4l-4 4"/><path d="M7 6v-1h11v1"/><path d="M7 19l4 0"/><path d="M13 5l-4 14"/>',
    'arrow-back-up': '<path d="M9 13l-4 -4l4 -4"/><path d="M5 9h11a4 4 0 0 1 0 8h-1"/>',
    'arrow-forward-up': '<path d="M15 13l4 -4l-4 -4"/><path d="M19 9h-11a4 4 0 0 0 0 8h1"/>',
    'plus': '<path d="M12 5l0 14"/><path d="M5 12l14 0"/>',
    'check': '<path d="M5 12l5 5l10 -10"/>',
    'device-floppy': '<path d="M6 4h10l4 4v10a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2"/><path d="M12 14m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M14 4l0 4l-6 0l0 -4"/>',
    'pencil': '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/>',
    'eye': '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>'
  };
  function ICON(name) { return '<svg class="fb-i" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (TABLER[name] || '') + '</svg>'; }
  FlowBoard.ICON = ICON;

  function createColorPicker(initial, onChange) {
    var wrap = el('span', 'fb-cp'), sw = el('button', 'fb-cp__sw', wrap); sw.type = 'button';
    var pop = el('div', 'fb-cp__pop', wrap), sv = el('div', 'fb-cp__sv', pop), thumb = el('span', 'fb-cp__thumb', sv);
    var hue = el('input', 'fb-cp__hue', pop); hue.type = 'range'; hue.min = 0; hue.max = 360;
    var rowd = el('div', 'fb-cp__row', pop), hex = el('input', 'fb-cp__hex', rowd); hex.type = 'text'; hex.spellcheck = false;
    var pres = el('div', 'fb-cp__presets', pop);
    ['#2f6fd6', '#1a7a4a', '#9a6a12', '#c0392b', '#8e44ad', '#0e141b', '#5a6675', '#ffffff'].forEach(function (c) { var b = el('button', null, pres); b.type = 'button'; b.style.background = c; b.title = c; b.addEventListener('click', function () { setHex(c, true); }); });
    var h = 0, s = 1, v = 1;
    function render() { var hx = rgbToHex(hsvToRgb(h, s, v)); sw.style.background = hx; sv.style.background = 'linear-gradient(to top,#000,rgba(0,0,0,0)),linear-gradient(to right,#fff,hsl(' + h + ',100%,50%))'; thumb.style.left = (s * 100) + '%'; thumb.style.top = ((1 - v) * 100) + '%'; hue.value = h; if (document.activeElement !== hex) hex.value = hx; }
    function fire() { onChange(rgbToHex(hsvToRgb(h, s, v))); }
    function setHex(hx, f) { var rgb = hexToRgb(hx); if (!rgb) return; var c = rgbToHsv(rgb); h = c.h; s = c.s; v = c.v; render(); if (f) fire(); }
    setHex(toHex(initial, '#2f6fd6'), false);
    sw.addEventListener('click', function (ev) { ev.stopPropagation(); wrap.classList.toggle('is-open'); });
    document.addEventListener('pointerdown', function (ev) { if (!wrap.contains(ev.target)) wrap.classList.remove('is-open'); });
    var dragging = false;
    function svAt(ev) { var r = sv.getBoundingClientRect(); s = clamp((ev.clientX - r.left) / r.width, 0, 1); v = clamp(1 - (ev.clientY - r.top) / r.height, 0, 1); render(); fire(); }
    sv.addEventListener('pointerdown', function (ev) { dragging = true; sv.setPointerCapture(ev.pointerId); svAt(ev); ev.stopPropagation(); });
    sv.addEventListener('pointermove', function (ev) { if (dragging) svAt(ev); });
    sv.addEventListener('pointerup', function (ev) { dragging = false; try { sv.releasePointerCapture(ev.pointerId); } catch (_) {} });
    hue.addEventListener('input', function () { h = parseInt(hue.value, 10) || 0; render(); fire(); });
    hex.addEventListener('input', function () { var val = hex.value[0] === '#' ? hex.value : '#' + hex.value; if (/^#[0-9a-f]{6}$/i.test(val)) setHex(val, true); });
    render();
    return wrap;
  }

  FlowBoard._n = 0;
  if (typeof module !== 'undefined' && module.exports) module.exports = FlowBoard; else global.FlowBoard = FlowBoard;

})(typeof window !== 'undefined' ? window : this);
