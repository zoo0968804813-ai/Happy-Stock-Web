const state = {
  stocks: [],
  selectedSymbol: null,
  selectedStock: null,
  stockDetail: null,
  refreshSeconds: 15,
  compareSymbols: new Set(),
  intradayChart: null,
  compareChart: null,
  holderDistChart: null,
  currentChart: 'intraday',
};

const $ = (id) => document.getElementById(id);

function fmtInt(value) {
  return Math.round(Number(value || 0)).toLocaleString('zh-TW');
}

function fmtShares(n) {
  const value = Number(n || 0);

  if (value >= 100000000) return `${(value / 100000000).toFixed(2)}億股`;
  if (value >= 10000) return `${(value / 10000).toFixed(2)}萬股`;

  return `${Math.round(value).toLocaleString('zh-TW')}股`;
}

function fmtHolderPct(n) {
  return `${Number(n || 0).toFixed(4)}%`;
}

function fmtPrice(value) {
  return Number(value || 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 });
}

function fmtPct(value) {
  const n = Number(value || 0);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtDateTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString('zh-TW', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function changeClass(value) {
  const n = Number(value || 0);
  if (n > 0) return 'up-text';
  if (n < 0) return 'down-text';
  return 'flat-text';
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${url} ${res.status}: ${text}`);
  }
  return res.json();
}

async function loadConfig() {
  try {
    const config = await fetchJson('/api/config');
    state.refreshSeconds = Number(config.refreshSeconds || 15);
  } catch (_) {}
}

async function loadHolderDistribution(symbol) {
  const statusEl = document.getElementById('holderDistStatus');
  const summaryEl = document.getElementById('holderDistSummary');
  const rowsEl = document.getElementById('holderDistRows');

  if (!symbol) return;

  try {
    if (statusEl) statusEl.textContent = '讀取中...';

    const res = await fetch(`/api/stocks/${encodeURIComponent(symbol)}/holders`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    renderHolderDistribution(data);

    if (statusEl) statusEl.textContent = '已更新';
  } catch (err) {
    console.error('loadHolderDistribution failed:', err);

    if (statusEl) statusEl.textContent = '讀取失敗';
    if (summaryEl) summaryEl.textContent = '籌碼分布讀取失敗，請稍後再試。';
    if (rowsEl) {
      rowsEl.innerHTML = '<tr><td colspan="3">讀取失敗</td></tr>';
    }
  }
}

async function loadMarket() {
  const data = await fetchJson('/api/market');
  state.stocks = data.stocks || [];

  renderSummary(data.summary || {});
  renderStockList();

  if (!state.selectedSymbol && state.stocks.length) {
    state.selectedSymbol = state.stocks[0].symbol;
  }

  if (state.selectedSymbol) {
    const existing = state.stocks.find((s) => s.symbol === state.selectedSymbol);
    if (existing) {
      state.selectedStock = existing;
    }
    await loadStockDetail(state.selectedSymbol);
  }

  $('lastUpdated').textContent = `最後更新：${new Date().toLocaleTimeString('zh-TW', { hour12: false })}`;
  document.querySelector('.status-title').textContent = '即時連線中';
}

function renderSummary(summary) {
  $('stockCount').textContent = fmtInt(summary.count || 0);
  $('marketCap').textContent = fmtInt(summary.totalMarketCap || 0);
  $('upDownCount').textContent = `${fmtInt(summary.upCount || 0)} / ${fmtInt(summary.downCount || 0)}`;

  const strongest = summary.strongest ? `${summary.strongest.symbol} ${fmtPct(summary.strongest.change_pct)}` : '--';
  const weakest = summary.weakest ? `${summary.weakest.symbol} ${fmtPct(summary.weakest.change_pct)}` : '--';
  $('strongWeak').innerHTML = `
    <span class="strong-weak-line strong-line">${strongest}</span>
    <span class="strong-weak-line weak-line">${weakest}</span>
  `;
}

function renderHolderDistribution(data) {
  const summaryEl = document.getElementById('holderDistSummary');
  const rowsEl = document.getElementById('holderDistRows');
  const canvas = document.getElementById('holderDistChart');

  if (!data || !data.summary) return;

  const summary = data.summary;
  const marketHolders = Array.isArray(data.market_holders) ? data.market_holders : [];
  const players = Array.isArray(data.players) ? data.players : [];

  const rows = [];

  if (Number(summary.player_shares || 0) > 0) {
    rows.push({
      name: '玩家合計',
      shares: Number(summary.player_shares || 0),
      pct: Number(summary.player_pct || 0),
    });
  }

  for (const holder of marketHolders) {
    rows.push({
      name: holder.holder_name,
      shares: Number(holder.shares || 0),
      pct: Number(holder.holding_pct || 0),
    });
  }

  if (Number(summary.unallocated_shares || 0) > 0) {
    rows.push({
      name: '未分配',
      shares: Number(summary.unallocated_shares || 0),
      pct: data.stock.total_shares > 0
        ? (Number(summary.unallocated_shares || 0) / Number(data.stock.total_shares || 1)) * 100
        : 0,
    });
  }

  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="holder-summary-grid">
        <div>
          <span>總發行股數</span>
          <strong>${fmtShares(summary.total_shares)}</strong>
        </div>
        <div>
          <span>玩家持股</span>
          <strong>${fmtShares(summary.player_shares)}｜${fmtHolderPct(summary.player_pct)}</strong>
        </div>
        <div>
          <span>市場池持股</span>
          <strong>${fmtShares(summary.market_shares)}｜${fmtHolderPct(summary.market_pct)}</strong>
        </div>
        <div>
          <span>分配狀態</span>
          <strong class="${summary.is_valid ? 'ok-text' : 'bad-text'}">
            ${summary.is_valid ? '正常' : `超額 ${fmtShares(summary.over_allocated_shares)}`}
          </strong>
        </div>
      </div>
    `;
  }

  if (rowsEl) {
    rowsEl.innerHTML = rows.length
      ? rows.map((row) => `
        <tr>
          <td>${row.name}</td>
          <td>${fmtShares(row.shares)}</td>
          <td>${fmtHolderPct(row.pct)}</td>
        </tr>
      `).join('')
      : '<tr><td colspan="3">尚無籌碼資料</td></tr>';
  }

  if (canvas && window.Chart) {
    const chartRows = rows.filter((row) => row.shares > 0);

    if (state.holderDistChart) {
      state.holderDistChart.destroy();
      state.holderDistChart = null;
    }

    state.holderDistChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: chartRows.map((row) => row.name),
        datasets: [{
          data: chartRows.map((row) => row.shares),
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
          },
          tooltip: {
            callbacks: {
              label(context) {
                const value = Number(context.raw || 0);
                const total = chartRows.reduce((sum, row) => sum + row.shares, 0);
                const pct = total > 0 ? (value / total) * 100 : 0;
                return `${context.label}: ${fmtShares(value)}｜${fmtHolderPct(pct)}`;
              },
            },
          },
        },
      },
    });
  }
}

