/* ============================================================
   AI Social Commerce Agent — dashboard SPA (dependency-free).
   Hash-routed, fetches the REST API, renders 8 pages.
   ============================================================ */

const NAV = [
  { id: 'dashboard', title: 'Dashboard', icon: '◧' },
  { id: 'products', title: 'Products', icon: '▤' },
  { id: 'content', title: 'Generated Content', icon: '✎' },
  { id: 'videos', title: 'Video Library', icon: '►' },
  { id: 'queue', title: 'Publishing Queue', icon: '⇅' },
  { id: 'analytics', title: 'Analytics', icon: '◔' },
  { id: 'logs', title: 'Logs', icon: '≣' },
  { id: 'settings', title: 'Settings', icon: '⚙' },
  { id: 'admin', title: 'Admin', icon: '◈' },
];

const PLATFORMS = ['instagram', 'facebook', 'linkedin', 'pinterest', 'threads', 'x'];
const SOURCES = ['manual', 'csv', 'amazon', 'shopify', 'woocommerce', 'etsy', 'flipkart', 'meesho'];

/* ---------------- Auth token ---------------- */
const TOKEN_KEY = 'asc_api_token';
function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

/* ---------------- API client ---------------- */
async function api(path, opts = {}) {
  const headers = opts.body ? { 'content-type': 'application/json' } : {};
  const token = getToken();
  if (token) headers['authorization'] = 'Bearer ' + token;
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    clearToken();
    showAuthGate('Session expired or token invalid — please sign in again.');
    throw new Error('Unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------------- helpers ---------------- */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const badge = (s) => `<span class="badge badge-${esc(s)}">${esc(s)}</span>`;
const mediaUrl = (o) => (o && o.storageKey ? '/files/' + o.storageKey : o && o.url ? o.url : '');
const ago = (iso) => {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

function toast(message, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = message;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modalBackdrop').hidden = false;
}
function closeModal() {
  $('#modalBackdrop').hidden = true;
  $('#modal').innerHTML = '';
}
$('#modalBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modalBackdrop') closeModal();
});

function stat(label, value, cls = '', sub = '') {
  return `<div class="card stat"><span class="label">${esc(label)}</span><span class="value ${cls}">${esc(value)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</div>`;
}

/* ---------------- Views ---------------- */
const views = {};

views.dashboard = async () => {
  const d = await api('/dashboard');
  const s = d.stats;
  const p = d.products;
  return `
    <div class="grid stats">
      ${stat('Products processed', s.productsProcessed)}
      ${stat('Videos created', s.videosCreated, 'accent')}
      ${stat('Posts published', s.postsPublished, 'ok')}
      ${stat('Success rate', Math.round(s.successRate * 100) + '%', 'ok')}
      ${stat('Queue size', s.queueSize, s.queueSize ? 'warn' : '')}
      ${stat('Failures', s.failedJobs, s.failedJobs ? 'warn' : '')}
    </div>
    <div class="section-title"><h2>Today's queue</h2></div>
    <div class="grid stats">
      ${stat('Waiting', p.waiting, 'warn', 'Status = NEW')}
      ${stat('Processing', p.processing, '', 'in the pipeline')}
      ${stat('Posted', p.posted, 'ok', 'completed')}
      ${stat('Failed', p.failed, p.failed ? 'warn' : '', 'need attention')}
    </div>
    <div class="section-title"><h2>System health</h2></div>
    <div class="card">
      <div class="pill-row">
        <span class="chip">Sheet: ${esc(d.health.sheet)}</span>
        <span class="chip">Storage: ${esc(d.health.storage)}</span>
        <span class="chip">AI: ${esc(d.health.ai)}</span>
        <span class="chip">${d.health.dryRun ? 'Publishing: dry-run' : 'Publishing: LIVE'}</span>
        <span class="chip">Avg processing: ${(s.avgProcessingMs / 1000).toFixed(1)}s</span>
      </div>
    </div>`;
};

views.products = async () => {
  const { products } = await api('/products');
  if (!products.length) return emptyState('No products yet', 'Click “+ Add product” or add a NEW row to your Google Sheet.');
  const rows = products
    .map(
      (r) => `<tr data-id="${esc(r.id)}" class="prow">
        <td class="mono">${esc(r.id.slice(0, 12))}</td>
        <td>${badge(r.status)}</td>
        <td>${esc(r.productSource)}</td>
        <td>${esc(r.brand || '—')}</td>
        <td>${esc(r.platform || 'all')}</td>
        <td class="wrap">${esc((r.generatedCaption || '').slice(0, 80))}</td>
        <td>${esc(ago(r.updatedTime))}</td>
      </tr>`,
    )
    .join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>ID</th><th>Status</th><th>Source</th><th>Brand</th><th>Platform</th><th>Caption</th><th>Updated</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
};

async function showProduct(id) {
  const d = await api('/products/' + id);
  const captions = (d.content?.captions || []).map((c) => `<div class="field"><label>${esc(c.platform)}</label><div class="caption-preview">${esc(c.primary)}</div></div>`).join('');
  const assets = (d.assets || []).filter((a) => a.index === undefined || a.index === null).map((a) => `<div class="media-card"><img loading="lazy" src="${esc(mediaUrl(a))}" alt="${esc(a.type)}"/><div class="cap"><span>${esc(a.type)}</span><span>${a.width}×${a.height}</span></div></div>`).join('');
  const video = d.video ? `<div class="media-card"><video controls src="${esc(mediaUrl(d.video))}"></video><div class="cap"><span>promo</span><span>${d.video.durationSec}s</span></div></div>` : '';
  const hashtags = (d.content?.hashtags || []).map((h) => `<span class="chip">${esc(h)}</span>`).join('');
  const pubs = (d.publications || []).map((p) => `<tr><td>${esc(p.platform)}</td><td>${badge(p.status)}</td><td>${esc(p.permalink || p.scheduledAt || '—')}</td></tr>`).join('');
  openModal(`
    <h2>${esc(d.product.title || d.product.id)}</h2>
    <div class="muted">${badge(d.product.status)} · ${esc(d.product.productSource)} · ${esc(d.product.brand || '')}</div>
    ${video ? `<div class="section-title"><h2>Promo video</h2></div><div class="media-grid">${video}</div>` : ''}
    ${assets ? `<div class="section-title"><h2>Creative assets</h2></div><div class="media-grid">${assets}</div>` : ''}
    ${captions ? `<div class="section-title"><h2>Captions</h2></div><div class="form">${captions}</div>` : ''}
    ${hashtags ? `<div class="section-title"><h2>Hashtags</h2></div><div class="chips">${hashtags}</div>` : ''}
    ${pubs ? `<div class="section-title"><h2>Publications</h2></div><div class="table-wrap"><table><thead><tr><th>Platform</th><th>Status</th><th>Link / schedule</th></tr></thead><tbody>${pubs}</tbody></table></div>` : ''}
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Close</button>
      <button class="btn btn-accent" onclick="retryProduct('${esc(d.product.id)}')">Re-queue (set NEW)</button>
    </div>`);
}

views.content = async () => {
  const { content } = await api('/content?limit=100');
  if (!content.length) return emptyState('No generated content yet', 'Process a product to generate captions, hooks and hashtags.');
  const rows = content
    .map(
      (c) => `<tr><td class="mono">${esc(c.productId.slice(0, 12))}</td><td>${esc(c.tone)}</td><td>${esc(c.provider)}</td>
      <td>${c.captions.length} captions</td><td>${c.hooks.length} hooks</td><td>${c.hashtags.length} tags</td><td>${esc(ago(c.createdAt))}</td></tr>`,
    )
    .join('');
  return `<div class="table-wrap"><table><thead><tr><th>Product</th><th>Tone</th><th>Provider</th><th>Captions</th><th>Hooks</th><th>Hashtags</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table></div>`;
};

views.videos = async () => {
  const { videos } = await api('/videos');
  if (!videos.length) return emptyState('No videos yet', 'Videos are rendered automatically for each processed product.');
  const cards = videos.map((v) => `<div class="media-card"><video controls preload="metadata" src="${esc(mediaUrl(v))}"></video><div class="cap"><span>${esc(v.productId.slice(0, 10))}</span><span>${v.durationSec}s · ${Math.round(v.bytes / 1024)}KB</span></div></div>`).join('');
  return `<div class="media-grid">${cards}</div>`;
};

views.queue = async () => {
  const { counts, jobs } = await api('/queue');
  const tiles = `<div class="grid stats">
    ${stat('Queued', counts.QUEUED || 0, 'warn')}
    ${stat('Running', counts.RUNNING || 0)}
    ${stat('Succeeded', counts.SUCCEEDED || 0, 'ok')}
    ${stat('Failed', counts.FAILED || 0)}
    ${stat('Dead', counts.DEAD || 0, (counts.DEAD || 0) ? 'warn' : '')}
  </div>`;
  const rows = jobs.map((j) => `<tr><td class="mono">${esc(j.id.slice(0, 14))}</td><td>${esc(j.type)}</td><td>${badge(j.status === 'QUEUED' ? 'NEW' : j.status === 'SUCCEEDED' ? 'POSTED' : j.status === 'RUNNING' ? 'PROCESSING' : 'FAILED')}</td><td>${j.attempts}/${j.maxAttempts}</td><td class="wrap">${esc((j.lastError || '').slice(0, 70))}</td><td>${esc(ago(j.updatedAt))}</td></tr>`).join('');
  return tiles + (jobs.length ? `<div class="section-title"><h2>Recent jobs</h2></div><div class="table-wrap"><table><thead><tr><th>Job</th><th>Type</th><th>Status</th><th>Attempts</th><th>Last error</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('Queue is empty', 'New products are claimed and enqueued every few minutes.'));
};

views.analytics = async () => {
  const s = await api('/analytics');
  const pubRows = Object.entries(s.publications || {}).map(([k, v]) => `<span class="chip">${esc(k)}: ${v}</span>`).join('') || '<span class="chip">none</span>';
  return `<div class="grid stats">
      ${stat('Products processed', s.productsProcessed)}
      ${stat('Posts published', s.postsPublished, 'ok')}
      ${stat('Videos created', s.videosCreated, 'accent')}
      ${stat('Avg processing', (s.avgProcessingMs / 1000).toFixed(1) + 's')}
    </div>
    <div class="section-title"><h2>Success rate</h2></div>
    <div class="card"><div class="kpi-bar"><span style="width:${Math.round(s.successRate * 100)}%"></span></div>
      <p class="sub" style="margin-top:10px;color:var(--muted)">${Math.round(s.successRate * 100)}% of finished pipelines succeeded · ${s.failedJobs} failed</p></div>
    <div class="section-title"><h2>Publications</h2></div>
    <div class="card"><div class="pill-row">${pubRows}</div></div>`;
};

views.logs = async () => {
  const { logs } = await api('/logs?limit=200');
  if (!logs.length) return emptyState('No activity yet', 'Pipeline stages are logged here as products are processed.');
  const rows = logs.map((l) => `<tr><td>${esc(ago(l.ts))}</td><td>${badge(l.level === 'error' ? 'FAILED' : l.level === 'warn' ? 'PROCESSING' : 'POSTED')}</td><td>${esc(l.stage)}</td><td class="wrap">${esc(l.message)}</td></tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr><th>When</th><th>Level</th><th>Stage</th><th>Message</th></tr></thead><tbody>${rows}</tbody></table></div>`;
};

views.settings = async () => {
  const s = await api('/settings');
  const b = s.brand || {};
  const sources = s.sources.map((x) => `<span class="chip">${esc(x.type)} ${x.configured ? '✓' : '·'}</span>`).join('');
  const pubs = s.publishers.map((x) => `<span class="chip">${esc(x.platform)} ${x.configured ? '✓' : '·'}</span>`).join('');
  setTimeout(() => {
    const f = $('#brandForm');
    if (f) f.addEventListener('submit', saveBrand);
    const pt = $('#postingForm');
    if (pt) pt.addEventListener('submit', savePosting);
  }, 0);
  return `
    <div class="section-title"><h2>Brand</h2></div>
    <div class="card"><form class="form" id="brandForm">
      <div class="row2">
        <div class="field"><label>Brand name</label><input name="name" value="${esc(b.name || '')}" required /></div>
        <div class="field"><label>Font</label><input name="font" value="${esc(b.font || 'Poppins')}" /></div>
      </div>
      <div class="row2">
        <div class="field"><label>Primary color</label><input name="primaryColor" value="${esc(b.primaryColor || '#0F2027')}" /></div>
        <div class="field"><label>Accent color</label><input name="accentColor" value="${esc(b.accentColor || '#E63946')}" /></div>
      </div>
      <div class="row2">
        <div class="field"><label>Watermark</label><input name="watermarkText" value="${esc(b.watermarkText || '')}" /></div>
        <div class="field"><label>Default CTA</label><input name="cta" value="${esc(b.cta || 'Shop now')}" /></div>
      </div>
      <div class="modal-actions"><button class="btn btn-accent" type="submit">Save brand</button></div>
    </form></div>

    <div class="section-title"><h2>Posting schedule</h2></div>
    <div class="card"><form class="form" id="postingForm">
      <div class="field"><label>Posting times (comma-separated HH:mm, ${esc(s.timezone)})</label><input name="times" value="${esc((s.postingTimes || []).join(', '))}" /></div>
      <div class="modal-actions"><button class="btn btn-accent" type="submit">Save times</button></div>
    </form></div>

    <div class="section-title"><h2>Integrations</h2></div>
    <div class="card">
      <p class="sub" style="color:var(--muted);margin:0 0 8px">Publishing mode: <strong>${s.dryRun ? 'DRY-RUN (recorded, not sent)' : 'LIVE'}</strong> · AI provider: <strong>${esc(s.aiProvider)}</strong></p>
      <p class="sub" style="color:var(--muted);margin:14px 0 6px">Product sources</p><div class="pill-row">${sources}</div>
      <p class="sub" style="color:var(--muted);margin:14px 0 6px">Publishers</p><div class="pill-row">${pubs}</div>
      <p class="sub" style="color:var(--muted);margin:14px 0 0">Credentials are configured via environment variables / encrypted account storage. ✓ = configured.</p>
    </div>`;
};

/* ---- Admin helpers ---- */
function fmtUptime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec % 60}s`;
  return `${sec}s`;
}
function dot(ok) {
  return `<span class="check-dot ${ok ? 'ok' : 'fail'}"></span>`;
}

views.admin = async () => {
  const [system, health, backupsRes, update] = await Promise.all([
    api('/system'),
    api('/health'),
    api('/admin/backups'),
    api('/admin/update/check'),
  ]);
  const c = system.config;

  const checkPills = (health.checks || [])
    .map((chk) => `<span class="chip check-pill">${dot(chk.ok)}${esc(chk.name)}${chk.critical ? '<span class="crit-tag">critical</span>' : ''}${chk.detail ? `<span class="check-detail">${esc(chk.detail)}</span>` : ''}</span>`)
    .join('');

  const runtimeChips = [
    `Node ${system.node}`,
    `${system.platform}/${system.arch}`,
    `Sheet: ${c.sheet}`,
    `Storage: ${c.storage}`,
    `AI: ${c.aiProvider}`,
    c.dryRun ? 'Publishing: dry-run' : 'Publishing: LIVE',
    `Poll: ${c.pollIntervalMinutes}m`,
    `Concurrency: ${c.concurrency}`,
  ]
    .map((t) => `<span class="chip">${esc(t)}</span>`)
    .join('');

  const backups = backupsRes.backups || [];
  const backupRows = backups
    .map(
      (b) => `<tr>
        <td class="mono">${esc(b.name)}</td>
        <td>${Math.round(b.bytes / 1024)} KB</td>
        <td>${esc(ago(b.createdAt))}</td>
        <td><a class="btn btn-sm" href="/api/admin/backups/${encodeURIComponent(b.name)}/download">Download</a></td>
      </tr>`,
    )
    .join('');
  const backupsTable = backups.length
    ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Size</th><th>Created</th><th></th></tr></thead><tbody>${backupRows}</tbody></table></div>`
    : emptyState('No backups yet', 'Click “Create backup” to snapshot the database and generated assets.');

  const updateBody = update.error
    ? `<p class="sub" style="color:var(--muted);margin:0">Current version <strong>${esc(update.current)}</strong> · check failed: ${esc(update.error)}</p>`
    : update.latest
      ? `<p class="sub" style="color:var(--muted);margin:0">Current <strong>${esc(update.current)}</strong> · Latest <strong>${esc(update.latest)}</strong> · <span class="badge badge-${update.updateAvailable ? 'FAILED' : 'POSTED'}">${update.updateAvailable ? 'Update available' : 'Up to date'}</span>${update.notes ? `<br/>${esc(update.notes)}` : ''}</p>`
      : `<p class="sub" style="color:var(--muted);margin:0">Current version <strong>${esc(update.current)}</strong> (${esc(update.mode)}) · ${esc(update.message || '')}</p>`;

  setTimeout(() => {
    const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    bind('#createBackupBtn', createBackup);
    bind('#pruneBackupsBtn', pruneBackups);
    bind('#requeueStaleBtn', requeueStale);
    bind('#adminRunNowBtn', runNow);
    bind('#openSetupWizardBtn', () => openSetupWizard(true));
  }, 0);

  return `
    <div class="section-title"><h2>System health</h2><span class="badge badge-${health.status === 'ok' ? 'POSTED' : 'FAILED'}">${esc(health.status)}</span></div>
    <div class="card"><div class="pill-row">${checkPills}</div></div>

    <div class="section-title"><h2>System info</h2></div>
    <div class="grid stats">
      ${stat('Version', system.version)}
      ${stat('Uptime', fmtUptime(system.uptimeSec))}
      ${stat('Memory (RSS)', system.memory.rssMb + ' MB')}
      ${stat('Disk free', system.data.freeMb != null ? system.data.freeMb + ' MB' : '—')}
    </div>

    <div class="section-title"><h2>Runtime configuration</h2></div>
    <div class="card"><div class="pill-row">${runtimeChips}</div></div>

    <div class="section-title"><h2>Monitoring</h2></div>
    <div class="card">
      <p class="sub" style="color:var(--muted);margin:0 0 10px">Prometheus metrics are exposed at <span class="mono">/api/metrics</span> for scraping.</p>
      <a class="btn" href="/api/metrics" target="_blank" rel="noopener noreferrer">↗ Open /api/metrics</a>
    </div>

    <div class="section-title"><h2>Backups</h2>
      <div class="topbar-actions">
        <button class="btn" id="pruneBackupsBtn">Prune old</button>
        <button class="btn btn-accent" id="createBackupBtn">Create backup</button>
      </div>
    </div>
    <div class="card">${backupsTable}</div>

    <div class="section-title"><h2>Updates</h2></div>
    <div class="card">${updateBody}</div>

    <div class="section-title"><h2>Worker controls</h2></div>
    <div class="card">
      <div class="pill-row">
        <button class="btn btn-primary" id="adminRunNowBtn">▶ Run now</button>
        <button class="btn" id="requeueStaleBtn">⟲ Requeue stale jobs</button>
      </div>
    </div>

    <div class="section-title"><h2>Setup wizard</h2></div>
    <div class="card">
      <p class="sub" style="color:var(--muted);margin:0 0 10px">Re-run the first-run setup checklist and connection tests at any time.</p>
      <button class="btn" id="openSetupWizardBtn">Run setup wizard</button>
    </div>`;
};

function emptyState(title, hint) {
  return `<div class="card empty"><strong>${esc(title)}</strong><div class="empty-hint">${esc(hint)}</div></div>`;
}

/* ---------------- Actions ---------------- */
async function saveBrand(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/settings/brand', { method: 'PUT', body: Object.fromEntries(f) });
    toast('Brand saved', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}
async function savePosting(e) {
  e.preventDefault();
  const times = new FormData(e.target).get('times').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    await api('/settings/posting-times', { method: 'PUT', body: { times } });
    toast('Posting times saved', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}
window.retryProduct = async (id) => {
  try {
    await api('/products/' + id + '/retry', { method: 'POST' });
    toast('Product re-queued (Status = NEW)', 'ok');
    closeModal();
    route();
  } catch (err) {
    toast(err.message, 'err');
  }
};
window.closeModal = closeModal;

function addProductModal() {
  const platformChecks = PLATFORMS.map((p) => `<label><input type="checkbox" name="platform" value="${p}" checked/> ${p}</label>`).join('');
  const sourceOpts = SOURCES.map((s) => `<option value="${s}">${s}</option>`).join('');
  openModal(`
    <h2>Add product</h2>
    <div class="muted">Manual products render immediately. Other sources import via their API when credentials are set.</div>
    <form class="form" id="addForm">
      <div class="row2">
        <div class="field"><label>Source</label><select name="source">${sourceOpts}</select></div>
        <div class="field"><label>Brand</label><input name="brand" placeholder="Acme Audio"/></div>
      </div>
      <div class="row2">
        <div class="field"><label>Product URL (or leave blank)</label><input name="url" placeholder="https://…"/></div>
        <div class="field"><label>Product ID / ASIN / SKU</label><input name="productId" placeholder="optional"/></div>
      </div>
      <div class="field"><label>Platforms</label><div class="checks">${platformChecks}</div></div>
      <fieldset style="border:1px solid var(--border);border-radius:12px;padding:14px">
        <legend style="color:var(--muted);font-size:12px">Manual product details</legend>
        <div class="field"><label>Title</label><input name="title" placeholder="Aurora Wireless Headphones"/></div>
        <div class="field"><label>Description</label><textarea name="description"></textarea></div>
        <div class="field"><label>Features (one per line)</label><textarea name="features"></textarea></div>
        <div class="row2">
          <div class="field"><label>Price</label><input name="price" type="number" step="0.01" placeholder="149.99"/></div>
          <div class="field"><label>Currency</label><input name="currency" value="USD"/></div>
        </div>
        <div class="field"><label>Image URLs (one per line)</label><textarea name="imageUrls" placeholder="https://…"></textarea></div>
        <div class="field"><label>Category</label><input name="category" placeholder="Premium Audio"/></div>
      </fieldset>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-accent">Add product</button>
      </div>
    </form>`);
  $('#addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const platforms = f.getAll('platform');
    const body = {
      source: f.get('source'),
      brand: f.get('brand'),
      url: f.get('url'),
      productId: f.get('productId'),
      platforms,
      category: f.get('category'),
      title: f.get('title'),
      description: f.get('description'),
      features: (f.get('features') || '').split('\n').map((s) => s.trim()).filter(Boolean),
      price: f.get('price') ? Number(f.get('price')) : undefined,
      currency: f.get('currency'),
      imageUrls: (f.get('imageUrls') || '').split('\n').map((s) => s.trim()).filter(Boolean),
    };
    try {
      await api('/products', { method: 'POST', body });
      toast('Product added (Status = NEW)', 'ok');
      closeModal();
      location.hash = '#products';
      route();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

async function runNow() {
  const btn = $('#runNow');
  btn.disabled = true;
  btn.textContent = '⏳ Running…';
  try {
    const r = await api('/actions/run', { method: 'POST' });
    toast(r.message, 'ok');
    setTimeout(route, 1500);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '▶ Run now';
    }, 1500);
  }
}

async function createBackup() {
  const btn = $('#createBackupBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating…'; }
  try {
    const r = await api('/admin/backups', { method: 'POST' });
    toast(`Backup created: ${r.name} (${Math.round(r.bytes / 1024)} KB)`, 'ok');
    route();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Create backup'; }
  }
}
async function pruneBackups() {
  try {
    const r = await api('/admin/backups/prune', { method: 'POST', body: { keep: 10 } });
    toast(`Pruned ${r.removed} old backup${r.removed === 1 ? '' : 's'}`, 'ok');
    route();
  } catch (err) {
    toast(err.message, 'err');
  }
}
async function requeueStale() {
  try {
    const r = await api('/admin/requeue-stale', { method: 'POST' });
    toast(`Requeued ${r.requeued} stale job${r.requeued === 1 ? '' : 's'}`, 'ok');
    route();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ---------------- Setup wizard ---------------- */
function wizardStepsHtml(steps) {
  return (steps || [])
    .map(
      (s) => `<div class="wizard-step ${s.done ? 'done' : ''}">
        <span class="check-dot ${s.done ? 'ok' : 'fail'}"></span>
        <div class="wizard-step-body">
          <strong>${esc(s.label)}</strong>
          ${s.detail ? `<span class="sub">${esc(s.detail)}</span>` : ''}
        </div>
      </div>`,
    )
    .join('');
}

function testResultHtml(r) {
  if (!r) return '';
  return `<div class="test-result ${r.ok ? 'ok' : 'fail'}">${dot(r.ok)}${esc(r.detail || (r.ok ? 'OK' : 'failed'))}</div>`;
}

async function renderSetupWizard() {
  const status = await api('/setup/status');
  const platformOpts = PLATFORMS.map((p) => `<option value="${p}">${p}</option>`).join('');
  openModal(`
    <h2>Setup wizard</h2>
    <div class="muted">Finish configuring your AI marketing employee. You can re-run this any time from Admin.</div>

    <div class="section-title"><h2>Checklist</h2></div>
    <div class="wizard-steps" id="wizardSteps">${wizardStepsHtml(status.steps)}</div>

    <div class="section-title"><h2>Test connections</h2></div>
    <div class="card">
      <div class="pill-row" style="margin-bottom:10px">
        <button type="button" class="btn btn-sm" id="testSheetBtn">Test sheet</button>
        <button type="button" class="btn btn-sm" id="testAiBtn">Test AI provider</button>
      </div>
      <div id="testSheetResult"></div>
      <div id="testAiResult"></div>
      <div class="row2" style="margin-top:14px;align-items:end">
        <div class="field"><label>Publisher platform</label><select id="testPublisherPlatform">${platformOpts}</select></div>
        <button type="button" class="btn btn-sm" id="testPublisherBtn">Test publisher</button>
      </div>
      <div id="testPublisherResult"></div>
    </div>

    <div class="section-title"><h2>Brand quick-config</h2></div>
    <div class="card"><form class="form" id="wizardBrandForm">
      <div class="row2">
        <div class="field"><label>Brand name</label><input name="name" placeholder="Acme Audio" required /></div>
        <div class="field"><label>Default CTA</label><input name="cta" value="Shop now" /></div>
      </div>
      <div class="row2">
        <div class="field"><label>Primary color</label><input name="primaryColor" value="#0F2027" /></div>
        <div class="field"><label>Accent color</label><input name="accentColor" value="#E63946" /></div>
      </div>
      <div class="modal-actions"><button class="btn btn-accent" type="submit">Save brand</button></div>
    </form></div>

    <div class="modal-actions">
      <button class="btn" id="wizardLaterBtn">Remind me later</button>
      <button class="btn btn-accent" id="wizardFinishBtn">Finish</button>
    </div>`);

  const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };

  bind('#testSheetBtn', async () => {
    $('#testSheetResult').innerHTML = '<div class="test-result">Testing…</div>';
    try {
      const r = await api('/setup/test', { method: 'POST', body: { target: 'sheet' } });
      $('#testSheetResult').innerHTML = testResultHtml(r);
    } catch (err) {
      $('#testSheetResult').innerHTML = testResultHtml({ ok: false, detail: err.message });
    }
  });
  bind('#testAiBtn', async () => {
    $('#testAiResult').innerHTML = '<div class="test-result">Testing…</div>';
    try {
      const r = await api('/setup/test', { method: 'POST', body: { target: 'ai' } });
      $('#testAiResult').innerHTML = testResultHtml(r);
    } catch (err) {
      $('#testAiResult').innerHTML = testResultHtml({ ok: false, detail: err.message });
    }
  });
  bind('#testPublisherBtn', async () => {
    const platform = $('#testPublisherPlatform').value;
    $('#testPublisherResult').innerHTML = '<div class="test-result">Testing…</div>';
    try {
      const r = await api('/setup/test', { method: 'POST', body: { target: 'publisher', platform } });
      $('#testPublisherResult').innerHTML = testResultHtml(r);
    } catch (err) {
      $('#testPublisherResult').innerHTML = testResultHtml({ ok: false, detail: err.message });
    }
  });

  const bf = $('#wizardBrandForm');
  if (bf) {
    bf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('/settings/brand', { method: 'PUT', body: Object.fromEntries(f) });
        toast('Brand saved', 'ok');
        const refreshed = await api('/setup/status');
        const stepsEl = $('#wizardSteps');
        if (stepsEl) stepsEl.innerHTML = wizardStepsHtml(refreshed.steps);
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  bind('#wizardFinishBtn', async () => {
    try {
      await api('/setup/complete', { method: 'POST' });
      toast('Setup complete', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      closeModal();
    }
  });
  bind('#wizardLaterBtn', async () => {
    try {
      await api('/setup/dismiss', { method: 'POST' });
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      closeModal();
    }
  });
}

async function openSetupWizard(force = false) {
  try {
    if (!force) {
      const status = await api('/setup/status');
      if (status.complete || status.dismissed) return;
    }
    await renderSetupWizard();
  } catch {
    /* setup status unavailable — skip silently on auto-check */
  }
}
window.openSetupWizard = openSetupWizard;

/* ---------------- Router + chrome ---------------- */
function currentPage() {
  return (location.hash.replace('#', '') || 'dashboard').split('?')[0];
}
async function route() {
  const page = currentPage();
  const nav = NAV.find((n) => n.id === page) || NAV[0];
  $('#pageTitle').textContent = nav.title;
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === nav.id));
  $('#view').innerHTML = '<div class="loading">Loading…</div>';
  try {
    $('#view').innerHTML = await (views[nav.id] || views.dashboard)();
    document.querySelectorAll('.prow').forEach((r) => r.addEventListener('click', () => showProduct(r.dataset.id)));
  } catch (err) {
    $('#view').innerHTML = emptyState('Could not load', err.message);
  }
}

function buildNav() {
  $('#nav').innerHTML = NAV.map((n) => `<a href="#${n.id}" data-page="${n.id}"><span class="ic">${n.icon}</span>${n.title}</a>`).join('');
}

async function buildHealthPill() {
  try {
    const s = await api('/system');
    $('#healthPill').innerHTML = `<span class="dot">● v${esc(s.version)}</span><span class="dot">${s.config.dryRun ? 'dry-run' : 'live'}</span><span class="dot">${esc(s.config.sheet)}/${esc(s.config.storage)}</span>`;
  } catch {
    $('#healthPill').textContent = 'offline';
  }
}

function initTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  });
}

/* ---------------- Auth gate + bootstrap ---------------- */
function showAuthGate(message) {
  const gate = $('#authGate');
  if (!gate) return;
  gate.hidden = false;
  const err = $('#authError');
  if (err) {
    if (message) { err.textContent = message; err.hidden = false; } else { err.hidden = true; }
  }
  const input = $('#authTokenInput');
  if (input) { input.value = ''; setTimeout(() => input.focus(), 50); }
}
function hideAuthGate() {
  const gate = $('#authGate');
  if (gate) gate.hidden = true;
}
async function verifyToken(token) {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
function logout() {
  clearToken();
  location.reload();
}
window.logout = logout;

let appStarted = false;
function startApp() {
  if (appStarted) return;
  appStarted = true;
  buildNav();
  buildHealthPill();
  $('#runNow').addEventListener('click', runNow);
  $('#addProduct').addEventListener('click', addProductModal);
  $('#hamburger').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  window.addEventListener('hashchange', () => {
    route();
    $('#sidebar').classList.remove('open');
  });
  if (!location.hash) location.hash = '#dashboard';
  route();
  openSetupWizard();
}

async function bootstrap() {
  initTheme();
  const form = $('#authForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = ($('#authTokenInput').value || '').trim();
      const btn = form.querySelector('button');
      if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
      const ok = token ? await verifyToken(token) : false;
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
      if (ok) { setToken(token); hideAuthGate(); startApp(); }
      else { showAuthGate('Invalid token. Check API_TOKENS on the server and try again.'); }
    });
  }

  let status = { authEnabled: false };
  try { status = await fetch('/api/auth/status').then((r) => r.json()); } catch { /* treat as open */ }

  if (!status.authEnabled) { startApp(); return; }
  const token = getToken();
  if (token && (await verifyToken(token))) startApp();
  else showAuthGate();
}

bootstrap();
