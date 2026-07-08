/*
   SABER 11 – APLICACIÓN PRINCIPAL (app.js)
   Arquitectura: Flask API + SQLite backend
   Todos los filtros se envían al servidor que retorna los datos exactos.
   
   Endpoints usados:
     POST /api/geo          → resumen geográfico (depto o municipio)
     POST /api/trend        → tendencia histórica por periodo
     POST /api/distributions → distribuciones por naturaleza, área, género, estrato
     GET  /api/mapping      → códigos DANE → nombres
*/

// ─── ESTADO GLOBAL ──────────────────────────────────────────────────────────
let geoData    = null;
let mapping    = null;   // { deptos: {code: name}, mcpios: {code: name} }
let clusters   = null;
let map        = null;
let geoLayer   = null;
let charts     = {};
let refreshBusy = false;

// Rango de periodos disponibles (cargado una sola vez)
let availablePeriods = [];  // e.g. [19961, 19962, 19971, ...]
let availableYears   = [];  // unique sorted years

let filters = {
    depto:     '',   // nombre del departamento
    mcpio:     null, // código numérico del municipio
    year_start: null,
    year_end:   null,
    sem:        '',   // '1' | '2' | ''
    map_metric: 'global',
    trend_subject: 'global',
    scatter_x:  'pr',
    cluster_filter: 'ALL',
    mcpio_metric: 'global',
    // Características del colegio
    nature:   '',   // 'Oficial' | 'No Oficial' | 'NR' | ''
    area:     '',   // 'Urbano' | 'Rural' | 'NR' | ''
    // Estudiante
    gender:   '',   // 'Femenino' | 'Masculino' | 'NR' | ''
    stratum:  '',   // '1'..'6' | ''
    // Socioeconómico
    hh_size:    '',
    father_edu: '',
    mother_edu: ''
};

// ─── INICIO ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    loadData();
    setupTabs();
    setupClusterButtons();
});

function initTheme() {
    const toggle = document.getElementById('theme-toggle');
    const stored = localStorage.getItem('saber11-theme');
    const initialTheme = stored === 'light' ? 'light' : 'dark';
    applyTheme(initialTheme);

    toggle?.addEventListener('click', () => {
        const nextTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        applyTheme(nextTheme);
    });
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('saber11-theme', theme);

    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;

    const icon = toggle.querySelector('i');
    const label = toggle.querySelector('span');
    if (theme === 'light') {
        icon.className = 'fa-solid fa-moon';
        label.textContent = 'Modo oscuro';
        toggle.setAttribute('aria-pressed', 'false');
    } else {
        icon.className = 'fa-solid fa-sun';
        label.textContent = 'Modo claro';
        toggle.setAttribute('aria-pressed', 'true');
    }
}

async function loadData() {
    const bar = document.getElementById('loader-progress-bar');
    try {
        bar.style.width = '10%';

        // 1. Cargar GeoJSON
        const rGeo = await fetch('colombia.geojson');
        if (!rGeo.ok) throw new Error('No se pudo cargar colombia.geojson');
        geoData = await rGeo.json();
        bar.style.width = '30%';

        // 2. Cargar clusters
        const rClust = await apiFetch('/api/clusters', buildApiFilters());
        clusters = rClust;
        bar.style.width = '50%';

        // 3. Cargar mapeo DANE (códigos ↔ nombres)
        const rMap = await fetch('/api/mapping');
        if (!rMap.ok) throw new Error('No se pudo cargar /api/mapping');
        mapping = await rMap.json();
        bar.style.width = '70%';

        // 4. Cargar lista de periodos disponibles desde la API
        const rFiles = await fetch('/api/periods');
        if (!rFiles.ok) throw new Error('No se pudo cargar /api/periods');
        availablePeriods = (await rFiles.json()).sort();
        availableYears   = [...new Set(availablePeriods.map(p => Math.floor(p / 10)))].sort((a,b)=>a-b);
        bar.style.width = '90%';

        bar.style.width = '100%';
        setTimeout(() => {
            const overlay = document.getElementById('loader-overlay');
            overlay.style.opacity = '0';
            setTimeout(() => { overlay.style.display = 'none'; }, 500);
            initApp();
        }, 300);
    } catch (e) {
        console.error(e);
        document.querySelector('.loader-title').textContent = '⚠ Error cargando datos';
        document.querySelector('.loader-subtitle').textContent = e.message;
        document.querySelector('.spinner').style.borderTopColor = '#ef4444';
    }
}

function initApp() {
    populateFilters();
    initMap();
    updateDashboard();
}

function showRefreshOverlay() {
    const overlay = document.getElementById('dashboard-refresh-overlay');
    if (!overlay) return;
    overlay.classList.add('is-visible');
    overlay.setAttribute('aria-hidden', 'false');
}

