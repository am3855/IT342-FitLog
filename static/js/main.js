/* ═══════════════════════════════════════════════
   FitLog — main.js
═══════════════════════════════════════════════ */

let currentUser = null;
let allWorkouts = [];
let charts = {};

// ── View / Panel helpers ──────────────────────

function showView(name) {
  ['login','register','2fa','app'].forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('hidden', v !== name);
  });
}

function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.remove('hidden');
  document.querySelectorAll('.sidebar-item').forEach(el => {
    el.classList.toggle('active', el.dataset.panel === name);
  });
  if (name === 'history')  renderHistoryTable(allWorkouts);
  if (name === 'metrics')  renderMetrics();
  if (name === 'settings') loadSettings();
  if (name === 'admin')    loadAdmin();
  if (name === 'log')      { setTodayDate(); loadMuscles(); }
}

function showMsg(id, msg, isError) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  el.className = isError ? 'error-box' : 'success-box';
  el.style.display = 'block';
  setTimeout(() => { if (el) el.style.display = 'none'; }, 5000);
}

function hideMsg(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function setTodayDate() {
  const d = document.getElementById('log-date');
  if (d && !d.value) d.value = new Date().toISOString().split('T')[0];
}

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

// ── Auth ─────────────────────────────────────

async function checkAuth() {
  const res = await fetch('/api/me');
  const data = await res.json();
  if (data.logged_in) {
    await enterApp(data.user);
  } else {
    showView('login');
  }
}

async function enterApp(user) {
  currentUser = user;
  document.getElementById('nav-username').textContent = user.username;
  const adminLink = document.getElementById('admin-sidebar-link');
  if (adminLink) adminLink.classList.toggle('hidden', !user.is_admin);
  await loadWorkouts();
  showView('app');
  showPanel('dashboard');
}

async function handleLogin() {
  hideMsg('login-error');
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) { showMsg('login-error', 'Please enter your email and password.', true); return; }

  const res  = await fetch('/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email, password}) });
  const data = await res.json();

  if (data.requires_2fa) { showView('2fa'); return; }
  if (!res.ok) { showMsg('login-error', data.error, true); return; }
  await enterApp(data.user);
}

async function handleRegister() {
  hideMsg('register-error');
  const username         = document.getElementById('reg-username').value.trim();
  const email            = document.getElementById('reg-email').value.trim();
  const password         = document.getElementById('reg-password').value;
  const confirm_password = document.getElementById('reg-confirm').value;

  if (!username || !email || !password || !confirm_password) {
    showMsg('register-error', 'All fields are required.', true); return;
  }
  if (password.length < 8) { showMsg('register-error', 'Password must be at least 8 characters.', true); return; }
  if (password !== confirm_password) { showMsg('register-error', 'Passwords do not match.', true); return; }

  const res  = await fetch('/api/register', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({username, email, password, confirm_password}) });
  const data = await res.json();
  if (!res.ok) { showMsg('register-error', data.error, true); return; }
  await enterApp(data.user);
}

async function handle2FA() {
  hideMsg('twofa-error');
  const code = document.getElementById('twofa-code').value.trim();
  if (!code) { showMsg('twofa-error', 'Please enter the verification code.', true); return; }

  const res  = await fetch('/api/2fa/verify', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({code}) });
  const data = await res.json();
  if (!res.ok) { showMsg('twofa-error', data.error, true); return; }
  await enterApp(data.user);
}

async function handleLogout() {
  await fetch('/api/logout', { method: 'POST' });
  currentUser = null;
  allWorkouts = [];
  Object.keys(charts).forEach(k => destroyChart(k));
  showView('login');
}

// ── Password strength ─────────────────────────

function checkStrength(val) {
  const segs  = ['seg1','seg2','seg3','seg4'].map(id => document.getElementById(id));
  const label = document.getElementById('strength-label');
  segs.forEach(s => { s.className = 'strength-seg'; });
  if (!val.length) { label.textContent = 'Enter a password'; return; }
  let score = 0;
  if (val.length >= 8) score++;
  if (/[A-Z]/.test(val)) score++;
  if (/[0-9]/.test(val)) score++;
  if (/[^A-Za-z0-9]/.test(val)) score++;
  const cls = score <= 1 ? 'low' : score <= 2 ? 'med' : 'high';
  for (let i = 0; i < score; i++) segs[i].classList.add(cls);
  label.textContent = 'Password strength: ' + (['','Weak','Weak','Good','Strong'][score] || 'Weak');
}

// ── Workouts ──────────────────────────────────

async function loadWorkouts() {
  const res  = await fetch('/api/workouts');
  const data = await res.json();
  allWorkouts = data.workouts || [];
  updateStatsBar(allWorkouts);
  renderDashboardRecent(allWorkouts);
  renderWeeklyVolumeChart(allWorkouts);
}

