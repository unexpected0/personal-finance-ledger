let records = [];
let ledgerSettings = { openingBalance: null, payDay: 7, payMonthOffset: 1 };
let selectedMonth = '';
let isDirty = false;
let toastTimer;
let saveTimer;
let saveRetryCount = 0;
let expandedChartKey = null;
let lastChartTrigger = null;

const FILE_PREVIEW = window.location.protocol === 'file:';

const DATA_VERSION = 2;
const MONEY_FIELDS = [
  'grossIncome', 'allowance', 'personalSocial', 'personalFund',
  'companyFund', 'tax', 'otherDeduction', 'netIncome', 'balance', 'adjustment'
];

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const money = (value, digits = 2) => value == null || !Number.isFinite(value)
  ? '—'
  : new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const signedMoney = value => value == null ? '—' : `${value >= 0 ? '+' : '−'}${money(Math.abs(value))}`;
const monthLabel = month => {
  const [year, number] = month.split('-');
  return `${year} 年 ${number} 月`;
};
const shortMonth = month => `${Number(month.split('-')[1])}月`;
const numberValue = (form, name) => Number(form.elements[name].value || 0);
const roundMoney = value => Math.round((value + Number.EPSILON) * 100) / 100;

function paymentDate(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(year, monthNumber - 1 + ledgerSettings.payMonthOffset, ledgerSettings.payDay);
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return {
    iso,
    label: `${date.getFullYear()} 年 ${String(date.getMonth() + 1).padStart(2, '0')} 月 ${String(date.getDate()).padStart(2, '0')} 日`
  };
}

function sortRecords() {
  records.sort((a, b) => a.month.localeCompare(b.month));
}

function calculatePayroll(record) {
  const calculatedNet = roundMoney(record.grossIncome
    - record.personalSocial
    - record.personalFund
    - record.tax
    - record.otherDeduction);
  return {
    calculatedNet,
    payrollDifference: roundMoney(record.netIncome - calculatedNet),
    fundTotal: roundMoney(record.personalFund + record.companyFund)
  };
}

function calculateCashflow(record, previous) {
  const previousBalance = previous?.balance ?? ledgerSettings.openingBalance;
  if (!Number.isFinite(previousBalance)) return { saving: null, expense: null, savingRate: null };
  const saving = roundMoney(record.balance - previousBalance);
  const expense = roundMoney(previousBalance + record.netIncome + record.adjustment - record.balance);
  return {
    saving,
    expense,
    savingRate: record.netIncome ? saving / record.netIncome * 100 : null
  };
}

function derivedAt(index) {
  const record = records[index];
  const previous = records[index - 1];
  return { ...calculatePayroll(record), ...calculateCashflow(record, previous) };
}

function percentChange(current, previous) {
  if (current == null || previous == null || previous === 0) return null;
  return (current - previous) / Math.abs(previous) * 100;
}