function hideRefreshOverlay() {
    const overlay = document.getElementById('dashboard-refresh-overlay');
    if (!overlay) return;
    overlay.classList.remove('is-visible');
    overlay.setAttribute('aria-hidden', 'true');
}

function getFilterSummaryEntries(extra = {}) {
    const entries = [];
    const add = (label, value) => {
        if (value === undefined || value === null || value === '') return;
        entries.push({ label, value });
    };

    const start = filters.year_start || availableYears[0];
    const end = filters.year_end || availableYears[availableYears.length - 1];
    add('Periodo', `${start}–${end}`);

    if (filters.depto) add('Departamento', filters.depto);
    if (filters.mcpio) add('Municipio', mapping?.mcpios?.[String(filters.mcpio)] || filters.mcpio);
    if (filters.sem) add('Semestre', filters.sem === '1' ? '1º' : '2º');
    if (filters.nature) add('Naturaleza', filters.nature);
    if (filters.area) add('Área', filters.area);
    if (filters.gender) add('Género', filters.gender);
    if (filters.stratum) add('Estrato', filters.stratum);
    if (filters.hh_size) add('Hogar', filters.hh_size === 'small' ? 'Pequeño' : filters.hh_size === 'medium' ? 'Mediano' : 'Grande');
    if (filters.father_edu) add('Padre', filters.father_edu === 'low' ? 'Sin educación / Primaria' : filters.father_edu === 'secondary' ? 'Secundaria / Bachillerato' : filters.father_edu === 'technical' ? 'Técnica / Tecnológica' : 'Universitaria o más');
    if (filters.mother_edu) add('Madre', filters.mother_edu === 'low' ? 'Sin educación / Primaria' : filters.mother_edu === 'secondary' ? 'Secundaria / Bachillerato' : filters.mother_edu === 'technical' ? 'Técnica / Tecnológica' : 'Universitaria o más');

    if (extra.metric) add(extra.metric.label, extra.metric.value);
    if (extra.clusterLevel && extra.clusterLevel !== 'ALL') add('Conglomerado', extra.clusterLevel);
    if (extra.subject) add(extra.subject.label, extra.subject.value);
    if (extra.axis) add(extra.axis.label, extra.axis.value);

    return entries;
}

function renderFilterSummary(containerId, extra = {}) {
    const container = document.getElementById(containerId);
    const list = document.getElementById(`${containerId}-list`);
    if (!container || !list) return;

    const entries = getFilterSummaryEntries(extra);
    if (!entries.length) {
        list.innerHTML = '<span class="filter-chip"><strong>Sin filtros adicionales</strong></span>';
        return;
    }

    list.innerHTML = entries.map(entry => `<span class="filter-chip"><strong>${entry.label}:</strong> ${entry.value}</span>`).join('');
}

function updateFilterSummaries() {
    renderFilterSummary('filter-summary-resumen', { metric: { label: 'Métrica mapa', value: { global: 'Puntaje Global', mat: 'Matemáticas', lec: 'Lectura', cna: 'Ciencias Naturales', soc: 'Sociales', ing: 'Inglés', evaluados: 'Evaluados' }[filters.map_metric] || filters.map_metric } });
    renderFilterSummary('filter-summary-tendencias', { subject: { label: 'Materia', value: { global: 'Global', mat: 'Matemáticas', lec: 'Lectura', cna: 'Ciencias Naturales', soc: 'Sociales', ing: 'Inglés', evaluados: 'Evaluados' }[filters.trend_subject] || filters.trend_subject } });
    renderFilterSummary('filter-summary-cluster-scatter', { axis: { label: 'Eje X', value: { pr: '% Rural', po: '% Oficiales', ps: '% Estrato 1-2' }[filters.scatter_x] || filters.scatter_x } });
    renderFilterSummary('filter-summary-cluster-table', { clusterLevel: filters.cluster_filter });
    renderFilterSummary('filter-summary-municipality', { metric: { label: 'Métrica', value: { global: 'Global', mat: 'Matemáticas', lec: 'Lectura', cna: 'Ciencias Naturales', soc: 'Sociales', ing: 'Inglés' }[filters.mcpio_metric] || filters.mcpio_metric } });
}

// ─── HELPERS DE API ──────────────────────────────────────────────────────────
function buildApiFilters() {
    const f = {};
    if (filters.depto)      f.depto      = filters.depto;
    if (filters.mcpio)      f.mcpio      = filters.mcpio;
    if (filters.year_start) f.year_start = filters.year_start;
    if (filters.year_end)   f.year_end   = filters.year_end;
    if (filters.sem)        f.sem        = filters.sem;
    if (filters.nature)     f.nature     = filters.nature;
    if (filters.area)       f.area       = filters.area;
    if (filters.gender)     f.gender     = filters.gender;
    if (filters.stratum)    f.stratum    = filters.stratum;
    if (filters.hh_size)    f.hh_size    = filters.hh_size;
    if (filters.father_edu) f.father_edu = filters.father_edu;
    if (filters.mother_edu) f.mother_edu = filters.mother_edu;
    return f;
}

