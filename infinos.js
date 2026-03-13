// ───────────────────────────────────────────────
// STATE
// ───────────────────────────────────────────────
let bags = JSON.parse(localStorage.getItem('infinos_bags') || '[]');
let activeBagId = null;
let chartInstances = {};
let liveInterval = null;
let modalStep = 1;

const CHANNEL_ID = '3297681';
const API_KEY = 'C8DUVRKN6XZTK1A2';

// ───────────────────────────────────────────────
// THINGSPEAK FETCH
// ───────────────────────────────────────────────
async function fetchThingSpeak(count = 20) {
  const url = `https://api.thingspeak.com/channels/${CHANNEL_ID}/feeds.json?api_key=${API_KEY}&results=${count}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('ThingSpeak unreachable');
  return res.json();
}

function parseFeeds(feeds) {
  return feeds.map(f => ({
    timestamp:   new Date(f.created_at),
    hotTemp:     parseFloat(f.field3) ?? null,  // field3 = Hot Zone Temp (°C)
    coldTemp:    parseFloat(f.field1) ?? null,  // field1 = Cold Zone Temp (°C)
    humidity:    parseFloat(f.field4) ?? null,  // field4 = Humidity (%)
  }));
}

// ───────────────────────────────────────────────
// BAGS CRUD
// ───────────────────────────────────────────────
function saveBags() {
  localStorage.setItem('infinos_bags', JSON.stringify(bags));
}

function deleteBag(e, bagId) {
  e.stopPropagation(); // don't trigger selectBag
  const bag = bags.find(b => b.id === bagId);
  if (!bag) return;
  if (!confirm(`Remove "${bag.name}" from your dashboard?`)) return;

  bags = bags.filter(b => b.id !== bagId);
  saveBags();

  // If deleted bag was active, clear monitor
  if (activeBagId === bagId) {
    activeBagId = null;
    if (liveInterval) { clearInterval(liveInterval); liveInterval = null; }
    document.getElementById('monitorContent').innerHTML = `
      <div class="empty-monitor">
        <div class="empty-icon">📡</div>
        <div class="empty-title">Select a bag to monitor</div>
        <div class="empty-desc">Tap any bag card above to view real-time temperature readings and history charts.</div>
      </div>`;
  }

  renderDevices();
}

function getLatestReading(bag) {
  if (!bag.history || !bag.history.length) return null;
  return bag.history[bag.history.length - 1];
}

// ───────────────────────────────────────────────
// RENDER DEVICES GRID
// ───────────────────────────────────────────────
function renderDevices() {
  const grid = document.getElementById('devicesGrid');
  updateStats();

  if (!bags.length) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:48px 20px;color:var(--muted)">
        <div style="font-size:38px;margin-bottom:12px;opacity:.22">📦</div>
        <div style="font-family:'Syne',sans-serif;font-size:0.9rem;font-weight:700;margin-bottom:5px">No bags claimed yet</div>
        <div style="font-size:0.75rem">Tap <strong style="color:var(--orange)">+ Claim Bag</strong> to add your first delivery bag</div>
      </div>`;
    return;
  }

  grid.innerHTML = bags.map(bag => {
    const r = getLatestReading(bag);
    const isActive = bag.id === activeBagId;

    return `<div class="device-card ${isActive ? 'active' : ''}"
        onclick="selectBag('${bag.id}')">
      <div class="dcard-top">
        <div class="dcard-icon">🌡️</div>
        <div class="dcard-status online">LIVE</div>
      </div>
      <div class="dcard-name">${bag.name}</div>
      <div class="dcard-code">${bag.code}</div>
      <div class="dcard-readings">
        <div class="dread">
          <div class="dread-label">🔥 Hot</div>
          <div class="dread-val" style="color:var(--hot)">${r && r.hotTemp != null ? r.hotTemp.toFixed(1) : '—'}°C</div>
        </div>
        <div class="dread">
          <div class="dread-label">❄️ Cold</div>
          <div class="dread-val" style="color:var(--cold)">${r && r.coldTemp != null ? r.coldTemp.toFixed(1) : '—'}°C</div>
        </div>
      </div>
      <div class="dcard-actions">
        <button class="btn-delete" onclick="deleteBag(event, '${bag.id}')">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
          Delete
        </button>
      </div>
    </div>`;
  }).join('');
}