function getFilteredStocks() {
  const keyword = $('searchInput').value.trim().toLowerCase();
  const sort = $('sortSelect').value;

  let rows = state.stocks.filter((s) => {
    if (!keyword) return true;
    return [
      s.symbol,
      s.name,
      s.sector,
      s.description,
    ].join(' ').toLowerCase().includes(keyword);
  });

  rows = [...rows].sort((a, b) => {
    if (sort === 'change_desc') return Number(b.change_pct || 0) - Number(a.change_pct || 0);
    if (sort === 'change_asc') return Number(a.change_pct || 0) - Number(b.change_pct || 0);
    if (sort === 'volume_desc') return Number(b.today_volume || 0) - Number(a.today_volume || 0);
    if (sort === 'price_desc') return Number(b.price || 0) - Number(a.price || 0);
    return String(a.symbol).localeCompare(String(b.symbol));
  });

  return rows;
}

function renderStockList() {
  const list = $('stockList');
  const rows = getFilteredStocks();

  if (!rows.length) {
    list.innerHTML = '<div class="empty">找不到股票</div>';
    return;
  }

  list.innerHTML = rows.map((s) => {
    const active = s.symbol === state.selectedSymbol ? 'active' : '';
    const checked = state.compareSymbols.has(s.symbol) ? 'checked' : '';
    const cls = changeClass(s.change_pct);

    return `
      <div class="stock-item ${active}" data-symbol="${s.symbol}">
        <div class="stock-main">
          <div>
            <strong>${s.symbol}</strong>
            <span>${escapeHtml(s.name)}</span>
          </div>
          <label class="compare-check" title="加入比較">
            <input type="checkbox" data-compare="${s.symbol}" ${checked} />
            比較
          </label>
        </div>
        <div class="stock-meta">
          <span>${escapeHtml(s.sector)}</span>
          <span>${fmtPrice(s.price)}</span>
          <span class="${cls}">${fmtPct(s.change_pct)}</span>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.stock-item').forEach((item) => {
    item.addEventListener('click', async (event) => {
      if (event.target.matches('input[type="checkbox"]')) return;
      state.selectedSymbol = item.dataset.symbol;
      renderStockList();
      await loadStockDetail(state.selectedSymbol);
    });
  });

  list.querySelectorAll('input[data-compare]').forEach((input) => {
    input.addEventListener('change', async (event) => {
      const symbol = event.target.dataset.compare;
      if (event.target.checked) {
        if (state.compareSymbols.size >= 5) {
          event.target.checked = false;
          alert('最多同時比較 5 支股票。');
          return;
        }
        state.compareSymbols.add(symbol);
      } else {
        state.compareSymbols.delete(symbol);
      }

      if (state.currentChart === 'compare') {
        await loadCompareChart();
      }
    });
  });
}

async function loadStockDetail(symbol) {
  const data = await fetchJson(`/api/stocks/${encodeURIComponent(symbol)}`);
  state.stockDetail = data;
  state.selectedStock = data.stock;

  renderStockDetail(data);

  await Promise.all([
    loadIntradayChart(symbol),
    loadCandles(symbol),
    loadHolderDistribution(symbol),
    loadNews(),
    loadListings(),
  ]);

  if (state.currentChart === 'compare') {
    await loadCompareChart();
  }
}

function renderStockDetail(data) {
  const s = data.stock;
  const cls = changeClass(s.change_pct);

  $('detailSector').textContent = s.sector || '--';
  $('detailTitle').textContent = `${s.symbol}｜${s.name}`;
  $('detailDescription').textContent = s.description || '沒有股票說明。';
  $('detailPrice').textContent = fmtPrice(s.price);
  $('detailChange').textContent = `${fmtPrice(s.change)} / ${fmtPct(s.change_pct)}`;
  $('detailChange').className = cls;
  $('detailOpen').textContent = fmtPrice(s.open_price);
  $('detailHigh').textContent = fmtPrice(s.high_price);
  $('detailLow').textContent = fmtPrice(s.low_price);
  $('detailFair').textContent = fmtPrice(s.fair_price);
  $('detailVolume').textContent = fmtInt(data.todayTrades?.volume || 0);
  $('detailLimit').textContent = `±${fmtPrice(s.daily_limit_pct)}%`;

  const f = data.flows || {};
  $('flowBox').innerHTML = `
    <div><span>外資</span><strong>${signed(f.foreign_net_value)}</strong></div>
    <div><span>投信</span><strong>${signed(f.trust_net_value)}</strong></div>
    <div><span>自營商</span><strong>${signed(f.dealer_net_value)}</strong></div>
    <div><span>主力</span><strong>${signed(f.main_player_net_value)}</strong></div>
    <div><span>散戶</span><strong>${signed(f.retail_net_value)}</strong></div>
  `;

  const holders = data.holders || [];
  const holderHtml = holders.length
    ? holders.slice(0, 3).map((h, index) => (
      `<div><span>${index + 1}. ${escapeHtml(h.username)}</span><strong>${fmtInt(h.amount)} 股｜${Number(h.holding_pct || 0).toFixed(4)}%</strong></div>`
    )).join('')
    : '<div><span>持有人</span><strong>目前無資料</strong></div>';

  const dividend = data.dividend || {};
  const latest = dividend.latestRun;
  const dividendPool = latest ? latest.dividend_pool : 0;

  $('holderDividendBox').innerHTML = `
    ${holderHtml}
    <hr />
    <div><span>近 7 日收益</span><strong>${fmtInt(dividend.recentRevenue || 0)}</strong></div>
    <div><span>上次配息</span><strong>${latest ? fmtInt(latest.total_paid) : '尚無'}</strong></div>
    <div><span>股利池</span><strong>${fmtInt(dividendPool)}</strong></div>
  `;
}

function signed(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? '+' : ''}${fmtInt(n)}`;
}

async function loadIntradayChart(symbol) {
  const data = await fetchJson(`/api/stocks/${encodeURIComponent(symbol)}/intraday`);
  const points = data.points || [];

  const labels = points.map((p) => new Date(p.created_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }));
  const prices = points.map((p) => Number(p.price));
  const openPrice = Number(data.openPrice || 0);

  const ctx = $('intradayChart');

  if (state.intradayChart) {
    state.intradayChart.destroy();
  }

  state.intradayChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `${symbol} 單日即時`,
          data: prices,
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 2,
          segment: {
            borderColor: (context) => {
              const value = context.p1.parsed.y;
              return value >= openPrice ? '#ff5b6e' : '#2dd4bf';
            },
          },
        },
        {
          label: '開盤價',
          data: prices.map(() => openPrice),
          borderDash: [6, 6],
          borderWidth: 1,
          pointRadius: 0,
        },
      ],
    },
    options: baseChartOptions('價格'),
  });
}