async function apiFetch(endpoint, body) {
    const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`API error ${r.status} on ${endpoint}`);
    return r.json();
}

// ─── FILTROS ─────────────────────────────────────────────────────────────────
function populateFilters() {
    // Departamentos
    const sel = document.getElementById('select-dept');
    const deptoNames = Object.values(mapping.deptos).sort();
    deptoNames.forEach(d => {
        const o = document.createElement('option'); o.value = d; o.textContent = d; sel.appendChild(o);
    });

    // Años
    const sy = document.getElementById('select-year-start');
    const ey = document.getElementById('select-year-end');
    availableYears.forEach(y => {
        [sy, ey].forEach(s => { const o = document.createElement('option'); o.value = y; o.textContent = y; s.appendChild(o); });
    });
    filters.year_start = availableYears[0];
    filters.year_end   = availableYears[availableYears.length - 1];
    sy.value = filters.year_start;
    ey.value = filters.year_end;

    // Event listeners
    sel.addEventListener('change', e => { filters.depto = e.target.value; filters.mcpio = null; updateMcpioDropdown(); renderGeoLayer(); updateDashboard(); });
    document.getElementById('select-year-start').addEventListener('change',  e => { filters.year_start = +e.target.value; renderGeoLayer(); updateDashboard(); });
    document.getElementById('select-year-end').addEventListener('change',    e => { filters.year_end   = +e.target.value; renderGeoLayer(); updateDashboard(); });
    document.getElementById('select-period-sem').addEventListener('change',  e => { filters.sem        = e.target.value;  renderGeoLayer(); updateDashboard(); });
    document.getElementById('select-map-metric').addEventListener('change',  e => { filters.map_metric = e.target.value;  renderGeoLayer(); updateFilterSummaries(); });
    document.getElementById('select-trend-subject').addEventListener('change', e => { filters.trend_subject = e.target.value; renderTrend(); updateFilterSummaries(); });
    document.getElementById('select-scatter-x').addEventListener('change',   e => { filters.scatter_x   = e.target.value; renderScatter(); updateFilterSummaries(); });
    document.getElementById('select-mcpio-metric').addEventListener('change', e => { filters.mcpio_metric = e.target.value; renderMcpioCharts(); updateFilterSummaries(); });
    document.getElementById('input-search-mcpio').addEventListener('input',   () => renderMcpioTable());
    document.getElementById('btn-clear-filters').addEventListener('click', clearFilters);

    document.getElementById('select-nature').addEventListener('change', e => { filters.nature  = e.target.value; updateDashboard(); });
    document.getElementById('select-area').addEventListener('change',   e => { filters.area    = e.target.value; updateDashboard(); });
    document.getElementById('select-gender').addEventListener('change', e => { filters.gender  = e.target.value; updateDashboard(); });
    document.getElementById('select-stratum').addEventListener('change',e => { filters.stratum = e.target.value; updateDashboard(); });
    document.getElementById('select-hh-size').addEventListener('change',    e => { filters.hh_size    = e.target.value; updateDashboard(); });
    document.getElementById('select-father-edu').addEventListener('change',  e => { filters.father_edu = e.target.value; updateDashboard(); });
    document.getElementById('select-mother-edu').addEventListener('change',  e => { filters.mother_edu = e.target.value; updateDashboard(); });
}

function updateMcpioDropdown() {
    const sel = document.getElementById('select-mcpio');
    sel.innerHTML = '<option value="">Todos los Municipios</option>';
    if (!filters.depto || !mapping) { sel.disabled = true; return; }
    sel.disabled = false;

    // Buscar código de departamento
    const deptoCode = Object.entries(mapping.deptos).find(([,name]) => name === filters.depto)?.[0];
    if (!deptoCode) return;
    const deptoCodeNum = parseInt(deptoCode);

    // Filtrar municipios por departamento (prefijo de código)
    const mcpios = Object.entries(mapping.mcpios)
        .filter(([code]) => Math.floor(parseInt(code) / 1000) === deptoCodeNum)
        .sort((a, b) => a[1].localeCompare(b[1]));

    mcpios.forEach(([code, name]) => {
        const o = document.createElement('option'); o.value = code; o.textContent = name; sel.appendChild(o);
    });
    if (!sel.hasAttribute('data-listener')) {
        sel.setAttribute('data-listener', '1');
        sel.addEventListener('change', e => { filters.mcpio = +e.target.value || null; updateDashboard(); });
    }
}