function updateStats() {
  const total = bags.length;
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statOnline').textContent = total;

  if (total > 0) {
    const hotVals  = bags.map(b => { const r = getLatestReading(b); return r && r.hotTemp  != null ? r.hotTemp  : null; }).filter(v => v !== null);
    const coldVals = bags.map(b => { const r = getLatestReading(b); return r && r.coldTemp != null ? r.coldTemp : null; }).filter(v => v !== null);
    document.getElementById('statHot').textContent  = hotVals.length  ? (hotVals.reduce((a,b)=>a+b)  / hotVals.length).toFixed(1)  : '—';
    document.getElementById('statCold').textContent = coldVals.length ? (coldVals.reduce((a,b)=>a+b) / coldVals.length).toFixed(1) : '—';
  }
}

// ───────────────────────────────────────────────
// SELECT BAG & RENDER MONITOR
// ───────────────────────────────────────────────
function selectBag(id) {
  activeBagId = id;
  const bag = bags.find(b => b.id === id);
  if (!bag) return;

  renderDevices();
  renderMonitor(bag);
  // smooth scroll to monitor on mobile
  if (window.innerWidth <= 640) {
    setTimeout(() => {
      document.querySelector('.monitor-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
  }

  if (liveInterval) clearInterval(liveInterval);
  liveInterval = setInterval(() => updateBagData(id), 15000);
}

function renderMonitor(bag) {
  const r = getLatestReading(bag);
  const history = bag.history || [];

  const labels   = history.map(h => {
    const d = h.timestamp instanceof Date ? h.timestamp : new Date(h.timestamp);
    return d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
  });
  const hotData  = history.map(h => h.hotTemp  ?? null);
  const coldData = history.map(h => h.coldTemp ?? null);
  const now = new Date();

  const hotVal  = (r && r.hotTemp  != null) ? r.hotTemp.toFixed(2)  + '°C' : '—';
  const coldVal = (r && r.coldTemp != null) ? r.coldTemp.toFixed(2) + '°C' : '—';

  document.getElementById('monitorContent').innerHTML = `
    <div class="mp-header">
      <div>
        <div class="mp-title">🔴 Live: ${bag.name}</div>
        <div class="mp-meta">Code: ${bag.code} · Channel ${CHANNEL_ID} · Auto-refresh every 15s</div>
      </div>
      <div class="mp-actions">
        <div class="live-badge">LIVE</div>
        <button class="btn-export" onclick="exportBagPdf()">Download PDF</button>
      </div>
    </div>
    <div class="mp-body">
      <div class="timestamp-bar">
        🕐 Updated: <strong>${now.toLocaleTimeString()}</strong>
        &nbsp;·&nbsp; ${history.length} readings loaded
      </div>

      <div class="readings-row">
        <div class="rb-card hot">
          <div class="rb-label">🔥 Hot Zone Temp</div>
          <div class="rb-value" id="liveHot">${hotVal}</div>
          <div class="rb-sub">field3 · ThingSpeak</div>
        </div>
        <div class="rb-card cold">
          <div class="rb-label">❄️ Cold Zone Temp</div>
          <div class="rb-value" id="liveCold">${coldVal}</div>
          <div class="rb-sub">field1 · ThingSpeak</div>
        </div>
      </div>

      <div class="charts-grid">
        <div class="chart-card">
          <div class="chart-title">
            <span class="chart-dot" style="background:var(--hot)"></span>
            Hot Zone History (°C)
          </div>
          <div class="chart-wrapper"><canvas id="chartHot"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="chart-title">
            <span class="chart-dot" style="background:var(--cold)"></span>
            Cold Zone History (°C)
          </div>
          <div class="chart-wrapper"><canvas id="chartCold"></canvas></div>
        </div>
      </div>
    </div>
  `;

  Object.keys(chartInstances).forEach(cid => {
    try { chartInstances[cid].destroy(); } catch(e) {}
    delete chartInstances[cid];
  });

  const baseOptions = (unit) => {
    const style = getComputedStyle(document.documentElement);
    const tickColor = style.getPropertyValue('--chart-tick').trim() || '#6b7080';
    const gridColor = style.getPropertyValue('--chart-grid').trim() || 'rgba(255,255,255,0.03)';
    const textColor = style.getPropertyValue('--text').trim() || '#F0F1F5';
    const mutedColor = style.getPropertyValue('--muted').trim() || '#6b7080';
    const surfaceColor = style.getPropertyValue('--surface2').trim() || '#14171f';
    return {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 500, easing: 'easeOutQuart' },
      plugins: { legend: { display: false }, tooltip: {
        backgroundColor: surfaceColor,
        borderColor: style.getPropertyValue('--border-strong').trim(),
        borderWidth: 1,
        titleColor: textColor, bodyColor: mutedColor, padding: 10,
        callbacks: { label: ctx => ` ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(2) : '—'} ${unit}` }
      }},
      scales: {
        x: { ticks: { color: tickColor, font:{size:9}, maxRotation:0, maxTicksLimit:5 }, grid: { color: gridColor }, border: { display:false } },
        y: { ticks: { color: tickColor, font:{size:9} }, grid: { color: gridColor }, border: { display:false } }
      }
    };
  };

  function gradient(ctx, rgb) {
    const g = ctx.createLinearGradient(0, 0, 0, 200);
    g.addColorStop(0, `rgba(${rgb},0.28)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    return g;
  }

  const hotCtx = document.getElementById('chartHot').getContext('2d');
  chartInstances['chartHot'] = new Chart(hotCtx, {
    type:'line', data:{
      labels,
      datasets:[{ data:hotData, borderColor:'rgb(255,107,53)',
        backgroundColor:gradient(hotCtx,'255,107,53'),
        fill:true, tension:.4, pointRadius:2.5,
        pointBackgroundColor:'rgb(255,107,53)', borderWidth:1.8, spanGaps:true }]
    }, options: baseOptions('°C')
  });

  const coldCtx = document.getElementById('chartCold').getContext('2d');
  chartInstances['chartCold'] = new Chart(coldCtx, {
    type:'line', data:{
      labels,
      datasets:[{ data:coldData, borderColor:'rgb(56,189,248)',
        backgroundColor:gradient(coldCtx,'56,189,248'),
        fill:true, tension:.4, pointRadius:2.5,
        pointBackgroundColor:'rgb(56,189,248)', borderWidth:1.8, spanGaps:true }]
    }, options: baseOptions('°C')
  });
}

function exportBagPdf() {
  const bag = bags.find(b => b.id === activeBagId);
  if (!bag || !bag.history || !bag.history.length) {
    alert('No readings available to export yet.');
    return;
  }

  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert('PDF library failed to load. Please check your internet connection and try again.');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  const history = bag.history;
  const title = 'Temperature Readings';
  const subtitle = `Bag: ${bag.name}  |  Code: ${bag.code || '-'}`;
  const generated = `Generated: ${new Date().toLocaleString()}`;

  let y = 15;
  doc.setFontSize(16);
  doc.text(title, 14, y);
  y += 7;

  doc.setFontSize(10);
  doc.text(subtitle, 14, y);
  y += 5;
  doc.text(generated, 14, y);
  y += 8;

  // table header
  doc.setFontSize(10);
  doc.setFont(undefined, 'bold');
  doc.text('#', 14, y);
  doc.text('Time', 24, y);
  doc.text('Hot (°C)', 100, y);
  doc.text('Cold (°C)', 140, y);
  doc.setFont(undefined, 'normal');
  y += 5;

  const lineHeight = 5;
  const bottomMargin = 280;

  history.forEach((h, idx) => {
    const d = h.timestamp instanceof Date ? h.timestamp : new Date(h.timestamp);
    const hot = h.hotTemp != null ? h.hotTemp.toFixed(2) : '—';
    const cold = h.coldTemp != null ? h.coldTemp.toFixed(2) : '—';

    if (y > bottomMargin) {
      doc.addPage();
      y = 20;
    }

    doc.text(String(idx + 1), 14, y);
    doc.text(d.toLocaleString(), 24, y);
    doc.text(String(hot), 100, y);
    doc.text(String(cold), 140, y);
    y += lineHeight;
  });

  const fileName = `infinos-readings-${bag.name.replace(/\s+/g, '_')}.pdf`;
  doc.save(fileName);
}

async function updateBagData(bagId) {
  try {
    const data = await fetchThingSpeak(20);
    const parsed = parseFeeds(data.feeds);
    const bag = bags.find(b => b.id === bagId);
    if (!bag) return;

    bag.history = parsed;
    bag.lastSeen = new Date().toISOString();
    saveBags();

    if (activeBagId === bagId) renderMonitor(bag);
    renderDevices();

    const r = parsed[parsed.length - 1];
    if (r) {
      const hotEl  = document.getElementById('liveHot');
      const coldEl = document.getElementById('liveCold');
      if (hotEl)  { hotEl.textContent  = r.hotTemp  != null ? r.hotTemp.toFixed(2)  + '°C' : '—'; flash(hotEl); }
      if (coldEl) { coldEl.textContent = r.coldTemp != null ? r.coldTemp.toFixed(2) + '°C' : '—'; flash(coldEl); }
    }
  } catch(e) { console.error('Update error:', e); }
}

function flash(el) {
  el.style.transition = 'opacity .1s';
  el.style.opacity = '0.4';
  setTimeout(() => { el.style.opacity = '1'; }, 200);
}

async function refreshAll() {
  const icon = document.getElementById('refreshIcon');
  if (icon) icon.style.animation = 'spin .55s linear infinite';

  for (const bag of bags) {
    try {
      const data = await fetchThingSpeak(20);
      bag.history = parseFeeds(data.feeds);
      bag.lastSeen = new Date().toISOString();
    } catch(e) {}
  }
  saveBags(); renderDevices();
  if (activeBagId) { const bag = bags.find(b=>b.id===activeBagId); if(bag) renderMonitor(bag); }
  if (icon) setTimeout(() => { icon.style.animation = ''; }, 900);
}

// ───────────────────────────────────────────────
// CLAIM MODAL
// ───────────────────────────────────────────────
function openClaimModal() {
  modalStep = 1;
  document.getElementById('deviceCodeInput').value = '';
  document.getElementById('bagNameInput').value = '';
  document.getElementById('errorBox').className = 'error-msg';
  updateModalUI();
  document.getElementById('claimModal').classList.add('open');
  setTimeout(() => document.getElementById('deviceCodeInput').focus(), 320);
}
function closeClaimModal() {
  document.getElementById('claimModal').classList.remove('open');
}

function updateModalUI() {
  const s1 = document.getElementById('step1Content');
  const s2 = document.getElementById('step2Content');
  const d1 = document.getElementById('step1dot');
  const d2 = document.getElementById('step2dot');
  const line = document.getElementById('stepLine');
  const nextBtn = document.getElementById('nextBtn');
  const backBtn = document.getElementById('backBtn');

  if (modalStep === 1) {
    s1.style.display='block'; s2.style.display='none';
    d1.className='step-dot active'; d1.textContent='1';
    d2.className='step-dot';
    line.className='step-line';
    nextBtn.textContent='Continue →';
    backBtn.textContent='Cancel'; backBtn.onclick=closeClaimModal;
  } else {
    s1.style.display='none'; s2.style.display='block';
    d1.className='step-dot done'; d1.textContent='✓';
    d2.className='step-dot active';
    line.className='step-line done';
    nextBtn.textContent='Claim Bag ✓';
    backBtn.textContent='← Back'; backBtn.onclick=()=>{ modalStep=1; updateModalUI(); };
  }
}

async function modalNext() {
  const errorBox = document.getElementById('errorBox');
  errorBox.className = 'error-msg';
  const nextBtn = document.getElementById('nextBtn');

  if (modalStep === 1) {
    const code = document.getElementById('deviceCodeInput').value.trim();
    if (!code || code.length < 3) {
      errorBox.textContent = 'Please enter a valid device code (min 3 chars)';
      errorBox.className = 'error-msg show'; return;
    }
    nextBtn.disabled = true;
    nextBtn.innerHTML = '<span class="spinner"></span>Verifying...';
    try {
      const data = await fetchThingSpeak(1);
      const feed = data.feeds[0];
      document.getElementById('verifyInfo').textContent =
        `CH:${CHANNEL_ID} · Entry #${feed.entry_id} · ${new Date(feed.created_at).toLocaleString()}`;
      modalStep = 2; updateModalUI();
      setTimeout(() => document.getElementById('bagNameInput').focus(), 100);
    } catch(e) {
      errorBox.textContent = 'Could not connect to ThingSpeak. Check your connection.';
      errorBox.className = 'error-msg show';
    } finally { nextBtn.disabled = false; nextBtn.textContent='Continue →'; }

  } else {
    const name = document.getElementById('bagNameInput').value.trim();
    const code = document.getElementById('deviceCodeInput').value.trim().toUpperCase();
    if (!name) {
      errorBox.textContent = 'Please enter a name for your bag';
      errorBox.className = 'error-msg show'; return;
    }
    nextBtn.disabled = true;
    nextBtn.innerHTML = '<span class="spinner"></span>Claiming...';
    try {
      const data = await fetchThingSpeak(20);
      const history = parseFeeds(data.feeds);
      const newBag = {
        id: 'bag_'+Date.now(), name, code,
        type: name.toLowerCase().includes('hot')?'hot':name.toLowerCase().includes('cold')?'cold':'dual',
        channelId: CHANNEL_ID, history,
        claimedAt: new Date().toISOString(), lastSeen: new Date().toISOString(),
      };
      bags.push(newBag); saveBags(); closeClaimModal(); renderDevices(); selectBag(newBag.id);
    } catch(e) {
      errorBox.textContent = 'Failed to fetch initial data. Try again.';
      errorBox.className = 'error-msg show';
    } finally { nextBtn.disabled=false; nextBtn.textContent='Claim Bag ✓'; }
  }
}

function modalBack() { closeClaimModal(); }

function handleOverlayClick(e) {
  if (e.target === document.getElementById('claimModal')) closeClaimModal();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeClaimModal();
  if (e.key === 'Enter' && document.getElementById('claimModal').classList.contains('open')) modalNext();
});

// ───────────────────────────────────────────────
// NAV
// ───────────────────────────────────────────────
function showPage(page, el) {
  document.querySelectorAll('.nav-link, .mob-nav-btn').forEach(l => l.classList.remove('active'));
  if (el) el.classList.add('active');
}

// ───────────────────────────────────────────────
// THEME TOGGLE
// ───────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('infinos_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (saved === 'light' || (!saved && !prefersDark)) {
    document.documentElement.classList.add('light');
  }
  updateThemeIcons();
}

