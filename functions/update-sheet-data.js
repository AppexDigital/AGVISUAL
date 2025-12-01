<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Centro de Mando | AG Visual Info</title>
    <link rel="icon" type="image/png" href="https://placehold.co/32x32/1a1a1a/FDFDFD?text=AG">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;700&family=Montserrat:wght@400;500;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    
    <style>
        :root { --bg-main: #FDFDFD; --text-dark: #1a1a1a; --text-muted: #52525b; --accent: #3a3a3a; --border-color: #e5e7eb; --status-pending: #f59e0b; --status-confirmed: #10b981; --status-paid: #3b82f6; --status-canceled: #ef4444; }
        body { font-family: 'Montserrat', sans-serif; background-color: var(--bg-main); color: var(--text-dark); }
        h1, h2, h3, .font-display { font-family: 'Cormorant Garamond', serif; }
        
        .loader-circle { width: 50px; height: 50px; border: 4px solid rgba(0,0,0,0.1); border-radius: 50%; border-top-color: var(--accent); animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }

        .btn { padding: 0.5rem 1rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.75rem; transition: all 0.2s; display: inline-flex; align-items: center; gap: 0.5rem; cursor: pointer; border-radius: 4px; }
        .btn-primary { background-color: var(--text-dark); color: white; }
        .btn-primary:hover { background-color: var(--accent); }
        .btn-secondary { border: 1px solid var(--text-dark); color: var(--text-dark); background: transparent; }
        .btn-secondary:hover { background: #f3f4f6; }
        .btn-danger { background-color: #ef4444; color: white; }
        
        .form-input, .form-select, .form-textarea { width: 100%; padding: 0.5rem; border: 1px solid var(--border-color); font-family: 'Montserrat', sans-serif; font-size: 0.9rem; }
        .form-input:focus { border-color: var(--text-dark); outline: none; }
        .form-label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; color: var(--text-muted); margin-bottom: 0.25rem; display: block; }
        .form-checkbox { width: 1rem; height: 1rem; accent-color: var(--text-dark); }

        .sidebar-link { display: flex; align-items: center; padding: 0.75rem 1.5rem; color: var(--text-muted); border-left: 4px solid transparent; transition: all 0.2s; font-size: 0.9rem; }
        .sidebar-link:hover { background-color: #f3f4f6; color: var(--text-dark); }
        .sidebar-link.active { background-color: #f3f4f6; color: var(--text-dark); border-left-color: var(--text-dark); font-weight: 700; }
        .sidebar-link i { width: 1.5rem; text-align: center; margin-right: 0.75rem; }
        
        .view { display: none; animation: fadeIn 0.3s ease-out; }
        .view.active { display: block; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }

        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); display: flex; justify-content: center; align-items: center; z-index: 50; opacity: 0; pointer-events: none; transition: opacity 0.2s; }
        .modal-overlay.visible { opacity: 1; pointer-events: auto; }
        .modal-content { background: white; width: 95%; max-width: 800px; max-height: 90vh; overflow-y: auto; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); transform: scale(0.95); transition: transform 0.2s; border-radius: 8px; }
        .modal-overlay.visible .modal-content { transform: scale(1); }

        .toast { position: fixed; bottom: 2rem; right: 2rem; background: var(--text-dark); color: white; padding: 1rem 1.5rem; z-index: 100; transform: translateY(100px); transition: transform 0.3s; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); font-weight: 600; border-radius: 4px; }
        .toast.visible { transform: translateY(0); }
        .toast.error { background: #ef4444; }
        
        .status-badge { padding: 2px 8px; border-radius: 10px; color: white; font-size: 0.65rem; font-weight: bold; text-transform: uppercase; }
        .status-Pendiente { background: var(--status-pending); }
        .status-Confirmado { background: var(--status-confirmed); }
        .status-Pagado { background: var(--status-paid); }
        .status-Cancelado { background: var(--status-canceled); }

        .portfolio-grid-item { position: relative; aspect-ratio: 1; overflow: hidden; border-radius: 4px; border: 1px solid #eee; background: #f3f4f6; }
        .portfolio-grid-item img { width: 100%; height: 100%; object-fit: cover; }
        .portfolio-grid-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.6); opacity: 0; transition: opacity 0.2s; display: flex; flex-direction: column; justify-content: center; items-center; gap: 10px; }
        .portfolio-grid-item:hover .portfolio-grid-overlay { opacity: 1; }
        .portfolio-badge { position: absolute; top: 5px; right: 5px; background: #10b981; color: white; font-size: 0.6rem; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; font-weight: bold; z-index: 10; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
        .img-preview { width: 60px; height: 60px; object-fit: cover; border: 1px solid #e5e7eb; border-radius: 4px; background-color: #f9fafb; }

        /* Tabs */
        .tab-nav { display: flex; border-bottom: 1px solid var(--border-color); margin-bottom: 1.5rem; }
        .tab-btn { padding: 1rem; color: var(--text-muted); font-weight: 600; border-bottom: 2px solid transparent; transition: all 0.2s; }
        .tab-btn.active { color: var(--text-dark); border-bottom-color: var(--text-dark); }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
    </style>
</head>
<body class="bg-gray-100 h-screen flex flex-col overflow-hidden">

    <div id="loading-screen" class="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-white">
        <div class="loader-circle"></div>
        <p id="loading-text" class="mt-4 font-display text-xl text-text-dark">Cargando Sistema...</p>
    </div>

    <div id="login-screen" class="fixed inset-0 z-50 hidden flex items-center justify-center bg-gray-100">
        <div class="bg-white p-10 shadow-2xl max-w-md w-full text-center border-t-4 border-text-dark">
            <h1 class="font-display text-4xl font-bold mb-2">AG Visual Info</h1>
            <p class="text-text-muted mb-8 uppercase tracking-widest text-xs">Panel de Control</p>
            <button id="google-login-btn" class="w-full bg-[#4285F4] text-white font-bold py-3 px-4 flex items-center justify-center gap-3 hover:bg-[#3367D6] transition-colors shadow-md rounded">
                <i class="fab fa-google"></i> Iniciar con Google Workspace
            </button>
        </div>
    </div>

    <div id="app-screen" class="hidden flex-1 flex h-full overflow-hidden">
        <aside class="w-64 bg-white border-r border-gray-200 flex flex-col flex-shrink-0 shadow-sm z-20">
            <div class="p-6 border-b border-gray-100">
                <h2 class="font-display text-2xl font-bold">AG Admin</h2>
            </div>
            <nav class="flex-1 overflow-y-auto py-4 space-y-1" id="main-nav">
                <a href="#" class="sidebar-link active" data-view="dashboard"><i class="fas fa-home"></i>Inicio</a>
                <a href="#" class="sidebar-link" data-view="projects"><i class="fas fa-camera"></i>Proyectos</a>
                <a href="#" class="sidebar-link" data-view="portfolio-manager"><i class="fas fa-images"></i>Portafolio</a>
                <a href="#" class="sidebar-link" data-view="services"><i class="fas fa-concierge-bell"></i>Servicios</a>
                <a href="#" class="sidebar-link" data-view="rentals"><i class="fas fa-video"></i>Alquiler</a>
                <a href="#" class="sidebar-link" data-view="bookings"><i class="fas fa-calendar-check"></i>Reservas</a>
                <a href="#" class="sidebar-link" data-view="settings"><i class="fas fa-cog"></i>Configuración</a>
            </nav>
            <div class="p-4 border-t border-gray-100">
                <button id="logout-btn" class="w-full text-left px-4 py-2 text-text-muted hover:text-red-600 transition-colors text-xs font-bold uppercase"><i class="fas fa-sign-out-alt mr-2"></i>Salir</button>
            </div>
        </aside>

        <main class="flex-1 overflow-y-auto bg-gray-50 p-8 relative">
            <div id="view-dashboard" class="view active">
                <h1 class="text-4xl font-display font-bold mb-6">Resumen</h1>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div class="bg-white p-6 shadow-sm border border-gray-200 rounded">
                        <h3 class="text-xs text-text-muted uppercase font-bold">Proyectos</h3>
                        <p class="text-4xl font-display font-bold mt-2" id="dash-projects">0</p>
                    </div>
                    <div class="bg-white p-6 shadow-sm border border-gray-200 rounded">
                        <h3 class="text-xs text-text-muted uppercase font-bold">Portafolio</h3>
                        <p class="text-4xl font-display font-bold mt-2" id="dash-portfolio">0</p>
                    </div>
                    <div class="bg-white p-6 shadow-sm border border-gray-200 rounded">
                        <h3 class="text-xs text-text-muted uppercase font-bold">Reservas Pendientes</h3>
                        <p class="text-4xl font-display font-bold mt-2 text-yellow-600" id="dash-bookings">0</p>
                    </div>
                </div>
            </div>

            <div id="view-projects" class="view">
                <div class="flex justify-between items-center mb-6">
                    <h1 class="text-3xl font-display font-bold">Proyectos</h1>
                    <button class="btn btn-primary" onclick="App.handleEditCrudItem('Projects', null)"><i class="fas fa-plus"></i> Nuevo Proyecto</button>
                </div>
                <div class="bg-white shadow-sm border border-gray-200 rounded overflow-hidden">
                    <table class="w-full text-left text-sm">
                        <thead class="bg-gray-50 text-xs uppercase text-text-muted font-bold border-b">
                            <tr><th class="p-4">Orden</th><th class="p-4">Portada</th><th class="p-4">Título</th><th class="p-4">Acciones</th></tr>
                        </thead>
                        <tbody id="projects-table-body" class="divide-y divide-gray-100"></tbody>
                    </table>
                </div>
            </div>

            <div id="view-portfolio-manager" class="view">
                <div class="flex justify-between items-center mb-6">
                    <h1 class="text-3xl font-display font-bold">Portafolio</h1>
                    <button class="btn btn-primary" onclick="App.savePortfolioOrder()"><i class="fas fa-save"></i> Guardar Orden</button>
                </div>
                <p class="text-text-muted mb-6 text-sm">Imágenes seleccionadas para la página principal.</p>
                <div id="portfolio-manager-grid" class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4"></div>
            </div>

            <div id="view-services" class="view">
                <div class="flex justify-between items-center mb-6">
                    <h1 class="text-3xl font-display font-bold">Servicios</h1>
                    <button class="btn btn-primary" onclick="App.handleEditCrudItem('Services', null)"><i class="fas fa-plus"></i> Nuevo</button>
                </div>
                <div class="bg-white shadow-sm border border-gray-200 rounded overflow-hidden">
                    <table class="w-full text-left text-sm"><thead class="bg-gray-50 text-xs uppercase text-text-muted font-bold border-b"><tr><th class="p-4">Orden</th><th class="p-4">Título</th><th class="p-4">Acciones</th></tr></thead><tbody id="services-table-body" class="divide-y divide-gray-100"></tbody></table>
                </div>
            </div>

            <div id="view-rentals" class="view">
                <h1 class="text-3xl font-display font-bold mb-6">Alquiler</h1>
                <div class="tab-nav">
                    <button class="tab-btn active" onclick="UI.switchTab('rental-items')">Equipos</button>
                    <button class="tab-btn" onclick="UI.switchTab('rental-cats')">Categorías</button>
                </div>
                
                <div id="tab-rental-items" class="tab-content active">
                    <div class="flex justify-end mb-4"><button class="btn btn-primary" onclick="App.handleEditCrudItem('RentalItems', null)"><i class="fas fa-plus"></i> Nuevo Equipo</button></div>
                    <div class="bg-white shadow-sm border border-gray-200 rounded overflow-hidden">
                        <table class="w-full text-left text-sm"><thead class="bg-gray-50 text-xs uppercase text-text-muted font-bold border-b"><tr><th class="p-4">Img</th><th class="p-4">Nombre</th><th class="p-4">Categoría</th><th class="p-4">Precio</th><th class="p-4">Acciones</th></tr></thead><tbody id="rental-items-table-body" class="divide-y divide-gray-100"></tbody></table>
                    </div>
                </div>
                
                <div id="tab-rental-cats" class="tab-content">
                    <div class="flex justify-end mb-4"><button class="btn btn-primary" onclick="App.handleEditCrudItem('RentalCategories', null)"><i class="fas fa-plus"></i> Nueva Categoría</button></div>
                    <div class="bg-white shadow-sm border border-gray-200 rounded overflow-hidden">
                        <table class="w-full text-left text-sm"><thead class="bg-gray-50 text-xs uppercase text-text-muted font-bold border-b"><tr><th class="p-4">Orden</th><th class="p-4">Nombre</th><th class="p-4">Acciones</th></tr></thead><tbody id="rental-categories-table-body" class="divide-y divide-gray-100"></tbody></table>
                    </div>
                </div>
            </div>

            <div id="view-bookings" class="view">
                <h1 class="text-3xl font-display font-bold mb-6">Reservas</h1>
                <div class="tab-nav">
                    <button class="tab-btn active" onclick="UI.switchTab('booking-list')">Solicitudes</button>
                    <button class="tab-btn" onclick="UI.switchTab('blocked-dates')">Bloqueos</button>
                </div>
                <div id="tab-booking-list" class="tab-content active">
                     <div class="bg-white shadow-sm border border-gray-200 rounded overflow-hidden">
                        <table class="w-full text-left text-sm"><thead class="bg-gray-50 text-xs uppercase text-text-muted font-bold border-b"><tr><th class="p-4">Fecha</th><th class="p-4">Cliente</th><th class="p-4">Equipo</th><th class="p-4">Total</th><th class="p-4">Estado</th><th class="p-4">Acciones</th></tr></thead><tbody id="bookings-list-body" class="divide-y divide-gray-100"></tbody></table>
                    </div>
                </div>
                <div id="tab-blocked-dates" class="tab-content">
                    <div class="flex justify-end mb-4"><button class="btn btn-primary" onclick="App.handleEditCrudItem('BlockedDates', null)"><i class="fas fa-ban"></i> Nuevo Bloqueo</button></div>
                    <div class="bg-white shadow-sm border border-gray-200 rounded overflow-hidden">
                        <table class="w-full text-left text-sm"><thead class="bg-gray-50 text-xs uppercase text-text-muted font-bold border-b"><tr><th class="p-4">Equipo</th><th class="p-4">Motivo</th><th class="p-4">Desde</th><th class="p-4">Hasta</th><th class="p-4">Acciones</th></tr></thead><tbody id="blocked-dates-table-body" class="divide-y divide-gray-100"></tbody></table>
                    </div>
                </div>
            </div>
            
            <div id="view-settings" class="view">
                <div class="flex justify-between items-center mb-6"><h1 class="text-3xl font-display font-bold">Configuración</h1><button class="btn btn-primary" onclick="App.handleSaveSettings()"><i class="fas fa-save"></i> Guardar</button></div>
                <div id="settings-form-container" class="max-w-3xl space-y-6 bg-white p-6 rounded border border-gray-200"></div>
                <h2 class="text-2xl font-display font-bold mt-10 mb-4">Quién Soy</h2>
                <div id="about-form-container" class="max-w-3xl space-y-6 bg-white p-6 rounded border border-gray-200"></div>
                <div class="mt-4 text-right"><button class="btn btn-primary" onclick="App.handleSaveAbout()"><i class="fas fa-save"></i> Guardar Bio</button></div>
                <h2 class="text-2xl font-display font-bold mt-10 mb-4">Logos Clientes</h2>
                <button class="btn btn-secondary mb-4" onclick="App.handleEditCrudItem('ClientLogos', null)">+ Logo</button>
                <div id="clientlogos-table-body" class="grid grid-cols-2 md:grid-cols-5 gap-4"></div>
            </div>
        </main>
    </div>

    <div id="modal-container"></div>
    <div id="toast-container"></div>
    <script src="https://accounts.google.com/gsi/client" async defer></script>

<script>
const GOOGLE_REDIRECT_URI = 'postmessage';
const AppState = { data: null, token: JSON.parse(localStorage.getItem('gAuthToken') || 'null'), view: 'dashboard' };

const API = {
    async call(endpoint, options = {}, isRetry = false) {
        const headers = new Headers(options.headers || {});
        if (AppState.token?.access_token) headers.set('Authorization', `Bearer ${AppState.token.access_token}`);
        if (options.body && !(options.body instanceof FormData)) {
            headers.set('Content-Type', 'application/json');
            options.body = JSON.stringify(options.body);
        }
        try {
            const res = await fetch(endpoint, { ...options, headers });
            if (res.status === 401 && !isRetry) {
                if (await Auth.refresh()) return API.call(endpoint, options, true);
                else { Auth.logout(); throw new Error('Sesión expirada'); }
            }
            if (!res.ok) throw new Error((await res.json()).error || 'Error servidor');
            return await res.json();
        } catch (e) { throw e; }
    }
};

const Auth = {
    async init() {
        if (AppState.token) {
            if (Date.now() >= AppState.token.expires_at) await this.refresh();
            UI.showApp();
        } else UI.showLogin();
    },
    async login() {
        try {
            const config = await fetch('/.netlify/functions/get-auth-config').then(r => r.json());
            google.accounts.oauth2.initCodeClient({
                client_id: config.clientId,
                scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive',
                callback: (r) => r.code && this.exchangeCode(r.code)
            }).requestCode();
        } catch (e) { alert('Error config: ' + e.message); }
    },
    async exchangeCode(code) {
        UI.showLoading('Autenticando...');
        try {
            const tokens = await fetch('/.netlify/functions/auth-google', { method: 'POST', body: JSON.stringify({ code, redirectUri: GOOGLE_REDIRECT_URI }) }).then(r => r.json());
            if (tokens.error) throw new Error(tokens.error);
            this.setToken(tokens);
            UI.showApp();
        } catch (e) { alert(e.message); UI.showLogin(); }
    },
    async refresh() {
        if (!AppState.token?.refresh_token) return false;
        try {
            const t = await fetch('/.netlify/functions/auth-refresh', { method: 'POST', body: JSON.stringify({ refresh_token: AppState.token.refresh_token }) }).then(r => r.json());
            if (t.error) throw new Error(t.error);
            this.setToken({ ...AppState.token, ...t });
            return true;
        } catch { return false; }
    },
    setToken(t) {
        if (t.expires_in) t.expires_at = Date.now() + (t.expires_in * 1000);
        AppState.token = t;
        localStorage.setItem('gAuthToken', JSON.stringify(t));
    },
    logout() { localStorage.removeItem('gAuthToken'); location.reload(); }
};

const UI = {
    showLogin: () => { document.getElementById('loading-screen').style.display = 'none'; document.getElementById('app-screen').style.display = 'none'; document.getElementById('login-screen').style.display = 'flex'; },
    showApp: async () => {
        document.getElementById('login-screen').style.display = 'none';
        UI.showLoading('Cargando datos...');
        try { await App.loadData(); document.getElementById('loading-screen').style.display = 'none'; document.getElementById('app-screen').style.display = 'flex'; UI.renderView(AppState.view); } 
        catch (e) { alert(e.message); }
    },
    showLoading: (msg) => { document.getElementById('loading-text').innerText = msg; document.getElementById('loading-screen').style.display = 'flex'; },
    hideLoading: () => document.getElementById('loading-screen').style.display = 'none',
    showToast: (msg) => {
        const t = document.createElement('div'); t.className = 'toast'; t.innerText = msg;
        document.getElementById('toast-container').appendChild(t);
        setTimeout(() => t.classList.add('visible'), 10);
        setTimeout(() => t.remove(), 3000);
    },
    switchTab(tabId) {
        const activeView = document.querySelector('.view.active');
        if(!activeView) return;
        activeView.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        activeView.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        const btns = activeView.querySelectorAll('.tab-btn');
        btns.forEach(b => { if(b.getAttribute('onclick').includes(tabId)) b.classList.add('active'); });
        document.getElementById(`tab-${tabId}`).classList.add('active');
    },
    renderView: (view) => {
        AppState.view = view;
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById(`view-${view}`).classList.add('active');
        document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
        document.querySelector(`[data-view="${view}"]`)?.classList.add('active');
        
        const data = AppState.data;
        if (!data) return;

        if (view === 'dashboard') {
            document.getElementById('dash-projects').innerText = (data.Projects || []).length;
            const portfolioCount = (data.ProjectImages || []).filter(i => i.showInPortfolio === 'Si').length;
            document.getElementById('dash-portfolio').innerText = portfolioCount;
            document.getElementById('dash-bookings').innerText = (data.Bookings || []).filter(b => b.status === 'Pendiente').length;
        }
        else if (view === 'projects') {
            document.getElementById('projects-table-body').innerHTML = (data.Projects || []).sort((a,b) => (a.order||99)-(b.order||99)).map(p => {
                const cover = (data.ProjectImages || []).find(i => i.projectId === p.id && i.isCover === 'Si');
                return `<tr class="border-b hover:bg-gray-50">
                    <td class="p-4">${p.order||99}</td>
                    <td class="p-4"><img src="${cover?.imageUrl || 'https://placehold.co/50'}" class="img-preview" referrerpolicy="no-referrer" onerror="this.src='https://placehold.co/50?text=Err'"></td>
                    <td class="p-4 font-bold">${p.title}</td>
                    <td class="p-4 flex gap-2">
                        <button class="text-blue-600" onclick="App.handleEditCrudItem('Projects', '${p.id}')"><i class="fas fa-edit"></i></button>
                        <button class="text-green-600" onclick="App.handleProjectImages('${p.id}', '${p.title.replace(/'/g, "\\'")}')"><i class="fas fa-images"></i></button>
                        <button class="text-red-600" onclick="App.handleDelete('Projects', '${p.id}')"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>`;
            }).join('');
        }
        else if (view === 'portfolio-manager') {
            const images = (data.ProjectImages || []).filter(i => i.showInPortfolio === 'Si').sort((a,b) => (a.portfolioOrder||99)-(b.portfolioOrder||99));
            document.getElementById('portfolio-manager-grid').innerHTML = images.map(i => `
                <div class="portfolio-grid-item group">
                    <img src="${i.imageUrl}" loading="lazy" referrerpolicy="no-referrer" onerror="this.src='https://placehold.co/300?text=Err'">
                    <div class="portfolio-grid-overlay">
                        <input type="number" class="w-16 p-1 text-center text-sm rounded border mb-2 text-black" value="${i.portfolioOrder||99}" onchange="App.updateLocalPortfolioOrder('${i.id}', this.value)">
                        <button class="text-white hover:text-red-400 text-sm" onclick="App.removeFromPortfolio('${i.id}')"><i class="fas fa-times"></i> Quitar</button>
                    </div>
                    <span class="portfolio-badge">${i.portfolioOrder||99}</span>
                </div>
            `).join('');
        }
        else if (view === 'rentals') {
             document.getElementById('rental-items-table-body').innerHTML = (data.RentalItems || []).map(i => {
                const img = (data.RentalItemImages || []).find(im => im.itemId === i.id)?.imageUrl;
                const catName = (data.RentalCategories || []).find(c => c.id === i.categoryId)?.name || 'Sin Categoría';
                return `<tr class="border-b hover:bg-gray-50">
                    <td class="p-4"><img src="${img || 'https://placehold.co/50'}" class="img-preview" referrerpolicy="no-referrer" onerror="this.src='https://placehold.co/50?text=Error'"></td>
                    <td class="p-4 font-bold">${i.name}</td>
                    <td class="p-4 text-sm text-gray-500">${catName}</td>
                    <td class="p-4 font-mono">$${i.pricePerDay}</td>
                    <td class="p-4 flex gap-2">
                        <button class="text-blue-600" onclick="App.handleEditCrudItem('RentalItems', '${i.id}')"><i class="fas fa-edit"></i></button>
                        <button class="text-green-600" onclick="App.handleRentalImages('${i.id}', '${i.name.replace(/'/g, "\\'")}')"><i class="fas fa-images"></i></button>
                        <button class="text-red-600" onclick="App.handleDelete('RentalItems', '${i.id}')"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>`;
             }).join('');
             document.getElementById('rental-categories-table-body').innerHTML = (data.RentalCategories || []).map(c => `
                <tr class="border-b"><td class="p-4">${c.order}</td><td class="p-4 font-bold">${c.name}</td>
                <td class="p-4"><button class="text-blue-600 mr-2" onclick="App.handleEditCrudItem('RentalCategories', '${c.id}')"><i class="fas fa-edit"></i></button>
                <button class="text-red-600" onclick="App.handleDelete('RentalCategories', '${c.id}')"><i class="fas fa-trash"></i></button></td></tr>
             `).join('');
        }
        else if (view === 'settings') {
            const s = (data.Settings || []).reduce((acc, i) => ({...acc, [i.key]: i.value}), {});
            document.getElementById('settings-form-container').innerHTML = `
                ${UI.inputHTML('settings', 'contact_email', 'Email Contacto', s.contact_email)}
                ${UI.inputHTML('settings', 'social_whatsapp', 'WhatsApp Link', s.social_whatsapp)}
                ${UI.inputHTML('settings', 'social_instagram', 'Instagram Link', s.social_instagram)}
                ${UI.imageHTML('settings', 'logo_dark_url', 'Logo Oscuro', s.logo_dark_url)}
                ${UI.imageHTML('settings', 'logo_light_url', 'Logo Claro', s.logo_light_url)}
            `;
            const abt = (data.About || []).reduce((acc, i) => ({...acc, [i.section]: i.content}), {});
            document.getElementById('about-form-container').innerHTML = `
                 ${UI.textareaHTML('about', 'philosophy_p1', 'Filosofía (Párrafo)', abt.philosophy_p1)}
                 ${UI.imageHTML('about', 'profile_image_url', 'Foto de Perfil', abt.profile_image_url)}
            `;
            document.getElementById('clientlogos-table-body').innerHTML = (data.ClientLogos || []).map(c => `
                <div class="bg-white border p-4 flex flex-col items-center relative group">
                    <img src="${c.logoUrl}" class="h-12 object-contain mb-2" referrerpolicy="no-referrer">
                    <span class="font-bold text-sm">${c.clientName}</span>
                    <div class="absolute inset-0 bg-black/50 hidden group-hover:flex items-center justify-center gap-2">
                        <button class="text-white" onclick="App.handleEditCrudItem('ClientLogos', '${c.id}')"><i class="fas fa-edit"></i></button>
                        <button class="text-red-400" onclick="App.handleDelete('ClientLogos', '${c.id}')"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            `).join('');
        }
        else if (view === 'services') {
            document.getElementById('services-table-body').innerHTML = (data.Services || []).sort((a,b)=>(a.order||99)-(b.order||99)).map(s => `
                <tr class="border-b hover:bg-gray-50"><td class="p-4">${s.order||99}</td><td class="p-4 font-bold">${s.title}</td><td class="p-4 flex gap-2">
                <button class="text-blue-600" onclick="App.handleEditCrudItem('Services', '${s.id}')"><i class="fas fa-edit"></i></button>
                <button class="text-red-600" onclick="App.handleDelete('Services', '${s.id}')"><i class="fas fa-trash"></i></button>
                </td></tr>`).join('');
        }
        else if (view === 'bookings') {
            document.getElementById('bookings-list-body').innerHTML = (data.Bookings || []).sort((a,b)=>new Date(b.bookingTimestamp)-new Date(a.bookingTimestamp)).map(b => `
                <tr class="border-b hover:bg-gray-50"><td class="p-4 text-xs">${b.bookingTimestamp.split('T')[0]}</td>
                <td class="p-4 text-sm font-bold">${b.customerName}</td>
                <td class="p-4 text-sm">${b.itemName}</td>
                <td class="p-4 font-mono">$${b.totalPrice}</td>
                <td class="p-4"><span class="status-badge status-${b.status}">${b.status}</span></td>
                <td class="p-4 flex gap-2"><select onchange="App.updateStatus('${b.id}', this.value)" class="border text-xs p-1 rounded"><option value="">Estado...</option><option value="Confirmado">Confirmado</option><option value="Pagado">Pagado</option><option value="Cancelado">Cancelado</option></select>
                <button class="text-red-600 ml-2" onclick="App.handleDelete('Bookings', '${b.id}')"><i class="fas fa-trash"></i></button></td></tr>
            `).join('');
            document.getElementById('blocked-dates-table-body').innerHTML = (data.BlockedDates || []).map(b => {
                 const item = (data.RentalItems||[]).find(i => i.id === b.itemId)?.name || '???';
                 return `<tr class="border-b"><td class="p-4 text-sm font-bold">${item}</td><td class="p-4 text-sm">${b.reason}</td><td class="p-4 text-xs font-mono">${b.startDate}</td><td class="p-4 text-xs font-mono">${b.endDate}</td><td class="p-4 flex gap-2"><button class="text-blue-600" onclick="App.handleEditCrudItem('BlockedDates', '${b.blockId}')"><i class="fas fa-edit"></i></button><button class="text-red-600" onclick="App.handleDelete('BlockedDates', '${b.blockId}', 'blockId')"><i class="fas fa-trash"></i></button></td></tr>`;
            }).join('');
        }
    },

    inputHTML: (p, k, l, v='', t='text') => `<div class="mb-4"><label class="form-label">${l}</label><input type="${t}" id="${p}-${k}" data-key="${k}" class="form-input" value="${v||''}"></div>`,
    textareaHTML: (p, k, l, v='') => `<div class="mb-4"><label class="form-label">${l}</label><textarea id="${p}-${k}" data-key="${k}" class="form-textarea" rows="4">${v||''}</textarea></div>`,
    imageHTML: (p, k, l, v='') => `<div class="mb-4"><label class="form-label">${l}</label><div class="flex gap-2 items-center"><img src="${v||'https://placehold.co/50'}" class="w-12 h-12 object-cover border bg-white" referrerpolicy="no-referrer" onerror="this.src='https://placehold.co/50?text=Err'"><input type="text" id="${p}-${k}" data-key="${k}" class="form-input flex-1" value="${v||''}" readonly><button class="btn btn-secondary" onclick="App.uploadImage('${p}-${k}')">Subir</button></div></div>`,
    showModal: (title, body, footer) => {
        document.getElementById('modal-container').innerHTML = `<div class="modal-overlay visible"><div class="modal-content"><div class="p-6 border-b flex justify-between items-center"><h2 class="text-2xl font-display font-bold">${title}</h2><button onclick="UI.closeModal()" class="text-2xl">&times;</button></div><div class="p-6">${body}</div><div class="p-6 bg-gray-50 text-right">${footer}</div></div></div>`;
    },
    closeModal: () => document.getElementById('modal-container').innerHTML = ''
};

const App = {
    async loadData() { AppState.data = await API.call('/.netlify/functions/get-admin-data'); },
    async handleSaveSettings() { this._saveKeyValueSheet('Settings', 'settings-form-container'); },
    async handleSaveAbout() { this._saveKeyValueSheet('About', 'about-form-container', 'section', 'content'); },
    async _saveKeyValueSheet(sheetName, containerId, keyField='key', valField='value') {
        UI.showLoading('Guardando...');
        const inputs = document.querySelectorAll(`#${containerId} [data-key]`);
        const promises = [];
        inputs.forEach(inp => {
            const k = inp.dataset.key, v = inp.value;
            const existing = (AppState.data[sheetName]||[]).find(i => i[keyField] === k);
            if (!existing || existing[valField] !== v) {
                promises.push(API.call('/.netlify/functions/update-sheet-data', { method: 'POST', body: { sheet: sheetName, action: existing?'update':'add', criteria: {[keyField]: k}, data: {[keyField]: k, [valField]: v} } }));
            }
        });
        await Promise.all(promises); await this.loadData(); UI.hideLoading(); UI.showToast('Guardado');
    },
    async handleEditCrudItem(sheet, id) {
        const isNew = !id;
        const item = isNew ? {} : AppState.data[sheet].find(i => (i.id === id || i.blockId === id));
        let html = '';
        if (sheet === 'Projects') {
            html = `${UI.inputHTML('crud', 'order', 'Orden', item.order, 'number')} ${UI.inputHTML('crud', 'title', 'Título', item.title)} ${UI.textareaHTML('crud', 'description', 'Descripción', item.description)}`;
        } else if (sheet === 'Services') {
            html = `${UI.inputHTML('crud', 'order', 'Orden', item.order, 'number')} ${UI.inputHTML('crud', 'title', 'Título', item.title)} ${UI.inputHTML('crud', 'iconClass', 'Icono FA', item.iconClass)} ${UI.textareaHTML('crud', 'introText', 'Intro', item.introText)}`;
        } else if (sheet === 'RentalItems') {
            const cats = AppState.data.RentalCategories || [];
            const opts = cats.map(c => `<option value="${c.id}" ${item.categoryId===c.id?'selected':''}>${c.name}</option>`).join('');
            html = `${UI.inputHTML('crud', 'order', 'Orden', item.order, 'number')} ${UI.inputHTML('crud', 'name', 'Nombre', item.name)} <div class="mb-4"><label class="form-label">Categoría</label><select id="crud-categoryId" class="form-select">${opts}</select></div> ${UI.inputHTML('crud', 'pricePerDay', 'Precio', item.pricePerDay, 'number')} ${UI.textareaHTML('crud', 'description', 'Desc. Corta', item.description)} ${UI.textareaHTML('crud', 'longDescription', 'Desc. Larga', item.longDescription)}`;
        } else if (sheet === 'RentalCategories') {
            html = `${UI.inputHTML('crud', 'order', 'Orden', item.order, 'number')} ${UI.inputHTML('crud', 'name', 'Nombre', item.name)}`;
        } else if (sheet === 'ClientLogos') {
            html = `${UI.inputHTML('crud', 'order', 'Orden', item.order, 'number')} ${UI.inputHTML('crud', 'clientName', 'Cliente', item.clientName)} ${UI.imageHTML('crud', 'logoUrl', 'Logo', item.logoUrl)}`;
        } else if (sheet === 'BlockedDates') {
             const items = AppState.data.RentalItems || [];
             const opts = items.map(i => `<option value="${i.id}" ${item.itemId===i.id?'selected':''}>${i.name}</option>`).join('');
             html = `<div class="mb-4"><label class="form-label">Equipo</label><select id="crud-itemId" class="form-select">${opts}</select></div> ${UI.inputHTML('crud', 'reason', 'Motivo', item.reason)} ${UI.inputHTML('crud', 'startDate', 'Desde', item.startDate, 'date')} ${UI.inputHTML('crud', 'endDate', 'Hasta', item.endDate, 'date')}`;
        }
        UI.showModal(isNew ? 'Nuevo' : 'Editar', `<form id="crud-form">${html}</form>`, `<button class="btn btn-secondary mr-2" onclick="UI.closeModal()">Cancelar</button><button class="btn btn-primary" onclick="App.saveCrud('${sheet}', '${id}')">Guardar</button>`);
    },
    async saveCrud(sheet, id) {
        const isNew = !id || id === 'null';
        const data = {};
        document.querySelectorAll('#crud-form input, #crud-form textarea, #crud-form select').forEach(el => data[el.id.replace('crud-', '')] = el.value);
        const idField = sheet === 'BlockedDates' ? 'blockId' : 'id';
        if(isNew) data[idField] = `${sheet.toLowerCase().slice(0,4)}_${Date.now()}`;
        UI.showLoading('Guardando...');
        await API.call('/.netlify/functions/update-sheet-data', { method: 'POST', body: { sheet, action: isNew ? 'add' : 'update', criteria: isNew ? null : {[idField]:id}, data } });
        await this.loadData(); UI.closeModal(); UI.renderView(AppState.view); UI.hideLoading();
    },
    async handleDelete(sheet, id, idField='id') {
        if (!confirm('¿Eliminar?')) return;
        UI.showLoading('Eliminando...');
        
        if(sheet === 'Projects') {
            const imgs = (AppState.data.ProjectImages || []).filter(i => i.projectId === id);
            for(const img of imgs) {
                await API.call('/.netlify/functions/update-sheet-data', { method: 'POST', body: { sheet: 'ProjectImages', action: 'delete', criteria: {id: img.id} } });
            }
        }
        if(sheet === 'RentalItems') {
             const imgs = (AppState.data.RentalItemImages || []).filter(i => i.itemId === id);
             for(const img of imgs) {
                await API.call('/.netlify/functions/update-sheet-data', { method: 'POST', body: { sheet: 'RentalItemImages', action: 'delete', criteria: {id: img.id} } });
             }
        }

        await API.call('/.netlify/functions/update-sheet-data', { method: 'POST', body: { sheet, action: 'delete', criteria: { [idField]: id } } });
        await this.loadData(); UI.renderView(AppState.view); UI.hideLoading();
    },
    async handleProjectImages(projectId, title) {
        const images = (AppState.data.ProjectImages || []).filter(i => i.projectId === projectId).sort((a,b) => (a.order||99)-(b.order||99));
        const html = images.map(i => `
            <div class="flex items-center gap-4 p-3 border rounded mb-2 bg-white" data-id="${i.id}">
                <img src="${i.imageUrl}" class="w-16 h-16 object-cover rounded" referrerpolicy="no-referrer" onerror="this.src='https://placehold.co/50?text=Err'">
                <div class="flex-1 grid grid-cols-2 gap-2">
                    <label class="text-xs font-bold text-gray-500">Orden <input type="number" class="border p-1 w-full" value="${i.order||99}" onchange="App.quickUpdate('ProjectImages', '${i.id}', 'order', this.value)"></label>
                    <label class="text-xs font-bold text-gray-500">Pie <input type="text" class="border p-1 w-full" value="${i.caption||''}" onchange="App.quickUpdate('ProjectImages', '${i.id}', 'caption', this.value)"></label>
                </div>
                <div class="flex flex-col gap-2">
                    <label class="flex items-center gap-2 text-xs font-bold cursor-pointer"><input type="checkbox" ${i.isCover==='Si'?'checked':''} onchange="App.quickUpdate('ProjectImages', '${i.id}', 'isCover', this.checked?'Si':'No')"> Portada</label>
                    <label class="flex items-center gap-2 text-xs font-bold cursor-pointer"><input type="checkbox" ${i.showInPortfolio==='Si'?'checked':''} onchange="App.quickUpdate('ProjectImages', '${i.id}', 'showInPortfolio', this.checked?'Si':'No')"> Portafolio</label>
                </div>
                <button class="text-red-500" onclick="App.handleDelete('ProjectImages', '${i.id}')"><i class="fas fa-trash"></i></button>
            </div>
        `).join('');
        UI.showModal(`Imágenes: ${title}`, `<div id="img-list" class="max-h-[60vh] overflow-y-auto mb-4">${html}</div><div class="border-t pt-4"><label class="btn btn-primary w-full text-center cursor-pointer"><i class="fas fa-cloud-upload-alt mr-2"></i> Subir Imágenes<input type="file" multiple accept="image/*" class="hidden" onchange="App.uploadProjectImages(this, '${projectId}', '${title.replace(/'/g, "")}')"></label></div>`, '<button class="btn btn-secondary" onclick="UI.closeModal()">Cerrar</button>');
    },
    async handleRentalImages(itemId, itemName) {
        const images = (AppState.data.RentalItemImages || []).filter(i => i.itemId === itemId).sort((a,b) => (a.order||99)-(b.order||99));
        const html = images.map(i => `<div class="flex items-center gap-4 p-3 border rounded mb-2 bg-white"><img src="${i.imageUrl}" class="w-16 h-16 object-cover rounded" referrerpolicy="no-referrer"><div class="flex-1"><input type="number" class="border p-1 w-20" value="${i.order||99}" onchange="App.quickUpdate('RentalItemImages', '${i.id}', 'order', this.value)"></div><button class="text-red-500" onclick="App.handleDelete('RentalItemImages', '${i.id}')"><i class="fas fa-trash"></i></button></div>`).join('');
        UI.showModal('Imágenes', `<div class="max-h-[60vh] overflow-y-auto mb-4">${html}</div><label class="btn btn-primary w-full text-center cursor-pointer"><i class="fas fa-cloud-upload-alt mr-2"></i> Subir<input type="file" multiple accept="image/*" class="hidden" onchange="App.uploadGenericImages(this, 'RentalItemImages', 'itemId', '${itemId}', '${itemName.replace(/'/g, "")}', 'Rentals')"></label>`, '<button class="btn btn-secondary" onclick="UI.closeModal()">Cerrar</button>');
    },
    async uploadProjectImages(input, projectId, projectTitle) {
        const files = Array.from(input.files); if(!files.length) return;
        for (let i = 0; i < files.length; i++) {
            UI.showLoading(`Subiendo ${i + 1} de ${files.length}...`);
            const formData = new FormData(); formData.append('file', files[i]); 
            formData.append('targetSubfolder', 'Projects');
            formData.append('parentFolderName', projectTitle);
            try {
                const res = await API.call('/.netlify/functions/upload-image', { method: 'POST', body: formData });
                // GUARDAR ID DE CARPETA SI ES NUEVO
                const project = AppState.data.Projects.find(p => p.id === projectId);
                if (project && !project.driveFolderId && res.driveFolderId) {
                    await API.call('/.netlify/functions/update-sheet-data', { method: 'POST', body: { sheet: 'Projects', action: 'update', criteria: {id: projectId}, data: {driveFolderId: res.driveFolderId} } });
                }
                await API.call('/.netlify/functions/update-sheet-data', { method: 'POST', body: { sheet: 'ProjectImages', action: 'add', data: { id: `img_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, projectId, imageUrl: res.imageUrl, fileId: res.fileId, order: 99, isCover: 'No', showInPortfolio: 'No', portfolioOrder: 99 } } });
            } catch (e) { console.error(e); }
        }
        await this.loadData(); UI.hideLoading(); const p = AppState.data.Projects.find(pr => pr.id === projectId); this.handleProjectImages(projectId, p?.title || '');
    },
    async uploadGenericImages(input, sheet, keyField, parentId, parentName, categoryFolder) {
        const files = Array.from(input.files); if(!files.length) return;
        for (let i = 0; i < files.length; i++) {
            UI.showLoading(`Subiendo ${i + 1} de ${files.length}...`);
            const formData = new FormData(); formData.append('file', files[i]); 
            formData.append('targetSubfolder', categoryFolder);
            formData.append('parentFolderName', parentName);
            try {
                const res = await API.call('/.netlify/functions/upload-image', { method: 'POST', body: formData });
                // GUARDAR ID DE CARPETA SI ES NUEVO
                const item = AppState.data[sheet.replace('Images','')].find(i => i.id === parentId); 
                if (item && !item.driveFolderId && res.driveFolderId) {
                    await API.call('/.netlify/functions/update-sheet-data', { method: 'POST', body: { sheet: 'RentalItems', action: 'update', criteria: {id: parentId}, data: {driveFolderId: res.driveFolderId} } });
                }
                await API.call('/.netlify/functions/update-sheet-data', { method: 'POST', body: { sheet, action: 'add', data: { id: `img_${Date.now()}`, [keyField]: parentId, imageUrl: res.imageUrl, fileId: res.fileId, order: 99 } } });
            } catch (e) { console.error(e); }
        }
        await this.loadData(); UI.hideLoading(); this.handleRentalImages(parentId, parentName);
    },
    async quickUpdate(sheet, id, field, val) { 
        const valStr = val === true ? 'Si' : (val === false ? 'No' : val);
        await API.call('/.netlify/functions/update-sheet-data', { method: 'POST', body: { sheet, action: 'update', criteria: {id}, data: {[field]: valStr} } }); 
        
        // Si es portada o portafolio, refrescar todo para ver cambios (como desmarcado automático)
        if (field === 'isCover' || field === 'showInPortfolio') {
             await this.loadData();
             // Re-abrir modal si estamos en imágenes de proyecto
             const item = AppState.data[sheet].find(i => i.id === id);
             if (sheet === 'ProjectImages') {
                 const p = AppState.data.Projects.find(pr => pr.id === item.projectId);
                 this.handleProjectImages(item.projectId, p?.title || '');
                 if(AppState.view === 'portfolio-manager') UI.renderView('portfolio-manager');
             }
        }
    },
    updateLocalPortfolioOrder(id, val) { const img = AppState.data.ProjectImages.find(i => i.id === id); if(img) img.portfolioOrder = val; },
    async savePortfolioOrder() {
        UI.showLoading('Guardando...');
        const images = AppState.data.ProjectImages.filter(i => i.showInPortfolio === 'Si');
        const promises = images.map(i => API.call('/.netlify/functions/update-sheet-data', { method: 'POST', body: { sheet: 'ProjectImages', action: 'update', criteria: {id: i.id}, data: {portfolioOrder: i.portfolioOrder} } }));
        await Promise.all(promises); await this.loadData(); UI.hideLoading(); UI.showToast('Orden actualizado');
    },
    async removeFromPortfolio(id) { if(confirm('¿Quitar?')) { UI.showLoading('Quitando...'); await API.call('/.netlify/functions/update-sheet-data', { method: 'POST', body: { sheet: 'ProjectImages', action: 'update', criteria: {id}, data: {showInPortfolio: 'No'} } }); await this.loadData(); UI.renderView('portfolio-manager'); UI.hideLoading(); } },
    async uploadImage(inputId) {
        const input = document.createElement('input'); input.type = 'file';
        input.onchange = async e => {
            const file = e.target.files[0]; if(!file) return;
            UI.showLoading('Subiendo...');
            const formData = new FormData(); formData.append('file', file); formData.append('targetSubfolder', 'Assets');
            try {
                const res = await API.call('/.netlify/functions/upload-image', { method: 'POST', body: formData });
                document.getElementById(inputId).value = res.imageUrl;
                const preview = document.getElementById(inputId).parentElement.querySelector('img');
                if(preview) preview.src = res.imageUrl;
                UI.hideLoading();
            } catch(err) { alert(err.message); UI.hideLoading(); }
        };
        input.click();
    },
    async updateStatus(id, status) { if(status) { UI.showLoading('Actualizando...'); await API.call('/.netlify/functions/update-sheet-data', { method: 'POST', body: { sheet: 'Bookings', action: 'update', criteria: {id}, data: {status} } }); await this.loadData(); UI.renderView('bookings'); UI.hideLoading(); } }
};

document.getElementById('google-login-btn').addEventListener('click', () => Auth.login());
document.getElementById('logout-btn').addEventListener('click', () => Auth.logout());
document.getElementById('main-nav').addEventListener('click', e => { const link = e.target.closest('.sidebar-link'); if(link) { e.preventDefault(); UI.renderView(link.dataset.view); } });
Auth.init();
</script>
</body>
</html>