function clearFilters() {
    filters.depto = ''; filters.mcpio = null; filters.sem = '';
    filters.nature = ''; filters.area = ''; filters.gender = ''; filters.stratum = '';
    filters.hh_size = ''; filters.father_edu = ''; filters.mother_edu = '';
    filters.year_start = availableYears[0]; filters.year_end = availableYears[availableYears.length - 1];
    ['select-dept','select-mcpio','select-period-sem','select-nature','select-area','select-gender','select-stratum',
     'select-hh-size','select-father-edu','select-mother-edu'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('select-year-start').value = filters.year_start;
    document.getElementById('select-year-end').value   = filters.year_end;
    document.getElementById('select-mcpio').disabled = true;
    updateClearButtonState();
    renderGeoLayer();
    updateDashboard();
}

function updateClearButtonState() {
    const hasActive = !!(filters.depto || filters.mcpio || filters.sem ||
        filters.nature || filters.area || filters.gender || filters.stratum ||
        filters.hh_size || filters.father_edu || filters.mother_edu ||
        (filters.year_start && filters.year_start !== availableYears[0]) ||
        (filters.year_end   && filters.year_end   !== availableYears[availableYears.length - 1]));
    const btn = document.getElementById('btn-clear-filters');
    if (btn) btn.classList.toggle('has-filters', hasActive);
}

// ─── ACTUALIZAR TODO ──────────────────────────────────────────────────────────
async function updateDashboard() {
    if (!refreshBusy) {
        refreshBusy = true;
        showRefreshOverlay();
    }

    try {
        await Promise.all([
            renderGeoLayer(),
            updateKPIs(),
            renderDistributions(),
            renderTrend(),
            renderMcpioCharts(),
            renderMcpioTable(),
            refreshClusters()
        ]);
        updateFilterSummaries();
        updateClearButtonState();
    } finally {
        refreshBusy = false;
        hideRefreshOverlay();
    }
}

async function refreshClusters() {
    try {
        clusters = await apiFetch('/api/clusters', buildApiFilters());
        renderClustersTable();
        renderScatter();
    } catch (e) {
        console.error('refreshClusters:', e);
    }
}

// ─── KPIs (desde /api/geo con agrupación por depto) ─────────────────────────
async function updateKPIs() {
    try {
        const apiFilters = { ...buildApiFilters(), group_by: 'depto' };
        const rows = await apiFetch('/api/geo', apiFilters);
        let totalCnt = 0, sg = 0, sm = 0, sl = 0, sc = 0, ss = 0, si = 0;
        rows.forEach(r => {
            const w = r.count || 0;
            totalCnt += w;
            sg += (r.avg_global || 0) * w;
            sm += (r.avg_mat    || 0) * w;
            sl += (r.avg_lec    || 0) * w;
            sc += (r.avg_cna    || 0) * w;
            ss += (r.avg_soc    || 0) * w;
            si += (r.avg_ing    || 0) * w;
        });
        const n = totalCnt || 1;
        document.getElementById('val-kpi-evaluados').textContent = totalCnt.toLocaleString('es-CO');
        document.getElementById('val-kpi-global').textContent    = Math.round(sg / n);
        document.getElementById('val-kpi-mat').textContent       = (sm / n).toFixed(1);
        document.getElementById('val-kpi-lec').textContent       = (sl / n).toFixed(1);
        document.getElementById('val-kpi-cna').textContent       = (sc / n).toFixed(1);
        document.getElementById('val-kpi-soc').textContent       = (ss / n).toFixed(1);
        document.getElementById('val-kpi-ing').textContent       = (si / n).toFixed(1);
    } catch(e) { console.error('updateKPIs:', e); }
}

// ─── MAPA ────────────────────────────────────────────────────────────────────
function initMap() {
    map = L.map('colombia-map', { zoomControl: true, scrollWheelZoom: false, attributionControl: false })
            .setView([4.57, -74.30], 5);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 9, minZoom: 4 }).addTo(map);
    renderGeoLayer();
}