function toggleTheme() {
  const isLight = document.documentElement.classList.toggle('light');
  localStorage.setItem('infinos_theme', isLight ? 'light' : 'dark');
  document.querySelector('meta[name="theme-color"]').content = isLight ? '#F4F5F7' : '#060709';
  updateThemeIcons();
  // Re-render charts with new colors
  if (activeBagId) {
    const bag = bags.find(b => b.id === activeBagId);
    if (bag) renderMonitor(bag);
  }
}

function updateThemeIcons() {
  const isLight = document.documentElement.classList.contains('light');
  // Mobile nav emoji spans
  document.querySelectorAll('.mob-theme-moon').forEach(el => el.style.display = isLight ? 'none'  : 'block');
  document.querySelectorAll('.mob-theme-sun').forEach(el  => el.style.display = isLight ? 'block' : 'none');
}
async function init() {
  initTheme();
  // Migrate old bags with wrong field names (temperature → hotTemp/coldTemp)
  let migrated = false;
  bags.forEach(bag => {
    if (bag.history && bag.history.length > 0) {
      const sample = bag.history[0];
      if ('temperature' in sample && !('hotTemp' in sample)) {
        bag.history = bag.history.map(h => ({
          timestamp: new Date(h.timestamp),
          hotTemp:  h.temperature ?? null,
          coldTemp: null,
          humidity: h.humidity   ?? null,
        }));
        migrated = true;
      } else if ('hotHumidity' in sample) {
        // very old schema
        bag.history = bag.history.map(h => ({
          timestamp: new Date(h.timestamp),
          hotTemp:  h.hotTemp  ?? null,
          coldTemp: h.coldTemp ?? null,
          humidity: h.hotHumidity ?? null,
        }));
        migrated = true;
      }
    }
  });
  if (migrated) saveBags();

  renderDevices();
  if (bags.length > 0) {
    for (const bag of bags) {
      try { const data = await fetchThingSpeak(20); bag.history = parseFeeds(data.feeds); } catch(e) {}
    }
    saveBags(); renderDevices(); selectBag(bags[0].id);
  }
}

init();