function updateStatsBar(workouts) {
  document.getElementById('stat-total').textContent = workouts.length;
  const totalVol = workouts.reduce((s, w) => s + (w.sets * w.reps * w.weight), 0);
  document.getElementById('stat-volume').textContent = totalVol >= 1000 ? (totalVol / 1000).toFixed(1) + 'k' : Math.round(totalVol);
  const now  = new Date();
  const mon  = new Date(now); mon.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1));
  mon.setHours(0,0,0,0);
  const thisWeek = workouts.filter(w => new Date(w.date + 'T00:00:00') >= mon).length;
  document.getElementById('stat-week').textContent = thisWeek;
  // streak: consecutive days with at least one workout
  const dateset = new Set(workouts.map(w => w.date));
  let streak = 0;
  const today = new Date(); today.setHours(0,0,0,0);
  let check   = new Date(today);
  while (true) {
    const key = check.toISOString().split('T')[0];
    if (dateset.has(key)) { streak++; check.setDate(check.getDate() - 1); }
    else break;
  }
  document.getElementById('stat-streak').textContent = streak;
}

function renderDashboardRecent(workouts) {
  const tbody = document.getElementById('dashboard-recent-body');
  const recent = workouts.slice(0, 5);
  if (!recent.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);text-align:center;padding:24px;">No workouts yet. <a onclick="showPanel(\'log\')" style="color:var(--green);cursor:pointer;">Log your first one!</a></td></tr>';
    return;
  }
  tbody.innerHTML = recent.map(w => `
    <tr>
      <td>${fmtDate(w.date)}</td>
      <td><strong>${esc(w.exercise_name)}</strong></td>
      <td>${w.sets} &times; ${w.reps}</td>
      <td>${w.weight || 0}</td>
      <td>${w.duration || 0} min</td>
      <td>${Math.round(w.sets * w.reps * w.weight)}</td>
    </tr>`).join('');
}