function changeText(value, prefix = '较上月') {
  if (value == null || !Number.isFinite(value)) return `${prefix} 暂无数据`;
  return `${prefix} ${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function setStatus(text, saved = false) {
  const status = $('#fileStatus');
  status.classList.toggle('saved', saved);
  status.querySelector('span').textContent = text;
}

function markDirty() {
  isDirty = true;
  saveRetryCount = 0;
  setStatus('有修改 · 正在自动保存');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveData, 450);
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function render() {
  sortRecords();
  if (!records.some(record => record.month === selectedMonth)) selectedMonth = records.at(-1)?.month || '';
  renderOverview();
  renderTable();
  requestAnimationFrame(drawAllCharts);
}

function renderOverview() {
  const isEmpty = records.length === 0;
  $('#emptyState').hidden = !isEmpty;
  $('#overviewHeading').hidden = isEmpty;
  $('#metricGrid').hidden = isEmpty;
  $('#trends').hidden = isEmpty;
  $('#records').hidden = isEmpty;
  if (isEmpty) return;
  const index = records.findIndex(record => record.month === selectedMonth);
  const record = records[index];
  const previous = records[index - 1];
  const current = derivedAt(index);
  const previousDerived = previous ? derivedAt(index - 1) : null;

  $('#selectedMonthTitle').textContent = monthLabel(record.month);
  $('#selectedMonthMeta').textContent = `工资于 ${paymentDate(record.month).label}发放 · 余额记录于到账后`;
  $('#prevMonth').disabled = index <= 0;
  $('#nextMonth').disabled = index >= records.length - 1;
  $('#metricNet').textContent = money(record.netIncome);
  $('#metricNetChange').textContent = changeText(previous ? percentChange(record.netIncome, previous.netIncome) : null);
  $('#metricExpense').textContent = money(current.expense);
  $('#metricExpenseChange').textContent = changeText(previousDerived ? percentChange(current.expense, previousDerived.expense) : null);
  $('#metricSaving').textContent = signedMoney(current.saving);
  $('#metricSaving').className = current.saving < 0 ? 'negative' : '';
  $('#metricRate').textContent = current.savingRate == null ? '储蓄率 —' : `储蓄率 ${current.savingRate.toFixed(1)}%`;
  $('#savingProgress').style.width = `${Math.max(0, Math.min(100, current.savingRate || 0))}%`;
  $('#metricBalance').textContent = money(record.balance);
  const previousBalance = previous?.balance ?? ledgerSettings.openingBalance;
  $('#metricBalanceChange').textContent = changeText(percentChange(record.balance, previousBalance), index === 0 ? '较期初' : '较上月');
  $('#metricTax').textContent = money(record.tax);
  $('#metricTaxRate').textContent = `占税前收入 ${(record.tax / record.grossIncome * 100).toFixed(1)}%`;
  $('#metricFund').textContent = money(current.fundTotal);
  $('#metricFundSplit').textContent = `个人 ${money(record.personalFund, 0)} · 公司 ${money(record.companyFund, 0)}`;

  $('#breakGross').textContent = money(record.grossIncome, 0);
  $('#breakNet').textContent = money(record.netIncome);
  $('#breakSocial').textContent = money(record.personalSocial);
  $('#breakFund').textContent = money(record.personalFund);
  $('#breakOther').textContent = money(record.tax + record.otherDeduction);
  const parts = [record.netIncome, record.personalSocial, record.personalFund, record.tax + record.otherDeduction];
  ['#barNet', '#barSocial', '#barFund', '#barOther'].forEach((selector, partIndex) => {
    $(selector).style.width = `${Math.max(0, parts[partIndex] / record.grossIncome * 100)}%`;
  });
}

function renderTable() {
  const body = $('#recordsBody');
  body.innerHTML = records.map((record, index) => {
    const data = derivedAt(index);
    return `<tr class="${record.month === selectedMonth ? 'selected' : ''}" data-month="${record.month}">
      <td class="month-cell">${record.month}<small>发薪 ${paymentDate(record.month).iso.slice(5)}${record.note ? ` · ${record.note}` : ''}</small></td>
      <td>${money(record.grossIncome)}</td>
      <td>${money(record.netIncome)}</td>
      <td>${money(data.expense)}</td>
      <td class="${data.saving == null ? '' : data.saving >= 0 ? 'positive' : 'negative'}">${signedMoney(data.saving)}</td>
      <td>${money(record.balance)}</td>
      <td>${data.savingRate == null ? '—' : `${data.savingRate.toFixed(1)}%`}</td>
      <td><button class="row-action" type="button" data-edit="${record.month}" ${FILE_PREVIEW ? 'disabled title="双击 HTML 为只读预览，请通过本地服务编辑"' : ''}>编辑</button></td>
    </tr>`;
  }).join('');

  body.querySelectorAll('tr').forEach(row => row.addEventListener('click', event => {
    if (event.target.closest('[data-edit]')) return;
    selectedMonth = row.dataset.month;
    render();
    document.querySelector('#overview').scrollIntoView({ behavior: 'smooth' });
  }));
  body.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => openDrawer(button.dataset.edit)));
}

function openDrawer(month) {
  const form = $('#recordForm');
  form.reset();
  const record = records.find(item => item.month === month);
  $('#drawerTitle').textContent = record ? `编辑 ${monthLabel(month)}` : '记录本月';
  $('#deleteRecord').hidden = !record;
  if (record) {
    Object.entries(record).forEach(([key, value]) => {
      if (form.elements[key]) form.elements[key].value = value;
    });
    form.elements.editingMonth.value = month;
  } else {
    const last = records.at(-1);
    const nextDate = last ? new Date(`${last.month}-01T00:00:00`) : new Date();
    if (last) nextDate.setMonth(nextDate.getMonth() + 1);
    form.elements.month.value = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}`;
    ['allowance', 'personalSocial', 'personalFund', 'companyFund', 'otherDeduction'].forEach(name => {
      form.elements[name].value = last?.[name] ?? 0;
    });
    form.elements.adjustment.value = 0;
    form.elements.editingMonth.value = '';
  }
  updateFormPreview();
  $('#drawerBackdrop').hidden = false;
  $('#recordDrawer').classList.add('open');
  $('#recordDrawer').setAttribute('aria-hidden', 'false');
  setTimeout(() => form.elements.month.focus(), 250);
}