async function loadCandles(symbol) {
  const data = await fetchJson(`/api/stocks/${encodeURIComponent(symbol)}/candles`);
  drawCandles(data.candles || []);
}

function drawCandles(candles) {
  const canvas = $('candlesCanvas');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, width, height);

  const pad = { left: 56, right: 20, top: 28, bottom: 48 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  if (!candles.length) {
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('尚無 K 線資料', 24, 40);
    return;
  }

  const max = Math.max(...candles.map((c) => Number(c.high)));
  const min = Math.min(...candles.map((c) => Number(c.low)));
  const range = Math.max(max - min, 0.01);

  const y = (price) => pad.top + (max - price) / range * chartH;
  const slots = 30;
  const startIndex = Math.max(0, slots - candles.length);
  const slotW = chartW / slots;

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const yy = pad.top + chartH * i / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(width - pad.right, yy);
    ctx.stroke();

    const price = max - range * i / 4;
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px system-ui';
    ctx.fillText(fmtPrice(price), 8, yy + 4);
  }

  candles.forEach((c, i) => {
    const index = startIndex + i;
    const x = pad.left + index * slotW + slotW / 2;
    const open = Number(c.open);
    const close = Number(c.close);
    const high = Number(c.high);
    const low = Number(c.low);
    const up = close >= open;
    const color = up ? '#ff5b6e' : '#2dd4bf';

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(x, y(high));
    ctx.lineTo(x, y(low));
    ctx.stroke();

    const bodyTop = Math.min(y(open), y(close));
    const bodyH = Math.max(Math.abs(y(open) - y(close)), 2);
    const bodyW = Math.max(6, Math.min(18, slotW * 0.55));
    ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);

    if (i === candles.length - 1 || i % 5 === 0) {
      const label = new Date(c.open_time).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' });
      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px system-ui';
      ctx.fillText(label, x - 16, height - 20);
    }
  });
}

