// ───────────────────────────────────────────────
// CHART.JS — zoom / pan (chartjs-plugin-zoom + Hammer.js)
// ───────────────────────────────────────────────
if (typeof Chart !== 'undefined' && typeof ChartZoom !== 'undefined') {
  Chart.register(ChartZoom);
}

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

// Fetch latest N readings (for live updates — keep fast)
async function fetchThingSpeak(count = 100) {
  const url = `https://api.thingspeak.com/channels/${CHANNEL_ID}/feeds.json?api_key=${API_KEY}&results=${count}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('ThingSpeak unreachable');
  return res.json();
}

// Fetch ALL readings from ThingSpeak.
// Strategy: ThingSpeak's `results` param maxes at 8000.
// We page backwards in time using `end=<ISO datetime>` — each page
// fetches the 8000 entries BEFORE that timestamp, until we get < 8000
// back (meaning we've hit the beginning).
async function fetchAllThingSpeak(onProgress) {
  const PAGE = 8000;
  let allFeeds = [];
  let endTime = null; // null = start from now, then walk backwards

  // Get total count so we can show a progress bar
  let totalEntries = 0;
  try {
    const infoRes = await fetch(
      `https://api.thingspeak.com/channels/${CHANNEL_ID}/feeds.json?api_key=${API_KEY}&results=1`
    );
    if (infoRes.ok) {
      const info = await infoRes.json();
      totalEntries = info.channel?.last_entry_id || 0;
    }
  } catch(e) {}

  if (onProgress) onProgress(0, totalEntries);

  let page = 0;
  while (true) {
    page++;
    let url = `https://api.thingspeak.com/channels/${CHANNEL_ID}/feeds.json?api_key=${API_KEY}&results=${PAGE}&timezone=UTC`;
    if (endTime) url += `&end=${encodeURIComponent(endTime)}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`ThingSpeak error: ${res.status}`);
    const data = await res.json();
    const feeds = data.feeds || [];

    if (!feeds.length) break; // no more data

    // Prepend (we're going backwards — oldest page last)
    allFeeds = feeds.concat(allFeeds);

    if (onProgress) onProgress(allFeeds.length, totalEntries);

    // If we got fewer than PAGE results, we've reached the beginning
    if (feeds.length < PAGE) break;

    // Set end to just before the earliest entry in this page
    const earliest = new Date(feeds[0].created_at);
    earliest.setSeconds(earliest.getSeconds() - 1);
    endTime = earliest.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

    // ThingSpeak rate limit: 1 req / ~1s on free tier
    await new Promise(r => setTimeout(r, 1100));
  }

  // Final deduplicate by entry_id (pages can slightly overlap)
  const seen = new Set();
  const unique = [];
  for (const f of allFeeds) {
    if (!seen.has(f.entry_id)) { seen.add(f.entry_id); unique.push(f); }
  }
  unique.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  return unique;
}

function parseFeeds(feeds) {
  return feeds.map(f => {
    const hot  = parseFloat(f.field1);
    const cold = parseFloat(f.field3);
    return {
      entry_id:  f.entry_id,
      timestamp: new Date(f.created_at),
      hotTemp:   isNaN(hot)  ? null : hot,
      coldTemp:  isNaN(cold) ? null : cold,
    };
  });
  // Note: we keep ALL rows including 0.0 — only skip if field is literally missing
}

// Merge new readings into existing history — deduplicate by entry_id
function mergeHistory(existing, incoming) {
  const seen = new Set(existing.map(r => r.entry_id));
  const merged = [...existing];
  for (const r of incoming) {
    if (!seen.has(r.entry_id)) {
      merged.push(r);
      seen.add(r.entry_id);
    }
  }
  // Sort by timestamp ascending
  merged.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return merged;
}

// ───────────────────────────────────────────────
// BAGS CRUD
// ───────────────────────────────────────────────
function saveBags() {
  localStorage.setItem('infinos_bags', JSON.stringify(bags));
}

function deleteBag(e, bagId) {
  e.stopPropagation();
  const bag = bags.find(b => b.id === bagId);
  if (!bag) return;
  if (!confirm(`Remove "${bag.name}" from your dashboard?`)) return;

  bags = bags.filter(b => b.id !== bagId);
  saveBags();

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

function safeExportBaseName(bag) {
  return (bag.name || 'readings').replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'readings';
}

function closeExportDd(el) {
  const dd = el && el.closest && el.closest('details.export-dd');
  if (dd) dd.open = false;
}

// ───────────────────────────────────────────────
// DATE-RANGE EXPORT MODAL
// ───────────────────────────────────────────────

let _exportBagId = null;

function openDateRangeModal(bagId) {
  _exportBagId = bagId;
  closeExportDd(document.querySelector('.export-dd'));
  const now  = new Date();
  const week = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const fmt  = d => d.toISOString().slice(0, 16);
  document.getElementById('drFrom').value = fmt(week);
  document.getElementById('drTo').value   = fmt(now);
  document.getElementById('drError').style.display = 'none';
  const bag = bags.find(b => b.id === bagId);
  if (bag && bag.history && bag.history.length) {
    const first = new Date(bag.history[0].timestamp);
    document.getElementById('drMinNote').textContent = `Earliest stored: ${first.toLocaleString()}`;
  } else {
    document.getElementById('drMinNote').textContent = '';
  }
  document.getElementById('dateRangeModal').classList.add('open');
}

function closeDateRangeModal() {
  document.getElementById('dateRangeModal').classList.remove('open');
  _exportBagId = null;
}

function drPreset(days) {
  const now  = new Date();
  const from = new Date(now - days * 24 * 60 * 60 * 1000);
  const fmt  = d => d.toISOString().slice(0, 16);
  document.getElementById('drFrom').value = fmt(from);
  document.getElementById('drTo').value   = fmt(now);
}

function drPresetAll() {
  const bag = bags.find(b => b.id === _exportBagId);
  const fmt = d => d.toISOString().slice(0, 16);
  if (bag && bag.history && bag.history.length) {
    document.getElementById('drFrom').value = fmt(new Date(bag.history[0].timestamp));
    document.getElementById('drTo').value   = fmt(new Date(bag.history[bag.history.length - 1].timestamp));
  } else {
    document.getElementById('drFrom').value = '2020-01-01T00:00';
    document.getElementById('drTo').value   = new Date().toISOString().slice(0, 16);
  }
}

async function drDownload(format) {
  const fromVal = document.getElementById('drFrom').value;
  const toVal   = document.getElementById('drTo').value;
  const errEl   = document.getElementById('drError');
  if (!fromVal || !toVal) {
    errEl.textContent = 'Please select both start and end date/time.';
    errEl.style.display = 'block'; return;
  }
  const fromDate = new Date(fromVal);
  const toDate   = new Date(toVal);
  if (fromDate >= toDate) {
    errEl.textContent = 'Start must be before end date.';
    errEl.style.display = 'block'; return;
  }
  errEl.style.display = 'none';
  const bag = bags.find(b => b.id === _exportBagId);
  if (!bag) return;
  closeDateRangeModal();
  if (format === 'pdf') {
    if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) {
      alert('PDF library not loaded. Please refresh the page.'); return;
    }
    await downloadReadingsPdf(bag, fromDate, toDate);
  } else {
    if (typeof XLSX === 'undefined') {
      alert('Excel library not loaded. Please refresh the page.'); return;
    }
    await downloadReadingsExcel(bag, fromDate, toDate);
  }
}

// ───────────────────────────────────────────────
// DOWNLOAD
// ───────────────────────────────────────────────

async function downloadReadingsPdf(bag, fromDate, toDate) {
  const history = await fetchRangeForExport(bag, fromDate, toDate);
  if (!history) return;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  doc.setFontSize(14); doc.setTextColor(40,40,45);
  doc.text('infinosTech - Temperature Readings', 14, 14);
  doc.setFontSize(9);
  doc.text(`Bag: ${bag.name}   |   Code: ${bag.code}   |   Channel: ${CHANNEL_ID}`, 14, 21);
  doc.text(`From: ${fromDate.toLocaleString()}  To: ${toDate.toLocaleString()}`, 14, 26);
  doc.text(`Exported: ${new Date().toLocaleString()}   |   Total readings: ${history.length}`, 14, 31);
  const body = history.map(h => {
    const d = h.timestamp instanceof Date ? h.timestamp : new Date(h.timestamp);
    return [ h.entry_id ?? '', d.toLocaleString(),
      h.hotTemp  != null ? h.hotTemp.toFixed(2)  : '-',
      h.coldTemp != null ? h.coldTemp.toFixed(2) : '-' ];
  });
  doc.autoTable({
    startY: 35,
    head: [['Entry #', 'Timestamp', 'Hot Zone (C)', 'Cold Zone (C)']],
    body,
    styles: { fontSize: 7.5, cellPadding: 1.8 },
    headStyles: { fillColor: [255,107,53], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [245,245,248] },
    columnStyles: { 0: { cellWidth: 18 }, 1: { cellWidth: 52 } },
  });
  const tag = `${fromDate.toISOString().slice(0,10)}_to_${toDate.toISOString().slice(0,10)}`;
  doc.save(`infinosTech_${safeExportBaseName(bag)}_${tag}.pdf`);
}

async function downloadReadingsExcel(bag, fromDate, toDate) {
  const history = await fetchRangeForExport(bag, fromDate, toDate);
  if (!history) return;
  const tag = `${fromDate.toISOString().slice(0,10)}_to_${toDate.toISOString().slice(0,10)}`;
  const aoa = [
    ['Entry #','Timestamp (ISO)','Timestamp (Local)','Hot Zone (C)','Cold Zone (C)'],
    ...history.map(h => {
      const d = h.timestamp instanceof Date ? h.timestamp : new Date(h.timestamp);
      return [ h.entry_id??'', d.toISOString(), d.toLocaleString(),
        h.hotTemp !=null ? Number(h.hotTemp.toFixed(4)) : '',
        h.coldTemp!=null ? Number(h.coldTemp.toFixed(4)): '' ];
    }),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{wch:10},{wch:26},{wch:22},{wch:16},{wch:16}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Readings');
  const summary = [
    ['Bag Name', bag.name], ['Device Code', bag.code], ['Channel', CHANNEL_ID],
    ['From', fromDate.toLocaleString()], ['To', toDate.toLocaleString()],
    ['Total Readings', history.length], ['Export Date', new Date().toLocaleString()],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(summary);
  ws2['!cols'] = [{wch:18},{wch:30}];
  XLSX.utils.book_append_sheet(wb, ws2, 'Info');
  XLSX.writeFile(wb, `infinosTech_${safeExportBaseName(bag)}_${tag}.xlsx`);
}

async function fetchRangeForExport(bag, fromDate, toDate) {
  const overlay = document.createElement('div');
  overlay.id = 'fetchOverlay';
  overlay.innerHTML = `
    <div class="fetch-modal">
      <div class="fetch-icon">&#128225;</div>
      <div class="fetch-title">Fetching Readings</div>
      <div class="fetch-sub" id="fetchSub">Querying ThingSpeak...</div>
      <div class="fetch-bar-wrap"><div class="fetch-bar" id="fetchBar" style="width:5%"></div></div>
      <div class="fetch-count" id="fetchCount">Connecting...</div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  try {
    const fmtTS = d => d.toISOString().replace('T',' ').replace(/\.\d+Z$/,' UTC');
    const startStr = fmtTS(fromDate);
    const PAGE = 8000;
    let allFeeds = [], pageEnd = fmtTS(toDate), barPct = 5;
    while (true) {
      const url = `https://api.thingspeak.com/channels/${CHANNEL_ID}/feeds.json` +
        `?api_key=${API_KEY}&results=${PAGE}` +
        `&start=${encodeURIComponent(startStr)}&end=${encodeURIComponent(pageEnd)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ThingSpeak error: ${res.status}`);
      const data = await res.json();
      const feeds = data.feeds || [];
      if (!feeds.length) break;
      allFeeds = feeds.concat(allFeeds);
      barPct = Math.min(barPct + 20, 90);
      const barEl = document.getElementById('fetchBar');
      const subEl = document.getElementById('fetchSub');
      const cntEl = document.getElementById('fetchCount');
      if (barEl) barEl.style.width = barPct + '%';
      if (subEl) subEl.textContent = `Fetched ${allFeeds.length.toLocaleString()} readings...`;
      if (cntEl) cntEl.textContent = `${new Date(feeds[0].created_at).toLocaleDateString()} to ${new Date(feeds[feeds.length-1].created_at).toLocaleDateString()}`;
      if (feeds.length < PAGE) break;
      const earliest = new Date(feeds[0].created_at);
      earliest.setSeconds(earliest.getSeconds() - 1);
      pageEnd = fmtTS(earliest);
      await new Promise(r => setTimeout(r, 1100));
    }
    const seen = new Set(), unique = [];
    for (const f of allFeeds) { if (!seen.has(f.entry_id)) { seen.add(f.entry_id); unique.push(f); } }
    unique.sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
    const history = parseFeeds(unique);
    bag.history = mergeHistory(bag.history || [], history);
    saveBags(); renderDevices();
    if (activeBagId === bag.id) renderMonitor(bag);
    const barEl = document.getElementById('fetchBar');
    if (barEl) barEl.style.width = '100%';
    if (!history.length) {
      alert(`No readings found between ${fromDate.toLocaleString()} and ${toDate.toLocaleString()}`);
      return null;
    }
    return history;
  } catch (err) {
    alert('Failed to fetch readings: ' + err.message);
    return null;
  } finally {
    const el = document.getElementById('fetchOverlay');
    if (el) { el.classList.remove('open'); setTimeout(() => el.remove(), 300); }
  }
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
        <details class="export-dd">
          <summary class="btn-export" title="Download readings">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download
            <svg class="export-dd-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
          </summary>
          <div class="export-dd-menu" role="menu">
            <button type="button" class="export-dd-item" role="menuitem" onclick="openDateRangeModal('${bag.id}'); closeExportDd(this);">
              &#128197; Select Date Range
            </button>
          </div>
        </details>
        <div class="live-badge">LIVE</div>
      </div>
    </div>
    <div class="mp-body">
      <div class="timestamp-bar">
        🕐 Updated: <strong>${now.toLocaleTimeString()}</strong>
        &nbsp;·&nbsp; <strong>${history.length.toLocaleString()}</strong> readings stored · auto-refresh 15s
      </div>
      </div>

      <div class="readings-row">
        <div class="rb-card hot">
          <div class="rb-label">🔥 Hot Zone Temp</div>
          <div class="rb-value" id="liveHot">${hotVal}</div>
          <div class="rb-sub">field1 · ThingSpeak</div>
        </div>
        <div class="rb-card cold">
          <div class="rb-label">❄️ Cold Zone Temp</div>
          <div class="rb-value" id="liveCold">${coldVal}</div>
          <div class="rb-sub">field3 · ThingSpeak</div>
        </div>
      </div>

      <div class="charts-grid">
        <div class="chart-card">
          <div class="chart-head">
            <div class="chart-title">
              <span class="chart-dot" style="background:var(--hot)"></span>
              Hot Zone History (°C)
            </div>
            <button type="button" class="chart-reset-zoom" onclick="resetChartZoom('chartHot')" title="Reset zoom &amp; pan" aria-label="Reset hot zone chart zoom">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            </button>
          </div>
          <p class="chart-zoom-hint">Scroll or pinch to zoom · drag to pan · double-click to reset</p>
          <div class="chart-wrapper chart-wrapper--zoom"><canvas id="chartHot"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="chart-head">
            <div class="chart-title">
              <span class="chart-dot" style="background:var(--cold)"></span>
              Cold Zone History (°C)
            </div>
            <button type="button" class="chart-reset-zoom" onclick="resetChartZoom('chartCold')" title="Reset zoom &amp; pan" aria-label="Reset cold zone chart zoom">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            </button>
          </div>
          <p class="chart-zoom-hint">Scroll or pinch to zoom · drag to pan · double-click to reset</p>
          <div class="chart-wrapper chart-wrapper--zoom"><canvas id="chartCold"></canvas></div>
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

    const plugins = {
      legend: { display: false },
      tooltip: {
        backgroundColor: surfaceColor,
        borderColor: style.getPropertyValue('--border-strong').trim(),
        borderWidth: 1,
        titleColor: textColor, bodyColor: mutedColor, padding: 10,
        callbacks: { label: ctx => ` ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(2) : '—'} ${unit}` }
      }
    };

    if (typeof ChartZoom !== 'undefined') {
      plugins.zoom = {
        limits: {
          x: { min: 'original', max: 'original' },
          y: { min: 'original', max: 'original' }
        },
        pan: {
          enabled: true,
          mode: 'xy',
          threshold: 6
        },
        zoom: {
          wheel: { enabled: true, speed: 0.11 },
          pinch: { enabled: true },
          mode: 'xy',
          doubleClick: { enabled: true, mode: 'reset' }
        }
      };
    }

    return {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 500, easing: 'easeOutQuart' },
      interaction: { mode: 'nearest', intersect: false },
      plugins,
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

