/* Build step: copies source to dist/ and generates the auto-loading bundle.
 * Run: node build.js  (no dependencies) */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'src');
const dist = path.join(__dirname, 'dist');
fs.mkdirSync(dist, { recursive: true });

const css = fs.readFileSync(path.join(src, 'flowboard.css'), 'utf8');
const js = fs.readFileSync(path.join(src, 'flowboard.js'), 'utf8');

// 1) plain copies (importable individually via jsDelivr)
fs.writeFileSync(path.join(dist, 'flowboard.css'), css);
fs.writeFileSync(path.join(dist, 'flowboard.js'), js);

// 2) auto bundle: injects the stylesheet once, then defines window.FlowBoard
const auto =
`/*! FlowBoard auto-bundle — injects CSS + defines window.FlowBoard.
 * Just add this one <script> and you're ready to use FlowBoard. */
(function () {
  if (typeof document !== 'undefined' && !document.getElementById('flowboard-css')) {
    var s = document.createElement('style');
    s.id = 'flowboard-css';
    s.textContent = ${JSON.stringify(css)};
    (document.head || document.documentElement).appendChild(s);
  }
})();
${js}
`;
fs.writeFileSync(path.join(dist, 'flowboard.auto.js'), auto);

console.log('Built dist/flowboard.css, dist/flowboard.js, dist/flowboard.auto.js');