async function loadCompareChart() {
  const symbols = [...state.compareSymbols];

  if (!symbols.length && state.selectedSymbol) {
    symbols.push(state.selectedSymbol);
  }

  if (!symbols.length) return;

  const data = await fetchJson(`/api/compare?symbols=${symbols.join(',')}`);

  const grouped = new Map();
  for (const row of data.series || []) {
    if (!grouped.has(row.symbol)) grouped.set(row.symbol, []);
    grouped.get(row.symbol).push(row);
  }

  const labels = [];
  const labelSet = new Set();
  for (const rows of grouped.values()) {
    rows.forEach((r) => {
      const label = new Date(r.created_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
      if (!labelSet.has(label)) {
        labelSet.add(label);
        labels.push(label);
      }
    });
  }

  const datasets = [...grouped.entries()].map(([symbol, rows]) => {
    const first = Number(rows[0]?.price || 0);
    const byLabel = new Map(rows.map((r) => [
      new Date(r.created_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }),
      first > 0 ? ((Number(r.price) - first) / first) * 100 : 0,
    ]));

    return {
      label: symbol,
      data: labels.map((label) => byLabel.get(label) ?? null),
      borderWidth: 2,
      pointRadius: 1,
      tension: 0.25,
      spanGaps: true,
    };
  });

  if (state.compareChart) {
    state.compareChart.destroy();
  }

  state.compareChart = new Chart($('compareChart'), {
    type: 'line',
    data: { labels, datasets },
    options: baseChartOptions('百分比變化 %'),
  });
}

