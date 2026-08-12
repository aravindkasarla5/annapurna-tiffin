/* ==========================================================================
   Sri Lakshmi Annapurna Tiffin Center - Single Page Application Engine
   Role-Based Authentication, Live Availability Sync, Ordering & Management
   ========================================================================== */

const API_BASE = '/api';

class TiffinApp {
  constructor() {
    this.currentRole = 'CUSTOMER'; // 'CUSTOMER' or 'OWNER'
    this.currentUser = null; // Logged in user object
    this.authRole = 'CUSTOMER'; // Modal role tab
    this.authMode = 'LOGIN'; // 'LOGIN' or 'REGISTER'
    this.activeView = 'secCustomerHome';
    this.cart = [];
    this.menu = [];
    this.orders = [];
    this.payments = [];
    this.notifications = [];
    this.supportTickets = [];
    this.faqs = [];
    this.activeTicketId = null;
    this.customerTicketFilter = 'All';
    this.ownerTicketFilter = 'All';
    this.ownerOrderFilter = 'ALL'; // 'ALL', 'ACTIVE', 'COMPLETED', 'REJECTED'
    this.ownerPaymentFilter = 'All'; // 'All', 'UPI', 'Cash', 'Verified', 'Pending'
    this.customerPaymentFilter = 'All';
    this.settings = {};
    this.categoryFilter = 'All';
    this.searchQuery = '';
    this.selectedPaymentMethod = 'Cash';
    this.formAvailability = true;
    this.pollingTimer = null;
    this.quantities = {}; // itemId -> count
    this.referralStats = null;
    this.referralLeaderboard = [];
    this.appliedWalletDiscount = 0;

    this.customerProfile = {
      name: 'Ramesh Kumar',
      phone: '+91 98450 12345',
      email: 'ramesh.k@example.com',
      address: '#12, 4th Cross, Gandhi Nagar, Bengaluru, KA'
    };
  }

  async init() {
    console.log('Initializing Annapurna Tiffin Center App...');

    // Restore session from localStorage if available
    const savedUser = localStorage.getItem('tiffin_user');
    if (savedUser) {
      try {
        this.currentUser = JSON.parse(savedUser);
        this.currentRole = this.currentUser.role;
        this.activeView = this.currentRole === 'OWNER' ? 'secOwnerDashboard' : 'secCustomerHome';
      } catch (e) {
        console.error('Failed to parse saved user:', e);
      }
    }

    await this.fetchSettings();
    await this.fetchMenu();
    await this.fetchOrders();
    await this.fetchPayments();
    await this.fetchNotifications();
    await this.fetchFaqs();
    await this.fetchSupportTickets();
    this.fetchStats();

    this.updateUserAuthBadgeUI();
    this.renderNavigation();
    this.renderCurrentView();
    this.updateCartUI();

    // Start 2-second live polling engine for real-time status and availability sync
    this.startPolling();
  }

  startPolling() {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    this.pollingTimer = setInterval(async () => {
      await this.fetchMenu(true);
      await this.fetchOrders(true);
      await this.fetchNotifications(true);
      await this.fetchSupportTickets(true);
      if (this.currentRole === 'OWNER') {
        this.fetchStats(true);
        this.fetchPayments(true);
      }
    }, 2000);
  }

  // =========================================================================
  // API FETCHERS
  // =========================================================================

  async fetchSettings() {
    try {
      const res = await fetch(`${API_BASE}/settings`);
      const json = await res.json();
      if (json.success) {
        this.settings = json.data;
        this.updateHeaderAndSettingsUI();
      }
    } catch (err) {
      console.error('Error fetching settings:', err);
    }
  }

  async fetchMenu(silent = false) {
    try {
      const res = await fetch(`${API_BASE}/menu`);
      const json = await res.json();
      if (json.success) {
        this.menu = json.data;
        if (!silent || this.activeView === 'secCustomerHome' || this.activeView === 'secOwnerTiffins') {
          this.renderMenu();
        }
      }
    } catch (err) {
      console.error('Error fetching menu:', err);
    }
  }

  async fetchOrders(silent = false) {
    try {
      const res = await fetch(`${API_BASE}/orders`);
      const json = await res.json();
      if (json.success) {
        this.orders = json.data;
        if (!silent || this.activeView.includes('Orders') || this.activeView === 'secOwnerDashboard') {
          this.renderOrders();
        }
      }
    } catch (err) {
      console.error('Error fetching orders:', err);
    }
  }

  async fetchPayments(silent = false) {
    try {
      let url = `${API_BASE}/payments`;
      if (this.currentRole === 'CUSTOMER' && this.currentUser) {
        url += `?role=CUSTOMER&customer_mobile=${encodeURIComponent(this.currentUser.mobile)}`;
      }
      const res = await fetch(url);
      const json = await res.json();
      if (json.success) {
        this.payments = json.data;
        if (!silent || this.activeView === 'secOwnerPayments') {
          this.renderPayments();
        }
        if (!silent || this.activeView === 'secCustomerPayments') {
          this.renderCustomerPayments();
        }
      }
    } catch (err) {
      console.error('Error fetching payments:', err);
    }
  }

  async fetchNotifications(silent = false) {
    try {
      const res = await fetch(`${API_BASE}/notifications?role=${this.currentRole}`);
      const json = await res.json();
      if (json.success) {
        const oldUnreadCount = this.notifications.filter(n => !n.is_read).length;
        this.notifications = json.data;
        const newUnreadCount = this.notifications.filter(n => !n.is_read).length;

        // Show toast if new notification arrived
        if (silent && newUnreadCount > oldUnreadCount && this.notifications.length > 0) {
          const newest = this.notifications[0];
          this.showToast(newest.message, 'info');
        }

        this.renderNotificationsUI();
      }
    } catch (err) {
      console.error('Error fetching notifications:', err);
    }
  }

  async fetchStats(silent = false) {
    try {
      const res = await fetch(`${API_BASE}/stats`);
      const json = await res.json();
      if (json.success && json.data) {
        const s = json.data;
        const elTotal = document.getElementById('statTodayOrders');
        const elActive = document.getElementById('statPendingOrders');
        const elCompleted = document.getElementById('statCompletedOrders');
        const elRejected = document.getElementById('statRejectedOrders');
        const elSales = document.getElementById('statTodaySales');

        if (elTotal) elTotal.innerText = s.total_orders;
        if (elActive) elActive.innerText = s.active_orders;
        if (elCompleted) elCompleted.innerText = s.completed_orders;
        if (elRejected) elRejected.innerText = s.rejected_orders;
        if (elSales) elSales.innerText = `₹${s.total_sales.toLocaleString('en-IN')}`;
      }
    } catch (err) {
      console.error('Error fetching stats:', err);
    }
  }

  // =========================================================================
  // AUTHENTICATION & ROLE MANAGEMENT
  // =========================================================================

  openAuthModal(role = 'CUSTOMER', mode = 'LOGIN') {
    this.authRole = role;
    this.authMode = mode;
    this.switchAuthRole(role);
    this.setAuthMode(mode);
    this.toggleAuthModal(true);
  }

  toggleAuthModal(open = true) {
    document.getElementById('authModalBackdrop').classList.toggle('open', open);
  }

  switchAuthRole(role) {
    this.authRole = role;
    document.getElementById('btnTabCustomerAuth').classList.toggle('active', role === 'CUSTOMER');
    document.getElementById('btnTabOwnerAuth').classList.toggle('active', role === 'OWNER');

    const secKeyGrp = document.getElementById('grpSecretKey');
    if (secKeyGrp) secKeyGrp.classList.toggle('hidden', role !== 'OWNER');

    const btnLoginSubmit = document.getElementById('btnLoginSubmit');
    const btnRegisterSubmit = document.getElementById('btnRegisterSubmit');

    if (btnLoginSubmit) {
      btnLoginSubmit.innerHTML = `<span>Login as ${role === 'CUSTOMER' ? 'Customer' : 'Hotel Owner'}</span> <i class="fa-solid fa-arrow-right"></i>`;
    }
    if (btnRegisterSubmit) {
      btnRegisterSubmit.innerHTML = `<span>Create ${role === 'CUSTOMER' ? 'Customer' : 'Hotel Owner'} Account</span> <i class="fa-solid fa-user-plus"></i>`;
    }
  }

  setAuthMode(mode) {
    this.authMode = mode;
    const card = document.getElementById('authModalCard');
    const btnLogin = document.getElementById('btnAuthModeLogin');
    const btnRegister = document.getElementById('btnAuthModeRegister');

    if (card) {
      card.classList.toggle('mode-login', mode === 'LOGIN');
      card.classList.toggle('mode-register', mode === 'REGISTER');
    }

    if (btnLogin) btnLogin.classList.toggle('active', mode === 'LOGIN');
    if (btnRegister) btnRegister.classList.toggle('active', mode === 'REGISTER');

    document.getElementById('authLoginForm').classList.toggle('hidden', mode !== 'LOGIN');
    document.getElementById('authRegisterForm').classList.toggle('hidden', mode !== 'REGISTER');
  }

  fillDemoAccount(role) {
    this.switchAuthRole(role);
    this.setAuthMode('LOGIN');

    if (role === 'CUSTOMER') {
      document.getElementById('loginMobile').value = '9845012345';
      document.getElementById('loginPassword').value = 'customer123';
    } else {
      document.getElementById('loginMobile').value = '9876543210';
      document.getElementById('loginPassword').value = 'owner123';
    }

    this.showToast(`Filled ${role === 'CUSTOMER' ? 'Customer' : 'Hotel Owner'} demo credentials`, 'info');
  }