function renderHistoryTable(workouts) {
  const tbody = document.getElementById('history-body');
  const empty = document.getElementById('history-empty');
  if (!workouts.length) {
    tbody.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  const unit = currentUser?.unit_preference || 'imperial';
  const weightKg = (w) => unit === 'imperial' ? (w.weight / 2.205) : w.weight;
  tbody.innerHTML = workouts.map(w => {
    const cal = Math.round(5 * weightKg(w) * ((w.duration || 0) / 60));
    return `<tr id="hrow-${w.workout_id}">
      <td>${fmtDate(w.date)}</td>
      <td><strong>${esc(w.exercise_name)}</strong></td>
      <td>${w.sets}</td>
      <td>${w.reps}</td>
      <td>${w.weight}</td>
      <td>${w.duration || 0} min</td>
      <td>${cal} kcal</td>
      <td>
        <button class="btn-edit" onclick="openEditModal('${w.workout_id}','history')" style="margin-right:6px;">Edit</button>
        <button class="btn-danger" onclick="deleteWorkout('${w.workout_id}')">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

async function submitWorkout() {
  hideMsg('log-error'); hideMsg('log-success');
  const exercise_name = document.getElementById('log-exercise').value.trim();
  const sets     = parseInt(document.getElementById('log-sets').value) || 0;
  const reps     = parseInt(document.getElementById('log-reps').value) || 0;
  const weight   = parseFloat(document.getElementById('log-weight').value) || 0;
  const duration = parseInt(document.getElementById('log-duration').value) || 0;
  const date     = document.getElementById('log-date').value;

  if (!exercise_name) { showMsg('log-error', 'Please enter an exercise name.', true); return; }
  if (!sets || !reps)  { showMsg('log-error', 'Sets and reps are required.', true); return; }
  if (!date)           { showMsg('log-error', 'Please select a date.', true); return; }

  const res  = await fetch('/api/workouts', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({exercise_name, sets, reps, weight, duration, date}) });
  const data = await res.json();
  if (!res.ok) { showMsg('log-error', data.error, true); return; }

  allWorkouts.unshift(data.workout);
  updateStatsBar(allWorkouts);
  renderDashboardRecent(allWorkouts);
  renderWeeklyVolumeChart(allWorkouts);

  document.getElementById('log-exercise').value = '';
  document.getElementById('log-sets').value     = '';
  document.getElementById('log-reps').value     = '';
  document.getElementById('log-weight').value   = '';
  document.getElementById('log-duration').value = '';
  showMsg('log-success', 'Workout saved!', false);
}

async function deleteWorkout(id) {
  if (!confirm('Delete this workout?')) return;
  const res = await fetch('/api/workouts/' + id, { method: 'DELETE' });
  if (!res.ok) { showMsg('history-error', 'Failed to delete workout.', true); return; }
  allWorkouts = allWorkouts.filter(w => w.workout_id !== id);
  updateStatsBar(allWorkouts);
  renderDashboardRecent(allWorkouts);
  renderHistoryTable(allWorkouts);
  showMsg('history-success', 'Workout deleted.', false);
}

// ── Edit modal ────────────────────────────────

function openEditModal(id, source) {
  const w = allWorkouts.find(x => x.workout_id === id);
  if (!w) return;
  document.getElementById('edit-modal-id').value       = id;
  document.getElementById('edit-modal-source').value   = source || 'history';
  document.getElementById('edit-modal-exercise').value = w.exercise_name;
  document.getElementById('edit-modal-sets').value     = w.sets;
  document.getElementById('edit-modal-reps').value     = w.reps;
  document.getElementById('edit-modal-weight').value   = w.weight;
  document.getElementById('edit-modal-duration').value = w.duration;
  document.getElementById('edit-modal-date').value     = w.date;
  hideMsg('edit-modal-error');
  document.getElementById('edit-modal').classList.remove('hidden');
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
}

async function saveEditModal() {
  hideMsg('edit-modal-error');
  const id = document.getElementById('edit-modal-id').value;
  const payload = {
    exercise_name: document.getElementById('edit-modal-exercise').value.trim(),
    sets:     parseInt(document.getElementById('edit-modal-sets').value),
    reps:     parseInt(document.getElementById('edit-modal-reps').value),
    weight:   parseFloat(document.getElementById('edit-modal-weight').value),
    duration: parseInt(document.getElementById('edit-modal-duration').value) || 0,
    date:     document.getElementById('edit-modal-date').value,
  };
  if (!payload.exercise_name || !payload.sets || !payload.reps) {
    showMsg('edit-modal-error', 'Exercise, sets, and reps are required.', true); return;
  }
  const res = await fetch('/api/workouts/' + id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  if (!res.ok) { const d = await res.json(); showMsg('edit-modal-error', d.error, true); return; }

  const idx = allWorkouts.findIndex(w => w.workout_id === id);
  if (idx !== -1) allWorkouts[idx] = { ...allWorkouts[idx], ...payload };
  closeEditModal();
  updateStatsBar(allWorkouts);
  renderDashboardRecent(allWorkouts);
  renderHistoryTable(allWorkouts);
  showMsg('history-success', 'Workout updated!', false);
}

// ── Exercise search ───────────────────────────

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

const debouncedSearch = debounce(async (term) => {
  const dd = document.getElementById('exercise-dropdown');
  if (!term || term.length < 2) { dd.classList.add('hidden'); return; }
  try {
    const res  = await fetch('/api/exercises/search?term=' + encodeURIComponent(term));
    const data = await res.json();
    const suggestions = (data.suggestions || []).slice(0, 10);
    if (!suggestions.length) { dd.classList.add('hidden'); return; }
    dd.innerHTML = suggestions.map(s =>
      `<div class="exercise-dropdown-item" onclick="selectExercise('${esc(s.value || s)}')">${esc(s.value || s)}</div>`
    ).join('');
    dd.classList.remove('hidden');
  } catch(e) { dd.classList.add('hidden'); }
}, 300);

function selectExercise(name) {
  document.getElementById('log-exercise').value = name;
  document.getElementById('exercise-dropdown').classList.add('hidden');
}

document.addEventListener('click', e => {
  const dd = document.getElementById('exercise-dropdown');
  if (dd && !dd.contains(e.target) && e.target.id !== 'log-exercise') dd.classList.add('hidden');
});

// ── Muscle group browser ──────────────────────

async function loadMuscles() {
  const btnContainer = document.getElementById('muscle-buttons');
  if (!btnContainer || btnContainer.dataset.loaded) return;
  try {
    const res  = await fetch('/api/muscles');
    const data = await res.json();
    const muscles = data.results || [];
    btnContainer.innerHTML = muscles.map(m =>
      `<button class="muscle-btn" onclick="loadByMuscle(${m.id}, this)">${esc(m.name_en || m.name)}</button>`
    ).join('');
    btnContainer.dataset.loaded = '1';
  } catch(e) {}
}

async function loadByMuscle(muscleId, btn) {
  document.querySelectorAll('.muscle-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const container = document.getElementById('muscle-exercises');
  container.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:12px;">Loading...</div>';
  try {
    const res  = await fetch('/api/exercises/by-muscle?muscle_id=' + muscleId);
    const data = await res.json();
    const exercises = (data.results || []).filter(e => e.translations?.length || e.name);
    if (!exercises.length) { container.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:12px;">No exercises found.</div>'; return; }
    container.innerHTML = exercises.slice(0, 30).map(e => {
      const name = e.translations?.find(t => t.language === 2)?.name || e.name || 'Exercise';
      return `<div class="exercise-card" onclick="selectExercise('${esc(name)}');showPanel('log');">
        <div class="exercise-card-name">${esc(name)}</div>
        <div class="exercise-card-meta">Click to use in log form</div>
      </div>`;
    }).join('');
  } catch(e) { container.innerHTML = '<div style="color:var(--muted);font-size:13px;">Failed to load exercises.</div>'; }
}

// ── Weekly volume chart ───────────────────────

function renderWeeklyVolumeChart(workouts) {
  destroyChart('weeklyVol');
  const ctx = document.getElementById('chart-weekly-volume');
  if (!ctx) return;
  const labels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const now    = new Date(); now.setHours(0,0,0,0);
  const dow    = now.getDay(); // 0=Sun
  const mon    = new Date(now); mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  const data   = labels.map((_, i) => {
    const d = new Date(mon); d.setDate(mon.getDate() + i);
    const key = d.toISOString().split('T')[0];
    return workouts.filter(w => w.date === key).reduce((s, w) => s + w.sets * w.reps * w.weight, 0);
  });
  charts['weeklyVol'] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: 'rgba(184,249,79,0.6)', borderColor: '#b8f94f', borderWidth: 1, borderRadius: 4 }] },
    options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#777' }, grid: { color: '#2a2a2a' } }, y: { ticks: { color: '#777' }, grid: { color: '#2a2a2a' } } } },
  });
}

// ── Health Metrics ────────────────────────────

function renderMetrics() {
  if (!currentUser) return;
  const { age, weight, height, unit_preference: unit, gender } = currentUser;
  const hasBasics = weight && height;
  document.getElementById('metrics-no-data').classList.toggle('hidden', !!hasBasics);
  document.getElementById('metrics-content').classList.toggle('hidden', !hasBasics);
  if (!hasBasics) return;

  const weightKg = unit === 'imperial' ? weight / 2.205 : weight;
  const heightCm = unit === 'imperial' ? height * 2.54 : height;
  const heightM  = heightCm / 100;

  // BMI
  const bmi = weightKg / (heightM * heightM);
  const bmiNum = document.getElementById('bmi-value');
  const bmiBadge = document.getElementById('bmi-category-badge');
  bmiNum.textContent = bmi.toFixed(1);
  let bmiCat = 'Normal', bmiColor = 'var(--green)';
  if (bmi < 18.5)      { bmiCat = 'Underweight'; bmiColor = 'var(--blue)'; }
  else if (bmi >= 30)  { bmiCat = 'Obese'; bmiColor = 'var(--red)'; }
  else if (bmi >= 25)  { bmiCat = 'Overweight'; bmiColor = 'var(--orange)'; }
  bmiNum.style.color = bmiColor;
  bmiBadge.textContent = bmiCat;
  bmiBadge.style.background = bmiColor + '22';
  bmiBadge.style.color = bmiColor;
  renderBMIChart(bmi);

  // HR Zones
  if (age) {
    document.getElementById('hr-no-age').classList.add('hidden');
    document.getElementById('hr-content').style.display = 'block';
    renderHRZones(age);
  } else {
    document.getElementById('hr-no-age').classList.remove('hidden');
    document.getElementById('hr-content').style.display = 'none';
  }

  // Daily Calories
  const hasCalData = age && weight && height && gender && gender !== 'other';
  document.getElementById('metrics-calorie-no-data').classList.toggle('hidden', !!hasCalData);
  document.getElementById('metrics-calorie-content').style.display = hasCalData ? 'block' : 'none';
  if (hasCalData) renderDailyCalories();

  // Progress charts
  renderProgressCharts(allWorkouts, weightKg);
}

function renderBMIChart(bmi) {
  destroyChart('bmi');
  const ctx = document.getElementById('chart-bmi');
  if (!ctx) return;
  const clamped = Math.min(Math.max(bmi, 10), 40);
  charts['bmi'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Underweight\n<18.5', 'Normal\n18.5-25', 'Overweight\n25-30', 'Obese\n>30'],
      datasets: [
        { data: [18.5, 6.5, 5, 10], backgroundColor: ['rgba(79,168,255,0.5)','rgba(184,249,79,0.5)','rgba(255,183,77,0.5)','rgba(255,82,82,0.5)'], borderWidth: 0 },
        { data: [clamped > 18.5 ? 0 : clamped, clamped > 25 ? 6.5 : Math.max(0, Math.min(6.5, clamped - 18.5)), 0, 0], backgroundColor: '#ffffff44', borderWidth: 0 },
      ],
    },
    options: {
      indexAxis: 'y', plugins: { legend: { display: false },
        tooltip: { callbacks: { label: () => `Your BMI: ${bmi.toFixed(1)}` } }
      },
      scales: { x: { stacked: true, ticks: { color: '#777' }, grid: { color: '#2a2a2a' } }, y: { stacked: true, ticks: { color: '#777' }, grid: { display: false } } },
    },
  });
}

function renderHRZones(age) {
  const maxHR = 220 - age;
  const zones = [
    { name: 'Zone 1 — Warm Up',   pct: [50, 60], color: '#4fa8ff' },
    { name: 'Zone 2 — Fat Burn',  pct: [60, 70], color: '#b8f94f' },
    { name: 'Zone 3 — Cardio',    pct: [70, 80], color: '#ffd740' },
    { name: 'Zone 4 — Peak',      pct: [80, 90], color: '#ff5252' },
  ];
  const tbl = document.getElementById('hr-zones-table');
  tbl.innerHTML = '<tr><th>Zone</th><th>% Max HR</th><th>BPM Range</th></tr>' +
    zones.map(z => {
      const lo = Math.round(maxHR * z.pct[0] / 100);
      const hi = Math.round(maxHR * z.pct[1] / 100);
      return `<tr><td style="color:${z.color}">${esc(z.name)}</td><td style="color:var(--muted)">${z.pct[0]}–${z.pct[1]}%</td><td>${lo}–${hi} bpm</td></tr>`;
    }).join('');

  destroyChart('hr');
  const ctx = document.getElementById('chart-hr');
  if (!ctx) return;
  charts['hr'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Heart Rate Zones'],
      datasets: zones.map(z => ({
        label: z.name,
        data: [z.pct[1] - z.pct[0]],
        backgroundColor: z.color + '88',
        borderColor: z.color,
        borderWidth: 1,
      })),
    },
    options: {
      indexAxis: 'y', plugins: { legend: { position: 'bottom', labels: { color: '#777', boxWidth: 12, font: { size: 11 } } } },
      scales: { x: { stacked: true, ticks: { color: '#777' }, grid: { color: '#2a2a2a' } }, y: { stacked: true, display: false } },
    },
  });
}

function renderDailyCalories() {
  if (!currentUser) return;
  const { age, weight, height, gender, unit_preference: unit } = currentUser;
  if (!age || !weight || !height || !gender || gender === 'other') return;
  const weightKg = unit === 'imperial' ? weight / 2.205 : weight;
  const heightCm = unit === 'imperial' ? height * 2.54 : height;
  const activity = parseFloat(document.getElementById('activity-level')?.value || '1.55');
  let bmr;
  if (gender === 'male') bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + 5;
  else                   bmr = 10 * weightKg + 6.25 * heightCm - 5 * age - 161;
  const tdee = Math.round(bmr * activity);
  const el = document.getElementById('daily-cal-value');
  if (el) el.textContent = tdee.toLocaleString();

  const protein = Math.round(tdee * 0.30 / 4);
  const carbs   = Math.round(tdee * 0.40 / 4);
  const fat     = Math.round(tdee * 0.30 / 9);
  const mbEl    = document.getElementById('macro-breakdown');
  if (mbEl) mbEl.innerHTML = [
    { label: 'Protein', g: protein, color: '#4fa8ff', pct: '30%' },
    { label: 'Carbs',   g: carbs,   color: '#b8f94f', pct: '40%' },
    { label: 'Fat',     g: fat,     color: '#ffd740', pct: '30%' },
  ].map(m => `<div class="macro-row">
    <div class="macro-dot" style="background:${m.color}"></div>
    <span class="macro-label">${m.label} (${m.pct})</span>
    <span class="macro-val" style="margin-left:auto;">${m.g}g</span>
  </div>`).join('');

  destroyChart('macros');
  const ctx = document.getElementById('chart-macros');
  if (!ctx) return;
  charts['macros'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Protein 30%','Carbs 40%','Fat 30%'],
      datasets: [{ data: [30, 40, 30], backgroundColor: ['#4fa8ff88','#b8f94f88','#ffd74088'], borderColor: ['#4fa8ff','#b8f94f','#ffd740'], borderWidth: 2 }],
    },
    options: { plugins: { legend: { display: false } }, cutout: '65%' },
  });
}

function renderProgressCharts(workouts, weightKg) {
  destroyChart('volume'); destroyChart('frequency'); destroyChart('calsBurned');
  if (!workouts.length) return;

  const sorted    = [...workouts].sort((a, b) => a.date.localeCompare(b.date));
  const volLabels = sorted.map(w => fmtDate(w.date));
  const volData   = sorted.map(w => w.sets * w.reps * w.weight);
  const ctxVol    = document.getElementById('chart-volume');
  if (ctxVol) charts['volume'] = new Chart(ctxVol, {
    type: 'line',
    data: { labels: volLabels, datasets: [{ label: 'Volume', data: volData, borderColor: '#b8f94f', backgroundColor: 'rgba(184,249,79,0.08)', tension: 0.3, fill: true, pointRadius: 3 }] },
    options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#777', maxTicksLimit: 8 }, grid: { color: '#2a2a2a' } }, y: { ticks: { color: '#777' }, grid: { color: '#2a2a2a' } } } },
  });

  // Frequency per week
  const weekMap = {};
  workouts.forEach(w => {
    const d   = new Date(w.date + 'T00:00:00');
    const dow = d.getDay();
    const mon = new Date(d); mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    const key = mon.toISOString().split('T')[0];
    weekMap[key] = (weekMap[key] || 0) + 1;
  });
  const freqKeys = Object.keys(weekMap).sort().slice(-12);
  const ctxFreq  = document.getElementById('chart-frequency');
  if (ctxFreq) charts['frequency'] = new Chart(ctxFreq, {
    type: 'bar',
    data: { labels: freqKeys.map(k => fmtDate(k)), datasets: [{ label: 'Workouts', data: freqKeys.map(k => weekMap[k]), backgroundColor: 'rgba(79,168,255,0.6)', borderColor: '#4fa8ff', borderWidth: 1, borderRadius: 4 }] },
    options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#777' }, grid: { color: '#2a2a2a' } }, y: { ticks: { color: '#777' }, grid: { color: '#2a2a2a' } } } },
  });

  // Calories burned
  const calData = sorted.map(w => Math.round(5 * (weightKg || 70) * ((w.duration || 0) / 60)));
  const ctxCal  = document.getElementById('chart-calories-burned');
  if (ctxCal) charts['calsBurned'] = new Chart(ctxCal, {
    type: 'bar',
    data: { labels: volLabels, datasets: [{ label: 'Calories Burned', data: calData, backgroundColor: 'rgba(255,183,77,0.6)', borderColor: '#ffb74d', borderWidth: 1, borderRadius: 4 }] },
    options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#777', maxTicksLimit: 10 }, grid: { color: '#2a2a2a' } }, y: { ticks: { color: '#777' }, grid: { color: '#2a2a2a' } } } },
  });
}

// ── AI Recommendations ────────────────────────

async function getAIRecommendations() {
  document.getElementById('ai-no-workouts').classList.add('hidden');
  document.getElementById('ai-no-metrics').classList.add('hidden');
  document.getElementById('ai-result').classList.add('hidden');
  document.getElementById('ai-error').style.display = 'none';
  if (!allWorkouts.length) { document.getElementById('ai-no-workouts').classList.remove('hidden'); return; }
  if (!currentUser?.age || !currentUser?.weight || !currentUser?.height) {
    document.getElementById('ai-no-metrics').classList.remove('hidden');
  }
  document.getElementById('ai-loading').classList.remove('hidden');
  document.getElementById('ai-get-btn').disabled = true;

  try {
    const res  = await fetch('/api/ai/recommendations', { method: 'POST', headers: {'Content-Type':'application/json'} });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to get recommendations.');
    document.getElementById('ai-result-text').textContent = data.recommendations;
    document.getElementById('ai-result').classList.remove('hidden');
    document.getElementById('ai-refresh-btn').classList.remove('hidden');
    document.getElementById('ai-get-btn').classList.add('hidden');
  } catch(e) {
    const errEl = document.getElementById('ai-error');
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  } finally {
    document.getElementById('ai-loading').classList.add('hidden');
    document.getElementById('ai-get-btn').disabled = false;
  }
}

// ── Settings ──────────────────────────────────

async function loadSettings() {
  const res  = await fetch('/api/me');
  const data = await res.json();
  if (!data.logged_in) return;
  currentUser = data.user;
  const u = data.user;
  document.getElementById('settings-username-display').textContent = u.username || '—';
  document.getElementById('settings-email-display').textContent    = u.email || '—';
  document.getElementById('settings-created-display').textContent  = u.created_at ? fmtDate(u.created_at.split('T')[0]) : '—';
  if (u.age)    document.getElementById('settings-age').value    = u.age;
  if (u.weight) document.getElementById('settings-weight').value = u.weight;
  if (u.height) document.getElementById('settings-height').value = u.height;
  if (u.gender) document.getElementById('settings-gender').value = u.gender;
  const unitSel = document.getElementById('settings-units');
  if (unitSel) unitSel.value = u.unit_preference || 'imperial';
  updateUnitLabels();
  const is2FA = u['2fa_enabled'];
  document.getElementById('twofa-status-label').textContent = is2FA ? 'Enabled' : 'Disabled';
  document.getElementById('twofa-status-label').style.color = is2FA ? 'var(--green)' : 'var(--muted)';
  document.getElementById('twofa-toggle-btn').textContent   = is2FA ? 'Disable 2FA' : 'Enable 2FA';
}

function updateUnitLabels() {
  const unit = document.getElementById('settings-units')?.value || 'imperial';
  const wl = document.getElementById('weight-label');
  const hl = document.getElementById('height-label');
  if (wl) wl.textContent = unit === 'imperial' ? 'Weight (lbs)' : 'Weight (kg)';
  if (hl) hl.textContent = unit === 'imperial' ? 'Height (inches)' : 'Height (cm)';
}

async function saveUsername() {
  hideMsg('username-success'); hideMsg('username-error');
  const username = document.getElementById('settings-new-username').value.trim();
  if (!username) { showMsg('username-error', 'Please enter a username.', true); return; }
  const res  = await fetch('/api/user/username', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({username}) });
  const data = await res.json();
  if (!res.ok) { showMsg('username-error', data.error, true); return; }
  currentUser.username = username;
  document.getElementById('nav-username').textContent = username;
  document.getElementById('settings-username-display').textContent = username;
  document.getElementById('settings-new-username').value = '';
  showMsg('username-success', 'Username updated!', false);
}

async function saveEmail() {
  hideMsg('email-success'); hideMsg('email-error');
  const email = document.getElementById('settings-new-email').value.trim();
  if (!email) { showMsg('email-error', 'Please enter an email.', true); return; }
  const res  = await fetch('/api/user/email', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email}) });
  const data = await res.json();
  if (!res.ok) { showMsg('email-error', data.error, true); return; }
  currentUser.email = email;
  document.getElementById('settings-email-display').textContent = email;
  document.getElementById('settings-new-email').value = '';
  showMsg('email-success', 'Email updated!', false);
}

async function saveMetrics() {
  hideMsg('metrics-success'); hideMsg('metrics-error');
  const age   = document.getElementById('settings-age').value;
  const weight = document.getElementById('settings-weight').value;
  const height = document.getElementById('settings-height').value;
  const gender = document.getElementById('settings-gender').value;
  const unit_preference = document.getElementById('settings-units').value;
  const payload = { unit_preference };
  if (age)    payload.age    = parseInt(age);
  if (weight) payload.weight = parseFloat(weight);
  if (height) payload.height = parseFloat(height);
  if (gender) payload.gender = gender;
  const res  = await fetch('/api/user/metrics', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const data = await res.json();
  if (!res.ok) { showMsg('metrics-error', data.error, true); return; }
  Object.assign(currentUser, payload);
  showMsg('metrics-success', 'Body metrics saved!', false);
}

async function toggle2FA() {
  hideMsg('twofa-settings-success'); hideMsg('twofa-settings-error');
  const is2FA  = currentUser?.['2fa_enabled'];
  const url    = is2FA ? '/api/2fa/disable' : '/api/2fa/enroll';
  const res    = await fetch(url, { method: 'POST' });
  const data   = await res.json();
  if (!res.ok) { showMsg('twofa-settings-error', data.error || 'Failed.', true); return; }
  currentUser['2fa_enabled'] = !is2FA;
  const newState = !is2FA;
  document.getElementById('twofa-status-label').textContent = newState ? 'Enabled' : 'Disabled';
  document.getElementById('twofa-status-label').style.color = newState ? 'var(--green)' : 'var(--muted)';
  document.getElementById('twofa-toggle-btn').textContent   = newState ? 'Disable 2FA' : 'Enable 2FA';
  showMsg('twofa-settings-success', newState ? '2FA enabled!' : '2FA disabled.', false);
}

// ── Admin ─────────────────────────────────────

async function loadAdmin() {
  document.getElementById('admin-loading').style.display = 'block';
  document.getElementById('admin-content').classList.add('hidden');
  const res  = await fetch('/api/admin/users');
  if (!res.ok) { document.getElementById('admin-loading').textContent = 'Access denied.'; return; }
  const data = await res.json();
  document.getElementById('admin-loading').style.display = 'none';
  document.getElementById('admin-content').classList.remove('hidden');
  renderAdminTable(data.users || []);
}

function renderAdminTable(users) {
  const tbody = document.getElementById('admin-users-body');
  tbody.innerHTML = users.map(u => `
    <tr>
      <td><strong>${esc(u.username)}</strong></td>
      <td>${esc(u.email)}</td>
      <td>${u.created_at ? fmtDate(u.created_at.split('T')[0]) : '—'}</td>
      <td><span class="badge ${u['2fa_enabled'] ? 'badge-green' : 'badge-red'}">${u['2fa_enabled'] ? 'On' : 'Off'}</span></td>
      <td>${(u.workouts || []).length}</td>
      <td style="white-space:nowrap;">
        <button class="btn-edit" onclick="adminToggle2FA('${u.user_id}',${u['2fa_enabled']})" style="margin-right:4px;">Toggle 2FA</button>
        <button class="btn-ghost" onclick="adminEditEmail('${u.user_id}','${esc(u.email)}')" style="margin-right:4px;font-size:12px;padding:5px 10px;">Email</button>
        <button class="btn-ghost" onclick="adminEditUsername('${u.user_id}','${esc(u.username)}')" style="margin-right:4px;font-size:12px;padding:5px 10px;">Username</button>
        <button class="btn-ghost" onclick="openAdminMetrics('${u.user_id}',${JSON.stringify(u).replace(/'/g,'&#39;')})" style="margin-right:4px;font-size:12px;padding:5px 10px;">Metrics</button>
        <button class="btn-ghost" onclick="toggleAdminWorkouts('${u.user_id}')" style="font-size:12px;padding:5px 10px;">Workouts &#9660;</button>
      </td>
    </tr>
    <tr id="admin-workouts-${u.user_id}" class="admin-expand-row hidden">
      <td colspan="6">
        <div class="admin-expand-inner">${renderAdminWorkouts(u.workouts || [], u.user_id)}</div>
      </td>
    </tr>`).join('');
}

function renderAdminWorkouts(workouts, userId) {
  if (!workouts.length) return '<div style="color:var(--muted);font-size:13px;padding:8px;">No workouts.</div>';
  return `<table class="workout-table" style="font-size:12px;">
    <thead><tr><th>Date</th><th>Exercise</th><th>Sets</th><th>Reps</th><th>Weight</th><th>Duration</th><th>Actions</th></tr></thead>
    <tbody>${workouts.map(w => `<tr>
      <td>${fmtDate(w.date)}</td>
      <td>${esc(w.exercise_name)}</td>
      <td>${w.sets}</td><td>${w.reps}</td><td>${w.weight}</td><td>${w.duration||0}m</td>
      <td>
        <button class="btn-edit" onclick="openAdminEditWorkout('${w.workout_id}')" style="margin-right:4px;font-size:11px;padding:4px 10px;">Edit</button>
        <button class="btn-danger" onclick="adminDeleteWorkout('${w.workout_id}')" style="font-size:11px;padding:4px 10px;">Delete</button>
      </td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function toggleAdminWorkouts(userId) {
  const row = document.getElementById('admin-workouts-' + userId);
  if (row) row.classList.toggle('hidden');
}

async function adminToggle2FA(userId, current) {
  const res  = await fetch(`/api/admin/users/${userId}/toggle-2fa`, { method: 'PUT' });
  const data = await res.json();
  if (!res.ok) { alert(data.error); return; }
  loadAdmin();
}

function adminEditEmail(userId, currentEmail) {
  const newEmail = prompt('New email for this user:', currentEmail);
  if (!newEmail || newEmail === currentEmail) return;
  fetch(`/api/admin/users/${userId}/email`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email: newEmail}) })
    .then(r => r.json()).then(d => { if (d.error) alert(d.error); else loadAdmin(); });
}

function adminEditUsername(userId, current) {
  const newU = prompt('New username:', current);
  if (!newU || newU === current) return;
  fetch(`/api/admin/users/${userId}/username`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({username: newU}) })
    .then(r => r.json()).then(d => { if (d.error) alert(d.error); else loadAdmin(); });
}

function openAdminMetrics(userId, user) {
  if (typeof user === 'string') user = JSON.parse(user);
  document.getElementById('admin-metrics-user-id').value = userId;
  document.getElementById('admin-metrics-age').value     = user.age || '';
  document.getElementById('admin-metrics-weight').value  = user.weight || '';
  document.getElementById('admin-metrics-height').value  = user.height || '';
  document.getElementById('admin-metrics-gender').value  = user.gender || '';
  document.getElementById('admin-metrics-units').value   = user.unit_preference || 'imperial';
  hideMsg('admin-metrics-error');
  document.getElementById('admin-metrics-modal').classList.remove('hidden');
}

async function saveAdminMetrics() {
  const userId = document.getElementById('admin-metrics-user-id').value;
  const payload = {
    age:             parseInt(document.getElementById('admin-metrics-age').value) || null,
    weight:          parseFloat(document.getElementById('admin-metrics-weight').value) || null,
    height:          parseFloat(document.getElementById('admin-metrics-height').value) || null,
    gender:          document.getElementById('admin-metrics-gender').value,
    unit_preference: document.getElementById('admin-metrics-units').value,
  };
  const res  = await fetch(`/api/admin/users/${userId}/metrics`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const data = await res.json();
  if (!res.ok) { showMsg('admin-metrics-error', data.error, true); return; }
  document.getElementById('admin-metrics-modal').classList.add('hidden');
}

let adminEditWorkoutId = null;
function openAdminEditWorkout(id) {
  adminEditWorkoutId = id;
  // Reuse the existing edit modal but override save behavior
  const allAdminWorkouts = [];
  document.querySelectorAll('[id^="admin-workouts-"]').forEach(row => {
    row.querySelectorAll('tr').forEach(tr => {
      const tds = tr.querySelectorAll('td');
      if (tds.length >= 6) {
        const editBtn = tr.querySelector('.btn-edit');
        if (editBtn) {
          const m = editBtn.getAttribute('onclick').match(/'([^']+)'/);
          if (m && m[1] === id) {
            document.getElementById('edit-modal-exercise').value = tds[1]?.textContent || '';
            document.getElementById('edit-modal-sets').value     = tds[2]?.textContent || '';
            document.getElementById('edit-modal-reps').value     = tds[3]?.textContent || '';
            document.getElementById('edit-modal-weight').value   = tds[4]?.textContent || '';
            document.getElementById('edit-modal-duration').value = (tds[5]?.textContent || '').replace('m','');
          }
        }
      }
    });
  });
  document.getElementById('edit-modal-id').value     = id;
  document.getElementById('edit-modal-source').value = 'admin';
  document.getElementById('edit-modal-date').value   = '';
  hideMsg('edit-modal-error');
  document.getElementById('edit-modal').classList.remove('hidden');
}

async function adminDeleteWorkout(workoutId) {
  if (!confirm('Delete this workout?')) return;
  const res = await fetch('/api/admin/workouts/' + workoutId, { method: 'DELETE' });
  if (!res.ok) { alert('Failed to delete workout.'); return; }
  loadAdmin();
}

// Override saveEditModal to handle admin source
const _origSaveEdit = saveEditModal;
async function saveEditModal() {
  const source = document.getElementById('edit-modal-source').value;
  const id     = document.getElementById('edit-modal-id').value;
  if (source === 'admin') {
    hideMsg('edit-modal-error');
    const payload = {
      exercise_name: document.getElementById('edit-modal-exercise').value.trim(),
      sets:     parseInt(document.getElementById('edit-modal-sets').value),
      reps:     parseInt(document.getElementById('edit-modal-reps').value),
      weight:   parseFloat(document.getElementById('edit-modal-weight').value),
      duration: parseInt(document.getElementById('edit-modal-duration').value) || 0,
    };
    const dateVal = document.getElementById('edit-modal-date').value;
    if (dateVal) payload.date = dateVal;
    if (!payload.exercise_name || !payload.sets || !payload.reps) {
      showMsg('edit-modal-error', 'Exercise, sets, and reps are required.', true); return;
    }
    const res = await fetch('/api/admin/workouts/' + id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    if (!res.ok) { const d = await res.json(); showMsg('edit-modal-error', d.error, true); return; }
    closeEditModal();
    loadAdmin();
    return;
  }
  await _origSaveEdit();
}

// ── Escape utility ────────────────────────────

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Init ──────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setTodayDate();
  checkAuth();
});