function baseChartOptions(yTitle) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        labels: {
          color: '#cbd5e1',
        },
      },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.95)',
        borderColor: 'rgba(148, 163, 184, 0.3)',
        borderWidth: 1,
      },
    },
    scales: {
      x: {
        ticks: { color: '#94a3b8', maxTicksLimit: 8 },
        grid: { color: 'rgba(148, 163, 184, 0.12)' },
      },
      y: {
        title: { display: true, text: yTitle, color: '#94a3b8' },
        ticks: { color: '#94a3b8' },
        grid: { color: 'rgba(148, 163, 184, 0.12)' },
      },
    },
  };
}

async function loadNews() {
  const data = await fetchJson('/api/news?limit=12');
  const news = data.news || [];

  $('newsBox').innerHTML = news.length
    ? news.map((n) => `
      <div class="news-item">
        <strong>${escapeHtml(n.title)}</strong>
        <span>${n.symbol || n.event_type || ''}｜${fmtDateTime(n.created_at)}</span>
        <p>${escapeHtml(n.description || '')}</p>
      </div>
    `).join('')
    : '<div class="empty">目前沒有事件。</div>';
}

async function loadListings() {
  const data = await fetchJson('/api/listings');
  const listings = data.listings || [];

  $('listingBox').innerHTML = listings.length
    ? listings.slice(0, 5).map((app) => `
      <div>
        <span>#${app.id} ${escapeHtml(app.symbol)} ${escapeHtml(app.name)}</span>
        <strong>${formatListingStatus(app.status)}</strong>
      </div>
    `).join('')
    : '<div><span>融資上市</span><strong>目前無資料</strong></div>';
}

function formatListingStatus(status) {
  const map = {
    PENDING: '待審核',
    REJECTED: '已駁回',
    FUNDING: '融資中',
    LISTED: '已上市',
    CANCELLED: '已取消',
  };
  return map[status] || status || '--';
}

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', async () => {
      document.querySelectorAll('.tab').forEach((btn) => btn.classList.remove('active'));
      button.classList.add('active');

      state.currentChart = button.dataset.chart;

      $('intradayPanel').classList.toggle('hidden', state.currentChart !== 'intraday');
      $('candlesPanel').classList.toggle('hidden', state.currentChart !== 'candles');
      $('comparePanel').classList.toggle('hidden', state.currentChart !== 'compare');

      if (state.currentChart === 'compare') {
        await loadCompareChart();
      }

      if (state.currentChart === 'candles' && state.selectedSymbol) {
        await loadCandles(state.selectedSymbol);
      }
    });
  });
}

function setupControls() {
  $('searchInput').addEventListener('input', renderStockList);
  $('sortSelect').addEventListener('change', renderStockList);
}

async function boot() {
  setupTabs();
  setupControls();
  await loadConfig();
  await loadMarket();

  setInterval(async () => {
    try {
      await loadMarket();
    } catch (err) {
      console.error(err);
      document.querySelector('.status-title').textContent = '資料讀取失敗';
      $('lastUpdated').textContent = err.message;
    }
  }, Math.max(5, state.refreshSeconds) * 1000);
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre class="fatal">${escapeHtml(err.message)}</pre>`;
});