function closeDrawer() {
  $('#recordDrawer').classList.remove('open');
  $('#recordDrawer').setAttribute('aria-hidden', 'true');
  setTimeout(() => { $('#drawerBackdrop').hidden = true; }, 250);
}

function updateFormPreview() {
  const payroll = calculatePayroll(readFormRecord());
  const values = [money(payroll.calculatedNet), signedMoney(payroll.payrollDifference), money(payroll.fundTotal)];
  $$('#formPreview strong').forEach((element, index) => {
    element.textContent = values[index];
    element.className = index === 1 && Math.abs(payroll.payrollDifference) > .01 ? 'negative' : '';
  });
}

function readFormRecord() {
  const form = $('#recordForm');
  return {
    month: form.elements.month.value,
    grossIncome: numberValue(form, 'grossIncome'),
    allowance: numberValue(form, 'allowance'),
    personalSocial: numberValue(form, 'personalSocial'),
    personalFund: numberValue(form, 'personalFund'),
    companyFund: numberValue(form, 'companyFund'),
    tax: numberValue(form, 'tax'),
    otherDeduction: numberValue(form, 'otherDeduction'),
    netIncome: numberValue(form, 'netIncome'),
    balance: numberValue(form, 'balance'),
    adjustment: numberValue(form, 'adjustment'),
    note: form.elements.note.value.trim()
  };
}

function saveForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const record = readFormRecord();
  const editingMonth = form.elements.editingMonth.value;
  const duplicate = records.some(item => item.month === record.month && item.month !== editingMonth);
  if (duplicate) return showToast('这个月份已经存在，请直接编辑原记录。');
  const index = records.findIndex(item => item.month === editingMonth);
  if (index >= 0) records[index] = record;
  else records.push(record);
  selectedMonth = record.month;
  markDirty();
  render();
  closeDrawer();
  showToast(index >= 0 ? '月度记录已更新' : '新月份已加入账本');
}

function deleteCurrentRecord() {
  const month = $('#recordForm').elements.editingMonth.value;
  if (!month || !confirm(`确定删除 ${monthLabel(month)} 的记录吗？`)) return;
  records = records.filter(record => record.month !== month);
  selectedMonth = records.at(-1)?.month || '';
  markDirty();
  render();
  closeDrawer();
  showToast('记录已删除');
}

function serializeData() {
  return JSON.stringify({ version: DATA_VERSION, currency: 'CNY', settings: ledgerSettings, updatedAt: new Date().toISOString(), records }, null, 2);
}

function validateImportedData(data) {
  if (!data || !Array.isArray(data.records)) throw new Error('文件中没有有效的月度记录');
  if (data.version && data.version > DATA_VERSION) throw new Error('账本版本较新，请升级应用后再打开');
  const settings = {
    openingBalance: data.settings?.openingBalance == null ? null : Number(data.settings.openingBalance),
    payDay: Number(data.settings?.payDay ?? 7),
    payMonthOffset: Number(data.settings?.payMonthOffset ?? 1)
  };
  if (settings.openingBalance != null && (!Number.isFinite(settings.openingBalance) || settings.openingBalance < 0)) throw new Error('期初余额无效');
  if (!Number.isInteger(settings.payDay) || settings.payDay < 1 || settings.payDay > 28) throw new Error('发薪日必须在 1 至 28 日之间');
  if (!Number.isInteger(settings.payMonthOffset) || settings.payMonthOffset < 0 || settings.payMonthOffset > 2) throw new Error('发薪月份偏移无效');
  const seenMonths = new Set();
  const normalized = data.records.map((source, index) => {
    if (!source || typeof source !== 'object') throw new Error(`第 ${index + 1} 条记录格式错误`);
    const record = {
      allowance: 0, personalSocial: 0, personalFund: 0, companyFund: 0,
      tax: 0, otherDeduction: 0, adjustment: 0, note: '', ...source
    };
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(record.month || '')) throw new Error(`第 ${index + 1} 条记录的月份无效`);
    if (seenMonths.has(record.month)) throw new Error(`月份 ${record.month} 存在重复记录`);
    seenMonths.add(record.month);
    MONEY_FIELDS.forEach(field => {
      record[field] = Number(record[field]);
      if (!Number.isFinite(record[field])) throw new Error(`${record.month} 的金额字段 ${field} 无效`);
      if (field !== 'adjustment' && record[field] < 0) throw new Error(`${record.month} 的金额不能为负数`);
    });
    if (record.allowance > record.grossIncome) throw new Error(`${record.month} 的补贴不能大于税前收入`);
    record.note = String(record.note || '').slice(0, 100);
    return record;
  });
  return { records: normalized, settings };
}