async function renderGeoLayer() {
    if (!geoData || !mapping) return;
    if (geoLayer) { map.removeLayer(geoLayer); geoLayer = null; }

    let stats = {};
    try {
        const apiFilters = { ...buildApiFilters(), group_by: 'depto' };
        const rows = await apiFetch('/api/geo', apiFilters);
        rows.forEach(r => {
            const name = mapping.deptos[String(r.code)];
            if (name) stats[name] = r;
        });
    } catch(e) { console.error('renderGeoLayer:', e); }

    const metric = filters.map_metric;
    const vals = Object.values(stats).map(s => metric === 'cnt' ? s.count : (s[`avg_${metric}`] || 0)).filter(v => v > 0);
    const mn = vals.length ? Math.min(...vals) : 0;
    const mx = vals.length ? Math.max(...vals) : 100;

    function getColor(v) {
        if (!v) return '#1e293b';
        const t = (v - mn) / (mx - mn || 1);
        const colors = metric === 'cnt'
            ? ['#0284c7','#0369a1','#6d28d9','#7c3aed','#db2777']
            : ['#ea580c','#eab308','#06b6d4','#10b981','#059669'];
        return colors[Math.min(4, Math.floor(t * 5))];
    }

    geoLayer = L.geoJSON(geoData, {
        style: feat => {
            const dn  = feat.properties.normalized_name;
            const s   = stats[dn];
            const val = s ? (metric === 'cnt' ? s.count : s[`avg_${metric}`]) : null;
            const sel = filters.depto === dn;
            return { fillColor: getColor(val), weight: sel ? 3 : 1, color: sel ? '#38bdf8' : '#334155', fillOpacity: sel ? 0.85 : 0.65 };
        },
        onEachFeature: (feat, layer) => {
            const dn = feat.properties.normalized_name;
            const s  = stats[dn];
            let tip = `<div style="font-family:'Outfit',sans-serif;padding:8px;min-width:160px"><strong style="color:#f8fafc">${dn}</strong><br>`;
            if (s && s.count > 0) {
                tip += `<span style="color:#94a3b8">Evaluados: </span><strong style="color:#0ea5e9">${s.count.toLocaleString('es-CO')}</strong><br>`;
                tip += `<span style="color:#94a3b8">Global prom.: </span><strong style="color:#a855f7">${Math.round(s.avg_global)}</strong><br>`;
                tip += `<span style="color:#94a3b8">Matemáticas: </span><strong style="color:#10b981">${(s.avg_mat||0).toFixed(1)}</strong><br>`;
                tip += `<span style="color:#94a3b8">Lectura: </span><strong style="color:#f97316">${(s.avg_lec||0).toFixed(1)}</strong>`;
            } else { tip += '<span style="color:#64748b">Sin datos para los filtros</span>'; }
            tip += '</div>';
            layer.bindTooltip(tip, { sticky: true, className: 'leaflet-tooltip-own' });
            layer.on({
                mouseover: e => e.target.setStyle({ fillOpacity: 0.85, weight: 2 }),
                mouseout:  e => geoLayer.resetStyle(e.target),
                click: () => {
                    filters.depto = filters.depto === dn ? '' : dn;
                    filters.mcpio = null;
                    document.getElementById('select-dept').value = filters.depto;
                    updateMcpioDropdown();
                    renderGeoLayer();
                    updateDashboard();
                }
            });
        }
    }).addTo(map);

    // Legend
    const leg = document.getElementById('map-legend');
    const cs = metric === 'cnt'
        ? ['#0284c7','#0369a1','#6d28d9','#7c3aed','#db2777']
        : ['#ea580c','#eab308','#06b6d4','#10b981','#059669'];
    leg.innerHTML = '<div class="legend-item"><strong>Escala:</strong></div>' +
        cs.map((c, i) => {
            const v = mn + (mx - mn) * (i / 4);
            return `<div class="legend-item"><span class="legend-color" style="background:${c}"></span><span>${Math.round(v)}</span></div>`;
        }).join('');
}

// ─── DISTRIBUCIONES ──────────────────────────────────────────────────────────
async function renderDistributions() {
    try {
        const rows = await apiFetch('/api/distributions', buildApiFilters());
        renderNatureChart(rows.nature || []);
        renderAreaChart(rows.area || []);
        renderGenderChart(rows.gender || []);
        renderStratumChart(rows.stratum || []);
    } catch(e) { console.error('renderDistributions:', e); }
}

