// Adds the "Request a product" feature to the files that already exist in your project.
// Safe to run more than once. It changes only a few lines and tells you what it did.
//   From the project folder (the one that contains backend, frontend, admin):
//     node backend/scripts/apply-requests-patch.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const results = [];

function patch(file, label, test, edit) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return results.push(`SKIPPED  ${label}: ${file} not found`);
  const raw = fs.readFileSync(p, 'utf8');
  const crlf = raw.includes('\r\n');
  let s = raw.replace(/\r\n/g, '\n');
  if (test(s)) return results.push(`ok       ${label}: already done`);
  const out = edit(s);
  if (out === null || out === s) return results.push(`FAILED   ${label}: could not find the place to edit in ${file} (send me this file)`);
  fs.writeFileSync(p, crlf ? out.replace(/\n/g, '\r\n') : out);
  results.push(`DONE     ${label}`);
}

// 1. backend/server.js: mount the two new route files
patch('backend/server.js', 'backend routes',
  s => s.includes('requestRoutes'),
  s => {
    if (!s.includes("app.use('/api/admin', adminLimiter, adminRoutes);")) return null;
    s = s.replace("const adminRoutes = require('./src/routes/adminRoutes');",
      "const adminRoutes = require('./src/routes/adminRoutes');\nconst requestRoutes = require('./src/routes/requestRoutes');\nconst requestAdminRoutes = require('./src/routes/requestAdminRoutes');");
    // the more specific admin path must come BEFORE the general /api/admin line
    return s.replace("app.use('/api/admin', adminLimiter, adminRoutes);",
      "app.use('/api/admin/requests', adminLimiter, requestAdminRoutes);\napp.use('/api/requests', requestRoutes);\napp.use('/api/admin', adminLimiter, adminRoutes);");
  });

// 2. admin/index.html: Requests tab, badge and the new script (works with any set of existing tabs)
patch('admin/index.html', 'admin tab',
  s => s.includes('data-tab="requests"'),
  s => {
    const nav = s.match(/(<nav>(?:(?!<\/nav>)[\s\S])*data-tab="dash"(?:(?!<\/nav>)[\s\S])*)<\/nav>/);
    const map = s.match(/\(\{ ([^}]*?) \}\)\[t\]\(\);/);
    if (!nav || !map || !s.includes('</body>')) return null;
    s = s.replace(nav[0], nav[1] + '<button class="tab" data-tab="requests">Requests<span class="badge" id="reqBadge" hidden></span></button></nav>');
    s = s.replace(map[0], '({ ' + map[1] + ', requests })[t]();');
    return s.replace('</body>', '<script src="requests.js"></script>\n</body>');
  });

// 3. frontend/script.js: "Request" link in the shared header of Shop / Sell pages
patch('frontend/script.js', 'site header link',
  s => s.includes('request-product.html'),
  s => {
    const a = '<a href="vendor-register.html">Sell</a></nav>';
    return s.includes(a) ? s.replace(a, '<a href="vendor-register.html">Sell</a><a href="request-product.html">Request</a></nav>') : null;
  });

// 4. frontend/homepage.html: "Request" link in the top menu
patch('frontend/homepage.html', 'homepage menu link',
  s => s.includes('request-product.html'),
  s => {
    const a = '<a href="vendor-register.html">Sell</a><a href="#categories">Categories</a>';
    return s.includes(a) ? s.replace(a, '<a href="vendor-register.html">Sell</a><a href="request-product.html">Request</a><a href="#categories">Categories</a>') : null;
  });

console.log('\n' + results.join('\n') + '\n');
if (results.some(r => r.startsWith('FAILED'))) process.exitCode = 1;