async function saveData() {
  try {
    clearTimeout(saveTimer);
    const response = await fetch('/api/ledger', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: serializeData()
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `保存接口返回 ${response.status}`);
    }
    isDirty = false;
    saveRetryCount = 0;
    setStatus('data/personal-finance-ledger.json · 已保存', true);
  } catch (error) {
    isDirty = true;
    if (saveRetryCount < 3) {
      saveRetryCount += 1;
      setStatus(`自动保存失败 · 正在重试 ${saveRetryCount}/3`);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveData, 1200 * saveRetryCount);
      return;
    }
    setStatus('自动保存失败 · 修改仍在页面中');
    showToast(`保存失败：${error.message}`);
  }
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportCsv() {
  const header = ['工资月份','实际发薪日','税前收入','其中补贴','个人社保','个人公积金','公司公积金','个人所得税','其他扣款','实发工资','推算支出','存款变化','发薪后余额','储蓄率','备注'];
  const rows = records.map((record, index) => {
    const data = derivedAt(index);
    return [record.month, paymentDate(record.month).iso, record.grossIncome, record.allowance, record.personalSocial, record.personalFund, record.companyFund, record.tax, record.otherDeduction, record.netIncome, data.expense ?? '', data.saving ?? '', record.balance, data.savingRate == null ? '' : data.savingRate.toFixed(2), `"${(record.note || '').replaceAll('"','""')}"`].join(',');
  });
  downloadBlob(`\ufeff${[header.join(','), ...rows].join('\n')}`, '月度账本.csv', 'text/csv;charset=utf-8');
  showToast('CSV 已导出');
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function roundedValue(value) {
  if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(value % 10000 ? 1 : 0)}万`;
  return Math.round(value).toLocaleString('zh-CN');
}

function drawLineChart(canvas, series, options = {}) {
  const { context: ctx, width, height } = setupCanvas(canvas);
  if (!width || !height || !records.length) return;
  const pad = { left: 62, right: 22, top: 18, bottom: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const values = series.flatMap(item => item.values.filter(value => value != null && Number.isFinite(value)));
  let min = options.zeroBase ? 0 : Math.min(...values);
  let max = Math.max(...values);
  const range = Math.max(1, max - min);
  if (!options.zeroBase) min -= range * .12;
  max += range * .12;
  const span = Math.max(1, max - min);
  const x = index => pad.left + (records.length === 1 ? plotW / 2 : index / (records.length - 1) * plotW);
  const y = value => pad.top + (max - value) / span * plotH;

  ctx.clearRect(0, 0, width, height);
  ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  for (let line = 0; line <= 4; line++) {
    const py = pad.top + plotH * line / 4;
    const value = max - span * line / 4;
    ctx.beginPath();
    ctx.strokeStyle = '#e9ede9';
    ctx.lineWidth = 1;
    ctx.moveTo(pad.left, py);
    ctx.lineTo(width - pad.right, py);
    ctx.stroke();
    ctx.fillStyle = '#747477';
    ctx.textAlign = 'right';
    ctx.fillText(roundedValue(value), pad.left - 9, py);
  }
  records.forEach((record, index) => {
    if (records.length > 8 && index % 2 && index !== records.length - 1) return;
    ctx.fillStyle = '#747477';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(shortMonth(record.month), x(index), height - pad.bottom + 14);
  });

  const interactivePoints = [];
  series.forEach(item => {
    const points = item.values.map((value, index) => value == null ? null : {
      x: x(index), y: y(value), value, recordIndex: index, label: item.label, color: item.color
    }).filter(Boolean);
    if (!points.length) return;
    interactivePoints.push(...points);
    if (item.fill) {
      const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
      gradient.addColorStop(0, item.fill);
      gradient.addColorStop(1, 'rgba(57,118,74,0)');
      ctx.beginPath();
      ctx.moveTo(points[0].x, height - pad.bottom);
      points.forEach(point => ctx.lineTo(point.x, point.y));
      ctx.lineTo(points.at(-1).x, height - pad.bottom);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    if (points.length > 1) {
      ctx.beginPath();
      points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.width || 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    points.forEach((point, index) => {
      if (records.length > 9 && index !== points.length - 1) return;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = item.color;
      ctx.stroke();
    });
  });
  canvas.chartPoints = interactivePoints;
  enableChartTooltip(canvas);
}

function enableChartTooltip(canvas) {
  if (canvas.tooltipReady) return;
  canvas.tooltipReady = true;
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  canvas.parentElement.appendChild(tooltip);

  canvas.addEventListener('mousemove', event => {
    const rect = canvas.getBoundingClientRect();
    const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const nearest = (canvas.chartPoints || []).reduce((best, point) => {
      const distance = Math.hypot(cursor.x - point.x, cursor.y - point.y);
      return !best || distance < best.distance ? { point, distance } : best;
    }, null);
    if (!nearest || nearest.distance > 16) {
      tooltip.classList.remove('visible');
      return;
    }

    const { point } = nearest;
    const record = records[point.recordIndex];
    tooltip.style.setProperty('--tooltip-color', point.color);
    tooltip.innerHTML = `<span>${monthLabel(record.month)}工资 · ${paymentDate(record.month).iso} 发放</span><strong>${point.label}</strong><b>${money(point.value)}</b>`;
    tooltip.classList.add('visible');
    const maxLeft = canvas.parentElement.clientWidth - tooltip.offsetWidth - 6;
    const maxTop = canvas.parentElement.clientHeight - tooltip.offsetHeight - 6;
    tooltip.style.left = `${Math.max(6, Math.min(maxLeft, point.x + 14))}px`;
    tooltip.style.top = `${Math.max(6, Math.min(maxTop, point.y - tooltip.offsetHeight / 2))}px`;
  });
  canvas.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));
}

function chartDefinition(key) {
  const derived = records.map((_, index) => derivedAt(index));
  if (key === 'balance') return {
    kicker: '资产轨迹',
    title: '发薪后余额',
    note: '展示每次工资到账后记录的可用资金总余额。',
    options: {},
    series: [{ label: '发薪后余额', color: '#39764a', width: 2.6, fill: 'rgba(57,118,74,.12)', values: records.map(record => record.balance) }]
  };
  return {
    kicker: '现金流',
    title: '收入、支出与储蓄趋势',
    note: '按工资所属月份展示实发收入、推算支出与存款变化。',
    options: { zeroBase: true },
    series: [
      { label: '实发工资', color: '#1d1d1f', width: 2.5, values: records.map(record => record.netIncome) },
      { label: '推算支出', color: '#d9822b', width: 2.3, values: derived.map(item => item.expense) },
      { label: '存款变化', color: '#0066cc', width: 2.3, values: derived.map(item => item.saving) }
    ]
  };
}

function drawExpandedChart() {
  if (!expandedChartKey || $('#chartModal').hidden || !records.length) return;
  const definition = chartDefinition(expandedChartKey);
  drawLineChart($('#chartModalCanvas'), definition.series, definition.options);
}

function drawAllCharts() {
  if (!records.length) return;
  const cashflow = chartDefinition('cashflow');
  const balance = chartDefinition('balance');
  drawLineChart($('#cashflowChart'), cashflow.series, cashflow.options);
  drawLineChart($('#balanceChart'), balance.series, balance.options);
  drawExpandedChart();
  const first = records[0].balance;
  const last = records.at(-1).balance;
  $('#balanceGain').textContent = `${records.length}个月 ${last >= first ? '+' : ''}${((last - first) / first * 100).toFixed(1)}%`;
}

function openChartModal(key, trigger) {
  expandedChartKey = key;
  lastChartTrigger = trigger;
  const definition = chartDefinition(key);
  $('#chartModalKicker').textContent = definition.kicker;
  $('#chartModalTitle').textContent = definition.title;
  $('#chartModalNote').textContent = definition.note;
  $('#chartModalLegend').innerHTML = definition.series.map(item => `<span><i style="background:${item.color}"></i>${item.label}</span>`).join('');
  $('#chartModal').hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => {
    drawExpandedChart();
    $('#closeChartModal').focus();
  });
}

function closeChartModal() {
  $('#chartModal').hidden = true;
  document.body.classList.remove('modal-open');
  expandedChartKey = null;
  lastChartTrigger?.focus();
  lastChartTrigger = null;
}

$('#addRecord').addEventListener('click', () => openDrawer());
$('#addRecordSecondary').addEventListener('click', () => openDrawer());
$('#startFirstRecord').addEventListener('click', () => openDrawer());
$('#closeDrawer').addEventListener('click', closeDrawer);
$('#cancelDrawer').addEventListener('click', closeDrawer);
$('#drawerBackdrop').addEventListener('click', closeDrawer);
$('#recordForm').addEventListener('submit', saveForm);
$('#recordForm').addEventListener('input', updateFormPreview);
$('#deleteRecord').addEventListener('click', deleteCurrentRecord);
$('#exportCsv').addEventListener('click', exportCsv);
$('#prevMonth').addEventListener('click', () => {
  const index = records.findIndex(record => record.month === selectedMonth);
  if (index > 0) { selectedMonth = records[index - 1].month; render(); }
});
$('#nextMonth').addEventListener('click', () => {
  const index = records.findIndex(record => record.month === selectedMonth);
  if (index < records.length - 1) { selectedMonth = records[index + 1].month; render(); }
});

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const button = $('#toggleSidebar');
  button.textContent = collapsed ? '›' : '‹';
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-label', collapsed ? '展开侧边栏' : '收起侧边栏');
  localStorage.setItem('ledger-sidebar-collapsed', String(collapsed));
  setTimeout(drawAllCharts, 240);
}

$('#toggleSidebar').addEventListener('click', () => setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed')));
setSidebarCollapsed(localStorage.getItem('ledger-sidebar-collapsed') === 'true');

$$('[data-expand-chart]').forEach(button => button.addEventListener('click', () => openChartModal(button.dataset.expandChart, button)));
$('#closeChartModal').addEventListener('click', closeChartModal);
$('#chartModalBackdrop').addEventListener('click', closeChartModal);

function updateActiveNavigation() {
  const marker = window.innerHeight * .36;
  let activeLink = $('.side-nav a');
  $$('.side-nav a').forEach(link => {
    const section = document.querySelector(link.getAttribute('href'));
    if (section && !section.hidden && section.getBoundingClientRect().top <= marker) activeLink = link;
  });
  $$('.side-nav a').forEach(link => link.classList.toggle('active', link === activeLink));
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('#recordDrawer').classList.contains('open')) closeDrawer();
  else if (event.key === 'Escape' && !$('#chartModal').hidden) closeChartModal();
});
window.addEventListener('scroll', () => requestAnimationFrame(updateActiveNavigation), { passive: true });
window.addEventListener('resize', () => requestAnimationFrame(() => { drawAllCharts(); updateActiveNavigation(); }));
window.addEventListener('beforeunload', event => {
  if (!isDirty) return;
  event.preventDefault();
  event.returnValue = '';
});

async function initializeApp() {
  try {
    let source;
    if (FILE_PREVIEW) {
      if (!window.__LOCAL_LEDGER__) throw new Error('本地预览数据不可用');
      source = window.__LOCAL_LEDGER__;
    } else {
      const response = await fetch('data/personal-finance-ledger.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('初始化账本不可用');
      source = await response.json();
    }
    const validated = validateImportedData(source);
    records = validated.records;
    ledgerSettings = validated.settings;
    selectedMonth = records.at(-1)?.month || '';
    isDirty = false;
    setStatus(FILE_PREVIEW ? '本机历史数据 · 只读预览' : 'data/personal-finance-ledger.json · 已载入', true);
  } catch {
    records = [];
    ledgerSettings = { openingBalance: null, payDay: 7, payMonthOffset: 1 };
    selectedMonth = '';
    isDirty = false;
    setStatus(FILE_PREVIEW ? '未找到本机预览数据' : '空账本 · 启动本地服务后自动创建');
  }
  render();
  if (FILE_PREVIEW) {
    document.body.classList.add('file-preview');
    ['#addRecord', '#addRecordSecondary', '#startFirstRecord'].forEach(selector => {
      const button = $(selector);
      button.disabled = true;
      button.title = '双击 HTML 为只读预览；通过本地服务运行时可编辑并自动保存';
    });
  }
  updateActiveNavigation();
}

initializeApp();