function renderNatureChart(data) {
    const nat = { O: 0, P: 0, NR: 0 };
    data.forEach(r => { nat[r.key] = r.count; });
    const total = (nat.O + nat.P + nat.NR) || 1;

    const alphaO  = (!filters.nature || filters.nature === 'Oficial')    ? 1 : 0.25;
    const alphaP  = (!filters.nature || filters.nature === 'No Oficial')  ? 1 : 0.25;
    const alphaNR = (!filters.nature || filters.nature === 'NR')          ? 1 : 0.25;

    const natData    = [nat.O, nat.P, nat.NR];
    const natLabels  = ['Oficial (Público)','No Oficial (Privado)','No Reportado'];
    const pcts       = natData.map(v => (v / total * 100).toFixed(1));

    document.getElementById('legend-nature').innerHTML =
        `<span><span class="chart-legend-bullet" style="background:#a855f7;opacity:${alphaO}"></span>Oficial: <strong>${pcts[0]}%</strong></span>` +
        `<span><span class="chart-legend-bullet" style="background:#3b82f6;opacity:${alphaP}"></span>No Oficial: <strong>${pcts[1]}%</strong></span>` +
        (nat.NR > 0 ? `<span><span class="chart-legend-bullet" style="background:#64748b;opacity:${alphaNR}"></span>NR: <strong>${pcts[2]}%</strong></span>` : '');

    makeChart('chart-nature-distribution', 'doughnut', {
        labels: natLabels,
        datasets: [{ data: natData, backgroundColor: [`rgba(168,85,247,${alphaO})`,`rgba(59,130,246,${alphaP})`,`rgba(100,116,139,${alphaNR})`], borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' }]
    }, { cutout: '75%' });
}

function renderAreaChart(data) {
    const area = { U: 0, R: 0, NR: 0 };
    data.forEach(r => { area[r.key] = r.count; });
    const total = (area.U + area.R + area.NR) || 1;

    const alphaU  = (!filters.area || filters.area === 'Urbano') ? 1 : 0.25;
    const alphaR  = (!filters.area || filters.area === 'Rural')  ? 1 : 0.25;
    const alphaNR = (!filters.area || filters.area === 'NR')     ? 1 : 0.25;

    const areaData   = [area.U, area.R, area.NR];
    const pcts       = areaData.map(v => (v / total * 100).toFixed(1));

    document.getElementById('legend-area').innerHTML =
        `<span><span class="chart-legend-bullet" style="background:#10b981;opacity:${alphaU}"></span>Urbano: <strong>${pcts[0]}%</strong></span>` +
        `<span><span class="chart-legend-bullet" style="background:#f59e0b;opacity:${alphaR}"></span>Rural: <strong>${pcts[1]}%</strong></span>` +
        (area.NR > 0 ? `<span><span class="chart-legend-bullet" style="background:#64748b;opacity:${alphaNR}"></span>NR: <strong>${pcts[2]}%</strong></span>` : '');

    makeChart('chart-area-distribution', 'doughnut', {
        labels: ['Urbano','Rural','No Reportado'],
        datasets: [{ data: areaData, backgroundColor: [`rgba(16,185,129,${alphaU})`,`rgba(245,158,11,${alphaR})`,`rgba(100,116,139,${alphaNR})`], borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' }]
    }, { cutout: '75%' });
}

function renderGenderChart(data) {
    const gen = { F: { count: 0, avg: 0 }, M: { count: 0, avg: 0 }, NR: { count: 0, avg: 0 } };
    data.forEach(r => { if (gen[r.key] !== undefined) { gen[r.key].count = r.count; gen[r.key].avg = r.avg_global || 0; } });

    const labels = [], vals = [], bgColors = [], borderColors = [];
    if (!filters.gender || filters.gender === 'Femenino') {
        labels.push(`Femenino (${gen.F.count.toLocaleString('es-CO')})`);
        vals.push(+gen.F.avg.toFixed(1));
        bgColors.push('rgba(236,72,153,0.4)'); borderColors.push('#ec4899');
    }
    if (!filters.gender || filters.gender === 'Masculino') {
        labels.push(`Masculino (${gen.M.count.toLocaleString('es-CO')})`);
        vals.push(+gen.M.avg.toFixed(1));
        bgColors.push('rgba(14,165,233,0.4)'); borderColors.push('#0ea5e9');
    }
    if (filters.gender === 'NR' || (!filters.gender && gen.NR.count > 0)) {
        labels.push(`No Reportado (${gen.NR.count.toLocaleString('es-CO')})`);
        vals.push(+gen.NR.avg.toFixed(1));
        bgColors.push('rgba(148,163,184,0.4)'); borderColors.push('#94a3b8');
    }
    makeChart('chart-gender-performance', 'bar', {
        labels,
        datasets: [{ label: 'Puntaje Global Prom.', data: vals, backgroundColor: bgColors, borderColor: borderColors, borderWidth: 1.5, borderRadius: 4, barThickness: 60 }]
    }, { scales: { x: { grid: { display: false }, ticks: { color: '#94a3b8' } }, y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#94a3b8' }, min: 180, max: 320 } } });
}

function renderStratumChart(data) {
    const str = {};
    data.forEach(r => { str[r.key] = { count: r.count, avg: r.avg_global || 0 }; });
    const labels   = ['E1','E2','E3','E4','E5','E6'];
    const scores   = labels.map((_, i) => +(str[i+1]?.avg || 0).toFixed(1));
    const counts   = labels.map((_, i) => str[i+1]?.count || 0);
    const baseColors = ['#ef4444','#f97316','#eab308','#10b981','#06b6d4','#3b82f6'];
    const highlighted = filters.stratum ? parseInt(filters.stratum) - 1 : undefined;
    const bgColors = baseColors.map((c, i) => highlighted !== undefined && i !== highlighted ? c + '22' : c + '66');
    const bdColors = baseColors.map((c, i) => highlighted !== undefined && i !== highlighted ? c + '66' : c);
    const finalLabels = labels.map((l, i) => highlighted !== undefined && i === highlighted ? `★ ${l}` : l);

    makeChart('chart-stratum-performance', 'bar', {
        labels: finalLabels,
        datasets: [{ label: 'Puntaje Global Prom.', data: scores, backgroundColor: bgColors, borderColor: bdColors, borderWidth: highlighted !== undefined ? baseColors.map((_, i) => i === highlighted ? 2 : 1) : 1, borderRadius: 4, barPercentage: 0.8 }]
    }, {
        scales: { x: { grid: { display: false }, ticks: { color: '#94a3b8' } }, y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#94a3b8' } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` Puntaje: ${ctx.raw} | Estudiantes: ${counts[ctx.dataIndex].toLocaleString('es-CO')}` } } }
    });
}

// ─── TENDENCIAS HISTÓRICAS ───────────────────────────────────────────────────
async function renderTrend() {
    const subj = filters.trend_subject;
    try {
        const rows = await apiFetch('/api/trend', buildApiFilters());
        rows.sort((a, b) => a.periodo - b.periodo);
        const labels = rows.map(r => { const y = Math.floor(r.periodo/10); const s = r.periodo%10; return `${y}-${s}`; });
        let vals;
        if (subj === 'evaluados') vals = rows.map(r => r.count);
        else vals = rows.map(r => +(r[`avg_${subj}`] || 0).toFixed(1));

        const colorMap = { global:'#a855f7', mat:'#10b981', lec:'#f97316', cna:'#06b6d4', soc:'#eab308', ing:'#ec4899', evaluados:'#0ea5e9' };
        const color = colorMap[subj] || '#a855f7';

        makeChart('chart-trend-history', 'line', {
            labels,
            datasets: [{ label: subj === 'evaluados' ? 'Evaluados' : 'Puntaje Promedio', data: vals,
                borderColor: color, backgroundColor: color + '22', fill: true, borderWidth: 2,
                pointRadius: 2, pointHoverRadius: 6, tension: 0.25 }]
        }, { scales: { x: { grid: { color: 'rgba(255,255,255,0.015)' }, ticks: { color: '#94a3b8', maxTicksLimit: 20 } }, y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#94a3b8' } } } });
    } catch(e) { console.error('renderTrend:', e); }
}

// ─── COMPARADOR MUNICIPAL ─────────────────────────────────────────────────────
async function renderMcpioCharts() {
    try {
        const apiFilters = { ...buildApiFilters(), group_by: 'mcpio' };
        const rows = await apiFetch('/api/geo', apiFilters);
        const metric = filters.mcpio_metric;
        const metricKey = metric === 'evaluados' ? 'count' : `avg_${metric}`;
        const sorted = [...rows].filter(r => r.count >= 30).sort((a, b) => (b[metricKey]||0) - (a[metricKey]||0)).slice(0, 10);

        const labels = sorted.map(r => mapping.mcpios[String(r.code)] || `Mcpio ${r.code}`);
        const vals   = sorted.map(r => +((r[metricKey] || 0).toFixed(1)));

        makeChart('chart-municipality-ranking', 'bar', {
            labels, datasets: [{ label: 'Promedio', data: vals, backgroundColor: 'rgba(16,185,129,0.4)', borderColor: '#10b981', borderWidth: 1.5, borderRadius: 4, barPercentage: 0.6 }]
        }, { indexAxis: 'y', scales: { x: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#94a3b8' } }, y: { grid: { display: false }, ticks: { color: '#94a3b8' } } } });
    } catch(e) { console.error('renderMcpioCharts:', e); }
}

async function renderMcpioTable() {
    const tbody = document.getElementById('table-municipality-body');
    tbody.innerHTML = '';
    const search = document.getElementById('input-search-mcpio').value.trim().toUpperCase();
    try {
        const apiFilters = { ...buildApiFilters(), group_by: 'mcpio' };
        const rows = await apiFetch('/api/geo', apiFilters);
        const filtered = rows
            .filter(r => {
                const name = (mapping.mcpios[String(r.code)] || '').toUpperCase();
                return !search || name.includes(search);
            })
            .sort((a, b) => (b.avg_global || 0) - (a.avg_global || 0))
            .slice(0, 120);

        if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#64748b">Sin resultados.</td></tr>'; return; }
        filtered.forEach(r => {
            const name = mapping.mcpios[String(r.code)] || `Mcpio ${r.code}`;
            const tr = document.createElement('tr');
            tr.innerHTML = `<td><strong>${name}</strong></td><td>${r.code}</td><td>${r.count.toLocaleString('es-CO')}</td><td style="color:#a855f7"><strong>${Math.round(r.avg_global||0)}</strong></td><td style="color:#10b981">${(r.avg_mat||0).toFixed(1)}</td><td style="color:#f97316">${(r.avg_lec||0).toFixed(1)}</td>`;
            tbody.appendChild(tr);
        });
    } catch(e) { console.error('renderMcpioTable:', e); }
}

// ─── CONGLOMERADOS ────────────────────────────────────────────────────────────
function renderClustersTable() {
    const tbody = document.getElementById('table-cluster-body');
    tbody.innerHTML = '';
    const cl  = clusters;
    const lv  = filters.cluster_filter;
    const lvNorm = lv === 'Bajo' ? 'Vulnerable' : lv;

    const rows = Object.entries(cl)
        .filter(([name, c]) => {
            if (name.startsWith('DEPTO_')) return false;
            return lvNorm === 'ALL' || c.lv === lvNorm;
        })
        .sort(([,a],[,b]) => b.sc - a.sc);

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#64748b">Sin resultados para este conglomerado.</td></tr>';
        return;
    }
    const badgeClass = { Alto:'badge-green', Medio:'badge-blue', Vulnerable:'badge-orange' };
    rows.forEach(([name, c]) => {
        const tr = document.createElement('tr');
        const hh    = c.hh_avg         !== undefined ? c.hh_avg.toFixed(2)         : '-';
        const f_edu = c.father_edu_avg  !== undefined ? c.father_edu_avg.toFixed(2) : '-';
        const m_edu = c.mother_edu_avg  !== undefined ? c.mother_edu_avg.toFixed(2) : '-';
        tr.innerHTML = `<td><strong>${name}</strong></td><td><span class="cluster-box-level ${badgeClass[c.lv]||'badge-orange'}">${c.lv}</span></td><td style="color:#a855f7"><strong>${c.sc}</strong></td><td>${c.po!==undefined?c.po.toFixed(1):'-'}%</td><td>${c.pr!==undefined?c.pr.toFixed(1):'-'}%</td><td>${c.ps!==undefined?c.ps.toFixed(1):'-'}%</td><td style="color:#0ea5e9">${hh}</td><td style="color:#10b981">${f_edu}</td><td style="color:#f59e0b">${m_edu}</td>`;
        tbody.appendChild(tr);
    });
}

function renderScatter() {
    const cl     = clusters;
    const xKey   = filters.scatter_x;
    const xLabels = { pr:'% Colegios en Zona Rural', po:'% Colegios Oficiales', ps:'% Estudiantes Estrato 1 y 2' };
    const datasets = { Alto:[], Medio:[], Vulnerable:[] };
    Object.entries(cl).forEach(([name, c]) => {
        if (name.startsWith('DEPTO_')) return;
        const xVal = c[xKey];
        if (xVal === undefined || xVal === null) return;
        datasets[c.lv]?.push({ x: xVal, y: c.sc, label: name });
    });
    const ds = [
        { label:'Conglomerado Alto',       data:datasets.Alto,       backgroundColor:'rgba(16,185,129,0.75)',  borderColor:'#10b981', pointRadius:6, pointHoverRadius:10 },
        { label:'Conglomerado Medio',      data:datasets.Medio,      backgroundColor:'rgba(59,130,246,0.75)',  borderColor:'#3b82f6', pointRadius:6, pointHoverRadius:10 },
        { label:'Conglomerado Vulnerable', data:datasets.Vulnerable, backgroundColor:'rgba(249,115,22,0.75)',  borderColor:'#f97316', pointRadius:6, pointHoverRadius:10 }
    ];
    makeChart('chart-cluster-scatter', 'scatter', { datasets: ds }, {
        plugins: {
            legend: { display:true, labels:{color:'#94a3b8'} },
            tooltip: { callbacks: { label: ctx => ` ${ctx.raw.label}: (${xLabels[xKey]}: ${ctx.raw.x.toFixed(1)}%, Global: ${Math.round(ctx.raw.y)})` } }
        },
        scales: {
            x: { title:{display:true,text:xLabels[xKey]||'',color:'#94a3b8'}, grid:{color:'rgba(255,255,255,0.015)'}, ticks:{color:'#94a3b8'} },
            y: { title:{display:true,text:'Puntaje Global Promedio',color:'#94a3b8'}, grid:{color:'rgba(255,255,255,0.03)'}, ticks:{color:'#94a3b8'} }
        }
    });
}

// ─── UTILIDADES ──────────────────────────────────────────────────────────────
function makeChart(id, type, data, options={}) {
    if (charts[id]) { charts[id].destroy(); }
    const ctx = document.getElementById(id).getContext('2d');
    charts[id] = new Chart(ctx, { type, data, options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, ...options } });
}

// ─── TABS ─────────────────────────────────────────────────────────────────────
function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
            btn.classList.add('active');
            const tab = btn.dataset.tab;
            document.getElementById(`view-${tab}`).classList.add('active');
            if (tab === 'resumen' && map) setTimeout(() => map.invalidateSize(), 100);
            Object.values(charts).forEach(c => { try { c.resize(); } catch(_){} });
        });
    });
}

function setupClusterButtons() {
    document.querySelectorAll('.btn-cluster-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-cluster-filter').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filters.cluster_filter = btn.dataset.level;
            renderClustersTable();
            updateFilterSummaries();
        });
    });
}