async function updateBagData(bagId) {
  try {
    const data = await fetchThingSpeak(20);
    const parsed = parseFeeds(data.feeds);
    const bag = bags.find(b => b.id === bagId);
    if (!bag) return;

    bag.history = mergeHistory(bag.history || [], parsed);
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

/** Reset zoom/pan on a live-monitor chart (canvas id: chartHot | chartCold). */
function resetChartZoom(canvasId) {
  const ch = chartInstances[canvasId];
  if (!ch) return;
  if (typeof ch.resetZoom === 'function') {
    try { ch.resetZoom(); } catch (e) { console.warn('resetZoom:', e); }
  }
}

async function refreshAll() {
  const icon = document.getElementById('refreshIcon');
  if (icon) icon.style.animation = 'spin .55s linear infinite';

  for (const bag of bags) {
    try {
      const data = await fetchThingSpeak(100);
      const parsed = parseFeeds(data.feeds);
      bag.history = mergeHistory(bag.history || [], parsed);
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
        }));
        migrated = true;
      } else if ('hotHumidity' in sample) {
        // very old schema
        bag.history = bag.history.map(h => ({
          timestamp: new Date(h.timestamp),
          hotTemp:  h.hotTemp  ?? null,
          coldTemp: h.coldTemp ?? null,
        }));
        migrated = true;
      }
    }
  });
  if (migrated) saveBags();

  renderDevices();
  if (bags.length > 0) {
    for (const bag of bags) {
      try { const data = await fetchThingSpeak(100); const p = parseFeeds(data.feeds); bag.history = mergeHistory(bag.history||[], p); } catch(e) {}
    }
    saveBags(); renderDevices(); selectBag(bags[0].id);
  }
}

init();