  async handleLoginSubmit(e) {
    e.preventDefault();
    const mobile = document.getElementById('loginMobile').value;
    const password = document.getElementById('loginPassword').value;

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile, password, role: this.authRole })
      });
      const json = await res.json();

      if (json.success) {
        this.currentUser = json.user;
        this.currentRole = json.user.role;
        localStorage.setItem('tiffin_user', JSON.stringify(json.user));

        if (this.currentRole === 'CUSTOMER') {
          this.customerProfile = {
            name: json.user.name,
            phone: json.user.mobile,
            email: json.user.email || '',
            address: json.user.address || ''
          };
        }

        this.showToast(json.message, 'success');
        this.toggleAuthModal(false);
        this.updateUserAuthBadgeUI();

        this.activeView = this.currentRole === 'OWNER' ? 'secOwnerDashboard' : 'secCustomerHome';
        this.renderNavigation();
        this.renderCurrentView();
        await this.fetchNotifications();
        await this.fetchSupportTickets(true);
      } else {
        this.showToast(json.message || 'Login failed', 'error');
      }
    } catch (err) {
      console.error('Error logging in:', err);
      this.showToast('Server communication error.', 'error');
    }
  }

  async handleRegisterSubmit(e) {
    e.preventDefault();
    const name = document.getElementById('regName').value;
    const mobile = document.getElementById('regMobile').value;
    const password = document.getElementById('regPassword').value;
    const email = document.getElementById('regEmail').value;
    const address = document.getElementById('regAddress').value;
    const secret_key = document.getElementById('regSecretKey')?.value;
    const referral_code = document.getElementById('regReferralCode')?.value.trim();

    const payload = {
      name, mobile, password, role: this.authRole, email, address, secret_key, referral_code
    };

    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();

      if (json.success) {
        this.currentUser = json.user;
        this.currentRole = json.user.role;
        localStorage.setItem('tiffin_user', JSON.stringify(json.user));

        this.showToast(json.message, 'success');
        this.toggleAuthModal(false);
        this.updateUserAuthBadgeUI();

        this.activeView = this.currentRole === 'OWNER' ? 'secOwnerDashboard' : 'secCustomerHome';
        this.renderNavigation();
        this.renderCurrentView();
      } else {
        this.showToast(json.message || 'Registration failed', 'error');
      }
    } catch (err) {
      console.error('Error registering:', err);
      this.showToast('Server communication error.', 'error');
    }
  }

  logout() {
    this.currentUser = null;
    this.currentRole = 'CUSTOMER';
    localStorage.removeItem('tiffin_user');

    this.showToast('Logged out successfully.', 'info');
    this.updateUserAuthBadgeUI();
    this.activeView = 'secCustomerHome';
    this.renderNavigation();
    this.renderCurrentView();
  }

  updateUserAuthBadgeUI() {
    const lbl = document.getElementById('lblLoggedInUser');
    const btnLogin = document.getElementById('btnLoginHeader');
    const btnRegister = document.getElementById('btnRegisterHeader');
    const btnLogout = document.getElementById('btnLogoutHeader');
    const btnCart = document.getElementById('btnCart');
    const btnNotif = document.getElementById('btnNotifications');
    const bannerGreeting = document.getElementById('bannerGreeting');

    if (this.currentUser) {
      if (lbl) {
        lbl.classList.remove('hidden');
        lbl.innerHTML = `
          <div class="user-greeting-badge">
            <div class="greeting-avatar">
              <i class="${this.currentUser.role === 'OWNER' ? 'fa-solid fa-user-shield' : 'fa-solid fa-user'}"></i>
            </div>
            <div class="greeting-info">
              <span class="greeting-name">${this.currentUser.name}</span>
              <span class="greeting-role">${this.currentUser.role === 'OWNER' ? 'Hotel Owner' : 'Customer'}</span>
            </div>
          </div>
        `;
      }
      if (btnLogin) btnLogin.classList.add('hidden');
      if (btnRegister) btnRegister.classList.add('hidden');
      if (btnLogout) btnLogout.classList.remove('hidden');

      if (bannerGreeting) {
        bannerGreeting.innerText = `Welcome back, ${this.currentUser.name}! 🍲`;
      }

      // SHOW Bell & Cart icons ONLY when logged in!
      if (btnNotif) btnNotif.classList.remove('hidden');
      if (btnCart) {
        if (this.currentUser.role === 'CUSTOMER') {
          btnCart.classList.remove('hidden');
        } else {
          btnCart.classList.add('hidden');
        }
      }
    } else {
      if (lbl) {
        lbl.classList.add('hidden');
        lbl.innerHTML = '';
      }
      if (btnLogin) btnLogin.classList.remove('hidden');
      if (btnRegister) btnRegister.classList.remove('hidden');
      if (btnLogout) btnLogout.classList.add('hidden');

      if (bannerGreeting) {
        bannerGreeting.innerText = `Welcome to Annapurna Tiffin Center! 🍲`;
      }

      // HIDE Bell & Cart icons for Guests!
      if (btnNotif) btnNotif.classList.add('hidden');
      if (btnCart) btnCart.classList.add('hidden');
    }
  }

  renderNavigation() {
    const desktopSidebar = document.querySelector('.desktop-sidebar');
    const mobileNav = document.getElementById('mobileBottomNav');
    const btnMobileToggle = document.getElementById('btnMobileMenuToggle');

    // HIDE Sidebar, Mobile Bottom Nav, and Mobile Menu Toggle when NOT logged in (Guest mode)!
    if (!this.currentUser) {
      document.body.classList.add('guest-mode');
      if (desktopSidebar) desktopSidebar.classList.add('hidden');
      if (mobileNav) mobileNav.classList.add('hidden');
      if (btnMobileToggle) btnMobileToggle.classList.add('hidden');
      return;
    }

    // ENABLE & SHOW Sidebar, Mobile Bottom Nav, and Mobile Menu Toggle when logged in!
    document.body.classList.remove('guest-mode');
    if (desktopSidebar) desktopSidebar.classList.remove('hidden');
    if (mobileNav) mobileNav.classList.remove('hidden');
    if (btnMobileToggle) btnMobileToggle.classList.remove('hidden');

    const isCustomer = this.currentRole === 'CUSTOMER';

    // Update Sidebar Navigation
    const desktopNav = document.getElementById('desktopSidebarNav');
    if (desktopNav) {
      document.getElementById('sidebarRoleLabel').innerText = isCustomer ? 'CUSTOMER DASHBOARD' : 'HOTEL OWNER / ADMIN';

      if (isCustomer) {
        desktopNav.innerHTML = `
          <a class="nav-item ${this.activeView === 'secCustomerHome' ? 'active' : ''}" onclick="app.switchView('secCustomerHome')"><i class="fa-solid fa-house"></i> Customer Home</a>
          <a class="nav-item ${this.activeView === 'secCustomerHome' ? 'active' : ''}" onclick="app.switchView('secCustomerHome')"><i class="fa-solid fa-utensils"></i> Today's Menu</a>
          <a class="nav-item" onclick="app.toggleCartDrawer()"><i class="fa-solid fa-cart-shopping"></i> Shopping Cart (<span class="cart-count-text">0</span>)</a>
          <a class="nav-item ${this.activeView === 'secCustomerOrders' ? 'active' : ''}" onclick="app.switchView('secCustomerOrders')"><i class="fa-solid fa-receipt"></i> My Orders</a>
          <a class="nav-item ${this.activeView === 'secCustomerPayments' ? 'active' : ''}" onclick="app.switchView('secCustomerPayments')"><i class="fa-solid fa-wallet"></i> Payment History</a>
          <a class="nav-item ${this.activeView === 'secCustomerReferral' ? 'active' : ''}" onclick="app.switchView('secCustomerReferral')"><i class="fa-solid fa-gift" style="color: var(--accent-gold);"></i> Refer & Earn</a>
          <a class="nav-item ${this.activeView === 'secCustomerSupport' ? 'active' : ''}" onclick="app.switchView('secCustomerSupport')"><i class="fa-solid fa-headset"></i> Support & FAQs</a>
          <a class="nav-item ${this.activeView === 'secCustomerProfile' ? 'active' : ''}" onclick="app.switchView('secCustomerProfile')"><i class="fa-solid fa-user-gear"></i> My Profile</a>
        `;
      } else {
        desktopNav.innerHTML = `
          <a class="nav-item ${this.activeView === 'secOwnerDashboard' ? 'active' : ''}" onclick="app.switchView('secOwnerDashboard')"><i class="fa-solid fa-chart-line"></i> Dashboard</a>
          <a class="nav-item ${this.activeView === 'secOwnerTiffins' ? 'active' : ''}" onclick="app.switchView('secOwnerTiffins')"><i class="fa-solid fa-utensils"></i> Manage Tiffins</a>
          <a class="nav-item ${this.activeView === 'secOwnerOrders' ? 'active' : ''}" onclick="app.switchView('secOwnerOrders')"><i class="fa-solid fa-list-check"></i> Orders Management</a>
          <a class="nav-item ${this.activeView === 'secOwnerPayments' ? 'active' : ''}" onclick="app.switchView('secOwnerPayments')"><i class="fa-solid fa-wallet"></i> Payment History</a>
          <a class="nav-item ${this.activeView === 'secOwnerSupport' ? 'active' : ''}" onclick="app.switchView('secOwnerSupport')"><i class="fa-solid fa-headset"></i> Support Inbox</a>
          <a class="nav-item ${this.activeView === 'secOwnerSettings' ? 'active' : ''}" onclick="app.switchView('secOwnerSettings')"><i class="fa-solid fa-sliders"></i> Business Settings</a>
        `;
      }
    }

    // Update Mobile Bottom Navigation Bar
    if (mobileNav) {
      const cartCount = this.cart.reduce((acc, c) => acc + c.quantity, 0);
      if (isCustomer) {
        mobileNav.innerHTML = `
          <a class="bottom-nav-item ${this.activeView === 'secCustomerHome' ? 'active' : ''}" onclick="app.switchView('secCustomerHome')">
            <i class="fa-solid fa-house"></i> <span>Home</span>
          </a>
          <a class="bottom-nav-item ${this.activeView === 'secCustomerOrders' ? 'active' : ''}" onclick="app.switchView('secCustomerOrders')">
            <i class="fa-solid fa-receipt"></i> <span>Orders</span>
          </a>
          <a class="bottom-nav-item" onclick="app.toggleCartDrawer()">
            <i class="fa-solid fa-cart-shopping"></i> <span>Cart</span>
            <span class="badge ${cartCount > 0 ? '' : 'hidden'}" id="mobileCartBadgeCount">${cartCount}</span>
          </a>
          <a class="bottom-nav-item ${this.activeView === 'secCustomerPayments' ? 'active' : ''}" onclick="app.switchView('secCustomerPayments')">
            <i class="fa-solid fa-wallet"></i> <span>Payments</span>
          </a>
          <a class="bottom-nav-item ${this.activeView === 'secCustomerProfile' ? 'active' : ''}" onclick="app.switchView('secCustomerProfile')">
            <i class="fa-solid fa-user"></i> <span>Profile</span>
          </a>
        `;
      } else {
        mobileNav.innerHTML = `
          <a class="bottom-nav-item ${this.activeView === 'secOwnerDashboard' ? 'active' : ''}" onclick="app.switchView('secOwnerDashboard')">
            <i class="fa-solid fa-chart-line"></i> <span>Dashboard</span>
          </a>
          <a class="bottom-nav-item ${this.activeView === 'secOwnerOrders' ? 'active' : ''}" onclick="app.switchView('secOwnerOrders')">
            <i class="fa-solid fa-list-check"></i> <span>Orders</span>
          </a>
          <a class="bottom-nav-item ${this.activeView === 'secOwnerSupport' ? 'active' : ''}" onclick="app.switchView('secOwnerSupport')">
            <i class="fa-solid fa-headset"></i> <span>Support</span>
          </a>
          <a class="bottom-nav-item ${this.activeView === 'secOwnerPayments' ? 'active' : ''}" onclick="app.switchView('secOwnerPayments')">
            <i class="fa-solid fa-wallet"></i> <span>Payments</span>
          </a>
          <a class="bottom-nav-item ${this.activeView === 'secOwnerSettings' ? 'active' : ''}" onclick="app.switchView('secOwnerSettings')">
            <i class="fa-solid fa-sliders"></i> <span>Settings</span>
          </a>
        `;
      }
    }
  }

  switchView(viewId) {
    // Access Control Guard - Require login for features
    if (!this.currentUser) {
      if (viewId === 'secCustomerOrders' || viewId === 'secCustomerPayments' || viewId === 'secCustomerReferral') {
        this.showToast('Please Login or Register to view orders, payments & referral rewards.', 'error');
        this.openAuthModal('CUSTOMER', 'LOGIN');
        return;
      }
      if (viewId === 'secCustomerProfile') {
        this.showToast('Please Login or Register to access your profile.', 'error');
        this.openAuthModal('CUSTOMER', 'LOGIN');
        return;
      }
      if (viewId.startsWith('secOwner')) {
        this.showToast('Hotel Owner authentication required.', 'error');
        this.openAuthModal('OWNER', 'LOGIN');
        return;
      }
    } else if (this.currentUser.role === 'CUSTOMER' && viewId.startsWith('secOwner')) {
      this.showToast('Access denied: Hotel Owner login required.', 'error');
      this.openAuthModal('OWNER', 'LOGIN');
      return;
    } else if (this.currentUser.role === 'OWNER' && viewId.startsWith('secCustomer') && viewId !== 'secCustomerHome' && viewId !== 'secCustomerSupport') {
      this.showToast('Hotel Owner account active. Switch to Customer account to order.', 'info');
      this.activeView = 'secOwnerDashboard';
      this.renderNavigation();
      this.renderCurrentView();
      return;
    }

    this.activeView = viewId;
    this.renderNavigation();
    this.renderCurrentView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  renderCurrentView() {
    // Hide all view sections
    document.querySelectorAll('.view-section').forEach(sec => sec.classList.add('hidden'));

    // Show target section
    const target = document.getElementById(this.activeView);
    if (target) {
      target.classList.remove('hidden');
    }

    // Site Footer is ONLY visible for Home screen ('secCustomerHome')
    const footer = document.querySelector('.app-footer');
    if (footer) {
      footer.classList.toggle('hidden', this.activeView !== 'secCustomerHome');
    }

    // Trigger render logic per view
    if (this.activeView === 'secCustomerHome') this.renderMenu();
    if (this.activeView === 'secCustomerOrders') this.renderOrders();
    if (this.activeView === 'secCustomerPayments') {
      this.fetchPayments();
      this.renderCustomerPayments();
    }
    if (this.activeView === 'secCustomerReferral') {
      this.fetchReferralStats();
      this.fetchLeaderboard();
    }
    if (this.activeView === 'secCustomerSupport') {
      this.fetchSupportTickets();
      this.renderFaqs();
    }
    if (this.activeView === 'secOwnerDashboard') {
      this.fetchStats();
      this.renderOrders();
    }
    if (this.activeView === 'secOwnerTiffins') this.renderMenu();
    if (this.activeView === 'secOwnerOrders') this.renderOrders();
    if (this.activeView === 'secOwnerPayments') {
      this.fetchPayments();
      this.renderPayments();
    }
    if (this.activeView === 'secOwnerSupport') this.fetchSupportTickets();
    if (this.activeView === 'secOwnerSettings') this.populateSettingsForm();
  }

  // =========================================================================
  // MENU RENDER & TIFFIN MANAGEMENT
  // =========================================================================

  filterCategory(category) {
    this.categoryFilter = category;
    document.querySelectorAll('#categoryTabs .tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.innerText.includes(category) || (category === 'All' && btn.innerText.includes('All')));
    });
    this.renderMenu();
  }

  filterMenu() {
    this.searchQuery = (document.getElementById('searchInput')?.value || '').toLowerCase();
    this.renderMenu();
  }

  renderMenu() {
    let filtered = this.menu.filter(item => {
      const matchCat = this.categoryFilter === 'All' || item.category === this.categoryFilter;
      const matchSearch = !this.searchQuery || item.name.toLowerCase().includes(this.searchQuery) || item.description.toLowerCase().includes(this.searchQuery);
      return matchCat && matchSearch;
    });

    if (this.currentRole === 'CUSTOMER') {
      const container = document.getElementById('customerMenuGrid');
      if (!container) return;

      if (!filtered.length) {
        container.innerHTML = `
          <div style="grid-column: 1 / -1; text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
            <i class="fa-solid fa-bowl-food" style="font-size: 2.5rem; margin-bottom: 0.5rem;"></i>
            <p>No tiffin items match your search or filter.</p>
          </div>`;
        return;
      }

      container.innerHTML = filtered.map(item => {
        const qty = this.quantities[item.id] || 1;
        const isAvailable = item.is_available;

        return `
          <div class="food-card ${!isAvailable ? 'unavailable' : ''}">
            <div class="food-card-img-wrapper">
              <img src="${item.image}" alt="${item.name}" class="food-card-img" onerror="this.src='/images/idly_sambar.png'">
              <span class="availability-badge ${isAvailable ? 'available' : 'unavailable'}">
                <i class="fa-solid fa-circle" style="font-size: 0.5rem;"></i> ${isAvailable ? 'Available' : 'Not Available'}
              </span>
              <span class="category-tag">${item.category}</span>
            </div>

            <div class="food-card-body">
              <h3 class="food-card-title">${item.name}</h3>
              <p class="food-card-desc">${item.description}</p>

              <div class="food-card-footer">
                <span class="food-card-price">₹${item.price}</span>

                ${isAvailable ? `
                  <div class="qty-selector">
                    <button class="qty-btn" onclick="app.changeItemQty('${item.id}', -1)">-</button>
                    <span class="qty-val" id="qty_${item.id}">${qty}</span>
                    <button class="qty-btn" onclick="app.changeItemQty('${item.id}', 1)">+</button>
                  </div>
                  <button class="btn-add-cart" onclick="app.addToCart('${item.id}')">
                    <i class="fa-solid fa-cart-plus"></i> Add
                  </button>
                ` : `
                  <button class="btn-add-cart" disabled>
                    🔴 Not Available
                  </button>
                `}
              </div>
            </div>
          </div>
        `;
      }).join('');
    } else {
      // Hotel Owner Tiffin Management Grid
      const container = document.getElementById('ownerTiffinGrid');
      if (!container) return;

      container.innerHTML = filtered.map(item => {
        return `
          <div class="food-card">
            <div class="food-card-img-wrapper">
              <img src="${item.image}" alt="${item.name}" class="food-card-img" onerror="this.src='/images/idly_sambar.png'">
              <span class="category-tag">${item.category}</span>
            </div>

            <div class="food-card-body">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.25rem;">
                <h3 class="food-card-title">${item.name}</h3>
                <span class="food-card-price">₹${item.price}</span>
              </div>
              <p class="food-card-desc">${item.description}</p>

              <!-- Live Availability Toggle Switch -->
              <div style="background: var(--bg-surface-elevated); padding: 8px 12px; border-radius: var(--radius-md); display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;">
                <span style="font-size: 0.78rem; font-weight: 600; color: var(--text-muted);">AVAILABILITY</span>
                <div class="availability-switch ${item.is_available ? 'active' : ''}" onclick="app.toggleItemAvailability('${item.id}', ${!item.is_available})">
                  <div class="switch-track">
                    <div class="switch-thumb"></div>
                  </div>
                  <span style="font-size: 0.75rem; font-weight: 700;">${item.is_available ? '🟢 AVAILABLE' : '🔴 NOT AVAILABLE'}</span>
                </div>
              </div>

              <div style="display: flex; gap: 0.5rem; margin-top: auto;">
                <button class="role-btn" onclick="app.openEditTiffinModal('${item.id}')" style="flex: 1; justify-content: center; padding: 6px; border: 1px solid var(--border-color);">
                  <i class="fa-solid fa-pen"></i> Edit
                </button>
                <button class="role-btn" onclick="app.deleteTiffin('${item.id}')" style="flex: 1; justify-content: center; padding: 6px; border: 1px solid var(--color-unavailable); color: var(--color-unavailable);">
                  <i class="fa-solid fa-trash"></i> Delete
                </button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  changeItemQty(itemId, delta) {
    const current = this.quantities[itemId] || 1;
    const next = Math.max(1, current + delta);
    this.quantities[itemId] = next;
    const el = document.getElementById(`qty_${itemId}`);
    if (el) el.innerText = next;
  }

  // =========================================================================
  // SHOPPING CART & CHECKOUT
  // =========================================================================

  addToCart(itemId) {
    if (!this.currentUser) {
      this.showToast('Please Login or Register to add items to cart & order food!', 'error');
      this.openAuthModal('CUSTOMER', 'LOGIN');
      return;
    }

    const item = this.menu.find(m => m.id === itemId);
    if (!item || !item.is_available) {
      this.showToast('Item is currently unavailable.', 'error');
      return;
    }

    const qty = this.quantities[itemId] || 1;
    const existing = this.cart.find(c => c.id === itemId);

    if (existing) {
      existing.quantity += qty;
    } else {
      this.cart.push({
        id: item.id,
        name: item.name,
        price: item.price,
        image: item.image,
        quantity: qty
      });
    }

    this.quantities[itemId] = 1;
    this.updateCartUI();
    this.showToast(`Added ${qty}x ${item.name} to cart!`, 'success');
  }

  updateCartUI() {
    const badge = document.getElementById('cartBadgeCount');
    const mobileBadge = document.getElementById('mobileCartBadgeCount');
    const totalCount = this.cart.reduce((acc, c) => acc + c.quantity, 0);

    if (totalCount > 0) {
      if (badge) { badge.innerText = totalCount; badge.classList.remove('hidden'); }
      if (mobileBadge) { mobileBadge.innerText = totalCount; mobileBadge.classList.remove('hidden'); }
    } else {
      if (badge) badge.classList.add('hidden');
      if (mobileBadge) mobileBadge.classList.add('hidden');
    }

    document.querySelectorAll('.cart-count-text').forEach(el => el.innerText = totalCount);

    const container = document.getElementById('cartItemsContainer');
    if (!container) return;

    if (!this.cart.length) {
      container.innerHTML = `
        <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
          <i class="fa-solid fa-cart-flatbed" style="font-size: 2.5rem; margin-bottom: 0.5rem;"></i>
          <p>Your shopping cart is empty.</p>
        </div>`;
      document.getElementById('cartSubtotal').innerText = '₹0';
      document.getElementById('cartGrandTotal').innerText = '₹0';
      return;
    }

    let subtotal = 0;
    container.innerHTML = this.cart.map(item => {
      const itemTotal = item.price * item.quantity;
      subtotal += itemTotal;
      return `
        <div class="cart-item">
          <img src="${item.image}" alt="${item.name}" class="cart-item-img" onerror="this.src='/images/idly_sambar.png'">
          <div class="cart-item-details">
            <div class="cart-item-title">${item.name}</div>
            <div class="cart-item-price">₹${item.price} x ${item.quantity} = ₹${itemTotal}</div>
          </div>
          <div class="qty-selector" style="transform: scale(0.85);">
            <button class="qty-btn" onclick="app.updateCartItemQty('${item.id}', -1)">-</button>
            <span class="qty-val">${item.quantity}</span>
            <button class="qty-btn" onclick="app.updateCartItemQty('${item.id}', 1)">+</button>
          </div>
          <button class="cart-item-remove" onclick="app.removeCartItem('${item.id}')" title="Remove Item"><i class="fa-solid fa-trash"></i></button>
        </div>
      `;
    }).join('');

    document.getElementById('cartSubtotal').innerText = `₹${subtotal}`;
    document.getElementById('cartGrandTotal').innerText = `₹${subtotal}`;
    document.getElementById('checkoutGrandTotalDisplay').innerText = `₹${subtotal}`;
  }

  updateCartItemQty(itemId, delta) {
    const item = this.cart.find(c => c.id === itemId);
    if (!item) return;
    item.quantity += delta;
    if (item.quantity <= 0) {
      this.cart = this.cart.filter(c => c.id !== itemId);
    }
    this.updateCartUI();
  }

  removeCartItem(itemId) {
    this.cart = this.cart.filter(c => c.id !== itemId);
    this.updateCartUI();
  }

  toggleCartDrawer(open = null) {
    if (!this.currentUser) {
      this.showToast('Please Login or Register to access shopping cart & order food.', 'error');
      this.openAuthModal('CUSTOMER', 'LOGIN');
      return;
    }

    const drawer = document.getElementById('cartDrawer');
    const overlay = document.getElementById('cartOverlay');
    const isOpen = open !== null ? open : !drawer.classList.contains('open');

    drawer.classList.toggle('open', isOpen);
    overlay.classList.toggle('open', isOpen);
  }

  openOrderCheckoutModal() {
    if (!this.cart.length) {
      this.showToast('Your cart is empty!', 'error');
      return;
    }
    if (!this.settings.is_open) {
      this.showToast('Hotel is currently closed. Orders are not being accepted.', 'error');
      return;
    }

    this.toggleCartDrawer(false);
    document.getElementById('ordCustomerName').value = this.customerProfile.name || '';
    document.getElementById('ordCustomerMobile').value = this.customerProfile.phone || '';
    const addrInput = document.getElementById('ordDeliveryAddress');
    if (addrInput) addrInput.value = this.customerProfile.address || '';

    // Dynamically load shopkeeper's uploaded QR code scanner image & UPI ID
    if (this.settings) {
      const qrImg = document.getElementById('checkoutQrScannerImg');
      if (qrImg && this.settings.upi_qr_code) {
        qrImg.src = this.settings.upi_qr_code;
      }
      const upiDisplay = document.getElementById('checkoutUpiIdDisplay');
      if (upiDisplay && this.settings.upi_id) {
        upiDisplay.innerText = this.settings.upi_id;
      }
    }

    this.handleCheckoutOrderTypeChange();
    this.toggleCheckoutModal(true);
  }

  handleCheckoutOrderTypeChange() {
    const type = document.getElementById('ordType')?.value;
    const label = document.getElementById('ordDeliveryAddressLabel');
    const input = document.getElementById('ordDeliveryAddress');
    if (!label || !input) return;

    if (type === 'Dine-in') {
      label.innerHTML = `<i class="fa-solid fa-utensils" style="color: var(--primary);"></i> Table Number / Dining Area <span style="color: var(--primary);">*</span>`;
      input.placeholder = "e.g. Table No. 4, Ground Floor AC Section...";
    } else if (type === 'Takeaway') {
      label.innerHTML = `<i class="fa-solid fa-box" style="color: var(--primary);"></i> Pickup Notes / Time <span style="color: var(--primary);">*</span>`;
      input.placeholder = "e.g. Self pickup at counter around 8:00 PM...";
    } else {
      label.innerHTML = `<i class="fa-solid fa-location-dot" style="color: var(--primary);"></i> Delivery Address / Location Details <span style="color: var(--primary);">*</span>`;
      input.placeholder = "House/Flat No, Building, Street, Landmark, Area details...";
      if (!input.value && this.customerProfile.address) {
        input.value = this.customerProfile.address;
      }
    }
  }

  toggleCheckoutModal(open = true) {
    const backdrop = document.getElementById('checkoutModalBackdrop');
    backdrop.classList.toggle('open', open);
  }

  selectPaymentMethod(method) {
    this.selectedPaymentMethod = method;
    document.getElementById('optPayCash').classList.toggle('selected', method === 'Cash');
    document.getElementById('optPayUPI').classList.toggle('selected', method === 'UPI');
    document.getElementById('upiQrBox').classList.toggle('hidden', method !== 'UPI');
  }

  handleCustomerScreenshotUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      this.showToast('Screenshot file size must be less than 5MB', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = (evt) => {
      this.tempPaymentScreenshot = evt.target.result;
      const previewImg = document.getElementById('screenshotPreviewImg');
      const wrapper = document.getElementById('screenshotPreviewWrapper');
      const fileNameSpan = document.getElementById('screenshotFileName');
      if (previewImg) previewImg.src = evt.target.result;
      if (wrapper) wrapper.classList.remove('hidden');
      if (fileNameSpan) fileNameSpan.innerText = file.name;
    };
    reader.readAsDataURL(file);
  }

  removeCustomerScreenshot() {
    this.tempPaymentScreenshot = null;
    const fileInput = document.getElementById('ordPaymentScreenshot');
    if (fileInput) fileInput.value = '';
    const wrapper = document.getElementById('screenshotPreviewWrapper');
    if (wrapper) wrapper.classList.add('hidden');
    const fileNameSpan = document.getElementById('screenshotFileName');
    if (fileNameSpan) fileNameSpan.innerText = 'No file selected';
  }

  handleOwnerQrUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      this.tempOwnerQrCode = evt.target.result;
      const previewImg = document.getElementById('setQrPreviewImg');
      if (previewImg) previewImg.src = evt.target.result;
      this.showToast('New QR Scanner image loaded! Click Save Settings to update.', 'info');
    };
    reader.readAsDataURL(file);
  }

  copyUpiId() {
    const upiId = document.getElementById('checkoutUpiIdDisplay')?.innerText || 'annapurna.tiffin@upi';
    navigator.clipboard.writeText(upiId).then(() => {
      this.showToast(`UPI ID "${upiId}" copied to clipboard!`, 'success');
    }).catch(() => {
      this.showToast(`UPI ID: ${upiId}`, 'info');
    });
  }

  viewFullScreenshot(src) {
    const lightbox = document.getElementById('lightboxModalBackdrop');
    const img = document.getElementById('lightboxImg');
    if (lightbox && img) {
      img.src = src;
      lightbox.classList.add('open');
    }
  }

  closeLightbox() {
    const lightbox = document.getElementById('lightboxModalBackdrop');
    if (lightbox) lightbox.classList.remove('open');
  }

  async verifyOrderPayment(orderId, newStatus) {
    try {
      const res = await fetch(`${API_BASE}/orders/${orderId}/payment-verify`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_status: newStatus })
      });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message, 'success');
        await this.fetchOrders();
      } else {
        this.showToast(json.message || 'Failed to update payment status', 'error');
      }
    } catch (err) {
      console.error('Error verifying payment:', err);
    }
  }

  async submitCustomerOrder(e) {
    e.preventDefault();

    const name = document.getElementById('ordCustomerName').value;
    const mobile = document.getElementById('ordCustomerMobile').value;
    const orderType = document.getElementById('ordType').value;
    const deliveryAddress = document.getElementById('ordDeliveryAddress')?.value.trim();
    const notes = document.getElementById('ordNotes').value;
    const utrNumber = document.getElementById('ordUTRNumber')?.value.trim();

    if (this.selectedPaymentMethod === 'UPI') {
      if (!this.tempPaymentScreenshot) {
        this.showToast('Please upload your UPI payment screenshot to complete order.', 'error');
        return;
      }
      if (!utrNumber || utrNumber.length < 5) {
        this.showToast('Please enter your 12-digit UTR or Transaction Ref Number.', 'error');
        return;
      }
    }

    const payload = {
      customer_name: name,
      customer_mobile: mobile,
      order_type: orderType,
      delivery_address: deliveryAddress || (orderType === 'Delivery' ? (this.customerProfile.address || 'Home Delivery') : 'Counter Pickup'),
      notes: notes,
      payment_method: this.selectedPaymentMethod,
      payment_screenshot: this.tempPaymentScreenshot || '',
      utr_number: utrNumber || '',
      used_wallet_amount: this.appliedWalletDiscount || 0,
      items: this.cart
    };

    try {
      const res = await fetch(`${API_BASE}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();

      if (json.success) {
        this.cart = [];
        this.tempPaymentScreenshot = null;
        this.updateCartUI();
        this.toggleCheckoutModal(false);

        // Show Celebration Modal with Order Number
        document.getElementById('confirmedOrderNumDisplay').innerText = `#${json.data.order_number}`;
        document.getElementById('confirmationModalBackdrop').classList.add('open');

        await this.fetchOrders();
        await this.fetchNotifications();
      } else {
        this.showToast(json.message || 'Error placing order.', 'error');
      }
    } catch (err) {
      console.error('Error submitting order:', err);
      this.showToast('Server communication error.', 'error');
    }
  }

  closeConfirmationAndTrack() {
    document.getElementById('confirmationModalBackdrop').classList.remove('open');
    this.switchView('secCustomerOrders');
  }

  // =========================================================================
  // ORDERS RENDER & OWNER ORDER ACTIONS
  // =========================================================================

  setOwnerOrderFilter(filter) {
    this.ownerOrderFilter = filter;

    // Update active tab buttons on dashboard and orders page
    const tabs = ['ALL', 'ACTIVE', 'COMPLETED', 'REJECTED'];
    tabs.forEach(t => {
      const dbgBtn = document.getElementById(`tabFilter${t.charAt(0) + t.slice(1).toLowerCase()}`);
      const mgmtBtn = document.getElementById(`tabMgmtFilter${t.charAt(0) + t.slice(1).toLowerCase()}`);
      const isActive = t === filter;
      if (dbgBtn) dbgBtn.classList.toggle('active', isActive);
      if (mgmtBtn) mgmtBtn.classList.toggle('active', isActive);
    });

    this.renderOrders();
  }

  renderSalesAnalytics() {
    if (!this.orders) return;

    const allOrders = this.orders;
    const activeOrders = allOrders.filter(o => ['Received', 'Preparing', 'Ready'].includes(o.order_status));
    const completedOrders = allOrders.filter(o => o.order_status === 'Completed');
    const rejectedOrders = allOrders.filter(o => ['Rejected', 'Cancelled'].includes(o.order_status));
    const validOrders = allOrders.filter(o => !['Rejected', 'Cancelled'].includes(o.order_status));

    // Stats values
    const totalSales = validOrders.reduce((acc, o) => acc + (Number(o.grand_total) || 0), 0);
    const avgOrderVal = validOrders.length ? Math.round(totalSales / validOrders.length) : 0;

    // Update KPI grid numbers
    const elTotalOrders = document.getElementById('statTodayOrders');
    const elActiveOrders = document.getElementById('statPendingOrders');
    const elCompletedOrders = document.getElementById('statCompletedOrders');
    const elRejectedOrders = document.getElementById('statRejectedOrders');
    const elTotalSales = document.getElementById('statTodaySales');
    const elAov = document.getElementById('statAovVal');

    if (elTotalOrders) elTotalOrders.innerText = allOrders.length;
    if (elActiveOrders) elActiveOrders.innerText = activeOrders.length;
    if (elCompletedOrders) elCompletedOrders.innerText = completedOrders.length;
    if (elRejectedOrders) elRejectedOrders.innerText = rejectedOrders.length;
    if (elTotalSales) elTotalSales.innerText = `₹${totalSales.toLocaleString('en-IN')}`;
    if (elAov) elAov.innerText = `₹${avgOrderVal}`;

    // Update Tab Pill Counts
    const updateCount = (id, count) => {
      const el = document.getElementById(id);
      if (el) el.innerText = count;
    };
    updateCount('cntTabAll', allOrders.length);
    updateCount('cntTabActive', activeOrders.length);
    updateCount('cntTabCompleted', completedOrders.length);
    updateCount('cntTabRejected', rejectedOrders.length);

    updateCount('cntMgmtTabAll', allOrders.length);
    updateCount('cntMgmtTabActive', activeOrders.length);
    updateCount('cntMgmtTabCompleted', completedOrders.length);
    updateCount('cntMgmtTabRejected', rejectedOrders.length);

    // Payment Distribution: UPI vs Cash
    let upiTotal = 0;
    let cashTotal = 0;
    validOrders.forEach(o => {
      if ((o.payment_method || '').includes('UPI') || (o.payment_method || '').includes('Online')) {
        upiTotal += Number(o.grand_total) || 0;
      } else {
        cashTotal += Number(o.grand_total) || 0;
      }
    });

    const grandTotal = upiTotal + cashTotal || 1;
    const upiPct = Math.round((upiTotal / grandTotal) * 100);
    const cashPct = 100 - upiPct;

    const elUpiVal = document.getElementById('upiSalesVal');
    const elCashVal = document.getElementById('cashSalesVal');
    const elUpiBar = document.getElementById('upiSalesBar');
    const elCashBar = document.getElementById('cashSalesBar');

    if (elUpiVal) elUpiVal.innerText = `₹${upiTotal.toLocaleString('en-IN')}`;
    if (elCashVal) elCashVal.innerText = `₹${cashTotal.toLocaleString('en-IN')}`;
    if (elUpiBar) elUpiBar.style.width = `${upiPct}%`;
    if (elCashBar) elCashBar.style.width = `${cashPct}%`;

    // Order Type Distribution
    const delCount = validOrders.filter(o => o.order_type === 'Delivery').length;
    const takCount = validOrders.filter(o => o.order_type === 'Takeaway').length;
    const dinCount = validOrders.filter(o => o.order_type === 'Dine-in').length;

    updateCount('countDeliveryOrders', delCount);
    updateCount('countTakeawayOrders', takCount);
    updateCount('countDineinOrders', dinCount);

    // Top Selling Tiffins Analysis
    const itemStatsMap = {};
    validOrders.forEach(o => {
      (o.items || []).forEach(i => {
        const name = i.name;
        if (!itemStatsMap[name]) {
          itemStatsMap[name] = { name: name, count: 0, revenue: 0 };
        }
        itemStatsMap[name].count += Number(i.quantity);
        itemStatsMap[name].revenue += Number(i.price) * Number(i.quantity);
      });
    });

    const sortedItems = Object.values(itemStatsMap).sort((a, b) => b.count - a.count).slice(0, 4);
    const topContainer = document.getElementById('topSellingItemsContainer');
    if (topContainer) {
      if (!sortedItems.length) {
        topContainer.innerHTML = `<p style="font-size: 0.8rem; color: var(--text-muted); padding: 0.5rem 0;">No sales data available yet.</p>`;
      } else {
        const maxCount = sortedItems[0].count || 1;
        topContainer.innerHTML = sortedItems.map(item => {
          const barWidth = Math.round((item.count / maxCount) * 100);
          return `
            <div style="background: rgba(255,255,255,0.02); padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border-color);">
              <div style="display: flex; justify-content: space-between; font-size: 0.82rem; font-weight: 700; margin-bottom: 4px;">
                <span style="color: #FFF;"><i class="fa-solid fa-utensils" style="color: var(--primary);"></i> ${item.name}</span>
                <span style="color: var(--accent-gold);">${item.count} orders (₹${item.revenue.toLocaleString('en-IN')})</span>
              </div>
              <div style="height: 6px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden;">
                <div style="height: 100%; width: ${barWidth}%; background: linear-gradient(90deg, var(--primary), var(--accent-gold)); border-radius: 3px;"></div>
              </div>
            </div>
          `;
        }).join('');
      }
    }
  }

  renderOrders() {
    if (this.currentRole === 'CUSTOMER') {
      const container = document.getElementById('customerOrdersList');
      if (!container) return;

      if (!this.orders.length) {
        container.innerHTML = `
          <div style="text-align: center; padding: 4rem 1rem; color: var(--text-muted); background: var(--bg-surface); border-radius: var(--radius-lg); border: 1.5px dashed var(--border-color);">
            <div style="width: 70px; height: 70px; border-radius: 50%; background: rgba(234, 162, 33, 0.15); color: var(--accent-gold); display: flex; align-items: center; justify-content: center; font-size: 2rem; margin: 0 auto 1rem auto;">
              <i class="fa-solid fa-receipt"></i>
            </div>
            <h3 style="color: var(--text-main); font-size: 1.2rem; margin-bottom: 0.5rem;">No Active Orders Placed Yet</h3>
            <p style="font-size: 0.9rem; max-width: 400px; margin: 0 auto 1.25rem auto;">Explore our hot, fresh South Indian tiffins menu and place your first delicious order!</p>
            <button class="btn-primary-block" onclick="app.switchView('secCustomerHome')" style="max-width: 220px; margin: 0 auto;">
              <i class="fa-solid fa-utensils"></i> Browse Menu Now
            </button>
          </div>`;
        return;
      }

      container.innerHTML = this.orders.map(order => {
        return this.createCustomerOrderCardHTML(order);
      }).join('');
    } else {
      // First update sales analytics & KPI numbers
      this.renderSalesAnalytics();

      // Apply owner order filter
      let filtered = this.orders;
      if (this.ownerOrderFilter === 'ACTIVE') {
        filtered = this.orders.filter(o => ['Received', 'Preparing', 'Ready'].includes(o.order_status));
      } else if (this.ownerOrderFilter === 'COMPLETED') {
        filtered = this.orders.filter(o => o.order_status === 'Completed');
      } else if (this.ownerOrderFilter === 'REJECTED') {
        filtered = this.orders.filter(o => ['Rejected', 'Cancelled'].includes(o.order_status));
      }

      // Owner Dashboard Orders List
      const dashContainer = document.getElementById('ownerDashboardOrdersList');
      if (dashContainer) {
        if (!filtered.length) {
          dashContainer.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-muted); background: var(--bg-surface-elevated); border-radius: var(--radius-md); border: 1px dashed var(--border-color);">No ${this.ownerOrderFilter.toLowerCase()} orders found.</div>`;
        } else {
          dashContainer.innerHTML = filtered.map(order => this.createOwnerOrderCardHTML(order)).join('');
        }
      }

      // Owner All Orders Management Page
      const listContainer = document.getElementById('ownerOrdersList');
      if (listContainer) {
        if (!filtered.length) {
          listContainer.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-muted); background: var(--bg-surface-elevated); border-radius: var(--radius-md); border: 1px dashed var(--border-color);">No ${this.ownerOrderFilter.toLowerCase()} orders found.</div>`;
        } else {
          listContainer.innerHTML = filtered.map(order => this.createOwnerOrderCardHTML(order)).join('');
        }
      }
    }
  }

  createOwnerOrderCardHTML(order) {
    const dateFormatted = new Date(order.created_at).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    const isRejected = order.order_status === 'Rejected' || order.order_status === 'Cancelled';
    const isReceived = order.order_status === 'Received';
    const isPreparing = order.order_status === 'Preparing';
    const isReady = order.order_status === 'Ready';
    const isCompleted = order.order_status === 'Completed';

    let statusColor = '#EAA221';
    let statusIcon = 'fa-clock';
    let statusLabel = 'Received';
    if (isPreparing) { statusColor = '#29B6F6'; statusIcon = 'fa-fire-burner'; statusLabel = 'Preparing'; }
    if (isReady) { statusColor = '#66BB6A'; statusIcon = 'fa-bell-concierge'; statusLabel = 'Ready'; }
    if (isCompleted) { statusColor = '#4CAF50'; statusIcon = 'fa-circle-check'; statusLabel = 'Completed'; }
    if (isRejected) { statusColor = '#E53935'; statusIcon = 'fa-circle-xmark'; statusLabel = 'Order Rejected'; }

    let stepIdx = 0;
    if (isPreparing) stepIdx = 1;
    if (isReady) stepIdx = 2;
    if (isCompleted) stepIdx = 3;
    const progressPct = Math.round((stepIdx / 3) * 100);

    const typeIcon = order.order_type === 'Takeaway' ? 'fa-box' : order.order_type === 'Delivery' ? 'fa-motorcycle' : 'fa-utensils';
    const isPaid = order.payment_status.includes('Paid') || order.payment_status.includes('Verified');
    const isPendingPayment = order.payment_status.includes('Pending') || order.payment_status.includes('Verification');

    return `
      <div class="co-row-card owner-mode ${isRejected ? 'is-rejected' : ''}">
        ${isRejected ? `
          <!-- OWNER REJECTED BANNER -->
          <div style="background: rgba(229, 57, 53, 0.15); border: 1.5px solid #E53935; padding: 10px 14px; border-radius: var(--radius-md); color: #FF5252; display: flex; align-items: center; gap: 12px; margin-bottom: 0.25rem;">
            <i class="fa-solid fa-circle-xmark" style="font-size: 1.3rem; color: #E53935;"></i>
            <div>
              <strong style="font-size: 0.92rem; color: #FFF; display: block;">This Order Was Rejected</strong>
              <span style="font-size: 0.78rem; color: #FF8A80;">Status: Order Rejected • No further kitchen action required.</span>
            </div>
          </div>
        ` : ''}

        <!-- 1. TOP HEADER BAR: Order #, Customer Contact, Date, Badges & Grand Total -->
        <div class="co-card-top-bar">
          <div class="co-top-left" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span class="co-row-num"><i class="fa-solid fa-receipt" style="color: var(--accent-gold);"></i> Order #${order.order_number}</span>
            <span class="co-row-type"><i class="fa-solid ${typeIcon}"></i> ${order.order_type}</span>
            <span class="co-row-status-badge" style="border-color: ${statusColor}; color: ${statusColor};">
              <i class="fa-solid ${statusIcon}"></i> ${statusLabel}
            </span>
            <button type="button" class="btn-sm-status" onclick="app.deleteOrder('${order.id}')" style="background: rgba(229,57,53,0.16); color: #FF5252; border: 1px solid rgba(229,57,53,0.4); padding: 3px 9px; border-radius: 6px; font-weight: 700; font-size: 0.74rem; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Delete order record permanently">
              <i class="fa-solid fa-trash-can"></i> Delete
            </button>
            <span class="co-row-date"><i class="fa-regular fa-clock"></i> ${dateFormatted}</span>
          </div>

          <div class="co-top-right">
            <div class="co-payment-status-block">
              <span class="co-pay-title-label"><i class="fa-solid fa-credit-card" style="color: var(--accent-gold);"></i> Payment Status:</span>
              <span class="co-row-pay-pill ${isPaid ? 'paid' : 'pending'}">
                <i class="fa-solid ${isPaid ? 'fa-circle-check' : 'fa-hourglass-half'}"></i> ${order.payment_status} (${order.payment_method})
              </span>
            </div>
            <div class="co-total-amount-block">
              <span class="co-total-title-label">Total Amount</span>
              <span class="co-row-total-val">₹${order.grand_total}</span>
            </div>
          </div>
        </div>

        <!-- CUSTOMER CONTACT & DELIVERY LOCATION BAR FOR OWNER -->
        <div style="background: rgba(217, 83, 30, 0.08); padding: 10px 14px; border-radius: var(--radius-md); border: 1px solid rgba(217, 83, 30, 0.3); font-size: 0.84rem;">
          <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 6px;">
            <span style="font-size: 0.78rem; font-weight: 800; color: var(--primary); text-transform: uppercase; letter-spacing: 0.5px;">
              <i class="fa-solid fa-location-dot"></i> Delivery / Service Address Details
            </span>
            <span style="font-size: 0.74rem; font-weight: 700; color: var(--accent-gold);">
              <i class="fa-solid ${typeIcon}"></i> ${order.order_type}
            </span>
          </div>

          <div style="font-size: 0.92rem; font-weight: 700; color: #FFFFFF; line-height: 1.4; margin-bottom: 6px; background: rgba(0,0,0,0.25); padding: 8px 12px; border-radius: 6px; border-left: 3px solid var(--primary);">
            ${order.delivery_address || (order.order_type === 'Delivery' ? 'Home Delivery Address' : order.order_type === 'Dine-in' ? 'Dine-in Table' : 'Counter Pickup')}
          </div>

          <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: 0.78rem; color: var(--text-muted);">
            <div>
              <i class="fa-solid fa-user" style="color: var(--primary);"></i> Customer: <strong style="color: #FFF;">${order.customer_name}</strong>
              <span style="margin: 0 6px;">•</span>
              <i class="fa-solid fa-phone" style="color: var(--accent-gold);"></i> Call: <a href="tel:${order.customer_mobile}" style="color: var(--accent-gold); font-weight: 800; text-decoration: none;">${order.customer_mobile}</a>
            </div>
            <div>
              <i class="fa-solid fa-clock"></i> Placed: ${new Date(order.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
        </div>

        <!-- 2. MIDDLE SECTION: ORDER DETAILS AND KITCHEN ACTIONS SIDE BY SIDE -->
        <div class="co-middle-side-by-side">
          <!-- Left: Order Details Box (Items list line-by-line) -->
          <div class="co-order-details-box">
            <div class="co-order-details-title">
              <i class="fa-solid fa-utensils" style="color: var(--primary);"></i> Ordered Items (${(order.items || []).reduce((s, i) => s + Number(i.quantity), 0)} items)
            </div>
            <div class="co-order-details-list">
              ${(order.items || []).map(i => `
                <div class="co-item-line">
                  <div class="co-item-left-info">
                    <span class="co-qty-badge">${i.quantity}x</span>
                    <span class="co-item-name">${i.name}</span>
                  </div>
                  <span class="co-item-price">₹${Number(i.price) * Number(i.quantity)}</span>
                </div>
              `).join('')}
            </div>

            ${order.notes ? `<div class="co-order-notes"><i class="fa-solid fa-note-sticky"></i> Note: "${order.notes}"</div>` : ''}

            <!-- UTR & Screenshot Verification Box for Owner -->
            ${order.utr_number || order.payment_screenshot ? `
              <div style="margin-top: 0.75rem; padding: 10px; background: rgba(10, 10, 14, 0.5); border-radius: 8px; border: 1px solid var(--accent-gold); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: 0.78rem;">
                ${order.utr_number ? `
                  <div style="color: var(--accent-gold); font-weight: 700;">
                    <i class="fa-solid fa-receipt"></i> UTR Ref: <code style="background: rgba(255,255,255,0.1); padding: 2px 8px; border-radius: 4px; color: #FFF; font-family: monospace; font-size: 0.85rem;">${order.utr_number}</code>
                  </div>
                ` : ''}
                ${order.payment_screenshot ? `
                  <button type="button" class="btn-sm-status" onclick="app.viewFullScreenshot('${order.payment_screenshot}')" style="background: rgba(234, 162, 33, 0.2); color: var(--accent-gold); border: 1px solid var(--accent-gold); padding: 4px 12px; border-radius: 12px; font-size: 0.75rem; font-weight: 700; cursor: pointer;">
                    <i class="fa-solid fa-camera"></i> View Uploaded Screenshot
                  </button>
                ` : ''}
              </div>
            ` : ''}
          </div>

          <!-- Right: KITCHEN & ORDER ACTIONS Panel -->
          <div class="co-actions-panel">
            <div class="co-actions-title"><i class="fa-solid fa-fire-burner" style="color: var(--accent-gold);"></i> Kitchen Operations</div>
            <div class="co-row-actions owner-actions" style="display: flex; flex-direction: column; gap: 8px;">
              ${isRejected ? `
                <div style="background: rgba(229,57,53,0.15); border: 1px solid #E53935; padding: 10px; border-radius: 8px; text-align: center; color: #FF5252; font-weight: 800; font-size: 0.82rem;">
                  <i class="fa-solid fa-ban"></i> ORDER REJECTED
                </div>
              ` : ''}

              ${isReceived ? `
                <button class="co-row-btn-action accept" onclick="app.updateOrderStatus('${order.id}', 'Preparing')">
                  <i class="fa-solid fa-fire-burner"></i> Accept & Start Preparing
                </button>
                <button class="co-row-btn-action reject" onclick="app.updateOrderStatus('${order.id}', 'Rejected')">
                  <i class="fa-solid fa-xmark"></i> Reject Order
                </button>
              ` : ''}

              ${isPreparing ? `
                <button class="co-row-btn-action ready" onclick="app.updateOrderStatus('${order.id}', 'Ready')">
                  <i class="fa-solid fa-bell-concierge"></i> Mark Ready for Serving
                </button>
              ` : ''}

              ${isReady ? `
                <button class="co-row-btn-action complete" onclick="app.updateOrderStatus('${order.id}', 'Completed')">
                  <i class="fa-solid fa-circle-check"></i> Mark Order Completed
                </button>
              ` : ''}

              ${isPendingPayment && !isRejected ? `
                <div style="display: flex; gap: 6px; margin-top: 4px;">
                  <button type="button" class="btn-sm-status" onclick="app.verifyOrderPayment('${order.id}', 'Paid (UPI Verified)')" style="background: rgba(76,175,80,0.2); color: #4CAF50; border: 1px solid #4CAF50; padding: 6px; border-radius: 6px; font-weight: 800; font-size: 0.75rem; cursor: pointer; flex: 1; text-align: center;">
                    <i class="fa-solid fa-check"></i> Verify Paid
                  </button>
                  <button type="button" class="btn-sm-status" onclick="app.verifyOrderPayment('${order.id}', 'Payment Failed')" style="background: rgba(229,57,53,0.2); color: #E53935; border: 1px solid #E53935; padding: 6px; border-radius: 6px; font-weight: 800; font-size: 0.75rem; cursor: pointer; flex: 1; text-align: center;">
                    <i class="fa-solid fa-xmark"></i> Reject Pay
                  </button>
                </div>
              ` : ''}

              <div style="display: flex; gap: 6px; margin-top: 4px;">
                <button class="co-row-btn view" onclick="app.showOrderDetail('${order.order_number}')" style="flex: 1;">
                  <i class="fa-solid fa-eye"></i> View Details
                </button>
                <button class="co-row-btn receipt" onclick="app.downloadOrderReceipt('${order.order_number}')" style="flex: 1;">
                  <i class="fa-solid fa-print"></i> KOT / Receipt
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 3. BOTTOM SECTION: LIVE ORDER TRACKING STEPPER -->
        <div class="co-bottom-tracking">
          <div class="co-track-head-bar">
            <span><i class="fa-solid fa-route" style="color: var(--accent-gold);"></i> ${isRejected ? 'Kitchen Status' : 'Kitchen & Order Progress'}</span>
            <span style="color: ${statusColor}; font-weight: 800;"><i class="fa-solid ${statusIcon}"></i> ${statusLabel}</span>
          </div>
          ${isRejected ? `
            <div style="margin-top: 10px; background: rgba(229, 57, 53, 0.1); border: 1px dashed rgba(229, 57, 53, 0.4); padding: 10px; border-radius: 8px; text-align: center; color: #E53935; font-weight: 700; font-size: 0.84rem;">
              <i class="fa-solid fa-ban"></i> Order Rejected • Discontinued from Kitchen Queue
            </div>
          ` : `
            <div class="co-bottom-stepper">
              <div class="co-bottom-track-bar">
                <div class="co-bottom-track-fill" style="width: ${progressPct}%;"></div>
              </div>
              <div class="co-bottom-steps">
                <div class="co-bottom-step ${stepIdx >= 0 ? 'active' : ''}">
                  <div class="co-bottom-dot"><i class="fa-solid fa-receipt"></i></div>
                  <span>Received</span>
                </div>
                <div class="co-bottom-step ${stepIdx >= 1 ? 'active' : ''}">
                  <div class="co-bottom-dot"><i class="fa-solid fa-fire-burner"></i></div>
                  <span>Preparing</span>
                </div>
                <div class="co-bottom-step ${stepIdx >= 2 ? 'active' : ''}">
                  <div class="co-bottom-dot"><i class="fa-solid fa-bell-concierge"></i></div>
                  <span>Ready</span>
                </div>
                <div class="co-bottom-step ${stepIdx >= 3 ? 'active' : ''}">
                  <div class="co-bottom-dot"><i class="fa-solid fa-circle-check"></i></div>
                  <span>Completed</span>
                </div>
              </div>
            </div>
          `}
        </div>
      </div>
    `;
  }

  createCustomerOrderCardHTML(order) {
    const dateFormatted = new Date(order.created_at).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    const isRejected = order.order_status === 'Rejected' || order.order_status === 'Cancelled';
    const isReceived = order.order_status === 'Received';
    const isPreparing = order.order_status === 'Preparing';
    const isReady = order.order_status === 'Ready';
    const isCompleted = order.order_status === 'Completed';

    let statusColor = '#EAA221';
    let statusIcon = 'fa-clock';
    let statusLabel = 'Received';
    if (isPreparing) { statusColor = '#29B6F6'; statusIcon = 'fa-fire-burner'; statusLabel = 'Preparing'; }
    if (isReady) { statusColor = '#66BB6A'; statusIcon = 'fa-bell-concierge'; statusLabel = 'Ready'; }
    if (isCompleted) { statusColor = '#4CAF50'; statusIcon = 'fa-circle-check'; statusLabel = 'Completed'; }
    if (isRejected) { statusColor = '#E53935'; statusIcon = 'fa-circle-xmark'; statusLabel = 'Order Rejected'; }

    let stepIdx = 0;
    if (isPreparing) stepIdx = 1;
    if (isReady) stepIdx = 2;
    if (isCompleted) stepIdx = 3;
    const progressPct = Math.round((stepIdx / 3) * 100);

    const typeIcon = order.order_type === 'Takeaway' ? 'fa-box' : order.order_type === 'Delivery' ? 'fa-motorcycle' : 'fa-utensils';
    const isPaid = order.payment_status === 'Paid' || order.payment_status === 'Cash Received' || order.payment_status.includes('Verified');

    return `
      <div class="co-row-card ${isRejected ? 'is-rejected' : ''}">
        ${isRejected ? `
          <!-- PROMINENT REJECTED ORDER CALLOUT BANNER -->
          <div style="background: rgba(229, 57, 53, 0.15); border: 1.5px solid #E53935; padding: 12px 16px; border-radius: var(--radius-md); color: #FF5252; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 0.25rem;">
            <div style="display: flex; align-items: center; gap: 12px;">
              <div style="width: 38px; height: 38px; border-radius: 50%; background: rgba(229,57,53,0.25); color: #E53935; display: flex; align-items: center; justify-content: center; font-size: 1.3rem; flex-shrink: 0;">
                <i class="fa-solid fa-circle-xmark"></i>
              </div>
              <div>
                <strong style="font-size: 0.95rem; color: #FFF; display: block; margin-bottom: 2px;">Order Rejected by Hotel Manager</strong>
                <span style="font-size: 0.8rem; color: #FF8A80;">The hotel is currently unable to accept or fulfill this order. Any online UPI payment refund will be initiated automatically.</span>
              </div>
            </div>
            <button type="button" class="btn-sm-status" onclick="app.openOrderSupport('${order.order_number}')" style="background: #E53935; color: #FFF; border: none; padding: 7px 16px; font-weight: 800; font-size: 0.78rem; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
              <i class="fa-solid fa-headset"></i> Order Support
            </button>
          </div>
        ` : ''}

        <!-- 1. TOP HEADER BAR: Order #, Date, Badges, Payment & Grand Total -->
        <div class="co-card-top-bar">
          <div class="co-top-left">
            <span class="co-row-num"><i class="fa-solid fa-receipt" style="color: var(--accent-gold);"></i> Order #${order.order_number}</span>
            <span class="co-row-type"><i class="fa-solid ${typeIcon}"></i> ${order.order_type}</span>
            <span class="co-row-status-badge" style="border-color: ${statusColor}; color: ${statusColor};">
              <i class="fa-solid ${statusIcon}"></i> ${statusLabel}
            </span>
            <span class="co-row-date"><i class="fa-regular fa-clock"></i> ${dateFormatted}</span>
          </div>

          <div class="co-top-right">
            <div class="co-payment-status-block">
              <span class="co-pay-title-label"><i class="fa-solid fa-credit-card" style="color: var(--accent-gold);"></i> Payment Status:</span>
              <span class="co-row-pay-pill ${isPaid ? 'paid' : 'pending'}">
                <i class="fa-solid ${isPaid ? 'fa-circle-check' : 'fa-hourglass-half'}"></i> ${order.payment_status} (${order.payment_method})
              </span>
            </div>
            <div class="co-total-amount-block">
              <span class="co-total-title-label">Total Amount</span>
              <span class="co-row-total-val">₹${order.grand_total}</span>
            </div>
          </div>
        </div>

        <!-- 2. MIDDLE SECTION: ORDER DETAILS AND 3 BUTTONS SIDE BY SIDE -->
        <div class="co-middle-side-by-side">
          <!-- Left: Order Details Box (Items list one by one) -->
          <div class="co-order-details-box">
            <div class="co-order-details-title">
              <i class="fa-solid fa-utensils" style="color: var(--primary);"></i> Order Details
            </div>
            <div class="co-order-details-list">
              ${(order.items || []).map(i => `
                <div class="co-item-line">
                  <div class="co-item-left-info">
                    <span class="co-qty-badge">${i.quantity}x</span>
                    <span class="co-item-name">${i.name}</span>
                  </div>
                  <span class="co-item-price">₹${Number(i.price) * Number(i.quantity)}</span>
                </div>
              `).join('')}
            </div>
            ${order.notes ? `<div class="co-order-notes"><i class="fa-solid fa-note-sticky"></i> Note: "${order.notes}"</div>` : ''}
            ${order.utr_number || order.payment_screenshot ? `
              <div style="margin-top: 0.6rem; padding-top: 0.5rem; border-top: 1px dashed var(--border-color); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: 0.78rem;">
                ${order.utr_number ? `<span style="color: var(--accent-gold); font-weight: 700;"><i class="fa-solid fa-receipt"></i> UTR: <code style="background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; color: #FFF;">${order.utr_number}</code></span>` : ''}
                ${order.payment_screenshot ? `
                  <button type="button" class="btn-sm-status" onclick="app.viewFullScreenshot('${order.payment_screenshot}')" style="background: rgba(41,182,246,0.15); color: #29B6F6; border: 1px solid rgba(41,182,246,0.3); padding: 3px 10px; border-radius: 12px; font-size: 0.72rem; cursor: pointer;">
                    <i class="fa-solid fa-camera"></i> View Uploaded Screenshot
                  </button>
                ` : ''}
              </div>
            ` : ''}
          </div>

          <!-- Right: 3 Action Buttons Side-by-Side Panel -->
          <div class="co-actions-panel">
            <div class="co-actions-title"><i class="fa-solid fa-sliders" style="color: var(--accent-gold);"></i> Quick Actions</div>
            <div class="co-row-actions">
              <button class="co-row-btn view" onclick="app.showOrderDetail('${order.order_number}')">
                <i class="fa-solid fa-eye"></i> View Details
              </button>
              <button class="co-row-btn receipt" onclick="app.downloadOrderReceipt('${order.order_number}')">
                <i class="fa-solid fa-download"></i> Download Receipt
              </button>
              <button class="co-row-btn support" onclick="app.openOrderSupport('${order.order_number}')">
                <i class="fa-solid fa-headset"></i> Order Support
              </button>
            </div>
          </div>
        </div>

        <!-- 3. BOTTOM SECTION: LIVE ORDER TRACKING STEPPER -->
        <div class="co-bottom-tracking">
          <div class="co-track-head-bar">
            <span><i class="fa-solid fa-route" style="color: var(--accent-gold);"></i> ${isRejected ? 'Order Status' : 'Live Order Tracking'}</span>
            <span style="color: ${statusColor}; font-weight: 800;"><i class="fa-solid ${statusIcon}"></i> ${statusLabel}</span>
          </div>
          ${isRejected ? `
            <div style="margin-top: 10px; background: rgba(229, 57, 53, 0.1); border: 1px dashed rgba(229, 57, 53, 0.4); padding: 10px; border-radius: 8px; text-align: center; color: #E53935; font-weight: 700; font-size: 0.84rem;">
              <i class="fa-solid fa-ban"></i> Order Processing Discontinued • Status: Order Rejected by Hotel
            </div>
          ` : `
            <div class="co-bottom-stepper">
              <div class="co-bottom-track-bar">
                <div class="co-bottom-track-fill" style="width: ${progressPct}%;"></div>
              </div>
              <div class="co-bottom-steps">
                <div class="co-bottom-step ${stepIdx >= 0 ? 'active' : ''}">
                  <div class="co-bottom-dot"><i class="fa-solid fa-receipt"></i></div>
                  <span>Order Received</span>
                </div>
                <div class="co-bottom-step ${stepIdx >= 1 ? 'active' : ''}">
                  <div class="co-bottom-dot"><i class="fa-solid fa-fire-burner"></i></div>
                  <span>Preparing</span>
                </div>
                <div class="co-bottom-step ${stepIdx >= 2 ? 'active' : ''}">
                  <div class="co-bottom-dot"><i class="fa-solid fa-bell-concierge"></i></div>
                  <span>Ready</span>
                </div>
                <div class="co-bottom-step ${stepIdx >= 3 ? 'active' : ''}">
                  <div class="co-bottom-dot"><i class="fa-solid fa-circle-check"></i></div>
                  <span>Completed</span>
                </div>
              </div>
            </div>
          `}
        </div>
      </div>
    `;
  }

  openOrderSupport(orderNum) {
    this.switchView('secCustomerSupport');
    this.openRaiseTicketModal();
    setTimeout(() => {
      const orderSelect = document.getElementById('tktFormOrderSelect');
      if (orderSelect) orderSelect.value = orderNum || '';
      const catSelect = document.getElementById('tktFormCategorySelect');
      if (catSelect) catSelect.value = 'Order Issue';
      const subjInput = document.getElementById('tktFormSubject');
      if (subjInput && orderNum) subjInput.value = `Help with Order #${orderNum}`;
      const msgInput = document.getElementById('tktFormMessage');
      if (msgInput && orderNum) {
        msgInput.value = `Hi Support, I need help with my Order #${orderNum}. `;
        msgInput.focus();
      }
    }, 150);
  }

  showOrderDetail(orderNum) {
    const order = this.orders.find(o => o.order_number === orderNum);
    if (!order) { this.showToast('Order not found.', 'error'); return; }

    const dateFormatted = new Date(order.created_at).toLocaleString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const isReceived = order.order_status === 'Received';
    const isPreparing = order.order_status === 'Preparing';
    const isReady = order.order_status === 'Ready';
    const isCompleted = order.order_status === 'Completed';
    let statusColor = '#EAA221';
    if (isPreparing) statusColor = '#29B6F6';
    if (isReady) statusColor = '#66BB6A';
    if (isCompleted) statusColor = '#4CAF50';

    let stepIdx = 0;
    if (isPreparing) stepIdx = 1;
    if (isReady) stepIdx = 2;
    if (isCompleted) stepIdx = 3;

    const subtotal = order.items.reduce((s, i) => s + (i.price * i.quantity), 0);

    const container = document.getElementById('orderDetailContent');
    container.innerHTML = `
      <div class="od-header">
        <div>
          <h2 class="od-title">Order #${order.order_number}</h2>
          <p class="od-date"><i class="fa-regular fa-calendar"></i> ${dateFormatted}</p>
        </div>
        <span class="od-status" style="background: ${statusColor}22; border: 1px solid ${statusColor}; color: ${statusColor};">
          ${order.order_status}
        </span>
      </div>

      <div class="od-info-grid">
        <div class="od-info-item">
          <span class="od-label">Customer</span>
          <span class="od-value">${order.customer_name}</span>
        </div>
        <div class="od-info-item">
          <span class="od-label">Mobile</span>
          <span class="od-value">${order.customer_mobile}</span>
        </div>
        <div class="od-info-item">
          <span class="od-label">Order Type</span>
          <span class="od-value">${order.order_type}</span>
        </div>
        <div class="od-info-item">
          <span class="od-label">Payment</span>
          <span class="od-value">${order.payment_method} — ${order.payment_status}</span>
        </div>
        <div class="od-info-item" style="grid-column: 1 / -1; background: rgba(217, 83, 30, 0.08); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(217, 83, 30, 0.3);">
          <span class="od-label" style="color: var(--primary);"><i class="fa-solid fa-location-dot"></i> Delivery / Location Address</span>
          <span class="od-value" style="color: #FFF; font-weight: 700; font-size: 0.9rem;">${order.delivery_address || (order.order_type === 'Delivery' ? 'Home Delivery Address' : 'Counter Pickup')}</span>
        </div>
      </div>

      ${order.notes ? `<div class="od-notes"><i class="fa-regular fa-note-sticky"></i> "${order.notes}"</div>` : ''}

      <h4 class="od-section-title">Items Ordered</h4>
      <table class="od-items-table">
        <thead>
          <tr><th>Item</th><th>Qty</th><th>Price</th><th>Amount</th></tr>
        </thead>
        <tbody>
          ${order.items.map(i => `
            <tr>
              <td>${i.name}</td>
              <td style="text-align:center;">${i.quantity}</td>
              <td style="text-align:right;">₹${i.price}</td>
              <td style="text-align:right;">₹${i.price * i.quantity}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div class="od-total-bar">
        <span>Grand Total</span>
        <span class="od-grand">₹${order.grand_total}</span>
      </div>

      <!-- Progress -->
      <h4 class="od-section-title">Order Progress</h4>
      <div class="od-progress">
        ${['Received', 'Preparing', 'Ready', 'Completed'].map((label, idx) => `
          <div class="od-prog-step ${idx <= stepIdx ? 'active' : ''}">
            <div class="od-prog-dot">${idx <= stepIdx ? '✓' : idx + 1}</div>
            <span>${label}</span>
          </div>
          ${idx < 3 ? `<div class="od-prog-line ${idx < stepIdx ? 'active' : ''}"></div>` : ''}
        `).join('')}
      </div>

      <button class="od-download-btn" onclick="app.downloadOrderReceipt('${order.order_number}')">
        <i class="fa-solid fa-download"></i> Download Receipt
      </button>
    `;

    document.getElementById('orderDetailBackdrop').classList.add('open');
  }

  closeOrderDetail() {
    document.getElementById('orderDetailBackdrop').classList.remove('open');
  }

  downloadOrderReceipt(orderNum) {
    const order = this.orders.find(o => o.order_number === orderNum);
    if (!order) { this.showToast('Order not found.', 'error'); return; }

    const dateFormatted = new Date(order.created_at).toLocaleString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const itemRows = order.items.map(i => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${i.name}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;">${i.quantity}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">₹${i.price}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:700;">₹${i.price * i.quantity}</td>
      </tr>
    `).join('');

    const receiptHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Receipt - #${order.order_number}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Segoe UI', Arial, sans-serif; max-width: 420px; margin: 0 auto; padding: 24px 20px; color: #222; }
          .receipt-header { text-align: center; border-bottom: 2px dashed #ccc; padding-bottom: 14px; margin-bottom: 14px; }
          .receipt-header h1 { font-size: 1.3rem; color: #D9531E; }
          .receipt-header p { font-size: 0.78rem; color: #666; }
          .order-info { display: flex; justify-content: space-between; font-size: 0.82rem; margin-bottom: 12px; padding: 8px 0; border-bottom: 1px solid #eee; }
          .order-info span { color: #555; }
          .order-info strong { color: #222; }
          table { width: 100%; border-collapse: collapse; font-size: 0.82rem; margin-bottom: 10px; }
          thead th { background: #f5f5f5; padding: 8px 10px; text-align: left; font-size: 0.75rem; text-transform: uppercase; color: #888; border-bottom: 2px solid #ddd; }
          .total-row { display: flex; justify-content: space-between; font-size: 1.1rem; font-weight: 800; padding: 12px 0; border-top: 2px dashed #ccc; margin-top: 6px; }
          .total-row .amount { color: #D9531E; }
          .footer { text-align: center; margin-top: 18px; padding-top: 12px; border-top: 1px solid #eee; font-size: 0.72rem; color: #999; }
          @media print { body { padding: 0; } }
        </style>
      </head>
      <body>
        <div class="receipt-header">
          <h1>🍲 Sri Lakshmi Annapurna Tiffin Center</h1>
          <p>Authentic South Indian Tiffins & Mini Meals</p>
          <p style="margin-top:4px;">📍 Gandhi Nagar, Bengaluru | 📞 +91 98765 43210</p>
        </div>

        <div class="order-info">
          <span>Order: <strong>#${order.order_number}</strong></span>
          <span>Date: <strong>${dateFormatted}</strong></span>
        </div>
        <div class="order-info">
          <span>Customer: <strong>${order.customer_name}</strong></span>
          <span>Type: <strong>${order.order_type}</strong></span>
        </div>
        <div class="order-info">
          <span>Payment: <strong>${order.payment_method}</strong></span>
          <span>Status: <strong>${order.payment_status}</strong></span>
        </div>

        <table>
          <thead>
            <tr><th>Item</th><th style="text-align:center;">Qty</th><th style="text-align:right;">Price</th><th style="text-align:right;">Total</th></tr>
          </thead>
          <tbody>
            ${itemRows}
          </tbody>
        </table>

        <div class="total-row">
          <span>Grand Total</span>
          <span class="amount">₹${order.grand_total}</span>
        </div>

        <div class="footer">
          <p>Thank you for ordering! 🙏</p>
          <p>Visit us again at Sri Lakshmi Annapurna Tiffin Center</p>
          <p style="margin-top:6px;">Order Status: ${order.order_status}</p>
        </div>

        <script>window.onload = function() { window.print(); }</script>
      </body>
      </html>
    `;

    const printWindow = window.open('', '_blank', 'width=500,height=700');
    printWindow.document.write(receiptHTML);
    printWindow.document.close();
  }

  createOrderCardHTML(order, isOwnerView = false) {
    const dateFormatted = new Date(order.created_at).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
    });

    const isPending = order.order_status === 'Received';
    const isPreparing = order.order_status === 'Preparing';
    const isReady = order.order_status === 'Ready';

    return `
      <div class="order-card">
        <div class="order-card-header">
          <div>
            <span class="order-num-badge">#${order.order_number}</span>
            <span class="badge-status ${order.order_status}" style="margin-left: 8px;">${order.order_status}</span>
          </div>
          <span class="order-time">${dateFormatted}</span>
        </div>

        <div class="order-customer-info">
          <div class="order-customer-name">${order.customer_name} (${order.order_type})</div>
          <div class="order-customer-phone"><i class="fa-solid fa-phone"></i> ${order.customer_mobile}</div>
          ${order.notes ? `<div style="font-size: 0.78rem; color: var(--accent-gold); margin-top: 2px;"><i class="fa-regular fa-note-sticky"></i> Note: "${order.notes}"</div>` : ''}
        </div>

        <table class="order-items-table">
          <thead>
            <tr>
              <th>Item</th>
              <th style="text-align: center;">Qty</th>
              <th style="text-align: right;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${order.items.map(i => `
              <tr>
                <td>${i.name}</td>
                <td style="text-align: center;">${i.quantity}</td>
                <td style="text-align: right;">₹${i.price * i.quantity}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-color); padding-top: 0.5rem; font-size: 0.88rem;">
          <div>
            Payment: <strong style="color: var(--accent-gold);">${order.payment_method}</strong>
            <span class="badge-status ${order.payment_status.includes('Paid') ? 'Completed' : 'Received'}" style="font-size: 0.65rem; margin-left: 4px;">${order.payment_status}</span>
          </div>
          <div style="font-family: 'Outfit', sans-serif; font-size: 1.15rem; font-weight: 800; color: var(--text-main);">
            Total: ₹${order.grand_total}
          </div>
        </div>

        ${order.utr_number || order.payment_screenshot ? `
          <div style="background: rgba(10, 10, 14, 0.4); padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border-color); margin-top: 6px; font-size: 0.8rem;">
            ${order.utr_number ? `<div><i class="fa-solid fa-receipt" style="color: var(--accent-gold);"></i> <strong>UTR Number:</strong> <code style="background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px;">${order.utr_number}</code></div>` : ''}
            ${order.payment_screenshot ? `
              <div style="margin-top: 6px;">
                <button type="button" class="btn-secondary-outline" onclick="app.viewFullScreenshot('${order.payment_screenshot}')" style="padding: 4px 10px; font-size: 0.74rem;">
                  <i class="fa-solid fa-camera"></i> View Uploaded Payment Screenshot
                </button>
              </div>
            ` : ''}
          </div>
        ` : ''}

        ${isOwnerView && (order.payment_status.includes('Pending') || order.payment_status.includes('Verification')) ? `
          <div style="display: flex; gap: 6px; margin-top: 8px;">
            <button class="btn-sm-status" onclick="app.verifyOrderPayment('${order.id}', 'Paid (UPI Verified)')" style="background: rgba(76,175,80,0.2); color: #4CAF50; border: 1px solid #4CAF50; padding: 6px 12px; border-radius: 6px; font-weight: 700; font-size: 0.78rem; cursor: pointer; flex: 1;">
              <i class="fa-solid fa-circle-check"></i> Verify & Mark Paid
            </button>
            <button class="btn-sm-status" onclick="app.verifyOrderPayment('${order.id}', 'Payment Failed')" style="background: rgba(229,57,53,0.2); color: #E53935; border: 1px solid #E53935; padding: 6px 12px; border-radius: 6px; font-weight: 700; font-size: 0.78rem; cursor: pointer; flex: 1;">
              <i class="fa-solid fa-circle-xmark"></i> Reject Payment
            </button>
          </div>
        ` : ''}

        <!-- Status Progress Timeline Stepper -->
        <div class="status-stepper">
          <div class="status-step">
            <div class="step-dot ${['Received', 'Preparing', 'Ready', 'Completed'].includes(order.order_status) ? 'active' : ''}">
              <i class="fa-solid fa-receipt"></i>
            </div>
            <span class="step-label ${order.order_status === 'Received' ? 'active' : ''}">Received</span>
          </div>
          <div class="status-step">
            <div class="step-dot ${['Preparing', 'Ready', 'Completed'].includes(order.order_status) ? 'active' : ''}">
              <i class="fa-solid fa-fire"></i>
            </div>
            <span class="step-label ${order.order_status === 'Preparing' ? 'active' : ''}">Preparing</span>
          </div>
          <div class="status-step">
            <div class="step-dot ${['Ready', 'Completed'].includes(order.order_status) ? 'active' : ''}">
              <i class="fa-solid fa-bell"></i>
            </div>
            <span class="step-label ${order.order_status === 'Ready' ? 'active' : ''}">Ready</span>
          </div>
          <div class="status-step">
            <div class="step-dot ${order.order_status === 'Completed' ? 'active' : ''}">
              <i class="fa-solid fa-check"></i>
            </div>
            <span class="step-label ${order.order_status === 'Completed' ? 'active' : ''}">Completed</span>
          </div>
        </div>

        <!-- Owner Action Buttons -->
        ${isOwnerView ? `
          <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
            ${isPending ? `
              <button class="btn-primary-block" onclick="app.updateOrderStatus('${order.id}', 'Preparing')" style="flex: 2; padding: 8px; font-size: 0.82rem;">
                <i class="fa-solid fa-check"></i> Accept & Prepare
              </button>
              <button class="role-btn" onclick="app.updateOrderStatus('${order.id}', 'Rejected')" style="flex: 1; justify-content: center; border: 1px solid var(--color-unavailable); color: var(--color-unavailable);">
                Reject
              </button>
            ` : ''}

            ${isPreparing ? `
              <button class="btn-primary-block" onclick="app.updateOrderStatus('${order.id}', 'Ready')" style="flex: 1; padding: 8px; font-size: 0.82rem; background: linear-gradient(135deg, #0288D1, #0277BD);">
                <i class="fa-solid fa-bell"></i> Mark Ready for Serving
              </button>
            ` : ''}

            ${isReady ? `
              <button class="btn-primary-block" onclick="app.updateOrderStatus('${order.id}', 'Completed')" style="flex: 1; padding: 8px; font-size: 0.82rem; background: linear-gradient(135deg, #388E3C, #2E7D32);">
                <i class="fa-solid fa-circle-check"></i> Mark Order Completed
              </button>
            ` : ''}
          </div>
        ` : ''}

        ${!isOwnerView && order.order_status === 'Completed' ? `
          <div style="margin-top: 0.75rem; border-top: 1px dashed var(--border-color); padding-top: 0.65rem; display: flex; align-items: center; justify-content: space-between;">
            ${order.has_reviewed ? `
              <span class="status-badge ready" style="font-size: 0.8rem; padding: 5px 12px; font-weight: 800; background: rgba(76, 175, 80, 0.18); color: #4CAF50;">
                ⭐⭐⭐⭐⭐ Order Feedback Submitted
              </span>
            ` : `
              <button type="button" class="btn-primary-block" onclick="app.openOrderReviewModal('${order.order_number}')" style="background: linear-gradient(135deg, #FFB300, #FF6F00); color: #000; box-shadow: 0 4px 14px rgba(255, 179, 0, 0.4); padding: 8px 16px; font-size: 0.84rem; font-weight: 800; width: 100%;">
                ⭐ Rate Your Order & Share Feedback
              </button>
            `}
          </div>
        ` : ''}
      </div>
    `;
  }

  async updateOrderStatus(orderId, newStatus) {
    try {
      const res = await fetch(`${API_BASE}/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_status: newStatus })
      });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message, 'success');
        await this.fetchOrders();
        await this.fetchStats();
      }
    } catch (err) {
      console.error('Error updating order status:', err);
    }
  }

  // =========================================================================
  // OWNER TIFFIN MANAGEMENT CRUD
  // =========================================================================

  openAddTiffinModal() {
    document.getElementById('tiffinModalTitle').innerText = 'Add New Tiffin';
    document.getElementById('editTiffinId').value = '';
    document.getElementById('tifName').value = '';
    document.getElementById('tifDesc').value = '';
    document.getElementById('tifPrice').value = '';
    document.getElementById('tifCategory').value = 'Breakfast';
    document.getElementById('tifImage').value = '/images/idly_sambar.png';
    this.formAvailability = true;
    this.updateFormAvailabilityUI();
    this.toggleTiffinModal(true);
  }

  openEditTiffinModal(itemId) {
    const item = this.menu.find(m => m.id === itemId);
    if (!item) return;

    document.getElementById('tiffinModalTitle').innerText = 'Edit Tiffin Item';
    document.getElementById('editTiffinId').value = item.id;
    document.getElementById('tifName').value = item.name;
    document.getElementById('tifDesc').value = item.description;
    document.getElementById('tifPrice').value = item.price;
    document.getElementById('tifCategory').value = item.category;
    document.getElementById('tifImage').value = item.image;
    this.formAvailability = Boolean(item.is_available);
    this.updateFormAvailabilityUI();
    this.toggleTiffinModal(true);
  }

  toggleTiffinModal(open = true) {
    document.getElementById('tiffinModalBackdrop').classList.toggle('open', open);
  }

  toggleFormAvailability() {
    this.formAvailability = !this.formAvailability;
    this.updateFormAvailabilityUI();
  }

  updateFormAvailabilityUI() {
    const sw = document.getElementById('formAvailabilitySwitch');
    const lbl = document.getElementById('formAvailabilityLabel');
    sw.classList.toggle('active', this.formAvailability);
    lbl.innerText = this.formAvailability ? '🟢 AVAILABLE' : '🔴 NOT AVAILABLE';
  }

  async saveTiffin(e) {
    e.preventDefault();

    const id = document.getElementById('editTiffinId').value;
    const name = document.getElementById('tifName').value;
    const desc = document.getElementById('tifDesc').value;
    const price = document.getElementById('tifPrice').value;
    const cat = document.getElementById('tifCategory').value;
    const image = document.getElementById('tifImage').value || '/images/idly_sambar.png';

    const payload = {
      name, description: desc, price, category: cat, image, is_available: this.formAvailability
    };

    try {
      let res, json;
      if (id) {
        res = await fetch(`${API_BASE}/menu/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } else {
        res = await fetch(`${API_BASE}/menu`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

      json = await res.json();
      if (json.success) {
        this.showToast(json.message || `${name} has been added successfully.`, 'success');
        this.toggleTiffinModal(false);
        await this.fetchMenu();
      } else {
        this.showToast(json.message || 'Failed to save tiffin.', 'error');
      }
    } catch (err) {
      console.error('Error saving tiffin:', err);
    }
  }

  async toggleItemAvailability(itemId, isAvailable) {
    try {
      const res = await fetch(`${API_BASE}/menu/${itemId}/availability`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_available: isAvailable })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message, 'info');
        await this.fetchMenu();
      }
    } catch (err) {
      console.error('Error toggling availability:', err);
    }
  }

  async deleteTiffin(itemId) {
    const item = this.menu.find(m => m.id === itemId);
    if (!item) return;

    if (!confirm(`Are you sure you want to delete ${item.name}?`)) return;

    try {
      const res = await fetch(`${API_BASE}/menu/${itemId}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message, 'success');
        await this.fetchMenu();
      }
    } catch (err) {
      console.error('Error deleting tiffin:', err);
    }
  }

  async deleteOrder(orderId) {
    const order = this.orders.find(o => o.id === orderId || o.order_number === orderId);
    if (!order) return;

    if (!confirm(`Are you sure you want to delete Order #${order.order_number}? This action cannot be undone.`)) return;

    try {
      const res = await fetch(`${API_BASE}/orders/${order.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message, 'success');
        await this.fetchOrders();
      } else {
        this.showToast(json.message || 'Failed to delete order', 'error');
      }
    } catch (err) {
      console.error('Error deleting order:', err);
    }
  }

  async deleteSupportTicket(ticketId) {
    const targetId = ticketId || this.activeTicketId;
    const ticket = (this.supportTickets || []).find(t => t.id === targetId || t.ticket_number === targetId);
    if (!ticket) return;

    if (!confirm(`Are you sure you want to delete Support Ticket #${ticket.ticket_number}?`)) return;

    try {
      const res = await fetch(`${API_BASE}/support/tickets/${ticket.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message, 'success');
        this.toggleTicketThreadModal(false);
        await this.fetchSupportTickets();
      } else {
        this.showToast(json.message || 'Failed to delete support ticket', 'error');
      }
    } catch (err) {
      console.error('Error deleting support ticket:', err);
    }
  }

  // =========================================================================
  // PAYMENTS & FINANCIAL LEDGER
  // =========================================================================

  filterOwnerPayments(filter = null) {
    if (filter) this.ownerPaymentFilter = filter;
    const searchVal = (document.getElementById('ownerPaySearchInput')?.value || '').toLowerCase().trim();

    ['All', 'UPI', 'Cash', 'Verified', 'Pending'].forEach(f => {
      const tab = document.getElementById(`payTab${f}`);
      if (tab) tab.classList.toggle('active', (filter || this.ownerPaymentFilter) === f);
    });

    this.renderPayments(searchVal);
  }

  renderPayments(searchQuery = null) {
    const tableBody = document.getElementById('paymentsTableBody') || document.getElementById('paymentsCardsGrid');
    if (!tableBody) return;

    let list = this.payments || [];

    // Financial Metrics Summary
    const totalAmount = list.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const upiAmount = list.filter(p => (p.payment_method || '').includes('UPI') || (p.payment_method || '').includes('Online'))
      .reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const cashAmount = list.filter(p => !(p.payment_method || '').includes('UPI') && !(p.payment_method || '').includes('Online'))
      .reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const pendingCount = list.filter(p => (p.payment_status || '').includes('Pending') || (p.payment_status || '').includes('Verification')).length;

    const elTotal = document.getElementById('payStatTotal');
    const elUpi = document.getElementById('payStatUpi');
    const elCash = document.getElementById('payStatCash');
    const elPending = document.getElementById('payStatPending');

    if (elTotal) elTotal.innerText = `₹${totalAmount.toLocaleString('en-IN')}`;
    if (elUpi) elUpi.innerText = `₹${upiAmount.toLocaleString('en-IN')}`;
    if (elCash) elCash.innerText = `₹${cashAmount.toLocaleString('en-IN')}`;
    if (elPending) elPending.innerText = pendingCount;

    // Filter by tab
    if (this.ownerPaymentFilter === 'UPI') {
      list = list.filter(p => (p.payment_method || '').includes('UPI') || (p.payment_method || '').includes('Online'));
    } else if (this.ownerPaymentFilter === 'Cash') {
      list = list.filter(p => !(p.payment_method || '').includes('UPI') && !(p.payment_method || '').includes('Online'));
    } else if (this.ownerPaymentFilter === 'Verified') {
      list = list.filter(p => (p.payment_status || '').includes('Paid') || (p.payment_status || '').includes('Verified') || (p.payment_status || '').includes('Cash Received'));
    } else if (this.ownerPaymentFilter === 'Pending') {
      list = list.filter(p => (p.payment_status || '').includes('Pending') || (p.payment_status || '').includes('Verification'));
    }

    // Search query filter
    const query = searchQuery !== null ? searchQuery : (document.getElementById('ownerPaySearchInput')?.value || '').toLowerCase().trim();
    if (query) {
      list = list.filter(p =>
        (p.order_number || '').toLowerCase().includes(query) ||
        (p.customer_name || '').toLowerCase().includes(query) ||
        (p.utr_number || '').toLowerCase().includes(query) ||
        (p.payment_method || '').toLowerCase().includes(query) ||
        (p.payment_status || '').toLowerCase().includes(query)
      );
    }

    if (!list.length) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
            <i class="fa-solid fa-wallet" style="font-size: 2.5rem; color: var(--accent-gold); margin-bottom: 0.75rem;"></i>
            <h3 style="color: #FFF; font-size: 1.1rem; margin-bottom: 0.25rem;">No Payment Records Found</h3>
            <p style="font-size: 0.85rem;">No payments match your current filter or search query.</p>
          </td>
        </tr>
      `;
      return;
    }

    tableBody.innerHTML = list.map(p => this.createPaymentTableRowHTML(p)).join('');
  }

  createPaymentTableRowHTML(p) {
    const isPaid = (p.payment_status || '').includes('Paid') || (p.payment_status || '').includes('Verified') || (p.payment_status || '').includes('Cash Received');
    const isPending = (p.payment_status || '').includes('Pending') || (p.payment_status || '').includes('Verification');
    const isUPI = (p.payment_method || '').includes('UPI') || (p.payment_method || '').includes('Online');

    const statusBg = isPaid ? 'rgba(76, 175, 80, 0.15)' : isPending ? 'rgba(234, 162, 33, 0.15)' : 'rgba(229, 57, 53, 0.15)';
    const statusBorder = isPaid ? '#4CAF50' : isPending ? '#EAA221' : '#E53935';
    const statusColor = isPaid ? '#4CAF50' : isPending ? '#FFB74D' : '#FF5252';

    return `
      <tr style="border-bottom: 1px solid var(--border-color); transition: background 0.2s ease;">
        <!-- 1. Order ID Column -->
        <td style="padding: 14px 16px; vertical-align: middle;">
          <div style="font-weight: 800; font-size: 0.95rem; color: var(--accent-gold);">
            <i class="fa-solid fa-receipt"></i> #${p.order_number}
          </div>
          <div style="font-size: 0.82rem; color: #FFF; font-weight: 600; margin-top: 3px;">
            <i class="fa-solid fa-user" style="color: var(--primary);"></i> ${p.customer_name}
          </div>
          <div style="font-size: 0.74rem; color: var(--text-muted); margin-top: 2px;">
            <i class="fa-regular fa-clock"></i> ${p.date_time || 'Today'}
          </div>
        </td>

        <!-- 2. Transaction ID / UTR Column -->
        <td style="padding: 14px 16px; vertical-align: middle;">
          ${p.utr_number ? `
            <code style="background: rgba(234, 162, 33, 0.15); color: var(--accent-gold); border: 1px solid rgba(234, 162, 33, 0.3); padding: 4px 9px; border-radius: 6px; font-family: monospace; font-weight: 700; font-size: 0.85rem; display: inline-block;">
              ${p.utr_number}
            </code>
            <div style="font-size: 0.72rem; color: #29B6F6; font-weight: 700; margin-top: 4px;">
              <i class="fa-solid fa-qrcode"></i> ${p.payment_method}
            </div>
          ` : `
            <span style="font-size: 0.82rem; color: #4CAF50; font-weight: 700;">
              <i class="fa-solid fa-money-bill-wave"></i> Cash Payment
            </span>
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 2px;">Counter Payment</div>
          `}
        </td>

        <!-- 3. Screenshot Column (Customer Uploaded) -->
        <td style="padding: 14px 16px; vertical-align: middle;">
          ${p.payment_screenshot ? `
            <div style="display: flex; align-items: center; gap: 10px;">
              <img src="${p.payment_screenshot}" onclick="app.viewFullScreenshot('${p.payment_screenshot}')" class="payment-screenshot-thumb" style="width: 48px; height: 48px; object-fit: cover; border-radius: 8px; border: 1.5px solid var(--accent-gold); cursor: pointer; transition: transform 0.2s ease;" title="Click to view full screenshot">
              <button type="button" class="btn-sm-status" onclick="app.viewFullScreenshot('${p.payment_screenshot}')" style="background: rgba(234, 162, 33, 0.15); color: var(--accent-gold); border: 1px solid rgba(234, 162, 33, 0.3); padding: 4px 10px; border-radius: 6px; font-size: 0.75rem; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;">
                <i class="fa-solid fa-camera"></i> View
              </button>
            </div>
          ` : `
            <span style="font-size: 0.75rem; color: var(--text-muted); background: rgba(255,255,255,0.05); padding: 4px 10px; border-radius: 6px; display: inline-block;">
              <i class="fa-solid fa-image-slash"></i> No Screenshot
            </span>
          `}
        </td>

        <!-- 4. Status Column -->
        <td style="padding: 14px 16px; vertical-align: middle;">
          <select onchange="app.updatePaymentStatus('${p.id}', this.value)" style="background: ${statusBg}; color: ${statusColor}; border: 1px solid ${statusBorder}; padding: 6px 10px; border-radius: 8px; font-size: 0.78rem; font-weight: 800; cursor: pointer; outline: none;">
            <option value="Pending" ${p.payment_status === 'Pending' ? 'selected' : ''}>⏳ Pending</option>
            <option value="Paid" ${p.payment_status === 'Paid' || p.payment_status.includes('Verified') ? 'selected' : ''}>✅ Paid (Verified)</option>
            <option value="Cash Received" ${p.payment_status === 'Cash Received' ? 'selected' : ''}>💵 Cash Received</option>
            <option value="Failed" ${p.payment_status === 'Failed' ? 'selected' : ''}>❌ Payment Failed</option>
          </select>
          <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 4px; font-weight: 600;">
            Amount: <strong style="color: var(--accent-gold); font-size: 0.88rem;">₹${p.amount}</strong>
          </div>
        </td>

        <!-- 5. Action (Bill) Column -->
        <td style="padding: 14px 16px; vertical-align: middle; text-align: center;">
          <button type="button" class="btn-sm-status" onclick="app.downloadSinglePaymentVoucher('${p.order_number}')" style="background: linear-gradient(135deg, #EAA221, #D9531E); color: #FFFFFF; border: none; padding: 8px 16px; border-radius: 8px; font-size: 0.78rem; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 4px 12px rgba(217, 83, 30, 0.35); transition: transform 0.15s ease;" title="Print or Download Invoice / Bill">
            <i class="fa-solid fa-file-invoice"></i> Action (Bill)
          </button>
        </td>
      </tr>
    `;
  }

  viewFullScreenshot(imgSrc) {
    const img = document.getElementById('lightboxImg');
    const backdrop = document.getElementById('lightboxModalBackdrop');
    if (img && backdrop) {
      img.src = imgSrc;
      backdrop.classList.add('open');
    }
  }

  closeLightbox() {
    const backdrop = document.getElementById('lightboxModalBackdrop');
    if (backdrop) {
      backdrop.classList.remove('open');
    }
  }

  downloadPaymentStatementCSV() {
    if (!this.payments || !this.payments.length) {
      this.showToast('No payment records available to export.', 'info');
      return;
    }

    const headers = ['Order Number', 'Customer Name', 'Amount (INR)', 'Payment Method', 'UTR Ref Number', 'Date & Time', 'Payment Status'];
    const rows = this.payments.map(p => [
      `"${p.order_number}"`,
      `"${p.customer_name}"`,
      `"${p.amount}"`,
      `"${p.payment_method}"`,
      `"${p.utr_number || 'N/A'}"`,
      `"${p.date_time}"`,
      `"${p.payment_status}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Sri_Lakshmi_Annapurna_Payment_Statement_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.showToast('Financial statement downloaded successfully (CSV)!', 'success');
  }

  downloadSinglePaymentVoucher(orderNumber) {
    this.downloadOrderReceipt(orderNumber);
  }

  // =========================================================================
  // OWNER BUSINESS SETTINGS & REFERRAL PROGRAM CONTROLS
  // =========================================================================

  populateSettingsForm() {
    if (!this.settings) return;
    const elName = document.getElementById('setHotelName');
    const elPhone = document.getElementById('setPhone');
    const elAddr = document.getElementById('setAddr');
    const elOpen = document.getElementById('setOpenTime');
    const elClose = document.getElementById('setCloseTime');
    const elHolidays = document.getElementById('setHolidays');
    const elUpi = document.getElementById('setUpiId');
    const elDesc = document.getElementById('setDesc');

    if (elName) elName.value = this.settings.hotel_name || '';
    if (elPhone) elPhone.value = this.settings.phone || '';
    if (elAddr) elAddr.value = this.settings.address || '';
    if (elOpen) elOpen.value = this.settings.open_time || '';
    if (elClose) elClose.value = this.settings.close_time || '';
    if (elHolidays) elHolidays.value = this.settings.holidays || '';
    if (elUpi) elUpi.value = this.settings.upi_id || '';
    if (elDesc) elDesc.value = this.settings.description || '';

    // Referral Program Settings Controls
    const ref = this.settings.referral || {};
    const swEnabled = document.getElementById('setRefEnabledSwitch');
    const lblEnabled = document.getElementById('setRefEnabledLabel');
    const elReward = document.getElementById('setRefReferrerReward');
    const elDiscount = document.getElementById('setRefCustomerDiscount');
    const elMinOrder = document.getElementById('setRefMinOrderValue');
    const elLimit = document.getElementById('setRefMonthlyLimit');

    if (swEnabled) swEnabled.classList.toggle('active', ref.enabled !== false);
    if (lblEnabled) lblEnabled.innerText = ref.enabled !== false ? '🟢 PROGRAM ON' : '🔴 PROGRAM OFF';
    if (elReward) elReward.value = ref.referrer_reward || 30;
    if (elDiscount) elDiscount.value = ref.new_customer_discount || 30;
    if (elMinOrder) elMinOrder.value = ref.min_order_value || 150;
    if (elLimit) elLimit.value = ref.monthly_limit || 500;
  }

  async saveSettings(e) {
    if (e) e.preventDefault();

    const swEnabled = document.getElementById('setRefEnabledSwitch');
    const refEnabled = swEnabled ? swEnabled.classList.contains('active') : true;

    const payload = {
      hotel_name: document.getElementById('setHotelName')?.value,
      phone: document.getElementById('setPhone')?.value,
      address: document.getElementById('setAddr')?.value,
      open_time: document.getElementById('setOpenTime')?.value,
      close_time: document.getElementById('setCloseTime')?.value,
      holidays: document.getElementById('setHolidays')?.value,
      upi_id: document.getElementById('setUpiId')?.value,
      description: document.getElementById('setDesc')?.value,
      upi_qr_code: this.settings.upi_qr_code,
      is_open: this.settings.is_open,
      referral: {
        enabled: refEnabled,
        referrer_reward: Number(document.getElementById('setRefReferrerReward')?.value || 30),
        new_customer_discount: Number(document.getElementById('setRefCustomerDiscount')?.value || 30),
        min_order_value: Number(document.getElementById('setRefMinOrderValue')?.value || 150),
        monthly_limit: Number(document.getElementById('setRefMonthlyLimit')?.value || 500)
      }
    };

    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (json.success) {
        this.settings = json.data;
        this.showToast('Business & Referral settings saved successfully!', 'success');
      }
    } catch (err) {
      console.error('Error saving settings:', err);
    }
  }

  // =========================================================================
  // CUSTOMER SIDE PAYMENT HISTORY
  // =========================================================================

  filterCustomerPayments(filter = null) {
    if (filter) this.customerPaymentFilter = filter;
    const searchVal = (document.getElementById('custPaySearchInput')?.value || '').toLowerCase().trim();

    ['All', 'UPI', 'Cash', 'Verified', 'Pending'].forEach(f => {
      const tab = document.getElementById(`custPayTab${f}`);
      if (tab) tab.classList.toggle('active', (filter || this.customerPaymentFilter) === f);
    });

    this.renderCustomerPayments(searchVal);
  }

  renderCustomerPayments(searchQuery = null) {
    const tableBody = document.getElementById('custPaymentsTableBody');
    if (!tableBody) return;
    if (!this.currentUser) return;

    const userMobileClean = (this.currentUser.mobile || '').replace(/[^0-9]/g, '');

    // Filter user's payment records
    let list = (this.payments || []).filter(p => {
      if (p.customer_mobile && p.customer_mobile.replace(/[^0-9]/g, '') === userMobileClean) return true;
      const matchingOrder = (this.orders || []).find(o => o.order_number === p.order_number);
      if (matchingOrder && matchingOrder.customer_mobile.replace(/[^0-9]/g, '') === userMobileClean) return true;
      return false;
    });

    // Summary stats
    const totalSpent = list.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const paidCount = list.filter(p => (p.payment_status || '').includes('Paid') || (p.payment_status || '').includes('Verified') || (p.payment_status || '').includes('Cash Received')).length;
    const pendingCount = list.filter(p => (p.payment_status || '').includes('Pending') || (p.payment_status || '').includes('Verification')).length;

    const elTotal = document.getElementById('custPayStatTotal');
    const elPaid = document.getElementById('custPayStatPaid');
    const elPending = document.getElementById('custPayStatPending');

    if (elTotal) elTotal.innerText = `₹${totalSpent.toLocaleString('en-IN')}`;
    if (elPaid) elPaid.innerText = paidCount;
    if (elPending) elPending.innerText = pendingCount;

    // Filter tabs
    const activeFilter = this.customerPaymentFilter || 'All';
    if (activeFilter === 'UPI') {
      list = list.filter(p => (p.payment_method || '').includes('UPI') || (p.payment_method || '').includes('Online'));
    } else if (activeFilter === 'Cash') {
      list = list.filter(p => !(p.payment_method || '').includes('UPI') && !(p.payment_method || '').includes('Online'));
    } else if (activeFilter === 'Verified') {
      list = list.filter(p => (p.payment_status || '').includes('Paid') || (p.payment_status || '').includes('Verified') || (p.payment_status || '').includes('Cash Received'));
    } else if (activeFilter === 'Pending') {
      list = list.filter(p => (p.payment_status || '').includes('Pending') || (p.payment_status || '').includes('Verification'));
    }

    // Search query filter
    const query = searchQuery !== null ? searchQuery : (document.getElementById('custPaySearchInput')?.value || '').toLowerCase().trim();
    if (query) {
      list = list.filter(p =>
        (p.order_number || '').toLowerCase().includes(query) ||
        (p.utr_number || '').toLowerCase().includes(query) ||
        (p.payment_method || '').toLowerCase().includes(query) ||
        (p.payment_status || '').toLowerCase().includes(query)
      );
    }

    if (!list.length) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
            <i class="fa-solid fa-wallet" style="font-size: 2.5rem; color: var(--accent-gold); margin-bottom: 0.75rem;"></i>
            <h3 style="color: #FFF; font-size: 1.1rem; margin-bottom: 0.25rem;">No Payment History Found</h3>
            <p style="font-size: 0.85rem;">No payment receipts match your selected filter.</p>
          </td>
        </tr>
      `;
      return;
    }

    tableBody.innerHTML = list.map(p => this.createCustomerPaymentTableRowHTML(p)).join('');
  }

  createCustomerPaymentTableRowHTML(p) {
    const isPaid = (p.payment_status || '').includes('Paid') || (p.payment_status || '').includes('Verified') || (p.payment_status || '').includes('Cash Received');
    const isPending = (p.payment_status || '').includes('Pending') || (p.payment_status || '').includes('Verification');
    const isUPI = (p.payment_method || '').includes('UPI') || (p.payment_method || '').includes('Online');

    const statusBg = isPaid ? 'rgba(76, 175, 80, 0.15)' : isPending ? 'rgba(234, 162, 33, 0.15)' : 'rgba(229, 57, 53, 0.15)';
    const statusBorder = isPaid ? '#4CAF50' : isPending ? '#EAA221' : '#E53935';
    const statusColor = isPaid ? '#4CAF50' : isPending ? '#FFB74D' : '#FF5252';

    return `
      <tr style="border-bottom: 1px solid var(--border-color); transition: background 0.2s ease;">
        <!-- 1. Order ID & Date -->
        <td style="padding: 14px 16px; vertical-align: middle;">
          <div style="font-weight: 800; font-size: 0.95rem; color: var(--accent-gold);">
            <i class="fa-solid fa-receipt"></i> #${p.order_number}
          </div>
          <div style="font-size: 0.74rem; color: var(--text-muted); margin-top: 3px;">
            <i class="fa-regular fa-clock"></i> ${p.date_time || 'Today'}
          </div>
        </td>

        <!-- 2. Transaction ID / UTR -->
        <td style="padding: 14px 16px; vertical-align: middle;">
          ${p.utr_number ? `
            <code style="background: rgba(234, 162, 33, 0.15); color: var(--accent-gold); border: 1px solid rgba(234, 162, 33, 0.3); padding: 4px 9px; border-radius: 6px; font-family: monospace; font-weight: 700; font-size: 0.85rem; display: inline-block;">
              ${p.utr_number}
            </code>
            <div style="font-size: 0.72rem; color: #29B6F6; font-weight: 700; margin-top: 4px;">
              <i class="fa-solid fa-qrcode"></i> ${p.payment_method}
            </div>
          ` : `
            <span style="font-size: 0.82rem; color: #4CAF50; font-weight: 700;">
              <i class="fa-solid fa-money-bill-wave"></i> Cash Payment
            </span>
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 2px;">Counter Payment</div>
          `}
        </td>

        <!-- 3. Screenshot -->
        <td style="padding: 14px 16px; vertical-align: middle;">
          ${p.payment_screenshot ? `
            <div style="display: flex; align-items: center; gap: 10px;">
              <img src="${p.payment_screenshot}" onclick="app.viewFullScreenshot('${p.payment_screenshot}')" class="payment-screenshot-thumb" style="width: 46px; height: 46px; object-fit: cover; border-radius: 8px; border: 1.5px solid var(--accent-gold); cursor: pointer;" title="Click to view full screenshot">
              <button type="button" class="btn-sm-status" onclick="app.viewFullScreenshot('${p.payment_screenshot}')" style="background: rgba(234, 162, 33, 0.15); color: var(--accent-gold); border: 1px solid rgba(234, 162, 33, 0.3); padding: 4px 10px; border-radius: 6px; font-size: 0.75rem; font-weight: 700; cursor: pointer;">
                <i class="fa-solid fa-camera"></i> View
              </button>
            </div>
          ` : `
            <span style="font-size: 0.75rem; color: var(--text-muted); background: rgba(255,255,255,0.05); padding: 4px 10px; border-radius: 6px; display: inline-block;">
              No Screenshot
            </span>
          `}
        </td>

        <!-- 4. Payment Status -->
        <td style="padding: 14px 16px; vertical-align: middle;">
          <span style="background: ${statusBg}; border: 1px solid ${statusBorder}; color: ${statusColor}; font-size: 0.76rem; font-weight: 800; padding: 4px 12px; border-radius: 12px; display: inline-flex; align-items: center; gap: 6px;">
            <i class="fa-solid ${isPaid ? 'fa-circle-check' : 'fa-hourglass-half'}"></i> ${p.payment_status}
          </span>
          <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 4px; font-weight: 600;">
            Amount: <strong style="color: var(--accent-gold); font-size: 0.88rem;">₹${p.amount}</strong>
          </div>
        </td>

        <!-- 5. Download Invoice / Bill -->
        <td style="padding: 14px 16px; vertical-align: middle; text-align: center;">
          <button type="button" class="btn-sm-status" onclick="app.downloadSinglePaymentVoucher('${p.order_number}')" style="background: linear-gradient(135deg, #EAA221, #D9531E); color: #FFFFFF; border: none; padding: 8px 16px; border-radius: 8px; font-size: 0.78rem; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 4px 12px rgba(217, 83, 30, 0.35);" title="Download Official Receipt Invoice">
            <i class="fa-solid fa-download"></i> Tax Invoice
          </button>
        </td>
      </tr>
    `;
  }

  downloadCustomerPaymentStatementCSV() {
    if (!this.currentUser) return;
    const userMobileClean = (this.currentUser.mobile || '').replace(/[^0-9]/g, '');

    const userPayments = (this.payments || []).filter(p => {
      if (p.customer_mobile && p.customer_mobile.replace(/[^0-9]/g, '') === userMobileClean) return true;
      const matchingOrder = (this.orders || []).find(o => o.order_number === p.order_number);
      if (matchingOrder && matchingOrder.customer_mobile.replace(/[^0-9]/g, '') === userMobileClean) return true;
      return false;
    });

    if (!userPayments.length) {
      this.showToast('No payment history records to download.', 'info');
      return;
    }

    const headers = ['Order Number', 'Amount (INR)', 'Payment Method', 'UTR Ref Number', 'Date & Time', 'Payment Status'];
    const rows = userPayments.map(p => [
      `"${p.order_number}"`,
      `"${p.amount}"`,
      `"${p.payment_method}"`,
      `"${p.utr_number || 'N/A'}"`,
      `"${p.date_time}"`,
      `"${p.payment_status}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Payment_Statement_${(this.currentUser.name || 'Customer').replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.showToast('Payment statement downloaded (CSV)!', 'success');
  }

  async updatePaymentStatus(paymentId, newStatus) {
    try {
      const res = await fetch(`${API_BASE}/payments/${paymentId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_status: newStatus })
      });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message, 'success');
        await this.fetchPayments();
      }
    } catch (err) {
      console.error('Error updating payment status:', err);
    }
  }

  populateSettingsForm() {
    if (!this.settings) return;
    document.getElementById('setHotelName').value = this.settings.hotel_name || '';
    document.getElementById('setPhone').value = this.settings.phone || '';
    document.getElementById('setAddress').value = this.settings.address || '';
    document.getElementById('setOpenTime').value = this.settings.open_time || '';
    document.getElementById('setCloseTime').value = this.settings.close_time || '';
    document.getElementById('setHolidays').value = this.settings.holidays || '';
    document.getElementById('setUpiId').value = this.settings.upi_id || '';
    document.getElementById('setDesc').value = this.settings.description || '';

    const setQr = document.getElementById('setQrPreviewImg');
    if (setQr && this.settings.upi_qr_code) {
      setQr.src = this.settings.upi_qr_code;
    }

    const sw = document.getElementById('settingHotelOpenSwitch');
    const lbl = document.getElementById('settingHotelOpenLabel');
    const isOpen = Boolean(this.settings.is_open);
    if (sw) sw.classList.toggle('active', isOpen);
    if (lbl) lbl.innerText = isOpen ? '🟢 HOTEL OPEN' : '🔴 HOTEL CLOSED';
  }

  async toggleSettingsHotelOpen() {
    this.settings.is_open = !this.settings.is_open;
    this.populateSettingsForm();
    await this.saveBusinessSettingsDirect();
  }

  async toggleMasterHotelStatus() {
    this.settings.is_open = !this.settings.is_open;
    await this.saveBusinessSettingsDirect();
  }

  async saveBusinessSettingsDirect() {
    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.settings)
      });
      const json = await res.json();
      if (json.success) {
        this.updateHeaderAndSettingsUI();
        this.showToast(`Hotel status updated to ${this.settings.is_open ? 'OPEN' : 'CLOSED'}`, 'info');
      }
    } catch (err) {
      console.error('Error updating hotel status:', err);
    }
  }

  async saveBusinessSettings(e) {
    e.preventDefault();

    const payload = {
      hotel_name: document.getElementById('setHotelName').value,
      phone: document.getElementById('setPhone').value,
      address: document.getElementById('setAddress').value,
      open_time: document.getElementById('setOpenTime').value,
      close_time: document.getElementById('setCloseTime').value,
      holidays: document.getElementById('setHolidays').value,
      upi_id: document.getElementById('setUpiId').value,
      upi_qr_code: this.tempOwnerQrCode || (this.settings ? this.settings.upi_qr_code : '/images/upi_qr_scanner.png'),
      description: document.getElementById('setDesc').value,
      is_open: this.settings.is_open
    };

    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (json.success) {
        this.settings = json.data;
        this.tempOwnerQrCode = null;
        this.updateHeaderAndSettingsUI();
        this.showToast('Business settings & UPI QR Scanner saved successfully.', 'success');
      }
    } catch (err) {
      console.error('Error saving settings:', err);
    }
  }

  updateHeaderAndSettingsUI() {
    if (!this.settings) return;
    document.getElementById('headerHotelName').innerText = this.settings.hotel_name || 'Annapurna Tiffin Center';
    document.getElementById('sidebarHotelName').innerText = this.settings.hotel_name || 'Annapurna Tiffin';
    document.getElementById('headerAddress').innerText = (this.settings.address || '').split(',')[0];
    document.getElementById('checkoutUpiIdDisplay').innerText = this.settings.upi_id || 'annapurna@upi';

    const checkoutQr = document.getElementById('checkoutQrScannerImg');
    if (checkoutQr && this.settings.upi_qr_code) {
      checkoutQr.src = this.settings.upi_qr_code;
    }

    const setQr = document.getElementById('setQrPreviewImg');
    if (setQr && this.settings.upi_qr_code) {
      setQr.src = this.settings.upi_qr_code;
    }

    // Master Switch UI
    const mSwitch = document.getElementById('masterHotelSwitch');
    const mText = document.getElementById('masterHotelStatusText');
    const tag = document.getElementById('customerHotelStatusTag');

    const isOpen = Boolean(this.settings.is_open);
    if (mSwitch) mSwitch.classList.toggle('active', isOpen);
    if (mText) mText.innerText = isOpen ? '🟢 HOTEL OPEN' : '🔴 HOTEL CLOSED';

    if (tag) {
      tag.className = `hotel-status-tag ${isOpen ? 'open' : 'closed'}`;
      tag.innerHTML = isOpen ? `<i class="fa-solid fa-circle"></i> <span>🟢 HOTEL OPEN - Taking Orders</span>`
        : `<i class="fa-solid fa-circle"></i> <span>🔴 HOTEL CLOSED - Currently Closed</span>`;
    }
  }

  // =========================================================================
  // NOTIFICATIONS TRAY & TOAST UTILITIES
  // =========================================================================

  toggleNotificationsTray(open = null) {
    const backdrop = document.getElementById('notifBackdrop');
    const isOpen = open !== null ? open : !backdrop.classList.contains('open');
    backdrop.classList.toggle('open', isOpen);
  }

  renderNotificationsUI() {
    const badge = document.getElementById('notifBadgeCount');
    const unread = this.notifications.filter(n => !n.is_read).length;

    if (unread > 0) {
      badge.innerText = unread;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    const container = document.getElementById('notifListContainer');
    if (!container) return;

    if (!this.notifications.length) {
      container.innerHTML = `<p style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No notifications.</p>`;
      return;
    }

    container.innerHTML = this.notifications.map(n => `
      <div style="background: ${n.is_read ? 'var(--bg-surface)' : 'var(--bg-surface-elevated)'}; padding: 10px; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-bottom: 8px;">
        <div style="font-size: 0.82rem; font-weight: ${n.is_read ? '500' : '700'}; color: var(--text-main); margin-bottom: 4px;">
          ${n.message}
        </div>
        <span style="font-size: 0.7rem; color: var(--text-muted);">${new Date(n.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    `).join('');
  }

  async markNotificationsRead() {
    try {
      await fetch(`${API_BASE}/notifications/read-all`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: this.currentRole })
      });
      await this.fetchNotifications();
    } catch (err) {
      console.error('Error marking notifications read:', err);
    }
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';

    let icon = '<i class="fa-solid fa-info-circle" style="color: var(--accent-gold);"></i>';
    if (type === 'success') icon = '<i class="fa-solid fa-circle-check" style="color: var(--status-completed);"></i>';
    if (type === 'error') icon = '<i class="fa-solid fa-circle-exclamation" style="color: var(--color-unavailable);"></i>';

    toast.innerHTML = `${icon} <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(50px)';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  saveCustomerProfile(e) {
    e.preventDefault();
    this.customerProfile.name = document.getElementById('profNameInput').value;
    this.customerProfile.phone = document.getElementById('profPhoneInput').value;
    this.customerProfile.email = document.getElementById('profEmailInput').value;
    this.customerProfile.address = document.getElementById('profAddressInput').value;

    document.getElementById('profNameDisplay').innerText = this.customerProfile.name;
    document.getElementById('profPhoneDisplay').innerText = this.customerProfile.phone;

    this.showToast('Profile updated successfully.', 'success');
  }

  // =========================================================================
  // SUPPORT TICKETS & FAQ ENGINE
  // =========================================================================

  async fetchFaqs() {
    try {
      const res = await fetch(`${API_BASE}/support/faqs`);
      const json = await res.json();
      if (json.success) {
        this.faqs = json.data;
        if (this.activeView === 'secCustomerSupport') {
          this.renderFaqs();
        }
      }
    } catch (err) {
      console.error('Error fetching FAQs:', err);
    }
  }

  async fetchSupportTickets(silent = false) {
    try {
      const role = this.currentRole;
      let url = `${API_BASE}/support/tickets?role=${role}`;
      if (this.currentUser) {
        url += `&user_id=${this.currentUser.id}&mobile=${this.currentUser.mobile}`;
      }

      const res = await fetch(url);
      const json = await res.json();
      if (json.success) {
        this.supportTickets = json.data;
        if (!silent || this.activeView === 'secCustomerSupport' || this.activeView === 'secOwnerSupport') {
          if (this.currentRole === 'OWNER') {
            this.renderOwnerTickets();
          } else {
            this.renderCustomerTickets();
          }
        }
        if (this.activeTicketId && document.getElementById('ticketThreadModalBackdrop')?.classList.contains('open')) {
          const activeTkt = this.supportTickets.find(t => t.id === this.activeTicketId);
          if (activeTkt) {
            this.renderTicketThreadMessages(activeTkt);
          }
        }
      }
    } catch (err) {
      console.error('Error fetching support tickets:', err);
    }
  }

  renderFaqs() {
    const container = document.getElementById('faqAccordionContainer');
    if (!container) return;

    const query = (document.getElementById('faqSearchInput')?.value || '').toLowerCase().trim();
    const filtered = (this.faqs || []).filter(f =>
      !query ||
      f.question.toLowerCase().includes(query) ||
      f.answer.toLowerCase().includes(query) ||
      f.category.toLowerCase().includes(query)
    );

    if (!filtered.length) {
      container.innerHTML = `
        <div style="text-align: center; padding: 2rem; color: var(--text-muted);">
          <i class="fa-solid fa-circle-question" style="font-size: 2rem; margin-bottom: 0.5rem;"></i>
          <p>No questions matching "${query}". Try searching for another topic!</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(faq => `
      <div class="faq-accordion-item" id="faqItem_${faq.id}">
        <div class="faq-accordion-header" onclick="app.toggleFaqAccordion('${faq.id}')">
          <span><i class="fa-solid fa-circle-info" style="color: var(--accent-gold); margin-right: 8px;"></i> ${faq.question}</span>
          <i class="fa-solid fa-chevron-down faq-icon-toggle"></i>
        </div>
        <div class="faq-accordion-content">
          <p>${faq.answer}</p>
        </div>
      </div>
    `).join('');
  }

  filterFaqs() {
    this.renderFaqs();
  }

  toggleFaqAccordion(id) {
    const item = document.getElementById(`faqItem_${id}`);
    if (item) {
      item.classList.toggle('open');
    }
  }

  triggerQuickAiBotPrompt() {
    const box = document.getElementById('aiBotBox');
    if (box) {
      box.classList.remove('hidden');
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  closeQuickAiBotPrompt() {
    const box = document.getElementById('aiBotBox');
    if (box) box.classList.add('hidden');
  }

  runAiQuery(topic) {
    const area = document.getElementById('aiBotResponseArea');
    if (!area) return;
    area.classList.remove('hidden');

    let reply = '';
    if (topic === 'track_order') {
      const recent = (this.orders || [])[0];
      if (recent) {
        reply = `<strong>🤖 Smart Assistant:</strong> Your most recent order <strong>#${recent.order_number}</strong> (${recent.order_type}) is currently in status: <span class="highlight-gold">${recent.order_status}</span>. You can view full details in the 'My Orders' section.`;
      } else {
        reply = `<strong>🤖 Smart Assistant:</strong> You don't have any active orders right now. Explore our fresh breakfast & lunch menu to place a new order!`;
      }
    } else if (topic === 'payment_issue') {
      reply = `<strong>🤖 Smart Assistant:</strong> Online UPI payments (GPay/PhonePe/Paytm) are instantly verified. If money was deducted but order shows pending, please click 'Raise Support Ticket' with your Order ID or call our helpline (+91 98765 43210).`;
    } else if (topic === 'customization') {
      reply = `<strong>🤖 Smart Assistant:</strong> You can add special instructions for extra sambar, coconut chutney, less oil, or extra crispy dosas right in the 'Order Notes' text field during checkout!`;
    } else if (topic === 'catering') {
      reply = `<strong>🤖 Smart Assistant:</strong> We cater for family functions, office breakfasts, and bulk tiffin orders (10 to 500+ guests). Please raise a support ticket under 'Bulk & Catering Inquiry' or call +91 98765 43210.`;
    } else if (topic === 'timings') {
      reply = `<strong>🤖 Smart Assistant:</strong> Our hotel opens at 06:30 AM every morning serving steaming hot tiffins, and remains open until 10:30 PM, 7 days a week including holidays!`;
    }

    area.innerHTML = reply;
  }

  openRaiseTicketModal() {
    if (!this.currentUser) {
      this.showToast('Please Login or Register to submit a support ticket.', 'error');
      this.openAuthModal('CUSTOMER', 'LOGIN');
      return;
    }

    const orderSelect = document.getElementById('tktFormOrderSelect');
    if (orderSelect) {
      const custMobileClean = (this.currentUser.mobile || '').replace(/[^0-9]/g, '');
      const userOrders = (this.orders || []).filter(o => o.customer_mobile.replace(/[^0-9]/g, '') === custMobileClean);

      orderSelect.innerHTML = `
        <option value="General Inquiry">General Inquiry (No specific order)</option>
        ${userOrders.map(o => `<option value="${o.order_number}">Order #${o.order_number} (${o.order_type} - ₹${o.grand_total})</option>`).join('')}
      `;
    }

    document.getElementById('tktFormSubject').value = '';
    document.getElementById('tktFormMessage').value = '';
    this.toggleRaiseTicketModal(true);
  }

  toggleRaiseTicketModal(open = true) {
    const backdrop = document.getElementById('raiseTicketModalBackdrop');
    if (backdrop) backdrop.classList.toggle('open', open);
  }

  async handleRaiseTicketSubmit(e) {
    e.preventDefault();
    if (!this.currentUser) return;

    const order_number = document.getElementById('tktFormOrderSelect').value;
    const category = document.getElementById('tktFormCategorySelect').value;
    const subject = document.getElementById('tktFormSubject').value;
    const priority = document.getElementById('tktFormPriority').value;
    const message = document.getElementById('tktFormMessage').value;

    try {
      const res = await fetch(`${API_BASE}/support/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: this.currentUser.id,
          customer_name: this.currentUser.name,
          customer_mobile: this.currentUser.mobile,
          order_number,
          category,
          subject,
          priority,
          message
        })
      });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message, 'success');
        this.toggleRaiseTicketModal(false);
        await this.fetchSupportTickets();
      } else {
        this.showToast(json.message || 'Failed to submit support ticket', 'error');
      }
    } catch (err) {
      console.error('Error submitting support ticket:', err);
      this.showToast('Server communication error.', 'error');
    }
  }

  filterCustomerTickets(status) {
    this.customerTicketFilter = status;
    ['All', 'Open', 'InProgress', 'Resolved'].forEach(s => {
      const chip = document.getElementById(`chipTktFilter${s}`);
      if (chip) {
        const normalized = s === 'InProgress' ? 'In Progress' : s;
        chip.classList.toggle('active', status === normalized);
      }
    });
    this.renderCustomerTickets();
  }

  renderCustomerTickets() {
    const container = document.getElementById('customerTicketsList');
    if (!container) return;

    let list = this.supportTickets || [];
    if (this.customerTicketFilter !== 'All') {
      list = list.filter(t => t.status === this.customerTicketFilter);
    }

    if (!list.length) {
      container.innerHTML = `
        <div style="text-align: center; padding: 2rem; background: var(--bg-surface); border-radius: var(--radius-md); color: var(--text-muted);">
          <i class="fa-solid fa-ticket" style="font-size: 2rem; margin-bottom: 0.5rem; color: var(--accent-gold);"></i>
          <p>No support tickets found in '${this.customerTicketFilter}' status.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = list.map(t => {
      const pClass = (t.priority || 'Medium').toLowerCase();
      const stClass = (t.status || 'Open').toLowerCase().replace(' ', '');
      const createdDate = new Date(t.created_at || Date.now()).toLocaleString('en-IN');
      const msgCount = (t.messages || []).length;

      return `
        <div class="customer-ticket-card" onclick="app.openTicketThreadModal('${t.id}')">
          <div class="tkt-header">
            <div style="display: flex; align-items: center; gap: 10px;">
              <span class="tkt-number">${t.ticket_number}</span>
              <span class="tkt-priority-tag ${pClass}">${t.priority} Priority</span>
              ${t.order_number !== 'General Inquiry' ? `<span class="tkt-order-tag"><i class="fa-solid fa-receipt"></i> #${t.order_number}</span>` : ''}
            </div>
            <span class="status-badge st-${stClass}">${t.status}</span>
          </div>
          <div class="tkt-subject">${t.subject}</div>
          <p style="font-size: 0.84rem; color: var(--text-muted); line-height: 1.4;">${t.category} • Last message by ${(t.messages[t.messages.length - 1] || {}).sender_name || 'Customer'}</p>
          <div class="tkt-footer">
            <span><i class="fa-regular fa-clock"></i> Created: ${createdDate}</span>
            <span style="color: var(--accent-gold); font-weight: 700;"><i class="fa-regular fa-comments"></i> ${msgCount} ${msgCount === 1 ? 'message' : 'messages'} →</span>
          </div>
        </div>
      `;
    }).join('');
  }

  openTicketThreadModal(ticketId) {
    this.activeTicketId = ticketId;
    const ticket = (this.supportTickets || []).find(t => t.id === ticketId || t.ticket_number === ticketId);
    if (!ticket) return;

    document.getElementById('threadModalTicketNum').innerText = ticket.ticket_number;
    const stBadge = document.getElementById('threadModalStatusBadge');
    if (stBadge) {
      stBadge.innerText = ticket.status;
      stBadge.className = `status-badge st-${ticket.status.toLowerCase().replace(' ', '')}`;
    }

    document.getElementById('threadModalSubInfo').innerText = `Category: ${ticket.category} | Order: ${ticket.order_number} | Customer: ${ticket.customer_name} (${ticket.customer_mobile})`;

    // Show/hide owner quick replies and status toolbar based on active role
    const isOwner = this.currentRole === 'OWNER';
    const ownerReplies = document.getElementById('ownerQuickReplies');
    const ownerStatusToolbar = document.getElementById('ownerThreadStatusToolbar');

    if (ownerReplies) ownerReplies.classList.toggle('hidden', !isOwner);
    if (ownerStatusToolbar) ownerStatusToolbar.classList.toggle('hidden', !isOwner);

    this.renderTicketThreadMessages(ticket);
    this.toggleTicketThreadModal(true);
  }

  toggleTicketThreadModal(open = true) {
    const backdrop = document.getElementById('ticketThreadModalBackdrop');
    if (backdrop) backdrop.classList.toggle('open', open);
  }

  renderTicketThreadMessages(ticket) {
    const container = document.getElementById('ticketThreadMessages');
    if (!container) return;

    container.innerHTML = (ticket.messages || []).map(m => {
      const isOwnerSender = m.sender_role === 'OWNER';
      const timeStr = new Date(m.timestamp || Date.now()).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

      return `
        <div class="chat-bubble ${isOwnerSender ? 'chat-bubble-owner' : 'chat-bubble-customer'}">
          <span class="chat-sender-tag">${isOwnerSender ? '🏨 ' + m.sender_name : '👤 ' + m.sender_name}</span>
          <div>${m.message}</div>
          <span class="chat-time-tag">${timeStr}</span>
        </div>
      `;
    }).join('');

    setTimeout(() => {
      container.scrollTop = container.scrollHeight;
    }, 100);
  }

  async handleSendTicketMessage(e) {
    e.preventDefault();
    if (!this.activeTicketId) return;

    const input = document.getElementById('ticketReplyInput');
    const message = input.value.trim();
    if (!message) return;

    const sender_role = this.currentRole;
    const sender_name = this.currentUser ? this.currentUser.name : (sender_role === 'OWNER' ? 'Lakshmi Narayana (Owner)' : 'Customer');

    try {
      const res = await fetch(`${API_BASE}/support/tickets/${this.activeTicketId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender_role, sender_name, message })
      });
      const json = await res.json();
      if (json.success) {
        input.value = '';
        await this.fetchSupportTickets();
      } else {
        this.showToast(json.message || 'Failed to send message', 'error');
      }
    } catch (err) {
      console.error('Error sending ticket reply:', err);
      this.showToast('Server communication error.', 'error');
    }
  }

  insertQuickReply(text) {
    const input = document.getElementById('ticketReplyInput');
    if (input) {
      input.value = text;
      input.focus();
    }
  }

  async changeActiveTicketStatus(newStatus) {
    if (!this.activeTicketId) return;
    try {
      const res = await fetch(`${API_BASE}/support/tickets/${this.activeTicketId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message, 'success');
        const stBadge = document.getElementById('threadModalStatusBadge');
        if (stBadge) {
          stBadge.innerText = newStatus;
          stBadge.className = `status-badge st-${newStatus.toLowerCase().replace(' ', '')}`;
        }
        await this.fetchSupportTickets();
      } else {
        this.showToast(json.message || 'Failed to update status', 'error');
      }
    } catch (err) {
      console.error('Error changing ticket status:', err);
    }
  }

  filterOwnerTickets(status) {
    if (status) this.ownerTicketFilter = status;
    const searchVal = (document.getElementById('ownerTktSearchInput')?.value || '').toLowerCase().trim();

    ['All', 'Open', 'InProgress', 'Resolved', 'Closed'].forEach(s => {
      const chip = document.getElementById(`chipOwnerTkt${s}`);
      if (chip) {
        const normalized = s === 'InProgress' ? 'In Progress' : s;
        chip.classList.toggle('active', (status || this.ownerTicketFilter) === normalized);
      }
    });

    this.renderOwnerTickets(searchVal);
  }

  renderOwnerTickets(searchQuery = null) {
    const cardsContainer = document.getElementById('ownerTicketsCardsContainer');
    if (!cardsContainer) return;

    let list = this.supportTickets || [];

    // Calculate owner stats
    const total = list.length;
    const openCount = list.filter(t => t.status === 'Open').length;
    const inProgressCount = list.filter(t => t.status === 'In Progress').length;
    const resolvedCount = list.filter(t => t.status === 'Resolved').length;

    const elTotal = document.getElementById('statTotalTickets');
    const elOpen = document.getElementById('statOpenTickets');
    const elProgress = document.getElementById('statInProgressTickets');
    const elResolved = document.getElementById('statResolvedTickets');

    if (elTotal) elTotal.innerText = total;
    if (elOpen) elOpen.innerText = openCount;
    if (elProgress) elProgress.innerText = inProgressCount;
    if (elResolved) elResolved.innerText = resolvedCount;

    if (this.ownerTicketFilter !== 'All') {
      list = list.filter(t => t.status === this.ownerTicketFilter);
    }

    const query = searchQuery !== null ? searchQuery : (document.getElementById('ownerTktSearchInput')?.value || '').toLowerCase().trim();

    if (query) {
      list = list.filter(t =>
        (t.ticket_number || '').toLowerCase().includes(query) ||
        (t.customer_name || '').toLowerCase().includes(query) ||
        (t.customer_mobile || '').includes(query) ||
        (t.order_number || '').toLowerCase().includes(query) ||
        (t.subject || '').toLowerCase().includes(query) ||
        (t.category || '').toLowerCase().includes(query)
      );
    }

    if (!list.length) {
      cardsContainer.innerHTML = `
        <div class="owner-tkt-empty-card">
          <i class="fa-solid fa-ticket-simple" style="font-size: 2.5rem; color: var(--accent-gold); margin-bottom: 0.75rem;"></i>
          <h3>No tickets found</h3>
          <p>No customer support tickets match the current filter or search criteria.</p>
        </div>
      `;
      return;
    }

    cardsContainer.innerHTML = list.map(t => {
      const updatedStr = new Date(t.updated_at || t.created_at).toLocaleString('en-IN', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
      });
      const stClass = t.status.toLowerCase().replace(' ', '');
      const pClass = (t.priority || 'Medium').toLowerCase();
      const initials = (t.customer_name || 'C').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
      const lastMsg = (t.messages && t.messages.length) ? t.messages[t.messages.length - 1] : null;
      const msgCount = (t.messages || []).length;

      return `
        <div class="owner-tkt-card ${stClass}" onclick="app.openTicketThreadModal('${t.id}')">
          <!-- Top Row: Customer Avatar, Name, Ticket #, Order #, Badges -->
          <div class="otc-top-bar">
            <div class="otc-user-info">
              <div class="otc-avatar">${initials}</div>
              <div>
                <h4 class="otc-cust-name">${t.customer_name}</h4>
                <span class="otc-cust-phone"><i class="fa-solid fa-phone"></i> ${t.customer_mobile}</span>
              </div>
            </div>

            <div class="otc-top-badges">
              <span class="otc-num"><i class="fa-solid fa-ticket" style="color: var(--accent-gold);"></i> ${t.ticket_number}</span>
              ${t.order_number && t.order_number !== 'General Inquiry' ? `<span class="otc-order-chip"><i class="fa-solid fa-receipt"></i> #${t.order_number}</span>` : ''}
              <span class="tkt-priority-tag ${pClass}">${t.priority}</span>
              <span class="status-badge st-${stClass}">${t.status}</span>
            </div>
          </div>

          <!-- Ticket Content Body -->
          <div class="otc-body">
            <div class="otc-subject">${t.subject}</div>
            <div class="otc-meta-row">
              <span class="otc-category-chip"><i class="fa-solid fa-tag"></i> Category: ${t.category}</span>
            </div>

            ${lastMsg ? `
              <div class="otc-last-msg">
                <span class="otc-msg-sender">${lastMsg.sender_role === 'OWNER' ? '🏨 You' : '👤 ' + lastMsg.sender_name}:</span>
                <span class="otc-msg-text">"${lastMsg.message}"</span>
              </div>
            ` : ''}
          </div>

          <!-- Footer Bar: Time & Reply Button -->
          <div class="otc-footer">
            <span class="otc-time"><i class="fa-regular fa-clock"></i> Updated: ${updatedStr}</span>
            <button class="otc-reply-btn" onclick="event.stopPropagation(); app.openTicketThreadModal('${t.id}')">
              <i class="fa-solid fa-reply"></i> Reply Thread (${msgCount})
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  toggleFloatingSupportPopover() {
    const popover = document.getElementById('floatingSupportPopover');
    if (popover) {
      popover.classList.toggle('hidden');
    }
  }

  openSupportFromFloating(target) {
    this.toggleFloatingSupportPopover();
    if (!this.currentUser) {
      if (target === 'ticket') {
        this.showToast('Please login to submit a support ticket.', 'error');
        this.openAuthModal('CUSTOMER', 'LOGIN');
        return;
      }
    }
    const view = this.currentRole === 'OWNER' ? 'secOwnerSupport' : 'secCustomerSupport';
    this.switchView(view);

    if (target === 'ticket' && this.currentRole === 'CUSTOMER') {
      setTimeout(() => this.openRaiseTicketModal(), 300);
    } else if (target === 'faq') {
      setTimeout(() => {
        const faqSec = document.querySelector('.faq-section');
        if (faqSec) faqSec.scrollIntoView({ behavior: 'smooth' });
      }, 300);
    }
  }

  // =========================================================================
  // REFERRAL SYSTEM (REFER & EARN) CLIENT METHODS
  // =========================================================================

  async fetchReferralStats() {
    if (!this.currentUser) return;
    const cleanMobile = (this.currentUser.mobile || '').replace(/[^0-9]/g, '');

    try {
      const res = await fetch(`${API_BASE}/referrals/stats?customer_mobile=${cleanMobile}`);
      const json = await res.json();
      if (json.success) {
        this.referralStats = json.data;
        this.renderReferralDashboard();
      }
    } catch (err) {
      console.error('Error fetching referral stats:', err);
    }
  }

  renderReferralDashboard() {
    if (!this.referralStats) return;
    const { referral_code, wallet_balance, total_referrals, completed_referrals, pending_referrals, total_rewards_earned, history, show_on_leaderboard } = this.referralStats;

    // Update Hero Referral Code Display
    const elCode = document.getElementById('referralCodeDisplay');
    if (elCode) elCode.innerText = referral_code || 'RAMESH50';

    // Update KPI Stat Cards
    const elWallet = document.getElementById('refStatWallet');
    const elTotal = document.getElementById('refStatTotal');
    const elCompleted = document.getElementById('refStatCompleted');
    const elEarned = document.getElementById('refStatEarned');

    if (elWallet) elWallet.innerText = `₹${wallet_balance.toLocaleString('en-IN')}`;
    if (elTotal) elTotal.innerText = total_referrals;
    if (elCompleted) elCompleted.innerText = completed_referrals;
    if (elEarned) elEarned.innerText = `₹${total_rewards_earned.toLocaleString('en-IN')}`;

    // Update Checkout Wallet Balance Box
    const elCheckoutText = document.getElementById('checkoutWalletAvailableText');
    const elCheckoutVal = document.getElementById('checkoutWalletDiscountVal');
    const chkWallet = document.getElementById('chkUseWallet');

    if (elCheckoutText) elCheckoutText.innerText = `Available Balance: ₹${wallet_balance}`;
    if (elCheckoutVal) {
      const discount = Math.min(wallet_balance, 30);
      elCheckoutVal.innerText = discount;
      if (chkWallet) {
        chkWallet.disabled = wallet_balance <= 0;
        chkWallet.checked = wallet_balance > 0 && this.appliedWalletDiscount > 0;
      }
    }

    // Update Milestones Progress
    const elMilestoneLabel = document.getElementById('milestoneProgressLabel');
    if (elMilestoneLabel) elMilestoneLabel.innerText = `${completed_referrals} / 10 Completed Referrals`;

    const box1 = document.getElementById('milestoneBox1');
    const box5 = document.getElementById('milestoneBox5');
    const box10 = document.getElementById('milestoneBox10');

    if (box1) box1.style.borderColor = completed_referrals >= 1 ? 'var(--accent-gold)' : 'var(--border-color)';
    if (box5) box5.style.borderColor = completed_referrals >= 5 ? 'var(--accent-gold)' : 'var(--border-color)';
    if (box10) box10.style.borderColor = completed_referrals >= 10 ? 'var(--accent-gold)' : 'var(--border-color)';

    // Update Privacy Switch UI
    const swPrivacy = document.getElementById('leaderboardPrivacySwitch');
    if (swPrivacy) swPrivacy.classList.toggle('active', show_on_leaderboard !== false);

    // Render Referral History Table
    const tableBody = document.getElementById('refHistoryTableBody');
    if (!tableBody) return;

    if (!history || !history.length) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; padding: 2rem 1rem; color: var(--text-muted);">
            <i class="fa-solid fa-gift" style="font-size: 2rem; color: var(--accent-gold); margin-bottom: 0.5rem;"></i>
            <p>No referrals yet. Share your referral code to earn ₹30 per friend!</p>
          </td>
        </tr>
      `;
      return;
    }

    tableBody.innerHTML = history.map(r => {
      let statusBadge = '<span class="status-badge preparing">🟡 Pending</span>';
      if (r.status === 'Completed') statusBadge = '<span class="status-badge ready">✅ Completed</span>';
      if (r.status === 'Cancelled') statusBadge = '<span class="status-badge rejected">❌ Cancelled</span>';

      // Privacy mask for friend name
      const nameParts = (r.referred_name || 'Friend').split(' ');
      const maskedName = nameParts.length > 1 ? `${nameParts[0]} ${nameParts[1][0]}.` : nameParts[0];

      return `
        <tr style="border-bottom: 1px solid var(--border-color);">
          <td style="padding: 10px; font-weight: 700; color: #FFF;">${maskedName}</td>
          <td style="padding: 10px; color: var(--text-muted); font-size: 0.78rem;">${r.date_time || 'Recent'}</td>
          <td style="padding: 10px;">${statusBadge}</td>
          <td style="padding: 10px; text-align: right; font-weight: 800; color: ${r.status === 'Completed' ? 'var(--accent-gold)' : 'var(--text-dim)'};">
            ${r.status === 'Completed' ? `+₹${r.reward_amount || 30}` : '₹0'}
          </td>
        </tr>
      `;
    }).join('');
  }

  async fetchLeaderboard() {
    try {
      const res = await fetch(`${API_BASE}/referrals/leaderboard`);
      const json = await res.json();
      if (json.success) {
        this.referralLeaderboard = json.data || [];
        this.renderLeaderboard();
      }
    } catch (err) {
      console.error('Error fetching leaderboard:', err);
    }
  }

  renderLeaderboard() {
    const container = document.getElementById('referralLeaderboardContainer');
    if (!container) return;

    if (!this.referralLeaderboard.length) {
      container.innerHTML = `
        <div style="text-align: center; padding: 1.5rem; color: var(--text-muted); font-size: 0.82rem;">
          <i class="fa-solid fa-trophy" style="font-size: 1.5rem; color: var(--accent-gold); margin-bottom: 0.5rem;"></i>
          <p>Leaderboard opens after first completed referral this month!</p>
        </div>
      `;
      return;
    }

    const rankBadges = ['🥇', '🥈', '🥉'];
    container.innerHTML = this.referralLeaderboard.map((item, idx) => `
      <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(10,10,14,0.4); padding: 8px 12px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 1rem; width: 22px;">${rankBadges[idx] || `#${idx + 1}`}</span>
          <span style="font-size: 0.85rem; font-weight: 700; color: ${item.is_anonymous ? 'var(--text-muted)' : '#FFF'};">
            ${item.name}
          </span>
        </div>
        <div style="font-size: 0.8rem; font-weight: 800; color: var(--accent-gold);">
          ${item.count} Referrals (₹${item.rewards})
        </div>
      </div>
    `).join('');
  }

  copyReferralCode() {
    const code = document.getElementById('referralCodeDisplay')?.innerText || 'RAMESH50';
    navigator.clipboard.writeText(code).then(() => {
      this.showToast(`Referral Code ${code} copied to clipboard!`, 'success');
    }).catch(() => {
      this.showToast(`Referral Code: ${code}`, 'info');
    });
  }

  shareReferralWhatsApp() {
    const code = document.getElementById('referralCodeDisplay')?.innerText || 'RAMESH50';
    const hotelName = this.settings.hotel_name || 'Sri Lakshmi Annapurna Tiffin Center';
    const msg = `Hey! Order delicious, authentic South Indian tiffins from ${hotelName}! Use my Referral Code *${code}* during registration to get ₹30 OFF your first order! 🍲✨ Order here: http://localhost:3000`;
    const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`;
    window.open(waUrl, '_blank');
  }

  async toggleLeaderboardPrivacy() {
    if (!this.currentUser) return;
    const currentState = this.referralStats?.show_on_leaderboard !== false;
    const newState = !currentState;

    try {
      const res = await fetch(`${API_BASE}/referrals/privacy`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_mobile: this.currentUser.mobile,
          show_on_leaderboard: newState
        })
      });
      const json = await res.json();
      if (json.success) {
        if (this.referralStats) this.referralStats.show_on_leaderboard = newState;
        const swPrivacy = document.getElementById('leaderboardPrivacySwitch');
        if (swPrivacy) swPrivacy.classList.toggle('active', newState);
        this.showToast(json.message, 'success');
        await this.fetchLeaderboard();
      }
    } catch (err) {
      console.error('Error toggling privacy:', err);
    }
  }

  toggleCheckoutWalletDiscount() {
    const chk = document.getElementById('chkUseWallet');
    const walletBal = Number(this.referralStats?.wallet_balance || 0);

    if (chk && chk.checked) {
      this.appliedWalletDiscount = Math.min(walletBal, 30);
      this.showToast(`Applied ₹${this.appliedWalletDiscount} Referral Wallet Discount!`, 'success');
    } else {
      this.appliedWalletDiscount = 0;
    }
  }

  toggleOwnerReferralProgram() {
    const sw = document.getElementById('setRefEnabledSwitch');
    const lbl = document.getElementById('setRefEnabledLabel');
    if (!sw) return;

    const isActive = sw.classList.contains('active');
    sw.classList.toggle('active', !isActive);
    if (lbl) lbl.innerText = !isActive ? '🟢 PROGRAM ON' : '🔴 PROGRAM OFF';
  }

  // =========================================================================
  // POST-ORDER REVIEW & RATING CLIENT METHODS
  // =========================================================================

  openOrderReviewModal(orderNum) {
    this.activeReviewOrderNumber = orderNum;
    this.selectedRating = 0;
    this.selectedIssues = [];

    const elOrderNum = document.getElementById('reviewOrderNumDisplay');
    if (elOrderNum) elOrderNum.innerText = `#${orderNum}`;

    const commentInput = document.getElementById('reviewComment');
    if (commentInput) commentInput.value = '';

    const btnSubmit = document.getElementById('btnSubmitReview');
    if (btnSubmit) btnSubmit.disabled = true;

    this.resetStarUI();
    this.updateReviewModalFlowUI();

    const backdrop = document.getElementById('orderReviewModalBackdrop');
    if (backdrop) backdrop.classList.add('open');
  }

  closeOrderReviewModal() {
    const backdrop = document.getElementById('orderReviewModalBackdrop');
    if (backdrop) backdrop.classList.remove('open');
  }

  resetStarUI() {
    document.querySelectorAll('#starRatingContainer .star-icon').forEach(icon => {
      icon.className = 'fa-regular fa-star star-icon';
      icon.style.color = 'var(--text-muted)';
    });
  }

  setStarRating(stars) {
    this.selectedRating = stars;

    document.querySelectorAll('#starRatingContainer .star-icon').forEach((icon, idx) => {
      if (idx < stars) {
        icon.className = 'fa-solid fa-star star-icon';
        icon.style.color = 'var(--accent-gold)';
      } else {
        icon.className = 'fa-regular fa-star star-icon';
        icon.style.color = 'var(--text-muted)';
      }
    });

    const btnSubmit = document.getElementById('btnSubmitReview');
    if (btnSubmit) btnSubmit.disabled = false;

    this.updateReviewModalFlowUI();
  }

  updateReviewModalFlowUI() {
    const header = document.getElementById('reviewDynamicHeader');
    const issuesBox = document.getElementById('reviewIssuesContainer');
    const publicBox = document.getElementById('reviewPublicOptInBox');

    if (!header) return;

    if (this.selectedRating === 0) {
      header.innerText = 'Tap a star rating above to begin';
      header.style.color = '#FFF';
      header.style.background = 'var(--bg-surface-elevated)';
      if (issuesBox) issuesBox.classList.add('hidden');
      if (publicBox) publicBox.classList.add('hidden');
    } else if (this.selectedRating >= 4) {
      // 4-5 Stars Positive Flow
      header.innerHTML = '❤️ Thank you! Would you like to share your experience publicly?';
      header.style.color = 'var(--accent-gold)';
      header.style.background = 'rgba(255, 179, 0, 0.12)';
      if (issuesBox) issuesBox.classList.add('hidden');
      if (publicBox) publicBox.classList.remove('hidden');
    } else {
      // 1-3 Stars Constructive Feedback Flow
      header.innerHTML = 'We\'re sorry! Tell us what went wrong so we can fix it immediately.';
      header.style.color = '#FF5252';
      header.style.background = 'rgba(255, 82, 82, 0.15)';
      if (issuesBox) issuesBox.classList.remove('hidden');
      if (publicBox) publicBox.classList.add('hidden');
    }
  }

  toggleReviewIssue(issueName) {
    const idx = this.selectedIssues.indexOf(issueName);
    if (idx > -1) {
      this.selectedIssues.splice(idx, 1);
    } else {
      this.selectedIssues.push(issueName);
    }

    document.querySelectorAll('#reviewIssuesContainer .filter-chip').forEach(btn => {
      btn.classList.toggle('active', this.selectedIssues.includes(btn.innerText.replace(/^[^\s]+\s*/, '')));
    });
  }

  async submitOrderReview(e) {
    if (e) e.preventDefault();
    if (!this.selectedRating) {
      this.showToast('Please select a star rating.', 'error');
      return;
    }

    const comment = document.getElementById('reviewComment')?.value.trim();
    const chkPublic = document.getElementById('chkReviewPublic');
    const isPublic = this.selectedRating >= 4 && chkPublic ? chkPublic.checked : false;

    const payload = {
      order_number: this.activeReviewOrderNumber,
      customer_name: this.currentUser ? this.currentUser.name : 'Customer',
      customer_mobile: this.currentUser ? this.currentUser.mobile : '',
      rating: this.selectedRating,
      comment: comment,
      issues: this.selectedIssues,
      is_public: isPublic
    };

    try {
      const res = await fetch(`${API_BASE}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message, 'success');
        this.closeOrderReviewModal();
        await this.fetchOrders();
        await this.fetchNotifications();
      } else {
        this.showToast(json.message || 'Error submitting review.', 'error');
      }
    } catch (err) {
      console.error('Error submitting review:', err);
      this.showToast('Server communication error.', 'error');
    }
  }

  async fetchReviewStats() {
    try {
      const res = await fetch(`${API_BASE}/reviews/stats`);
      const json = await res.json();
      if (json.success) {
        const { average_rating, total_reviews } = json.data;
        const elAvg = document.getElementById('ownerAvgRatingVal');
        const elTotal = document.getElementById('ownerTotalReviewsCount');
        if (elAvg) elAvg.innerText = average_rating.toFixed(1);
        if (elTotal) elTotal.innerText = total_reviews;
      }
    } catch (err) {
      console.error('Error fetching review stats:', err);
    }
  }

  // =========================================================================
  // MOBILE SLIDE-OUT DRAWER MENU METHODS
  // =========================================================================

  toggleMobileDrawer(forceState) {
    const backdrop = document.getElementById('mobileDrawerBackdrop');
    if (!backdrop) return;
    if (typeof forceState === 'boolean') {
      backdrop.classList.toggle('open', forceState);
    } else {
      backdrop.classList.toggle('open');
    }
    if (backdrop.classList.contains('open')) {
      this.renderMobileDrawerNav();
    }
  }

  renderMobileDrawerNav() {
    const drawerNav = document.getElementById('mobileDrawerNav');
    if (!drawerNav) return;

    if (!this.currentUser) {
      drawerNav.innerHTML = `
        <a class="nav-item ${this.activeView === 'secCustomerHome' ? 'active' : ''}" onclick="app.switchView('secCustomerHome'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-house"></i> Home Page</a>
        <a class="nav-item ${this.activeView === 'secCustomerHome' ? 'active' : ''}" onclick="app.switchView('secCustomerHome'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-utensils"></i> Today's Menu</a>
        <a class="nav-item" onclick="app.openAuthModal('CUSTOMER', 'LOGIN'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-right-to-bracket" style="color: var(--primary);"></i> Customer Login</a>
        <a class="nav-item" onclick="app.openAuthModal('CUSTOMER', 'REGISTER'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-user-plus" style="color: var(--accent-gold);"></i> Register New Account</a>
        <a class="nav-item" onclick="app.openAuthModal('OWNER', 'LOGIN'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-user-tie"></i> Hotel Owner Login</a>
        <a class="nav-item ${this.activeView === 'secCustomerSupport' ? 'active' : ''}" onclick="app.switchView('secCustomerSupport'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-headset"></i> Support & FAQs</a>
      `;
      return;
    }

    const isCustomer = this.currentRole === 'CUSTOMER';

    if (isCustomer) {
      drawerNav.innerHTML = `
        <a class="nav-item ${this.activeView === 'secCustomerHome' ? 'active' : ''}" onclick="app.switchView('secCustomerHome'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-house"></i> Home</a>
        <a class="nav-item ${this.activeView === 'secCustomerOrders' ? 'active' : ''}" onclick="app.switchView('secCustomerOrders'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-receipt"></i> My Orders</a>
        <a class="nav-item" onclick="app.toggleCartDrawer(); app.toggleMobileDrawer(false);"><i class="fa-solid fa-cart-shopping"></i> Shopping Cart (<span class="cart-count-text">0</span>)</a>
        <a class="nav-item ${this.activeView === 'secCustomerReferral' ? 'active' : ''}" onclick="app.switchView('secCustomerReferral'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-gift" style="color: var(--accent-gold);"></i> Refer & Earn (₹30)</a>
        <a class="nav-item ${this.activeView === 'secCustomerPayments' ? 'active' : ''}" onclick="app.switchView('secCustomerPayments'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-wallet"></i> Payment History</a>
        <a class="nav-item ${this.activeView === 'secCustomerSupport' ? 'active' : ''}" onclick="app.switchView('secCustomerSupport'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-headset"></i> Support & FAQs</a>
        <a class="nav-item ${this.activeView === 'secCustomerProfile' ? 'active' : ''}" onclick="app.switchView('secCustomerProfile'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-user-gear"></i> My Profile</a>
        <button class="btn-auth-logout" onclick="app.logout(); app.toggleMobileDrawer(false);" style="margin-top: 1rem; width: 100%; justify-content: center;"><i class="fa-solid fa-power-off"></i> Logout</button>
      `;
    } else {
      drawerNav.innerHTML = `
        <a class="nav-item ${this.activeView === 'secOwnerDashboard' ? 'active' : ''}" onclick="app.switchView('secOwnerDashboard'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-chart-line"></i> Dashboard</a>
        <a class="nav-item ${this.activeView === 'secOwnerTiffins' ? 'active' : ''}" onclick="app.switchView('secOwnerTiffins'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-utensils"></i> Manage Tiffins</a>
        <a class="nav-item ${this.activeView === 'secOwnerOrders' ? 'active' : ''}" onclick="app.switchView('secOwnerOrders'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-list-check"></i> Orders Management</a>
        <a class="nav-item ${this.activeView === 'secOwnerPayments' ? 'active' : ''}" onclick="app.switchView('secOwnerPayments'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-wallet"></i> Payment History</a>
        <a class="nav-item ${this.activeView === 'secOwnerSupport' ? 'active' : ''}" onclick="app.switchView('secOwnerSupport'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-headset"></i> Support Inbox</a>
        <a class="nav-item ${this.activeView === 'secOwnerSettings' ? 'active' : ''}" onclick="app.switchView('secOwnerSettings'); app.toggleMobileDrawer(false);"><i class="fa-solid fa-sliders"></i> Business Settings</a>
        <button class="btn-auth-logout" onclick="app.logout(); app.toggleMobileDrawer(false);" style="margin-top: 1rem; width: 100%; justify-content: center;"><i class="fa-solid fa-power-off"></i> Logout</button>
      `;
    }
  }
}

// Instantiate global app engine
const app = new TiffinApp();

document.addEventListener('DOMContentLoaded', () => {
  app.init();
});
