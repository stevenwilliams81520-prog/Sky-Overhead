// Turns the Apps Script page (src/Index.html + src/StarData.html) into the app's
// www folder: the star data is pulled in, the libraries are bundled so the app
// doesn't depend on CDNs, and google.script.run is swapped for local-server.js,
// which runs the data functions on the phone itself. Run with: node build-www.js
const fs = require('fs'), path = require('path');
const src = f => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
const out = path.join(__dirname, 'www');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'lib'), { recursive: true });

const libs = {
  'satellite.min.js': 'node_modules/satellite.js/dist/satellite.min.js',
  'astronomy.browser.min.js': 'node_modules/astronomy-engine/astronomy.browser.min.js',
  'leaflet.js': 'node_modules/leaflet/dist/leaflet.js',
  'leaflet.css': 'node_modules/leaflet/dist/leaflet.css'
};
for (const [name, from] of Object.entries(libs)) fs.copyFileSync(path.join(__dirname, from), path.join(out, 'lib', name));
fs.cpSync(path.join(__dirname, 'node_modules/leaflet/dist/images'), path.join(out, 'lib', 'images'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'src', 'local-server.js'), path.join(out, 'local-server.js'));

let html = src('Index.html');
const swap = (re, to) => { if (!re.test(html)) throw new Error('Could not find ' + re); html = html.replace(re, to); };
swap(/<script src="[^"]*satellite\.js[^"]*"><\/script>/, '<script src="lib/satellite.min.js"></script>');
swap(/<script src="[^"]*astronomy-engine[^"]*"><\/script>/, '<script src="lib/astronomy.browser.min.js"></script>');
swap(/<link rel="stylesheet" href="[^"]*leaflet[^"]*\.css">/, '<link rel="stylesheet" href="lib/leaflet.css">');
swap(/<script src="[^"]*leaflet[^"]*\.js"><\/script>/, '<script src="lib/leaflet.js"></script>');
swap(/<\?!= include\('StarData'\); \?>/, src('StarData.html'));

// Apps Script adds this for the web version; the app needs it in the page itself,
// otherwise iPhone shows the page at desktop width (really zoomed out)
const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
                 '<meta name="theme-color" content="#0C1726">\n';
const shim = viewport + '<script src="local-server.js"></script>';
swap(/<base target="_top">/, shim);
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log('www built:', Math.round(html.length / 1024) + ' KB index.html');
