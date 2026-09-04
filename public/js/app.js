/* ==========================================================================
   Sri Lakshmi Annapurna Tiffin Center - Single Page Application Engine
   Role-Based Authentication, Live Availability Sync, Ordering & Management
   ========================================================================== */

const API_BASE = '/api';

// Safe HTML Escaping Helper for XSS Prevention and Safe UI Template Rendering
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
window.escapeHtml = escapeHtml;

// =========================================================================
// GLOBAL EARLY PWA EVENT LISTENER & SERVICE WORKER REGISTRATION
// Captures `beforeinstallprompt` IMMEDIATELY before any async app initialization!
// =========================================================================
window.deferredPwaPrompt = window.deferredPwaPrompt || null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.deferredPwaPrompt = e;
  console.log('[PWA Early Capture] beforeinstallprompt event captured and saved!');
  if (window.app && typeof window.app.updatePwaInstallStateUI === 'function') {
    window.app.updatePwaInstallStateUI();
  }
});

window.addEventListener('appinstalled', () => {
  window.deferredPwaPrompt = null;
  console.log('[PWA Early Capture] PWA installed successfully!');
  if (window.app && typeof window.app.showToast === 'function') {
    window.app.showToast('🎉 Thank you for installing Annapurna Tiffin App!', 'success');
  }
  if (window.app && typeof window.app.updatePwaInstallStateUI === 'function') {
    window.app.updatePwaInstallStateUI();
  }
});

// Immediate Service Worker Registration (registers immediately and checks for server updates)
if ('serviceWorker' in navigator) {
  const registerSw = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(reg => {
        console.log('[PWA SW] Registered successfully with scope:', reg.scope);
        reg.update(); // Force check for SW update on server
      })
      .catch(err => console.warn('[PWA SW] Registration failed:', err));
  };
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    registerSw();
  } else {
    window.addEventListener('DOMContentLoaded', registerSw);
  }
}

class TiffinApp {
  constructor() {
    this.currentRole = 'CUSTOMER'; // 'CUSTOMER' or 'OWNER'
    this.authToken = null;
    this.currentUser = null; // Logged in user object
    this.authRole = 'CUSTOMER'; // Modal role tab
    this.authMode = 'LOGIN'; // 'LOGIN' or 'REGISTER'
    this.activeView = 'secCustomerHome';
    this.cart = [];
    this.favorites = [];
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
    this.customerProfile = null;
    this.ownerReviewFilter = 'All';
    this.isLoadingOrders = false;
    this.isLoadingPayments = false;
    this.isLoadingStats = false;
    this.knownNotificationIds = new Set();
    this.activePopupNotifIds = new Set();
    this.isFirstNotificationFetch = true;
    this.audioCtx = null;

    // Real-Time WebSocket & Web Push State
    this.ws = null;
    this.wsReconnectTimer = null;
    this.wsReconnectDelay = 1000;
    this.wsPingInterval = null;
    this.isWsIntentionallyClosed = false;
    this.pushSubscription = null;
    this.vapidPublicKey = null;

    // Track active/processing operations for order buttons
    this.processingOrders = new Set();

    // Order Search & Filter State
    this.custOrderSearch = '';
    this.custTabFilter = 'ALL'; // 'ALL', 'PENDING', 'COMPLETED'
    this.custOrderStatus = 'ALL';
    this.custPaymentStatus = 'ALL';
    this.custPaymentMethod = 'ALL';
    this.custDatePreset = 'ALL';

    this.ownerOrderSearch = '';
    this.ownerFilterOrderStatus = 'ALL';
    this.ownerFilterPaymentStatus = 'ALL';
    this.ownerFilterPaymentMethod = 'ALL';
    this.ownerFilterDatePreset = 'ALL';

    // Customer Inactivity Auto-Logout State (20-Minute Timeout, CUSTOMER Only)
    this.customerInactivityDurationMs = 20 * 60 * 1000; // 20 minutes = 1,200,000 ms
    this.customerWarningDurationMs = 19 * 60 * 1000;    // 19 minutes = 1,140,000 ms
    this.lastCustomerActivityTimestamp = Date.now();
    this.inactivityCheckInterval = null;
    this.lastBroadcastActivityTime = 0;
    this.isWarningModalShowing = false;

    // Start Live 3-Minute Order Modification Timer Ticker
    this.startModificationTimerTicker();
  }

  async fetchWithAuth(url, options = {}) {
    const headers = options.headers ? { ...options.headers } : {};
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
      headers['X-Auth-Token'] = this.authToken;
    }
    if (options.isBackgroundPoll) {
      headers['X-Background-Poll'] = 'true';
    }

    // Attach unique Idempotency-Key header for state-mutating requests
    const method = (options.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !headers['X-Idempotency-Key'] && !headers['x-idempotency-key']) {
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(2, 8);
      const uid = this.currentUser ? this.currentUser.id : 'anon';
      headers['X-Idempotency-Key'] = `idem_${uid}_${timestamp}_${random}`;
    }
    try {
      const res = await fetch(url, { ...options, headers });
      if (res.status === 401 && this.currentUser) {
        if (this.currentUser.role === 'CUSTOMER') {
          const clone = res.clone();
          try {
            const body = await clone.json();
            if (body.code === 'SESSION_EXPIRED' || (body.message && body.message.toLowerCase().includes('inactivity'))) {
              this.triggerInactivityLogout("You have been logged out due to 20 minutes of inactivity.");
            }
          } catch (e) {}
        } else {
          console.warn('401 Unauthorized returned for:', url, '- preserving user session state');
        }
      }
      if (res.status === 403 && this.currentUser && this.currentUser.role === 'CUSTOMER') {
        const clone = res.clone();
        try {
          const body = await clone.json();
          if (body.code === 'PASSWORD_CHANGE_REQUIRED') {
            this.currentUser.password_change_required = true;
            this.checkPasswordChangeRequired();
          }
        } catch (e) {}
      }
      return res;
    } catch (err) {
      console.error(`Fetch error for ${url}:`, err);
      throw err;
    }
  }

  async fetchMe() {
    if (!this.authToken) return;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/auth/me`);
      const json = await res.json();
      if (json.success && json.user) {
        this.currentUser = json.user;
        this.currentRole = json.user.role;
        localStorage.setItem('tiffin_user', JSON.stringify(json.user));
        this.checkPasswordChangeRequired();
      }
    } catch (err) {
      console.error('Error refreshing profile:', err);
    }
  }

  async init() {
    console.log('Initializing Annapurna Tiffin Center App...');
    this.bindGlobalQuickActionListeners();
    this.startLivePrepTicker();

    // Restore session and token from localStorage if available
    const savedToken = localStorage.getItem('tiffin_token') || sessionStorage.getItem('tiffin_token');
    const savedUser = localStorage.getItem('tiffin_user') || sessionStorage.getItem('tiffin_user');

    if (savedUser && savedToken) {
      try {
        this.currentUser = JSON.parse(savedUser);
        this.authToken = savedToken;
        this.currentRole = this.currentUser.role;
        this.activeView = this.currentRole === 'OWNER' ? 'secOwnerDashboard' : 'secCustomerHome';
        
        // Deep-link routing via URL hash (e.g. from notification clicks or shortcuts)
        const rawHash = window.location.hash ? window.location.hash.replace('#', '') : '';
        const hashView = rawHash.split('?')[0];
        if (hashView && document.getElementById(hashView)) {
          this.activeView = hashView;
        }

        this.cart = this.currentUser.cart || [];
        this.favorites = this.currentUser.favorites || [];
        try {
          const savedAddons = localStorage.getItem('tiffin_selected_addons');
          if (savedAddons) this.selectedCartAddons = JSON.parse(savedAddons) || {};
        } catch (e) {}
        this.checkPasswordChangeRequired();
      } catch (e) {
        console.error('Failed to parse saved user:', e);
      }
    }

    // Bind hashchange event listener for notification deep links
    window.addEventListener('hashchange', () => {
      const rawHash = window.location.hash ? window.location.hash.replace('#', '') : '';
      const targetHash = rawHash.split('?')[0];
      if (targetHash && document.getElementById(targetHash)) {
        this.switchView(targetHash);
      }
    });



    await this.fetchSettings();
    await this.fetchMenu();
    await this.fetchFaqs();

    if (this.currentUser) {
      await this.fetchMe();
      await this.loadUserData();
      await this.handlePhonePeCallback();
      this.initWebSocket();
      this.initPushNotifications();
    }

    this.updateUserAuthBadgeUI();
    this.renderNavigation();
    this.renderCurrentView();
    this.updateCartUI();

    // Setup HTML5 History & Android Back Button / Gesture Navigation
    this.setupAndroidBackNavigation();

    // Start 2-second live polling engine for real-time status and availability sync
    this.startPolling();

    // Initialize 20-minute customer inactivity auto-logout engine
    this.initCustomerInactivityEngine();

    // Initialize PWA Progressive Web App installation & offline engine
    this.initPwaInstall();

    // Bind Web Audio Context unlocking on user gesture
    ['mousedown', 'click', 'keydown', 'touchstart', 'pointerdown'].forEach(evt => {
      window.addEventListener(evt, () => this.initAudioContext(), { passive: true });
    });
  }

  // =========================================================================
  // REAL-TIME WEBSOCKET & WEB PUSH DELIVERY ENGINE
  // =========================================================================

  initWebSocket() {
    if (!this.currentUser || !this.authToken) return;

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.isWsIntentionallyClosed = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws?token=${encodeURIComponent(this.authToken)}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[Real-Time WS] Connected to notification server.');
        this.wsReconnectDelay = 1000;
        
        if (this.wsPingInterval) clearInterval(this.wsPingInterval);
        this.wsPingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try { this.ws.send(JSON.stringify({ type: 'PING' })); } catch (e) {}
          }
        }, 25000);

        if (this.knownNotificationIds && this.knownNotificationIds.size > 0) {
          this.fetchNotifications(true);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg && msg.type === 'NOTIFICATION' && msg.data) {
            this.handleRealTimeNotificationReceived(msg.data);
          } else if (msg && (msg.type === 'VOTE_UPDATE' || msg.type === 'POLL_CREATED' || msg.type === 'POLL_CLOSED')) {
            this.loadActivePoll();
            if (this.activeView === 'secCustomerVoting') this.loadCustomerVoting();
            if (this.activeView === 'secOwnerVoting') this.loadOwnerPolls();
          } else if (msg && msg.type === 'SECURITY_ALERT') {
            this.showToast(`🚨 Security Alert (${msg.data.risk_level || 'HIGH'}): ${msg.data.event_type || 'Suspicious Activity'}`, 'warning');
            if (this.activeView === 'secOwnerSecurity') this.loadSecurityDashboard();
          } else if (msg && msg.type === 'REFUND_UPDATE') {
            if (this.activeView === 'secOwnerRefunds') this.loadOwnerRefundsDashboard();
            if (this.activeView === 'secCustomerOrders') this.renderOrders();
            if (this.currentActiveCustomerRefundId && msg.data && msg.data.refund_id === this.currentActiveCustomerRefundId) {
              this.openCustomerRefundModal(this.currentActiveCustomerRefundId);
            }
          } else if (msg && msg.type === 'PREPARATION_TIME_UPDATE') {
            if (this.activeView === 'secQueueProgress') this.fetchQueueProgress();
            if (this.activeView === 'secCustomerOrders') this.fetchOrders();
            if (this.activeView === 'secOwnerOrders') this.renderOrders();
          } else if (msg && msg.type === 'MEAL_PASS_REDEEMED') {
            if (this.currentUser && msg.customerId === this.currentUser.id) {
              this.showToast(`🎫 Meal pass redeemed! Remaining meals: ${msg.remainingMeals}`, 'success');
              if (this.activeView === 'secCustomerSubscriptions') this.renderCustomerSubscriptions();
              if (this.activeView === 'secCustomerMealPasses') this.renderCustomerMealPasses();
            }
            if (this.activeView === 'secOwnerSubscribers') this.renderOwnerSubscribersHub();
          }
        } catch (err) {
          console.error('[Real-Time WS] Message parse error:', err);
        }
      };

      this.ws.onclose = (event) => {
        if (this.wsPingInterval) clearInterval(this.wsPingInterval);
        console.warn('[Real-Time WS] Connection closed:', event.code, event.reason);

        if (this.isWsIntentionallyClosed || !this.currentUser) return;

        if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = setTimeout(() => {
          console.log(`[Real-Time WS] Reconnecting... (delay: ${this.wsReconnectDelay}ms)`);
          this.initWebSocket();
          this.wsReconnectDelay = Math.min(this.wsReconnectDelay * 2, 16000);
        }, this.wsReconnectDelay);
      };

      this.ws.onerror = (err) => {
        console.error('[Real-Time WS] Error:', err);
        try { this.ws.close(); } catch (e) {}
      };
    } catch (err) {
      console.error('[Real-Time WS] Initialization failed:', err);
    }
  }

  closeWebSocket() {
    this.isWsIntentionallyClosed = true;
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    if (this.wsPingInterval) clearInterval(this.wsPingInterval);
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
  }

  handleRealTimeNotificationReceived(notif) {
    if (!notif) return;
    const notifKey = this.getNotifKey(notif);

    if (this.knownNotificationIds.has(notifKey)) {
      return;
    }

    this.knownNotificationIds.add(notifKey);
    this.notifications.unshift(notif);

    if (this.isSoundEnabled()) {
      this.playNotificationChime();
    }

    this.showNotificationPopup(notif);
    this.renderNotificationsUI();
    if (this.activeView === 'secQueueProgress') {
      this.fetchQueueProgress();
    }
    if (this.activeView === 'secCustomerLoyalty' || notif.type === 'LOYALTY' || (notif.title && notif.title.includes('Loyalty'))) {
      this.loadLoyaltyRewardsPage();
    }
  }

  async initPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      this.updatePushToggleUI();
      return;
    }

    if (!this._pushFocusListenersBound) {
      this._pushFocusListenersBound = true;
      const syncOnFocus = () => {
        this.updatePushToggleUI();
        if (this.currentUser) {
          this.fetchNotifications(true);
          this.initWebSocket();
        }
      };
      window.addEventListener('focus', syncOnFocus);
      window.addEventListener('online', syncOnFocus);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') syncOnFocus();
      });

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'NOTIFICATION_CLICK') {
            const targetUrl = event.data.url || '';
            if (targetUrl.includes('#')) {
              const rawHash = targetUrl.substring(targetUrl.indexOf('#') + 1);
              const targetView = rawHash.split('?')[0];
              if (targetView && document.getElementById(targetView)) {
                this.switchView(targetView);
              }
            }
          }
        });
      }
    }

    try {
      const res = await fetch(`${API_BASE}/push/vapid-public-key`);
      const json = await res.json();
      if (!json.success || !json.publicKey) return;
      this.vapidPublicKey = json.publicKey;

      if (Notification.permission === 'granted') {
        await this.subscribeUserToPush();
      }
    } catch (err) {
      console.warn('[Push Engine] Init notice:', err.message);
    } finally {
      this.updatePushToggleUI();
    }
  }

  async updatePushToggleUI() {
    const btn = document.getElementById('btnTrayPushToggle');
    if (!btn) return;

    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      btn.style.display = 'none';
      return;
    }

    const perm = Notification.permission;

    if (perm === 'granted') {
      try {
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub && this.vapidPublicKey && this.currentUser && this.authToken) {
          await this.subscribeUserToPush();
          sub = await reg.pushManager.getSubscription();
        }
        if (sub) {
          btn.style.display = 'none';
          return;
        }
      } catch (e) {
        console.warn('[Push Engine] Check push sub notice:', e.message);
      }
    }

    btn.style.display = 'flex';
    if (perm === 'denied') {
      btn.title = 'Push Notifications are blocked in browser settings. Please enable them in site settings.';
      btn.innerHTML = `<i class="fa-solid fa-bell-slash" style="color: var(--accent-red, #FF5252);"></i> <span>Push Blocked</span>`;
    } else {
      btn.title = 'Enable Real-Time Push Notifications';
      btn.innerHTML = `<i class="fa-solid fa-tower-broadcast" style="color: var(--accent-gold);"></i> <span>Enable Push</span>`;
    }
  }

  async enablePushNotificationsPrompt() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      this.showToast('Push Notifications are not supported in this browser.', 'warning');
      this.updatePushToggleUI();
      return;
    }

    if (Notification.permission === 'denied') {
      this.showToast('Notification permission is blocked in browser settings. Please enable it in site settings.', 'warning');
      this.updatePushToggleUI();
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        await this.subscribeUserToPush();
        this.showToast('🔔 Real-Time Push Notifications Enabled!', 'success');
      } else if (permission === 'denied') {
        this.showToast('Notification permission was blocked in browser settings.', 'warning');
      } else {
        this.showToast('Notification permission was not granted.', 'info');
      }
    } catch (err) {
      console.error('[Push Engine] Permission error:', err);
    } finally {
      this.updatePushToggleUI();
    }
  }

  async subscribeUserToPush() {
    if (!this.vapidPublicKey || !this.currentUser || !this.authToken) return;

    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      const convertedKey = this.urlBase64ToUint8Array(this.vapidPublicKey);

      // Auto-heal VAPID key mismatch if server key regenerated on restart/redeploy
      if (sub && sub.options && sub.options.applicationServerKey) {
        try {
          const currentSubKey = new Uint8Array(sub.options.applicationServerKey);
          let keyMismatch = currentSubKey.length !== convertedKey.length;
          if (!keyMismatch) {
            for (let i = 0; i < convertedKey.length; i++) {
              if (currentSubKey[i] !== convertedKey[i]) {
                keyMismatch = true;
                break;
              }
            }
          }
          if (keyMismatch) {
            console.log('[Push Engine] VAPID key mismatch detected. Auto-refreshing push subscription...');
            try { await sub.unsubscribe(); } catch (e) { }
            sub = null;
          }
        } catch (subKeyErr) {
          console.warn('[Push Engine] Key check notice:', subKeyErr.message);
        }
      }

      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: convertedKey
        });
      }

      this.pushSubscription = sub;

      await this.fetchWithAuth(`${API_BASE}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub })
      });
      console.log('[Push Engine] Push subscription saved on server.');
    } catch (err) {
      console.warn('[Push Engine] Subscribe notice:', err.message);
    } finally {
      this.updatePushToggleUI();
    }
  }

  urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  bindGlobalQuickActionListeners() {
    if (this._quickActionListenersBound) return;
    this._quickActionListenersBound = true;

    const handleAction = (e) => {
      const btn = e.target.closest('[data-action], .co-row-btn, .btn-sm-status');
      if (!btn) return;

      const onclickAttr = btn.getAttribute('onclick') || '';
      const action = btn.getAttribute('data-action');
      const orderNum = btn.getAttribute('data-order-num') || btn.getAttribute('data-order-number');
      const orderId = btn.getAttribute('data-order-id');

      if (action === 'open-review' || onclickAttr.includes('openOrderReviewModal')) {
        e.preventDefault();
        e.stopPropagation();
        const num = orderNum || (onclickAttr.match(/openOrderReviewModal\('([^']+)'\)/) || [])[1];
        if (num) this.openOrderReviewModal(num);
      } else if (action === 'open-cancel' || onclickAttr.includes('openCancelOrderModal')) {
        e.preventDefault();
        e.stopPropagation();
        const id = orderId || (onclickAttr.match(/openCancelOrderModal\('([^']+)'\)/) || [])[1];
        if (id) this.openCancelOrderModal(id);
      } else if (action === 'open-edit' || onclickAttr.includes('openEditOrderModal')) {
        e.preventDefault();
        e.stopPropagation();
        const id = orderId || (onclickAttr.match(/openEditOrderModal\('([^']+)'\)/) || [])[1];
        if (id) this.openEditOrderModal(id);
      }
    };

    document.addEventListener('click', handleAction, true);
    document.addEventListener('touchstart', handleAction, { passive: false });
  }

  async loadUserData() {
    if (!this.currentUser) return;
    await this.fetchOrders();
    await this.fetchNotifications();
    await this.fetchSupportTickets(true);

    if (this.currentRole === 'CUSTOMER') {
      await this.fetchPayments();
      await this.fetchReferralStats();
      await this.fetchCart();
      await this.fetchFavorites();
      this.renderCustomerProfile();
    } else {
      // Always re-fetch settings for Owner on login/session-restore to ensure
      // the latest PostgreSQL values are loaded into the form
      await this.fetchSettings();
      await this.fetchStats();
      await this.fetchPayments();
      await this.fetchOwnerReviews(true);
      await this.fetchMenu(true);
    }
  }

  async loadCustomerUserData() {
    return this.loadUserData();
  }

  startPolling() {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    this.pollingTimer = setInterval(async () => {
      await this.fetchSettings(true);
      await this.fetchMenu(true);
      if (this.currentUser) {
        if (this.currentUser.role === 'CUSTOMER' && (this.currentUser.password_change_required || this.currentUser.passwordChangeRequired)) {
          return;
        }
        await this.fetchOrders(true);
        await this.fetchNotifications(true);
        await this.fetchSupportTickets(true);
        if (this.currentRole === 'OWNER') {
          this.fetchStats(true);
          this.fetchPayments(true);
        }
      }
    }, 2000);
  }

  // =========================================================================
  // API FETCHERS
  // =========================================================================

  async fetchSettings(silent = false) {
    try {
      const res = await fetch(`${API_BASE}/settings`, { cache: 'no-cache' });
      if (res.status === 304) {
        // Settings unchanged since last poll (ETag revalidation) — cached copy is valid.
        return;
      }
      const json = await res.json();
      if (json.success && json.success !== false) {
        const incoming = json.settings || json.data || {};
        // Only update if we got a non-empty result, never overwrite saved values with empty
        if (Object.keys(incoming).length > 0) {
          this.settings = incoming;
        }
        this.updateHeaderAndSettingsUI();
        // Auto-populate settings form whenever owner opens Business Settings
        if (this.activeView === 'secOwnerSettings' && !this.isSettingsFormPopulated) {
          this.populateSettingsForm();
        }
      }
    } catch (err) {
      if (!silent) console.error('Error fetching settings:', err);
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
    if (!this.currentUser) {
      this.orders = [];
      this.isLoadingOrders = false;
      return;
    }
    this.isLoadingOrders = true;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/orders`, { isBackgroundPoll: silent });
      const json = await res.json();
      if (json.success) {
        this.orders = Array.isArray(json.data) ? json.data : [];
      }
    } catch (err) {
      console.error('Error fetching orders:', err);
    } finally {
      this.isLoadingOrders = false;
      if (!silent || this.activeView.includes('Orders') || this.activeView === 'secOwnerDashboard') {
        this.renderOrders();
      }
      if (this.activeView === 'secQueueProgress') {
        this.fetchQueueProgress();
      }
    }
  }

  async fetchPayments(silent = false) {
    if (!this.currentUser) {
      this.payments = [];
      this.isLoadingPayments = false;
      return;
    }
    this.isLoadingPayments = true;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/payments`, { isBackgroundPoll: silent });
      const json = await res.json();
      if (json.success) {
        this.payments = Array.isArray(json.data) ? json.data : [];
      }
    } catch (err) {
      console.error('Error fetching payments:', err);
    } finally {
      this.isLoadingPayments = false;
      if (!silent || this.activeView === 'secOwnerPayments') {
        this.renderPayments();
      }
      if (!silent || this.activeView === 'secCustomerPayments') {
        this.renderCustomerPayments();
      }
    }
  }

  // =========================================================================
  // NOTIFICATION SOUND ENGINE & AUDIO SYNTHESIZER
  // =========================================================================

  initAudioContext() {
    try {
      if (!this.audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          this.audioCtx = new AudioContextClass({ latencyHint: 'interactive' });
        }
      }
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().then(() => {
          this._audioUnlocked = true;
        }).catch(() => {});
      }

      // Warm up / unlock AudioContext during a user gesture tick by playing a 0.001s silent audio frame
      if (this.audioCtx && !this._audioUnlocked && this.audioCtx.state === 'running') {
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        gain.gain.value = 0.00001; // virtually silent
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start(0);
        osc.stop(this.audioCtx.currentTime + 0.001);
        this._audioUnlocked = true;
      }
    } catch (e) {
      console.warn('AudioContext unlock notice:', e);
    }
  }

  getChimeWavDataUri() {
    if (this._cachedChimeWavUri) return this._cachedChimeWavUri;
    try {
      const sampleRate = 8000;
      const numSamples = Math.floor(sampleRate * 0.45);
      const buffer = new Uint8Array(44 + numSamples);

      const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) buffer[offset + i] = str.charCodeAt(i);
      };
      const writeUint32 = (offset, val) => {
        buffer[offset] = val & 0xff;
        buffer[offset + 1] = (val >> 8) & 0xff;
        buffer[offset + 2] = (val >> 16) & 0xff;
        buffer[offset + 3] = (val >> 24) & 0xff;
      };
      const writeUint16 = (offset, val) => {
        buffer[offset] = val & 0xff;
        buffer[offset + 1] = (val >> 8) & 0xff;
      };

      writeString(0, 'RIFF');
      writeUint32(4, 36 + numSamples);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      writeUint32(16, 16);
      writeUint16(20, 1); // PCM
      writeUint16(22, 1); // Mono
      writeUint32(24, sampleRate);
      writeUint32(28, sampleRate);
      writeUint16(32, 1);
      writeUint16(34, 8); // 8-bit
      writeString(36, 'data');
      writeUint32(40, numSamples);

      // Synthesize 3-note harmonic chime (C5 -> E5 -> G5)
      for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        let freq = 523.25;
        let env = 1.0;
        if (t < 0.15) {
          freq = 523.25;
          env = Math.max(0, 1 - (t / 0.15));
        } else if (t < 0.30) {
          freq = 659.25;
          env = Math.max(0, 1 - ((t - 0.15) / 0.15));
        } else {
          freq = 783.99;
          env = Math.max(0, 1 - ((t - 0.30) / 0.15));
        }
        const val = Math.sin(2 * Math.PI * freq * t) * env;
        buffer[44 + i] = Math.floor(128 + val * 120);
      }

      let binary = '';
      for (let i = 0; i < buffer.length; i++) binary += String.fromCharCode(buffer[i]);
      this._cachedChimeWavUri = 'data:audio/wav;base64,' + btoa(binary);
      return this._cachedChimeWavUri;
    } catch (e) {
      return '';
    }
  }

  playFallbackAudioChime() {
    try {
      const dataUri = this.getChimeWavDataUri();
      if (!dataUri) return;
      const audio = new Audio(dataUri);
      audio.volume = 0.8;
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch(() => {});
      }
    } catch (e) {
      console.warn('Fallback audio chime play notice:', e);
    }
  }

  playNotificationChime() {
    if (!this.isSoundEnabled()) return;

    const playWebAudioNotes = () => {
      try {
        if (!this.audioCtx) return false;
        const now = this.audioCtx.currentTime;

        // Harmonic 3-Note Chime: C5 (523.25 Hz) -> E5 (659.25 Hz) -> G5 (783.99 Hz)
        const notes = [
          { freq: 523.25, start: now, duration: 0.15 },
          { freq: 659.25, start: now + 0.08, duration: 0.2 },
          { freq: 783.99, start: now + 0.18, duration: 0.35 }
        ];

        notes.forEach(note => {
          const osc = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();

          osc.type = 'sine';
          osc.frequency.setValueAtTime(note.freq, note.start);

          gain.gain.setValueAtTime(0, note.start);
          gain.gain.linearRampToValueAtTime(1.0, note.start + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.001, note.start + note.duration);

          osc.connect(gain);
          gain.connect(this.audioCtx.destination);

          osc.start(note.start);
          osc.stop(note.start + note.duration);
        });
        return true;
      } catch (e) {
        console.warn('Audio chime play warning:', e);
        return false;
      }
    };

    try {
      this.initAudioContext();
      if (this.audioCtx) {
        if (this.audioCtx.state === 'running') {
          playWebAudioNotes();
          return;
        } else if (this.audioCtx.state === 'suspended') {
          this.audioCtx.resume().then(() => {
            if (this.audioCtx && this.audioCtx.state === 'running') {
              playWebAudioNotes();
            } else {
              this.playFallbackAudioChime();
            }
          }).catch(() => {
            this.playFallbackAudioChime();
          });
          return;
        }
      }
    } catch (e) {
      console.warn('Audio chime play warning:', e);
    }

    this.playFallbackAudioChime();
  }

  isSoundEnabled() {
    if (!this.currentUser) return true;
    return this.currentUser.sound_enabled !== false;
  }

  async toggleSoundPreference() {
    if (!this.currentUser) return;
    const current = this.isSoundEnabled();
    const newState = !current;
    this.currentUser.sound_enabled = newState;
    localStorage.setItem('tiffin_user', JSON.stringify(this.currentUser));

    this.updateSoundToggleUI();

    if (newState) {
      this.playNotificationChime();
    }

    try {
      await this.fetchWithAuth(`${API_BASE}/profile/sound-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sound_enabled: newState })
      });
      this.showToast(`Notification sound ${newState ? 'ON 🔔' : 'OFF 🔕'}`, 'info');
    } catch (err) {
      console.error('Error saving sound preference:', err);
    }
  }

  updateSoundToggleUI() {
    const isEnabled = this.isSoundEnabled();

    // 1. Notification Tray header button
    const trayBtn = document.getElementById('btnTraySoundToggle');
    if (trayBtn) {
      trayBtn.innerHTML = isEnabled
        ? '<i class="fa-solid fa-volume-high" style="color: var(--accent-gold);"></i> <span>Sound ON</span>'
        : '<i class="fa-solid fa-volume-xmark" style="color: var(--text-muted);"></i> <span>Sound OFF</span>';
    }

    // 1b. Dashboard Notification card sound toggle button
    const dashBtn = document.getElementById('btnDashSoundToggle');
    if (dashBtn) {
      dashBtn.innerHTML = isEnabled
        ? '<i class="fa-solid fa-volume-high" style="color: var(--accent-gold);"></i> <span>Sound ON</span>'
        : '<i class="fa-solid fa-volume-xmark" style="color: var(--text-muted);"></i> <span>Sound OFF</span>';
    }

    // 2. Customer Profile Sound switch
    const profSwitch = document.getElementById('profSoundSwitch');
    const profLabel = document.getElementById('profSoundLabel');
    if (profSwitch) profSwitch.classList.toggle('active', isEnabled);
    if (profLabel) profLabel.innerText = isEnabled ? '🟢 SOUND ON' : '🔴 SOUND OFF';

    // 3. Owner Settings Sound switch
    const setSwitch = document.getElementById('setSoundSwitch');
    const setLabel = document.getElementById('setSoundLabel');
    if (setSwitch) setSwitch.classList.toggle('active', isEnabled);
    if (setLabel) setLabel.innerText = isEnabled ? '🟢 SOUND ON' : '🔴 SOUND OFF';
  }

  getNotifKey(n, idx = 0) {
    if (!n) return `notif_idx_${idx}`;
    return String(n.id || (n._id || (n.order_number ? `notif_ord_${n.order_number}_${n.created_at || ''}` : `notif_msg_${n.message}_${n.created_at || idx}`)));
  }

  async fetchNotifications(silent = false) {
    if (!this.currentUser) {
      this.notifications = [];
      this.knownNotificationIds.clear();
      this.activePopupNotifIds.clear();
      this.isFirstNotificationFetch = true;
      return;
    }
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/notifications`, { isBackgroundPoll: silent });
      const json = await res.json();
      if (json.success) {
        const incoming = Array.isArray(json.data) ? json.data : [];

        // On first fetch / login load: populate known IDs without playing sound or showing popups
        if (this.isFirstNotificationFetch) {
          this.isFirstNotificationFetch = false;
          incoming.forEach((n, idx) => this.knownNotificationIds.add(this.getNotifKey(n, idx)));
          this.notifications = incoming;
          this.renderNotificationsUI();
          return;
        }

        // Detect genuinely NEW notifications not present in known set
        const brandNewNotifs = incoming.filter((n, idx) => !this.knownNotificationIds.has(this.getNotifKey(n, idx)));

        // Add all incoming IDs to known set
        incoming.forEach((n, idx) => this.knownNotificationIds.add(this.getNotifKey(n, idx)));
        this.notifications = incoming;

        if (brandNewNotifs.length > 0) {
          if (this.isSoundEnabled()) {
            this.playNotificationChime();
          }

          // Trigger visual popup toast for each brand new notification
          brandNewNotifs.forEach(n => {
            this.showNotificationPopup(n);
          });
        }

        this.renderNotificationsUI();
      }
    } catch (err) {
      console.error('Error fetching notifications:', err);
    }
  }

  showNotificationPopup(n) {
    if (!n) return;
    const notifKey = this.getNotifKey(n);
    if (this.activePopupNotifIds.has(notifKey)) return;
    this.activePopupNotifIds.add(notifKey);

    const stackContainer = document.getElementById('toastNotificationStackContainer');
    if (!stackContainer) return;

    // Limit maximum visible popups in stack to 3 (remove oldest if > 3)
    const activeToasts = stackContainer.querySelectorAll('.popup-notif-toast');
    if (activeToasts.length >= 3) {
      const oldest = activeToasts[0];
      if (oldest) oldest.remove();
    }

    const toastId = `popup_toast_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const type = (n.type || '').toUpperCase();
    const msg = n.message || n.text || 'New notification received!';
    const msgLower = msg.toLowerCase();

    let titleText = '🔔 New Notification';
    let iconClass = 'fa-bell';

    if (type === 'PAYMENT' || msgLower.includes('payment') || msgLower.includes('upi') || msgLower.includes('cash')) {
      titleText = '💳 Payment Received';
      iconClass = 'fa-wallet';
    } else if (msgLower.includes('status') || msgLower.includes('order')) {
      titleText = '📦 Order Status Changed';
      iconClass = 'fa-receipt';
    } else if (type === 'SUPPORT' || msgLower.includes('ticket') || msgLower.includes('support')) {
      titleText = '🎧 Support Update';
      iconClass = 'fa-headset';
    } else if (type === 'REVIEW' || msgLower.includes('rating') || msgLower.includes('star')) {
      titleText = '⭐ Review Update';
      iconClass = 'fa-star';
    }

    if (n.title) {
      titleText = `🔔 ${n.title}`;
    }

    const timeStr = n.created_at ? new Date(n.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : 'Just now';

    const toastEl = document.createElement('div');
    toastEl.id = toastId;
    toastEl.className = 'popup-notif-toast';
    toastEl.innerHTML = `
      <div class="popup-notif-icon-box">
        <i class="fa-solid ${iconClass}"></i>
      </div>
      <div class="popup-notif-content">
        <div class="popup-notif-header">
          <span class="popup-notif-title">${titleText}</span>
          <button type="button" class="popup-notif-close-btn" title="Dismiss" onclick="app.dismissNotificationPopup('${toastId}')">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <p class="popup-notif-msg">${msg}</p>
        <span class="popup-notif-time">${timeStr}</span>
      </div>
    `;

    stackContainer.appendChild(toastEl);

    // Auto dismiss after 5 seconds (5000 ms)
    setTimeout(() => {
      this.dismissNotificationPopup(toastId);
    }, 5000);
  }

  dismissNotificationPopup(toastId) {
    const el = document.getElementById(toastId);
    if (!el) return;
    el.classList.add('hiding');
    setTimeout(() => {
      if (el && el.parentNode) {
        el.parentNode.removeChild(el);
      }
    }, 300);
  }

  async fetchStats(silent = false) {
    if (this.currentRole !== 'OWNER') return;
    this.isLoadingStats = true;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/stats`, { isBackgroundPoll: silent });
      const json = await res.json();
      if (json.success && json.data) {
        const s = json.data;
        const elTotal = document.getElementById('statTodayOrders');
        const elActive = document.getElementById('statPendingOrders');
        const elCompleted = document.getElementById('statCompletedOrders');
        const elRejected = document.getElementById('statRejectedOrders');
        const elSales = document.getElementById('statTodaySales');

        if (elTotal) elTotal.innerText = s?.total_orders ?? 0;
        if (elActive) elActive.innerText = s?.active_orders ?? 0;
        if (elCompleted) elCompleted.innerText = s?.completed_orders ?? 0;
        if (elRejected) elRejected.innerText = s?.rejected_orders ?? 0;
        if (elSales) elSales.innerText = `₹${(Number(s?.total_sales ?? s?.total_revenue) || 0).toLocaleString('en-IN')}`;
      }
    } catch (err) {
      console.error('Error fetching stats:', err);
    } finally {
      this.isLoadingStats = false;
    }
  }

  // =========================================================================
  // AUTHENTICATION & ROLE MANAGEMENT
  // =========================================================================

  clearAuthFormInputs() {
    const loginIdent = document.getElementById('loginIdentifier');
    const loginMob = document.getElementById('loginMobile');
    const loginPass = document.getElementById('loginPassword');

    if (loginIdent) loginIdent.value = '';
    if (loginMob) loginMob.value = '';
    if (loginPass) loginPass.value = '';

    const regName = document.getElementById('regName');
    const regMobile = document.getElementById('regMobile');
    const regEmail = document.getElementById('regEmail');
    const regPassword = document.getElementById('regPassword');
    const regConfirmPassword = document.getElementById('regConfirmPassword');
    const regAddress = document.getElementById('regAddress');
    const regReferralCode = document.getElementById('regReferralCode');

    if (regName) regName.value = '';
    if (regMobile) regMobile.value = '';
    if (regEmail) regEmail.value = '';
    if (regPassword) regPassword.value = '';
    if (regConfirmPassword) regConfirmPassword.value = '';
    if (regAddress) regAddress.value = '';
    if (regReferralCode) regReferralCode.value = '';

    const forgotIdent = document.getElementById('forgotIdentifier');
    if (forgotIdent) forgotIdent.value = '';
  }

  openAuthModal(arg1 = 'LOGIN', arg2 = null) {
    let mode = 'LOGIN';
    let role = 'CUSTOMER';

    const validModes = ['LOGIN', 'REGISTER', 'FORGOT_PASSWORD'];
    const validRoles = ['CUSTOMER', 'OWNER', 'HOTEL_OWNER', 'ADMIN'];

    if (typeof arg1 === 'string') {
      const upper1 = arg1.toUpperCase();
      if (validModes.includes(upper1)) {
        mode = upper1;
        if (arg2 && typeof arg2 === 'string' && validRoles.includes(arg2.toUpperCase())) {
          role = arg2.toUpperCase();
        }
      } else if (validRoles.includes(upper1)) {
        role = upper1;
        if (arg2 && typeof arg2 === 'string' && validModes.includes(arg2.toUpperCase())) {
          mode = arg2.toUpperCase();
        }
      }
    }

    this.clearAuthFormInputs();
    this.authRole = role;
    this.authMode = mode;
    this.setAuthMode(mode);
    this.toggleAuthModal(true);
  }

  toggleAuthModal(open = true) {
    const backdrop = document.getElementById('authModalBackdrop');
    if (backdrop) {
      backdrop.classList.toggle('open', open);
      backdrop.classList.toggle('visible', open);
      backdrop.classList.toggle('active', open);
      backdrop.classList.toggle('hidden', !open);
      backdrop.style.display = open ? 'flex' : 'none';
      if (!open) {
        this.clearAuthFormInputs();
      }
    }
  }

  setAuthMode(mode) {
    this.authMode = mode;
    const card = document.getElementById('authModalCard');
    const btnLogin = document.getElementById('btnAuthModeLogin');
    const btnRegister = document.getElementById('btnAuthModeRegister');
    const modePills = document.getElementById('authModePills');

    if (card) {
      card.classList.toggle('mode-login', mode === 'LOGIN' || mode === 'FORGOT_PASSWORD');
      card.classList.toggle('mode-register', mode === 'REGISTER');
    }

    if (modePills) {
      modePills.classList.toggle('hidden', mode === 'FORGOT_PASSWORD');
    }

    if (btnLogin) btnLogin.classList.toggle('active', mode === 'LOGIN');
    if (btnRegister) btnRegister.classList.toggle('active', mode === 'REGISTER');

    const formLogin = document.getElementById('authLoginForm');
    const formRegister = document.getElementById('authRegisterForm');
    const formForgot = document.getElementById('authForgotPasswordForm');

    if (formLogin) formLogin.classList.toggle('hidden', mode !== 'LOGIN');
    if (formRegister) formRegister.classList.toggle('hidden', mode !== 'REGISTER');
    if (formForgot) formForgot.classList.toggle('hidden', mode !== 'FORGOT_PASSWORD');

    const regAlert = document.getElementById('regDuplicateAlert');
    if (regAlert && mode !== 'REGISTER') {
      regAlert.classList.add('hidden');
    }

    if (mode === 'FORGOT_PASSWORD') {
      this.resetForgotFormState();
    }
  }

  togglePasswordVisibility(inputId, iconId) {
    const input = document.getElementById(inputId);
    const icon = typeof iconId === 'string' ? document.getElementById(iconId) : iconId;
    if (!input || !icon) return;

    if (input.type === 'password') {
      input.type = 'text';
      icon.classList.remove('fa-eye');
      icon.classList.add('fa-eye-slash');
    } else {
      input.type = 'password';
      icon.classList.remove('fa-eye-slash');
      icon.classList.add('fa-eye');
    }
  }

  async handleLoginSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();

    const submitBtn = document.getElementById('btnLoginSubmit');
    if (submitBtn && submitBtn.disabled) {
      return;
    }

    const identifier = document.getElementById('loginIdentifier')?.value || document.getElementById('loginMobile')?.value || '';
    const password = document.getElementById('loginPassword')?.value || '';

    const originalBtnHTML = submitBtn ? submitBtn.innerHTML : '<span>Login to Account</span> <i class="fa-solid fa-arrow-right"></i>';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.classList.add('disabled');
      submitBtn.innerHTML = '<span>Logging in...</span> <i class="fa-solid fa-circle-notch fa-spin"></i>';
    }

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password })
      });
      const json = await res.json();

      if (json.success) {
        this.currentUser = json.user;
        this.authToken = json.token;
        this.currentRole = json.user.role;

        this.clearAuthFormInputs();

        localStorage.setItem('tiffin_token', json.token);
        localStorage.setItem('tiffin_user', JSON.stringify(json.user));

        if (this.currentRole === 'CUSTOMER') {
          this.lastCustomerActivityTimestamp = Date.now();
          localStorage.setItem('tiffin_customer_last_activity', Date.now().toString());
        }

        const welcomeMsg = this.currentRole === 'OWNER'
          ? 'Welcome back, Owner! 👋'
          : '✅ Login successful';

        this.showToast(welcomeMsg, 'success');
        this.toggleAuthModal(false);
        this.updateUserAuthBadgeUI();

        this.activeView = this.currentRole === 'OWNER' ? 'secOwnerDashboard' : 'secCustomerHome';
        await this.loadCustomerUserData();
        this.renderNavigation();
        this.renderCurrentView();

        this.initWebSocket();
        this.initPushNotifications();

        if (this.currentRole === 'CUSTOMER' && (this.currentUser.password_change_required || json.passwordChangeRequired)) {
          this.checkPasswordChangeRequired();
        }
      } else {
        if (identifier.trim() === '9392874900' || identifier.trim().toLowerCase() === 'owner@annapurna.com') {
          this.showToast(json.message || 'Login failed', 'error');
        } else {
          if (json.message === 'Your account has been blocked by the owner. Please contact support.') {
            this.showToast(json.message, 'error');
          } else {
            this.showToast('❌ Invalid username and password', 'error');
          }
        }
      }
    } catch (err) {
      console.error('Error logging in:', err);
      this.showToast('Server communication error.', 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.classList.remove('disabled');
        submitBtn.innerHTML = originalBtnHTML;
      }
    }
  }

  async handleRegisterSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();

    const submitBtn = document.getElementById('btnRegisterSubmit');
    if (submitBtn && submitBtn.disabled) {
      return; // Prevent accidental duplicate submissions
    }

    const regAlert = document.getElementById('regDuplicateAlert');
    const regAlertText = document.getElementById('regAlertText');
    if (regAlert) regAlert.classList.add('hidden');

    const nameInput = document.getElementById('regName');
    const mobileInput = document.getElementById('regMobile');
    const emailInput = document.getElementById('regEmail');
    const passwordInput = document.getElementById('regPassword');
    const confirmPasswordInput = document.getElementById('regConfirmPassword');
    const addressInput = document.getElementById('regAddress');
    const refCodeInput = document.getElementById('regReferralCode');

    const name = nameInput?.value.trim() || '';
    const rawMobile = mobileInput?.value.trim() || '';
    const email = emailInput?.value.trim() || '';
    const password = passwordInput?.value.trim() || '';
    const confirmPassword = confirmPasswordInput?.value.trim() || '';
    const address = addressInput?.value.trim() || '';
    const referral_code = refCodeInput?.value.trim() || '';

    // 1. Full Name check
    if (!name) {
      this.showToast('Please enter your name.', 'error');
      if (nameInput) nameInput.focus();
      return;
    }

    // 2. Mobile Number check — exactly 10 digits, numbers only
    if (!/^\d{10}$/.test(rawMobile)) {
      this.showToast('Please enter a valid 10-digit mobile number.', 'error');
      if (mobileInput) mobileInput.focus();
      return;
    }

    // 3. Email Address check — valid format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      this.showToast('Please enter a valid email address.', 'error');
      if (emailInput) emailInput.focus();
      return;
    }

    // 4. Password checks
    if (!password) {
      this.showToast('Please enter a password.', 'error');
      if (passwordInput) passwordInput.focus();
      return;
    }

    if (password.length < 4) {
      this.showToast('Password must be at least 4 characters long.', 'error');
      if (passwordInput) passwordInput.focus();
      return;
    }

    // 5. Confirm Password checks
    if (!confirmPassword) {
      this.showToast('Please confirm your password.', 'error');
      if (confirmPasswordInput) confirmPasswordInput.focus();
      return;
    }

    if (password !== confirmPassword) {
      this.showToast('Passwords do not match.', 'error');
      if (confirmPasswordInput) confirmPasswordInput.focus();
      return;
    }

    // Step 2: Immediate Visual Feedback & Single Submission Guard
    const originalBtnHTML = submitBtn ? submitBtn.innerHTML : '<span>Create New Account</span> <i class="fa-solid fa-user-plus"></i>';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.classList.add('disabled');
      submitBtn.innerHTML = '<span>Creating Account...</span> <i class="fa-solid fa-circle-notch fa-spin"></i>';
    }

    const payload = {
      name,
      mobile: rawMobile,
      email: email.toLowerCase(),
      password,
      confirm_password: confirmPassword,
      confirmPassword,
      address,
      referral_code
    };

    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();

      if (json.success) {
        if (regAlert) regAlert.classList.add('hidden');
        this.currentUser = json.user;
        this.authToken = json.token;
        this.currentRole = json.user.role;

        this.clearAuthFormInputs();

        localStorage.setItem('tiffin_token', json.token);
        localStorage.setItem('tiffin_user', JSON.stringify(json.user));

        if (this.currentRole === 'CUSTOMER') {
          this.lastCustomerActivityTimestamp = Date.now();
          localStorage.setItem('tiffin_customer_last_activity', Date.now().toString());
        }

        // Clear previous state for new customer
        this.cart = [];
        this.orders = [];
        this.notifications = [];
        this.supportTickets = [];
        this.favorites = [];
        this.referralStats = null;

        const welcomeMsg = json.message || '✅ Account created successfully. You can login now.';

        this.showToast(welcomeMsg, 'success');
        this.toggleAuthModal(false);
        this.updateUserAuthBadgeUI();

        this.activeView = this.currentRole === 'OWNER' ? 'secOwnerDashboard' : 'secCustomerHome';
        await this.loadCustomerUserData();
        this.renderNavigation();
        this.renderCurrentView();
      } else {
        const errorMsg = json.message || 'Unable to create account. Please try again.';
        this.showToast(errorMsg, 'error');

        // Display duplicate alert box with [ Login Now ] button if duplicate account
        if (json.isDuplicate || errorMsg.toLowerCase().includes('already registered')) {
          if (regAlert && regAlertText) {
            regAlertText.textContent = errorMsg;
            regAlert.classList.remove('hidden');
          }
        }

        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.classList.remove('disabled');
          submitBtn.innerHTML = originalBtnHTML;
        }
      }
    } catch (err) {
      console.error('Error registering:', err);
      this.showToast('Unable to create account. Please try again.', 'error');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.classList.remove('disabled');
        submitBtn.innerHTML = originalBtnHTML;
      }
    }
  }

  async loadUserData() {
    if (!this.currentUser) return;
    this.updateSoundToggleUI();
    await this.fetchOrders();
    await this.fetchNotifications();
    await this.fetchSupportTickets(true);

    if (this.currentRole === 'CUSTOMER') {
      await this.fetchPayments();
      await this.fetchReferralStats();
      await this.fetchCart();
      await this.fetchFavorites();
      this.renderCustomerProfile();
    } else {
      await this.fetchSettings();
      await this.fetchStats();
      await this.fetchPayments();
      await this.fetchOwnerReviews(true);
      await this.fetchMenu(true);
    }
  }

  async loadCustomerUserData() {
    return this.loadUserData();
  }

  startPolling() {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    this.pollingTimer = setInterval(async () => {
      await this.fetchSettings(true);
      await this.fetchMenu(true);
      if (this.currentUser) {
        await this.fetchOrders(true);
        await this.fetchNotifications(true);
        await this.fetchSupportTickets(true);
        if (this.currentRole === 'OWNER') {
          this.fetchStats(true);
          this.fetchPayments(true);
        }
      }
    }, 2000);
  }

  normalizePhone(phone) {
    if (!phone) return '';
    let digits = phone.toString().replace(/[^0-9]/g, '');
    if (digits.length === 10) return digits;
    if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
    if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
    if (digits.length > 10) return digits.slice(-10);
    return digits;
  }

  resetForgotFormState() {
    const stepPhone = document.getElementById('stepForgotPhone');
    const stepOtp = document.getElementById('stepForgotOtp');
    const stepNewPass = document.getElementById('stepForgotNewPassword');
    const inputId = document.getElementById('forgotIdentifier');
    const inputOtp = document.getElementById('forgotOtp');
    const inputNewPass = document.getElementById('forgotNewPassword');
    const inputConfirmPass = document.getElementById('forgotConfirmPassword');

    if (stepPhone) stepPhone.classList.remove('hidden');
    if (stepOtp) stepOtp.classList.add('hidden');
    if (stepNewPass) stepNewPass.classList.add('hidden');

    if (inputId) {
      inputId.readOnly = false;
      inputId.value = '';
    }
    if (inputOtp) inputOtp.value = '';
    if (inputNewPass) inputNewPass.value = '';
    if (inputConfirmPass) inputConfirmPass.value = '';

    if (this.resendOtpTimer) {
      clearInterval(this.resendOtpTimer);
      this.resendOtpTimer = null;
    }
  }

  resetForgotFormState() {
    const stepPhone = document.getElementById('stepForgotPhone');
    const stepOtp = document.getElementById('stepForgotOtp');
    const stepNewPass = document.getElementById('stepForgotNewPassword');
    const stepMethods = document.getElementById('stepForgotMethods');
    const inputId = document.getElementById('forgotIdentifier');
    const inputOtp = document.getElementById('forgotOtp');
    const inputNewPass = document.getElementById('forgotNewPassword');
    const inputConfirmPass = document.getElementById('forgotConfirmPassword');

    if (stepPhone) stepPhone.classList.remove('hidden');
    if (stepOtp) stepOtp.classList.add('hidden');
    if (stepNewPass) stepNewPass.classList.add('hidden');
    if (stepMethods) stepMethods.classList.add('hidden');

    if (inputId) {
      inputId.readOnly = false;
      inputId.value = '';
    }
    if (inputOtp) inputOtp.value = '';
    if (inputNewPass) inputNewPass.value = '';
    if (inputConfirmPass) inputConfirmPass.value = '';

    if (this.resendOtpTimer) {
      clearInterval(this.resendOtpTimer);
      this.resendOtpTimer = null;
    }
  }

  async requestForgotOtp(isResend = false) {
    const rawVal = document.getElementById('forgotIdentifier')?.value || '';
    const mobile = rawVal.replace(/[^0-9]/g, '').trim();

    if (!mobile || mobile.length !== 10) {
      this.showToast('Please enter a valid 10-digit mobile number.', 'warning');
      return;
    }

    let selectedMethod = 'SMS';
    const checkedRadio = document.querySelector('input[name="forgotOtpDeliveryMethod"]:checked') || document.querySelector('input[name="forgotRecoveryMethod"]:checked');
    if (checkedRadio) {
      selectedMethod = checkedRadio.value;
    }

    const btn = isResend ? document.getElementById('btnForgotResendOtp') : document.getElementById('btnForgotSendOtp');
    const origHTML = btn ? btn.innerHTML : '<span>Send OTP</span> <i class="fa-solid fa-paper-plane"></i>';

    let json = null;
    try {
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = isResend ? '<i class="fa-solid fa-spinner fa-spin"></i> Resending...' : '<i class="fa-solid fa-spinner fa-spin"></i> Sending OTP...';
      }

      const res = await fetch(`${API_BASE}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile, method: selectedMethod })
      });
      json = await res.json();

      if (json.success) {
        this.showToast(json.message || 'OTP sent successfully.', 'success');

        const stepPhone = document.getElementById('stepForgotPhone');
        const stepOtp = document.getElementById('stepForgotOtp');
        const inputId = document.getElementById('forgotIdentifier');
        const mobileDisp = document.getElementById('forgotMobileSentDisp');

        if (stepPhone) stepPhone.classList.add('hidden');
        if (stepOtp) stepOtp.classList.remove('hidden');
        if (inputId) inputId.readOnly = true;
        if (mobileDisp) mobileDisp.innerText = json.data?.maskedMobile || mobile;

        this.startResendOtpTimer();

        const otpInput = document.getElementById('forgotOtp');
        if (otpInput) otpInput.focus();
      } else {
        this.showToast(json.message || 'Unable to send OTP. Please try again.', 'error');
      }
    } catch (err) {
      console.error('Error requesting OTP:', err);
      this.showToast('Unable to send OTP. Server communication error.', 'error');
    } finally {
      if (btn && (!isResend || !json || !json.success)) {
        btn.disabled = false;
        btn.innerHTML = origHTML;
      }
    }
  }

  startResendOtpTimer() {
    if (this.resendOtpTimer) clearInterval(this.resendOtpTimer);
    let seconds = 30;

    const btnResend = document.getElementById('btnForgotResendOtp');
    const timerDisp = document.getElementById('forgotResendTimer');

    if (btnResend) btnResend.disabled = true;
    if (timerDisp) timerDisp.innerText = seconds;

    this.resendOtpTimer = setInterval(() => {
      seconds--;
      if (timerDisp) timerDisp.innerText = seconds;

      if (seconds <= 0) {
        clearInterval(this.resendOtpTimer);
        this.resendOtpTimer = null;
        if (btnResend) {
          btnResend.disabled = false;
          btnResend.innerHTML = 'Resend OTP';
        }
      }
    }, 1000);
  }

  async verifyForgotOtp() {
    const rawVal = document.getElementById('forgotIdentifier')?.value || '';
    const mobile = rawVal.replace(/[^0-9]/g, '').trim();
    const otp = document.getElementById('forgotOtp')?.value?.trim() || '';

    if (!mobile || mobile.length !== 10) {
      this.showToast('Please enter a valid 10-digit mobile number.', 'warning');
      return;
    }

    if (!otp || otp.length !== 6) {
      this.showToast('Please enter the 6-digit verification OTP code.', 'warning');
      return;
    }

    const btn = document.getElementById('btnForgotVerifyOtp');
    const origHTML = btn ? btn.innerHTML : '<span>Verify OTP</span> <i class="fa-solid fa-shield-check"></i>';

    try {
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';
      }

      const res = await fetch(`${API_BASE}/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile, otp })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || 'OTP verified successfully.', 'success');
        const stepOtp = document.getElementById('stepForgotOtp');
        const stepNewPass = document.getElementById('stepForgotNewPassword');

        if (stepOtp) stepOtp.classList.add('hidden');
        if (stepNewPass) stepNewPass.classList.remove('hidden');

        const newPassInput = document.getElementById('forgotNewPassword');
        if (newPassInput) newPassInput.focus();
      } else {
        this.showToast(json.message || 'OTP is incorrect. Please check and try again.', 'error');
      }
    } catch (err) {
      console.error('Error verifying OTP:', err);
      this.showToast('Failed to verify OTP. Please try again.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHTML;
      }
    }
  }

  async handleForgotPasswordSubmit(e) {
    e.preventDefault();

    const rawVal = document.getElementById('forgotIdentifier')?.value || '';
    const mobile = rawVal.replace(/[^0-9]/g, '').trim();
    const otp = document.getElementById('forgotOtp')?.value?.trim() || '';
    const new_password = document.getElementById('forgotNewPassword')?.value?.trim() || '';
    const confirm_password = document.getElementById('forgotConfirmPassword')?.value?.trim() || '';

    if (!mobile || mobile.length !== 10) {
      this.showToast('Please enter a valid 10-digit mobile number.', 'warning');
      return;
    }

    if (!new_password) {
      this.showToast('Please enter your new password.', 'warning');
      return;
    }

    if (confirm_password && new_password !== confirm_password) {
      this.showToast('New Password and Confirm New Password do not match.', 'error');
      return;
    }

    if (new_password.length < 4) {
      this.showToast('Password must be at least 4 characters long.', 'warning');
      return;
    }

    const btnSubmit = document.getElementById('btnForgotSubmit');
    const origHTML = btnSubmit ? btnSubmit.innerHTML : 'Change Password';

    try {
      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Updating Password...';
      }

      const res = await fetch(`${API_BASE}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile, otp, new_password })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || 'Password reset successfully. Please login with your new password.', 'success');
        this.resetForgotFormState();
        this.setAuthMode('LOGIN');

        const loginInput = document.getElementById('loginIdentifier');
        if (loginInput) loginInput.value = mobile;
      } else {
        this.showToast(json.message || 'Failed to reset password. Please try again.', 'error');
      }
    } catch (err) {
      console.error('Error resetting password:', err);
      this.showToast('Server error resetting password. Please try again.', 'error');
    } finally {
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = origHTML;
      }
    }
  }

  logout() {
    this.clearAuthFormInputs();
    if (this.closeFoodMemberQrScannerModal) {
      this.closeFoodMemberQrScannerModal();
    }
    if (this.authToken) {
      fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.authToken}` }
      }).catch(() => {});
    }

    this.currentUser = null;
    this.authToken = null;
    this.currentRole = 'CUSTOMER';
    this.activeView = 'secCustomerHome';
    this.cart = [];
    this.favorites = [];
    this.orders = [];
    this.payments = [];
    this.notifications = [];
    this.supportTickets = [];
    this.referralStats = null;
    this.customerProfile = null;
    this.isLoadingOrders = false;
    this.isLoadingPayments = false;
    this.isLoadingStats = false;
    this.knownNotificationIds.clear();
    this.activePopupNotifIds.clear();
    this.isFirstNotificationFetch = true;
    this.closeWebSocket();

    this.hideInactivityWarningModal();
    localStorage.removeItem('tiffin_token');
    localStorage.removeItem('tiffin_user');
    localStorage.removeItem('tiffin_customer_last_activity');
    sessionStorage.clear();

    this.showToast('Logged out successfully.', 'info');

    this.updateUserAuthBadgeUI();
    this.renderNavigation();
    this.renderCurrentView();
    this.updateCartUI();
  }

  getFormattedCustomerName() {
    if (!this.currentUser) return '';
    const rawName = this.currentUser.name || this.currentUser.full_name || this.currentUser.username || '';
    if (!rawName) return '';
    const cleaned = String(rawName).trim();
    if (!cleaned || cleaned.toLowerCase() === 'undefined' || cleaned.toLowerCase() === 'null') return '';
    return cleaned;
  }

  updateUserAuthBadgeUI() {
    const guestAuth = document.getElementById('guestAuthWrapper');
    const btnLogin = document.getElementById('btnLoginHeader');
    const btnRegister = document.getElementById('btnRegisterHeader');
    const btnLogout = document.getElementById('btnLogoutHeader');
    const btnCart = document.getElementById('btnCart');
    const btnNotif = document.getElementById('btnNotifications');
    const btnProfile = document.getElementById('btnHeaderProfile');
    const lblProfile = document.getElementById('headerProfileLabel');
    const bannerGreeting = document.getElementById('bannerGreeting');
    const ownerGreetingText = document.getElementById('ownerGreetingText');

    if (this.currentUser) {
      if (guestAuth) guestAuth.classList.add('hidden');
      if (btnLogin) btnLogin.classList.add('hidden');
      if (btnRegister) btnRegister.classList.add('hidden');

      // 1. Bell Icon (Visible ONLY when logged in)
      if (btnNotif) btnNotif.classList.remove('hidden');

      // 2. Cart Icon (Visible ONLY for customer)
      if (btnCart) {
        if (this.currentUser.role === 'CUSTOMER') {
          btnCart.classList.remove('hidden');
        } else {
          btnCart.classList.add('hidden');
        }
      }

      // 3. Profile Card Badge with Full Name (Visible ONLY when logged in)
      if (btnProfile) {
        btnProfile.classList.remove('hidden');
        const elFullName = document.getElementById('headerProfileFullName');
        const elInitial = document.getElementById('headerProfileInitial');
        const elImg = document.getElementById('headerProfileImg');
        const elRoleTag = document.getElementById('headerProfileRoleTag');
        const custName = this.getFormattedCustomerName();
        const displayName = this.currentUser.role === 'OWNER' ? 'Owner' : (custName || 'Customer');

        if (elFullName) elFullName.innerText = displayName;
        if (elRoleTag) {
          elRoleTag.innerText = this.currentUser.role === 'OWNER' ? '👑 Hotel Owner' : '⭐ Foodie Member';
        }

        const ringEl = document.getElementById('headerProfileAvatarRing');
        if (this.currentUser.profile_photo) {
          if (elImg) {
            elImg.src = this.currentUser.profile_photo;
            elImg.classList.remove('hidden');
          }
          if (elInitial) elInitial.classList.add('hidden');
          if (ringEl) ringEl.classList.add('has-photo');
        } else {
          if (elImg) {
            elImg.src = '';
            elImg.classList.add('hidden');
          }
          if (elInitial) {
            elInitial.innerText = displayName.charAt(0).toUpperCase();
            elInitial.classList.remove('hidden');
          }
          if (ringEl) ringEl.classList.remove('has-photo');
        }
      }

      // 4. Logout Button (Visible ONLY when logged in)
      if (btnLogout) btnLogout.classList.remove('hidden');

      // 5. Role-Based Welcome Greetings
      if (this.currentRole === 'OWNER') {
        if (ownerGreetingText) {
          ownerGreetingText.innerText = 'Welcome back, Owner! 👋';
        }
        if (bannerGreeting) {
          bannerGreeting.innerText = 'Welcome back, Owner! 👋';
        }
      } else {
        const custName = this.getFormattedCustomerName();
        const greetingStr = custName ? `Welcome back, ${custName} 👋` : `Welcome back 👋`;
        if (bannerGreeting) {
          bannerGreeting.innerText = greetingStr;
        }
      }
    } else {
      if (guestAuth) guestAuth.classList.remove('hidden');
      if (btnLogin) btnLogin.classList.remove('hidden');
      if (btnRegister) btnRegister.classList.remove('hidden');

      // HIDE all authenticated buttons for Guests
      if (btnNotif) btnNotif.classList.add('hidden');
      if (btnCart) btnCart.classList.add('hidden');
      if (btnProfile) btnProfile.classList.add('hidden');
      if (btnLogout) btnLogout.classList.add('hidden');

      if (bannerGreeting) {
        bannerGreeting.innerText = `Welcome to Sri Lakshmi Annapurna Tiffin Center! 🍲`;
      }
    }
  }

  // =========================================================================
  // NOTIFICATIONS TRAY & CLEAR ALL ACTIONS
  // =========================================================================

  renderNotificationsUI() {
    const badge = document.getElementById('notifBadgeCount');
    const notifs = this.notifications || [];
    const unreadCount = notifs.filter(n => !n.is_read && !n.read).length;

    if (badge) {
      badge.innerText = unreadCount;
      badge.classList.toggle('hidden', unreadCount === 0);
    }

    this.renderOwnerDashboardNotifications();
    this.renderNotificationsTray();
  }

  renderOwnerDashboardNotifications() {
    const container = document.getElementById('ownerDashNotifFeedList');
    const badge = document.getElementById('ownerDashUnreadBadge');
    if (!container) return;

    if (this.currentRole !== 'OWNER') return;

    const notifs = (this.notifications || []).filter(n => n.target_role === 'OWNER' || (!n.target_role && !n.customer_id));
    const unreadCount = notifs.filter(n => !n.is_read && !n.read).length;

    if (badge) {
      badge.innerText = `${unreadCount} Unread`;
      badge.style.background = unreadCount > 0 ? 'var(--primary)' : 'rgba(255,255,255,0.1)';
    }

    if (!notifs.length) {
      container.innerHTML = `
        <p style="text-align: center; color: var(--text-muted); font-size: 0.82rem; padding: 1rem 0;">
          <i class="fa-regular fa-bell-slash"></i> No notifications yet. Live customer orders & payments will appear here.
        </p>
      `;
      return;
    }

    const recent = notifs.slice(0, 5);
    container.innerHTML = recent.map((n, idx) => {
      const isRead = Boolean(n.is_read || n.read);
      const timeStr = n.created_at ? new Date(n.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : 'Just now';
      const notifId = n.id || idx;

      return `
        <div class="notif-item-card ${isRead ? 'is-read' : 'is-unread'}" style="background: ${isRead ? 'rgba(255,255,255,0.02)' : 'rgba(234, 162, 33, 0.1)'}; border: 1px solid ${isRead ? 'var(--border-color)' : 'var(--accent-gold)'};" onclick="app.handleNotifClick('${notifId}')">
          <div class="notif-icon-circle info">
            <i class="fa-solid ${this.getNotifIcon(n)}"></i>
          </div>
          <div class="notif-content-body">
            <div class="notif-header-line">
              <strong class="notif-title-text">${n.message || ''}</strong>
              <span class="notif-time-text">${timeStr} ${n.order_number ? `• Order #${n.order_number}` : ''}</span>
            </div>
            <div style="margin-top: 6px; display: flex; align-items: center; justify-content: flex-end;">
              <button class="btn-secondary-outline" onclick="event.stopPropagation(); app.handleNotifClick('${notifId}')" style="padding: 3px 10px; font-size: 0.75rem; white-space: nowrap;">
                Open <i class="fa-solid fa-arrow-right"></i>
              </button>
            </div>
          </div>
          <button type="button" class="btn-del-single-notif" onclick="event.stopPropagation(); app.deleteSingleNotification('${notifId}')" title="Delete notification">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      `;
    }).join('');
  }

  getNotifIcon(n) {
    const type = n ? (n.type || '').toUpperCase() : '';
    const msg = n && n.message ? n.message.toLowerCase() : '';
    if (type === 'PAYMENT' || msg.includes('payment') || msg.includes('upi') || msg.includes('cash')) return 'fa-wallet';
    if (type === 'SUPPORT' || msg.includes('ticket') || msg.includes('support')) return 'fa-headset';
    if (type === 'REVIEW' || msg.includes('rating') || msg.includes('star')) return 'fa-star';
    if (msg.includes('cancelled')) return 'fa-triangle-exclamation';
    return 'fa-receipt';
  }

  toggleNotificationsTray(open = null) {
    const backdrop = document.getElementById('notifBackdrop');
    if (!backdrop) return;
    const currentState = backdrop.classList.contains('open');
    const newState = open !== null ? open : !currentState;
    backdrop.classList.toggle('open', newState);

    if (newState) {
      this.renderNotificationsTray();
    }
  }

  renderNotificationsTray() {
    this.updatePushToggleUI();
    const container = document.getElementById('notifListContainer');
    const badge = document.getElementById('notifBadgeCount');
    const subText = document.getElementById('notifSubCountText');
    if (!container) return;

    const notifs = this.notifications || [];
    const unreadCount = notifs.filter(n => !n.is_read && !n.read).length;

    if (badge) {
      badge.innerText = unreadCount;
      badge.classList.toggle('hidden', unreadCount === 0);
    }

    if (subText) {
      subText.innerText = `${unreadCount} unread alert${unreadCount === 1 ? '' : 's'}`;
    }

    if (!notifs.length) {
      container.innerHTML = `
        <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
          <div style="width: 60px; height: 60px; border-radius: 50%; background: rgba(255,255,255,0.05); color: var(--text-muted); display: flex; align-items: center; justify-content: center; font-size: 1.8rem; margin: 0 auto 1rem auto; border: 1.5px dashed var(--border-color);">
            <i class="fa-regular fa-bell-slash"></i>
          </div>
          <h4 style="color: #FFF; font-size: 1rem; margin-bottom: 0.35rem;">No Notifications</h4>
          <p style="font-size: 0.8rem; max-width: 260px; margin: 0 auto;">You're all caught up! Order status updates & promotional alerts will appear here.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = notifs.map((n, idx) => {
      const isRead = Boolean(n.is_read || n.read);
      const notifId = n.id || idx;
      const title = n.title || (n.order_number ? `Order #${n.order_number}` : 'Notification');
      const timeStr = n.created_at ? new Date(n.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : (n.time || 'Just now');

      return `
        <div class="notif-item-card ${isRead ? 'is-read' : 'is-unread'}" onclick="app.handleNotifClick('${notifId}')">
          <div class="notif-icon-circle info">
            <i class="fa-solid ${n.icon || 'fa-bell'}"></i>
          </div>
          <div class="notif-content-body">
            <div class="notif-header-line">
              <strong class="notif-title-text">${title}</strong>
              <span class="notif-time-text">${timeStr}</span>
            </div>
            <p class="notif-msg-text">${n.message || n.text || ''}</p>
          </div>
          <button type="button" class="btn-del-single-notif" onclick="event.stopPropagation(); app.deleteSingleNotification('${notifId}')" title="Delete alert">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      `;
    }).join('');
  }

  async markNotificationsRead() {
    (this.notifications || []).forEach(n => { n.is_read = true; n.read = true; });
    this.renderNotificationsUI();
    this.showToast('Marked all notifications as read', 'success');

    try {
      await this.fetchWithAuth(`${API_BASE}/notifications/read-all`, { method: 'PATCH' });
    } catch (err) {
      console.error('Error marking notifications read:', err);
    }
  }

  async clearAllNotifications() {
    if (!this.notifications || !this.notifications.length) {
      this.showToast('No notifications to clear', 'info');
      return;
    }
    this.notifications = [];
    this.renderNotificationsUI();
    this.showToast('Cleared all notifications', 'info');

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/notifications/clear-all`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.success) {
        console.error('Error clearing all notifications:', json.message);
        await this.fetchNotifications(true);
      }
    } catch (err) {
      console.error('Error clearing all notifications:', err);
      await this.fetchNotifications(true);
    }
  }

  async deleteSingleNotification(idOrIdx) {
    const targetNotif = (this.notifications || []).find((n, idx) => n.id === idOrIdx || String(idx) === String(idOrIdx));
    const targetId = targetNotif ? targetNotif.id : idOrIdx;

    this.notifications = (this.notifications || []).filter((n, idx) => n.id !== targetId && String(idx) !== String(idOrIdx));
    this.renderNotificationsUI();

    if (targetId) {
      try {
        const res = await this.fetchWithAuth(`${API_BASE}/notifications/${encodeURIComponent(targetId)}`, { method: 'DELETE' });
        const json = await res.json();
        if (!json.success) {
          console.error('Error deleting single notification:', json.message);
          await this.fetchNotifications(true);
        }
      } catch (err) {
        console.error('Error deleting single notification:', err);
        await this.fetchNotifications(true);
      }
    }
  }

  handleNotifClick(idOrIdx) {
    const notif = (this.notifications || []).find((n, idx) => n.id === idOrIdx || String(idx) === String(idOrIdx));
    if (notif) {
      notif.is_read = true;
      notif.read = true;
      this.renderNotificationsUI();

      if (notif.id) {
        this.fetchWithAuth(`${API_BASE}/notifications/${encodeURIComponent(notif.id)}/read`, { method: 'PATCH' }).catch(err => {
          console.error('Error marking notification read:', err);
        });
      }
    }
    this.toggleNotificationsTray(false);

    const isOwner = this.currentRole === 'OWNER';
    const notifType = notif ? (notif.type || '').toUpperCase() : '';
    const msg = notif && notif.message ? notif.message.toLowerCase() : '';

    if (isOwner) {
      if (notifType === 'PAYMENT' || msg.includes('payment') || msg.includes('upi') || msg.includes('cash')) {
        this.switchView('secOwnerPayments');
      } else if (notifType === 'SUPPORT' || msg.includes('ticket') || msg.includes('support')) {
        this.switchView('secOwnerSupport');
      } else if (notifType === 'REVIEW' || msg.includes('rating') || msg.includes('review') || msg.includes('star')) {
        this.switchView('secOwnerReviews');
      } else {
        this.switchView('secOwnerOrders');
      }
    } else {
      if (notifType === 'PAYMENT' || msg.includes('payment') || msg.includes('paid')) {
        this.switchView('secCustomerPayments');
      } else if (notifType === 'SUPPORT' || msg.includes('ticket') || msg.includes('reply')) {
        this.switchView('secCustomerSupport');
      } else if (notifType === 'REFERRAL' || msg.includes('referral') || msg.includes('reward')) {
        this.switchView('secCustomerReferral');
      } else {
        this.switchView('secCustomerOrders');
      }
    }
  }

  renderNavigation() {
    const desktopSidebar = document.querySelector('.desktop-sidebar');
    const mobileNav = document.getElementById('mobileBottomNav');
    const btnMobileToggle = document.getElementById('btnMobileMenuToggle');

    // Always unhide hamburger menu button so CSS screen width controls it!
    if (btnMobileToggle) btnMobileToggle.classList.remove('hidden');

    // Render Header Horizontal Nav Links (Always updated for Mobile, Tablet & Desktop)
    this.renderHeaderNavLinks();

    // Render Mobile Drawer Nav (Always pre-rendered for instant drawer availability!)
    this.renderMobileDrawerNav();

    // HIDE Sidebar and Mobile Bottom Nav when NOT logged in (Guest mode)
    if (!this.currentUser) {
      document.body.classList.add('guest-mode');
      if (desktopSidebar) desktopSidebar.classList.add('hidden');
      if (mobileNav) mobileNav.classList.add('hidden');
      return;
    }

    // ENABLE & SHOW Sidebar and Mobile Bottom Nav when logged in!
    document.body.classList.remove('guest-mode');
    if (desktopSidebar) desktopSidebar.classList.remove('hidden');
    if (mobileNav) mobileNav.classList.remove('hidden');

    const isCustomer = this.currentRole === 'CUSTOMER';

    // Update Sidebar Navigation
    const desktopNav = document.getElementById('desktopSidebarNav');
    if (desktopNav) {
      document.getElementById('sidebarRoleLabel').innerText = isCustomer ? 'CUSTOMER DASHBOARD' : 'HOTEL OWNER / ADMIN';

        const u = this.currentUser;
        if (isCustomer) {
          desktopNav.innerHTML = `
            <a class="nav-item ${this.activeView === 'secCustomerHome' ? 'active' : ''}" onclick="app.switchView('secCustomerHome')"><i class="fa-solid fa-house"></i> Customer Home</a>
            <a class="nav-item ${this.activeView === 'secCustomerHome' ? 'active' : ''}" onclick="app.scrollToMenu()"><i class="fa-solid fa-utensils"></i> Today's Menu</a>
            <a class="nav-item ${this.activeView === 'secCustomerAddresses' ? 'active' : ''}" onclick="app.switchView('secCustomerAddresses')"><i class="fa-solid fa-location-dot" style="color: #FF5722;"></i> 📍 My Addresses</a>
            <a class="nav-item ${this.activeView === 'secCustomerMealPlans' ? 'active' : ''}" onclick="app.switchView('secCustomerMealPlans')"><i class="fa-solid fa-basket-shopping" style="color: #FF9800;"></i> 🧺 Meal Plans</a>
            <a class="nav-item ${this.activeView === 'secCustomerSubscriptions' ? 'active' : ''}" onclick="app.switchView('secCustomerSubscriptions')"><i class="fa-solid fa-calendar-check" style="color: #4CAF50;"></i> 🧺 My Subscriptions</a>
            <a class="nav-item ${this.activeView === 'secCustomerMealPasses' ? 'active' : ''}" onclick="app.switchView('secCustomerMealPasses')"><i class="fa-solid fa-qrcode" style="color: var(--accent-gold);"></i> 🎟️ My Passes</a>
            <a class="nav-item ${this.activeView === 'secCustomerMemberCard' ? 'active' : ''}" onclick="app.switchView('secCustomerMemberCard')"><i class="fa-solid fa-id-card" style="color: #FFD700;"></i> 💳 Member Card</a>
            <a class="nav-item ${this.activeView === 'secCustomerFavorites' ? 'active' : ''}" onclick="app.switchView('secCustomerFavorites')"><i class="fa-solid fa-heart" style="color: #E53935;"></i> My Favorites ❤️</a>
            <a class="nav-item" onclick="app.toggleCartDrawer()"><i class="fa-solid fa-cart-shopping"></i> Shopping Cart (<span class="cart-count-text">0</span>)</a>
            <a class="nav-item ${this.activeView === 'secCustomerOrders' ? 'active' : ''}" onclick="app.switchView('secCustomerOrders')"><i class="fa-solid fa-receipt"></i> My Orders</a>
            <a class="nav-item ${this.activeView === 'secQueueProgress' ? 'active' : ''}" onclick="app.switchView('secQueueProgress')"><i class="fa-solid fa-ticket" style="color: var(--accent-gold);"></i> 🎟️ Queue Progress</a>
            <a class="nav-item ${this.activeView === 'secCustomerPayments' ? 'active' : ''}" onclick="app.switchView('secCustomerPayments')"><i class="fa-solid fa-wallet"></i> Payment History</a>
            <a class="nav-item ${this.activeView === 'secCustomerReferral' ? 'active' : ''}" onclick="app.switchView('secCustomerReferral')"><i class="fa-solid fa-gift" style="color: var(--accent-gold);"></i> Refer & Earn</a>
            <a class="nav-item ${this.activeView === 'secCustomerLoyalty' ? 'active' : ''}" onclick="app.switchView('secCustomerLoyalty')"><i class="fa-solid fa-gift" style="color: #AB47BC;"></i> Loyalty Rewards 🎁</a>
            <a class="nav-item ${this.activeView === 'secCustomerSupport' ? 'active' : ''}" onclick="app.switchView('secCustomerSupport')"><i class="fa-solid fa-headset"></i> Support & FAQs</a>
            <a class="nav-item ${this.activeView === 'secCustomerProfile' ? 'active' : ''}" onclick="app.switchView('secCustomerProfile')">${u && u.profile_photo ? `<img src="${u.profile_photo}" alt="Profile" style="width: 18px; height: 18px; border-radius: 50%; object-fit: cover; vertical-align: middle; margin-right: 8px;">` : `<i class="fa-solid fa-user-gear"></i>`} My Profile</a>
          `;
        } else {
          const unreadNotifCount = (this.notifications || []).filter(n => !n.is_read && !n.read && n.target_role === 'OWNER').length;
          desktopNav.innerHTML = `
            <a class="nav-item ${this.activeView === 'secOwnerDashboard' ? 'active' : ''}" onclick="app.switchView('secOwnerDashboard')"><i class="fa-solid fa-chart-line"></i> Dashboard</a>
            <a class="nav-item ${this.activeView === 'secOwnerDeliveryZones' ? 'active' : ''}" onclick="app.switchView('secOwnerDeliveryZones')"><i class="fa-solid fa-map-location-dot" style="color: #4CAF50;"></i> 🗺️ Delivery Zones</a>
            <a class="nav-item ${this.activeView === 'secOwnerSubscriptionPlans' ? 'active' : ''}" onclick="app.switchView('secOwnerSubscriptionPlans')"><i class="fa-solid fa-basket-shopping" style="color: #FF9800;"></i> 🧺 Subscription Plans</a>
            <a class="nav-item ${this.activeView === 'secOwnerMealPassScanner' ? 'active' : ''}" onclick="app.switchView('secOwnerMealPassScanner')"><i class="fa-solid fa-qrcode" style="color: #00E676;"></i> 🎫 Meal Pass Scanner</a>
            <a class="nav-item ${this.activeView === 'secOwnerSubscribers' ? 'active' : ''}" onclick="app.switchView('secOwnerSubscribers')"><i class="fa-solid fa-users" style="color: #40C4FF;"></i> 👥 Subscribers</a>
            <a class="nav-item ${this.activeView === 'secOwnerVoting' ? 'active' : ''}" onclick="app.switchView('secOwnerVoting')">🗳️ Menu Voting</a>
            <a class="nav-item ${this.activeView === 'secOwnerSecurity' ? 'active' : ''}" onclick="app.switchView('secOwnerSecurity')"><i class="fa-solid fa-shield-halved" style="color: #40C4FF;"></i> 🛡️ Security Center</a>
            <a class="nav-item ${this.activeView === 'secOwnerRefunds' ? 'active' : ''}" onclick="app.switchView('secOwnerRefunds')">💸 Refunds</a>
            <a class="nav-item ${this.activeView === 'secOwnerAddons' ? 'active' : ''}" onclick="app.switchView('secOwnerAddons')">🥘 Add-ons</a>
            <a class="nav-item ${this.activeView === 'secOwnerBusinessCopilot' ? 'active' : ''}" onclick="app.switchView('secOwnerBusinessCopilot')"><i class="fa-solid fa-brain" style="color: #40C4FF;"></i> 🧠 Copilot</a>
            <a class="nav-item ${this.activeView === 'secOwnerSmartOffers' ? 'active' : ''}" onclick="app.switchView('secOwnerSmartOffers')"><i class="fa-solid fa-tags" style="color: #4CAF50;"></i> 🛒 Combo Offers</a>
            <a class="nav-item ${this.activeView === 'secOwnerMemberCardApprovals' ? 'active' : ''}" onclick="app.switchView('secOwnerMemberCardApprovals')"><i class="fa-solid fa-id-card" style="color: #FFD700;"></i> 🍽️ Member Cards</a>
            <a class="nav-item ${this.activeView === 'secOwnerTiffins' ? 'active' : ''}" onclick="app.switchView('secOwnerTiffins')"><i class="fa-solid fa-utensils"></i> Manage Tiffins</a>
            <a class="nav-item ${this.activeView === 'secOwnerOrders' ? 'active' : ''}" onclick="app.switchView('secOwnerOrders')"><i class="fa-solid fa-list-check"></i> Orders</a>
            <a class="nav-item ${this.activeView === 'secOwnerCustomers' ? 'active' : ''}" onclick="app.switchView('secOwnerCustomers')"><i class="fa-solid fa-users-gear" style="color: var(--accent-gold);"></i> Customers</a>
            <a class="nav-item" onclick="app.toggleNotificationsTray()"><i class="fa-solid fa-bell" style="color: var(--accent-gold);"></i> Alerts ${unreadNotifCount > 0 ? `<span class="sidebar-badge-count" style="background: var(--primary); color: #FFF; font-size: 0.72rem; padding: 2px 7px; border-radius: 10px; margin-left: 6px;">${unreadNotifCount}</span>` : ''}</a>
            <a class="nav-item ${this.activeView === 'secOwnerReviews' ? 'active' : ''}" onclick="app.switchView('secOwnerReviews')"><i class="fa-solid fa-star" style="color: var(--accent-gold);"></i> Reviews</a>
            <a class="nav-item ${this.activeView === 'secOwnerPayments' ? 'active' : ''}" onclick="app.switchView('secOwnerPayments')"><i class="fa-solid fa-wallet"></i> Payments</a>
            <a class="nav-item ${this.activeView === 'secOwnerSupport' ? 'active' : ''}" onclick="app.switchView('secOwnerSupport')"><i class="fa-solid fa-headset"></i> Support</a>
            <a class="nav-item ${this.activeView === 'secOwnerSettings' ? 'active' : ''}" onclick="app.switchView('secOwnerSettings')">${u && u.profile_photo ? `<img src="${u.profile_photo}" alt="Settings" style="width: 18px; height: 18px; border-radius: 50%; object-fit: cover; vertical-align: middle; margin-right: 8px;">` : `<i class="fa-solid fa-sliders"></i>`} Settings</a>
          `;
        }
    }

    // Update Mobile Bottom Navigation Bar
    if (mobileNav) {
      const cartCount = this.cart.reduce((acc, c) => acc + c.quantity, 0);
      const u = this.currentUser;
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
            ${u && u.profile_photo ? `<img src="${u.profile_photo}" alt="Profile" style="width: 22px; height: 22px; border-radius: 50%; object-fit: cover;">` : `<i class="fa-solid fa-user"></i>`} <span>Profile</span>
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
          <a class="bottom-nav-item ${this.activeView === 'secOwnerReviews' ? 'active' : ''}" onclick="app.switchView('secOwnerReviews')">
            <i class="fa-solid fa-star"></i> <span>Reviews</span>
          </a>
          <a class="bottom-nav-item ${this.activeView === 'secOwnerPayments' ? 'active' : ''}" onclick="app.switchView('secOwnerPayments')">
            <i class="fa-solid fa-wallet"></i> <span>Payments</span>
          </a>
          <a class="bottom-nav-item ${this.activeView === 'secOwnerSettings' ? 'active' : ''}" onclick="app.switchView('secOwnerSettings')">
            ${u && u.profile_photo ? `<img src="${u.profile_photo}" alt="Settings" style="width: 22px; height: 22px; border-radius: 50%; object-fit: cover;">` : `<i class="fa-solid fa-sliders"></i>`} <span>Settings</span>
          </a>
        `;
      }
    }
  }

  renderHeaderNavLinks() {
    const navContainer = document.getElementById('headerNavLinks');
    if (!navContainer) return;
    navContainer.innerHTML = '';
    navContainer.classList.add('hidden');
  }

  scrollToMenu() {
    if (this.activeView !== 'secCustomerHome') {
      this.switchView('secCustomerHome');
    }
    setTimeout(() => {
      const el = document.getElementById('customerMenuGrid') || document.querySelector('.category-tabs') || document.querySelector('.section-header');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 120);
  }

  // =========================================================================
  // NAVIGATION DRAWER (RESPONSIVE HAMBURGER MENU < 1200PX)
  // =========================================================================

  toggleMobileDrawer(open = null) {
    const backdrop = document.getElementById('mobileDrawerBackdrop');
    if (!backdrop) return;
    const currentState = backdrop.classList.contains('open');
    const newState = open !== null ? open : !currentState;
    backdrop.classList.toggle('open', newState);

    if (newState) {
      this.renderMobileDrawerNav();
    }
  }

  renderMobileDrawerNav() {
    const navContainer = document.getElementById('mobileDrawerNav');
    const hotelName = document.getElementById('mobileDrawerHotelName');
    const roleLabel = document.getElementById('mobileDrawerRoleLabel');
    if (!navContainer) return;

    if (hotelName && this.settings) {
      hotelName.innerText = this.settings.hotel_name || 'Annapurna Tiffin';
    }

    const cartCount = (this.cart || []).reduce((a, c) => a + c.quantity, 0);
    const unreadNotifCount = (this.notifications || []).filter(n => !n.is_read && !n.read).length;

    if (!this.currentUser) {
      if (roleLabel) roleLabel.innerText = '👋 GUEST EXPLORER';
      navContainer.innerHTML = `
        <div class="drawer-user-info-box guest">
          <div class="drawer-avatar-circle guest">
            <i class="fa-solid fa-user-astronaut"></i>
          </div>
          <div class="drawer-user-details">
            <strong class="drawer-user-name">Welcome, Guest!</strong>
            <span class="drawer-user-role">Sign in to unlock online ordering</span>
          </div>
        </div>

        <div class="drawer-menu-list">
          <a class="drawer-item ${this.activeView === 'secCustomerHome' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerHome');">
            <div class="drawer-icon-box orange"><i class="fa-solid fa-house"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Home</strong>
              <span class="drawer-item-sub">Fresh South Indian Tiffins</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item" onclick="app.toggleMobileDrawer(false); app.scrollToMenu();">
            <div class="drawer-icon-box gold"><i class="fa-solid fa-utensils"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Today's Menu</strong>
              <span class="drawer-item-sub">Idly, Dosa, Meals & Vada</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item" onclick="app.toggleMobileDrawer(false); app.openAiAssistantModal();">
            <div class="drawer-icon-box blue" style="background: linear-gradient(135deg, #2196F3, #1565C0); color: #FFF;"><i class="fa-solid fa-robot"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title" style="color: #2196F3;">🤖 AI Order Assistant</strong>
              <span class="drawer-item-sub">Smart natural language menu assistant</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item highlight-login" onclick="app.toggleMobileDrawer(false); app.openAuthModal('CUSTOMER', 'LOGIN');">
            <div class="drawer-icon-box primary"><i class="fa-solid fa-right-to-bracket"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title" style="color: var(--accent-gold);">Login / Register</strong>
              <span class="drawer-item-sub">Access your account & orders</span>
            </div>
            <i class="fa-solid fa-arrow-right drawer-chevron" style="color: var(--accent-gold);"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secCustomerSupport' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerSupport');">
            <div class="drawer-icon-box teal"><i class="fa-solid fa-headset"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Support & FAQs</strong>
              <span class="drawer-item-sub">Instant answers & helpline</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          ${this.isAppInstalled() ? `
            <a class="drawer-item" onclick="app.toggleMobileDrawer(false); app.showToast('✅ Website is already installed on your home screen!', 'success');">
              <div class="drawer-icon-box green"><i class="fa-solid fa-circle-check"></i></div>
              <div class="drawer-text-group">
                <strong class="drawer-item-title" style="color: var(--color-available);">✅ App Installed</strong>
                <span class="drawer-item-sub">Running as home screen app</span>
              </div>
              <i class="fa-solid fa-check drawer-chevron" style="color: var(--color-available);"></i>
            </a>
          ` : `
            <a class="drawer-item pwa-install-btn" onclick="app.toggleMobileDrawer(false); app.triggerPwaInstall();">
              <div class="drawer-icon-box purple"><i class="fa-solid fa-mobile-screen-button"></i></div>
              <div class="drawer-text-group">
                <strong class="drawer-item-title">📲 Install App</strong>
                <span class="drawer-item-sub">Install app on Android phone</span>
              </div>
              <i class="fa-solid fa-chevron-right drawer-chevron"></i>
            </a>
          `}

          <a class="drawer-item" href="tel:+919392874900">
            <div class="drawer-icon-box green"><i class="fa-solid fa-phone-volume"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Call Hotel Helpline</strong>
              <span class="drawer-item-sub">+91 9392874900 (Open 7 Days)</span>
            </div>
            <i class="fa-solid fa-arrow-up-right-from-square drawer-chevron"></i>
          </a>
        </div>
      `;
      return;
    }

    const isCustomer = this.currentRole === 'CUSTOMER';
    if (roleLabel) {
      roleLabel.innerText = isCustomer ? '👤 VIP CUSTOMER MENU' : '👑 HOTEL MANAGEMENT HUB';
    }

    if (isCustomer) {
      const u = this.currentUser;
      const initial = u.name ? u.name.charAt(0).toUpperCase() : 'C';
      const walletBal = u.wallet_balance || 0;
      const points = u.loyalty_points || 0;

      navContainer.innerHTML = `
        <div class="drawer-user-info-box customer">
          <div class="drawer-avatar-circle" style="overflow: hidden; display: flex; align-items: center; justify-content: center;">
            ${u.profile_photo ? `<img src="${u.profile_photo}" alt="${u.name}" style="width: 100%; height: 100%; object-fit: cover;">` : initial}
          </div>
          <div class="drawer-user-details">
            <strong class="drawer-user-name">${u.name}</strong>
            <span class="drawer-user-role">⭐ VIP Foodie Member</span>
            <div class="drawer-wallet-pill">
              <span>💳 ₹${walletBal}</span>
              <span class="pill-divider">•</span>
              <span>🏆 ${points} Pts</span>
            </div>
          </div>
        </div>

        <div class="drawer-menu-list">
          <a class="drawer-item ${this.activeView === 'secCustomerHome' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerHome');">
            <div class="drawer-icon-box orange"><i class="fa-solid fa-house"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Home</strong>
              <span class="drawer-item-sub">Breakfast & Mini Meals</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item" onclick="app.toggleMobileDrawer(false); app.scrollToMenu();">
            <div class="drawer-icon-box gold"><i class="fa-solid fa-utensils"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Today's Menu</strong>
              <span class="drawer-item-sub">Steaming hot delicacies</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item" onclick="app.toggleMobileDrawer(false); app.filterCategory('Specials'); app.scrollToMenu();">
            <div class="drawer-icon-box flame"><i class="fa-solid fa-fire"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Today's Specials</strong>
              <span class="drawer-item-sub">Chef's recommended combos</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item" onclick="app.toggleMobileDrawer(false); app.toggleCartDrawer();">
            <div class="drawer-icon-box primary"><i class="fa-solid fa-cart-shopping"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Shopping Cart</strong>
              <span class="drawer-item-sub">Review items & checkout</span>
            </div>
            ${cartCount > 0 ? `<span class="drawer-badge-count">${cartCount}</span>` : ''}
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item" onclick="app.toggleMobileDrawer(false); app.openAiAssistantModal();">
            <div class="drawer-icon-box blue" style="background: linear-gradient(135deg, #2196F3, #1565C0); color: #FFF;"><i class="fa-solid fa-robot"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title" style="color: #2196F3;">🤖 AI Order Assistant</strong>
              <span class="drawer-item-sub">Smart natural language menu assistant</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secCustomerAddresses' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerAddresses');">
            <div class="drawer-icon-box" style="background: rgba(255,87,34,0.15); color: #FF5722;"><i class="fa-solid fa-location-dot"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">📍 My Saved Addresses</strong>
              <span class="drawer-item-sub">Manage Home, Work & Delivery PINs</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secCustomerMealPlans' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerMealPlans');">
            <div class="drawer-icon-box" style="background: rgba(255,152,0,0.15); color: #FF9800;"><i class="fa-solid fa-basket-shopping"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">🧺 Subscription Meal Plans</strong>
              <span class="drawer-item-sub">Save big with 7/15/30-Day packages</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secCustomerSubscriptions' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerSubscriptions');">
            <div class="drawer-icon-box" style="background: rgba(76,175,80,0.15); color: #4CAF50;"><i class="fa-solid fa-calendar-check"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">🧺 My Subscriptions</strong>
              <span class="drawer-item-sub">Active plans & renewal history</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secCustomerMealPasses' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerMealPasses');">
            <div class="drawer-icon-box" style="background: rgba(234,162,33,0.15); color: var(--accent-gold);"><i class="fa-solid fa-qrcode"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">🎟️ My Passes</strong>
              <span class="drawer-item-sub">Show QR code at shop counter</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secCustomerVoting' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerVoting');">
            <div class="drawer-icon-box" style="background: rgba(156,39,176,0.15); color: #9C27B0;"><i class="fa-solid fa-square-poll-vertical"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">🗳️ Menu Voting</strong>
              <span class="drawer-item-sub">Vote for tomorrow's special dish</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secCustomerFavorites' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerFavorites');">
            <div class="drawer-icon-box" style="background: rgba(229,57,53,0.15); color: #E53935;"><i class="fa-solid fa-heart"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">My Favorites ❤️</strong>
              <span class="drawer-item-sub">Saved favorite tiffins</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secCustomerOrders' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerOrders');">
            <div class="drawer-icon-box blue"><i class="fa-solid fa-box-archive"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">My Orders</strong>
              <span class="drawer-item-sub">Live tracking & KOT history</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secQueueProgress' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secQueueProgress');">
            <div class="drawer-icon-box gold"><i class="fa-solid fa-ticket"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">🎟️ Queue Progress</strong>
              <span class="drawer-item-sub">Live token & queue tracking</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secCustomerPayments' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerPayments');">
            <div class="drawer-icon-box purple"><i class="fa-solid fa-wallet"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Payment History</strong>
              <span class="drawer-item-sub">Verified UPI & Cash receipts</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secCustomerReferral' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerReferral');">
            <div class="drawer-icon-box gold"><i class="fa-solid fa-gift"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Refer & Earn</strong>
              <span class="drawer-item-sub">Earn ₹30 bonus per friend</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secCustomerLoyalty' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerLoyalty');">
            <div class="drawer-icon-box purple" style="background: rgba(171, 71, 188, 0.2); color: #E1BEE7;"><i class="fa-solid fa-gift"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Loyalty Rewards 🎁</strong>
              <span class="drawer-item-sub">Points & discount rewards</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secCustomerMemberCard' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerMemberCard');">
            <div class="drawer-icon-box gold" style="background: rgba(255, 215, 0, 0.2); color: #FFD700;"><i class="fa-solid fa-id-card"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">💳 Member Card</strong>
              <span class="drawer-item-sub">₹5 OFF & Express Delivery</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item" onclick="app.toggleMobileDrawer(false); app.toggleNotificationsTray();">
            <div class="drawer-icon-box orange"><i class="fa-solid fa-bell"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Notifications</strong>
              <span class="drawer-item-sub">Order updates & alerts</span>
            </div>
            ${unreadNotifCount > 0 ? `<span class="drawer-badge-count danger">${unreadNotifCount}</span>` : ''}
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secCustomerSupport' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerSupport');">
            <div class="drawer-icon-box teal"><i class="fa-solid fa-headset"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Support & FAQs</strong>
              <span class="drawer-item-sub">24/7 help desk & tickets</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secCustomerProfile' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secCustomerProfile');">
            <div class="drawer-icon-box grey"><i class="fa-solid fa-user-gear"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">My Profile</strong>
              <span class="drawer-item-sub">Personal details & address</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          ${this.isAppInstalled() ? `
            <a class="drawer-item" onclick="app.toggleMobileDrawer(false); app.showToast('✅ Website is already installed on your home screen!', 'success');">
              <div class="drawer-icon-box green"><i class="fa-solid fa-circle-check"></i></div>
              <div class="drawer-text-group">
                <strong class="drawer-item-title" style="color: var(--color-available);">✅ App Installed</strong>
                <span class="drawer-item-sub">Running as home screen app</span>
              </div>
              <i class="fa-solid fa-check drawer-chevron" style="color: var(--color-available);"></i>
            </a>
          ` : `
            <a class="drawer-item pwa-install-btn" onclick="app.toggleMobileDrawer(false); app.triggerPwaInstall();">
              <div class="drawer-icon-box purple"><i class="fa-solid fa-mobile-screen-button"></i></div>
              <div class="drawer-text-group">
                <strong class="drawer-item-title">📲 Install App</strong>
                <span class="drawer-item-sub">Install app on Android phone</span>
              </div>
              <i class="fa-solid fa-chevron-right drawer-chevron"></i>
            </a>
          `}

          <a class="drawer-item danger" onclick="app.toggleMobileDrawer(false); app.logout();">
            <div class="drawer-icon-box danger"><i class="fa-solid fa-power-off"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Logout Account</strong>
              <span class="drawer-item-sub">Sign out securely</span>
            </div>
            <i class="fa-solid fa-right-from-bracket drawer-chevron"></i>
          </a>
        </div>
      `;
    } else {
      const u = this.currentUser;
      const isOpen = this.settings ? this.settings.is_open !== false : true;

      navContainer.innerHTML = `
        <div class="drawer-user-info-box owner">
          <div class="drawer-avatar-circle owner" style="overflow: hidden; display: flex; align-items: center; justify-content: center;">
            ${u.profile_photo ? `<img src="${u.profile_photo}" alt="${u.name}" style="width: 100%; height: 100%; object-fit: cover;">` : `<i class="fa-solid fa-user-shield"></i>`}
          </div>
          <div class="drawer-user-details">
            <strong class="drawer-user-name">${u.name}</strong>
            <span class="drawer-user-role">👑 Restaurant Owner / Admin</span>
            <div class="drawer-status-pill ${isOpen ? 'open' : 'closed'}">
              <span>${isOpen ? '🟢 HOTEL OPEN' : '🔴 HOTEL CLOSED'}</span>
            </div>
          </div>
        </div>

        <div class="drawer-menu-list">
          <a class="drawer-item ${this.activeView === 'secOwnerDashboard' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerDashboard');">
            <div class="drawer-icon-box primary"><i class="fa-solid fa-chart-line"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Dashboard & Analytics</strong>
              <span class="drawer-item-sub">Real-time sales & order stats</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerDeliveryZones' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerDeliveryZones');">
            <div class="drawer-icon-box" style="background: rgba(76,175,80,0.15); color: #4CAF50;"><i class="fa-solid fa-map-location-dot"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">🗺️ Delivery Zones & Fees</strong>
              <span class="drawer-item-sub">Configure PIN codes, fees & thresholds</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerSubscriptionPlans' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerSubscriptionPlans');">
            <div class="drawer-icon-box" style="background: rgba(255,152,0,0.15); color: #FF9800;"><i class="fa-solid fa-basket-shopping"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">🧺 Subscription Plans</strong>
              <span class="drawer-item-sub">Create & edit meal packages</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerMealPassScanner' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerMealPassScanner');">
            <div class="drawer-icon-box" style="background: rgba(0,230,118,0.15); color: #00E676;"><i class="fa-solid fa-qrcode"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">🎫 Meal Pass Scanner</strong>
              <span class="drawer-item-sub">Camera scanner for QR pass verification</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerSubscribers' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerSubscribers');">
            <div class="drawer-icon-box" style="background: rgba(64,196,255,0.15); color: #40C4FF;"><i class="fa-solid fa-users"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">👥 Subscribers Hub</strong>
              <span class="drawer-item-sub">Search, multi-filter & sort subscribers</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerVoting' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerVoting');">
            <div class="drawer-icon-box gold" style="background: rgba(234, 162, 33, 0.2); color: var(--accent-gold);"><i class="fa-solid fa-check-to-slot"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Menu Voting 🗳️</strong>
              <span class="drawer-item-sub">Tomorrow's Special Polls</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerSecurity' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerSecurity');">
            <div class="drawer-icon-box blue" style="background: rgba(64, 196, 255, 0.2); color: #40C4FF;"><i class="fa-solid fa-shield-halved"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Security Center 🛡️</strong>
              <span class="drawer-item-sub">Anti-Fraud & Audit Logs</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerRefunds' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerRefunds');">
            <div class="drawer-icon-box orange" style="background: rgba(234, 162, 33, 0.2); color: var(--accent-gold);"><i class="fa-solid fa-money-bill-transfer"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Refund Management 💸</strong>
              <span class="drawer-item-sub">Track & Process Refunds</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerAddons' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerAddons');">
            <div class="drawer-icon-box orange" style="background: rgba(234, 162, 33, 0.2); color: var(--accent-gold);"><i class="fa-solid fa-bowl-food"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Add-ons Management 🥘</strong>
              <span class="drawer-item-sub">Manage Extra Food Items & Prices</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerBusinessCopilot' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerBusinessCopilot');">
            <div class="drawer-icon-box blue" style="background: rgba(33, 150, 243, 0.2); color: #2196F3;"><i class="fa-solid fa-brain"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Business Copilot 🧠</strong>
              <span class="drawer-item-sub">AI Insights & Best Sellers</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerMemberCardApprovals' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerMemberCardApprovals');">
            <div class="drawer-icon-box gold" style="background: rgba(255, 215, 0, 0.2); color: #FFD700;"><i class="fa-solid fa-id-card"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Member Card Approvals 🍽️</strong>
              <span class="drawer-item-sub">Review ₹10 payments & approve</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerTiffins' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerTiffins');">
            <div class="drawer-icon-box gold"><i class="fa-solid fa-utensils"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Manage Tiffins & Menu</strong>
              <span class="drawer-item-sub">Add, edit pricing & stock</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerOrders' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerOrders');">
            <div class="drawer-icon-box blue"><i class="fa-solid fa-list-check"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Orders Management</strong>
              <span class="drawer-item-sub">Accept, prepare & complete</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerCustomers' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerCustomers');">
            <div class="drawer-icon-box gold"><i class="fa-solid fa-users-gear"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Customer Accounts</strong>
              <span class="drawer-item-sub">View, block/unblock & details</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerReviews' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerReviews');">
            <div class="drawer-icon-box gold"><i class="fa-solid fa-star"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Customer Reviews</strong>
              <span class="drawer-item-sub">View feedback, reply & feature</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerPayments' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerPayments');">
            <div class="drawer-icon-box purple"><i class="fa-solid fa-wallet"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Payment Receipts</strong>
              <span class="drawer-item-sub">Verify UPI screenshots & cash</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerSupport' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerSupport');">
            <div class="drawer-icon-box teal"><i class="fa-solid fa-headset"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Customer Support Inbox</strong>
              <span class="drawer-item-sub">Respond to customer tickets</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item ${this.activeView === 'secOwnerSettings' ? 'active' : ''}" onclick="app.toggleMobileDrawer(false); app.switchView('secOwnerSettings');">
            <div class="drawer-icon-box grey"><i class="fa-solid fa-sliders"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Business Settings</strong>
              <span class="drawer-item-sub">Timings, UPI ID & QR Scanner</span>
            </div>
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item" onclick="app.toggleMobileDrawer(false); app.toggleNotificationsTray();">
            <div class="drawer-icon-box orange"><i class="fa-solid fa-bell"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Notifications</strong>
              <span class="drawer-item-sub">Live alerts & updates</span>
            </div>
            ${unreadNotifCount > 0 ? `<span class="drawer-badge-count danger">${unreadNotifCount}</span>` : ''}
            <i class="fa-solid fa-chevron-right drawer-chevron"></i>
          </a>

          <a class="drawer-item danger" onclick="app.toggleMobileDrawer(false); app.logout();">
            <div class="drawer-icon-box danger"><i class="fa-solid fa-power-off"></i></div>
            <div class="drawer-text-group">
              <strong class="drawer-item-title">Logout Account</strong>
              <span class="drawer-item-sub">Sign out securely</span>
            </div>
            <i class="fa-solid fa-right-from-bracket drawer-chevron"></i>
          </a>
        </div>
      `;
    }
  }

  // =========================================================================
  // PWA (PROGRESSIVE WEB APP) INSTALLATION & OFFLINE DETECTION
  // =========================================================================

  initPwaInstall() {
    // Check initial installation state and update UI
    this.updatePwaInstallStateUI();

    // Handle Network Online / Offline Status (Requirement 23)
    window.addEventListener('offline', () => {
      this.showToast("📡 You're Offline: Please reconnect to the internet to view latest menu, orders, and payment information.", 'warning');
    });

    window.addEventListener('online', () => {
      this.showToast("🟢 Back Online: Reconnected to Annapurna Tiffin servers.", 'success');
    });
  }

  isAppInstalled() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true ||
      document.referrer.includes('android-app://')
    );
  }

  updatePwaInstallStateUI() {
    const staticBtnTitle = document.getElementById('staticDrawerInstallTitle');
    const staticBtnSub = document.getElementById('staticDrawerInstallSub');
    if (staticBtnTitle && staticBtnSub) {
      if (this.isAppInstalled()) {
        staticBtnTitle.innerText = '✅ App Installed';
        staticBtnTitle.style.color = 'var(--color-available)';
        staticBtnSub.innerText = 'Running as home screen app';
      } else {
        staticBtnTitle.innerText = '📲 Install App';
        staticBtnSub.innerText = 'Install app on Android phone';
      }
    }
    this.renderMobileDrawerNav();
  }

  triggerPwaInstall() {
    if (this.isAppInstalled()) {
      this.showToast('✅ App is already installed and running on your device!', 'success');
      return;
    }

    if (window.deferredPwaPrompt) {
      const promptEvent = window.deferredPwaPrompt;
      promptEvent.prompt();
      promptEvent.userChoice.then((choiceResult) => {
        if (choiceResult.outcome === 'accepted') {
          console.log('[PWA] User accepted the install prompt');
          window.deferredPwaPrompt = null;
          this.updatePwaInstallStateUI();
        } else {
          console.log('[PWA] User dismissed the install prompt');
        }
      });
    } else {
      // Browser or device does not support native prompt event or user already dismissed it
      this.openPwaInstallModal();
    }
  }

  openPwaInstallModal() {
    const modal = document.getElementById('pwaInstallModal');
    if (modal) {
      modal.classList.add('open');
    }
  }

  closePwaInstallModal() {
    const modal = document.getElementById('pwaInstallModal');
    if (modal) {
      modal.classList.remove('open');
    }
  }

  canAccessView(viewId) {
    if (!viewId || !document.getElementById(viewId)) return false;
    if (!this.currentUser) {
      if (viewId.startsWith('secOwner')) return false;
      if (['secCustomerOrders', 'secCustomerPayments', 'secCustomerReferral', 'secCustomerFavorites', 'secCustomerLoyalty', 'secCustomerMemberCard', 'secCustomerProfile'].includes(viewId)) {
        return false;
      }
      return true;
    }
    if (this.currentUser.role === 'CUSTOMER' && viewId.startsWith('secOwner')) return false;
    if (this.currentUser.role === 'OWNER' && viewId.startsWith('secCustomer') && viewId !== 'secCustomerHome' && viewId !== 'secCustomerSupport') {
      return false;
    }
    return true;
  }

  hasOpenOverlay() {
    // 1. Check dynamic modals in DOM
    const dynamicModals = [
      'modalConfirmRejectMemberApp',
      'modalConfirmReapproveMemberApp',
      'modalApplyMemberCard',
      'modalViewPaymentProof',
      'modalRejectMemberPayment',
      'modalConfirmDeleteMemberApp',
      'modalConfirmDeleteAllMemberApps',
      'modalRejectOrder'
    ];
    for (const id of dynamicModals) {
      const el = document.getElementById(id);
      if (el && (el.classList.contains('visible') || el.classList.contains('open') || el.classList.contains('active'))) {
        return true;
      }
    }

    // 2. Check static modals & drawers
    const staticModalSelectors = [
      '#reorderReviewModalBackdrop.open',
      '#cancelOrderModalBackdrop.open',
      '#editOrderModalBackdrop.open',
      '#checkoutModalBackdrop.open',
      '#authModalBackdrop.open',
      '#orderReviewModalBackdrop.open',
      '#verifyPinModalBackdrop.open',
      '#rejectOrderModalBackdrop.open',
      '#pwaInstallModal.open',
      '#cartDrawer.open',
      '#mobileDrawer.open',
      '#imageLightbox.open',
      '.modal-backdrop.open',
      '.modal-backdrop.visible',
      '.modal-backdrop.active',
      '.drawer.open'
    ];
    for (const selector of staticModalSelectors) {
      const el = document.querySelector(selector);
      if (el) return true;
    }

    return false;
  }

  closeTopmostOverlay() {
    // Check dynamic modals first
    if (document.getElementById('modalConfirmRejectMemberApp')) {
      this.closeRejectMemberCardModal();
      return true;
    }
    if (document.getElementById('modalConfirmReapproveMemberApp')) {
      this.closeReapproveMemberCardModal();
      return true;
    }
    if (document.getElementById('modalApplyMemberCard')) {
      this.closeApplyMemberCardModal();
      return true;
    }
    const payProofModal = document.getElementById('modalViewPaymentProof');
    if (payProofModal && (payProofModal.classList.contains('visible') || payProofModal.classList.contains('open'))) {
      this.closeViewPaymentProofModal();
      return true;
    }
    const rejectPayModal = document.getElementById('modalRejectMemberPayment');
    if (rejectPayModal && (rejectPayModal.classList.contains('visible') || rejectPayModal.classList.contains('open'))) {
      this.closeRejectPaymentModal();
      return true;
    }
    const delMemberAppModal = document.getElementById('modalConfirmDeleteMemberApp');
    if (delMemberAppModal && (delMemberAppModal.classList.contains('visible') || delMemberAppModal.classList.contains('open'))) {
      this.closeDeleteMemberAppModal();
      return true;
    }
    const delAllMemberAppsModal = document.getElementById('modalConfirmDeleteAllMemberApps');
    if (delAllMemberAppsModal && (delAllMemberAppsModal.classList.contains('visible') || delAllMemberAppsModal.classList.contains('open'))) {
      this.closeDeleteAllMemberAppsModal();
      return true;
    }

    // Check lightbox
    const lightbox = document.getElementById('imageLightbox');
    if (lightbox && lightbox.classList.contains('open')) {
      this.closeLightbox();
      return true;
    }

    // Check static modals / drawers
    const modalHandlers = [
      { id: 'modalCreatePoll', class: 'open', close: () => this.closeCreatePollModal() },
      { id: 'modalCreateEditAddon', class: 'open', close: () => this.closeCreateEditAddonModal() },
      { id: 'reorderReviewModalBackdrop', class: 'open', close: () => this.closeReorderReviewModal() },
      { id: 'cancelOrderModalBackdrop', class: 'open', close: () => this.closeCancelOrderModal() },
      { id: 'editOrderModalBackdrop', class: 'open', close: () => this.closeEditOrderModal() },
      { id: 'rejectOrderModalBackdrop', class: 'open', close: () => this.closeRejectOrderModal() },
      { id: 'verifyPinModalBackdrop', class: 'open', close: () => this.closeVerifyPinModal() },
      { id: 'checkoutModalBackdrop', class: 'open', close: () => this.toggleCheckoutModal(false) },
      { id: 'authModalBackdrop', class: 'open', close: () => this.toggleAuthModal(false) },
      { id: 'orderReviewModalBackdrop', class: 'open', close: () => this.closeOrderReviewModal() },
      { id: 'pwaInstallModal', class: 'open', close: () => this.closePwaInstallModal() },
      { id: 'cartDrawer', class: 'open', close: () => this.toggleCartDrawer(false) },
      { id: 'mobileDrawer', class: 'open', close: () => this.toggleMobileDrawer(false) }
    ];

    for (const h of modalHandlers) {
      const el = document.getElementById(h.id);
      if (el && (el.classList.contains(h.class) || el.classList.contains('visible') || el.classList.contains('active'))) {
        h.close();
        return true;
      }
    }

    // Fallback: any element matching .modal-backdrop.open, .modal-backdrop.visible, or .modal.open
    const anyModal = document.querySelector('.modal-backdrop.open, .modal-backdrop.visible, .modal.open, .drawer.open');
    if (anyModal) {
      anyModal.classList.remove('open', 'visible', 'active');
      return true;
    }

    return false;
  }

  setupAndroidBackNavigation() {
    const initialView = this.activeView || (this.currentRole === 'OWNER' ? 'secOwnerDashboard' : 'secCustomerHome');
    try {
      window.history.replaceState({ viewId: initialView, timestamp: Date.now() }, '', `#${initialView}`);
    } catch (e) {}
    this.viewHistoryStack = [initialView];

    window.addEventListener('popstate', (e) => {
      // 1. Overlay Priority Check: If any modal/overlay/drawer is open, close it first
      if (this.hasOpenOverlay()) {
        const closed = this.closeTopmostOverlay();
        if (closed) {
          try {
            window.history.pushState({ viewId: this.activeView, timestamp: Date.now() }, '', `#${this.activeView}`);
          } catch (err) {}
          return;
        }
      }

      // 2. View History Back Navigation
      const targetView = (e.state && e.state.viewId) ? e.state.viewId : (window.location.hash ? window.location.hash.replace('#', '') : null);

      if (targetView && targetView !== this.activeView && document.getElementById(targetView)) {
        if (this.canAccessView(targetView)) {
          this.switchView(targetView, { isBack: true });
          return;
        }
      }

      // 3. Fallback using internal history stack
      if (this.viewHistoryStack && this.viewHistoryStack.length > 1) {
        this.viewHistoryStack.pop(); // Remove current view
        const prevView = this.viewHistoryStack[this.viewHistoryStack.length - 1];
        if (prevView && prevView !== this.activeView && document.getElementById(prevView) && this.canAccessView(prevView)) {
          this.switchView(prevView, { isBack: true });
          return;
        }
      }

      // If at root view with no prior history, allow default browser/PWA exit behavior
    });
  }

  switchView(viewId, options = {}) {
    const isBack = options.isBack || false;

    // Access Control Guard - Require login for features
    if (!this.currentUser) {
      if (viewId === 'secCustomerOrders' || viewId === 'secCustomerPayments' || viewId === 'secCustomerReferral' || viewId === 'secCustomerFavorites' || viewId === 'secCustomerLoyalty' || viewId === 'secCustomerMemberCard') {
        this.showToast('Please Login or Register to view favorites, orders, payments, referral rewards, loyalty points & member card.', 'error');
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

    const previousView = this.activeView;

    // Always stop active QR camera scanner when switching views
    if (this.closeFoodMemberQrScannerModal) {
      this.closeFoodMemberQrScannerModal();
    }
    if (this.stopMealPassScanner) {
      this.stopMealPassScanner();
    }

    // Skip redundant re-rendering if already on target view
    if (this.activeView === viewId && document.getElementById(viewId) && !document.getElementById(viewId).classList.contains('hidden')) {
      return;
    }

    this.activeView = viewId;

    if (!this.viewHistoryStack) {
      this.viewHistoryStack = [previousView || viewId];
    }

    if (!isBack && viewId !== previousView) {
      try {
        window.history.pushState({ viewId: viewId, timestamp: Date.now() }, '', `#${viewId}`);
      } catch (err) {}
      this.viewHistoryStack.push(viewId);
    }

    this.renderNavigation();
    this.renderCurrentView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  renderCurrentView() {
    this.updateUserAuthBadgeUI();
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

    // Floating Support Help Widget is ONLY visible for Customers / Guests (Hidden on Owner side)
    const floatingSupport = document.querySelector('.floating-support-container');
    const isOwnerView = (this.currentRole === 'OWNER') || (this.currentUser && this.currentUser.role === 'OWNER') || (this.activeView && this.activeView.startsWith('secOwner'));
    document.body.classList.toggle('owner-mode', isOwnerView);
    document.body.classList.toggle('owner-dashboard-active', this.activeView === 'secOwnerDashboard');
    if (floatingSupport) {
      floatingSupport.classList.toggle('hidden', isOwnerView);
    }

    // Trigger render logic per view
    if (this.activeView === 'secCustomerHome') {
      this.renderMenu();
      this.loadActivePoll();
    }
    if (this.activeView === 'secCustomerOrders') this.renderOrders();
    if (this.activeView === 'secQueueProgress') this.fetchQueueProgress();
    if (this.activeView === 'secCustomerFavorites') {
      this.fetchFavorites();
      this.renderFavorites();
    }
    if (this.activeView === 'secCustomerPayments') {
      this.fetchPayments();
      this.renderCustomerPayments();
    }
    if (this.activeView === 'secCustomerReferral') {
      this.fetchReferralStats();
      this.fetchLeaderboard();
    }
    if (this.activeView === 'secCustomerLoyalty') {
      this.loadLoyaltyRewardsPage();
    }
    if (this.activeView === 'secCustomerMemberCard') {
      this.loadFoodMemberCardState();
    }
    if (this.activeView === 'secCustomerSupport') {
      this.fetchSupportTickets();
      this.renderFaqs();
    }
    if (this.activeView === 'secCustomerProfile') {
      this.renderCustomerProfile();
    }
    if (this.activeView === 'secCustomerVoting') this.loadCustomerVoting();
    if (this.activeView === 'secCustomerMealPlans') this.renderCustomerMealPlans();
    if (this.activeView === 'secCustomerSubscriptions') this.renderCustomerSubscriptions();
    if (this.activeView === 'secCustomerMealPasses') this.renderCustomerMealPasses();
    if (this.activeView === 'secCustomerAddresses') this.loadCustomerAddresses();
    if (this.activeView === 'secOwnerSubscriptionPlans') this.renderOwnerSubscriptionPlans();
    if (this.activeView === 'secOwnerMealPassScanner') this.startMealPassScanner();
    if (this.activeView === 'secOwnerSubscribers') this.renderOwnerSubscribersHub();
    if (this.activeView === 'secOwnerDeliveryZones') this.loadOwnerDeliveryZones();
    if (this.activeView === 'secOwnerDashboard') {
      this.fetchStats();
      this.renderOrders();
    }
    if (this.activeView === 'secOwnerVoting') this.loadOwnerPolls();
    if (this.activeView === 'secOwnerSecurity') this.loadSecurityDashboard();
    if (this.activeView === 'secOwnerRefunds') this.loadOwnerRefundsDashboard();
    if (this.activeView === 'secOwnerAddons') this.loadOwnerAddonsDashboard();
    if (this.activeView === 'secOwnerBusinessCopilot') this.loadBusinessCopilotDashboard();
    if (this.activeView === 'secOwnerSmartOffers') this.loadOwnerSmartOffers();
    if (this.activeView === 'secOwnerMemberCardApprovals') {
      this.loadOwnerMemberApprovals();
    }
    if (this.activeView === 'secOwnerTiffins') this.renderMenu();
    if (this.activeView === 'secOwnerOrders') this.renderOrders();
    if (this.activeView === 'secOwnerCustomers') this.fetchOwnerCustomers();
    if (this.activeView === 'secOwnerReviews') this.fetchOwnerReviews();
    if (this.activeView === 'secOwnerPayments') {
      this.fetchPayments();
      this.renderPayments();
    }
    if (this.activeView === 'secOwnerSupport') this.fetchSupportTickets();
    if (this.activeView === 'secOwnerSettings') {
      this.isSettingsFormPopulated = false;
      this.fetchSettings().then(() => this.populateSettingsForm());
    }
  }

  // =========================================================================
  // CUSTOMER PROFILE, CART & FAVORITES SYNC
  // =========================================================================

  renderCustomerProfile() {
    if (!this.currentUser) return;
    const nameDisp = document.getElementById('profNameDisplay');
    const phoneDisp = document.getElementById('profPhoneDisplay');
    const nameInput = document.getElementById('profNameInput');
    const phoneInput = document.getElementById('profPhoneInput');
    const emailInput = document.getElementById('profEmailInput');
    const addrInput = document.getElementById('profAddressInput');
    const avatarInit = document.getElementById('profAvatarInitials');
    const statOrders = document.getElementById('profStatOrdersCount');
    const statWallet = document.getElementById('profStatWalletBal');

    const name = this.currentUser.name || 'Customer';
    if (nameDisp) nameDisp.innerText = name;
    if (phoneDisp) phoneDisp.innerText = this.currentUser.mobile || '---';
    if (nameInput) nameInput.value = name;
    if (phoneInput) phoneInput.value = this.currentUser.mobile || '';
    if (emailInput) emailInput.value = this.currentUser.email || '';
    if (addrInput) addrInput.value = this.currentUser.address || '';
    if (avatarInit) avatarInit.innerText = name.charAt(0).toUpperCase();

    // Customer Profile Photo UI Update
    const profRing = document.getElementById('profAvatarRing');
    const profImg = document.getElementById('profAvatarImg');
    const custRemoveBtn = document.getElementById('btnCustRemovePhoto');
    const custUploadBtnLabel = document.getElementById('lblCustPhotoBtn');

    if (this.currentUser.profile_photo) {
      if (profRing) profRing.classList.add('has-photo');
      if (profImg) {
        profImg.src = this.currentUser.profile_photo;
        profImg.classList.remove('hidden');
      }
      if (avatarInit) avatarInit.classList.add('hidden');
      if (custRemoveBtn) custRemoveBtn.classList.remove('hidden');
      if (custUploadBtnLabel) custUploadBtnLabel.innerText = 'Change Photo';
    } else {
      if (profRing) profRing.classList.remove('has-photo');
      if (profImg) {
        profImg.src = '';
        profImg.classList.add('hidden');
      }
      if (avatarInit) avatarInit.classList.remove('hidden');
      if (custRemoveBtn) custRemoveBtn.classList.add('hidden');
      if (custUploadBtnLabel) custUploadBtnLabel.innerText = 'Upload Photo';
    }

    if (statOrders) {
      statOrders.innerText = this.isLoadingOrders ? 'Loading...' : (this.orders || []).length;
    }
    if (statWallet) {
      const bal = this.referralStats?.wallet_balance || 0;
      statWallet.innerText = `₹${bal}`;
    }
  }

  async saveCustomerProfile(e) {
    if (e) e.preventDefault();
    if (!this.currentUser) return;

    const name = document.getElementById('profNameInput')?.value;
    const email = document.getElementById('profEmailInput')?.value;
    const address = document.getElementById('profAddressInput')?.value;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, address })
      });
      const json = await res.json();
      if (json.success) {
        this.currentUser = json.data;
        localStorage.setItem('tiffin_user', JSON.stringify(json.data));
        this.showToast(json.message || 'Profile saved successfully.', 'success');
        this.updateUserAuthBadgeUI();
        this.renderCustomerProfile();
      } else {
        this.showToast(json.message || 'Failed to save profile.', 'error');
      }
    } catch (err) {
      console.error('Error saving profile:', err);
      this.showToast('Server communication error.', 'error');
    }
  }

  // =========================================================================
  // PROFILE PHOTO UPLOADER & MANAGEMENT
  // =========================================================================

  triggerPhotoUpload(role = 'CUSTOMER') {
    const inputId = role === 'OWNER' ? 'ownerPhotoFileInput' : 'customerPhotoFileInput';
    const inputEl = document.getElementById(inputId);
    if (inputEl) inputEl.click();
  }

  async handlePhotoFileSelected(event, role = 'CUSTOMER') {
    const file = event.target?.files?.[0];
    if (!file) return;

    const statusId = role === 'OWNER' ? 'ownerPhotoUploadStatus' : 'custPhotoUploadStatus';
    const statusEl = document.getElementById(statusId);

    const setStatus = (msg, type = 'info') => {
      if (!statusEl) return;
      statusEl.classList.remove('hidden');
      statusEl.style.color = type === 'error' ? 'var(--color-unavailable)' : (type === 'success' ? 'var(--color-available)' : 'var(--accent-gold)');
      statusEl.innerText = msg;
    };

    // 1. Client-Side File Type Validation (JPG, JPEG, PNG, WEBP)
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type.toLowerCase())) {
      setStatus('❌ Invalid file format. Only JPG, JPEG, PNG, and WEBP images are allowed.', 'error');
      this.showToast('❌ Invalid file format. Allowed: JPG, JPEG, PNG, WEBP', 'danger');
      event.target.value = '';
      return;
    }

    // 2. Client-Side File Size Validation (Max 5MB)
    const maxSizeInBytes = 5 * 1024 * 1024;
    if (file.size > maxSizeInBytes) {
      setStatus('❌ File size is too large. Maximum allowed size is 5MB.', 'error');
      this.showToast('❌ File size exceeds 5MB limit.', 'danger');
      event.target.value = '';
      return;
    }

    setStatus('⏳ Processing and uploading profile photo...', 'info');

    // 3. Read File as Base64 Data URL
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64Data = e.target.result;
      try {
        const response = await this.fetchWithAuth(`${API_BASE}/profile/photo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photo: base64Data })
        });

        const data = await response.json();
        if (data.success && data.user) {
          this.currentUser = data.user;
          localStorage.setItem('tiffin_user', JSON.stringify(this.currentUser));
          if (sessionStorage.getItem('tiffin_user')) {
            sessionStorage.setItem('tiffin_user', JSON.stringify(this.currentUser));
          }

          setStatus('✅ Profile photo updated successfully!', 'success');
          this.showToast('✅ Profile photo updated successfully!', 'success');

          // Update UI across all components immediately
          this.updateUserAuthBadgeUI();
          this.renderNavigation();
          this.renderMobileDrawerNav();
          if (role === 'OWNER') {
            this.populateSettingsForm();
          } else {
            this.renderCustomerProfile();
          }

          setTimeout(() => {
            if (statusEl) statusEl.classList.add('hidden');
          }, 3000);
        } else {
          setStatus(`❌ ${data.message || 'Failed to upload photo.'}`, 'error');
          this.showToast(`❌ ${data.message || 'Upload failed'}`, 'danger');
        }
      } catch (err) {
        console.error('Error uploading profile photo:', err);
        setStatus('❌ Network error uploading photo. Please try again.', 'error');
        this.showToast('❌ Failed to upload photo', 'danger');
      } finally {
        event.target.value = '';
      }
    };

    reader.onerror = () => {
      setStatus('❌ Error reading selected image file.', 'error');
      this.showToast('❌ Error reading file', 'danger');
      event.target.value = '';
    };

    reader.readAsDataURL(file);
  }

  async removeProfilePhoto(role = 'CUSTOMER') {
    if (!this.currentUser) return;
    if (!confirm('Are you sure you want to remove your profile photo?')) return;

    const statusId = role === 'OWNER' ? 'ownerPhotoUploadStatus' : 'custPhotoUploadStatus';
    const statusEl = document.getElementById(statusId);

    try {
      const response = await this.fetchWithAuth(`${API_BASE}/profile/photo`, {
        method: 'DELETE'
      });

      const data = await response.json();
      if (data.success && data.user) {
        this.currentUser = data.user;
        localStorage.setItem('tiffin_user', JSON.stringify(this.currentUser));
        if (sessionStorage.getItem('tiffin_user')) {
          sessionStorage.setItem('tiffin_user', JSON.stringify(this.currentUser));
        }

        this.showToast('✅ Profile photo removed successfully.', 'success');

        // Update UI across all views
        this.updateUserAuthBadgeUI();
        this.renderNavigation();
        this.renderMobileDrawerNav();
        if (role === 'OWNER') {
          this.populateSettingsForm();
        } else {
          this.renderCustomerProfile();
        }

        if (statusEl) statusEl.classList.add('hidden');
      } else {
        this.showToast(`❌ ${data.message || 'Failed to remove photo.'}`, 'danger');
      }
    } catch (err) {
      console.error('Error removing profile photo:', err);
      this.showToast('❌ Failed to remove profile photo', 'danger');
    }
  }

  async fetchCart() {
    if (!this.currentUser || this.currentRole !== 'CUSTOMER') return;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/cart`);
      const json = await res.json();
      if (json.success) {
        this.cart = Array.isArray(json.data) ? json.data : [];
        this.updateCartUI();
      }
    } catch (err) {
      console.error('Error fetching cart:', err);
    }
  }

  async saveCartBackend() {
    if (!this.currentUser || this.currentRole !== 'CUSTOMER') return;
    try {
      await this.fetchWithAuth(`${API_BASE}/cart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cart: this.cart })
      });
    } catch (err) {
      console.error('Error saving cart:', err);
    }
  }

  async fetchFavorites() {
    if (!this.currentUser || this.currentRole !== 'CUSTOMER') return;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/favorites`);
      const json = await res.json();
      if (json.success) {
        this.favorites = Array.isArray(json.data) ? json.data : [];
      }
    } catch (err) {
      console.error('Error fetching favorites:', err);
    }
  }

  async saveFavoritesBackend() {
    if (!this.currentUser || this.currentRole !== 'CUSTOMER') return;
    try {
      await this.fetchWithAuth(`${API_BASE}/favorites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorites: this.favorites })
      });
    } catch (err) {
      console.error('Error saving favorites:', err);
    }
  }

  async toggleFavorite(tiffinId, event) {
    if (event) event.stopPropagation();

    if (!this.currentUser || this.currentRole !== 'CUSTOMER') {
      this.showToast('Please log in to save items to your favorites ❤️', 'warning');
      this.openAuthModal('CUSTOMER', 'LOGIN');
      return;
    }

    if (!Array.isArray(this.favorites)) {
      this.favorites = [];
    }

    const index = this.favorites.indexOf(tiffinId);

    if (index >= 0) {
      this.favorites.splice(index, 1);
      this.showToast('Removed from Favorites ❤️', 'info');
    } else {
      this.favorites.push(tiffinId);
      this.showToast('Added to My Favorites ❤️', 'success');
    }

    await this.saveFavoritesBackend();

    if (this.activeView === 'secCustomerHome') {
      this.renderMenu();
    } else if (this.activeView === 'secCustomerFavorites') {
      this.renderFavorites();
    }
  }

  renderFavorites() {
    if (this.currentRole !== 'CUSTOMER') return;
    const container = document.getElementById('customerFavoritesGrid');
    if (!container) return;

    if (!this.favorites || !this.favorites.length) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 3.5rem 1rem; color: var(--text-muted); background: var(--bg-surface); border-radius: var(--radius-lg); border: 1.5px dashed var(--border-color);">
          <div style="width: 70px; height: 70px; border-radius: 50%; background: rgba(229, 57, 53, 0.15); color: #E53935; display: flex; align-items: center; justify-content: center; font-size: 2rem; margin: 0 auto 1rem auto;">
            <i class="fa-solid fa-heart-crack"></i>
          </div>
          <h3 style="color: var(--text-main); font-size: 1.2rem; margin-bottom: 0.5rem;">No Favorites Saved Yet</h3>
          <p style="font-size: 0.9rem; max-width: 400px; margin: 0 auto 1.25rem auto;">Tap the ❤️ heart icon on any tiffin card in today's menu to save it to your favorites!</p>
          <button class="btn-primary-block" onclick="app.switchView('secCustomerHome')" style="max-width: 220px; margin: 0 auto;">
            <i class="fa-solid fa-utensils"></i> Explore Menu
          </button>
        </div>`;
      return;
    }

    const favoriteItems = [];
    this.favorites.forEach(favId => {
      const item = this.menu.find(m => m.id === favId);
      if (item) {
        favoriteItems.push(item);
      }
    });

    if (!favoriteItems.length) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 3rem 1rem; color: var(--text-muted); background: var(--bg-surface); border-radius: var(--radius-lg); border: 1.5px dashed var(--border-color);">
          <i class="fa-solid fa-heart-crack" style="font-size: 2.5rem; color: #E53935; margin-bottom: 0.5rem;"></i>
          <p>Your saved favorite items are currently no longer available on the menu.</p>
          <button class="btn-primary-block" onclick="app.switchView('secCustomerHome')" style="max-width: 200px; margin: 1rem auto 0 auto;">Browse Menu</button>
        </div>`;
      return;
    }

    const isHotelOpen = this.settings ? (this.settings.is_open !== false) : true;

    container.innerHTML = favoriteItems.map(item => {
      const qty = this.quantities[item.id] || 1;
      const isAvailable = item.is_available;
      const canOrder = isAvailable && isHotelOpen;

      return `
        <div class="food-card ${!canOrder ? 'unavailable' : ''}">
          <div class="food-card-img-wrapper">
            <img src="${item.image}" alt="${item.name}" class="food-card-img" onerror="this.src='/images/idly_sambar.png'">
            <span class="availability-badge ${canOrder ? 'available' : 'unavailable'}">
              <i class="fa-solid fa-circle" style="font-size: 0.5rem;"></i> ${!isHotelOpen ? 'Hotel Closed' : (isAvailable ? 'Available' : 'Not Available')}
            </span>
            <span class="category-tag">${item.category}</span>
            <button type="button" class="favorite-heart-btn active" onclick="app.toggleFavorite('${item.id}', event)" title="Remove from Favorites" style="position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.65); border: none; color: #E53935; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; cursor: pointer; backdrop-filter: blur(4px); transition: all 0.2s ease; z-index: 5;">
              <i class="fa-solid fa-heart"></i>
            </button>
          </div>

          <div class="food-card-body">
            <h3 class="food-card-title">${item.name}</h3>
            <p class="food-card-desc">${item.description}</p>

            <div class="food-card-footer">
              <span class="food-card-price">₹${item.price}</span>

              ${canOrder ? `
                <div class="qty-selector">
                  <button class="qty-btn" onclick="app.changeItemQty('${item.id}', -1)">-</button>
                  <span class="qty-val" id="fav_qty_${item.id}">${qty}</span>
                  <button class="qty-btn" onclick="app.changeItemQty('${item.id}', 1)">+</button>
                </div>
                <button class="btn-add-cart" onclick="app.addToCart('${item.id}')">
                  <i class="fa-solid fa-cart-plus"></i> Add
                </button>
              ` : `
                <button class="btn-add-cart" disabled style="${!isHotelOpen ? 'background: rgba(229,57,53,0.15); color: #FF5252; border: 1px solid rgba(229,57,53,0.3); font-weight: 700;' : ''}">
                  ${!isHotelOpen ? '🔴 Hotel Closed' : '🔴 Not Available'}
                </button>
              `}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  async reorderPreviousOrder(orderId, evt) {
    const btn = evt ? (evt.currentTarget || evt.target) : null;
    const origHTML = btn ? btn.innerHTML : '<i class="fa-solid fa-rotate-right"></i> 🔄 Reorder';

    if (btn) {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
    }

    try {
      if (!this.currentUser || this.currentRole !== 'CUSTOMER') {
        this.showToast('Please log in to reorder previous orders.', 'warning');
        this.openAuthModal('CUSTOMER', 'LOGIN');
        return;
      }

      const isHotelOpen = this.settings ? (this.settings.is_open !== false) : true;
      if (!isHotelOpen) {
        this.showToast('🔴 Hotel is currently closed. Cannot place reorder at this time.', 'error');
        return;
      }

      // Client Guard: Reorder allowed ONLY for completed orders
      const targetOrder = (this.orders || []).find(o => String(o.id) === String(orderId) || String(o.order_number) === String(orderId));
      if (targetOrder) {
        const orderStatClean = (targetOrder.order_status || '').toLowerCase();
        if (!['completed', 'delivered'].includes(orderStatClean)) {
          this.showToast('❌ Reorder is available ONLY AFTER the order is completed.', 'error');
          return;
        }
      }

      let reorderableItems = [];
      let unavailableItems = [];
      let origOrderNum = orderId;

      // Primary: Fetch live verified items from backend endpoint
      try {
        const res = await fetch(`${API_BASE}/orders/${encodeURIComponent(orderId)}/reorder-items`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.authToken}`
          }
        });

        const json = await res.json();
        if (res.ok && json.success && json.data) {
          origOrderNum = json.data.original_order_number || orderId;
          reorderableItems = json.data.reorderableItems || [];
          unavailableItems = json.data.unavailableItems || [];
        } else if (!res.ok || !json.success) {
          this.showToast(json.message || '❌ Reorder is available ONLY AFTER the order is completed.', 'error');
          return;
        }
      } catch (e) {
        console.warn('Backend reorder verification notice:', e);
      }

      // Fallback: Client menu matching if endpoint unreachable
      if (!reorderableItems.length) {
        const order = (this.orders || []).find(o => String(o.id) === String(orderId) || String(o.order_number) === String(orderId));
        if (!order) {
          this.showToast('Order details not found.', 'error');
          return;
        }
        origOrderNum = order.order_number || orderId;
        const items = order.items || [];
        if (!items.length) {
          this.showToast('No items found in this order.', 'error');
          return;
        }

        items.forEach(orderItem => {
          const targetId = orderItem.tiffin_id || orderItem.id;
          const matchedTiffin = (this.menu || []).find(m => m.id === targetId || (m.name && orderItem.name && m.name.toLowerCase() === orderItem.name.toLowerCase()));

          if (matchedTiffin && matchedTiffin.is_available !== false) {
            reorderableItems.push({
              id: matchedTiffin.id,
              name: matchedTiffin.name,
              price: Number(matchedTiffin.price),
              image: matchedTiffin.image,
              quantity: Number(orderItem.quantity || 1)
            });
          } else {
            unavailableItems.push(orderItem.name || 'Item');
          }
        });
      }

      if (!reorderableItems.length) {
        this.showToast(`❌ Cannot reorder: All items from Order #${origOrderNum} are currently unavailable or deleted.`, 'error');
        return;
      }

      // Store active reorder state
      this.activeReorderTargetId = orderId;
      this.activeReorderData = {
        origOrderNum,
        reorderableItems,
        unavailableItems
      };

      // Open Reorder Review Modal
      this.openReorderReviewModal();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHTML;
      }
    }
  }

  openReorderReviewModal() {
    if (!this.activeReorderData) return;

    const { origOrderNum, reorderableItems, unavailableItems } = this.activeReorderData;

    const modalBackdrop = document.getElementById('reorderReviewModalBackdrop');
    const origNumElem = document.getElementById('reorderReviewOrigNum');
    const itemsListElem = document.getElementById('reorderReviewItemsList');
    const grandTotalElem = document.getElementById('reorderReviewGrandTotal');
    const addressInput = document.getElementById('reorderReviewAddress');
    const unavailNotice = document.getElementById('reorderReviewUnavailableNotice');
    const selectPayMethod = document.getElementById('reorderReviewPaymentMethod');

    if (origNumElem) origNumElem.innerText = origOrderNum;
    if (addressInput) addressInput.value = this.currentUser?.address || '';

    // Reset payment & proof fields
    if (selectPayMethod) selectPayMethod.value = 'Cash';
    this.removeReorderScreenshot();
    const utrInput = document.getElementById('reorderUTRNumber');
    if (utrInput) utrInput.value = '';

    let grandTotal = 0;
    if (itemsListElem) {
      itemsListElem.innerHTML = reorderableItems.map(item => {
        const itemTotal = Number(item.price) * Number(item.quantity);
        grandTotal += itemTotal;
        return `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px dashed rgba(255,255,255,0.1); font-size: 0.84rem;">
            <div>
              <strong style="color: #FFF;">${item.name}</strong>
              <div style="font-size: 0.75rem; color: var(--text-muted);">${item.quantity} × ₹${item.price} (Current Price)</div>
            </div>
            <div style="font-weight: 800; color: var(--accent-gold);">₹${itemTotal}</div>
          </div>
        `;
      }).join('');
    }

    if (grandTotalElem) grandTotalElem.innerText = `₹${grandTotal}`;

    if (unavailNotice) {
      if (unavailableItems && unavailableItems.length > 0) {
        unavailNotice.classList.remove('hidden');
        unavailNotice.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> <strong>Excluded Unavailable Items:</strong> ${unavailableItems.join(', ')}`;
      } else {
        unavailNotice.classList.add('hidden');
      }
    }

    this.handleReorderPaymentMethodChange('Cash');

    if (modalBackdrop) modalBackdrop.classList.add('open');
  }

  handleReorderPaymentMethodChange(method) {
    const upiQrBox = document.getElementById('reorderUpiQrBox');
    const btnSubmit = document.getElementById('btnConfirmReorderSubmit');
    const isOnline = method === 'UPI' || method === 'QRPay';

    if (upiQrBox) {
      upiQrBox.classList.toggle('hidden', !isOnline);
    }

    if (isOnline && this.settings) {
      const qrImg = document.getElementById('reorderQrScannerImg');
      if (qrImg) {
        const qrSrc = this.getQrDisplayUrl();
        if (qrSrc && qrImg.getAttribute('data-raw-src') !== qrSrc) {
          qrImg.src = qrSrc;
          qrImg.setAttribute('data-raw-src', qrSrc);
        }
      }
      const upiDisplay = document.getElementById('reorderUpiIdDisplay');
      if (upiDisplay) {
        upiDisplay.innerText = this.settings.upi_id || '9392974900@ybl';
      }

      const elHolder = document.getElementById('reorderDisplayBankHolder');
      const elBank = document.getElementById('reorderDisplayBankName');
      const elAcc = document.getElementById('reorderDisplayBankAccount');
      const elIfsc = document.getElementById('reorderDisplayBankIfsc');
      const elBox = document.getElementById('reorderBankDetailsDisplay');

      const bankHolder = this.settings.account_holder || this.settings.upi_name || this.settings.hotel_name || '';
      const bankName = this.settings.bank_name || '';
      const bankAcc = this.settings.bank_account || '';
      const bankIfsc = this.settings.bank_ifsc || '';

      if (elHolder) elHolder.innerText = bankHolder || '-';
      if (elBank) elBank.innerText = bankName || '-';
      if (elAcc) elAcc.innerText = bankAcc || '-';
      if (elIfsc) elIfsc.innerText = bankIfsc || '-';
      if (elBox) elBox.classList.toggle('hidden', !(bankAcc || bankIfsc || bankName));
    }

    if (btnSubmit) {
      const grandTotalText = document.getElementById('reorderReviewGrandTotal')?.innerText || '';
      if (isOnline) {
        btnSubmit.innerHTML = `<span>Confirm & Pay Reorder (${grandTotalText})</span> <i class="fa-solid fa-check-circle"></i>`;
      } else {
        btnSubmit.innerHTML = `<span>Confirm Reorder</span> <i class="fa-solid fa-check-circle"></i>`;
      }
    }
  }

  handleReorderScreenshotUpload(evt) {
    const file = evt.target.files ? evt.target.files[0] : null;
    const fileNameElem = document.getElementById('reorderScreenshotFileName');
    const previewWrapper = document.getElementById('reorderScreenshotPreviewWrapper');
    const previewImg = document.getElementById('reorderScreenshotPreviewImg');

    if (!file) {
      this.reorderScreenshotData = null;
      if (fileNameElem) fileNameElem.innerText = 'No file selected';
      if (previewWrapper) previewWrapper.classList.add('hidden');
      return;
    }

    if (fileNameElem) fileNameElem.innerText = file.name;

    const reader = new FileReader();
    reader.onload = (e) => {
      this.reorderScreenshotData = e.target.result;
      if (previewImg) previewImg.src = e.target.result;
      if (previewWrapper) previewWrapper.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  }

  removeReorderScreenshot() {
    this.reorderScreenshotData = null;
    const input = document.getElementById('reorderPaymentScreenshot');
    if (input) input.value = '';
    const fileNameElem = document.getElementById('reorderScreenshotFileName');
    if (fileNameElem) fileNameElem.innerText = 'No file selected';
    const previewWrapper = document.getElementById('reorderScreenshotPreviewWrapper');
    if (previewWrapper) previewWrapper.classList.add('hidden');
  }

  closeReorderReviewModal() {
    const modalBackdrop = document.getElementById('reorderReviewModalBackdrop');
    if (modalBackdrop) modalBackdrop.classList.remove('open');
    this.removeReorderScreenshot();
    this.activeReorderTargetId = null;
    this.activeReorderData = null;
  }

  async confirmAndSubmitReorder() {
    if (!this.activeReorderTargetId) {
      this.showToast('Reorder target not found.', 'error');
      return;
    }

    const address = document.getElementById('reorderReviewAddress')?.value?.trim() || '';
    const payment_method = document.getElementById('reorderReviewPaymentMethod')?.value || 'Cash';
    const utrNumber = document.getElementById('reorderUTRNumber')?.value?.trim() || '';
    const screenshotData = this.reorderScreenshotData || '';

    const isOnline = payment_method === 'UPI' || payment_method === 'QRPay';

    if (isOnline) {
      if (!utrNumber && !screenshotData) {
        this.showToast('Please upload a payment screenshot or enter the 12-digit UTR number for your online payment.', 'warning');
        return;
      }
    }

    const btnSubmit = document.getElementById('btnConfirmReorderSubmit');
    const origHTML = btnSubmit ? btnSubmit.innerHTML : '<span>Confirm Reorder</span> <i class="fa-solid fa-check-circle"></i>';

    try {
      if (btnSubmit) {
        if (btnSubmit.disabled) return;
        btnSubmit.disabled = true;
        btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Placing New Reorder...';
      }

      // Call Backend End-to-End Database Reorder Endpoint
      const res = await fetch(`${API_BASE}/orders/${encodeURIComponent(this.activeReorderTargetId)}/reorder`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`
        },
        body: JSON.stringify({
          delivery_address: address,
          payment_method: payment_method,
          utr_number: utrNumber,
          payment_screenshot: screenshotData
        })
      });

      const json = await res.json();

      if (json.success && json.data?.new_order) {
        this.showToast(json.message || `🎉 New Reorder #${json.data.new_order.order_number} created successfully!`, 'success');
        this.closeReorderReviewModal();

        // Refresh Orders directly from backend database
        await this.fetchOrders();

        // Switch view to Customer Orders & scroll to top
        this.switchView('secCustomerOrders');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        this.showToast(json.message || 'Failed to place reorder. Please try again.', 'error');
      }
    } catch (err) {
      console.error('Error placing reorder:', err);
      this.showToast('Server error placing reorder. Please try again.', 'error');
    } finally {
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = origHTML;
      }
    }
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
        const isHotelOpen = this.settings ? (this.settings.is_open !== false) : true;
        const canOrder = isAvailable && isHotelOpen;
        const isFav = Array.isArray(this.favorites) && this.favorites.includes(item.id);

        return `
          <div class="food-card ${!canOrder ? 'unavailable' : ''}">
            <div class="food-card-img-wrapper">
              <img src="${item.image}" alt="${item.name}" class="food-card-img" onerror="this.src='/images/idly_sambar.png'">
              <span class="availability-badge ${canOrder ? 'available' : 'unavailable'}">
                <i class="fa-solid fa-circle" style="font-size: 0.5rem;"></i> ${!isHotelOpen ? 'Hotel Closed' : (isAvailable ? 'Available' : 'Not Available')}
              </span>
              <span class="category-tag">${item.category}</span>
              <button type="button" class="favorite-heart-btn ${isFav ? 'active' : ''}" onclick="app.toggleFavorite('${item.id}', event)" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}" style="position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.65); border: none; color: ${isFav ? '#E53935' : '#FFFFFF'}; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; cursor: pointer; backdrop-filter: blur(4px); transition: all 0.2s ease; z-index: 5;">
                <i class="fa-${isFav ? 'solid' : 'regular'} fa-heart"></i>
              </button>
            </div>

            <div class="food-card-body">
              <h3 class="food-card-title">${item.name}</h3>
              <p class="food-card-desc">${item.description}</p>

              <div class="food-card-footer">
                <span class="food-card-price">₹${item.price}</span>

                ${canOrder ? `
                  <div class="qty-selector">
                    <button class="qty-btn" onclick="app.changeItemQty('${item.id}', -1)">-</button>
                    <span class="qty-val" id="qty_${item.id}">${qty}</span>
                    <button class="qty-btn" onclick="app.changeItemQty('${item.id}', 1)">+</button>
                  </div>
                  <button class="btn-add-cart" onclick="app.addToCart('${item.id}')">
                    <i class="fa-solid fa-cart-plus"></i> Add
                  </button>
                ` : `
                  <button class="btn-add-cart" disabled style="${!isHotelOpen ? 'background: rgba(229,57,53,0.15); color: #FF5252; border: 1px solid rgba(229,57,53,0.3); font-weight: 700;' : ''}">
                    ${!isHotelOpen ? '🔴 Hotel Closed' : '🔴 Not Available'}
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
      this.openAuthModal('LOGIN');
      return;
    }

    if (this.settings && this.settings.is_open === false) {
      this.showToast('Hotel is currently closed. Orders are not being accepted.', 'error');
      return;
    }

    const item = this.menu.find(m => m.id === itemId);
    if (!item || !item.is_available) {
      this.showToast('Item is currently not available', 'error');
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

  calculateCartTotals() {
    const items = this.cart || [];
    const mainSubtotal = items.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 1)), 0);
    const addonsSubtotal = this.calculateSelectedAddonsTotal ? this.calculateSelectedAddonsTotal() : 0;
    const subtotal = mainSubtotal + addonsSubtotal;
    const walletDiscount = Number(this.appliedWalletDiscount || 0);
    const grandTotal = Math.max(0, subtotal - walletDiscount);
    return {
      mainSubtotal,
      addonsSubtotal,
      subtotal,
      walletDiscount,
      grandTotal
    };
  }

  updateCartUI() {
    const badge = document.getElementById('cartBadgeCount');
    const mobileBadge = document.getElementById('mobileCartBadgeCount');
    const mainItemsCount = (this.cart || []).reduce((acc, c) => acc + c.quantity, 0);
    const addonsCount = Object.values(this.selectedCartAddons || {}).reduce((acc, a) => acc + (a.quantity || 0), 0);
    const totalCount = mainItemsCount + addonsCount;

    if (totalCount > 0) {
      if (badge) { badge.innerText = totalCount; badge.classList.remove('hidden'); }
      if (mobileBadge) { mobileBadge.innerText = totalCount; mobileBadge.classList.remove('hidden'); }
    } else {
      if (badge) badge.classList.add('hidden');
      if (mobileBadge) mobileBadge.classList.add('hidden');
    }

    document.querySelectorAll('.cart-count-text').forEach(el => el.innerText = totalCount);

    const { subtotal, grandTotal } = this.calculateCartTotals();

    const container = document.getElementById('cartItemsContainer');
    const selectedAddonsList = Object.values(this.selectedCartAddons || {});

    if (container) {
      if (!this.cart.length && !selectedAddonsList.length) {
        container.innerHTML = `
          <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
            <i class="fa-solid fa-cart-flatbed" style="font-size: 2.5rem; margin-bottom: 0.5rem;"></i>
            <p>Your shopping cart is empty.</p>
          </div>`;
      } else {
        let html = '';

        if (this.cart.length > 0) {
          html += this.cart.map(item => {
            const itemTotal = item.price * item.quantity;
            return `
              <div class="cart-item">
                <img src="${item.image}" alt="${escapeHtml(item.name)}" class="cart-item-img" onerror="this.src='/images/idly_sambar.png'">
                <div class="cart-item-details">
                  <div class="cart-item-title">${escapeHtml(item.name)}</div>
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
        }

        if (selectedAddonsList.length > 0) {
          html += `
            <div style="margin-top: 1rem; padding-top: 0.75rem; border-top: 1px dashed var(--border-color);">
              <h5 style="margin: 0 0 0.5rem 0; color: var(--accent-gold); font-size: 0.82rem; font-weight: 700; display: flex; align-items: center; gap: 6px;">
                <span>🥘</span> Selected Extra Add-ons
              </h5>
              ${selectedAddonsList.map(addon => {
                const addonId = addon.add_on_id || addon.id;
                const addonTotal = Number(addon.price) * Number(addon.quantity);
                return `
                  <div class="cart-item" style="border-left: 3px solid var(--accent-gold); background: rgba(255,179,0,0.05); margin-bottom: 6px; padding: 0.6rem 0.75rem;">
                    <div class="cart-item-details">
                      <div class="cart-item-title" style="font-size: 0.85rem; color: #FFF;">${escapeHtml(addon.name)}</div>
                      <div class="cart-item-price" style="font-size: 0.78rem; color: #FFC107;">+₹${addon.price} x ${addon.quantity} = +₹${addonTotal}</div>
                    </div>
                    <div class="qty-selector" style="transform: scale(0.8);">
                      <button class="qty-btn" onclick="app.updateCartAddonQty('${addonId}', -1)">-</button>
                      <span class="qty-val">${addon.quantity}</span>
                      <button class="qty-btn" onclick="app.updateCartAddonQty('${addonId}', 1)">+</button>
                    </div>
                    <button class="cart-item-remove" onclick="app.removeAddon('${addonId}')" title="Remove Add-on"><i class="fa-solid fa-trash"></i></button>
                  </div>
                `;
              }).join('')}
            </div>
          `;
        }

        container.innerHTML = html;
      }
    }

    const elCartSub = document.getElementById('cartSubtotal');
    const elCartGrand = document.getElementById('cartGrandTotal');
    const elCheckoutGrand = document.getElementById('checkoutGrandTotalDisplay');

    if (elCartSub) elCartSub.innerText = `₹${subtotal}`;
    if (elCartGrand) elCartGrand.innerText = `₹${grandTotal}`;
    if (elCheckoutGrand) elCheckoutGrand.innerText = `₹${grandTotal}`;

    this.updatePhonePeAmountDisplay();
    this.evaluateSmartCartOptimizer();
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

    if (isOpen) {
      this.fetchAvailableAddons();
    }
  }

  openOrderCheckoutModal() {
    if (!this.cart || !this.cart.length) {
      this.showToast('Your cart is empty! Please add items from menu.', 'error');
      return;
    }
    if (this.settings && this.settings.is_open === false) {
      this.showToast('Hotel is currently closed. Orders are not being accepted.', 'error');
      return;
    }

    if (!this.currentUser) {
      this.toggleCartDrawer(false);
      this.showToast('Please login or register to complete your order.', 'info');
      this.openAuthModal('LOGIN');
      return;
    }

    this.toggleCartDrawer(false);
    document.getElementById('ordCustomerName').value = this.currentUser ? (this.currentUser.name || '') : '';
    document.getElementById('ordCustomerMobile').value = this.currentUser ? (this.currentUser.mobile || '') : '';
    const addrInput = document.getElementById('ordDeliveryAddress');
    if (addrInput) addrInput.value = this.currentUser ? (this.currentUser.address || '') : '';

    // Dynamically load shopkeeper's uploaded QR code scanner image & UPI ID
    if (this.settings) {
      const qrImg = document.getElementById('checkoutQrScannerImg');
      if (qrImg) {
        const qrSrc = this.getQrDisplayUrl();
        if (qrSrc) {
          if (qrImg.getAttribute('data-raw-src') !== qrSrc) {
            qrImg.src = qrSrc;
            qrImg.setAttribute('data-raw-src', qrSrc);
          }
          qrImg.style.display = 'block';
        }
      }
      const upiDisplay = document.getElementById('checkoutUpiIdDisplay');
      if (upiDisplay) {
        upiDisplay.innerText = this.settings.upi_id || '9392974900@ybl';
      }

      const elHolder = document.getElementById('displayBankHolder');
      const elBank = document.getElementById('displayBankName');
      const elAcc = document.getElementById('displayBankAccount');
      const elIfsc = document.getElementById('displayBankIfsc');
      const elBox = document.getElementById('checkoutBankDetailsDisplay');

      const bankHolder = this.settings.account_holder || this.settings.upi_name || this.settings.hotel_name || '';
      const bankName = this.settings.bank_name || '';
      const bankAcc = this.settings.bank_account || '';
      const bankIfsc = this.settings.bank_ifsc || '';

      if (elHolder) elHolder.innerText = bankHolder || '-';
      if (elBank) elBank.innerText = bankName || '-';
      if (elAcc) elAcc.innerText = bankAcc || '-';
      if (elIfsc) elIfsc.innerText = bankIfsc || '-';

      if (elBox) {
        if (bankAcc || bankIfsc || bankName) {
          elBox.classList.remove('hidden');
        } else {
          elBox.classList.add('hidden');
        }
      }
    }

    const chkWallet = document.getElementById('chkUseWallet');
    if (chkWallet) chkWallet.checked = false;
    this.appliedWalletDiscount = 0;
    const breakdownBox = document.getElementById('referralAppliedBreakdown');
    if (breakdownBox) breakdownBox.classList.add('hidden');

    this.handleCheckoutOrderTypeChange();
    this.updateCartUI();
    this.selectPaymentMethod(this.selectedPaymentMethod || 'Cash');

    this.fetchReferralStats().then(() => {
      const walletBal = Number(this.referralStats?.wallet_balance || this.currentUser?.wallet_balance || 0);
      const elText = document.getElementById('checkoutWalletAvailableText');
      if (elText) elText.innerHTML = `Available Balance: <strong>₹${walletBal}</strong>`;
    }).catch(() => {});

    this.toggleCheckoutModal(true);
  }

  handleCheckoutOrderTypeChange() {
    const type = document.getElementById('ordType')?.value;
    const label = document.getElementById('ordDeliveryAddressLabel');
    const input = document.getElementById('ordDeliveryAddress');
    const savedContainer = document.getElementById('savedAddressesCheckoutContainer');
    if (!label || !input) return;

    if (type === 'Dine-in') {
      label.innerHTML = `<i class="fa-solid fa-utensils" style="color: var(--primary);"></i> Table Number / Dining Area <span style="color: var(--primary);">*</span>`;
      input.placeholder = "e.g. Table No. 4, Ground Floor AC Section...";
      if (savedContainer) savedContainer.innerHTML = '';
      this.selectedDeliveryAddressId = null;
      this.currentDeliveryFee = 0;
    } else if (type === 'Takeaway') {
      label.innerHTML = `<i class="fa-solid fa-box" style="color: var(--primary);"></i> Pickup Notes / Time <span style="color: var(--primary);">*</span>`;
      input.placeholder = "e.g. Self pickup at counter around 8:00 PM...";
      if (savedContainer) savedContainer.innerHTML = '';
      this.selectedDeliveryAddressId = null;
      this.currentDeliveryFee = 0;
    } else {
      label.innerHTML = `<i class="fa-solid fa-location-dot" style="color: var(--primary);"></i> Select Saved Delivery Address <span style="color: var(--primary);">*</span>`;
      input.placeholder = "House/Flat No, Building, Street, Landmark, Area details...";
      this.loadCheckoutSavedAddresses();
    }
  }

  toggleCheckoutModal(open = true) {
    const backdrop = document.getElementById('checkoutModalBackdrop');
    backdrop.classList.toggle('open', open);
  }

  selectPaymentMethod(method) {
    this.selectedPaymentMethod = method;
    document.getElementById('optPayCash')?.classList.toggle('selected', method === 'Cash');
    document.getElementById('optPayUPI')?.classList.toggle('selected', method === 'UPI');
    document.getElementById('upiQrBox')?.classList.toggle('hidden', method !== 'UPI');

    if (method === 'UPI') {
      this.updateOnlinePaymentOptionsVisibility();
    }
  }

  async updateReferralWalletCheckoutUI() {
    let latestBalance = 0;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/referrals/stats`);
      const json = await res.json();
      if (json.success && json.data) {
        latestBalance = Number(json.data.wallet_balance || 0);
        if (this.currentUser) this.currentUser.wallet_balance = latestBalance;
        if (this.referralStats) this.referralStats.wallet_balance = latestBalance;
      }
    } catch (err) {
      console.error('Error fetching latest wallet balance for checkout:', err);
      latestBalance = Number(this.currentUser?.wallet_balance || 0);
    }

    const cartTotals = this.calculateCartTotals ? this.calculateCartTotals() : { grandTotal: 0 };
    const orderTotal = cartTotals.grandTotal || 0;

    const elDisplayBal = document.getElementById('refWalletDisplayBal');
    const elCurrentBalVal = document.getElementById('refWalletCurrentBalVal');
    const elOrderTotalVal = document.getElementById('refWalletOrderTotalVal');
    const elRemainingBalVal = document.getElementById('refWalletRemainingBalVal');
    const elInsufficientMsg = document.getElementById('refWalletInsufficientMsg');

    const stateSufficient = document.getElementById('refWalletSufficientState');
    const stateInsufficient = document.getElementById('refWalletInsufficientState');
    const stateZero = document.getElementById('refWalletZeroState');
    const btnSubmit = document.getElementById('btnCheckoutSubmit');

    if (elDisplayBal) elDisplayBal.innerText = `₹${latestBalance}`;
    if (elCurrentBalVal) elCurrentBalVal.innerText = `₹${latestBalance}`;
    if (elOrderTotalVal) elOrderTotalVal.innerText = `₹${orderTotal}`;

    if (latestBalance === 0) {
      if (stateSufficient) stateSufficient.classList.add('hidden');
      if (stateInsufficient) stateInsufficient.classList.add('hidden');
      if (stateZero) stateZero.classList.remove('hidden');

      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.innerHTML = `<i class="fa-solid fa-ban"></i> <span>Pay with Referral Wallet (₹0 Balance)</span>`;
      }
    } else if (latestBalance < orderTotal) {
      if (stateSufficient) stateSufficient.classList.add('hidden');
      if (stateZero) stateZero.classList.add('hidden');
      if (stateInsufficient) stateInsufficient.classList.remove('hidden');

      if (elInsufficientMsg) {
        elInsufficientMsg.innerHTML = `Your referral wallet balance is ₹${latestBalance}, but this order requires ₹${orderTotal}.`;
      }

      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> <span>Insufficient Wallet Balance</span>`;
      }
    } else {
      const remainingBal = latestBalance - orderTotal;
      if (elRemainingBalVal) elRemainingBalVal.innerText = `₹${remainingBal}`;

      if (stateZero) stateZero.classList.add('hidden');
      if (stateInsufficient) stateInsufficient.classList.add('hidden');
      if (stateSufficient) stateSufficient.classList.remove('hidden');

      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = `<i class="fa-solid fa-gift"></i> <span>Pay ₹${orderTotal} with Referral Wallet</span>`;
      }
    }
  }

  updateOnlinePaymentOptionsVisibility() {
    const isQrEnabled = this.settings?.is_qr_pay_enabled !== false;
    const isPhonePeEnabled = this.settings?.is_phonepe_enabled !== false;

    const subtabsContainer = document.querySelector('.online-pay-subtabs');
    const btnQr = document.getElementById('subtabQrPay');
    const btnPhonePe = document.getElementById('subtabPhonePe');
    const viewQr = document.getElementById('subviewQrPay');
    const viewPhonePe = document.getElementById('subviewPhonePe');
    const proofSection = document.getElementById('onlineProofSection');
    const disabledMsg = document.getElementById('onlinePaymentDisabledMsg');

    if (!isQrEnabled && !isPhonePeEnabled) {
      if (subtabsContainer) subtabsContainer.classList.add('hidden');
      if (viewQr) viewQr.classList.add('hidden');
      if (viewPhonePe) viewPhonePe.classList.add('hidden');
      if (proofSection) proofSection.classList.add('hidden');
      if (disabledMsg) disabledMsg.classList.remove('hidden');
      return;
    }

    if (disabledMsg) disabledMsg.classList.add('hidden');

    if (isQrEnabled && isPhonePeEnabled) {
      if (subtabsContainer) subtabsContainer.classList.remove('hidden');
      if (btnQr) btnQr.classList.remove('hidden');
      if (btnPhonePe) btnPhonePe.classList.remove('hidden');

      if (!this.selectedOnlineSubOption) this.selectedOnlineSubOption = 'QRPay';
      this.selectOnlineSubOption(this.selectedOnlineSubOption);
    } else if (isQrEnabled && !isPhonePeEnabled) {
      if (subtabsContainer) subtabsContainer.classList.add('hidden');
      if (btnQr) btnQr.classList.remove('hidden');
      if (btnPhonePe) btnPhonePe.classList.add('hidden');

      this.selectedOnlineSubOption = 'QRPay';
      if (viewQr) viewQr.classList.remove('hidden');
      if (viewPhonePe) viewPhonePe.classList.add('hidden');
      if (proofSection) proofSection.classList.remove('hidden');
      if (btnQr) btnQr.classList.add('active');
      if (btnPhonePe) btnPhonePe.classList.remove('active');
    } else if (!isQrEnabled && isPhonePeEnabled) {
      if (subtabsContainer) subtabsContainer.classList.add('hidden');
      if (btnQr) btnQr.classList.add('hidden');
      if (btnPhonePe) btnPhonePe.classList.remove('hidden');

      this.selectedOnlineSubOption = 'PhonePe';
      if (viewQr) viewQr.classList.add('hidden');
      if (viewPhonePe) viewPhonePe.classList.remove('hidden');
      if (proofSection) proofSection.classList.add('hidden');
      if (btnQr) btnQr.classList.remove('active');
      if (btnPhonePe) btnPhonePe.classList.add('active');

      this.updatePhonePeAmountDisplay();
    }
  }

  async togglePaymentMethodSetting(method) {
    if (!this.settings) this.settings = {};
    if (method === 'QRPay') {
      const current = this.settings.is_qr_pay_enabled !== false;
      this.settings.is_qr_pay_enabled = !current;
    } else if (method === 'PhonePe') {
      const current = this.settings.is_phonepe_enabled !== false;
      this.settings.is_phonepe_enabled = !current;
    }

    this.updateHeaderAndSettingsUI();

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_qr_pay_enabled: this.settings.is_qr_pay_enabled,
          is_phonepe_enabled: this.settings.is_phonepe_enabled
        })
      });
      const json = await res.json();
      if (json.success) {
        this.showToast('Payment settings updated successfully.', 'success');
        this.settings = json.data;
        this.updateHeaderAndSettingsUI();
      } else {
        this.showToast(json.message || 'Failed to update payment settings.', 'error');
      }
    } catch (err) {
      console.error('Error updating payment settings:', err);
      this.showToast('Server communication error.', 'error');
    }
  }

  selectOnlineSubOption(subOption) {
    this.selectedOnlineSubOption = subOption;
    const btnQr = document.getElementById('subtabQrPay');
    const btnPhonePe = document.getElementById('subtabPhonePe');
    const viewQr = document.getElementById('subviewQrPay');
    const viewPhonePe = document.getElementById('subviewPhonePe');
    const proofSection = document.getElementById('onlineProofSection');

    if (btnQr) btnQr.classList.toggle('active', subOption === 'QRPay');
    if (btnPhonePe) btnPhonePe.classList.toggle('active', subOption === 'PhonePe');
    if (viewQr) viewQr.classList.toggle('hidden', subOption !== 'QRPay');
    if (viewPhonePe) viewPhonePe.classList.toggle('hidden', subOption !== 'PhonePe');

    // Screenshot Upload & UTR input fields are completely hidden/disabled ONLY for PhonePe
    if (proofSection) {
      proofSection.classList.toggle('hidden', subOption === 'PhonePe');
    }

    if (subOption === 'PhonePe') {
      this.updatePhonePeAmountDisplay();
    }
  }

  updatePhonePeAmountDisplay() {
    const { grandTotal } = this.calculateCartTotals();
    const elAmount = document.getElementById('phonePePayableAmount');
    const elBtnAmount = document.getElementById('phonePeBtnAmount');
    if (elAmount) elAmount.innerText = grandTotal;
    if (elBtnAmount) elBtnAmount.innerText = grandTotal;
  }

  launchPhonePeIntent(redirectUrl, orderData = {}) {
    const vpa = (this.settings?.upi_id || '9392974900@ybl').trim();
    const amount = orderData.amount || orderData.net_amount || (this.calculateCartTotals ? this.calculateCartTotals().grandTotal : '');
    const orderNum = orderData.order_number || orderData.orderNumber || '';
    const merchantName = this.settings?.upi_name || 'Sri Lakshmi Annapurna Tiffin Center';

    const encodedVpa = encodeURIComponent(vpa);
    const encodedPn = encodeURIComponent(merchantName);
    const encodedAm = encodeURIComponent(amount);
    const encodedTn = encodeURIComponent('Order ' + (orderNum || 'Tiffin'));

    const isAndroid = /android/i.test(navigator.userAgent || '');
    
    // Direct PhonePe URI scheme & Android intent URI (Launches installed PhonePe Android App directly without intermediate web page navigation)
    const phonepeScheme = `phonepe://pay?pa=${encodedVpa}&pn=${encodedPn}&am=${encodedAm}&cu=INR&tn=${encodedTn}`;
    const intentScheme = `intent://pay?pa=${encodedVpa}&pn=${encodedPn}&am=${encodedAm}&cu=INR&tn=${encodedTn}#Intent;scheme=upi;end`;
    const upiScheme = `upi://pay?pa=${encodedVpa}&pn=${encodedPn}&am=${encodedAm}&cu=INR&tn=${encodedTn}`;

    const fallbackUrl = isAndroid ? intentScheme : upiScheme;

    // Launch direct PhonePe app scheme first, with universal Android UPI intent fallback
    try {
      window.location.href = phonepeScheme;
      setTimeout(() => {
        window.location.href = fallbackUrl;
      }, 250);
    } catch (err) {
      console.warn('[PhonePe Direct App Launch Fallback]:', err);
      window.location.href = fallbackUrl;
    }
  }

  async openPhonePePaymentApp() {
    const { grandTotal } = this.calculateCartTotals();

    if (!this.cart || !this.cart.length || grandTotal <= 0) {
      this.showToast('Your cart is empty or amount is invalid.', 'error');
      return;
    }

    if (this.isSubmittingOrder) return;

    const elName = document.getElementById('ordCustomerName');
    const elMobile = document.getElementById('ordCustomerMobile');
    const elAddress = document.getElementById('ordDeliveryAddress');

    const name = (elName?.value || (this.currentUser ? this.currentUser.name : '') || '').trim();
    const mobile = (elMobile?.value || (this.currentUser ? this.currentUser.mobile : '') || '').trim();
    const orderType = document.getElementById('ordType')?.value || 'Takeaway';
    const deliveryAddress = (elAddress?.value || '').trim();
    const notes = document.getElementById('ordNotes')?.value || '';

    if (!name) {
      this.showToast('Please enter your Customer Name in the checkout form above.', 'error');
      if (elName) elName.focus();
      return;
    }

    if (!mobile || mobile.length < 10) {
      this.showToast('Please enter a valid 10-digit Mobile Number in the checkout form above.', 'error');
      if (elMobile) elMobile.focus();
      return;
    }

    if (orderType === 'Delivery' && !deliveryAddress) {
      this.showToast('Please enter your Delivery Address in the checkout form above.', 'error');
      if (elAddress) elAddress.focus();
      return;
    }

    const payload = {
      customer_name: name,
      customer_mobile: mobile,
      order_type: orderType,
      delivery_address: deliveryAddress || (orderType === 'Delivery' ? (this.currentUser ? this.currentUser.address : 'Home Delivery') : 'Counter Pickup'),
      notes: notes,
      used_wallet_amount: this.appliedWalletDiscount || 0,
      items: this.cart,
      add_ons: this.getSelectedAddonsPayload ? this.getSelectedAddonsPayload() : []
    };

    this.isSubmittingOrder = true;
    const payBtns = document.querySelectorAll('.btn-phonepe-pay');
    payBtns.forEach(btn => {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="font-size: 1.2rem;"></i> <span>Opening PhonePe...</span>`;
    });

    try {
      this.showToast('Initiating PhonePe payment gateway...', 'info');
      const res = await this.fetchWithAuth(`${API_BASE}/phonepe/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      let json = {};
      try {
        json = await res.json();
      } catch (parseErr) {
        console.error('Failed to parse PhonePe response:', parseErr);
      }

      if (res.ok && json.success && json.redirectUrl) {
        this.launchPhonePeIntent(json.redirectUrl, json.data || { amount: grandTotal });
      } else {
        console.warn('[PhonePe PG Notice] Launching fallback intent:', json);
        this.launchPhonePeIntent(json.redirectUrl || '/api/phonepe/redirect', json.data || { amount: grandTotal });
      }
    } catch (err) {
      console.error('Error initiating PhonePe payment:', err);
      this.launchPhonePeIntent('/api/phonepe/redirect', { amount: grandTotal });
    } finally {
      this.isSubmittingOrder = false;
      payBtns.forEach(btn => {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-bolt-lightning" style="color: #00E676; font-size: 1.2rem;"></i> <span>Pay ₹<span id="phonePeBtnAmount">${grandTotal}</span> with PhonePe</span>`;
      });
    }
  }

  async handlePhonePeCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    if (!urlParams.has('phonepe_callback')) return;

    const txnId = urlParams.get('txnId');
    const statusParam = urlParams.get('status');

    // Clean URL query string without refreshing page
    window.history.replaceState({}, document.title, window.location.pathname);

    if (!txnId || !this.currentUser) return;

    try {
      this.showToast('Verifying transaction with PhonePe...', 'info');
      const res = await this.fetchWithAuth(`${API_BASE}/phonepe/status/${txnId}`);
      const json = await res.json();

      if (json.verified === true && json.status === 'SUCCESS' && json.data) {
        this.cart = [];
        this.tempPaymentScreenshot = null;
        this.updateCartUI();

        this.switchView('secCustomerOrders');
        this.showToast(`🟢 PAYMENT SUCCESSFUL! Order #${json.data.order_number} confirmed with PhonePe.`, 'success');

        const confirmDisplay = document.getElementById('confirmedOrderNumDisplay');
        const confirmBackdrop = document.getElementById('confirmationModalBackdrop');
        if (confirmDisplay) confirmDisplay.innerText = `#${json.data.order_number}`;
        if (confirmBackdrop) confirmBackdrop.classList.add('open');

        await this.fetchOrders();
        await this.fetchNotifications();
      } else if (json.status === 'CANCELLED' || statusParam === 'CANCELLED' || statusParam === 'Cancelled') {
        this.cart = [];
        this.updateCartUI();
        this.switchView('secCustomerOrders');
        this.showToast(`🔴 PAYMENT CANCELLED for Order #${json.data?.order_number || ''}. Click "Pay Again" on your order card to retry.`, 'warning');
        await this.fetchOrders();
      } else if (json.status === 'FAILED' || statusParam === 'FAILED' || statusParam === 'Failed') {
        this.cart = [];
        this.updateCartUI();
        this.switchView('secCustomerOrders');
        this.showToast(`🔴 PAYMENT FAILED for Order #${json.data?.order_number || ''}. Click "Pay Again" on your order card to retry.`, 'error');
        await this.fetchOrders();
      } else {
        this.cart = [];
        this.updateCartUI();
        this.switchView('secCustomerOrders');
        this.showToast(`🟠 PAYMENT PROCESSING for Order #${json.data?.order_number || ''}. You can retry payment anytime.`, 'info');
        await this.fetchOrders();
      }
    } catch (err) {
      console.error('Error verifying PhonePe callback:', err);
      this.switchView('secCustomerOrders');
      this.showToast('Unable to verify PhonePe status. Please check your orders history.', 'error');
      await this.fetchOrders();
    }
  }

  async payAgainPhonePe(orderId) {
    if (!orderId) return;
    if (!this.processingPayAgain) this.processingPayAgain = new Set();
    if (this.processingPayAgain.has(orderId)) return;

    this.processingPayAgain.add(orderId);
    const btn = document.getElementById(`btnPayAgain_${orderId}`);
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Opening PhonePe...`;
    }

    try {
      this.showToast('Initiating PhonePe payment retry...', 'info');
      const res = await this.fetchWithAuth(`${API_BASE}/phonepe/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId })
      });

      let json = {};
      try {
        json = await res.json();
      } catch (parseErr) {
        console.error('Failed to parse PhonePe retry response:', parseErr);
      }

      if (res.ok && json.success && json.redirectUrl) {
        this.launchPhonePeIntent(json.redirectUrl, json.data || {});
      } else {
        const errorMsg = json.message || (res.statusText ? `PhonePe Error (${res.status}: ${res.statusText})` : 'Unable to launch PhonePe payment retry.');
        console.error('[PhonePe Retry Failed]:', json);
        this.showToast(errorMsg, 'error');
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = `<i class="fa-solid fa-rotate-right" style="color: #00E676;"></i> Pay Again`;
        }
      }
    } catch (err) {
      console.error('Error initiating Pay Again:', err);
      this.showToast(err.message || 'Network connection error while contacting PhonePe gateway. Please try again.', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-rotate-right" style="color: #00E676;"></i> Pay Again`;
      }
    } finally {
      this.processingPayAgain.delete(orderId);
    }
  }

  handleProcessingScreenshotSelect(e, orderId) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      this.showToast('Screenshot file size must be less than 5MB', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = (evt) => {
      if (!this.processingScreenshots) this.processingScreenshots = new Map();
      this.processingScreenshots.set(orderId, evt.target.result);
      const fileNameEl = document.getElementById(`procScreenshotName_${orderId}`);
      const btnUpload = document.getElementById(`btnUploadProcScreenshot_${orderId}`);
      if (fileNameEl) fileNameEl.innerText = file.name;
      if (btnUpload) btnUpload.style.display = 'inline-flex';
    };
    reader.readAsDataURL(file);
  }

  async uploadProcessingScreenshot(orderId) {
    if (!this.processingScreenshots || !this.processingScreenshots.has(orderId)) {
      this.showToast('Please select a screenshot file first.', 'error');
      return;
    }
    const b64Data = this.processingScreenshots.get(orderId);
    const btn = document.getElementById(`btnUploadProcScreenshot_${orderId}`);
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Uploading...`;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/orders/${orderId}/processing-screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_screenshot: b64Data })
      });
      const json = await res.json();
      if (json.success) {
        this.showToast('Processing payment screenshot uploaded successfully!', 'success');
        this.processingScreenshots.delete(orderId);
        await this.fetchOrders();
      } else {
        this.showToast(json.message || 'Failed to upload processing screenshot.', 'error');
      }
    } catch (err) {
      console.error('Error uploading processing screenshot:', err);
      this.showToast('Failed to upload screenshot. Please try again.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> Upload Screenshot`;
      }
    }
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
      if (previewImg) {
        previewImg.src = evt.target.result;
        previewImg.style.display = 'block';
      }
      this.showToast('New QR Scanner image loaded! Click Save & Publish All Business Settings to update.', 'info');
    };
    reader.readAsDataURL(file);
  }

  removeOwnerQrScanner() {
    this.tempOwnerQrCode = '';
    this.isQrRemovedFlag = true;
    if (this.settings) {
      this.settings.upi_qr_code = '';
    }
    const previewImg = document.getElementById('setQrPreviewImg');
    if (previewImg) {
      previewImg.src = '';
      previewImg.style.display = 'none';
    }
    const fileInput = document.getElementById('setQrFileInput');
    if (fileInput) fileInput.value = '';
    this.showToast('QR Scanner image removed! Click Save & Publish All Business Settings to confirm.', 'warning');
  }

  copyUpiId() {
    const upiId = document.getElementById('checkoutUpiIdDisplay')?.innerText || '9392974900@ybl';
    navigator.clipboard.writeText(upiId).then(() => {
      this.showToast(`UPI ID "${upiId}" copied to clipboard!`, 'success');
    }).catch(() => {
      this.showToast(`UPI ID: ${upiId}`, 'info');
    });
  }

  zoomCheckoutQrCode() {
    const qrSrc = this.getQrDisplayUrl();
    if (!qrSrc) {
      this.showToast('QR Scanner is not available.', 'warning');
      return;
    }
    this.viewFullScreenshot(qrSrc, 'Official Shop Owner UPI QR Code Scanner');
  }

  toggleLightboxZoom() {
    const img = document.getElementById('lightboxImg');
    if (!img) return;
    const isZoomed = img.classList.contains('zoomed-in');
    img.classList.toggle('zoomed-in', !isZoomed);
    if (!isZoomed) {
      img.style.transform = 'scale(1.6)';
      img.style.cursor = 'zoom-out';
    } else {
      img.style.transform = 'scale(1.0)';
      img.style.cursor = 'zoom-in';
    }
  }

  viewFullScreenshot(src, title = 'Customer Payment Proof') {
    const backdrop = document.getElementById('lightboxModalBackdrop');
    const img = document.getElementById('lightboxImg');
    const titleEl = document.getElementById('lightboxTitle');
    const iconEl = document.getElementById('lightboxIcon');
    const loader = document.getElementById('lightboxLoader');
    const errorBox = document.getElementById('lightboxError');

    if (!src) {
      this.showToast('Image URL is not available.', 'warning');
      return;
    }

    if (img) {
      img.classList.remove('zoomed-in');
      img.style.transform = 'scale(1.0)';
      img.style.cursor = 'zoom-in';
    }

    if (titleEl) titleEl.innerText = title;
    if (iconEl) {
      const isQr = title.toLowerCase().includes('qr') || title.toLowerCase().includes('scanner');
      iconEl.className = isQr ? 'fa-solid fa-qrcode' : 'fa-solid fa-camera';
    }

    if (loader) loader.classList.remove('hidden');
    if (errorBox) errorBox.classList.add('hidden');
    if (img) {
      img.style.display = 'none';
      img.src = src;
    }

    if (backdrop) backdrop.classList.add('open');
  }

  onLightboxImgLoad() {
    const loader = document.getElementById('lightboxLoader');
    const errorBox = document.getElementById('lightboxError');
    const img = document.getElementById('lightboxImg');
    if (loader) loader.classList.add('hidden');
    if (errorBox) errorBox.classList.add('hidden');
    if (img) img.style.display = 'block';
  }

  onLightboxImgError() {
    const loader = document.getElementById('lightboxLoader');
    const errorBox = document.getElementById('lightboxError');
    const img = document.getElementById('lightboxImg');
    if (loader) loader.classList.add('hidden');
    if (img) img.style.display = 'none';
    if (errorBox) errorBox.classList.remove('hidden');
  }

  closeLightbox() {
    const backdrop = document.getElementById('lightboxModalBackdrop');
    const img = document.getElementById('lightboxImg');
    const loader = document.getElementById('lightboxLoader');
    const errorBox = document.getElementById('lightboxError');
    if (backdrop) backdrop.classList.remove('open');
    if (loader) loader.classList.add('hidden');
    if (errorBox) errorBox.classList.add('hidden');
    if (img) {
      img.classList.remove('zoomed-in');
      img.style.transform = 'scale(1.0)';
      img.src = '';
      img.style.display = 'none';
    }
  }

  async verifyOrderPayment(orderId, newStatus, targetBtn = null) {
    const order = this.orders.find(o => o.id === orderId || o.order_number === orderId);
    if (!order) return;

    const key = `pay_${order.id}`;
    if (this.processingOrders.has(key)) return;
    this.processingOrders.add(key);

    if (targetBtn && targetBtn.innerHTML) {
      targetBtn.disabled = true;
      targetBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Verifying...`;
    }

    const prevPayStatus = order.payment_status;
    order.payment_status = newStatus;
    this.renderSingleOrderCard(order.id);

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/orders/${order.id}/payment-verify`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_status: newStatus })
      });
      const json = await res.json();
      if (json.success) {
        if (json.data) {
          Object.assign(order, json.data);
        }
        this.showToast(json.message || 'Payment status updated', 'success');
        this.renderSingleOrderCard(order.id);
      } else {
        order.payment_status = prevPayStatus;
        this.renderSingleOrderCard(order.id);
        this.showToast(json.message || 'Unable to update payment status. Please try again.', 'error');
      }
    } catch (err) {
      console.error('Error verifying payment:', err);
      order.payment_status = prevPayStatus;
      this.renderSingleOrderCard(order.id);
      this.showToast('Unable to update payment status. Please try again.', 'error');
    } finally {
      this.processingOrders.delete(key);
    }
  }

  async verifyPickupPin(orderId, e) {
    if (e) e.preventDefault();
    const pinInput = document.getElementById(`inputPin_${orderId}`);
    const feedbackBox = document.getElementById(`pinFeedback_${orderId}`);
    const btnSubmit = document.getElementById(`btnVerifyPin_${orderId}`);

    const pinVal = pinInput ? pinInput.value.trim() : '';

    if (!pinVal || pinVal.length !== 4 || !/^\d{4}$/.test(pinVal)) {
      const msg = "❌ Incorrect Pickup PIN. Please enter customer's 4-digit Pickup PIN.";
      this.showToast(msg, "error");
      if (feedbackBox) {
        feedbackBox.style.display = 'block';
        feedbackBox.style.color = '#FF5252';
        feedbackBox.innerHTML = `❌ Incorrect Pickup PIN.<br><span style="font-weight: normal; font-size: 0.76rem;">Please ask the customer to provide the correct PIN.</span>`;
      }
      return;
    }

    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Verifying...`;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/orders/${orderId}/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinVal })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || '✅ Pickup PIN Verified', 'success');
        if (feedbackBox) {
          feedbackBox.style.display = 'block';
          feedbackBox.style.color = '#4CAF50';
          feedbackBox.innerHTML = `✅ Pickup PIN Verified • Order Completed`;
        }
        await this.fetchOrders();
      } else {
        const errorMsg = json.message || '❌ Incorrect Pickup PIN. Please ask the customer to provide the correct PIN.';
        this.showToast(errorMsg, 'error');
        if (feedbackBox) {
          feedbackBox.style.display = 'block';
          feedbackBox.style.color = '#FF5252';
          feedbackBox.innerHTML = `❌ Incorrect Pickup PIN.<br><span style="font-weight: normal; font-size: 0.76rem; color: #FFE0B2;">Please ask the customer to provide the correct PIN.</span>`;
        }
      }
    } catch (err) {
      console.error('Error verifying pickup PIN:', err);
      this.showToast('Server error verifying pickup PIN.', 'error');
      if (feedbackBox) {
        feedbackBox.style.display = 'block';
        feedbackBox.style.color = '#FF5252';
        feedbackBox.innerHTML = '❌ Server error verifying pickup PIN.';
      }
    } finally {
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = `<i class="fa-solid fa-shield-check"></i> Verify PIN`;
      }
    }
  }

  openVerifyPinModal(orderId) {
    const order = this.orders.find(o => o.id === orderId || o.order_number === orderId);
    if (!order) return;

    const backdrop = document.getElementById('verifyPinModalBackdrop');
    const orderIdInput = document.getElementById('verifyPinModalOrderId');
    const orderNumEl = document.getElementById('verifyPinModalOrderNum');
    const pinInput = document.getElementById('verifyPinModalInput');
    const feedbackBox = document.getElementById('verifyPinModalFeedback');

    if (orderIdInput) orderIdInput.value = order.id;
    if (orderNumEl) orderNumEl.innerText = `Order #${order.order_number}`;
    if (pinInput) {
      pinInput.value = '';
      pinInput.style.borderColor = 'var(--accent-gold)';
    }
    if (feedbackBox) {
      feedbackBox.style.display = 'none';
      feedbackBox.innerHTML = '';
    }

    if (backdrop) {
      backdrop.classList.add('open');
      setTimeout(() => {
        if (pinInput) pinInput.focus();
      }, 100);
    }
  }

  closeVerifyPinModal() {
    const backdrop = document.getElementById('verifyPinModalBackdrop');
    if (backdrop) backdrop.classList.remove('open');
  }

  async submitModalVerifyPin(e) {
    if (e) e.preventDefault();

    const orderIdInput = document.getElementById('verifyPinModalOrderId');
    const pinInput = document.getElementById('verifyPinModalInput');
    const feedbackBox = document.getElementById('verifyPinModalFeedback');
    const btnSubmit = document.getElementById('btnSubmitModalPin');

    const orderId = orderIdInput ? orderIdInput.value : '';
    const pinVal = pinInput ? pinInput.value.trim() : '';

    if (!pinVal || pinVal.length !== 4 || !/^\d{4}$/.test(pinVal)) {
      const errorMsg = "❌ Incorrect Pickup PIN. Please enter customer's 4-digit Pickup PIN.";
      this.showToast(errorMsg, 'error');
      if (feedbackBox) {
        feedbackBox.style.display = 'block';
        feedbackBox.style.color = '#FF5252';
        feedbackBox.innerHTML = `❌ Incorrect Pickup PIN.<br><span style="font-weight: normal; font-size: 0.78rem;">Please ask the customer to provide the correct 4-digit PIN.</span>`;
      }
      if (pinInput) pinInput.focus();
      return;
    }

    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Verifying...`;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/orders/${orderId}/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinVal })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || '✅ Pickup PIN Verified & Order Completed!', 'success');
        this.closeVerifyPinModal();
        this.closeOrderDetail();
        await this.fetchOrders();
      } else {
        const errorMsg = json.message || '❌ Incorrect Pickup PIN. Please ask the customer to provide the correct PIN.';
        this.showToast(errorMsg, 'error');
        if (feedbackBox) {
          feedbackBox.style.display = 'block';
          feedbackBox.style.color = '#FF5252';
          feedbackBox.innerHTML = `❌ Incorrect Pickup PIN.<br><span style="font-weight: normal; font-size: 0.78rem;">Please ask the customer to provide the correct PIN.</span>`;
        }
        if (pinInput) {
          pinInput.value = '';
          pinInput.focus();
        }
      }
    } catch (err) {
      console.error('Error verifying pickup PIN:', err);
      this.showToast('Server error verifying pickup PIN.', 'error');
      if (feedbackBox) {
        feedbackBox.style.display = 'block';
        feedbackBox.style.color = '#FF5252';
        feedbackBox.innerHTML = `Server error verifying pickup PIN. Please try again.`;
      }
    } finally {
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = `<i class="fa-solid fa-shield-check"></i> Verify & Complete`;
      }
    }
  }

  async submitCustomerOrder(e) {
    e.preventDefault();

    if (this.isSubmittingOrder) return;

    // If customer clicks main submit button while PhonePe subtab is selected, delegate to openPhonePePaymentApp
    if (this.selectedPaymentMethod === 'UPI' && this.selectedOnlineSubOption === 'PhonePe') {
      return this.openPhonePePaymentApp();
    }

    const name = document.getElementById('ordCustomerName').value;
    const mobile = document.getElementById('ordCustomerMobile').value;
    const orderType = document.getElementById('ordType').value;
    const deliveryAddress = document.getElementById('ordDeliveryAddress')?.value.trim();
    const notes = document.getElementById('ordNotes').value;
    const utrNumber = document.getElementById('ordUTRNumber')?.value.trim();

    if (this.selectedPaymentMethod === 'UPI' && this.selectedOnlineSubOption === 'QRPay') {
      if (!this.tempPaymentScreenshot) {
        this.showToast('Please upload your payment screenshot to complete order.', 'error');
        return;
      }
      if (!utrNumber || utrNumber.length < 5) {
        this.showToast('Please enter your 12-digit UTR or Transaction Ref Number.', 'error');
        return;
      }
    }

    const chkWalletUsed = document.getElementById('chkUseWallet')?.checked === true;
    const cartTotals = this.calculateCartTotals ? this.calculateCartTotals() : { grandTotal: 0 };
    const grandTotal = cartTotals.grandTotal || 0;

    let finalUsedWalletAmount = 0;
    let payMethodName = this.selectedPaymentMethod === 'UPI'
      ? (this.selectedOnlineSubOption === 'PhonePe' ? 'UPI (PhonePe)' : 'UPI (QR Pay)')
      : 'Cash';

    if (chkWalletUsed && this.appliedWalletDiscount > 0) {
      finalUsedWalletAmount = this.appliedWalletDiscount;
      if (finalUsedWalletAmount >= grandTotal) {
        payMethodName = 'REFERRAL';
      }
    }

    const payload = {
      customer_name: name,
      customer_mobile: mobile,
      order_type: orderType,
      address_id: this.selectedDeliveryAddressId || null,
      delivery_address: deliveryAddress || (orderType === 'Delivery' ? (this.currentUser ? this.currentUser.address : 'Home Delivery') : 'Counter Pickup'),
      notes: notes,
      payment_method: payMethodName,
      payment_screenshot: this.tempPaymentScreenshot || '',
      utr_number: utrNumber || '',
      used_wallet_amount: finalUsedWalletAmount,
      items: this.cart,
      add_ons: this.getSelectedAddonsPayload ? this.getSelectedAddonsPayload() : []
    };

    this.isSubmittingOrder = true;
    const btnSubmit = document.getElementById('btnCheckoutSubmit');
    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Placing Order...`;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();

      if (json.success) {
        if (json.wallet_balance !== undefined) {
          if (this.currentUser) this.currentUser.wallet_balance = json.wallet_balance;
          if (this.referralStats) this.referralStats.wallet_balance = json.wallet_balance;
        }
        this.cart = [];
        this.selectedCartAddons = {};
        try { localStorage.removeItem('tiffin_selected_addons'); } catch (e) {}
        this.tempPaymentScreenshot = null;
        this.appliedWalletDiscount = 0;
        const chk = document.getElementById('chkUseWallet');
        if (chk) chk.checked = false;
        const breakdownBox = document.getElementById('referralAppliedBreakdown');
        if (breakdownBox) breakdownBox.classList.add('hidden');

        this.updateCartUI();
        this.toggleCheckoutModal(false);

        // Show Celebration Modal with Order Number and Pickup PIN
        document.getElementById('confirmedOrderNumDisplay').innerText = `#${json.data.order_number}`;
        const pinDisp = document.getElementById('confirmedPickupPinDisplay');
        if (pinDisp && json.data.pickup_pin) {
          pinDisp.innerText = json.data.pickup_pin;
        }
        document.getElementById('confirmationModalBackdrop').classList.add('open');

        await this.fetchOrders();
        await this.fetchNotifications();
        await this.fetchReferralStats();
      } else {
        this.showToast(json.message || 'Error placing order.', 'error');
      }
    } catch (err) {
      console.error('Error submitting order:', err);
      this.showToast('Server communication error placing order.', 'error');
    } finally {
      this.isSubmittingOrder = false;
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = `<i class="fa-solid fa-circle-check"></i> <span>Confirm & Place Order (<span id="checkoutGrandTotalDisplay">₹0</span>)</span>`;
        this.updateCartUI();
      }
    }
  }

  async submitPaymentProof(orderId) {
    const screenshotInput = document.getElementById(`proofScreenshotInput_${orderId}`);
    const utrInput = document.getElementById(`proofUtrInput_${orderId}`);

    const utrNumber = utrInput ? utrInput.value.trim() : '';
    const file = screenshotInput && screenshotInput.files ? screenshotInput.files[0] : null;

    if (!utrNumber && !file) {
      this.showToast('Please provide a UTR number or upload a screenshot.', 'warning');
      return;
    }

    let base64Screenshot = null;
    if (file) {
      base64Screenshot = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsDataURL(file);
      });
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/orders/${orderId}/payment-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment_screenshot: base64Screenshot,
          utr_number: utrNumber
        })
      });
      const json = await res.json();
      if (json.success) {
        this.showToast('Payment proof submitted successfully.', 'success');
        await this.fetchOrders();
        await this.fetchPayments();
      } else {
        this.showToast(json.message || 'Failed to submit payment proof.', 'error');
      }
    } catch (err) {
      console.error('Error submitting payment proof:', err);
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

  setOwnerMemberTypeFilter(type) {
    this.ownerMemberTypeFilter = type;
    const btnPrem = document.getElementById('btnFilterMemberPremium');
    const btnReg = document.getElementById('btnFilterMemberRegular');
    if (btnPrem) btnPrem.classList.toggle('active', type === 'PREMIUM');
    if (btnReg) btnReg.classList.toggle('active', type === 'REGULAR');
    this.renderOrders();
  }

  renderSalesAnalytics() {
    if (!this.orders && !this.isLoadingOrders) return;

    const allOrders = this.orders || [];
    const activeOrders = allOrders.filter(o => ['Received', 'Preparing', 'Ready'].includes(o.order_status));
    const completedOrders = allOrders.filter(o => o.order_status === 'Completed');
    const rejectedOrders = allOrders.filter(o => ['Rejected', 'Cancelled'].includes(o.order_status));
    const validOrders = allOrders.filter(o => !['Rejected', 'Cancelled'].includes(o.order_status));

    // Stats values
    const totalSales = validOrders.reduce((acc, o) => acc + (Number(o.net_amount ?? o.total_amount ?? o.grand_total) || 0), 0);
    const avgOrderVal = validOrders.length ? Math.round(totalSales / validOrders.length) : 0;

    // Update KPI grid numbers
    const elTotalOrders = document.getElementById('statTodayOrders');
    const elActiveOrders = document.getElementById('statPendingOrders');
    const elCompletedOrders = document.getElementById('statCompletedOrders');
    const elRejectedOrders = document.getElementById('statRejectedOrders');
    const elTotalSales = document.getElementById('statTodaySales');
    const elAov = document.getElementById('statAovVal');

    if (this.isLoadingOrders && !allOrders.length) {
      if (elTotalOrders) elTotalOrders.innerText = 'Loading...';
      if (elActiveOrders) elActiveOrders.innerText = 'Loading...';
      if (elCompletedOrders) elCompletedOrders.innerText = 'Loading...';
      if (elRejectedOrders) elRejectedOrders.innerText = 'Loading...';
      if (elTotalSales) elTotalSales.innerText = 'Loading...';
      if (elAov) elAov.innerText = 'Loading...';
    } else {
      if (elTotalOrders) elTotalOrders.innerText = allOrders.length;
      if (elActiveOrders) elActiveOrders.innerText = activeOrders.length;
      if (elCompletedOrders) elCompletedOrders.innerText = completedOrders.length;
      if (elRejectedOrders) elRejectedOrders.innerText = rejectedOrders.length;
      if (elTotalSales) elTotalSales.innerText = `₹${totalSales.toLocaleString('en-IN')}`;
      if (elAov) elAov.innerText = `₹${avgOrderVal}`;
    }

    // Update Tab Pill Counts
    const updateCount = (id, count) => {
      const el = document.getElementById(id);
      if (el) el.innerText = this.isLoadingOrders && !allOrders.length ? 'Loading...' : count;
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
        upiTotal += Number(o.net_amount ?? o.total_amount ?? o.grand_total) || 0;
      } else {
        cashTotal += Number(o.net_amount ?? o.total_amount ?? o.grand_total) || 0;
      }
    });

    const grandTotal = upiTotal + cashTotal || 1;
    const upiPct = Math.round((upiTotal / grandTotal) * 100);
    const cashPct = 100 - upiPct;

    const elUpiVal = document.getElementById('upiSalesVal');
    const elCashVal = document.getElementById('cashSalesVal');
    const elUpiBar = document.getElementById('upiSalesBar');
    const elCashBar = document.getElementById('cashSalesBar');

    if (this.isLoadingOrders && !allOrders.length) {
      if (elUpiVal) elUpiVal.innerText = 'Loading...';
      if (elCashVal) elCashVal.innerText = 'Loading...';
    } else {
      if (elUpiVal) elUpiVal.innerText = `₹${upiTotal.toLocaleString('en-IN')}`;
      if (elCashVal) elCashVal.innerText = `₹${cashTotal.toLocaleString('en-IN')}`;
    }
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

  // =========================================================================
  // SEARCH & FILTER ENGINE FOR CUSTOMER & OWNER ORDERS
  // =========================================================================

  setCustomerTabFilter(filter) {
    this.custTabFilter = filter;
    ['ALL', 'PENDING', 'COMPLETED', 'REJECTED'].forEach(f => {
      const btn = document.getElementById(`custTab${f.charAt(0) + f.slice(1).toLowerCase()}`);
      if (btn) btn.classList.toggle('active', f === filter);
    });
    this.renderOrders();
  }

  handleCustomerSearchInput(val) {
    this.custOrderSearch = (val || '').trim().toLowerCase();
    this.renderOrders();
  }

  handleCustomerFilterChange() {
    this.custOrderStatus = document.getElementById('custFilterOrderStatus')?.value || 'ALL';
    this.custPaymentStatus = document.getElementById('custFilterPaymentStatus')?.value || 'ALL';
    this.custPaymentMethod = document.getElementById('custFilterPaymentMethod')?.value || 'ALL';
    this.renderOrders();
  }

  handleCustomerDatePresetChange(val) {
    this.custDatePreset = val;
    const wrapper = document.getElementById('custCustomDateWrapper');
    if (wrapper) wrapper.classList.toggle('hidden', val !== 'CUSTOM');
    this.handleCustomerFilterChange();
  }

  resetCustomerOrderFilters() {
    this.custOrderSearch = '';
    this.custOrderStatus = 'ALL';
    this.custPaymentStatus = 'ALL';
    this.custPaymentMethod = 'ALL';
    this.custDatePreset = 'ALL';

    const inputSearch = document.getElementById('custOrderSearchInput');
    const selStatus = document.getElementById('custFilterOrderStatus');
    const selPayStatus = document.getElementById('custFilterPaymentStatus');
    const selPayMethod = document.getElementById('custFilterPaymentMethod');
    const selPreset = document.getElementById('custFilterDatePreset');
    const startDate = document.getElementById('custFilterStartDate');
    const endDate = document.getElementById('custFilterEndDate');
    const wrapper = document.getElementById('custCustomDateWrapper');

    if (inputSearch) inputSearch.value = '';
    if (selStatus) selStatus.value = 'ALL';
    if (selPayStatus) selPayStatus.value = 'ALL';
    if (selPayMethod) selPayMethod.value = 'ALL';
    if (selPreset) selPreset.value = 'ALL';
    if (startDate) startDate.value = '';
    if (endDate) endDate.value = '';
    if (wrapper) wrapper.classList.add('hidden');

    this.renderOrders();
  }

  handleOwnerSearchInput(val) {
    this.ownerOrderSearch = (val || '').trim().toLowerCase();
    this.renderOrders();
  }

  handleOwnerFilterChange() {
    this.ownerFilterOrderStatus = document.getElementById('ownerFilterOrderStatus')?.value || 'ALL';
    this.ownerFilterPaymentStatus = document.getElementById('ownerFilterPaymentStatus')?.value || 'ALL';
    this.ownerFilterPaymentMethod = document.getElementById('ownerFilterPaymentMethod')?.value || 'ALL';
    this.renderOrders();
  }

  handleOwnerDatePresetChange(val) {
    this.ownerFilterDatePreset = val;
    const wrapper = document.getElementById('ownerCustomDateWrapper');
    if (wrapper) wrapper.classList.toggle('hidden', val !== 'CUSTOM');
    this.handleOwnerFilterChange();
  }

  resetOwnerOrderFilters() {
    this.ownerOrderSearch = '';
    this.ownerFilterOrderStatus = 'ALL';
    this.ownerFilterPaymentStatus = 'ALL';
    this.ownerFilterPaymentMethod = 'ALL';
    this.ownerFilterDatePreset = 'ALL';
    this.ownerOrderFilter = 'ALL';

    const inputSearch = document.getElementById('ownerOrderSearchInput');
    const selStatus = document.getElementById('ownerFilterOrderStatus');
    const selPayStatus = document.getElementById('ownerFilterPaymentStatus');
    const selPayMethod = document.getElementById('ownerFilterPaymentMethod');
    const selPreset = document.getElementById('ownerFilterDatePreset');
    const startDate = document.getElementById('ownerFilterStartDate');
    const endDate = document.getElementById('ownerFilterEndDate');
    const wrapper = document.getElementById('ownerCustomDateWrapper');

    if (inputSearch) inputSearch.value = '';
    if (selStatus) selStatus.value = 'ALL';
    if (selPayStatus) selPayStatus.value = 'ALL';
    if (selPayMethod) selPayMethod.value = 'ALL';
    if (selPreset) selPreset.value = 'ALL';
    if (startDate) startDate.value = '';
    if (endDate) endDate.value = '';
    if (wrapper) wrapper.classList.add('hidden');

    this.setOwnerOrderFilter('ALL');
  }

  parseOrderDate(order) {
    if (!order) return new Date();
    if (order.created_at) {
      const d = new Date(order.created_at);
      if (!isNaN(d.getTime())) return d;
    }
    if (order.date_time) {
      const d = new Date(order.date_time);
      if (!isNaN(d.getTime())) return d;

      // Parse Indian locale format: DD/MM/YYYY, hh:mm:ss am/pm
      const parts = order.date_time.split(',');
      if (parts.length >= 1) {
        const dateParts = parts[0].trim().split('/');
        if (dateParts.length === 3) {
          const day = parseInt(dateParts[0], 10);
          const month = parseInt(dateParts[1], 10) - 1;
          const year = parseInt(dateParts[2], 10);
          const parsed = new Date(year, month, day);
          if (!isNaN(parsed.getTime())) return parsed;
        }
      }
    }
    return new Date();
  }

  filterSingleOrder(order, isOwner) {
    if (!order) return false;

    const rawQuery = isOwner ? this.ownerOrderSearch : this.custOrderSearch;
    const cleanQuery = (rawQuery || '').replace(/^#/, '').trim().toLowerCase();

    const statusFilter = isOwner ? this.ownerFilterOrderStatus : this.custOrderStatus;
    const payStatusFilter = isOwner ? this.ownerFilterPaymentStatus : this.custPaymentStatus;
    const payMethodFilter = isOwner ? this.ownerFilterPaymentMethod : this.custPaymentMethod;
    const datePreset = isOwner ? this.ownerFilterDatePreset : this.custDatePreset;
    const startDateVal = isOwner ? document.getElementById('ownerFilterStartDate')?.value : document.getElementById('custFilterStartDate')?.value;
    const endDateVal = isOwner ? document.getElementById('ownerFilterEndDate')?.value : document.getElementById('custFilterEndDate')?.value;

    // 1. Keyword Search (Case-Insensitive & Trimmed)
    if (cleanQuery) {
      const orderNum = (order.order_number || '').toString().toLowerCase();
      const custName = (order.customer_name || '').toString().toLowerCase();
      const custMobile = (order.customer_mobile || '').toString().toLowerCase();
      const cleanMobile = custMobile.replace(/[^0-9]/g, '');
      const cleanQueryDigits = cleanQuery.replace(/[^0-9]/g, '');

      const utrNum = (order.utr_number || '').toString().toLowerCase();
      const txnId = (order.transaction_id || '').toString().toLowerCase();
      const dateTime = (order.date_time || order.created_at || '').toString().toLowerCase();
      const itemsStr = (order.items || []).map(i => i.name).join(' ').toLowerCase();

      const matchOrderNum = orderNum.includes(cleanQuery) || (`tf${orderNum}`).includes(cleanQuery);
      const matchCustName = isOwner && custName.includes(cleanQuery);
      const matchMobile = isOwner && (custMobile.includes(cleanQuery) || (cleanQueryDigits.length >= 4 && cleanMobile.includes(cleanQueryDigits)));
      const matchUtr = utrNum.includes(cleanQuery) || txnId.includes(cleanQuery);
      const matchDate = dateTime.includes(cleanQuery);
      const matchItems = itemsStr.includes(cleanQuery);

      if (!matchOrderNum && !matchCustName && !matchMobile && !matchUtr && !matchDate && !matchItems) {
        return false;
      }
    }

    // 2. Order Status Filter
    if (statusFilter && statusFilter !== 'ALL') {
      const ordStat = (order.order_status || '').toLowerCase();
      const reqStat = statusFilter.toLowerCase();
      if (reqStat === 'received') {
        if (!['received', 'pending'].includes(ordStat)) return false;
      } else if (reqStat === 'completed') {
        if (!['completed', 'delivered'].includes(ordStat)) return false;
      } else {
        if (ordStat !== reqStat) return false;
      }
    }

    // 3. Payment Status Filter
    if (payStatusFilter && payStatusFilter !== 'ALL') {
      const payStat = (order.payment_status || '').toLowerCase();
      const reqPayStat = payStatusFilter.toLowerCase();
      if (reqPayStat === 'referral') {
        if (!payStat.includes('referral') && (order.payment_method || '').toLowerCase() !== 'referral') return false;
      } else if (reqPayStat === 'paid') {
        if (!['paid', 'verified'].includes(payStat)) return false;
      } else if (reqPayStat === 'pending verification') {
        if (!['pending verification', 'pending_verification'].includes(payStat)) return false;
      } else {
        if (!payStat.includes(reqPayStat)) return false;
      }
    }

    // 4. Payment Method Filter
    if (payMethodFilter && payMethodFilter !== 'ALL') {
      const payMethod = (order.payment_method || '').toLowerCase();
      const reqMethod = payMethodFilter.toLowerCase();
      if (reqMethod === 'referral') {
        if (!payMethod.includes('referral') && (order.payment_status || '').toLowerCase() !== 'referral') return false;
      } else if (reqMethod === 'upi') {
        if (!payMethod.includes('upi') && !payMethod.includes('qr') && !payMethod.includes('phonepe') && !payMethod.includes('online')) return false;
      } else if (reqMethod === 'qrpay') {
        if (!payMethod.includes('qr')) return false;
      } else if (reqMethod === 'phonepe') {
        if (!payMethod.includes('phonepe')) return false;
      } else if (reqMethod === 'cash') {
        if (!payMethod.includes('cash')) return false;
      }
    }

    // 5. Date Preset Filter
    if (datePreset && datePreset !== 'ALL') {
      const orderDate = this.parseOrderDate(order);
      const now = new Date();
      const todayStr = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

      if (datePreset === 'TODAY') {
        const orderDayStr = new Date(orderDate.getFullYear(), orderDate.getMonth(), orderDate.getDate()).getTime();
        if (orderDayStr !== todayStr) return false;
      } else if (datePreset === 'YESTERDAY') {
        const yesterdayStr = todayStr - 86400000;
        const orderDayStr = new Date(orderDate.getFullYear(), orderDate.getMonth(), orderDate.getDate()).getTime();
        if (orderDayStr !== yesterdayStr) return false;
      } else if (datePreset === 'LAST_7_DAYS') {
        const sevenDaysAgo = Date.now() - (7 * 86400000);
        if (orderDate.getTime() < sevenDaysAgo) return false;
      } else if (datePreset === 'LAST_30_DAYS') {
        const thirtyDaysAgo = Date.now() - (30 * 86400000);
        if (orderDate.getTime() < thirtyDaysAgo) return false;
      } else if (datePreset === 'CUSTOM') {
        if (startDateVal) {
          const startMs = new Date(startDateVal).setHours(0, 0, 0, 0);
          if (orderDate.getTime() < startMs) return false;
        }
        if (endDateVal) {
          const endMs = new Date(endDateVal).setHours(23, 59, 59, 999);
          if (orderDate.getTime() > endMs) return false;
        }
      }
    }

    return true;
  }

  renderOrders() {
    if (this.currentRole === 'CUSTOMER') {
      const container = document.getElementById('customerOrdersList');
      if (!container) return;

      const allOrders = this.orders || [];
      const pendingOrdersCount = allOrders.filter(o => ['Received', 'Pending', 'Preparing', 'Ready'].includes(o.order_status)).length;
      const completedOrdersCount = allOrders.filter(o => ['Completed', 'Delivered'].includes(o.order_status)).length;
      const rejectedOrdersCount = allOrders.filter(o => ['Rejected', 'Cancelled'].includes(o.order_status)).length;

      const cntAll = document.getElementById('custCountAll');
      const cntPending = document.getElementById('custCountPending');
      const cntCompleted = document.getElementById('custCountCompleted');
      const cntRejected = document.getElementById('custCountRejected');

      if (cntAll) cntAll.innerText = allOrders.length;
      if (cntPending) cntPending.innerText = pendingOrdersCount;
      if (cntCompleted) cntCompleted.innerText = completedOrdersCount;
      if (cntRejected) cntRejected.innerText = rejectedOrdersCount;

      ['ALL', 'PENDING', 'COMPLETED', 'REJECTED'].forEach(f => {
        const btn = document.getElementById(`custTab${f.charAt(0) + f.slice(1).toLowerCase()}`);
        if (btn) btn.classList.toggle('active', f === this.custTabFilter);
      });

      if (this.isLoadingOrders && !allOrders.length) {
        container.innerHTML = `
          <div style="text-align: center; padding: 4rem 1rem; color: var(--text-muted); background: var(--bg-surface); border-radius: var(--radius-lg); border: 1.5px dashed var(--border-color);">
            <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: var(--accent-gold); margin-bottom: 1rem;"></i>
            <h3 style="color: var(--text-main); font-size: 1.1rem; margin-bottom: 0.5rem;">Loading Your Orders...</h3>
            <p style="font-size: 0.85rem;">Fetching database records...</p>
          </div>`;
        return;
      }

      if (!allOrders.length) {
        container.innerHTML = `
          <div style="text-align: center; padding: 4rem 1rem; color: var(--text-muted); background: var(--bg-surface); border-radius: var(--radius-lg); border: 1.5px dashed var(--border-color);">
            <div style="width: 70px; height: 70px; border-radius: 50%; background: rgba(234, 162, 33, 0.15); color: var(--accent-gold); display: flex; align-items: center; justify-content: center; font-size: 2rem; margin: 0 auto 1rem auto;">
              <i class="fa-solid fa-receipt"></i>
            </div>
            <h3 style="color: var(--text-main); font-size: 1.2rem; margin-bottom: 0.5rem;">You haven't placed any orders yet.</h3>
            <p style="font-size: 0.9rem; max-width: 400px; margin: 0 auto 1.25rem auto;">Explore our hot, fresh South Indian tiffins menu and place your order!</p>
            <button class="btn-primary-block" onclick="app.switchView('secCustomerHome')" style="max-width: 220px; margin: 0 auto;">
              <i class="fa-solid fa-utensils"></i> Browse Today's Menu
            </button>
          </div>`;
        return;
      }

      // Filter by Tab (ALL / PENDING / COMPLETED / REJECTED)
      let tabFilteredOrders = allOrders;
      if (this.custTabFilter === 'PENDING') {
        tabFilteredOrders = allOrders.filter(o => ['Received', 'Pending', 'Preparing', 'Ready'].includes(o.order_status));
      } else if (this.custTabFilter === 'COMPLETED') {
        tabFilteredOrders = allOrders.filter(o => ['Completed', 'Delivered'].includes(o.order_status));
      } else if (this.custTabFilter === 'REJECTED') {
        tabFilteredOrders = allOrders.filter(o => ['Rejected', 'Cancelled'].includes(o.order_status));
      }

      // Tab Empty State handling when customer has orders overall, but 0 in selected tab
      if (!tabFilteredOrders.length) {
        let emptyTitle = "You haven't placed any orders yet.";
        let emptySub = "Explore our hot, fresh South Indian tiffins menu and place your order!";

        if (this.custTabFilter === 'PENDING') {
          emptyTitle = "You don't have any pending orders.";
          emptySub = "All your past orders have been completed or processed.";
        } else if (this.custTabFilter === 'COMPLETED') {
          emptyTitle = "You don't have any completed orders yet.";
          emptySub = "Your completed order history will appear here once delivered.";
        } else if (this.custTabFilter === 'REJECTED') {
          emptyTitle = "You don't have any rejected orders.";
          emptySub = "Any cancelled or rejected orders will appear here.";
        }

        container.innerHTML = `
          <div style="text-align: center; padding: 3.5rem 1rem; color: var(--text-muted); background: var(--bg-surface); border-radius: var(--radius-lg); border: 1.5px dashed var(--border-color);">
            <div style="width: 65px; height: 65px; border-radius: 50%; background: rgba(234, 162, 33, 0.15); color: var(--accent-gold); display: flex; align-items: center; justify-content: center; font-size: 1.8rem; margin: 0 auto 1rem auto;">
              <i class="fa-solid ${this.custTabFilter === 'PENDING' ? 'fa-hourglass-half' : this.custTabFilter === 'COMPLETED' ? 'fa-circle-check' : this.custTabFilter === 'REJECTED' ? 'fa-circle-xmark' : 'fa-receipt'}"></i>
            </div>
            <h3 style="color: var(--text-main); font-size: 1.15rem; margin-bottom: 0.4rem;">${emptyTitle}</h3>
            <p style="font-size: 0.88rem; max-width: 400px; margin: 0 auto 1.25rem auto;">${emptySub}</p>
            <button class="btn-primary-block" onclick="app.switchView('secCustomerHome')" style="max-width: 220px; margin: 0 auto;">
              <i class="fa-solid fa-utensils"></i> Browse Today's Menu
            </button>
          </div>`;
        return;
      }

      // Filter Customer Orders by Search / Dropdowns
      const filteredCustomerOrders = tabFilteredOrders.filter(o => this.filterSingleOrder(o, false));

      if (!filteredCustomerOrders.length) {
        container.innerHTML = `
          <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted); background: var(--bg-surface); border-radius: var(--radius-lg); border: 1.5px dashed var(--border-color);">
            <div style="width: 60px; height: 60px; border-radius: 50%; background: rgba(255,255,255,0.05); color: var(--accent-gold); display: flex; align-items: center; justify-content: center; font-size: 1.6rem; margin: 0 auto 1rem auto;">
              <i class="fa-solid fa-magnifying-glass"></i>
            </div>
            <h3 style="color: var(--text-main); font-size: 1.1rem; margin-bottom: 0.4rem;">No matching orders found</h3>
            <p style="font-size: 0.85rem; max-width: 380px; margin: 0 auto;">No order matches your current search query or filter settings.</p>
          </div>`;
        return;
      }

      // Sort Customer Orders: newest first (created_at / date_time DESC)
      const sortedCustomerOrders = [...filteredCustomerOrders].sort((a, b) => {
        return this.parseOrderDate(b).getTime() - this.parseOrderDate(a).getTime();
      });

      container.innerHTML = sortedCustomerOrders.map(order => {
        return this.createCustomerOrderCardHTML(order);
      }).join('');
    } else {
      // First update sales analytics & KPI numbers
      this.renderSalesAnalytics();

      // Apply owner order tab filter
      let filtered = this.orders;
      if (this.ownerOrderFilter === 'ACTIVE') {
        filtered = this.orders.filter(o => ['Received', 'Preparing', 'Ready'].includes(o.order_status));
      } else if (this.ownerOrderFilter === 'COMPLETED') {
        filtered = this.orders.filter(o => o.order_status === 'Completed');
      } else if (this.ownerOrderFilter === 'REJECTED') {
        filtered = this.orders.filter(o => ['Rejected', 'Cancelled'].includes(o.order_status));
      }

      // Apply owner member type filter (ALL / PREMIUM / REGULAR)
      if (this.ownerMemberTypeFilter === 'PREMIUM') {
        filtered = filtered.filter(o => Boolean(o.is_premium_member || (o.food_member_discount && Number(o.food_member_discount) > 0)));
      } else if (this.ownerMemberTypeFilter === 'REGULAR') {
        filtered = filtered.filter(o => !o.is_premium_member && (!o.food_member_discount || Number(o.food_member_discount) === 0));
      }

      // Apply owner search & multi-filter controls
      filtered = filtered.filter(o => this.filterSingleOrder(o, true));

      const emptyMsg = (this.ownerOrderSearch || this.ownerFilterOrderStatus !== 'ALL' || this.ownerFilterPaymentStatus !== 'ALL' || this.ownerFilterPaymentMethod !== 'ALL' || this.ownerFilterDatePreset !== 'ALL' || (this.ownerMemberTypeFilter && this.ownerMemberTypeFilter !== 'ALL'))
        ? 'No matching orders found for your search and filter criteria.'
        : (this.ownerOrderFilter === 'ALL' ? 'No orders found.' : `No ${this.ownerOrderFilter.toLowerCase()} orders found.`);

      // Owner Dashboard Orders List
      const dashContainer = document.getElementById('ownerDashboardOrdersList');
      if (dashContainer) {
        if (this.isLoadingOrders && !filtered.length) {
          dashContainer.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-muted); background: var(--bg-surface-elevated); border-radius: var(--radius-md); border: 1px dashed var(--border-color);"><i class="fa-solid fa-spinner fa-spin" style="margin-right: 8px;"></i>Loading orders...</div>`;
        } else if (!filtered.length) {
          dashContainer.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-muted); background: var(--bg-surface-elevated); border-radius: var(--radius-md); border: 1px dashed var(--border-color);">${emptyMsg}</div>`;
        } else {
          dashContainer.innerHTML = filtered.map(order => this.createOwnerOrderCardHTML(order)).join('');
        }
      }

      // Owner All Orders Management Page
      const listContainer = document.getElementById('ownerOrdersList');
      if (listContainer) {
        if (this.isLoadingOrders && !filtered.length) {
          listContainer.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-muted); background: var(--bg-surface-elevated); border-radius: var(--radius-md); border: 1px dashed var(--border-color);"><i class="fa-solid fa-spinner fa-spin" style="margin-right: 8px;"></i>Loading orders...</div>`;
        } else if (!filtered.length) {
          listContainer.innerHTML = `
            <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted); background: var(--bg-surface-elevated); border-radius: var(--radius-lg); border: 1.5px dashed var(--border-color);">
              <div style="width: 60px; height: 60px; border-radius: 50%; background: rgba(234, 162, 33, 0.15); color: var(--accent-gold); display: flex; align-items: center; justify-content: center; font-size: 1.6rem; margin: 0 auto 1rem auto;">
                <i class="fa-solid fa-magnifying-glass"></i>
              </div>
              <h3 style="color: #FFF; font-size: 1.1rem;">${emptyMsg}</h3>
            </div>`;
        } else {
          listContainer.innerHTML = filtered.map(order => this.createOwnerOrderCardHTML(order)).join('');
        }
      }
    }
  }

  async fetchQueueProgress() {
    if (!this.currentUser || this.currentRole !== 'CUSTOMER') return;
    try {
      const res = await fetch(`${API_BASE}/customer/queue-progress`, {
        headers: this.authToken ? {
          'Authorization': `Bearer ${this.authToken}`,
          'X-Auth-Token': this.authToken
        } : {}
      });
      const json = await res.json();
      if (json && json.success) {
        this.renderQueueProgressUI(json.data);
      } else {
        this.renderQueueProgressUI({ has_active_order: false });
      }
    } catch (err) {
      console.error('Error fetching queue progress:', err);
      this.renderQueueProgressUI({ has_active_order: false });
    }
  }

  renderQueueProgressUI(data) {
    const container = document.getElementById('queueProgressContainer');
    if (!container) return;

    if (!data || !data.has_active_order) {
      container.innerHTML = `
        <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-lg, 16px); padding: 3rem 1.5rem; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.25);">
          <div style="font-size: 3.5rem; margin-bottom: 1rem;">🎟️</div>
          <h3 style="font-size: 1.25rem; font-weight: 800; color: #FFF; margin-bottom: 0.5rem;">Queue Progress</h3>
          <p style="color: var(--text-muted); font-size: 0.92rem; margin-bottom: 1.5rem;">You don't have an active order in the queue.</p>
          <button type="button" class="btn-primary-block" onclick="app.switchView('secCustomerHome'); app.scrollToMenu();" style="max-width: 260px; margin: 0 auto; display: inline-flex; align-items: center; justify-content: center; gap: 8px; font-weight: 800; font-size: 0.95rem; padding: 12px 24px; border-radius: 12px; background: linear-gradient(135deg, var(--primary), var(--accent-gold)); color: #000; border: none; cursor: pointer;">
            <i class="fa-solid fa-utensils"></i> 🍽️ View Today's Menu
          </button>
        </div>
      `;
      return;
    }

    const {
      customer_token,
      order_id,
      order_number,
      order_status,
      pickup_pin,
      currently_serving_token,
      orders_ahead,
      active_queue_list
    } = data;

    let statusBannerHtml = '';
    if (order_status === 'Preparing') {
      statusBannerHtml = `
        <div style="background: linear-gradient(135deg, rgba(234, 162, 33, 0.2), rgba(255, 179, 0, 0.1)); border: 1.5px solid var(--accent-gold); border-radius: 14px; padding: 1rem 1.25rem; margin-bottom: 1.5rem; text-align: center;">
          <h4 style="margin: 0 0 4px 0; color: var(--accent-gold); font-size: 1.05rem; font-weight: 800; display: flex; align-items: center; justify-content: center; gap: 8px;">
            🎉 Your order is now being prepared!
          </h4>
          <p style="margin: 0; font-size: 0.85rem; color: #FFF;">The chef is currently cooking your hot & fresh South Indian tiffins.</p>
        </div>
      `;
    } else if (order_status === 'Ready') {
      statusBannerHtml = `
        <div style="background: linear-gradient(135deg, rgba(76, 175, 80, 0.25), rgba(46, 125, 50, 0.15)); border: 1.5px solid #4CAF50; border-radius: 14px; padding: 1rem 1.25rem; margin-bottom: 1.5rem; text-align: center;">
          <h4 style="margin: 0 0 6px 0; color: #4CAF50; font-size: 1.1rem; font-weight: 800; display: flex; align-items: center; justify-content: center; gap: 8px;">
            🟢 Your order is ready!
          </h4>
          <p style="margin: 0 0 8px 0; font-size: 0.88rem; color: #FFF;">Please present your Pickup PIN at the counter to collect your order.</p>
          ${pickup_pin ? `<div style="display: inline-block; background: #4CAF50; color: #000; font-weight: 900; font-size: 1.2rem; letter-spacing: 3px; padding: 4px 16px; border-radius: 8px;">PIN: ${pickup_pin}</div>` : ''}
        </div>
      `;
    } else {
      statusBannerHtml = `
        <div style="background: rgba(41, 182, 246, 0.12); border: 1px solid rgba(41, 182, 246, 0.3); border-radius: 14px; padding: 0.9rem 1.25rem; margin-bottom: 1.5rem; text-align: center;">
          <h4 style="margin: 0 0 4px 0; color: #29B6F6; font-size: 0.98rem; font-weight: 800;">
            ⏳ Order Received & Queued
          </h4>
          <p style="margin: 0; font-size: 0.82rem; color: var(--text-muted);">Your order is queued in kitchen position #${orders_ahead + 1}.</p>
        </div>
      `;
    }

    // Visual Queue Progress Bar / Timeline
    let timelineDotsHtml = '';
    if (active_queue_list && active_queue_list.length > 0) {
      timelineDotsHtml = `
        <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 14px; padding: 1.25rem 1rem; margin-bottom: 1.5rem;">
          <div style="font-size: 0.78rem; font-weight: 700; color: var(--text-muted); margin-bottom: 1rem; text-transform: uppercase; letter-spacing: 0.5px; text-align: center;">
            <i class="fa-solid fa-layer-group"></i> Active Kitchen Queue Sequence
          </div>
          <div style="display: flex; align-items: center; justify-content: center; gap: 8px; overflow-x: auto; padding: 8px 4px; -webkit-overflow-scrolling: touch;">
            ${active_queue_list.map((item, index) => `
              <div style="display: flex; flex-direction: column; align-items: center; min-width: 68px; flex-shrink: 0;">
                <div style="width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 0.78rem; margin-bottom: 6px; ${
                  item.is_customer 
                    ? 'background: linear-gradient(135deg, var(--primary), var(--accent-gold)); color: #000; box-shadow: 0 0 12px rgba(255, 179, 0, 0.6); border: 2px solid #FFF;' 
                    : item.status === 'Preparing' 
                      ? 'background: rgba(234, 162, 33, 0.25); color: var(--accent-gold); border: 1.5px solid var(--accent-gold);' 
                      : 'background: rgba(255, 255, 255, 0.08); color: var(--text-muted); border: 1px solid var(--border-color);'
                }">
                  ${item.token}
                </div>
                <span style="font-size: 0.68rem; font-weight: 700; color: ${item.is_customer ? 'var(--accent-gold)' : 'var(--text-muted)'}; white-space: nowrap;">
                  ${item.is_customer ? '⭐ YOU' : (item.status === 'Preparing' ? 'Serving' : 'Queued')}
                </span>
              </div>
              ${index < active_queue_list.length - 1 ? '<div style="height: 2px; width: 16px; background: var(--border-color); flex-shrink: 0; margin-bottom: 18px;"></div>' : ''}
            `).join('')}
          </div>
        </div>
      `;
    }

    container.innerHTML = `
      ${statusBannerHtml}

      <!-- Main Queue Metrics Cards Grid -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
        
        <!-- 1. Customer's Token -->
        <div style="background: linear-gradient(135deg, rgba(255, 87, 34, 0.15), rgba(255, 179, 0, 0.08)); border: 2px solid var(--primary); border-radius: 16px; padding: 1.25rem; text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,0.3); position: relative; overflow: hidden;">
          <div style="position: absolute; top: 8px; right: 12px; font-size: 0.68rem; font-weight: 800; background: var(--primary); color: #FFF; padding: 2px 8px; border-radius: 10px;">YOUR ORDER</div>
          <div style="font-size: 0.8rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">
            🎟️ Your Token
          </div>
          <div style="font-size: 2.2rem; font-weight: 900; color: var(--accent-gold); letter-spacing: 1px; margin-bottom: 4px;">
            ${customer_token}
          </div>
          <div style="font-size: 0.78rem; color: var(--text-muted); font-weight: 700;">
            Order ID: #${order_number}
          </div>
        </div>

        <!-- 2. Currently Serving -->
        <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-color); border-radius: 16px; padding: 1.25rem; text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,0.25);">
          <div style="font-size: 0.8rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">
            🍳 Currently Serving
          </div>
          <div style="font-size: 2.2rem; font-weight: 900; color: #FFF; letter-spacing: 1px; margin-bottom: 4px;">
            ${currently_serving_token}
          </div>
          <div style="font-size: 0.78rem; color: var(--accent-gold); font-weight: 700;">
            Kitchen Active Order
          </div>
        </div>

        <!-- 3. Orders Ahead of You -->
        <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-color); border-radius: 16px; padding: 1.25rem; text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,0.25);">
          <div style="font-size: 0.8rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">
            👥 Orders Ahead of You
          </div>
          <div style="font-size: 2.2rem; font-weight: 900; color: ${orders_ahead === 0 ? '#4CAF50' : 'var(--accent-gold)'}; letter-spacing: 1px; margin-bottom: 4px;">
            ${orders_ahead}
          </div>
          <div style="font-size: 0.78rem; color: var(--text-muted); font-weight: 700;">
            ${orders_ahead === 0 ? '🎉 You are next in line!' : 'Active Orders Preceding'}
          </div>
        </div>

        <!-- 4. Live Preparation Time -->
        ${(() => {
          const prepInfo = this.getPrepTimerDetails(data.estimated_ready_at, data.order_status);
          return `
            <div style="background: linear-gradient(135deg, rgba(234, 162, 33, 0.15), rgba(217, 83, 30, 0.08)); border: 1.5px solid var(--accent-gold); border-radius: 16px; padding: 1.25rem; text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,0.25);">
              <div style="font-size: 0.8rem; font-weight: 800; color: var(--accent-gold); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">
                ⏱️ Estimated Ready
              </div>
              <div class="live-prep-timer-val" data-ready-at="${data.estimated_ready_at || ''}" data-status="${data.order_status}" data-order-id="${data.order_id || ''}" style="font-size: 1.9rem; font-weight: 900; color: #FFF; letter-spacing: 0.5px; margin-bottom: 4px;">
                ${prepInfo.text}
              </div>
              <div id="prepExpectedTime_${data.order_id || ''}" style="font-size: 0.78rem; color: var(--accent-gold); font-weight: 700;">
                🕘 Expected by ${prepInfo.expectedStr}
              </div>
            </div>
          `;
        })()}

      </div>

      ${timelineDotsHtml}

      <!-- Order Details Footer Quick Action -->
      <div style="text-align: center; margin-top: 1rem;">
        <button type="button" class="co-row-btn view" onclick="app.switchView('secCustomerOrders')" style="max-width: 240px; margin: 0 auto; padding: 10px 20px; font-weight: 800; font-size: 0.85rem;">
          <i class="fa-solid fa-receipt"></i> View My Orders History
        </button>
      </div>
    `;
  }


  getPremiumHighlightDetails(order) {
    if (!order) return { isHighlight: false, remainingDaysText: '' };

    const wasPlacedAsPremium = Boolean(order.is_premium_member || (order.food_member_discount && Number(order.food_member_discount) > 0));
    if (!wasPlacedAsPremium) {
      return { isHighlight: false, remainingDaysText: '' };
    }

    const validUntilStr = order.customer_card_valid_until || order.valid_until;
    const validFromStr = order.customer_card_valid_from || order.valid_from;

    if (!validUntilStr) {
      return { isHighlight: false, remainingDaysText: '' };
    }

    const now = new Date();
    const validUntil = new Date(validUntilStr);
    const validFrom = validFromStr ? new Date(validFromStr) : null;

    let validUntilEnd = new Date(validUntil);
    if (typeof validUntilStr === 'string' && validUntilStr.length <= 10) {
      validUntilEnd.setHours(23, 59, 59, 999);
    }

    if (validFrom && now < validFrom) {
      return { isHighlight: false, remainingDaysText: '' };
    }

    if (now > validUntilEnd) {
      return { isHighlight: false, remainingDaysText: '' };
    }

    const parseDateParts = (input) => {
      const d = new Date(input);
      if (isNaN(d.getTime())) return null;
      if (typeof input === 'string' && input.includes('T')) {
        const parts = input.split('T')[0].split('-');
        if (parts.length === 3) {
          return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        }
      }
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    };

    const todayStart = parseDateParts(now);
    const untilStart = parseDateParts(validUntilStr);

    const diffMs = (untilStart ? untilStart.getTime() : 0) - (todayStart ? todayStart.getTime() : 0);
    const daysDiff = Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));

    const dayLabel = daysDiff === 1 ? 'day' : 'days';
    const remainingDaysText = `🟢 ${daysDiff} ${dayLabel} remaining`;

    return {
      isHighlight: true,
      daysRemaining: daysDiff,
      remainingDaysText: remainingDaysText
    };
  }

  createOwnerOrderCardHTML(order) {
    const dateFormatted = new Date(order.created_at).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    const isCancelled = order.order_status === 'Cancelled' || order.order_status === 'CUSTOMER_CANCELLED';
    const isRejected = order.order_status === 'Rejected' || order.order_status === 'OWNER_REJECTED';
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
    if (isCancelled) { statusColor = '#FF9800'; statusIcon = 'fa-triangle-exclamation'; statusLabel = '🟠 Customer Cancelled'; }
    else if (isRejected) { statusColor = '#E53935'; statusIcon = 'fa-circle-xmark'; statusLabel = '🔴 Owner Rejected'; }

    let stepIdx = 0;
    if (isPreparing) stepIdx = 1;
    if (isReady) stepIdx = 2;
    if (isCompleted) stepIdx = 3;
    const progressPct = Math.round((stepIdx / 3) * 100);

    const typeIcon = order.order_type === 'Takeaway' ? 'fa-box' : order.order_type === 'Delivery' ? 'fa-motorcycle' : 'fa-utensils';
    const isReferralPay = (order.payment_status || '').toUpperCase() === 'REFERRAL' || (order.payment_method || '').toUpperCase() === 'REFERRAL';
    const isPaid = order.payment_status.includes('Paid') || order.payment_status.includes('Verified');
    const isPendingPayment = order.payment_status.includes('Pending') || order.payment_status.includes('Verification');

    const premInfo = this.getPremiumHighlightDetails(order);

    return `
      <div class="co-row-card owner-mode ${isCancelled ? 'is-customer-cancelled' : isRejected ? 'is-owner-rejected' : ''} ${premInfo.isHighlight ? 'card-order-premium' : ''}" data-order-card-id="${order.id}">
        ${isCancelled ? `
          <!-- CUSTOMER CANCELLED BANNER (ORANGE) -->
          <div style="background: rgba(255, 152, 0, 0.14); border: 1.5px solid #FF9800; padding: 12px 16px; border-radius: var(--radius-md); color: #FFE0B2; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 0.25rem;">
            <div style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 250px;">
              <i class="fa-solid fa-triangle-exclamation" style="font-size: 1.4rem; color: #FF9800; flex-shrink: 0;"></i>
              <div style="word-break: break-word; overflow-wrap: break-word;">
                <strong style="font-size: 0.95rem; color: #FFF; display: block; margin-bottom: 2px;">🟠 Customer Cancelled</strong>
                <span style="font-size: 0.84rem; color: #FFE0B2; font-weight: 600;">
                  <strong>Cancellation Reason:</strong> ${order.cancellation_reason || 'Ordered by mistake'}
                </span>
              </div>
            </div>
            <div style="display: flex; gap: 8px;">
              <button type="button" class="btn-sm-status" onclick="app.restoreRejectedOrder('${order.id}', this)" style="background: rgba(255, 152, 0, 0.25); color: #FFB74D; border: 1px solid #FF9800; padding: 6px 14px; border-radius: 6px; font-weight: 800; font-size: 0.78rem; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
                <i class="fa-solid fa-rotate-left"></i> Restore Order
              </button>
              <button type="button" class="btn-sm-status" onclick="app.deleteOrder('${order.id}', this)" style="background: rgba(229,57,53,0.25); color: #FF5252; border: 1px solid rgba(229,57,53,0.5); padding: 6px 14px; border-radius: 6px; font-weight: 800; font-size: 0.78rem; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;" title="Permanently delete from database history">
                <i class="fa-solid fa-trash-can"></i> Delete
              </button>
            </div>
          </div>
        ` : isRejected ? `
          <!-- OWNER REJECTED BANNER (RED) -->
          <div style="background: rgba(229, 57, 53, 0.14); border: 1.5px solid #E53935; padding: 12px 16px; border-radius: var(--radius-md); color: #FF5252; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 0.25rem;">
            <div style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 250px;">
              <i class="fa-solid fa-circle-xmark" style="font-size: 1.4rem; color: #E53935; flex-shrink: 0;"></i>
              <div style="word-break: break-word; overflow-wrap: break-word;">
                <strong style="font-size: 0.95rem; color: #FFF; display: block; margin-bottom: 2px;">🔴 Owner Rejected</strong>
                <span style="font-size: 0.84rem; color: #FF8A80; font-weight: 600;">
                  <strong>Rejection Reason:</strong> ${order.rejection_reason || 'Item unavailable'}
                </span>
              </div>
            </div>
            <div style="display: flex; gap: 8px;">
              <button type="button" class="btn-sm-status" onclick="app.restoreRejectedOrder('${order.id}', this)" style="background: rgba(76, 175, 80, 0.25); color: #4CAF50; border: 1px solid #4CAF50; padding: 6px 14px; border-radius: 6px; font-weight: 800; font-size: 0.78rem; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
                <i class="fa-solid fa-rotate-left"></i> Restore / Accept Order
              </button>
              <button type="button" class="btn-sm-status" onclick="app.deleteOrder('${order.id}', this)" style="background: rgba(229,57,53,0.25); color: #FF5252; border: 1px solid rgba(229,57,53,0.5); padding: 6px 14px; border-radius: 6px; font-weight: 800; font-size: 0.78rem; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;" title="Permanently delete from database history">
                <i class="fa-solid fa-trash-can"></i> Delete Permanently
              </button>
            </div>
          </div>
        ` : ''}

        <!-- 1. TOP HEADER BAR: Order #, Customer Contact, Date, Badges & Grand Total -->
        <div class="co-card-top-bar">
          <div class="co-top-left" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span class="co-row-num"><i class="fa-solid fa-receipt" style="color: var(--accent-gold);"></i> Order #${order.order_number}</span>
            ${premInfo.isHighlight ? `
              <span class="badge-premium-member" style="background: linear-gradient(135deg, #FFD700 0%, #FFA000 100%); color: #1A1A2E; padding: 3px 10px; border-radius: 12px; font-weight: 800; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 2px 8px rgba(255, 215, 0, 0.3);">
                🎟️ PREMIUM MEMBER
              </span>
            ` : ''}
            ${order.is_express_delivery ? `
              <span class="badge-express-priority" style="background: linear-gradient(135deg, #1A1A2E 0%, #0F3460 100%); color: #64B5F6; border: 1px solid #64B5F6; padding: 3px 10px; border-radius: 12px; font-weight: 800; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 4px;">
                🚀 PRIORITY EXPRESS
              </span>
            ` : ''}
            <span class="co-row-type"><i class="fa-solid ${typeIcon}"></i> ${order.order_type}</span>
            <span class="co-row-status-badge" style="border-color: ${statusColor}; color: ${statusColor};">
              <i class="fa-solid ${statusIcon}"></i> ${statusLabel}
            </span>
            <button type="button" class="btn-sm-status" onclick="app.deleteOrder('${order.id}', this)" style="background: rgba(229,57,53,0.16); color: #FF5252; border: 1px solid rgba(229,57,53,0.4); padding: 3px 9px; border-radius: 6px; font-weight: 700; font-size: 0.74rem; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Delete order record permanently">
              <i class="fa-solid fa-trash-can"></i> Delete
            </button>
            <span class="co-row-date"><i class="fa-regular fa-clock"></i> ${dateFormatted}</span>
          </div>

          <div class="co-top-right">
            <div class="co-payment-status-block">
              <span class="co-pay-title-label"><i class="fa-solid fa-credit-card" style="color: var(--accent-gold);"></i> Payment Status:</span>
              <span class="co-row-pay-pill ${isReferralPay ? 'referral' : (isPaid ? 'paid' : 'pending')}">
                <i class="fa-solid ${isReferralPay ? 'fa-circle' : (isPaid ? 'fa-circle-check' : 'fa-hourglass-half')}" style="${isReferralPay ? 'color: #00E676;' : ''}"></i> ${isReferralPay ? '🟢 REFERRAL' : `${order.payment_status} (${order.payment_method})`}
              </span>
            </div>
            <div class="co-total-amount-block">
              <span class="co-total-title-label">Total Amount</span>
              <span class="co-row-total-val">₹${order.net_amount ?? order.total_amount ?? order.grand_total ?? 0}</span>
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

          ${premInfo.isHighlight ? `
            <div style="margin-top: 8px; padding: 8px 12px; background: rgba(255, 215, 0, 0.12); border: 1.5px solid #FFD700; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
              <div style="font-weight: 800; color: #FFD700; font-size: 0.84rem; display: flex; align-items: center; gap: 6px;">
                🎟️ PREMIUM MEMBER
              </div>
              <div style="font-size: 0.82rem; font-weight: 700; color: #FFFFFF; display: flex; align-items: center; gap: 6px;">
                <span style="color: var(--text-muted, #AAA);">Premium Membership:</span>
                <span style="color: #4CAF50; font-weight: 800; font-size: 0.88rem;">${premInfo.remainingDaysText}</span>
              </div>
            </div>
          ` : ''}
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
                  <button type="button" class="btn-sm-status" onclick="app.viewFullScreenshot('${order.payment_screenshot}', 'Customer Payment Proof - Order #${order.order_number}')" style="background: rgba(234, 162, 33, 0.2); color: var(--accent-gold); border: 1px solid var(--accent-gold); padding: 4px 12px; border-radius: 12px; font-size: 0.75rem; font-weight: 700; cursor: pointer;">
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
                <button type="button" class="co-row-btn-action accept" onclick="app.restoreRejectedOrder('${order.id}', this)" style="background: linear-gradient(135deg, #388E3C, #2E7D32);">
                  <i class="fa-solid fa-rotate-left"></i> Restore & Accept Order
                </button>
                <button type="button" class="co-row-btn-action reject" onclick="app.deleteOrder('${order.id}', this)" style="background: rgba(229,57,53,0.2); border: 1px solid #E53935; color: #FF5252;">
                  <i class="fa-solid fa-trash-can"></i> Delete Permanently
                </button>
              ` : ''}

              ${isReceived ? `
                <button class="co-row-btn-action accept" onclick="app.updateOrderStatus('${order.id}', 'Preparing', this)">
                  <i class="fa-solid fa-fire-burner"></i> Accept & Start Preparing
                </button>
                <button class="co-row-btn-action reject" onclick="app.openRejectOrderModal('${order.id}')">
                  <i class="fa-solid fa-xmark"></i> Reject Order
                </button>
              ` : ''}

              ${isPreparing ? `
                <button class="co-row-btn-action ready" onclick="app.updateOrderStatus('${order.id}', 'Ready', this)">
                  <i class="fa-solid fa-bell-concierge"></i> Mark Ready for Serving
                </button>
              ` : ''}

              ${(isReceived || isPreparing) ? `
                <!-- ⏱️ KITCHEN LIVE PREPARATION TIME CONTROL -->
                ${(order.estimated_ready_at && !this.editingPrepTimeOrders?.[order.id]) ? `
                  <div style="margin-bottom: 8px; padding: 8px 12px; background: rgba(234, 162, 33, 0.1); border: 1px solid var(--accent-gold); border-radius: 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 0.8rem;">
                    <div style="color: var(--accent-gold); font-weight: 700; display: flex; align-items: center; gap: 6px;">
                      <i class="fa-solid fa-stopwatch"></i> Prep Time: <strong style="color: #FFF;">${order.preparation_minutes || 15}m</strong>
                      <span style="color: var(--text-muted); font-size: 0.75rem;">(Expected ~ ${new Date(order.estimated_ready_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })})</span>
                    </div>
                    <button type="button" class="btn-sm-status" onclick="app.togglePrepTimeEdit('${order.id}', true)" style="background: rgba(255,255,255,0.08); color: #AAA; border: 1px solid var(--border-color); font-size: 0.72rem; padding: 3px 8px; border-radius: 6px; cursor: pointer;">
                      ✏️ Edit Time
                    </button>
                  </div>
                ` : `
                  <div style="margin-bottom: 8px; padding: 10px; background: rgba(0,0,0,0.3); border: 1.5px dashed var(--accent-gold); border-radius: 10px;">
                    <div style="font-size: 0.78rem; font-weight: 800; color: var(--accent-gold); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
                      <span><i class="fa-solid fa-stopwatch"></i> Prep Time: <strong>${order.preparation_minutes || 15}m</strong></span>
                      <span style="font-size: 0.7rem; color: #FFF;">Expected ~ ${order.estimated_ready_at ? new Date(order.estimated_ready_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }) : 'Soon'}</span>
                    </div>
                    <div style="display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 6px;">
                      ${[5, 10, 15, 20, 30].map(m => `
                        <button type="button" class="prep-preset-btn" onclick="app.updateOrderPreparationTime('${order.id}', ${m})">${m}m</button>
                      `).join('')}
                    </div>
                    <div style="display: flex; gap: 6px; align-items: center;">
                      <input type="number" min="1" max="180" value="${order.preparation_minutes || 15}" id="txtPrepTime_${order.id}" class="form-control" style="padding: 4px 8px; font-size: 0.8rem; text-align: center; height: 30px; width: 70px;">
                      <button type="button" class="btn-secondary-outline" onclick="app.updateOrderPreparationTime('${order.id}')" style="padding: 4px 10px; font-size: 0.78rem; height: 30px; white-space: nowrap; flex: 1;">
                        Set Time
                      </button>
                      ${order.estimated_ready_at ? `
                        <button type="button" class="btn-secondary-outline" onclick="app.togglePrepTimeEdit('${order.id}', false)" style="padding: 4px 8px; font-size: 0.75rem; height: 30px; color: #AAA;">
                          Cancel
                        </button>
                      ` : ''}
                    </div>
                  </div>
                `}
              ` : ''}

              ${isReady ? `
                <button class="co-row-btn-action complete" onclick="app.updateOrderStatus('${order.id}', 'Completed', this)">
                  <i class="fa-solid fa-circle-check"></i> Mark Order Completed
                </button>
              ` : ''}

              ${isPendingPayment && !isRejected ? `
                <div style="display: flex; gap: 8px; margin-top: 6px;">
                  <button type="button" class="btn-verify-paid" onclick="app.verifyOrderPayment('${order.id}', 'Paid (UPI Verified)', this)">
                    <i class="fa-solid fa-check"></i> Verify Paid
                  </button>
                  <button type="button" class="btn-reject-pay" onclick="app.verifyOrderPayment('${order.id}', 'Payment Failed', this)">
                    <i class="fa-solid fa-xmark"></i> Reject Pay
                  </button>
                </div>
              ` : ''}

              ${(order.pickup_pin_verified || isCompleted) ? `
                <div style="background: rgba(76, 175, 80, 0.15); border: 1.5px solid #4CAF50; border-radius: 8px; padding: 8px 10px; margin-top: 4px; text-align: center; color: #4CAF50; font-weight: 800; font-size: 0.82rem;">
                  <i class="fa-solid fa-circle-check"></i> ✅ Order Completed
                </div>
              ` : ''}

              <div style="display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap;">
                <button class="co-row-btn view" onclick="app.showOrderDetail('${order.order_number}')" style="flex: 1; min-width: 100px;">
                  <i class="fa-solid fa-eye"></i> View Details
                </button>
                ${(isCompleted || order.pickup_pin_verified) ? `
                  <button class="co-row-btn receipt" onclick="app.downloadInvoice('${order.order_number}')" style="flex: 1; min-width: 120px; background: rgba(76, 175, 80, 0.2); color: #4CAF50; border: 1px solid #4CAF50; font-weight: 800;">
                    <i class="fa-solid fa-file-invoice"></i> 🧾 Download Invoice
                  </button>
                ` : ''}
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

    const isCancelled = order.order_status === 'Cancelled' || order.order_status === 'CUSTOMER_CANCELLED';
    const isRejected = order.order_status === 'Rejected' || order.order_status === 'OWNER_REJECTED';
    const isReceived = order.order_status === 'Received' || order.order_status === 'Pending';
    const isPreparing = order.order_status === 'Preparing';
    const isReady = order.order_status === 'Ready';
    const isCompleted = order.order_status === 'Completed';

    let statusColor = '#EAA221';
    let statusIcon = 'fa-clock';
    let statusLabel = 'Received';
    if (isPreparing) { statusColor = '#29B6F6'; statusIcon = 'fa-fire-burner'; statusLabel = 'Preparing'; }
    if (isReady) { statusColor = '#66BB6A'; statusIcon = 'fa-bell-concierge'; statusLabel = 'Ready'; }
    if (isCompleted) { statusColor = '#4CAF50'; statusIcon = 'fa-circle-check'; statusLabel = 'Completed'; }
    if (isCancelled) { statusColor = '#FF9800'; statusIcon = 'fa-triangle-exclamation'; statusLabel = '🟠 Customer Cancelled'; }
    else if (isRejected) { statusColor = '#E53935'; statusIcon = 'fa-circle-xmark'; statusLabel = '🔴 Owner Rejected'; }

    let stepIdx = 0;
    if (isPreparing) stepIdx = 1;
    if (isReady) stepIdx = 2;
    if (isCompleted) stepIdx = 3;
    const progressPct = Math.round((stepIdx / 3) * 100);

    const typeIcon = order.order_type === 'Takeaway' ? 'fa-box' : order.order_type === 'Delivery' ? 'fa-motorcycle' : 'fa-utensils';
    const isReferralPay = (order.payment_status || '').toUpperCase() === 'REFERRAL' || (order.payment_method || '').toUpperCase() === 'REFERRAL';
    
    const payMethodStr = (order.payment_method || '').toLowerCase();
    const isPhonePe = payMethodStr.includes('phonepe');
    const rawPayStatus = (order.payment_status || '').toLowerCase();
    const isPaid = order.payment_status === 'Paid' || order.payment_status === 'Cash Received' || order.payment_status.includes('Verified');
    const isPhonePeCancelled = isPhonePe && (rawPayStatus.includes('cancel') || order.payment_status === 'Cancelled');
    const isPhonePeFailed = isPhonePe && (rawPayStatus.includes('fail') || rawPayStatus.includes('reject') || order.payment_status === 'Failed');
    const isPhonePeProcessing = isPhonePe && !isPaid && !isPhonePeFailed && !isPhonePeCancelled;
    const isPhonePeSuccess = isPhonePe && isPaid;

    let payPillHtml = '';
    if (isReferralPay) {
      payPillHtml = `<span class="co-row-pay-pill referral"><i class="fa-solid fa-circle" style="color: #00E676;"></i> 🟢 REFERRAL</span>`;
    } else if (isPhonePeSuccess) {
      payPillHtml = `<span class="co-row-pay-pill paid" style="background: rgba(76, 175, 80, 0.18); color: #4CAF50; border: 1px solid #4CAF50;"><i class="fa-solid fa-circle-check"></i> 🟢 Payment Successful</span>`;
    } else if (isPhonePeCancelled) {
      payPillHtml = `<span class="co-row-pay-pill failed" style="background: rgba(239, 108, 0, 0.18); color: #FF9800; border: 1px solid #EF6C00;"><i class="fa-solid fa-ban"></i> 🔴 Payment Cancelled</span>`;
    } else if (isPhonePeFailed) {
      payPillHtml = `<span class="co-row-pay-pill failed" style="background: rgba(229, 57, 53, 0.18); color: #FF5252; border: 1px solid #E53935;"><i class="fa-solid fa-circle-xmark"></i> 🔴 Payment Failed</span>`;
    } else if (isPhonePeProcessing) {
      payPillHtml = `<span class="co-row-pay-pill processing" style="background: rgba(255, 152, 0, 0.18); color: #FFB74D; border: 1px solid #FF9800;"><i class="fa-solid fa-hourglass-half"></i> 🟠 Payment Processing</span>`;
    } else {
      payPillHtml = `<span class="co-row-pay-pill ${isPaid ? 'paid' : 'pending'}"><i class="fa-solid ${isPaid ? 'fa-circle-check' : 'fa-hourglass-half'}"></i> ${order.payment_status} (${order.payment_method})</span>`;
    }

    // Calculate 3-minute modification cutoff
    const createdAtMs = new Date(order.created_at || Date.now()).getTime();
    const elapsedMs = Date.now() - createdAtMs;
    const isWithin3Min = elapsedMs < 180000;
    const canModify = isWithin3Min && ['Received', 'Pending'].includes(order.order_status);
    const canCancel = ['Received', 'Pending'].includes(order.order_status);
    const remainingSecs = Math.max(0, Math.floor((180000 - elapsedMs) / 1000));
    const minsStr = String(Math.floor(remainingSecs / 60)).padStart(2, '0');
    const secsStr = String(remainingSecs % 60).padStart(2, '0');

    const isCustPremiumOrder = Boolean(order.is_premium_member || (order.food_member_discount && Number(order.food_member_discount) > 0));

    return `
      <div class="co-row-card ${isCancelled ? 'is-customer-cancelled' : isRejected ? 'is-owner-rejected' : ''} ${isCustPremiumOrder ? 'card-order-premium' : ''}">
        ${isCancelled ? `
          <!-- PROMINENT CANCELLED ORDER CALLOUT BANNER (ORANGE) -->
          <div style="background: rgba(255, 152, 0, 0.14); border: 1.5px solid #FF9800; padding: 12px 16px; border-radius: var(--radius-md); color: #FFE0B2; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 0.25rem;">
            <div style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 250px;">
              <div style="width: 38px; height: 38px; border-radius: 50%; background: rgba(255, 152, 0, 0.25); color: #FF9800; display: flex; align-items: center; justify-content: center; font-size: 1.3rem; flex-shrink: 0;">
                <i class="fa-solid fa-triangle-exclamation"></i>
              </div>
              <div style="word-break: break-word; overflow-wrap: break-word;">
                <strong style="font-size: 0.95rem; color: #FFF; display: block; margin-bottom: 2px;">🟠 Customer Cancelled</strong>
                <span style="font-size: 0.84rem; color: #FFE0B2; font-weight: 600;">
                  <strong>Cancellation Reason:</strong> ${order.cancellation_reason || 'Ordered by mistake'}
                </span>
              </div>
            </div>
            <button type="button" class="btn-sm-status" onclick="app.openOrderSupport('${order.order_number}')" style="background: #FF9800; color: #FFF; border: none; padding: 7px 16px; font-weight: 800; font-size: 0.78rem; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
              <i class="fa-solid fa-headset"></i> Order Support
            </button>
          </div>
        ` : isRejected ? `
          <!-- PROMINENT REJECTED ORDER CALLOUT BANNER (RED) -->
          <div style="background: rgba(229, 57, 53, 0.14); border: 1.5px solid #E53935; padding: 12px 16px; border-radius: var(--radius-md); color: #FF5252; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 0.25rem;">
            <div style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 250px;">
              <div style="width: 38px; height: 38px; border-radius: 50%; background: rgba(229,57,53,0.25); color: #E53935; display: flex; align-items: center; justify-content: center; font-size: 1.3rem; flex-shrink: 0;">
                <i class="fa-solid fa-circle-xmark"></i>
              </div>
              <div style="word-break: break-word; overflow-wrap: break-word;">
                <strong style="font-size: 0.95rem; color: #FFF; display: block; margin-bottom: 2px;">🔴 Owner Rejected</strong>
                <span style="font-size: 0.84rem; color: #FF8A80; font-weight: 600;">
                  <strong>Rejection Reason:</strong> ${order.rejection_reason || 'Item unavailable'}
                </span>
              </div>
            </div>
            <button type="button" class="btn-sm-status" onclick="app.openOrderSupport('${order.order_number}')" style="background: #E53935; color: #FFF; border: none; padding: 7px 16px; font-weight: 800; font-size: 0.78rem; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
              <i class="fa-solid fa-headset"></i> Order Support
            </button>
          </div>
        ` : ''}

        <!-- 1. TOP HEADER BAR: Order #, Date, Badges, Payment & Grand Total -->
        <div class="co-card-top-bar">
          <div class="co-top-left" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span class="co-row-num"><i class="fa-solid fa-receipt" style="color: var(--accent-gold);"></i> Order #${order.order_number}</span>
            ${isCustPremiumOrder ? `
              <span class="badge-premium-member">
                ⭐ PREMIUM MEMBER
              </span>
            ` : ''}
            ${order.is_express_delivery ? `
              <span class="badge-express-delivery">
                🚀 EXPRESS
              </span>
            ` : ''}
            <span class="co-row-type"><i class="fa-solid ${typeIcon}"></i> ${order.order_type}</span>
            <span class="co-row-status-badge" style="border-color: ${statusColor}; color: ${statusColor};">
              <i class="fa-solid ${statusIcon}"></i> ${statusLabel}
            </span>
            <span class="co-row-date"><i class="fa-regular fa-clock"></i> ${dateFormatted}</span>
            <button type="button" class="btn-sm-status" onclick="event.stopPropagation(); app.deleteCustomerOrder('${order.id}')" style="background: rgba(229,57,53,0.16); color: #FF5252; border: 1px solid rgba(229,57,53,0.4); padding: 4px 12px; border-radius: 6px; font-weight: 700; font-size: 0.74rem; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; transition: all 0.2s ease;" title="Delete this order from your history">
              <i class="fa-solid fa-trash-can"></i> Delete
            </button>
          </div>

          <div class="co-top-right">
            <div class="co-payment-status-block">
              <span class="co-pay-title-label"><i class="fa-solid fa-credit-card" style="color: var(--accent-gold);"></i> Payment Status:</span>
              ${payPillHtml}
            </div>
            <div class="co-total-amount-block">
              <span class="co-total-title-label">Total Amount</span>
              <span class="co-row-total-val">₹${order.net_amount ?? order.total_amount ?? order.grand_total ?? 0}</span>
            </div>
          </div>
        </div>

        <!-- 2. MIDDLE SECTION: ORDER DETAILS AND QUICK ACTIONS SIDE BY SIDE -->
        <div class="co-middle-side-by-side">
          <!-- Left: Order Details Box -->
          <div class="co-order-details-box">
            ${(!isCancelled && !isRejected) ? `
              <!-- PROMINENT PICKUP PIN CARD FOR CUSTOMER -->
              <div style="background: rgba(0, 230, 118, 0.08); border: 1.5px solid #00E676; border-radius: var(--radius-md); padding: 10px 14px; margin-bottom: 0.85rem; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
                <div>
                  <span style="font-size: 0.74rem; font-weight: 800; color: #80E6A2; text-transform: uppercase; letter-spacing: 0.5px; display: block;">
                    <i class="fa-solid fa-lock" style="color: #00E676;"></i> PICKUP PIN
                  </span>
                  <span style="font-size: 1.8rem; font-weight: 900; color: #00E676; letter-spacing: 5px; font-family: monospace; line-height: 1.1;">
                    ${order.pickup_pin || '----'}
                  </span>
                  <span style="font-size: 0.78rem; color: #FFFFFF; font-weight: 600; display: block; margin-top: 2px;">
                    🔐 Please show or tell this PIN to the owner when collecting your order.
                  </span>
                </div>
                ${(order.pickup_pin_verified || isCompleted) ? `
                  <span style="background: rgba(76, 175, 80, 0.2); color: #4CAF50; border: 1px solid #4CAF50; padding: 5px 12px; border-radius: 20px; font-size: 0.78rem; font-weight: 800; display: inline-flex; align-items: center; gap: 4px;">
                    <i class="fa-solid fa-circle-check"></i> PIN Verified
                  </span>
                ` : `
                  <span style="background: rgba(0, 230, 118, 0.15); color: #00E676; border: 1px solid rgba(0, 230, 118, 0.4); padding: 5px 12px; border-radius: 20px; font-size: 0.78rem; font-weight: 800; display: inline-flex; align-items: center; gap: 4px;">
                    <i class="fa-solid fa-shield-halved"></i> Active PIN
                  </span>
                `}
              </div>
            ` : ''}

            <div class="co-order-details-title">
              <i class="fa-solid fa-utensils" style="color: var(--primary);"></i> Order Details & Items
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

            <!-- Delivery / Service Location Tag -->
            <div class="co-delivery-info-tag">
              <span class="tag-label"><i class="fa-solid fa-location-dot"></i> ${order.order_type === 'Delivery' ? 'Delivery Address' : order.order_type === 'Dine-in' ? 'Table Location' : 'Pickup Point'}:</span>
              <span class="tag-val">${order.delivery_address || 'Hotel Counter'}</span>
            </div>

            ${order.notes ? `<div class="co-order-notes"><i class="fa-solid fa-note-sticky"></i> Note: "${order.notes}"</div>` : ''}

            ${order.utr_number || order.payment_screenshot ? `
              <div class="co-payment-utr-line">
                ${order.utr_number ? `<span class="utr-code"><i class="fa-solid fa-receipt" style="color: var(--accent-gold);"></i> Transaction Ref / UTR: <code style="background: rgba(255,255,255,0.08); padding: 2px 7px; border-radius: 4px; color: #FFF; font-family: monospace;">${order.utr_number}</code></span>` : ''}
                ${order.payment_screenshot ? `
                  <button type="button" class="btn-sm-status" onclick="app.viewFullScreenshot('${order.payment_screenshot}', 'Payment Screenshot - Order #${order.order_number}')" style="background: rgba(41,182,246,0.15); color: #29B6F6; border: 1px solid rgba(41,182,246,0.3); padding: 4px 10px; border-radius: 12px; font-size: 0.74rem; font-weight: 700; cursor: pointer;">
                    <i class="fa-solid fa-camera"></i> View Screenshot
                  </button>
                ` : ''}
              </div>
            ` : ''}

            ${isPhonePeProcessing ? `
              <!-- ISOLATED PROCESSING PAYMENT SCREENSHOT UPLOAD CARD (ONLY FOR 🟠 PAYMENT PROCESSING) -->
              <div class="processing-screenshot-card" style="margin-top: 0.85rem; background: rgba(255, 152, 0, 0.1); border: 1.5px dashed rgba(255, 152, 0, 0.5); padding: 12px; border-radius: var(--radius-md);">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px;">
                  <span style="font-weight: 700; font-size: 0.84rem; color: #FFF; display: flex; align-items: center; gap: 6px;">
                    <i class="fa-solid fa-camera" style="color: var(--accent-gold);"></i> Upload Processing Payment Screenshot
                  </span>
                  <span style="font-size: 0.72rem; color: #FFB74D; background: rgba(255,152,0,0.2); padding: 2px 8px; border-radius: 10px; font-weight: 700;">
                    🟠 Payment Processing
                  </span>
                </div>
                <p style="font-size: 0.76rem; color: var(--text-muted); margin-bottom: 10px;">
                  If your PhonePe payment is currently processing, upload a transaction screenshot here to assist verification.
                </p>

                <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                  <label class="btn-secondary-outline" style="font-size: 0.78rem; padding: 6px 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
                    <i class="fa-solid fa-upload"></i> Choose Screenshot
                    <input type="file" accept="image/*" onchange="app.handleProcessingScreenshotSelect(event, '${order.id}')" style="display: none;">
                  </label>
                  <span id="procScreenshotName_${order.id}" style="font-size: 0.76rem; color: var(--accent-gold); font-style: italic;">No file selected</span>
                  <button type="button" id="btnUploadProcScreenshot_${order.id}" class="btn-primary-block" onclick="app.uploadProcessingScreenshot('${order.id}')" style="width: auto; padding: 6px 14px; font-size: 0.78rem; background: var(--accent-gold); color: #000; font-weight: 800; border: none; border-radius: 6px; cursor: pointer; display: none;">
                    <i class="fa-solid fa-cloud-arrow-up"></i> Upload Screenshot
                  </button>
                </div>

                ${order.payment_screenshot ? `
                  <div style="margin-top: 10px;">
                    <button type="button" class="btn-sm-status" onclick="app.viewFullScreenshot('${order.payment_screenshot}', 'Processing Payment Screenshot - Order #${order.order_number}')" style="background: rgba(41,182,246,0.15); color: #29B6F6; border: 1px solid rgba(41,182,246,0.3); padding: 5px 12px; border-radius: 12px; font-size: 0.74rem; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
                      <i class="fa-solid fa-camera"></i> View Uploaded Processing Screenshot
                    </button>
                  </div>
                ` : ''}
              </div>
            ` : ''}
          </div>

          <!-- Right: Quick Actions Panel Side-by-Side -->
          <div class="co-actions-panel">
            <div class="co-actions-title"><i class="fa-solid fa-bolt" style="color: var(--accent-gold);"></i> Quick Actions</div>
            <div class="co-row-actions">
              ${isPhonePeFailed ? `
                <button type="button" class="co-row-btn btn-phonepe-pay-again" id="btnPayAgain_${order.id}" onclick="app.payAgainPhonePe('${order.id}')" style="grid-column: span 2; background: linear-gradient(135deg, #5f259f, #4a1c7c); color: #FFF; border: 1.5px solid #8e44ad; font-weight: 800; padding: 10px 16px; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 14px rgba(95, 37, 159, 0.4); margin-bottom: 6px;">
                  <i class="fa-solid fa-rotate-right" style="color: #00E676; font-size: 1rem;"></i> Pay Again
                </button>
              ` : ''}

              ${canModify ? `
                <div class="order-mod-timer-box" style="grid-column: span 2; background: rgba(255, 179, 0, 0.12); border: 1px solid var(--accent-gold); padding: 8px 12px; border-radius: 8px; font-size: 0.78rem; color: #FFF; display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                  <span><i class="fa-solid fa-clock-rotate-left" style="color: var(--accent-gold);"></i> You can modify this order for:</span>
                  <strong data-order-timer-id="${order.id}" data-created-at="${order.created_at}" style="font-family: monospace; font-size: 0.92rem; color: var(--accent-gold);">${minsStr}:${secsStr}</strong>
                </div>
                <button type="button" class="co-row-btn edit-order-btn" id="btnEditOrder_${order.id}" onclick="app.openEditOrderModal('${order.id}')" style="background: rgba(255,179,0,0.2); color: var(--accent-gold); border: 1px solid var(--accent-gold); font-weight: 800;">
                  <i class="fa-solid fa-box-open"></i> Edit Order
                </button>
              ` : (order.order_status === 'Received' || order.order_status === 'Pending') ? `
                <div class="order-mod-timer-box" style="grid-column: span 2; background: rgba(255,255,255,0.04); border: 1px solid var(--border-color); padding: 6px 10px; border-radius: 8px; font-size: 0.76rem; color: var(--text-muted); text-align: center; margin-bottom: 4px;">
                  <i class="fa-solid fa-hourglass-end"></i> Modification window expired.
                </div>
              ` : ''}

              ${canCancel ? `
                <button type="button" class="co-row-btn cancel-order-btn" id="btnCancelOrder_${order.id}" onclick="app.openCancelOrderModal('${order.id}')" style="background: rgba(229,57,53,0.18); color: #FF5252; border: 1px solid #E53935; font-weight: 800;">
                  <i class="fa-solid fa-ban"></i> Cancel Order
                </button>
              ` : ''}

              <button class="co-row-btn view" onclick="app.showOrderDetail('${order.order_number}')">
                <i class="fa-solid fa-eye"></i> View Full Details
              </button>

              ${(['completed', 'delivered'].includes((order.order_status || '').toLowerCase())) ? `
                <button type="button" class="co-row-btn reorder-btn" onclick="app.reorderPreviousOrder('${order.id || order.order_number}', event)" style="background: linear-gradient(135deg, var(--primary), var(--accent-gold)); color: #000; font-weight: 800; border: none; cursor: pointer;" title="Reorder items from this previous order">
                  <i class="fa-solid fa-rotate-right"></i> 🔄 Reorder
                </button>
              ` : ''}

              ${order.review ? `
                <button class="co-row-btn review reviewed" onclick="app.openOrderReviewModal('${order.order_number}')" style="background: rgba(255, 179, 0, 0.22); color: var(--accent-gold); border: 1.5px solid var(--accent-gold); font-weight: 800;" title="Click to view or edit your review">
                  <i class="fa-solid fa-star" style="color: var(--accent-gold);"></i> Rated ${order.review.rating}/5 • Edit Review
                </button>
              ` : `
                <button class="co-row-btn review" onclick="app.openOrderReviewModal('${order.order_number}')">
                  <i class="fa-regular fa-star" style="color: var(--accent-gold);"></i> Rate & Review Order
                </button>
              `}

              <button class="co-row-btn support" onclick="app.openOrderSupport('${order.order_number}')">
                <i class="fa-solid fa-headset"></i> Order Support & Help
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

    const isRejected = order.order_status === 'Rejected';
    const isPreparing = order.order_status === 'Preparing';
    const isReady = order.order_status === 'Ready';
    const isCompleted = order.order_status === 'Completed';

    let statusColor = '#FF9800';
    let statusIcon = 'fa-clock';
    if (isPreparing) { statusColor = '#29B6F6'; statusIcon = 'fa-fire-burner'; }
    if (isReady) { statusColor = '#66BB6A'; statusIcon = 'fa-bell-concierge'; }
    if (isCompleted) { statusColor = '#4CAF50'; statusIcon = 'fa-circle-check'; }

    let stepIdx = 0;
    if (isPreparing) stepIdx = 1;
    if (isReady) stepIdx = 2;
    if (isCompleted) stepIdx = 3;
    const progressPct = stepIdx * 33.33;

    const subtotal = order.items.reduce((s, i) => s + (i.price * i.quantity), 0);

    const container = document.getElementById('orderDetailContent');
    container.innerHTML = `
      <div class="od-header">
        <div>
          <h2 class="od-title">Order #${order.order_number}</h2>
          <p class="od-date"><i class="fa-regular fa-calendar"></i> ${dateFormatted}</p>
        </div>
        <span class="od-status" style="background: ${statusColor}22; border: 1px solid ${statusColor}; color: ${statusColor}; margin-right: 36px;">
          ${order.order_status}
        </span>
      </div>

      <!-- PICKUP PIN BANNER IN ORDER DETAILS (Hidden on Owner side until verified/completed) -->
      ${(this.currentRole !== 'OWNER' || order.pickup_pin_verified || isCompleted) ? `
        <div style="background: rgba(0, 230, 118, 0.08); border: 1.5px solid #00E676; padding: 12px; border-radius: 8px; margin: 1rem 0; text-align: center;">
          <span style="font-size: 0.74rem; font-weight: 800; color: #80E6A2; text-transform: uppercase; letter-spacing: 0.5px; display: block;">🔐 PICKUP PIN</span>
          <div style="font-size: 2.2rem; font-weight: 900; color: #00E676; letter-spacing: 6px; font-family: monospace; margin: 4px 0;">${order.pickup_pin || '----'}</div>
          <p style="font-size: 0.8rem; color: #FFFFFF; font-weight: 600; margin: 0;">
            ${(order.pickup_pin_verified || isCompleted) ? '✅ Pickup PIN Verified & Order Completed' : '🔐 Please show or tell this PIN to the owner when collecting your order.'}
          </p>
        </div>
      ` : ''}

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
          <span class="od-label">Payment Method</span>
          <span class="od-value">${order.payment_method}</span>
        </div>
        <div class="od-info-item">
          <span class="od-label">Payment Status</span>
          <span class="od-value">
            ${((order.payment_status || '').toUpperCase() === 'REFERRAL' || (order.payment_method || '').toUpperCase() === 'REFERRAL')
              ? '<span class="badge-status REFERRAL">🟢 REFERRAL</span>'
              : `${order.payment_status}`}
          </span>
        </div>
        ${((order.payment_method || '').toUpperCase() === 'REFERRAL' || Number(order.used_wallet_amount || 0) > 0) ? `
          <div class="od-info-item">
            <span class="od-label">Referral Wallet Used</span>
            <span class="od-value" style="color: #00E676; font-weight: 800;">₹${order.used_wallet_amount ?? order.total_amount ?? 0}</span>
          </div>
        ` : ''}
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

      <div class="od-total-bar" style="margin-bottom: 1.2rem;">
        <span>Grand Total</span>
        <span class="od-grand">₹${order.net_amount ?? order.total_amount ?? order.grand_total ?? 0}</span>
      </div>

      <!-- LIVE ORDER TRACKING STEPPER IN ORDER DETAILS MODAL -->
      <div class="co-bottom-tracking" style="margin-top: 1rem; margin-bottom: 1.25rem;">
        <div class="co-track-head-bar">
          <span><i class="fa-solid fa-route" style="color: var(--accent-gold);"></i> ${isRejected ? 'Kitchen Status' : 'ORDER PROGRESS & TRACKING'}</span>
          <span style="color: ${statusColor}; font-weight: 800;"><i class="fa-solid ${statusIcon}"></i> ${order.order_status}</span>
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

      ${(isCompleted || order.pickup_pin_verified) ? `
        <button class="od-download-btn" onclick="app.downloadInvoice('${order.order_number}')" style="background: rgba(76, 175, 80, 0.2); color: #4CAF50; border: 1.5px solid #4CAF50; font-weight: 800;">
          <i class="fa-solid fa-file-invoice"></i> 🧾 Download Invoice
        </button>
      ` : ''}
    `;

    document.getElementById('orderDetailBackdrop').classList.add('open');
  }

  closeOrderDetail() {
    const backdrop = document.getElementById('orderDetailBackdrop');
    if (backdrop) {
      backdrop.classList.remove('open');
    }
  }

  async downloadInvoice(orderNum, autoView = false) {
    if (!this.currentUser) {
      this.showToast('Please log in to download invoice', 'warning');
      return;
    }

    if (this.isGeneratingInvoice) return;
    this.isGeneratingInvoice = true;

    // Find target buttons to update state across cards & modals
    const buttons = document.querySelectorAll(`[onclick*="downloadInvoice('${orderNum}')"]`);
    buttons.forEach(btn => {
      btn.disabled = true;
      btn.setAttribute('data-orig-html', btn.innerHTML);
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ⏳ Downloading invoice...`;
    });

    this.showToast('⏳ Downloading invoice...', 'info');

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/orders/${orderNum}/invoice`);
      const json = await res.json();

      if (!json.success || !json.data) {
        this.showToast(json.message || '❌ Unable to generate invoice. Please try again.', 'error');
        this.resetInvoiceButtons(orderNum);
        return;
      }

      const inv = json.data;
      const filename = `Sri-Lakshmi-Annapurna-Invoice-${inv.order_number}.pdf`;

      // Build invoice HTML DOM element with clean text & Emojis for 100% reliable canvas rendering
      const itemsRowsHtml = (inv.items || []).map((item, idx) => `
        <tr style="border-bottom: 1px solid #EEEEEE;">
          <td style="padding: 10px 8px; font-weight: 600; color: #222; word-break: break-word;">${idx + 1}. ${item.name}</td>
          <td style="padding: 10px 8px; text-align: center; font-weight: 700; color: #444;">${item.quantity}</td>
          <td style="padding: 10px 8px; text-align: right; color: #555;">₹${item.price}</td>
          <td style="padding: 10px 8px; text-align: right; font-weight: 700; color: #222;">₹${item.price * item.quantity}</td>
        </tr>
      `).join('');

      const formattedDate = new Date(inv.order_date).toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short'
      });

      const invoiceHTML = `
        <div id="pdfInvoiceContainer" style="width: 680px; padding: 28px 32px; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111111; background: #FFFFFF; box-sizing: border-box; word-wrap: break-word; overflow-wrap: break-word;">
          <!-- INVOICE HEADER -->
          <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2.5px solid #D9531E; padding-bottom: 16px; margin-bottom: 18px;">
            <div>
              <h1 style="font-size: 1.4rem; font-weight: 900; color: #D9531E; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 0.5px; word-break: break-word;">${inv.hotel_name}</h1>
              <p style="font-size: 0.84rem; color: #444; margin: 2px 0; word-break: break-word;">📍 ${inv.hotel_address}</p>
              <p style="font-size: 0.84rem; color: #444; margin: 2px 0;">📞 Phone: ${inv.hotel_phone}</p>
            </div>
            <div style="text-align: right;">
              <span style="background: #E8F5E9; color: #2E7D32; border: 1.5px solid #4CAF50; font-weight: 800; font-size: 0.82rem; padding: 4px 12px; border-radius: 20px; display: inline-block; margin-bottom: 8px;">
                ✅ TAX INVOICE
              </span>
              <h2 style="font-size: 1.05rem; font-weight: 800; color: #222; margin: 0;">${inv.invoice_number}</h2>
              <p style="font-size: 0.82rem; color: #555; margin: 4px 0 0 0;">Order #${inv.order_number}</p>
            </div>
          </div>

          <!-- META DETAILS GRID -->
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 22px; font-size: 0.84rem;">
            <div>
              <p style="margin: 3px 0; color: #555; word-break: break-word;"><strong style="color: #222;">Customer Name:</strong> ${inv.customer_name}</p>
              <p style="margin: 3px 0; color: #555;"><strong style="color: #222;">Mobile Number:</strong> ${inv.customer_mobile}</p>
              <p style="margin: 3px 0; color: #555;"><strong style="color: #222;">Order Type:</strong> ${inv.order_type}</p>
              ${inv.delivery_address ? `<p style="margin: 3px 0; color: #555; word-break: break-word;"><strong style="color: #222;">Delivery Address:</strong> ${inv.delivery_address}</p>` : ''}
            </div>
            <div style="text-align: right;">
              <p style="margin: 3px 0; color: #555;"><strong style="color: #222;">Invoice Date:</strong> ${formattedDate}</p>
              <p style="margin: 3px 0; color: #555;"><strong style="color: #222;">Payment Method:</strong> ${inv.payment_method}</p>
              <p style="margin: 3px 0; color: #555;"><strong style="color: #222;">Payment Status:</strong> <span style="color: #2E7D32; font-weight: 700;">${inv.payment_status}</span></p>
              ${inv.utr_number ? `<p style="margin: 3px 0; color: #555; word-break: break-all;"><strong style="color: #222;">Transaction UTR:</strong> ${inv.utr_number}</p>` : ''}
            </div>
          </div>

          <!-- ITEMS TABLE -->
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 22px; font-size: 0.86rem; table-layout: fixed;">
            <thead>
              <tr style="background: #F3F4F6; color: #374151; font-size: 0.80rem; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid #E5E7EB;">
                <th style="padding: 10px 8px; text-align: left; width: 50%; word-break: break-word;">Item Description</th>
                <th style="padding: 10px 8px; text-align: center; width: 14%;">Qty</th>
                <th style="padding: 10px 8px; text-align: right; width: 18%;">Rate</th>
                <th style="padding: 10px 8px; text-align: right; width: 18%;">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${itemsRowsHtml}
            </tbody>
          </table>

          <!-- TOTALS SUMMARY -->
          <div style="display: flex; justify-content: flex-end; margin-bottom: 28px;">
            <div style="width: 260px; font-size: 0.86rem;">
              <div style="display: flex; justify-content: space-between; padding: 5px 0; color: #555;">
                <span>Subtotal:</span>
                <span style="font-weight: 600;">₹${inv.total_amount}</span>
              </div>
              ${inv.used_wallet_amount > 0 ? `
                <div style="display: flex; justify-content: space-between; padding: 5px 0; color: #E65100;">
                  <span>Wallet / Reward Discount:</span>
                  <span style="font-weight: 700;">-₹${inv.used_wallet_amount}</span>
                </div>
              ` : ''}
              <div style="display: flex; justify-content: space-between; padding: 10px 0; border-top: 2.5px solid #222; font-size: 1.02rem; font-weight: 900; color: #111;">
                <span>Net Total Paid:</span>
                <span style="color: #D9531E;">₹${inv.net_amount}</span>
              </div>
            </div>
          </div>

          <!-- FOOTER STAMP & THANKS -->
          <div style="border-top: 1.5px dashed #D1D5DB; padding-top: 14px; text-align: center; font-size: 0.80rem; color: #6B7280;">
            <p style="font-weight: 700; color: #374151; margin-bottom: 4px;">🎉 Thank you for ordering from Sri Lakshmi Annapurna Tiffin Center!</p>
            <p style="margin: 0;">This is an official digital tax invoice for completed Order #${inv.order_number}.</p>
          </div>
        </div>
      `;

      // Render to DOM temporarily in an isolated foreground container (opacity 0.02 so human-invisible, but foreground z-index 999999 for html2canvas)
      let tempDiv = document.getElementById('tempInvoicePdfWrapper');
      if (!tempDiv) {
        tempDiv = document.createElement('div');
        tempDiv.id = 'tempInvoicePdfWrapper';
        tempDiv.style.position = 'fixed';
        tempDiv.style.left = '0';
        tempDiv.style.top = '0';
        tempDiv.style.width = '680px';
        tempDiv.style.minHeight = '960px';
        tempDiv.style.zIndex = '999999';
        tempDiv.style.opacity = '0.02';
        tempDiv.style.visibility = 'visible';
        tempDiv.style.pointerEvents = 'none';
        tempDiv.style.background = '#FFFFFF';
        document.body.appendChild(tempDiv);
      }
      tempDiv.innerHTML = invoiceHTML;

      // Wait for layout rendering and font loading completion
      await new Promise(resolve => setTimeout(resolve, 250));

      const element = document.getElementById('pdfInvoiceContainer');
      if (!element || element.offsetWidth === 0 || element.offsetHeight === 0) {
        console.error('Invoice element invalid or has zero dimensions!');
        this.showToast('❌ Unable to generate invoice. Please try again.', 'error');
        this.resetInvoiceButtons(orderNum);
        if (tempDiv) tempDiv.remove();
        return;
      }

      if (!window.html2pdf) {
        this.showToast('❌ Unable to generate invoice. Please try again.', 'error');
        this.resetInvoiceButtons(orderNum);
        if (tempDiv) tempDiv.remove();
        return;
      }

      const opt = {
        margin: [10, 12, 10, 12],
        filename: filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          allowTaint: true,
          logging: false,
          scrollX: 0,
          scrollY: 0,
          windowWidth: 700,
          windowHeight: 1100,
          backgroundColor: '#FFFFFF',
          width: element.offsetWidth || 680,
          height: element.offsetHeight || 960
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
      };

      const worker = window.html2pdf().set(opt).from(element);
      const pdfBlob = await worker.output('blob');

      if (!pdfBlob || pdfBlob.size < 2000) {
        console.error('Invoice PDF generation resulted in blank/empty file:', pdfBlob);
        this.showToast('❌ Unable to generate invoice. Please try again.', 'error');
        this.resetInvoiceButtons(orderNum);
        if (tempDiv) tempDiv.remove();
        return;
      }

      // Store Blob URL for View Invoice button
      if (!this.lastGeneratedInvoices) this.lastGeneratedInvoices = {};
      const blobUrl = URL.createObjectURL(pdfBlob);
      this.lastGeneratedInvoices[orderNum] = blobUrl;

      // Trigger File Download
      await worker.save();

      if (tempDiv) tempDiv.remove();

      this.showToast('✅ Invoice downloaded successfully!', 'success');

      // Update button UI to: ✅ Invoice Downloaded
      buttons.forEach(btn => {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-check"></i> ✅ Invoice Downloaded`;
        btn.style.background = 'rgba(76, 175, 80, 0.3)';
        btn.style.color = '#4CAF50';
      });

      // Show/insert "👁️ View Invoice" action button next to download button
      this.renderViewInvoiceAction(orderNum, blobUrl);

      if (autoView) {
        this.viewInvoice(orderNum);
      }
    } catch (err) {
      console.error('Error downloading invoice:', err);
      this.showToast('❌ Unable to generate invoice. Please try again.', 'error');
      this.resetInvoiceButtons(orderNum);
      const tempDiv = document.getElementById('tempInvoicePdfWrapper');
      if (tempDiv) tempDiv.remove();
    } finally {
      this.isGeneratingInvoice = false;
    }
  }

  resetInvoiceButtons(orderNum) {
    const buttons = document.querySelectorAll(`[onclick*="downloadInvoice('${orderNum}')"]`);
    buttons.forEach(btn => {
      btn.disabled = false;
      const orig = btn.getAttribute('data-orig-html');
      if (orig) btn.innerHTML = orig;
      else btn.innerHTML = `<i class="fa-solid fa-file-invoice"></i> 🧾 Download Invoice`;
    });
  }

  renderViewInvoiceAction(orderNum, blobUrl) {
    const buttons = document.querySelectorAll(`[onclick*="downloadInvoice('${orderNum}')"]`);
    buttons.forEach(btn => {
      const parent = btn.parentElement;
      if (parent) {
        // Enforce vertical column layout (one below another, NEVER side-by-side)
        parent.classList.add('invoice-btn-group');
        parent.style.display = 'flex';
        parent.style.flexDirection = 'column';
        parent.style.alignItems = 'stretch';
        parent.style.gap = '10px';
        parent.style.marginTop = '10px';
        parent.style.marginBottom = '6px';
        parent.style.width = '100%';

        btn.style.width = '100%';
        btn.style.flex = 'none';

        if (!parent.querySelector(`.btn-view-invoice_${orderNum}`)) {
          const viewBtn = document.createElement('button');
          viewBtn.className = `co-row-btn view-invoice-btn btn-view-invoice_${orderNum}`;
          viewBtn.type = 'button';
          viewBtn.setAttribute('onclick', `app.viewInvoice('${orderNum}')`);
          viewBtn.style.width = '100%';
          viewBtn.style.flex = 'none';
          viewBtn.style.background = 'rgba(41, 182, 246, 0.2)';
          viewBtn.style.color = '#29B6F6';
          viewBtn.style.border = '1.5px solid #29B6F6';
          viewBtn.style.fontWeight = '800';
          viewBtn.style.padding = '8px 16px';
          viewBtn.style.borderRadius = '8px';
          viewBtn.style.cursor = 'pointer';
          viewBtn.style.display = 'inline-flex';
          viewBtn.style.alignItems = 'center';
          viewBtn.style.justifyContent = 'center';
          viewBtn.style.gap = '6px';
          viewBtn.style.fontSize = '0.82rem';
          viewBtn.style.boxShadow = '0 2px 8px rgba(41, 182, 246, 0.2)';
          viewBtn.innerHTML = `<i class="fa-solid fa-eye"></i> 👁️ View Invoice`;
          parent.appendChild(viewBtn);
        }
      }
    });
  }

  viewInvoice(orderNum) {
    const blobUrl = this.lastGeneratedInvoices ? this.lastGeneratedInvoices[orderNum] : null;
    if (blobUrl) {
      const win = window.open(blobUrl, '_blank');
      if (!win) {
        window.location.href = blobUrl;
      }
    } else {
      this.downloadInvoice(orderNum, true);
    }
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
          <p style="margin-top:4px;">📍 Gandhi Nagar, Bengaluru | 📞 +91 9392874900</p>
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
          <span class="amount">₹${order.net_amount ?? order.total_amount ?? order.grand_total ?? 0}</span>
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
    const isKitchenPremium = Boolean(order.is_premium_member || (order.food_member_discount && Number(order.food_member_discount) > 0));
    const isSubscriptionOrder = Boolean(
      (order.payment_method || '').toUpperCase().includes('SUB') ||
      (order.notes || '').toUpperCase().includes('SUB') ||
      (order.order_number || '').startsWith('SUB-')
    );

    return `
      <div class="order-card ${isSubscriptionOrder ? 'card-order-subscription' : (isKitchenPremium ? 'card-order-premium' : '')}" ${isOwnerView ? `data-order-card-id="${order.id}"` : ''}>
        <div class="order-card-header">
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <span class="order-num-badge">#${order.order_number}</span>
            ${isSubscriptionOrder ? `
              <span class="badge-subscription-order">
                🧺 SUBSCRIPTION MEAL
              </span>
            ` : ''}
            ${isKitchenPremium ? `
              <span class="badge-premium-member">
                ⭐ PREMIUM MEMBER
              </span>
            ` : ''}
            ${order.is_express_delivery ? `
              <span class="badge-express-delivery">
                🚀 EXPRESS
              </span>
            ` : ''}
            <span class="badge-status ${order.order_status}">${order.order_status}</span>
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
            Total: ₹${order.net_amount ?? order.total_amount ?? order.grand_total ?? 0}
          </div>
        </div>

        ${order.utr_number || order.payment_screenshot ? `
          <div style="background: rgba(10, 10, 14, 0.4); padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border-color); margin-top: 6px; font-size: 0.8rem;">
            ${order.utr_number ? `<div><i class="fa-solid fa-receipt" style="color: var(--accent-gold);"></i> <strong>UTR Number:</strong> <code style="background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px;">${order.utr_number}</code></div>` : ''}
            ${order.payment_screenshot ? `
              <div style="margin-top: 6px;">
                <button type="button" class="btn-secondary-outline" onclick="app.viewFullScreenshot('${order.payment_screenshot}', 'Customer Payment Screenshot - Order #${order.order_number}')" style="padding: 4px 10px; font-size: 0.74rem;">
                  <i class="fa-solid fa-camera"></i> View Uploaded Payment Screenshot
                </button>
              </div>
            ` : ''}
          </div>
        ` : ''}

        ${isOwnerView && (order.payment_status.includes('Pending') || order.payment_status.includes('Verification')) ? `
          <div style="display: flex; gap: 6px; margin-top: 8px;">
            <button class="btn-sm-status" onclick="app.verifyOrderPayment('${order.id}', 'Paid (UPI Verified)', this)" style="background: rgba(76,175,80,0.2); color: #4CAF50; border: 1px solid #4CAF50; padding: 6px 12px; border-radius: 6px; font-weight: 700; font-size: 0.78rem; cursor: pointer; flex: 1;">
              <i class="fa-solid fa-circle-check"></i> Verify & Mark Paid
            </button>
            <button class="btn-sm-status" onclick="app.verifyOrderPayment('${order.id}', 'Payment Failed', this)" style="background: rgba(229,57,53,0.2); color: #E53935; border: 1px solid #E53935; padding: 6px 12px; border-radius: 6px; font-weight: 700; font-size: 0.78rem; cursor: pointer; flex: 1;">
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
              <button class="btn-primary-block" onclick="app.updateOrderStatus('${order.id}', 'Preparing', this)" style="flex: 2; padding: 8px; font-size: 0.82rem;">
                <i class="fa-solid fa-check"></i> Accept & Prepare
              </button>
              <button class="role-btn" onclick="app.updateOrderStatus('${order.id}', 'Rejected', this)" style="flex: 1; justify-content: center; border: 1px solid var(--color-unavailable); color: var(--color-unavailable);">
                Reject
              </button>
            ` : ''}

            ${isPreparing ? `
              <button class="btn-primary-block" onclick="app.updateOrderStatus('${order.id}', 'Ready', this)" style="flex: 1; padding: 8px; font-size: 0.82rem; background: linear-gradient(135deg, #0288D1, #0277BD);">
                <i class="fa-solid fa-bell"></i> Mark Ready for Serving
              </button>
            ` : ''}

            ${isReady ? `
              <button class="btn-primary-block" onclick="app.updateOrderStatus('${order.id}', 'Completed', this)" style="flex: 1; padding: 8px; font-size: 0.82rem; background: linear-gradient(135deg, #388E3C, #2E7D32);">
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

  renderSingleOrderCard(orderId) {
    const order = this.orders.find(o => o.id === orderId || o.order_number === orderId);
    if (!order) return;

    const cardElements = document.querySelectorAll(`[data-order-card-id="${order.id}"]`);
    if (!cardElements || cardElements.length === 0) {
      this.renderOrders();
      return;
    }

    let isVisibleInCurrentFilter = true;
    if (this.ownerOrderFilter === 'ACTIVE') {
      isVisibleInCurrentFilter = ['Received', 'Preparing', 'Ready'].includes(order.order_status);
    } else if (this.ownerOrderFilter === 'COMPLETED') {
      isVisibleInCurrentFilter = order.order_status === 'Completed';
    } else if (this.ownerOrderFilter === 'REJECTED') {
      isVisibleInCurrentFilter = ['Rejected', 'Cancelled'].includes(order.order_status);
    }
    isVisibleInCurrentFilter = isVisibleInCurrentFilter && this.filterSingleOrder(order, true);

    const newCardHTML = this.createOwnerOrderCardHTML(order);

    cardElements.forEach(card => {
      if (!isVisibleInCurrentFilter) {
        card.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
        card.style.opacity = '0';
        card.style.transform = 'scale(0.95)';
        setTimeout(() => {
          card.remove();
          const dashContainer = document.getElementById('ownerDashboardOrdersList');
          const listContainer = document.getElementById('ownerOrdersList');
          if ((dashContainer && !dashContainer.querySelector('[data-order-card-id]')) ||
              (listContainer && !listContainer.querySelector('[data-order-card-id]'))) {
            this.renderOrders();
          }
        }, 200);
      } else {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = newCardHTML;
        const newCardNode = tempDiv.firstElementChild;
        if (newCardNode) {
          card.parentNode.replaceChild(newCardNode, card);
        }
      }
    });

    this.renderSalesAnalytics();
  }

  async updateOrderStatus(orderId, newStatus, targetBtn = null) {
    const order = this.orders.find(o => o.id === orderId || o.order_number === orderId);
    if (!order) return;

    // 🚨 CRITICAL PIN REQUIREMENT: Intercept "Completed" status on unverified orders!
    if (newStatus === 'Completed' && !order.pickup_pin_verified) {
      this.openVerifyPinModal(order.id);
      return;
    }

    const key = `status_${order.id}`;
    if (this.processingOrders.has(key)) return;
    this.processingOrders.add(key);

    if (targetBtn && targetBtn.innerHTML) {
      targetBtn.disabled = true;
      targetBtn.setAttribute('data-orig-html', targetBtn.innerHTML);
      targetBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing...`;
    }

    const prevStatus = order.order_status;
    order.order_status = newStatus;
    this.renderSingleOrderCard(order.id);

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/orders/${order.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_status: newStatus })
      });
      const json = await res.json();
      if (json.success) {
        if (json.data) {
          Object.assign(order, json.data);
        }
        this.showToast(json.message || `Order status updated to ${newStatus}`, 'success');
        this.renderSingleOrderCard(order.id);
      } else {
        order.order_status = prevStatus;
        this.renderSingleOrderCard(order.id);
        this.showToast(json.message || 'Unable to update order. Please try again.', 'error');
      }
    } catch (err) {
      console.error('Error updating order status:', err);
      order.order_status = prevStatus;
      this.renderSingleOrderCard(order.id);
      this.showToast('Unable to update order. Please try again.', 'error');
    } finally {
      this.processingOrders.delete(key);
    }
  }

  openRejectOrderModal(orderId) {
    const order = this.orders.find(o => o.id === orderId || o.order_number === orderId);
    if (!order) return;

    const elId = document.getElementById('rejectTargetOrderId');
    const elNum = document.getElementById('rejectOrderNumDisplay');
    const elInput = document.getElementById('rejectOrderReasonInput');
    const backdrop = document.getElementById('rejectOrderModalBackdrop');

    if (elId) elId.value = order.id;
    if (elNum) elNum.innerText = `#${order.order_number}`;
    if (elInput) elInput.value = 'Items Out of Stock';
    if (backdrop) backdrop.classList.add('open');
  }

  closeRejectOrderModal() {
    const backdrop = document.getElementById('rejectOrderModalBackdrop');
    if (backdrop) backdrop.classList.remove('open');
  }

  setRejectReasonChip(reasonText) {
    const elInput = document.getElementById('rejectOrderReasonInput');
    if (elInput) elInput.value = reasonText;
  }

  async submitOrderRejection(e) {
    if (e) e.preventDefault();
    const orderId = document.getElementById('rejectTargetOrderId')?.value;
    const reason = document.getElementById('rejectOrderReasonInput')?.value || 'Rejected by Hotel Manager';

    if (!orderId) return;
    const order = this.orders.find(o => o.id === orderId || o.order_number === orderId);
    if (!order) return;

    const key = `status_${order.id}`;
    if (this.processingOrders.has(key)) return;
    this.processingOrders.add(key);

    const submitBtn = document.querySelector('#rejectOrderForm button[type="submit"]');
    let origSubmitHTML = '';
    if (submitBtn) {
      submitBtn.disabled = true;
      origSubmitHTML = submitBtn.innerHTML;
      submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Rejecting...`;
    }

    const prevStatus = order.order_status;
    const prevReason = order.rejection_reason;

    this.closeRejectOrderModal();
    order.order_status = 'Rejected';
    order.rejection_reason = reason;
    this.renderSingleOrderCard(order.id);

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/orders/${order.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_status: 'Rejected', rejection_reason: reason })
      });
      const json = await res.json();
      if (json.success) {
        if (json.data) {
          Object.assign(order, json.data);
        }
        this.showToast(json.message || `Order marked as Rejected. Moved to Rejected Orders.`, 'info');
        this.renderSingleOrderCard(order.id);
      } else {
        order.order_status = prevStatus;
        order.rejection_reason = prevReason;
        this.renderSingleOrderCard(order.id);
        this.showToast(json.message || 'Unable to reject order. Please try again.', 'error');
      }
    } catch (err) {
      console.error('Error rejecting order:', err);
      order.order_status = prevStatus;
      order.rejection_reason = prevReason;
      this.renderSingleOrderCard(order.id);
      this.showToast('Unable to reject order. Please try again.', 'error');
    } finally {
      this.processingOrders.delete(key);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = origSubmitHTML || 'Confirm Rejection';
      }
    }
  }

  async restoreRejectedOrder(orderId, targetBtn = null) {
    const order = this.orders.find(o => o.id === orderId || o.order_number === orderId);
    if (!order) return;

    if (!confirm(`Restore Order #${order.order_number} back to active kitchen queue?`)) return;

    const key = `status_${order.id}`;
    if (this.processingOrders.has(key)) return;
    this.processingOrders.add(key);

    if (targetBtn && targetBtn.innerHTML) {
      targetBtn.disabled = true;
      targetBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Restoring...`;
    }

    const prevStatus = order.order_status;
    order.order_status = 'Received';
    this.renderSingleOrderCard(order.id);

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/orders/${order.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_status: 'Received' })
      });
      const json = await res.json();
      if (json.success) {
        if (json.data) {
          Object.assign(order, json.data);
        }
        this.showToast(`Order #${order.order_number} restored to Received status!`, 'success');
        this.renderSingleOrderCard(order.id);
      } else {
        order.order_status = prevStatus;
        this.renderSingleOrderCard(order.id);
        this.showToast(json.message || 'Unable to restore order. Please try again.', 'error');
      }
    } catch (err) {
      console.error('Error restoring order:', err);
      order.order_status = prevStatus;
      this.renderSingleOrderCard(order.id);
      this.showToast('Unable to restore order. Please try again.', 'error');
    } finally {
      this.processingOrders.delete(key);
    }
  }

  // =========================================================================
  // OWNER TIFFIN MANAGEMENT CRUD
  // =========================================================================

  async handleTiffinImageSelect(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type.toLowerCase())) {
      this.showToast('❌ Invalid image format. Allowed: JPG, JPEG, PNG, WEBP', 'error');
      e.target.value = '';
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      this.showToast('❌ Image file size must be under 5MB', 'error');
      e.target.value = '';
      return;
    }

    try {
      const compressedDataUrl = await this.compressTiffinImage(file);
      this.selectedTiffinImageBase64 = compressedDataUrl;
      this.updateTiffinImagePreview(compressedDataUrl, file.name);
    } catch (err) {
      console.error('Error processing tiffin image:', err);
      this.showToast('❌ Failed to process selected image.', 'error');
    }
  }

  compressTiffinImage(file, maxWidth = 800, maxHeight = 800, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let width = img.width;
          let height = img.height;

          if (width > maxWidth || height > maxHeight) {
            if (width > height) {
              height = Math.round((height * maxWidth) / width);
              width = maxWidth;
            } else {
              width = Math.round((width * maxHeight) / height);
              height = maxHeight;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
          resolve(canvas.toDataURL(mimeType, quality));
        };
        img.onerror = (err) => reject(err);
        img.src = e.target.result;
      };
      reader.onerror = (err) => reject(err);
      reader.readAsDataURL(file);
    });
  }

  updateTiffinImagePreview(srcUrl, fileName = 'Tiffin Image') {
    const previewContainer = document.getElementById('tifImagePreviewContainer');
    const previewImg = document.getElementById('tifImagePreview');
    const previewName = document.getElementById('tifImagePreviewName');

    if (srcUrl) {
      if (previewImg) previewImg.src = srcUrl;
      if (previewName) previewName.innerText = fileName;
      if (previewContainer) previewContainer.style.display = 'flex';
    } else {
      if (previewContainer) previewContainer.style.display = 'none';
      if (previewImg) previewImg.src = '';
    }
  }

  removeSelectedTiffinImage() {
    this.selectedTiffinImageBase64 = '';
    const tifImageEl = document.getElementById('tifImage');
    if (tifImageEl) tifImageEl.value = '';
    const fileInput = document.getElementById('tifFileInput');
    if (fileInput) fileInput.value = '';
    this.updateTiffinImagePreview(null);
  }

  openAddTiffinModal() {
    document.getElementById('tiffinModalTitle').innerText = 'Add New Tiffin';
    document.getElementById('editTiffinId').value = '';
    document.getElementById('tifName').value = '';
    document.getElementById('tifDesc').value = '';
    document.getElementById('tifPrice').value = '';
    document.getElementById('tifCategory').value = 'Breakfast';
    document.getElementById('tifImage').value = '/images/idly_sambar.png';
    const fileInput = document.getElementById('tifFileInput');
    if (fileInput) fileInput.value = '';
    this.selectedTiffinImageBase64 = null;
    this.updateTiffinImagePreview('/images/idly_sambar.png', 'Default Tiffin Image');
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
    document.getElementById('tifImage').value = item.image || '';
    const fileInput = document.getElementById('tifFileInput');
    if (fileInput) fileInput.value = '';
    this.selectedTiffinImageBase64 = null;
    if (item.image) {
      this.updateTiffinImagePreview(item.image, item.name);
    } else {
      this.updateTiffinImagePreview(null);
    }
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

    const submitBtn = e.target.querySelector('button[type="submit"]');
    const origSubmitText = submitBtn ? submitBtn.innerHTML : 'Save Tiffin';

    const id = document.getElementById('editTiffinId').value;
    const name = document.getElementById('tifName').value;
    const desc = document.getElementById('tifDesc').value;
    const price = document.getElementById('tifPrice').value;
    const cat = document.getElementById('tifCategory').value;
    const existingImage = document.getElementById('tifImage').value;

    let finalImage = existingImage;
    if (this.selectedTiffinImageBase64 !== null && this.selectedTiffinImageBase64 !== undefined) {
      finalImage = this.selectedTiffinImageBase64;
    }
    if (!finalImage) {
      finalImage = '/images/idly_sambar.png';
    }

    const payload = {
      name,
      description: desc,
      price,
      category: cat,
      image: finalImage,
      is_available: this.formAvailability
    };

    try {
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
      }

      let res, json;
      if (id) {
        res = await this.fetchWithAuth(`${API_BASE}/menu/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } else {
        res = await this.fetchWithAuth(`${API_BASE}/menu`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

      json = await res.json();
      if (json.success) {
        this.showToast(json.message || `${name} has been saved successfully.`, 'success');
        this.toggleTiffinModal(false);
        await this.fetchMenu();
      } else {
        this.showToast(json.message || 'Failed to save tiffin item.', 'error');
      }
    } catch (err) {
      console.error('Error saving tiffin:', err);
      this.showToast('Error saving tiffin. Please try again.', 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = origSubmitText;
      }
    }
  }

  async toggleItemAvailability(itemId, isAvailable) {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/menu/${itemId}/availability`, {
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
      const res = await this.fetchWithAuth(`${API_BASE}/menu/${itemId}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message, 'success');
        await this.fetchMenu();
      }
    } catch (err) {
      console.error('Error deleting tiffin:', err);
    }
  }

  async deleteOrder(orderId, targetBtn = null) {
    const order = this.orders.find(o => o.id === orderId || o.order_number === orderId);
    if (!order) return;

    if (!confirm(`Are you sure you want to delete Order #${order.order_number}? This action cannot be undone.`)) return;

    const key = `delete_${order.id}`;
    if (this.processingOrders.has(key)) return;
    this.processingOrders.add(key);

    if (targetBtn && targetBtn.innerHTML) {
      targetBtn.disabled = true;
      targetBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Deleting...`;
    }

    const cardElements = document.querySelectorAll(`[data-order-card-id="${order.id}"]`);

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/orders/${order.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message || 'Order deleted successfully.', 'success');
        this.orders = this.orders.filter(o => o.id !== order.id);
        cardElements.forEach(card => {
          card.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
          card.style.opacity = '0';
          card.style.transform = 'scale(0.95)';
          setTimeout(() => card.remove(), 200);
        });
        setTimeout(() => {
          const dashContainer = document.getElementById('ownerDashboardOrdersList');
          const listContainer = document.getElementById('ownerOrdersList');
          if ((dashContainer && !dashContainer.querySelector('[data-order-card-id]')) ||
              (listContainer && !listContainer.querySelector('[data-order-card-id]'))) {
            this.renderOrders();
          } else {
            this.renderSalesAnalytics();
          }
        }, 250);
      } else {
        if (targetBtn) {
          targetBtn.disabled = false;
          targetBtn.innerHTML = targetBtn.getAttribute('data-orig-html') || targetBtn.innerHTML;
        }
        this.showToast(json.message || 'Unable to delete order. Please try again.', 'error');
      }
    } catch (err) {
      console.error('Error deleting order:', err);
      if (targetBtn) {
        targetBtn.disabled = false;
      }
      this.showToast('Unable to delete order. Please try again.', 'error');
    } finally {
      this.processingOrders.delete(key);
    }
  }

  async deleteSupportTicket(ticketId) {
    const targetId = ticketId || this.activeTicketId;
    const ticket = (this.supportTickets || []).find(t => t.id === targetId || t.ticket_number === targetId);
    if (!ticket) return;

    if (!confirm(`Are you sure you want to delete Support Ticket #${ticket.ticket_number}?`)) return;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/support/tickets/${ticket.id}`, { method: 'DELETE' });
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

    if (this.isLoadingPayments && !list.length) {
      if (elTotal) elTotal.innerText = 'Loading...';
      if (elUpi) elUpi.innerText = 'Loading...';
      if (elCash) elCash.innerText = 'Loading...';
      if (elPending) elPending.innerText = 'Loading...';
      tableBody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
            <i class="fa-solid fa-spinner fa-spin" style="font-size: 2.5rem; color: var(--accent-gold); margin-bottom: 0.75rem;"></i>
            <h3 style="color: #FFF; font-size: 1.1rem; margin-bottom: 0.25rem;">Loading Payment Records...</h3>
            <p style="font-size: 0.85rem;">Fetching database records...</p>
          </td>
        </tr>
      `;
      return;
    } else {
      if (elTotal) elTotal.innerText = `₹${totalAmount.toLocaleString('en-IN')}`;
      if (elUpi) elUpi.innerText = `₹${upiAmount.toLocaleString('en-IN')}`;
      if (elCash) elCash.innerText = `₹${cashAmount.toLocaleString('en-IN')}`;
      if (elPending) elPending.innerText = pendingCount;
    }

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

  formatPaymentDateTime(p) {
    let raw = p.created_at || p.order_date || p.date_time || p.timestamp;
    if (!raw && this.orders && p.order_number) {
      const matchingOrder = this.orders.find(o => o.order_number === p.order_number);
      if (matchingOrder) raw = matchingOrder.created_at || matchingOrder.order_date;
    }
    if (!raw) return 'Today';
    try {
      const d = new Date(raw);
      if (isNaN(d.getTime())) return String(raw);
      return d.toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
    } catch (e) {
      return String(raw);
    }
  }

  createPaymentTableRowHTML(p) {
    const isPaid = (p.payment_status || '').includes('Paid') || (p.payment_status || '').includes('Verified') || (p.payment_status || '').includes('Cash Received');
    const isPending = (p.payment_status || '').includes('Pending') || (p.payment_status || '').includes('Verification');
    const isUPI = (p.payment_method || '').includes('UPI') || (p.payment_method || '').includes('Online');
    const isSubscription = (p.order_number || '').startsWith('SUB-') || (p.payment_method || '').toUpperCase().includes('SUB');

    const statusBg = isPaid ? 'rgba(76, 175, 80, 0.15)' : isPending ? 'rgba(234, 162, 33, 0.15)' : 'rgba(229, 57, 53, 0.15)';
    const statusBorder = isPaid ? '#4CAF50' : isPending ? '#EAA221' : '#E53935';
    const statusColor = isPaid ? '#4CAF50' : isPending ? '#FFB74D' : '#FF5252';

    return `
      <tr class="${isSubscription ? 'table-row-subscription' : ''}" style="border-bottom: 1px solid var(--border-color); transition: background 0.2s ease;">
        <!-- 1. Order ID Column (OWNER SIDE: Order ID, Customer Name, Date & Time) -->
        <td style="padding: 14px 16px; vertical-align: middle;">
          <div style="font-weight: 800; font-size: 0.95rem; color: var(--accent-gold); display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <span><i class="fa-solid fa-receipt"></i> #${p.order_number}</span>
            ${isSubscription ? `<span class="badge-subscription-order" style="font-size: 0.7rem; padding: 2px 7px;">🧺 SUBSCRIPTION PLAN</span>` : ''}
          </div>
          <div style="font-size: 0.82rem; color: #FFF; font-weight: 600; margin-top: 3px;">
            <i class="fa-solid fa-user" style="color: var(--primary);"></i> ${p.customer_name || 'Customer'}
          </div>
          <div style="font-size: 0.74rem; color: var(--text-muted); margin-top: 3px;">
            <i class="fa-regular fa-clock"></i> ${this.formatPaymentDateTime(p)}
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
              <img src="${p.payment_screenshot}" onclick="app.viewFullScreenshot('${p.payment_screenshot}', 'Payment Proof - Order #${p.order_number}')" class="payment-screenshot-thumb" style="width: 48px; height: 48px; object-fit: cover; border-radius: 8px; border: 1.5px solid var(--accent-gold); cursor: pointer; transition: transform 0.2s ease;" title="Click to view full screenshot">
              <button type="button" class="btn-sm-status" onclick="app.viewFullScreenshot('${p.payment_screenshot}', 'Payment Proof - Order #${p.order_number}')" style="background: rgba(234, 162, 33, 0.15); color: var(--accent-gold); border: 1px solid rgba(234, 162, 33, 0.3); padding: 4px 10px; border-radius: 6px; font-size: 0.75rem; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;">
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

        <!-- 5. Action Column (Bill & Delete) -->
        <td style="padding: 14px 16px; vertical-align: middle; text-align: center;">
          <div style="display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap;">
            <button type="button" class="btn-sm-status" onclick="app.downloadSinglePaymentVoucher('${p.order_number}')" style="background: linear-gradient(135deg, #EAA221, #D9531E); color: #FFFFFF; border: none; padding: 7px 12px; border-radius: 8px; font-size: 0.78rem; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 4px 12px rgba(217, 83, 30, 0.35); transition: transform 0.15s ease;" title="Print or Download Invoice / Bill">
              <i class="fa-solid fa-file-invoice"></i> Action (Bill)
            </button>
            <button type="button" class="btn-sm-status btn-del-pay-${p.id}" onclick="app.confirmDeleteSinglePaymentOwner('${p.id}', '${p.order_number}')" style="background: rgba(229, 57, 53, 0.16); color: #FF5252; border: 1.5px solid rgba(229, 57, 53, 0.4); padding: 7px 12px; border-radius: 8px; font-size: 0.78rem; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s ease;" title="Delete this payment record from Financial Ledger">
              <i class="fa-solid fa-trash-can"></i> 🗑️ Delete
            </button>
          </div>
        </td>
      </tr>
    `;
  }

  confirmDeleteSinglePaymentOwner(paymentId, orderNum) {
    if (!this.currentUser || this.currentUser.role !== 'OWNER') {
      this.showToast('Unauthorized action', 'error');
      return;
    }

    const modalBackdrop = document.createElement('div');
    modalBackdrop.className = 'confirm-modal-backdrop';
    modalBackdrop.id = 'ownerDeleteSinglePayModal';
    modalBackdrop.style.position = 'fixed';
    modalBackdrop.style.inset = '0';
    modalBackdrop.style.background = 'rgba(0, 0, 0, 0.75)';
    modalBackdrop.style.backdropFilter = 'blur(4px)';
    modalBackdrop.style.zIndex = '99999';
    modalBackdrop.style.display = 'flex';
    modalBackdrop.style.alignItems = 'center';
    modalBackdrop.style.justifyContent = 'center';
    modalBackdrop.style.padding = '1rem';

    modalBackdrop.innerHTML = `
      <div style="background: var(--bg-surface-elevated, #1A1A24); border: 1.5px solid rgba(229, 57, 53, 0.5); border-radius: 16px; max-width: 440px; width: 100%; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.8); text-align: center; color: #FFF;">
        <div style="width: 56px; height: 56px; background: rgba(229, 57, 53, 0.15); color: #FF5252; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.6rem; margin: 0 auto 16px auto;">
          ⚠️
        </div>
        <h3 style="font-size: 1.25rem; font-weight: 900; color: #FFF; margin: 0 0 10px 0;">Delete Payment Record?</h3>
        <p style="font-size: 0.88rem; color: #DDD; line-height: 1.5; margin: 0 0 14px 0;">
          Are you sure you want to delete this payment record for <strong>Order #${orderNum}</strong> from the Financial Ledger & Payment History?
        </p>
        <div style="background: rgba(255, 152, 0, 0.1); border: 1px dashed rgba(255, 152, 0, 0.4); padding: 10px; border-radius: 8px; font-size: 0.8rem; color: #FFB74D; margin-bottom: 20px; text-align: left;">
          ℹ️ <strong>IMPORTANT:</strong> The order record (Order #${orderNum}) and customer data will <strong>NOT</strong> be deleted.
        </div>
        <p style="font-size: 0.78rem; color: var(--text-muted); margin-bottom: 20px;">This action cannot be undone.</p>
        <div style="display: flex; gap: 12px;">
          <button type="button" onclick="document.getElementById('ownerDeleteSinglePayModal').remove()" style="flex: 1; padding: 10px; background: rgba(255,255,255,0.08); color: #FFF; border: 1px solid var(--border-color); border-radius: 8px; font-weight: 700; cursor: pointer;">
            Cancel
          </button>
          <button type="button" id="btnConfirmDelSinglePay" onclick="app.executeDeleteSinglePaymentOwner('${paymentId}', '${orderNum}')" style="flex: 1; padding: 10px; background: linear-gradient(135deg, #E53935, #C62828); color: #FFF; border: none; border-radius: 8px; font-weight: 800; cursor: pointer; box-shadow: 0 4px 12px rgba(229,57,53,0.4);">
            Delete
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modalBackdrop);
  }

  async executeDeleteSinglePaymentOwner(paymentId, orderNum) {
    const btn = document.getElementById('btnConfirmDelSinglePay');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ⏳ Deleting...`;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/payments/${paymentId}`, {
        method: 'DELETE'
      });
      const json = await res.json();

      if (json.success) {
        this.showToast('✅ Payment record deleted successfully.', 'success');
        const modal = document.getElementById('ownerDeleteSinglePayModal');
        if (modal) modal.remove();
        await this.fetchPayments(true);
      } else {
        this.showToast(json.message || '❌ Payment could not be deleted. Please try again.', 'error');
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = 'Delete';
        }
      }
    } catch (err) {
      console.error('Error executing payment deletion:', err);
      this.showToast('❌ Payment could not be deleted. Please try again.', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = 'Delete';
      }
    }
  }

  confirmDeleteAllPaymentsOwner() {
    if (!this.currentUser || this.currentUser.role !== 'OWNER') {
      this.showToast('Unauthorized action', 'error');
      return;
    }

    if (!this.payments || !this.payments.length) {
      this.showToast('No payment records to delete.', 'info');
      return;
    }

    const modalBackdrop = document.createElement('div');
    modalBackdrop.className = 'confirm-modal-backdrop';
    modalBackdrop.id = 'ownerDeleteAllPayModal';
    modalBackdrop.style.position = 'fixed';
    modalBackdrop.style.inset = '0';
    modalBackdrop.style.background = 'rgba(0, 0, 0, 0.8)';
    modalBackdrop.style.backdropFilter = 'blur(5px)';
    modalBackdrop.style.zIndex = '99999';
    modalBackdrop.style.display = 'flex';
    modalBackdrop.style.alignItems = 'center';
    modalBackdrop.style.justifyContent = 'center';
    modalBackdrop.style.padding = '1rem';

    modalBackdrop.innerHTML = `
      <div style="background: var(--bg-surface-elevated, #1A1A24); border: 2px solid #E53935; border-radius: 16px; max-width: 450px; width: 100%; padding: 24px; box-shadow: 0 12px 36px rgba(0,0,0,0.9); text-align: center; color: #FFF;">
        <div style="width: 60px; height: 60px; background: rgba(229, 57, 53, 0.2); color: #FF5252; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.8rem; margin: 0 auto 16px auto;">
          ⚠️
        </div>
        <h3 style="font-size: 1.3rem; font-weight: 900; color: #FF5252; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 0.5px;">DELETE ALL PAYMENTS?</h3>
        <p style="font-size: 0.9rem; color: #DDD; line-height: 1.5; margin: 0 0 14px 0;">
          This will permanently delete all <strong>${this.payments.length}</strong> payment records from the Financial Ledger & Payment History.
        </p>
        <div style="background: rgba(76, 175, 80, 0.12); border: 1.5px solid #4CAF50; padding: 12px; border-radius: 10px; font-size: 0.84rem; color: #81C784; margin-bottom: 20px; text-align: left;">
          ✅ <strong>IMPORTANT:</strong> Orders will <strong>NOT</strong> be deleted or modified in any way.
        </div>
        <p style="font-size: 0.8rem; color: #FF5252; font-weight: 700; margin-bottom: 20px;">This action cannot be undone.</p>
        <div style="display: flex; gap: 12px;">
          <button type="button" onclick="document.getElementById('ownerDeleteAllPayModal').remove()" style="flex: 1; padding: 11px; background: rgba(255,255,255,0.08); color: #FFF; border: 1px solid var(--border-color); border-radius: 8px; font-weight: 700; cursor: pointer;">
            Cancel
          </button>
          <button type="button" id="btnConfirmDelAllPay" onclick="app.executeDeleteAllPaymentsOwner()" style="flex: 1; padding: 11px; background: linear-gradient(135deg, #D32F2F, #B71C1C); color: #FFF; border: none; border-radius: 8px; font-weight: 900; cursor: pointer; box-shadow: 0 4px 14px rgba(211,47,47,0.5);">
            DELETE ALL
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modalBackdrop);
  }

  async executeDeleteAllPaymentsOwner() {
    const btn = document.getElementById('btnConfirmDelAllPay');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ⏳ Deleting...`;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/payments`, {
        method: 'DELETE'
      });
      const json = await res.json();

      if (json.success) {
        this.showToast('✅ All payment records deleted successfully.', 'success');
        const modal = document.getElementById('ownerDeleteAllPayModal');
        if (modal) modal.remove();
        await this.fetchPayments(true);
      } else {
        this.showToast(json.message || '❌ Payments could not be deleted. Please try again.', 'error');
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = 'DELETE ALL';
        }
      }
    } catch (err) {
      console.error('Error executing delete all payments:', err);
      this.showToast('❌ Payments could not be deleted. Please try again.', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = 'DELETE ALL';
      }
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
    // If settings not yet loaded, fetch from server and return — will re-populate once loaded
    if (!this.settings || Object.keys(this.settings).length === 0) {
      this.fetchSettings();
      return;
    }

    const s = this.settings;

    const elName = document.getElementById('setHotelName');
    const elPhone = document.getElementById('setPhone');
    const elAddr = document.getElementById('setAddr');
    const elOpen = document.getElementById('setOpenTime');
    const elClose = document.getElementById('setCloseTime');
    const elHolidays = document.getElementById('setHolidays');
    const elUpi = document.getElementById('setUpiId');
    const elDesc = document.getElementById('setDesc');

    // Only set value if element exists — set exact loaded values including empty strings
    if (elName && s.hotel_name !== undefined) elName.value = s.hotel_name !== null ? s.hotel_name : '';
    if (elPhone && s.phone !== undefined) elPhone.value = s.phone !== null ? s.phone : '';
    if (elAddr && s.address !== undefined) elAddr.value = s.address !== null ? s.address : '';
    if (elOpen && s.open_time !== undefined) elOpen.value = s.open_time !== null ? s.open_time : '';
    if (elClose && s.close_time !== undefined) elClose.value = s.close_time !== null ? s.close_time : '';
    if (elHolidays && s.holidays !== undefined) elHolidays.value = s.holidays !== null ? s.holidays : '';
    if (elUpi && s.upi_id !== undefined) elUpi.value = s.upi_id !== null ? s.upi_id : '';
    if (elDesc && s.description !== undefined) elDesc.value = s.description !== null ? s.description : '';

    // Populate Owner Profile Photo Display
    const ownerRing = document.getElementById('ownerAvatarRing');
    const ownerImg = document.getElementById('ownerAvatarImg');
    const ownerInitials = document.getElementById('ownerAvatarInitials');
    const ownerRemoveBtn = document.getElementById('btnOwnerRemovePhoto');
    const ownerUploadBtnLabel = document.getElementById('lblOwnerPhotoBtn');
    const ownerNameDisp = document.getElementById('ownerProfileNameDisplay');

    if (this.currentUser) {
      if (ownerNameDisp) ownerNameDisp.innerText = this.currentUser.name || 'Hotel Owner / Admin';
      if (this.currentUser.profile_photo) {
        if (ownerRing) ownerRing.classList.add('has-photo');
        if (ownerImg) {
          ownerImg.src = this.currentUser.profile_photo;
          ownerImg.classList.remove('hidden');
        }
        if (ownerInitials) ownerInitials.classList.add('hidden');
        if (ownerRemoveBtn) ownerRemoveBtn.classList.remove('hidden');
        if (ownerUploadBtnLabel) ownerUploadBtnLabel.innerText = 'Change Photo';
      } else {
        if (ownerRing) ownerRing.classList.remove('has-photo');
        if (ownerImg) {
          ownerImg.src = '';
          ownerImg.classList.add('hidden');
        }
        if (ownerInitials) ownerInitials.classList.remove('hidden');
        if (ownerRemoveBtn) ownerRemoveBtn.classList.add('hidden');
        if (ownerUploadBtnLabel) ownerUploadBtnLabel.innerText = 'Upload Photo';
      }
    }

    // Mark form as populated so background polling does not overwrite active user input while editing
    this.isSettingsFormPopulated = true;

    // QR preview image
    const qrImg = document.getElementById('setQrPreviewImg');
    if (qrImg) {
      const qrSrc = (this.tempOwnerQrCode !== undefined && this.tempOwnerQrCode !== null) ? this.tempOwnerQrCode : (s.upi_qr_code || '');
      if (qrSrc) {
        qrImg.src = qrSrc;
        qrImg.style.display = 'block';
      } else {
        qrImg.src = '';
        qrImg.style.display = 'none';
      }
    }

    // Store Open/Closed Switch
    const storeSwitch = document.getElementById('settingHotelOpenSwitch');
    const storeLabel = document.getElementById('settingHotelOpenLabel');
    const isOpen = Boolean(s.is_open !== false);
    if (storeSwitch) storeSwitch.classList.toggle('active', isOpen);
    if (storeLabel) storeLabel.innerText = isOpen ? '🟢 HOTEL OPEN' : '🔴 HOTEL CLOSED';

    // QR Pay & PhonePe switches
    const swQr = document.getElementById('setQrPayEnabledSwitch');
    const lblQr = document.getElementById('setQrPayEnabledLabel');
    const isQrEnabled = s.is_qr_pay_enabled !== false;
    if (swQr) swQr.classList.toggle('active', isQrEnabled);
    if (lblQr) lblQr.innerText = isQrEnabled ? '🟢 ON' : '🔴 OFF';

    const swPhonePe = document.getElementById('setPhonePeEnabledSwitch');
    const lblPhonePe = document.getElementById('setPhonePeEnabledLabel');
    const isPhonePeEnabled = s.is_phonepe_enabled !== false;
    if (swPhonePe) swPhonePe.classList.toggle('active', isPhonePeEnabled);
    if (lblPhonePe) lblPhonePe.innerText = isPhonePeEnabled ? '🟢 ON' : '🔴 OFF';

    // Referral Program Settings Controls
    let ref = s.referral || {};
    if (typeof ref === 'string') {
      try { ref = JSON.parse(ref); } catch (e) { ref = {}; }
    }
    const swEnabled = document.getElementById('setRefEnabledSwitch');
    const lblEnabled = document.getElementById('setRefEnabledLabel');
    const elReward = document.getElementById('setRefReferrerReward');
    const elDiscount = document.getElementById('setRefCustomerDiscount');
    const elMinOrder = document.getElementById('setRefMinOrderValue');
    const elLimit = document.getElementById('setRefMonthlyLimit');

    if (swEnabled) swEnabled.classList.toggle('active', ref.enabled !== false);
    if (lblEnabled) lblEnabled.innerText = ref.enabled !== false ? '🟢 PROGRAM ON' : '🔴 PROGRAM OFF';
    if (elReward) {
      const rawReward = (ref.referrer_reward !== undefined && ref.referrer_reward !== null && ref.referrer_reward !== '') ? Number(ref.referrer_reward) : 10;
      const activeRewardVal = (!isNaN(rawReward) && isFinite(rawReward) && rawReward > 0) ? rawReward : 10;
      elReward.value = activeRewardVal;
      this.highlightReferralPreset(activeRewardVal);
    }
    if (elDiscount) elDiscount.value = ref.new_customer_discount ?? 30;
    if (elMinOrder) elMinOrder.value = ref.min_order_value ?? 150;
    if (elLimit) elLimit.value = ref.monthly_limit ?? 500;
  }

  highlightReferralPreset(val) {
    const numVal = Number(val);
    document.querySelectorAll('.ref-preset-btn').forEach(btn => {
      const btnAmt = Number(btn.innerText.replace('₹', '').trim());
      btn.classList.toggle('active', !isNaN(numVal) && btnAmt === numVal);
    });
  }

  setReferralAmountPreset(amt) {
    const el = document.getElementById('setRefReferrerReward');
    if (el) {
      el.value = amt;
      this.highlightReferralPreset(amt);
    }
  }

  saveBusinessSettings(e) {
    return this.saveSettings(e);
  }

  async saveSettings(e) {
    if (e) e.preventDefault();
    if (this.isSavingSettings) return;

    // Read all switch states directly from DOM to ensure we capture latest user intent
    const swEnabled = document.getElementById('setRefEnabledSwitch');
    const refEnabled = swEnabled ? swEnabled.classList.contains('active') : (this.settings?.referral?.enabled !== false);

    const swQr = document.getElementById('setQrPayEnabledSwitch');
    const isQrEnabled = swQr ? swQr.classList.contains('active') : (this.settings ? (this.settings.is_qr_pay_enabled !== false) : true);

    const swPhonePe = document.getElementById('setPhonePeEnabledSwitch');
    const isPhonePeEnabled = swPhonePe ? swPhonePe.classList.contains('active') : (this.settings ? (this.settings.is_phonepe_enabled !== false) : true);

    const storeSwitch = document.getElementById('settingHotelOpenSwitch');
    const isHotelOpen = storeSwitch ? storeSwitch.classList.contains('active') : (this.settings ? (this.settings.is_open !== false) : true);

    let qrVal = this.settings ? (this.settings.upi_qr_code || '') : '';
    if (this.tempOwnerQrCode !== undefined && this.tempOwnerQrCode !== null) {
      qrVal = this.tempOwnerQrCode;
    }

    const hotelNameInput = document.getElementById('setHotelName')?.value;
    const phoneInput = document.getElementById('setPhone')?.value;
    const addrInput = document.getElementById('setAddr')?.value;
    const openTimeInput = document.getElementById('setOpenTime')?.value;
    const closeTimeInput = document.getElementById('setCloseTime')?.value;
    const holidaysInput = document.getElementById('setHolidays')?.value;
    const upiIdInput = document.getElementById('setUpiId')?.value;
    const descInput = document.getElementById('setDesc')?.value;

    const openTimeTrim = (openTimeInput || '').trim();
    const closeTimeTrim = (closeTimeInput || '').trim();
    const timeRegex = /^(0?[1-9]|1[0-2]):[0-5][0-9]\s*(AM|PM|am|pm)$|^(0?[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$/i;
    if (openTimeTrim !== '' && !timeRegex.test(openTimeTrim)) {
      this.showToast("❌ Unable to update Business Settings. Invalid Opening Time format (e.g. 06:00 AM).", "error");
      return;
    }
    if (closeTimeTrim !== '' && !timeRegex.test(closeTimeTrim)) {
      this.showToast("❌ Unable to update Business Settings. Invalid Closing Time format (e.g. 10:00 PM).", "error");
      return;
    }

    const upiIdTrim = (upiIdInput || '').trim();
    const upiVpaRegex = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
    if (upiIdTrim !== '' && !upiVpaRegex.test(upiIdTrim)) {
      this.showToast("❌ Unable to update Business Settings. Please enter a valid UPI VPA address.", "error");
      return;
    }

    const refRewardRaw = document.getElementById('setRefReferrerReward')?.value;
    const refRewardNum = Number(refRewardRaw);
    if (refRewardRaw === '' || refRewardRaw === null || refRewardRaw === undefined || isNaN(refRewardNum) || !isFinite(refRewardNum) || refRewardNum <= 0) {
      this.showToast("❌ Unable to update Business Settings. Referral Amount must be a valid positive monetary value greater than 0.", "error");
      return;
    }

    const submitBtns = document.querySelectorAll('#settingsForm button[type="submit"]');
    this.isSavingSettings = true;
    submitBtns.forEach(btn => {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    });

    const payload = {
      hotel_name: hotelNameInput !== undefined ? hotelNameInput : '',
      phone: phoneInput !== undefined ? phoneInput : '',
      address: addrInput !== undefined ? addrInput : '',
      open_time: openTimeInput !== undefined ? openTimeInput : '',
      close_time: closeTimeInput !== undefined ? closeTimeInput : '',
      holidays: holidaysInput !== undefined ? holidaysInput : '',
      upi_id: upiIdInput !== undefined ? upiIdInput : '',
      description: descInput !== undefined ? descInput : '',
      upi_qr_code: qrVal,
      remove_qr: Boolean(this.isQrRemovedFlag),
      is_open: isHotelOpen,
      is_qr_pay_enabled: isQrEnabled,
      is_phonepe_enabled: isPhonePeEnabled,
      referral: {
        enabled: refEnabled,
        referrer_reward: refRewardNum,
        new_customer_discount: Number(document.getElementById('setRefCustomerDiscount')?.value ?? (this.settings?.referral?.new_customer_discount ?? 30)),
        min_order_value: Number(document.getElementById('setRefMinOrderValue')?.value ?? (this.settings?.referral?.min_order_value ?? 150)),
        monthly_limit: Number(document.getElementById('setRefMonthlyLimit')?.value ?? (this.settings?.referral?.monthly_limit ?? 500))
      }
    };

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (json.success) {
        this.settings = json.settings || json.data;
        this.tempOwnerQrCode = null;
        this.isQrRemovedFlag = false;
        this.isSettingsFormPopulated = false;
        this.updateHeaderAndSettingsUI();
        this.populateSettingsForm();
        this.showToast('✓ Business Settings updated successfully.', 'success');
      } else {
        this.showToast(json.message || '❌ Unable to update Business Settings.', 'error');
      }
    } catch (err) {
      console.error('Error saving settings:', err);
      this.showToast('❌ Unable to update Business Settings.', 'error');
    } finally {
      this.isSavingSettings = false;
      submitBtns.forEach(btn => {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Changes`;
      });
    }
  }

  async saveUpiVpaSetting() {
    const upiInput = document.getElementById('setUpiId')?.value;
    const upiIdTrim = (upiInput || '').trim();
    const upiVpaRegex = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z0-9.\-_]{2,64}$/i;

    if (upiIdTrim !== '' && !upiVpaRegex.test(upiIdTrim)) {
      this.showToast("❌ Unable to update Business Settings. Please enter a valid UPI VPA address.", "error");
      return;
    }

    const btn = document.getElementById('btnSaveUpiVpa');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upi_id: upiInput !== undefined ? upiInput : '' })
      });
      const json = await res.json();
      if (json.success) {
        this.settings = json.settings || json.data;
        this.isSettingsFormPopulated = false;
        this.updateHeaderAndSettingsUI();
        this.populateSettingsForm();
        this.showToast('✓ Business Settings updated successfully.', 'success');
      } else {
        this.showToast(json.message || '❌ Unable to update Business Settings.', 'error');
      }
    } catch (err) {
      console.error('Error updating UPI VPA:', err);
      this.showToast('❌ Unable to update Business Settings.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Changes`;
      }
    }
  }

  async saveReferralAmountSetting() {
    const refRewardRaw = document.getElementById('setRefReferrerReward')?.value;
    const refRewardNum = Number(refRewardRaw);

    if (refRewardRaw === '' || refRewardRaw === null || refRewardRaw === undefined || isNaN(refRewardNum) || !isFinite(refRewardNum) || refRewardNum <= 0) {
      this.showToast("❌ Unable to update Business Settings. Referral Amount must be a valid positive monetary value greater than 0.", "error");
      return;
    }

    const btn = document.getElementById('btnSaveReferralAmount');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    }

    try {
      let existingRef = this.settings?.referral || {};
      if (typeof existingRef === 'string') {
        try { existingRef = JSON.parse(existingRef); } catch (e) { existingRef = {}; }
      }
      const payload = {
        referral: {
          ...existingRef,
          referrer_reward: refRewardNum
        }
      };

      const res = await this.fetchWithAuth(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (json.success) {
        this.settings = json.settings || json.data;
        this.isSettingsFormPopulated = false;
        this.updateHeaderAndSettingsUI();
        this.populateSettingsForm();
        this.showToast('✓ Business Settings updated successfully.', 'success');
      } else {
        this.showToast(json.message || '❌ Unable to update Business Settings.', 'error');
      }
    } catch (err) {
      console.error('Error updating Referral Amount:', err);
      this.showToast('❌ Unable to update Business Settings.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save`;
      }
    }
  }

  // Returns the QR scanner URL ready for <img> display with cache-busting.
  // Base64 data URLs are returned as-is (no cache issue); file URLs get a ?t= suffix
  // using upi_qr_updated_at so a replaced scanner is always fetched fresh.
  getQrDisplayUrl() {
    const qrCode = this.settings?.upi_qr_code || '';
    if (!qrCode) return '';
    if (qrCode.startsWith('data:')) return qrCode;
    const updatedAt = this.settings?.upi_qr_updated_at || Date.now();
    return qrCode.includes('?') ? `${qrCode}&t=${updatedAt}` : `${qrCode}?t=${updatedAt}`;
  }

  updateHeaderAndSettingsUI() {
    if (!this.settings) return;
    const name = this.settings.hotel_name || 'Sri Lakshmi Annapurna Tiffin Center';
    const phone = this.settings.phone || '';
    const addr = this.settings.address || '';
    const desc = this.settings.description || '';
    const openT = this.settings.open_time || '';
    const closeT = this.settings.close_time || '';
    const holidays = this.settings.holidays || '';
    const upi = this.settings.upi_id || 'annapurna@upi';
    const qrCode = this.settings.upi_qr_code || '';

    // Header & Sidebar
    const elHeaderName = document.getElementById('headerHotelName');
    const elSidebarName = document.getElementById('sidebarHotelName');
    const elMobileDrawerName = document.getElementById('mobileDrawerHotelName');
    const elHeaderAddr = document.getElementById('headerAddress');
    if (elHeaderName) elHeaderName.innerText = name;
    if (elSidebarName) elSidebarName.innerText = name;
    if (elMobileDrawerName) elMobileDrawerName.innerText = name;
    if (elHeaderAddr) elHeaderAddr.innerText = addr.split(',')[0] || addr;

    // Hero Home Section Banner
    const elBannerGreeting = document.getElementById('bannerGreeting');
    const elBannerDesc = document.getElementById('bannerDesc');
    if (elBannerGreeting && (!this.currentUser || this.currentRole !== 'CUSTOMER')) {
      elBannerGreeting.innerText = `Welcome to ${name}! 🍲`;
    }
    if (elBannerDesc && desc) elBannerDesc.innerText = desc;

    // Hero Home Section Details
    const elHeroTitle = document.getElementById('heroHotelTitle');
    const elHeroDesc = document.getElementById('heroHotelDescription');
    const elHeroAddr = document.getElementById('heroHotelAddress');
    const elHeroPhone = document.getElementById('heroHotelPhone');
    const elHeroHours = document.getElementById('heroOperatingHours');
    const elHeroHolidays = document.getElementById('heroHolidays');
    if (elHeroTitle) elHeroTitle.innerText = name;
    if (elHeroDesc && desc) elHeroDesc.innerText = desc;
    if (elHeroAddr) elHeroAddr.innerText = addr;
    if (elHeroPhone) elHeroPhone.innerText = phone;
    if (elHeroHours) elHeroHours.innerText = `${openT} - ${closeT}`;
    if (elHeroHolidays) elHeroHolidays.innerText = holidays;

    // Helpline Links & Support Cards
    const elHelplinePhone = document.getElementById('drawerHelplinePhone');
    if (elHelplinePhone) elHelplinePhone.innerText = `${phone} (${holidays || 'Open 7 Days'})`;

    const elSupportPhone = document.getElementById('supportCardPhone');
    const elSupportHours = document.getElementById('supportCardHours');
    if (elSupportPhone) elSupportPhone.innerText = phone;
    if (elSupportHours) elSupportHours.innerText = `${holidays ? holidays + ': ' : 'Mon - Sun: '}${openT} - ${closeT}`;

    // Footer Timings & Contact Info
    const elFooterOpen = document.getElementById('footerOpenTime');
    const elFooterClose = document.getElementById('footerCloseTime');
    const elFooterHolidays = document.getElementById('footerHolidays');
    const elFooterPhone = document.getElementById('footerPhone');
    const elFooterAddr = document.getElementById('footerAddress');
    const elFooterUpi = document.getElementById('footerUpi');
    if (elFooterOpen) elFooterOpen.innerText = openT;
    if (elFooterClose) elFooterClose.innerText = closeT;
    if (elFooterHolidays) elFooterHolidays.innerText = holidays || 'Open 7 Days a Week';
    if (elFooterPhone) elFooterPhone.innerText = phone;
    if (elFooterAddr) elFooterAddr.innerText = addr;
    if (elFooterUpi) elFooterUpi.innerText = upi;

    // Checkout & Payment
    const elCheckoutUpi = document.getElementById('checkoutUpiIdDisplay');
    if (elCheckoutUpi) elCheckoutUpi.innerText = upi;

    const cacheBustQr = this.getQrDisplayUrl();

    const checkoutQr = document.getElementById('checkoutQrScannerImg');
    const checkoutQrWrapper = document.getElementById('checkoutQrWrapper');
    const checkoutQrUnavail = document.getElementById('checkoutQrUnavailableMsg');
    if (checkoutQr) {
      if (qrCode) {
        if (checkoutQr.getAttribute('data-raw-src') !== cacheBustQr) {
          checkoutQr.src = cacheBustQr;
          checkoutQr.setAttribute('data-raw-src', cacheBustQr);
        }
        checkoutQr.style.display = 'block';
        if (checkoutQrWrapper) checkoutQrWrapper.style.display = 'block';
        if (checkoutQrUnavail) checkoutQrUnavail.classList.add('hidden');
        // If the saved scanner points to a file that no longer exists (e.g. after a
        // server restart on ephemeral storage), fall back to the "unavailable" notice.
        checkoutQr.onerror = () => {
          checkoutQr.style.display = 'none';
          if (checkoutQrWrapper) checkoutQrWrapper.style.display = 'none';
          if (checkoutQrUnavail) checkoutQrUnavail.classList.remove('hidden');
        };
      } else {
        checkoutQr.src = '';
        checkoutQr.removeAttribute('data-raw-src');
        checkoutQr.onerror = null;
        checkoutQr.style.display = 'none';
        if (checkoutQrWrapper) checkoutQrWrapper.style.display = 'none';
        if (checkoutQrUnavail) checkoutQrUnavail.classList.remove('hidden');
      }
    }

    const setQr = document.getElementById('setQrPreviewImg');
    if (setQr) {
      const displayQr = (this.tempOwnerQrCode !== undefined && this.tempOwnerQrCode !== null) ? this.tempOwnerQrCode : cacheBustQr;
      if (displayQr) {
        if (setQr.getAttribute('data-raw-src') !== displayQr) {
          setQr.src = displayQr;
          setQr.setAttribute('data-raw-src', displayQr);
        }
        setQr.style.display = 'block';
        setQr.onerror = () => { setQr.style.display = 'none'; };
      } else {
        setQr.src = '';
        setQr.removeAttribute('data-raw-src');
        setQr.onerror = null;
        setQr.style.display = 'none';
      }
    }

    // Master Switch UI
    const mSwitch = document.getElementById('masterHotelSwitch') || document.getElementById('settingHotelOpenSwitch');
    const mText = document.getElementById('masterHotelStatusText') || document.getElementById('settingHotelOpenLabel');
    const tag = document.getElementById('customerHotelStatusTag');

    const isOpen = Boolean(this.settings.is_open);
    if (mSwitch) mSwitch.classList.toggle('active', isOpen);
    if (mText) mText.innerText = isOpen ? '🟢 HOTEL OPEN' : '🔴 HOTEL CLOSED';

    if (tag) {
      tag.className = `hotel-status-tag ${isOpen ? 'open' : 'closed'}`;
      tag.innerHTML = isOpen ? `<i class="fa-solid fa-circle"></i> <span>🟢 HOTEL OPEN - Taking Orders</span>`
        : `<i class="fa-solid fa-circle"></i> <span>🔴 HOTEL CLOSED - Currently Closed</span>`;
    }

    // Owner Payment Control Switches (QR Pay & PhonePe)
    const isQrEnabled = this.settings.is_qr_pay_enabled !== false;
    const isPhonePeEnabled = this.settings.is_phonepe_enabled !== false;

    const swQr = document.getElementById('setQrPayEnabledSwitch');
    const lblQr = document.getElementById('setQrPayEnabledLabel');
    if (swQr) swQr.classList.toggle('active', isQrEnabled);
    if (lblQr) lblQr.innerText = isQrEnabled ? '🟢 ON' : '🔴 OFF';

    const swPhonePe = document.getElementById('setPhonePeEnabledSwitch');
    const lblPhonePe = document.getElementById('setPhonePeEnabledLabel');
    if (swPhonePe) swPhonePe.classList.toggle('active', isPhonePeEnabled);
    if (lblPhonePe) lblPhonePe.innerText = isPhonePeEnabled ? '🟢 ON' : '🔴 OFF';

    this.updateOnlinePaymentOptionsVisibility();
  }

  zoomCheckoutQrCode() {
    const checkoutImg = document.getElementById('checkoutQrScannerImg');
    const qrCode = this.getQrDisplayUrl() || checkoutImg?.getAttribute('data-raw-src') || checkoutImg?.src || '';

    if (!qrCode) {
      this.showToast('Online payment scanner is currently unavailable.', 'info');
      return;
    }

    this.viewFullScreenshot(qrCode, 'Owner UPI QR Code Scanner');
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
      if (p.customer_id && p.customer_id === this.currentUser.id) return true;
      if (p.customer_mobile && p.customer_mobile.replace(/[^0-9]/g, '') === userMobileClean) return true;
      const matchingOrder = (this.orders || []).find(o => o.order_number === p.order_number);
      if (matchingOrder && matchingOrder.customer_mobile && matchingOrder.customer_mobile.replace(/[^0-9]/g, '') === userMobileClean) return true;
      return false;
    });

    // Summary stats
    const totalSpent = list.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const paidCount = list.filter(p => (p.payment_status || '').includes('Paid') || (p.payment_status || '').includes('Verified') || (p.payment_status || '').includes('Cash Received')).length;
    const pendingCount = list.filter(p => (p.payment_status || '').includes('Pending') || (p.payment_status || '').includes('Verification')).length;

    const elTotal = document.getElementById('custPayStatTotal');
    const elPaid = document.getElementById('custPayStatPaid');
    const elPending = document.getElementById('custPayStatPending');

    if (this.isLoadingPayments && !list.length) {
      if (elTotal) elTotal.innerText = 'Loading...';
      if (elPaid) elPaid.innerText = 'Loading...';
      if (elPending) elPending.innerText = 'Loading...';
      tableBody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
            <i class="fa-solid fa-spinner fa-spin" style="font-size: 2.5rem; color: var(--accent-gold); margin-bottom: 0.75rem;"></i>
            <h3 style="color: #FFF; font-size: 1.1rem; margin-bottom: 0.25rem;">Loading Payment History...</h3>
            <p style="font-size: 0.85rem;">Fetching database records...</p>
          </td>
        </tr>
      `;
      return;
    } else {
      if (elTotal) elTotal.innerText = `₹${totalSpent.toLocaleString('en-IN')}`;
      if (elPaid) elPaid.innerText = paidCount;
      if (elPending) elPending.innerText = pendingCount;
    }

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
          <td colspan="6" style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
            <i class="fa-solid fa-wallet" style="font-size: 2.5rem; color: var(--accent-gold); margin-bottom: 0.75rem;"></i>
            <h3 style="color: #FFF; font-size: 1.1rem; margin-bottom: 0.25rem;">No payment history found</h3>
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

    const relatedOrder = this.orders.find(o => o.order_number === p.order_number);
    const isOrderCompleted = relatedOrder && (['completed', 'delivered'].includes((relatedOrder.order_status || '').toLowerCase()) || Boolean(relatedOrder.pickup_pin_verified));

    const statusBg = isPaid ? 'rgba(76, 175, 80, 0.15)' : isPending ? 'rgba(234, 162, 33, 0.15)' : 'rgba(229, 57, 53, 0.15)';
    const statusBorder = isPaid ? '#4CAF50' : isPending ? '#EAA221' : '#E53935';
    const statusColor = isPaid ? '#4CAF50' : isPending ? '#FFB74D' : '#FF5252';

    return `
      <tr style="border-bottom: 1px solid var(--border-color); transition: background 0.2s ease;">
        <!-- 1. Order ID & Date (CUSTOMER SIDE: Order ID, Date & Time) -->
        <td style="padding: 14px 16px; vertical-align: middle;">
          <div style="font-weight: 800; font-size: 0.95rem; color: var(--accent-gold);">
            <i class="fa-solid fa-receipt"></i> #${p.order_number}
          </div>
          <div style="font-size: 0.76rem; color: #E0E0E0; font-weight: 600; margin-top: 3px;">
            <i class="fa-regular fa-clock"></i> ${this.formatPaymentDateTime(p)}
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
              <img src="${p.payment_screenshot}" onclick="app.viewFullScreenshot('${p.payment_screenshot}', 'Payment Proof - Order #${p.order_number}')" class="payment-screenshot-thumb" style="width: 46px; height: 46px; object-fit: cover; border-radius: 8px; border: 1.5px solid var(--accent-gold); cursor: pointer;" title="Click to view full screenshot">
              <button type="button" class="btn-sm-status" onclick="app.viewFullScreenshot('${p.payment_screenshot}', 'Payment Proof - Order #${p.order_number}')" style="background: rgba(234, 162, 33, 0.15); color: var(--accent-gold); border: 1px solid rgba(234, 162, 33, 0.3); padding: 4px 10px; border-radius: 6px; font-size: 0.75rem; font-weight: 700; cursor: pointer;">
                <i class="fa-solid fa-camera"></i> View
              </button>
            </div>
          ` : `
            <span style="font-size: 0.76rem; color: var(--text-muted); font-style: italic;">No attachment</span>
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
          ${isOrderCompleted ? `
            <button type="button" class="btn-sm-status" onclick="app.downloadInvoice('${p.order_number}')" style="background: linear-gradient(135deg, #4CAF50, #2E7D32); color: #FFFFFF; border: none; padding: 8px 16px; border-radius: 8px; font-size: 0.78rem; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 4px 12px rgba(76, 175, 80, 0.35);" title="Download Official Receipt Invoice">
              <i class="fa-solid fa-file-invoice"></i> 🧾 Download Invoice
            </button>
          ` : `
            <span style="font-size: 0.76rem; color: var(--text-muted); font-style: italic;">Available after completion</span>
          `}
        </td>

        <!-- 6. Delete Action -->
        <td style="padding: 14px 16px; vertical-align: middle; text-align: center;">
          <button type="button" class="btn-sm-status" onclick="app.deleteCustomerPayment('${p.id}')" style="background: rgba(229,57,53,0.16); color: #FF5252; border: 1px solid rgba(229,57,53,0.4); padding: 8px 16px; border-radius: 8px; font-size: 0.78rem; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s ease;" title="Delete this payment record">
            <i class="fa-solid fa-trash-can"></i> Delete
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

  // =========================================================================
  // CUSTOMER HISTORY DELETION (Delete own order & payment records)
  // =========================================================================

  async deleteCustomerOrder(orderId) {
    const order = this.orders.find(o => o.id === orderId);
    if (!order) { this.showToast('Order not found.', 'error'); return; }

    if (!confirm(`Are you sure you want to permanently delete Order #${order.order_number} from your history?\n\nThis action cannot be undone.`)) return;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/customer/orders/${order.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        this.orders = (this.orders || []).filter(o => o.id !== order.id);
        this.isLoadingOrders = false;
        this.renderOrders();
        this.showToast('Order deleted successfully.', 'success');
        await this.fetchOrders(true);
        this.fetchPayments(true);
        this.fetchStats(true);
      } else {
        this.showToast(json.message || 'Unable to delete order. Please try again.', 'error');
      }
    } catch (err) {
      console.error('Error deleting customer order:', err);
      this.showToast('Unable to delete order. Please try again.', 'error');
    } finally {
      this.isLoadingOrders = false;
      this.renderOrders();
    }
  }

  async deleteAllCustomerOrders() {
    if (!this.orders || !this.orders.length) {
      this.showToast('No order history to delete.', 'info');
      return;
    }

    if (!confirm(`⚠️ Are you sure you want to permanently delete ALL your order history (${this.orders.length} orders)?\n\nThis action cannot be undone.`)) return;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/customer/orders`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        this.orders = [];
        this.isLoadingOrders = false;
        this.renderOrders();
        this.showToast('All orders deleted successfully.', 'success');
        await this.fetchOrders(true);
        this.fetchPayments(true);
        this.fetchStats(true);
      } else {
        this.showToast(json.message || 'Unable to delete order. Please try again.', 'error');
      }
    } catch (err) {
      console.error('Error deleting all customer orders:', err);
      this.showToast('Unable to delete order. Please try again.', 'error');
    } finally {
      this.isLoadingOrders = false;
      this.renderOrders();
    }
  }

  async deleteCustomerPayment(paymentId) {
    const payment = (this.payments || []).find(p => p.id === paymentId);
    if (!payment) { this.showToast('Payment record not found.', 'error'); return; }

    if (!confirm(`Are you sure you want to permanently delete the payment record for Order #${payment.order_number}?\n\nThis action cannot be undone.`)) return;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/customer/payments/${payment.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        this.payments = (this.payments || []).filter(p => p.id !== payment.id);
        this.isLoadingPayments = false;
        this.filterCustomerPayments();
        this.showToast('Payment deleted successfully.', 'success');
        await this.fetchPayments(true);
      } else {
        this.showToast(json.message || 'Unable to delete payment. Please try again.', 'error');
      }
    } catch (err) {
      console.error('Error deleting customer payment:', err);
      this.showToast('Unable to delete payment. Please try again.', 'error');
    } finally {
      this.isLoadingPayments = false;
      this.filterCustomerPayments();
    }
  }

  async deleteAllCustomerPayments() {
    const userMobileClean = (this.currentUser?.mobile || '').replace(/[^0-9]/g, '');
    const myPayments = (this.payments || []).filter(p => {
      if (p.customer_id && p.customer_id === this.currentUser?.id) return true;
      if (p.customer_mobile && p.customer_mobile.replace(/[^0-9]/g, '') === userMobileClean) return true;
      const matchingOrder = (this.orders || []).find(o => o.order_number === p.order_number);
      if (matchingOrder && matchingOrder.customer_mobile && matchingOrder.customer_mobile.replace(/[^0-9]/g, '') === userMobileClean) return true;
      return false;
    });

    if (!myPayments.length) {
      this.showToast('No payment history to delete.', 'info');
      return;
    }

    if (!confirm(`⚠️ Are you sure you want to permanently delete ALL your payment history (${myPayments.length} records)?\n\nThis action cannot be undone.`)) return;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/customer/payments`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        const paymentIds = myPayments.map(p => p.id);
        this.payments = (this.payments || []).filter(p => !paymentIds.includes(p.id));
        this.isLoadingPayments = false;
        this.filterCustomerPayments();
        this.showToast('All payment records deleted successfully.', 'success');
        await this.fetchPayments(true);
      } else {
        this.showToast(json.message || 'Unable to delete payment. Please try again.', 'error');
      }
    } catch (err) {
      console.error('Error deleting all customer payments:', err);
      this.showToast('Unable to delete payment. Please try again.', 'error');
    } finally {
      this.isLoadingPayments = false;
      this.filterCustomerPayments();
    }
  }

  async updatePaymentStatus(paymentId, newStatus) {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/payments/${paymentId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_status: newStatus })
      });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message, 'success');
        await this.fetchPayments();
      } else {
        this.showToast(json.message || 'Failed to update payment status', 'error');
      }
    } catch (err) {
      console.error('Error updating payment status:', err);
    }
  }

  async toggleMasterHotelStatus() {
    if (!this.settings) this.settings = {};
    const newState = !this.settings.is_open;
    this.settings.is_open = newState;

    this.updateHeaderAndSettingsUI();
    this.renderMenu();

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_open: newState })
      });
      const json = await res.json();
      if (json.success) {
        this.settings = json.data;
        this.updateHeaderAndSettingsUI();
        this.renderMenu();
        const msg = newState ? 'Hotel is now Open' : 'Hotel is now Closed';
        this.showToast(msg, newState ? 'success' : 'warning');
      } else {
        this.showToast(json.message || 'Failed to update hotel status', 'error');
      }
    } catch (err) {
      console.error('Error toggling hotel status:', err);
      this.showToast('Server communication error.', 'error');
    }
  }

  async toggleSettingsHotelOpen() {
    return this.toggleMasterHotelStatus();
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
      await this.fetchWithAuth(`${API_BASE}/notifications/read-all`, {
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

  async saveCustomerProfile(e) {
    e.preventDefault();
    const name = document.getElementById('profNameInput')?.value || '';
    const phone = document.getElementById('profPhoneInput')?.value || '';
    const email = document.getElementById('profEmailInput')?.value || '';
    const address = document.getElementById('profAddressInput')?.value || '';

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, mobile: phone, email, address })
      });
      const json = await res.json();
      if (json.success) {
        this.currentUser = json.data;
        localStorage.setItem('tiffin_user', JSON.stringify(json.data));
        this.showToast('Profile updated successfully.', 'success');
        this.updateUserAuthBadgeUI();
      } else {
        this.showToast(json.message || 'Failed to update profile', 'error');
      }
    } catch (err) {
      console.error('Error updating profile:', err);
      this.showToast('Server communication error.', 'error');
    }
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
    if (this.currentRole === 'OWNER' && !silent && this.activeView === 'secOwnerSupport') {
      const cardsContainer = document.getElementById('ownerTicketsCardsContainer');
      if (cardsContainer && (!this.supportTickets || !this.supportTickets.length)) {
        cardsContainer.innerHTML = `
          <div style="grid-column: 1 / -1; text-align: center; padding: 3rem 1rem; color: var(--text-muted); background: var(--bg-surface); border-radius: var(--radius-lg); border: 1px dashed var(--border-color);">
            <i class="fa-solid fa-circle-notch fa-spin" style="font-size: 2rem; color: var(--accent-gold); margin-bottom: 0.75rem;"></i>
            <h3 style="color: #FFF; font-size: 1.05rem; margin-bottom: 0.25rem;">Loading Support Inbox...</h3>
            <p style="font-size: 0.82rem;">Fetching customer tickets from production database...</p>
          </div>
        `;
      }
    }

    try {
      const role = this.currentRole;
      let url = `${API_BASE}/support/tickets?role=${role}`;
      if (this.currentUser) {
        url += `&user_id=${this.currentUser.id}&mobile=${this.currentUser.mobile}`;
      }

      const res = await this.fetchWithAuth(url, { isBackgroundPoll: silent });
      const json = await res.json();
      if (json.success) {
        this.supportTickets = Array.isArray(json.data) ? json.data : [];
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
      } else {
        if (this.currentRole === 'OWNER') {
          this.renderOwnerTicketError('Unable to load support tickets. Please try again.');
        }
      }
    } catch (err) {
      console.error('Error fetching support tickets:', err);
      if (this.currentRole === 'OWNER') {
        this.renderOwnerTicketError('Unable to load support tickets. Please try again.');
      }
    }
  }

  renderOwnerTicketError(message) {
    const elTotal = document.getElementById('statTotalTickets');
    const elOpen = document.getElementById('statOpenTickets');
    const elProgress = document.getElementById('statInProgressTickets');
    const elResolved = document.getElementById('statResolvedTickets');
    if (elTotal && elTotal.innerText === 'Loading...') elTotal.innerText = '0';
    if (elOpen && elOpen.innerText === 'Loading...') elOpen.innerText = '0';
    if (elProgress && elProgress.innerText === 'Loading...') elProgress.innerText = '0';
    if (elResolved && elResolved.innerText === 'Loading...') elResolved.innerText = '0';

    const cardsContainer = document.getElementById('ownerTicketsCardsContainer');
    if (cardsContainer) {
      cardsContainer.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 3rem 1rem; color: #FF5252; background: rgba(255,82,82,0.08); border-radius: var(--radius-lg); border: 1px solid rgba(255,82,82,0.25);">
          <i class="fa-solid fa-triangle-exclamation" style="font-size: 2.2rem; margin-bottom: 0.75rem;"></i>
          <h3 style="font-size: 1.05rem; font-weight: 700; margin-bottom: 0.25rem;">Unable to load support tickets</h3>
          <p style="font-size: 0.82rem; color: var(--text-muted);">${message}</p>
          <button class="btn-secondary-outline" onclick="app.fetchSupportTickets()" style="margin-top: 12px; font-size: 0.8rem; padding: 6px 14px;">
            <i class="fa-solid fa-rotate"></i> Retry Fetching Tickets
          </button>
        </div>
      `;
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
      reply = `<strong>🤖 Smart Assistant:</strong> Online UPI payments (GPay/PhonePe/Paytm) are instantly verified. If money was deducted but order shows pending, please click 'Raise Support Ticket' with your Order ID or call our helpline (+91 9392874900).`;
    } else if (topic === 'customization') {
      reply = `<strong>🤖 Smart Assistant:</strong> You can add special instructions for extra sambar, coconut chutney, less oil, or extra crispy dosas right in the 'Order Notes' text field during checkout!`;
    } else if (topic === 'catering') {
      reply = `<strong>🤖 Smart Assistant:</strong> We cater for family functions, office breakfasts, and bulk tiffin orders (10 to 500+ guests). Please raise a support ticket under 'Bulk & Catering Inquiry' or call +91 9392874900.`;
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
        ${userOrders.map(o => `<option value="${o.order_number}">Order #${o.order_number} (${o.order_type} - ₹${o.net_amount ?? o.total_amount ?? o.grand_total ?? 0})</option>`).join('')}
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
      const res = await this.fetchWithAuth(`${API_BASE}/support/tickets`, {
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
      const res = await this.fetchWithAuth(`${API_BASE}/support/tickets/${this.activeTicketId}/messages`, {
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
      const res = await this.fetchWithAuth(`${API_BASE}/support/tickets/${this.activeTicketId}/status`, {
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
                <span class="otc-cust-phone"><i class="fa-solid fa-phone"></i> ${t.customer_mobile} • ID: ${t.customer_id || t.user_id || 'N/A'}</span>
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

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/referrals/stats`);
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
    if (elCode) elCode.innerText = referral_code || '---';

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
    const code = this.referralStats?.referral_code || document.getElementById('referralCodeDisplay')?.innerText || '---';
    navigator.clipboard.writeText(code).then(() => {
      this.showToast(`Referral Code ${code} copied to clipboard!`, 'success');
    }).catch(() => {
      this.showToast(`Referral Code: ${code}`, 'info');
    });
  }

  shareReferralWhatsApp() {
    const code = this.referralStats?.referral_code || document.getElementById('referralCodeDisplay')?.innerText || '---';
    const hotelName = this.settings.hotel_name || 'Sri Lakshmi Annapurna Tiffin Center';
    const siteUrl = window.location.origin.includes('localhost') ? 'https://annapurna-tiffin-1.onrender.com' : window.location.origin;
    const msg = `Hey! Order delicious, authentic South Indian tiffins from ${hotelName}! Use my Referral Code *${code}* during registration to get ₹30 OFF your first order! 🍲✨ Order here: ${siteUrl}`;
    const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`;
    window.open(waUrl, '_blank');
  }

  async toggleLeaderboardPrivacy() {
    if (!this.currentUser) return;
    const currentState = this.referralStats?.show_on_leaderboard !== false;
    const newState = !currentState;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/referrals/privacy`, {
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

  async toggleCheckoutWalletDiscount() {
    const chk = document.getElementById('chkUseWallet');
    const breakdownBox = document.getElementById('referralAppliedBreakdown');
    
    if (chk && chk.checked) {
      // Fetch latest wallet balance from backend
      let walletBal = 0;
      try {
        const res = await this.fetchWithAuth(`${API_BASE}/referrals/stats`);
        const json = await res.json();
        if (json.success && json.data) {
          walletBal = Number(json.data.wallet_balance || 0);
          if (this.currentUser) this.currentUser.wallet_balance = walletBal;
          if (this.referralStats) this.referralStats.wallet_balance = walletBal;
        }
      } catch (e) {
        walletBal = Number(this.referralStats?.wallet_balance || this.currentUser?.wallet_balance || 0);
      }

      const elText = document.getElementById('checkoutWalletAvailableText');
      if (elText) elText.innerHTML = `Available Balance: <strong>₹${walletBal}</strong>`;

      if (walletBal <= 0) {
        this.showToast('Your referral wallet balance is ₹0. No referral balance available.', 'warning');
        chk.checked = false;
        this.appliedWalletDiscount = 0;
        if (breakdownBox) breakdownBox.classList.add('hidden');
        this.updateCartUI();
        return;
      }

      const cartTotals = this.calculateCartTotals ? this.calculateCartTotals() : { grandTotal: 0 };
      const grandTotal = cartTotals.grandTotal || 0;
      const applied = Math.min(walletBal, grandTotal);
      const remaining = Math.max(0, grandTotal - applied);

      this.appliedWalletDiscount = applied;

      const elTotal = document.getElementById('refBreakdownOrderTotal');
      const elApplied = document.getElementById('refBreakdownAppliedVal');
      const elNet = document.getElementById('refBreakdownNetPayable');

      if (elTotal) elTotal.innerText = `₹${grandTotal}`;
      if (elApplied) elApplied.innerText = `-₹${applied}`;
      if (elNet) elNet.innerText = `₹${remaining}`;

      if (breakdownBox) breakdownBox.classList.remove('hidden');

      this.showToast(`Referral Wallet balance applied (-₹${applied})!`, 'success');
    } else {
      this.appliedWalletDiscount = 0;
      if (breakdownBox) breakdownBox.classList.add('hidden');
      this.showToast('Referral balance unapplied.', 'info');
    }

    this.updateCartUI();
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

    const order = (this.orders || []).find(o => o.order_number === orderNum || o.id === orderNum);
    const existingReview = order?.review;

    const elOrderNum = document.getElementById('reviewOrderNumDisplay');
    if (elOrderNum) elOrderNum.innerText = `#${orderNum}`;

    const commentInput = document.getElementById('reviewComment');
    const btnSubmit = document.getElementById('btnSubmitReview');

    if (existingReview) {
      this.selectedRating = Number(existingReview.rating || 5);
      if (commentInput) commentInput.value = existingReview.comment || '';
      this.setStarRating(this.selectedRating);
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Update Your Review`;
      }
    } else {
      if (commentInput) commentInput.value = '';
      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Submit Review`;
      }
      this.resetStarUI();
      this.updateReviewModalFlowUI();
    }

    const backdrop = document.getElementById('orderReviewModalBackdrop');
    if (backdrop) {
      backdrop.style.display = 'flex';
      backdrop.classList.add('open');
    }
  }

  closeOrderReviewModal() {
    const backdrop = document.getElementById('orderReviewModalBackdrop');
    if (backdrop) {
      backdrop.classList.remove('open');
      backdrop.style.display = '';
    }
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
    if (this.isSubmittingReview) return;

    if (!this.selectedRating) {
      this.showToast('Please select a star rating.', 'error');
      return;
    }

    const comment = document.getElementById('reviewComment')?.value.trim();
    const chkPublic = document.getElementById('chkReviewPublic');
    const isPublic = this.selectedRating >= 4 && chkPublic ? chkPublic.checked : false;

    const btnSubmit = document.getElementById('btnSubmitReview');
    this.isSubmittingReview = true;
    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Submitting...`;
    }

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
      const res = await this.fetchWithAuth(`${API_BASE}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();

      if (json.success) {
        // Optimistically attach review to local order object
        const order = (this.orders || []).find(o => o.order_number === this.activeReviewOrderNumber || o.id === this.activeReviewOrderNumber);
        if (order) {
          order.review = json.data || {
            id: 'rev_' + Date.now(),
            order_number: this.activeReviewOrderNumber,
            rating: this.selectedRating,
            comment: comment,
            date_time: new Date().toLocaleDateString('en-IN')
          };
        }

        this.showToast(json.message || '✓ Thank you! Review saved successfully.', 'success');
        this.closeOrderReviewModal();
        this.renderCurrentView(); // Instant UI update without page refresh
        await this.fetchNotifications();
      } else {
        this.showToast(json.message || 'Error submitting review.', 'error');
      }
    } catch (err) {
      console.error('Error submitting review:', err);
      this.showToast('Server communication error. Please try again.', 'error');
    } finally {
      this.isSubmittingReview = false;
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Submit Review`;
      }
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
  // OWNER SIDE REVIEWS & RATINGS MANAGEMENT METHODS
  // =========================================================================

  async fetchOwnerReviews(silent = false) {
    if (this.currentRole !== 'OWNER') return;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/reviews`);
      const json = await res.json();
      if (json.success) {
        this.ownerReviews = json.data || [];
        this.renderOwnerReviews();
        this.fetchReviewStats();
      }
    } catch (err) {
      console.error('Error fetching owner reviews:', err);
    }
  }

  setOwnerReviewFilter(filterVal) {
    if (filterVal !== undefined) {
      this.ownerReviewFilter = filterVal;
    }
    this.renderOwnerReviews();
  }

  filterOwnerReviews(filterVal) {
    if (filterVal !== undefined) {
      this.ownerReviewFilter = filterVal;
    }
    this.renderOwnerReviews();
  }

  renderOwnerReviews() {
    const list1 = document.getElementById('ownerReviewsList');
    const list2 = document.getElementById('ownerReviewsCardsContainer');
    if (!list1 && !list2) return;

    const reviews = this.ownerReviews || [];

    // Calculate KPI Stats
    const totalCount = reviews.length;
    const count5Star = reviews.filter(r => Math.round(Number(r.rating)) === 5).length;
    const count4Star = reviews.filter(r => Math.round(Number(r.rating)) === 4).length;
    const count3Star = reviews.filter(r => Math.round(Number(r.rating)) === 3).length;
    const count2Star = reviews.filter(r => Math.round(Number(r.rating)) === 2).length;
    const count1Star = reviews.filter(r => Math.round(Number(r.rating)) === 1).length;
    const countPublic = reviews.filter(r => r.is_public).length;
    const criticalCount = reviews.filter(r => Number(r.rating) <= 3).length;
    const positiveCount = count5Star + count4Star;

    const sumRating = reviews.reduce((s, r) => s + (Number(r.rating) || 5), 0);
    const avgRating = totalCount > 0 ? (sumRating / totalCount).toFixed(1) : '5.0';
    const pct5Star = totalCount > 0 ? Math.round((positiveCount / totalCount) * 100) : 100;

    // Update KPI Stat Elements
    const elAvg1 = document.getElementById('ownerRevAvgVal');
    const elAvg2 = document.getElementById('ownerAvgRatingVal');
    const elTotal1 = document.getElementById('ownerRevTotalVal');
    const elTotal2 = document.getElementById('ownerTotalReviewsCount');
    const elPct = document.getElementById('ownerRev5StarPct');
    const elAlerts = document.getElementById('ownerRevAlertsVal');
    const elPos = document.getElementById('ownerPositiveReviewsCount');
    const elCrit = document.getElementById('ownerCriticalReviewsCount');

    if (elAvg1) elAvg1.innerText = `${avgRating} / 5.0`;
    if (elAvg2) elAvg2.innerText = avgRating;
    if (elTotal1) elTotal1.innerText = totalCount;
    if (elTotal2) elTotal2.innerText = totalCount;
    if (elPct) elPct.innerText = `${pct5Star}%`;
    if (elAlerts) elAlerts.innerText = criticalCount;
    if (elPos) elPos.innerText = positiveCount;
    if (elCrit) elCrit.innerText = criticalCount;

    // Update Filter Tab Badges
    const cntAll = document.getElementById('cntRevTabAll');
    const cnt5 = document.getElementById('cntRevTab5Star');
    const cnt4 = document.getElementById('cntRevTab4Star');
    const cntIss = document.getElementById('cntRevTabIssues');
    const cntPub = document.getElementById('cntRevTabPublic');

    if (cntAll) cntAll.innerText = totalCount;
    if (cnt5) cnt5.innerText = count5Star;
    if (cnt4) cnt4.innerText = count4Star;
    if (cntIss) cntIss.innerText = criticalCount;
    if (cntPub) cntPub.innerText = countPublic;

    // Update Tab Active Classes
    const filterKey = (this.ownerReviewFilter || 'ALL').toUpperCase();
    const mapTabs = {
      'ALL': ['tabRevFilterAll', 'chipOwnerRevAll'],
      'EXCELLENT': ['tabRevFilterExcellent', 'chipOwnerRev5'],
      '5': ['tabRevFilterExcellent', 'chipOwnerRev5'],
      'GOOD': ['tabRevFilterGood', 'chipOwnerRev4'],
      '4': ['tabRevFilterGood', 'chipOwnerRev4'],
      '3': ['chipOwnerRev3'],
      '2': ['chipOwnerRev2'],
      '1': ['chipOwnerRev1'],
      'ISSUES': ['tabRevFilterIssues', 'chipOwnerRev3', 'chipOwnerRev2', 'chipOwnerRev1'],
      'PUBLIC': ['tabRevFilterPublic', 'chipOwnerRevPublic']
    };

    document.querySelectorAll('.tab-pill, .filter-chip').forEach(el => el.classList.remove('active'));
    const activeIds = mapTabs[filterKey] || ['tabRevFilterAll', 'chipOwnerRevAll'];
    activeIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('active');
    });

    // Render Rating Breakdown Progress Bars
    const breakdownBox = document.getElementById('ownerRatingBreakdownContainer');
    if (breakdownBox) {
      const starCounts = [
        { stars: 5, count: count5Star, label: '5 Stars' },
        { stars: 4, count: count4Star, label: '4 Stars' },
        { stars: 3, count: count3Star, label: '3 Stars' },
        { stars: 2, count: count2Star, label: '2 Stars' },
        { stars: 1, count: count1Star, label: '1 Star' }
      ];

      breakdownBox.innerHTML = starCounts.map(item => {
        const pct = totalCount > 0 ? Math.round((item.count / totalCount) * 100) : 0;
        const color = item.stars >= 4 ? 'var(--accent-gold)' : item.stars === 3 ? '#29B6F6' : '#FF5252';
        return `
          <div style="display: flex; align-items: center; gap: 12px; font-size: 0.82rem;">
            <span style="width: 55px; color: var(--text-muted); font-weight: 600;">${item.label}</span>
            <div style="flex: 1; height: 8px; background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden;">
              <div style="width: ${pct}%; height: 100%; background: ${color}; border-radius: 4px; transition: width 0.4s ease;"></div>
            </div>
            <span style="width: 70px; text-align: right; color: var(--text-muted);">${item.count} (${pct}%)</span>
          </div>
        `;
      }).join('');
    }

    // Filter Reviews List
    const searchQuery = (document.getElementById('ownerRevSearchInput')?.value || '').toLowerCase().trim();
    let filtered = [...reviews];

    if (filterKey === 'EXCELLENT' || filterKey === '5') {
      filtered = filtered.filter(r => Math.round(Number(r.rating)) === 5);
    } else if (filterKey === 'GOOD' || filterKey === '4') {
      filtered = filtered.filter(r => Math.round(Number(r.rating)) === 4);
    } else if (filterKey === '3') {
      filtered = filtered.filter(r => Math.round(Number(r.rating)) === 3);
    } else if (filterKey === '2') {
      filtered = filtered.filter(r => Math.round(Number(r.rating)) === 2);
    } else if (filterKey === '1') {
      filtered = filtered.filter(r => Math.round(Number(r.rating)) === 1);
    } else if (filterKey === 'ISSUES') {
      filtered = filtered.filter(r => Number(r.rating) <= 3);
    } else if (filterKey === 'PUBLIC') {
      filtered = filtered.filter(r => r.is_public);
    }

    if (searchQuery) {
      filtered = filtered.filter(r =>
        (r.customer_name || '').toLowerCase().includes(searchQuery) ||
        (r.customer_mobile || '').toLowerCase().includes(searchQuery) ||
        (r.order_number || '').toLowerCase().includes(searchQuery) ||
        (r.comment || '').toLowerCase().includes(searchQuery)
      );
    }

    let cardsHtml = '';
    if (!filtered.length) {
      cardsHtml = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 3rem 1rem; background: var(--bg-surface-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-lg);">
          <div style="font-size: 2.5rem; color: var(--accent-gold); margin-bottom: 0.5rem;"><i class="fa-regular fa-star-half-stroke"></i></div>
          <h3 style="color: #FFF; font-size: 1.1rem; margin-bottom: 0.35rem;">No Customer Reviews Found</h3>
          <p style="color: var(--text-muted); font-size: 0.85rem; max-width: 400px; margin: 0 auto;">No reviews match the selected filter "${this.ownerReviewFilter}". When customers place orders and leave star feedback, they will appear here.</p>
        </div>
      `;
    } else {
      cardsHtml = filtered.map(r => {
        const initial = (r.customer_name || 'C').charAt(0).toUpperCase();
        const numRating = Number(r.rating) || 5;
        const formattedDate = r.created_at ? new Date(r.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'Recently';

        let starsHtml = '';
        for (let i = 1; i <= 5; i++) {
          if (i <= numRating) {
            starsHtml += '<i class="fa-solid fa-star" style="color: var(--accent-gold);"></i> ';
          } else {
            starsHtml += '<i class="fa-regular fa-star" style="color: var(--text-muted);"></i> ';
          }
        }

        const issuesHtml = (r.issues && r.issues.length)
          ? `<div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px;">
              ${r.issues.map(iss => `<span style="font-size: 0.72rem; background: rgba(255, 82, 82, 0.15); color: #FF5252; border: 1px solid rgba(255, 82, 82, 0.3); padding: 2px 8px; border-radius: 12px;"><i class="fa-solid fa-circle-exclamation"></i> ${iss}</span>`).join('')}
             </div>`
          : '';

        const ownerReplyHtml = r.owner_reply
          ? `<div style="margin-top: 12px; background: rgba(255, 179, 0, 0.08); border-left: 3px solid var(--accent-gold); padding: 10px 12px; border-radius: 6px;">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                <span style="font-size: 0.76rem; font-weight: 800; color: var(--accent-gold);"><i class="fa-solid fa-store"></i> Owner Response</span>
                <span style="font-size: 0.7rem; color: var(--text-muted);">${r.owner_reply.created_at ? new Date(r.owner_reply.created_at).toLocaleDateString('en-IN') : ''}</span>
              </div>
              <p style="font-size: 0.84rem; color: var(--text-main); margin: 0; line-height: 1.4;">${r.owner_reply.message}</p>
             </div>`
          : '';

        const publicChipHtml = r.is_public
          ? `<span style="font-size: 0.72rem; font-weight: 700; background: rgba(76, 175, 80, 0.15); color: #4CAF50; border: 1px solid rgba(76, 175, 80, 0.3); padding: 3px 10px; border-radius: 12px;"><i class="fa-solid fa-eye"></i> Featured Public</span>`
          : `<span style="font-size: 0.72rem; font-weight: 700; background: rgba(255, 255, 255, 0.06); color: var(--text-muted); border: 1px solid var(--border-color); padding: 3px 10px; border-radius: 12px;"><i class="fa-solid fa-eye-slash"></i> Internal Only</span>`;

        return `
          <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 1.25rem; display: flex; flex-direction: column; justify-content: space-between; gap: 12px; box-shadow: var(--shadow-sm); margin-bottom: 12px;">
            <div>
              <!-- Header: Customer Info & Rating -->
              <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 8px; flex-wrap: wrap;">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <div style="width: 42px; height: 42px; border-radius: 50%; background: linear-gradient(135deg, var(--primary), var(--accent-gold)); color: #FFF; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 1.1rem; border: 2px solid rgba(255,255,255,0.15);">
                    ${initial}
                  </div>
                  <div>
                    <strong style="color: #FFF; font-size: 0.95rem; display: block;">${r.customer_name || 'Customer'}</strong>
                    <span style="font-size: 0.76rem; color: var(--text-muted);"><i class="fa-solid fa-mobile-screen"></i> ${r.customer_mobile || '---'} • <span style="color: var(--accent-gold);">#${r.order_number}</span></span>
                  </div>
                </div>
                <div style="text-align: right;">
                  <div style="font-size: 0.9rem; margin-bottom: 2px;">${starsHtml}</div>
                  <span style="font-size: 0.7rem; color: var(--text-muted); display: block;">${formattedDate}</span>
                </div>
              </div>

              <!-- Review Comment -->
              <p style="font-size: 0.88rem; color: var(--text-main); line-height: 1.45; background: rgba(0,0,0,0.2); padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid rgba(255,255,255,0.05); margin: 6px 0 0 0;">
                "${r.comment ? r.comment : 'Customer left a ' + numRating + '-star rating.'}"
              </p>

              ${issuesHtml}
              ${ownerReplyHtml}
            </div>

            <!-- Footer Actions & Public Toggle -->
            <div style="display: flex; align-items: center; justify-content: space-between; border-top: 1px solid var(--border-color); padding-top: 10px; margin-top: 4px; gap: 8px; flex-wrap: wrap;">
              <div>${publicChipHtml}</div>
              
              <div style="display: flex; align-items: center; gap: 8px;">
                <button type="button" class="btn-text-action" onclick="app.toggleOwnerReviewVisibility('${r.id}', ${r.is_public})" title="${r.is_public ? 'Hide from public website' : 'Feature publicly on website'}">
                  <i class="fa-solid ${r.is_public ? 'fa-eye-slash' : 'fa-star'}"></i> ${r.is_public ? 'Unfeature' : 'Feature'}
                </button>

                <button type="button" class="btn-text-action" onclick="app.openReviewReplyModal('${r.id}')" style="color: var(--accent-gold);" title="Reply to this review">
                  <i class="fa-solid fa-reply"></i> ${r.owner_reply ? 'Edit Reply' : 'Reply'}
                </button>

                <button type="button" class="btn-text-action danger" onclick="app.deleteOwnerReview('${r.id}')" title="Delete review">
                  <i class="fa-solid fa-trash-can"></i>
                </button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    if (list1) list1.innerHTML = cardsHtml;
    if (list2) list2.innerHTML = cardsHtml;
  }

  async toggleOwnerReviewVisibility(reviewId, currentStatus) {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/reviews/${reviewId}/visibility`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_public: !currentStatus })
      });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message, 'success');
        await this.fetchOwnerReviews(true);
      } else {
        this.showToast(json.message || 'Failed to update review visibility.', 'error');
      }
    } catch (err) {
      console.error('Error toggling review visibility:', err);
      this.showToast('Server communication error.', 'error');
    }
  }

  openReviewReplyModal(reviewId) {
    const review = (this.ownerReviews || []).find(r => r.id === reviewId);
    if (!review) return;

    const inputId = document.getElementById('replyTargetReviewId');
    const snippet = document.getElementById('replyTargetReviewSnippet');
    const replyText = document.getElementById('ownerReplyText');

    if (inputId) inputId.value = review.id;

    if (snippet) {
      snippet.innerHTML = `
        <strong>${review.customer_name}</strong> (#${review.order_number}) — ${review.rating} ★<br>
        <span style="font-style: italic;">"${review.comment || 'No detailed comment'}"</span>
      `;
    }

    if (replyText) {
      replyText.value = review.owner_reply ? review.owner_reply.message : '';
    }

    const backdrop = document.getElementById('ownerReviewReplyModalBackdrop');
    if (backdrop) backdrop.classList.add('open');
  }

  closeReviewReplyModal() {
    const backdrop = document.getElementById('ownerReviewReplyModalBackdrop');
    if (backdrop) backdrop.classList.remove('open');
  }

  async submitReviewReply(e) {
    if (e) e.preventDefault();
    const reviewId = document.getElementById('replyTargetReviewId')?.value;
    const replyText = document.getElementById('ownerReplyText')?.value.trim();

    if (!reviewId || !replyText) {
      this.showToast('Please enter an owner reply message.', 'warning');
      return;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/reviews/${reviewId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply_message: replyText })
      });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message, 'success');
        this.closeReviewReplyModal();
        await this.fetchOwnerReviews(true);
      } else {
        this.showToast(json.message || 'Failed to post reply.', 'error');
      }
    } catch (err) {
      console.error('Error posting owner reply:', err);
      this.showToast('Server communication error.', 'error');
    }
  }

  async deleteOwnerReview(reviewId) {
    if (!confirm('Are you sure you want to delete this customer review? This action cannot be undone.')) return;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/reviews/${reviewId}`, {
        method: 'DELETE'
      });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message, 'success');
        await this.fetchOwnerReviews(true);
      } else {
        this.showToast(json.message || 'Failed to delete review.', 'error');
      }
    } catch (err) {
      console.error('Error deleting review:', err);
      this.showToast('Server communication error.', 'error');
    }
  }

  // =========================================================================
  // OWNER CUSTOMER ACCOUNT MANAGEMENT METHODS
  // =========================================================================

  async fetchOwnerCustomers(silent = false) {
    if (this.currentRole !== 'OWNER') return;

    if (!silent) {
      const bodyEl = document.getElementById('ownerCustomersTableBody');
      const cardsEl = document.getElementById('ownerCustomersCardsContainer');
      if (bodyEl && (!this.ownerCustomers || !this.ownerCustomers.length)) {
        bodyEl.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2rem; color: var(--text-muted);"><i class="fa-solid fa-circle-notch fa-spin" style="font-size: 1.5rem; color: var(--accent-gold); margin-bottom: 8px;"></i><br>Loading customer accounts...</td></tr>`;
      }
      if (cardsEl && (!this.ownerCustomers || !this.ownerCustomers.length)) {
        cardsEl.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 2rem; color: var(--text-muted);"><i class="fa-solid fa-circle-notch fa-spin" style="font-size: 1.5rem; color: var(--accent-gold); margin-bottom: 8px;"></i><br>Loading customer accounts...</div>`;
      }
    }

    try {
      const statusFilter = this.ownerCustFilter || 'All';
      const searchVal = (document.getElementById('ownerCustSearchInput')?.value || '').trim();
      const sortVal = document.getElementById('ownerCustSortSelect')?.value || 'newest';

      let url = `${API_BASE}/owner/customers?status=${encodeURIComponent(statusFilter)}&sort=${sortVal}`;
      if (searchVal) url += `&search=${encodeURIComponent(searchVal)}`;

      const res = await this.fetchWithAuth(url);
      const json = await res.json();

      if (json.success) {
        this.ownerCustomers = Array.isArray(json.data) ? json.data : [];
        this.renderOwnerCustomers();
      } else {
        this.showToast(json.message || 'Error fetching customer accounts', 'error');
      }
    } catch (err) {
      console.error('Error fetching owner customers:', err);
      this.showToast('Server communication error fetching customer accounts.', 'error');
    }
  }

  filterOwnerCustomers(status = null) {
    if (status) this.ownerCustFilter = status;

    ['All', 'Active', 'Blocked'].forEach(s => {
      const chip = document.getElementById(`chipCustFilter${s}`);
      if (chip) {
        chip.classList.toggle('active', (status || this.ownerCustFilter || 'All') === s);
      }
    });

    this.fetchOwnerCustomers();
  }

  renderOwnerCustomers() {
    const list = this.ownerCustomers || [];

    // Calculate KPI Stats
    const total = list.length;
    const activeCount = list.filter(c => (c.status || 'active').toLowerCase() === 'active').length;
    const blockedCount = list.filter(c => (c.status || '').toLowerCase() === 'blocked').length;

    const elTotal = document.getElementById('ownerStatTotalCust');
    const elActive = document.getElementById('ownerStatActiveCust');
    const elBlocked = document.getElementById('ownerStatBlockedCust');

    if (elTotal) elTotal.innerText = total;
    if (elActive) elActive.innerText = activeCount;
    if (elBlocked) elBlocked.innerText = blockedCount;

    const bodyEl = document.getElementById('ownerCustomersTableBody');
    const cardsEl = document.getElementById('ownerCustomersCardsContainer');

    if (!list.length) {
      const emptyHtml = `
        <div class="owner-tkt-empty-card" style="grid-column: 1 / -1; text-align: center; padding: 3rem 1.5rem; background: var(--bg-surface-elevated); border: 1px dashed var(--border-color); border-radius: var(--radius-lg);">
          <i class="fa-solid fa-users-slash" style="font-size: 2.5rem; color: var(--accent-gold); margin-bottom: 0.75rem;"></i>
          <h3 style="color: #FFF; font-size: 1.1rem; margin-bottom: 0.25rem;">No Customer Accounts Found</h3>
          <p style="color: var(--text-muted); font-size: 0.85rem;">No customer records match the current filter or search criteria.</p>
        </div>
      `;
      if (bodyEl) bodyEl.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2rem; color: var(--text-muted);">No customer accounts found matching criteria.</td></tr>`;
      if (cardsEl) cardsEl.innerHTML = emptyHtml;
      return;
    }

    // Render Desktop Table Rows
    if (bodyEl) {
      bodyEl.innerHTML = list.map(c => {
        const isBlocked = (c.status || '').toLowerCase() === 'blocked';
        const regDate = new Date(c.created_at || Date.now()).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        const initials = (c.name || 'C').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();

        return `
          <tr style="border-bottom: 1px solid var(--border-color); transition: var(--transition);" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
            <td style="padding: 12px 16px;">
              <div style="display: flex; align-items: center; gap: 10px;">
                <div style="width: 34px; height: 34px; border-radius: 50%; background: linear-gradient(135deg, var(--primary), var(--accent-gold)); color: #FFF; font-weight: 800; font-size: 0.8rem; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">${initials}</div>
                <div>
                  <strong style="color: #FFF; font-size: 0.9rem; display: block;">${c.name}</strong>
                  <span style="font-size: 0.74rem; color: var(--text-muted);">ID: ${c.id}</span>
                </div>
              </div>
            </td>
            <td style="padding: 12px 16px; font-size: 0.85rem;">
              <div style="display: flex; flex-direction: column;">
                <span style="color: #FFF; font-weight: 600;"><i class="fa-solid fa-phone" style="color: var(--accent-gold); font-size: 0.75rem;"></i> ${c.mobile}</span>
                ${c.email ? `<span style="font-size: 0.76rem; color: var(--text-muted);">${c.email}</span>` : ''}
              </div>
            </td>
            <td style="padding: 12px 16px; font-size: 0.82rem; color: var(--text-muted);">${regDate}</td>
            <td style="padding: 12px 16px; font-size: 0.88rem; font-weight: 700; color: #FFF;">${c.total_orders || 0}</td>
            <td style="padding: 12px 16px; font-size: 0.88rem; font-weight: 800; color: var(--accent-gold);">₹${Number(c.total_spent || 0).toLocaleString('en-IN')}</td>
            <td style="padding: 12px 16px;">
              <span class="status-badge ${isBlocked ? 'st-rejected' : 'st-active'}" style="background: ${isBlocked ? 'rgba(229,57,53,0.18)' : 'rgba(76,175,80,0.18)'}; color: ${isBlocked ? '#E53935' : '#4CAF50'}; border: 1px solid ${isBlocked ? '#E53935' : '#4CAF50'}; padding: 3px 9px; border-radius: 12px; font-size: 0.74rem; font-weight: 700;">
                ${isBlocked ? 'Blocked' : 'Active'}
              </span>
            </td>
            <td style="padding: 12px 16px; text-align: right;">
              <div style="display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap;">
                <button type="button" onclick="app.openCustomerDetailsModal('${c.id}')" style="background: rgba(234,162,33,0.15); color: var(--accent-gold); border: 1px solid var(--accent-gold); padding: 4px 10px; border-radius: 6px; font-size: 0.76rem; font-weight: 700; cursor: pointer;" title="View Customer Details"><i class="fa-solid fa-eye"></i> View</button>
                <button type="button" onclick="app.promptResetCustomerPassword('${c.id}', '${c.name.replace(/'/g, "\\'")}', '${c.mobile}')" style="background: rgba(234,162,33,0.15); color: var(--accent-gold); border: 1px solid var(--accent-gold); padding: 4px 10px; border-radius: 6px; font-size: 0.76rem; font-weight: 700; cursor: pointer;" title="Reset Customer Password"><i class="fa-solid fa-key"></i> 🔐 Reset Password</button>
                ${isBlocked ? 
                  `<button type="button" onclick="app.promptUnblockCustomer('${c.id}', '${c.name.replace(/'/g, "\\'")}')" style="background: rgba(76,175,80,0.15); color: #4CAF50; border: 1px solid #4CAF50; padding: 4px 10px; border-radius: 6px; font-size: 0.76rem; font-weight: 700; cursor: pointer;"><i class="fa-solid fa-user-check"></i> Unblock</button>` :
                  `<button type="button" onclick="app.promptBlockCustomer('${c.id}', '${c.name.replace(/'/g, "\\'")}')" style="background: rgba(229,57,53,0.15); color: #E53935; border: 1px solid #E53935; padding: 4px 10px; border-radius: 6px; font-size: 0.76rem; font-weight: 700; cursor: pointer;"><i class="fa-solid fa-user-slash"></i> Block</button>`
                }
                <button type="button" onclick="app.promptDeleteCustomer('${c.id}', '${c.name.replace(/'/g, "\\'")}')" style="background: rgba(158,158,176,0.15); color: #9E9EB0; border: 1px solid #9E9EB0; padding: 4px 8px; border-radius: 6px; font-size: 0.76rem; cursor: pointer;" title="Delete Customer Account"><i class="fa-solid fa-trash-can"></i></button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }

    // Render Mobile Cards View
    if (cardsEl) {
      cardsEl.innerHTML = list.map(c => {
        const isBlocked = (c.status || '').toLowerCase() === 'blocked';
        const regDate = new Date(c.created_at || Date.now()).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        const initials = (c.name || 'C').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();

        return `
          <div class="owner-tkt-card ${isBlocked ? 'rejected' : 'resolved'}" onclick="app.openCustomerDetailsModal('${c.id}')" style="border-left: 4px solid ${isBlocked ? '#E53935' : '#4CAF50'};">
            <div class="otc-top-bar">
              <div class="otc-user-info">
                <div class="otc-avatar">${initials}</div>
                <div>
                  <h4 class="otc-cust-name">${c.name}</h4>
                  <span class="otc-cust-phone"><i class="fa-solid fa-phone"></i> ${c.mobile}</span>
                </div>
              </div>
              <div class="otc-top-badges">
                <span class="status-badge" style="background: ${isBlocked ? 'rgba(229,57,53,0.18)' : 'rgba(76,175,80,0.18)'}; color: ${isBlocked ? '#E53935' : '#4CAF50'}; border: 1px solid ${isBlocked ? '#E53935' : '#4CAF50'}; padding: 3px 8px; border-radius: 12px; font-size: 0.72rem; font-weight: 700;">${isBlocked ? 'Blocked' : 'Active'}</span>
              </div>
            </div>

            <div class="otc-body" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 0.8rem;">
              <div><span style="color: var(--text-muted); display: block; font-size: 0.72rem;">TOTAL ORDERS</span><strong style="color: #FFF;">${c.total_orders || 0} Orders</strong></div>
              <div><span style="color: var(--text-muted); display: block; font-size: 0.72rem;">TOTAL SPENT</span><strong style="color: var(--accent-gold);">₹${Number(c.total_spent || 0).toLocaleString('en-IN')}</strong></div>
              <div style="grid-column: 1 / -1;"><span style="color: var(--text-muted); font-size: 0.72rem;">Joined: ${regDate} ${c.referral_code ? `• Code: ${c.referral_code}` : ''}</span></div>
            </div>

            <div class="otc-footer" style="display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px; flex-wrap: wrap;" onclick="event.stopPropagation()">
              <button type="button" class="btn-secondary-outline" onclick="app.openCustomerDetailsModal('${c.id}')" style="padding: 6px 10px; font-size: 0.78rem; flex: 1;"><i class="fa-solid fa-eye"></i> Details</button>
              <button type="button" class="btn-secondary-outline" onclick="app.promptResetCustomerPassword('${c.id}', '${c.name.replace(/'/g, "\\'")}', '${c.mobile}')" style="padding: 6px 10px; font-size: 0.78rem; color: var(--accent-gold); border-color: var(--accent-gold); flex: 1;"><i class="fa-solid fa-key"></i> Reset</button>
              ${isBlocked ? 
                `<button type="button" class="btn-secondary-outline" onclick="app.promptUnblockCustomer('${c.id}', '${c.name.replace(/'/g, "\\'")}')" style="padding: 6px 10px; font-size: 0.78rem; color: #4CAF50; border-color: #4CAF50; flex: 1;"><i class="fa-solid fa-user-check"></i> Unblock</button>` :
                `<button type="button" class="btn-secondary-outline" onclick="app.promptBlockCustomer('${c.id}', '${c.name.replace(/'/g, "\\'")}')" style="padding: 6px 10px; font-size: 0.78rem; color: #E53935; border-color: #E53935; flex: 1;"><i class="fa-solid fa-user-slash"></i> Block</button>`
              }
              <button type="button" class="btn-secondary-outline" onclick="app.promptDeleteCustomer('${c.id}', '${c.name.replace(/'/g, "\\'")}')" style="padding: 6px 10px; font-size: 0.78rem; color: #9E9EB0; border-color: #9E9EB0;" title="Delete Account"><i class="fa-solid fa-trash-can"></i></button>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  async openCustomerDetailsModal(customerId) {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/owner/customers/${customerId}`);
      const json = await res.json();

      if (!json.success || !json.data) {
        this.showToast(json.message || 'Unable to load customer details.', 'error');
        return;
      }

      const { customer, stats, recentOrders } = json.data;
      const isBlocked = (customer.status || '').toLowerCase() === 'blocked';
      const initials = (customer.name || 'C').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();

      document.getElementById('custModalHeaderName').innerText = `${customer.name} Profile`;
      document.getElementById('custModalAvatar').innerText = initials;
      document.getElementById('custModalName').innerText = customer.name;
      document.getElementById('custModalMobile').innerText = customer.mobile || 'N/A';
      document.getElementById('custModalEmail').innerText = customer.email || 'No email provided';
      document.getElementById('custModalRefCode').innerText = customer.referral_code || 'None';
      document.getElementById('custModalJoined').innerText = new Date(customer.created_at || Date.now()).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

      const badgeEl = document.getElementById('custModalStatusBadge');
      if (badgeEl) {
        badgeEl.innerText = isBlocked ? 'Blocked' : 'Active';
        badgeEl.className = `status-badge ${isBlocked ? 'st-rejected' : 'st-active'}`;
        badgeEl.style.cssText = `background: ${isBlocked ? 'rgba(229,57,53,0.18)' : 'rgba(76,175,80,0.18)'}; color: ${isBlocked ? '#E53935' : '#4CAF50'}; border: 1px solid ${isBlocked ? '#E53935' : '#4CAF50'}; padding: 4px 12px; border-radius: 12px; font-weight: 700;`;
      }

      document.getElementById('custModalTotalSpent').innerText = `₹${Number(stats.totalSpent || 0).toLocaleString('en-IN')}`;
      document.getElementById('custModalTotalOrders').innerText = stats.totalOrders || 0;
      document.getElementById('custModalCompletedOrders').innerText = stats.completedOrders || 0;
      document.getElementById('custModalCancelledOrders').innerText = stats.cancelledOrders || 0;

      // Render Recent Orders List
      const ordersContainer = document.getElementById('custModalRecentOrdersContainer');
      if (ordersContainer) {
        if (!recentOrders || !recentOrders.length) {
          ordersContainer.innerHTML = `<p style="font-size: 0.82rem; color: var(--text-muted); text-align: center; padding: 1rem;">No order history found for this customer.</p>`;
        } else {
          ordersContainer.innerHTML = recentOrders.map(o => {
            const orderDate = new Date(o.created_at || Date.now()).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
            return `
              <div style="background: rgba(10, 10, 14, 0.5); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                <div>
                  <strong style="color: var(--accent-gold); font-size: 0.88rem;">#${o.order_number}</strong>
                  <span style="font-size: 0.76rem; color: var(--text-muted); display: block;">${orderDate} • ${o.payment_method || 'Cash'}</span>
                </div>
                <div style="text-align: right;">
                  <span style="color: #FFF; font-weight: 800; font-size: 0.9rem; display: block;">₹${o.net_amount}</span>
                  <span style="font-size: 0.72rem; color: ${o.order_status === 'Delivered' || o.order_status === 'Completed' ? '#4CAF50' : (o.order_status === 'Cancelled' ? '#FF5252' : '#0288D1')}; font-weight: 700;">${o.order_status}</span>
                </div>
              </div>
            `;
          }).join('');
        }
      }

      // Action Buttons in Details Modal Footer
      const actionsEl = document.getElementById('custModalActionButtons');
      if (actionsEl) {
        const safeName = customer.name.replace(/'/g, "\\'");
        actionsEl.innerHTML = `
          <button type="button" class="btn-auth-primary" onclick="app.closeCustomerDetailsModal(); app.promptResetCustomerPassword('${customer.id}', '${safeName}', '${customer.mobile}')" style="background: linear-gradient(135deg, var(--primary), var(--accent-gold)); border-color: var(--accent-gold); color: #FFF; padding: 6px 14px; font-size: 0.8rem;"><i class="fa-solid fa-key"></i> 🔐 Reset Customer Password</button>
          ${isBlocked ?
            `<button type="button" class="btn-auth-primary" onclick="app.closeCustomerDetailsModal(); app.promptUnblockCustomer('${customer.id}', '${safeName}')" style="background: #4CAF50; border-color: #4CAF50; padding: 6px 14px; font-size: 0.8rem;"><i class="fa-solid fa-user-check"></i> Unblock Customer</button>` :
            `<button type="button" class="btn-auth-primary" onclick="app.closeCustomerDetailsModal(); app.promptBlockCustomer('${customer.id}', '${safeName}')" style="background: #E53935; border-color: #E53935; padding: 6px 14px; font-size: 0.8rem;"><i class="fa-solid fa-user-slash"></i> Block Customer</button>`
          }
          <button type="button" class="btn-secondary-outline" onclick="app.closeCustomerDetailsModal(); app.promptDeleteCustomer('${customer.id}', '${safeName}')" style="color: #9E9EB0; border-color: #9E9EB0; padding: 6px 12px; font-size: 0.8rem;"><i class="fa-solid fa-trash-can"></i> Delete Account</button>
        `;
      }

      const backdrop = document.getElementById('ownerCustomerDetailsModalBackdrop');
      if (backdrop) backdrop.classList.add('open');
    } catch (err) {
      console.error('Error loading customer details modal:', err);
      this.showToast('Server communication error loading customer details.', 'error');
    }
  }

  closeCustomerDetailsModal() {
    const backdrop = document.getElementById('ownerCustomerDetailsModalBackdrop');
    if (backdrop) backdrop.classList.remove('open');
  }

  promptBlockCustomer(customerId, customerName) {
    this.pendingCustomerAction = {
      type: 'BLOCK',
      id: customerId,
      name: customerName
    };

    document.getElementById('confirmModalIconBox').innerHTML = `<i class="fa-solid fa-user-slash" style="color: #E53935;"></i>`;
    document.getElementById('confirmModalTitle').innerText = 'Block Customer Account?';
    document.getElementById('confirmModalMessage').innerText = `Are you sure you want to block ${customerName}? They will no longer be able to log in or place orders.`;
    
    const btnExecute = document.getElementById('btnConfirmModalExecute');
    if (btnExecute) {
      btnExecute.innerText = 'Block Customer';
      btnExecute.style.background = '#E53935';
      btnExecute.style.borderColor = '#E53935';
    }

    const backdrop = document.getElementById('ownerCustomerConfirmModalBackdrop');
    if (backdrop) backdrop.classList.add('open');
  }

  promptUnblockCustomer(customerId, customerName) {
    this.pendingCustomerAction = {
      type: 'UNBLOCK',
      id: customerId,
      name: customerName
    };

    document.getElementById('confirmModalIconBox').innerHTML = `<i class="fa-solid fa-user-check" style="color: #4CAF50;"></i>`;
    document.getElementById('confirmModalTitle').innerText = 'Unblock Customer Account?';
    document.getElementById('confirmModalMessage').innerText = `Are you sure you want to unblock ${customerName}? They will be allowed to log in and place orders again.`;
    
    const btnExecute = document.getElementById('btnConfirmModalExecute');
    if (btnExecute) {
      btnExecute.innerText = 'Unblock Customer';
      btnExecute.style.background = '#4CAF50';
      btnExecute.style.borderColor = '#4CAF50';
    }

    const backdrop = document.getElementById('ownerCustomerConfirmModalBackdrop');
    if (backdrop) backdrop.classList.add('open');
  }

  promptDeleteCustomer(customerId, customerName) {
    this.pendingCustomerAction = {
      type: 'DELETE',
      id: customerId,
      name: customerName
    };

    document.getElementById('confirmModalIconBox').innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color: #E53935;"></i>`;
    document.getElementById('confirmModalTitle').innerText = 'Delete Customer Account Permanently?';
    document.getElementById('confirmModalMessage').innerText = `Are you sure you want to permanently delete ${customerName}'s account? This action cannot be undone. Historical order and payment records will be preserved.`;
    
    const btnExecute = document.getElementById('btnConfirmModalExecute');
    if (btnExecute) {
      btnExecute.innerText = 'Delete Permanently';
      btnExecute.style.background = '#E53935';
      btnExecute.style.borderColor = '#E53935';
    }

    const backdrop = document.getElementById('ownerCustomerConfirmModalBackdrop');
    if (backdrop) backdrop.classList.add('open');
  }

  promptResetCustomerPassword(customerId, customerName, customerMobile) {
    this.pendingCustomerAction = {
      type: 'RESET_PASSWORD',
      id: customerId,
      name: customerName,
      mobile: customerMobile
    };

    const maskedMobile = customerMobile ? customerMobile.replace(/^(\d{2})\d{4}(\d{4})$/, '$1****$2') : (customerMobile || 'N/A');

    document.getElementById('confirmModalIconBox').innerHTML = `<i class="fa-solid fa-key" style="color: var(--accent-gold);"></i>`;
    document.getElementById('confirmModalTitle').innerText = 'Reset password for this customer?';
    document.getElementById('confirmModalMessage').innerHTML = `
      <div style="text-align: left; background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); padding: 12px 16px; border-radius: 8px; margin-top: 8px;">
        <div style="margin-bottom: 6px;"><span style="color: var(--text-muted); font-size: 0.8rem;">Customer:</span> <strong style="color: #FFF;">${customerName}</strong></div>
        <div><span style="color: var(--text-muted); font-size: 0.8rem;">Mobile:</span> <strong style="color: var(--accent-gold);">${maskedMobile} (${customerMobile})</strong></div>
      </div>
      <p style="font-size: 0.82rem; color: var(--text-muted); margin-top: 10px;">A secure temporary password will be generated for the customer. The customer will be forced to change it upon login.</p>
    `;

    const btnExecute = document.getElementById('btnConfirmModalExecute');
    if (btnExecute) {
      btnExecute.innerText = 'Confirm Reset';
      btnExecute.style.background = 'linear-gradient(135deg, var(--primary), var(--accent-gold))';
      btnExecute.style.borderColor = 'var(--accent-gold)';
    }

    const backdrop = document.getElementById('ownerCustomerConfirmModalBackdrop');
    if (backdrop) backdrop.classList.add('open');
  }

  closeCustomerConfirmModal() {
    this.pendingCustomerAction = null;
    const backdrop = document.getElementById('ownerCustomerConfirmModalBackdrop');
    if (backdrop) backdrop.classList.remove('open');
  }

  async executeCustomerConfirmAction() {
    if (!this.pendingCustomerAction) return;

    const { type, id, name } = this.pendingCustomerAction;
    this.closeCustomerConfirmModal();

    try {
      let res, json;
      if (type === 'BLOCK' || type === 'UNBLOCK') {
        const targetStatus = type === 'BLOCK' ? 'blocked' : 'active';
        res = await this.fetchWithAuth(`${API_BASE}/owner/customers/${id}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: targetStatus })
        });
      } else if (type === 'DELETE') {
        res = await this.fetchWithAuth(`${API_BASE}/owner/customers/${id}`, {
          method: 'DELETE'
        });
      } else if (type === 'RESET_PASSWORD') {
        res = await this.fetchWithAuth(`${API_BASE}/owner/customers/${id}/reset-password`, {
          method: 'POST'
        });
      }

      json = await res.json();
      if (json.success) {
        if (type === 'RESET_PASSWORD' && json.temporaryPassword) {
          this.lastGeneratedTempPassword = json.temporaryPassword;
          const infoEl = document.getElementById('ownerTempPassCustInfo');
          if (infoEl) infoEl.innerHTML = `Temporary password generated for customer <strong>${name}</strong> (${json.customer?.mobile || ''}).`;
          const passEl = document.getElementById('ownerDisplayTempPassword');
          if (passEl) passEl.innerText = json.temporaryPassword;
          
          const tempBackdrop = document.getElementById('ownerTempPasswordModalBackdrop');
          if (tempBackdrop) tempBackdrop.classList.add('open');
          
          this.showToast('✅ Customer password reset successfully.', 'success');
        } else {
          this.showToast(json.message, 'success');
        }
        await this.fetchOwnerCustomers();
      } else {
        this.showToast(json.message || 'Action failed.', 'error');
      }
    } catch (err) {
      console.error('Error executing customer action:', err);
      this.showToast('Server error executing customer action.', 'error');
    }
  }

  closeOwnerTempPasswordModal() {
    this.lastGeneratedTempPassword = null;
    const backdrop = document.getElementById('ownerTempPasswordModalBackdrop');
    if (backdrop) backdrop.classList.remove('open');
  }

  async copyTempPassword() {
    if (!this.lastGeneratedTempPassword) return;
    try {
      await navigator.clipboard.writeText(this.lastGeneratedTempPassword);
      this.showToast('✅ Temporary password copied to clipboard!', 'success');
    } catch (err) {
      this.showToast(`Temporary password: ${this.lastGeneratedTempPassword}`, 'info');
    }
  }

  checkPasswordChangeRequired() {
    if (this.currentUser && this.currentUser.role === 'CUSTOMER' && (this.currentUser.password_change_required || this.currentUser.passwordChangeRequired)) {
      const backdrop = document.getElementById('forcedChangePasswordModalBackdrop');
      if (!backdrop || !backdrop.classList.contains('open')) {
        this.showForcedChangePasswordModal();
      }
    }
  }

  showForcedChangePasswordModal() {
    const backdrop = document.getElementById('forcedChangePasswordModalBackdrop');
    const isAlreadyOpen = backdrop && backdrop.classList.contains('open');

    if (!isAlreadyOpen) {
      const errBox = document.getElementById('forcedChangePasswordError');
      if (errBox) { errBox.style.display = 'none'; errBox.innerText = ''; }
      
      const input0 = document.getElementById('forcedCurrentPassword');
      const input1 = document.getElementById('forcedNewPassword');
      const input2 = document.getElementById('forcedConfirmPassword');
      if (input0) input0.value = '';
      if (input1) input1.value = '';
      if (input2) input2.value = '';
    }

    if (backdrop) backdrop.classList.add('open');
  }

  async submitForcedPasswordChange() {
    const currentPassword = (document.getElementById('forcedCurrentPassword')?.value || '').trim();
    const newPassword = (document.getElementById('forcedNewPassword')?.value || '').trim();
    const confirmPassword = (document.getElementById('forcedConfirmPassword')?.value || '').trim();
    const errBox = document.getElementById('forcedChangePasswordError');

    const showError = (msg) => {
      if (errBox) { errBox.innerText = msg; errBox.style.display = 'block'; }
      else { this.showToast(msg, 'error'); }
    };

    if (!currentPassword || !newPassword || !confirmPassword) {
      showError('Please enter all password fields.');
      return;
    }

    if (newPassword !== confirmPassword) {
      showError('New password and confirm password do not match.');
      return;
    }

    if (newPassword.length < 6) {
      showError('Password must be at least 6 characters long.');
      return;
    }

    const btn = document.getElementById('btnForcedChangePasswordSubmit');
    if (btn) { btn.disabled = true; btn.innerText = 'Changing Password...'; }

    try {
      const res = await fetch(`${API_BASE}/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`,
          'X-Auth-Token': this.authToken
        },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
      });

      const json = await res.json();
      if (json.success) {
        if (errBox) errBox.style.display = 'none';
        
        if (this.currentUser) {
          this.currentUser.password_change_required = false;
          this.currentUser.passwordChangeRequired = false;
          if (json.user) this.currentUser = { ...this.currentUser, ...json.user };
          localStorage.setItem('tiffin_user', JSON.stringify(this.currentUser));
        }

        const backdrop = document.getElementById('forcedChangePasswordModalBackdrop');
        if (backdrop) backdrop.classList.remove('open');

        this.showToast('✅ Password changed successfully.', 'success');
        this.renderNavigation();
        this.renderCurrentView();
      } else {
        showError(json.message || 'Unable to change password. Please try again.');
      }
    } catch (err) {
      console.error('Error submitting forced password change:', err);
      showError('Unable to change password. Please try again.');
    } finally {
      if (btn) { btn.disabled = false; btn.innerText = '🔐 Change Password'; }
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
  }

  // =========================================================================
  // CUSTOMER 20-MINUTE INACTIVITY AUTO-LOGOUT ENGINE
  // =========================================================================

  initCustomerInactivityEngine() {
    if (!localStorage.getItem('tiffin_customer_last_activity')) {
      localStorage.setItem('tiffin_customer_last_activity', Date.now().toString());
    }

    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'];
    activityEvents.forEach(evt => {
      window.addEventListener(evt, () => this.onCustomerGenuineActivity(), { passive: true });
    });

    window.addEventListener('storage', (e) => {
      if (e.key === 'tiffin_customer_last_activity' && e.newValue) {
        const remoteTime = Number(e.newValue);
        if (remoteTime > this.lastCustomerActivityTimestamp) {
          this.lastCustomerActivityTimestamp = remoteTime;
          if (this.isWarningModalShowing) {
            this.hideInactivityWarningModal();
          }
        }
      } else if (e.key === 'tiffin_customer_logout_signal' && e.newValue) {
        if (this.currentUser && this.currentUser.role === 'CUSTOMER') {
          this.executeInactivityLogoutCleanup("You have been logged out due to 20 minutes of inactivity.");
        }
      }
    });

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.inactivityBroadcastChannel = new BroadcastChannel('tiffin_customer_inactivity');
        this.inactivityBroadcastChannel.onmessage = (msg) => {
          if (!msg || !msg.data) return;
          if (msg.data.type === 'ACTIVITY') {
            if (msg.data.timestamp > this.lastCustomerActivityTimestamp) {
              this.lastCustomerActivityTimestamp = msg.data.timestamp;
              if (this.isWarningModalShowing) {
                this.hideInactivityWarningModal();
              }
            }
          } else if (msg.data.type === 'LOGOUT') {
            if (this.currentUser && this.currentUser.role === 'CUSTOMER') {
              this.executeInactivityLogoutCleanup("You have been logged out due to 20 minutes of inactivity.");
            }
          }
        };
      } catch (e) {
        console.warn('BroadcastChannel error:', e);
      }
    }

    if (this.inactivityCheckInterval) clearInterval(this.inactivityCheckInterval);
    this.inactivityCheckInterval = setInterval(() => this.checkCustomerInactivity(), 1000);
  }

  onCustomerGenuineActivity() {
    if (!this.currentUser || this.currentUser.role !== 'CUSTOMER') return;

    const now = Date.now();
    if (now - this.lastCustomerActivityTimestamp < 1000) return;

    this.lastCustomerActivityTimestamp = now;
    localStorage.setItem('tiffin_customer_last_activity', now.toString());

    if (this.isWarningModalShowing) {
      this.hideInactivityWarningModal();
    }

    if (now - this.lastBroadcastActivityTime > 5000) {
      this.lastBroadcastActivityTime = now;
      if (this.inactivityBroadcastChannel) {
        try {
          this.inactivityBroadcastChannel.postMessage({ type: 'ACTIVITY', timestamp: now });
        } catch (e) {}
      }
    }
  }

  checkCustomerInactivity() {
    if (!this.currentUser || this.currentUser.role !== 'CUSTOMER') {
      if (this.isWarningModalShowing) {
        this.hideInactivityWarningModal();
      }
      return;
    }

    const storedLastActivity = Number(localStorage.getItem('tiffin_customer_last_activity') || 0);
    const lastActive = Math.max(this.lastCustomerActivityTimestamp || 0, storedLastActivity || 0);
    const elapsed = Date.now() - lastActive;

    if (elapsed >= this.customerInactivityDurationMs) {
      this.triggerInactivityLogout("You have been logged out due to 20 minutes of inactivity.");
    } else if (elapsed >= this.customerWarningDurationMs) {
      const remainingSeconds = Math.max(0, Math.ceil((this.customerInactivityDurationMs - elapsed) / 1000));
      this.showInactivityWarningModal(remainingSeconds);
    } else {
      if (this.isWarningModalShowing) {
        this.hideInactivityWarningModal();
      }
    }
  }

  showInactivityWarningModal(remainingSeconds) {
    this.isWarningModalShowing = true;
    const backdrop = document.getElementById('inactivityWarningModalBackdrop');
    const elSec = document.getElementById('inactivityCountdownSeconds');
    if (elSec) {
      elSec.innerText = remainingSeconds.toString();
    }
    if (backdrop) {
      backdrop.classList.remove('hidden');
    }
  }

  hideInactivityWarningModal() {
    this.isWarningModalShowing = false;
    const backdrop = document.getElementById('inactivityWarningModalBackdrop');
    if (backdrop) {
      backdrop.classList.add('hidden');
    }
  }

  extendCustomerSession() {
    this.lastCustomerActivityTimestamp = Date.now();
    localStorage.setItem('tiffin_customer_last_activity', Date.now().toString());
    this.hideInactivityWarningModal();

    if (this.inactivityBroadcastChannel) {
      try {
        this.inactivityBroadcastChannel.postMessage({ type: 'ACTIVITY', timestamp: Date.now() });
      } catch (e) {}
    }

    this.fetchWithAuth(`${API_BASE}/auth/activity`, { method: 'POST' }).catch(() => {});
  }

  triggerInactivityLogout(reason = "You have been logged out due to 20 minutes of inactivity.") {
    this.hideInactivityWarningModal();

    localStorage.setItem('tiffin_customer_logout_signal', Date.now().toString());
    if (this.inactivityBroadcastChannel) {
      try {
        this.inactivityBroadcastChannel.postMessage({ type: 'LOGOUT', timestamp: Date.now() });
      } catch (e) {}
    }

    this.executeInactivityLogoutCleanup(reason);
  }

  executeInactivityLogoutCleanup(reason = "You have been logged out due to 20 minutes of inactivity.") {
    if (this.authToken) {
      fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.authToken}`,
          'X-Auth-Token': this.authToken
        }
      }).catch(() => {});
    }

    this.currentUser = null;
    this.authToken = null;
    this.currentRole = 'CUSTOMER';
    this.activeView = 'secCustomerHome';
    this.cart = [];
    this.favorites = [];
    this.orders = [];
    this.payments = [];
    this.notifications = [];
    this.supportTickets = [];
    this.referralStats = null;
    this.customerProfile = null;
    this.isLoadingOrders = false;
    this.isLoadingPayments = false;
    this.isLoadingStats = false;
    this.knownNotificationIds.clear();
    this.isFirstNotificationFetch = true;
    this.closeWebSocket();

    localStorage.removeItem('tiffin_token');
    localStorage.removeItem('tiffin_user');
    localStorage.removeItem('tiffin_customer_last_activity');
    sessionStorage.clear();

    this.showToast(reason, 'info');

    this.updateUserAuthBadgeUI();
    this.renderNavigation();
    this.renderCurrentView();
    this.updateCartUI();

    this.openAuthModal('LOGIN', 'CUSTOMER');
  }

  // =========================================================================
  // LIVE 3-MINUTE ORDER MODIFICATION & CANCELLATION ENGINE
  // =========================================================================

  startModificationTimerTicker() {
    if (this.modTimerInterval) clearInterval(this.modTimerInterval);
    this.modTimerInterval = setInterval(() => {
      const timerEls = document.querySelectorAll('[data-order-timer-id]');
      if (!timerEls || !timerEls.length) return;

      timerEls.forEach(el => {
        const createdAt = el.getAttribute('data-created-at');
        const orderId = el.getAttribute('data-order-timer-id');
        if (!createdAt) return;

        const createdAtMs = new Date(createdAt).getTime();
        const elapsedMs = Date.now() - createdAtMs;
        const remainingSecs = Math.max(0, Math.floor((180000 - elapsedMs) / 1000));

        if (remainingSecs > 0) {
          const minsStr = String(Math.floor(remainingSecs / 60)).padStart(2, '0');
          const secsStr = String(remainingSecs % 60).padStart(2, '0');
          el.innerText = `${minsStr}:${secsStr}`;
        } else {
          el.innerText = '00:00';
          const containerBox = el.closest('.order-mod-timer-box');
          if (containerBox) {
            containerBox.innerHTML = '<i class="fa-solid fa-hourglass-end"></i> Modification window expired.';
            containerBox.style.background = 'rgba(255,255,255,0.04)';
            containerBox.style.borderColor = 'var(--border-color)';
            containerBox.style.color = 'var(--text-muted)';
          }
          const btnEdit = document.getElementById(`btnEditOrder_${orderId}`);
          if (btnEdit) {
            btnEdit.disabled = true;
            btnEdit.style.opacity = '0.5';
            btnEdit.style.cursor = 'not-allowed';
          }
        }
      });
    }, 1000);
  }

  async openEditOrderModal(orderId) {
    if (!orderId) return;
    let order = (this.orders || []).find(o => o.id === orderId || o.order_number === orderId || String(o.id) === String(orderId) || String(o.order_number) === String(orderId));

    if (!order) {
      await this.fetchOrders(true);
      order = (this.orders || []).find(o => o.id === orderId || o.order_number === orderId || String(o.id) === String(orderId) || String(o.order_number) === String(orderId));
    }

    if (!order) {
      this.showToast('Order details loading, please try again.', 'info');
      return;
    }

    // Check cutoff
    const createdAtMs = new Date(order.created_at || Date.now()).getTime();
    if (Date.now() - createdAtMs >= 180000 || !['Received', 'Pending'].includes(order.order_status)) {
      this.showToast('Modification window has expired for this order.', 'warning');
      return;
    }

    this.editingOrder = JSON.parse(JSON.stringify(order));
    this.editingOrderItems = (this.editingOrder.items || []).map(i => ({ ...i }));

    const elId = document.getElementById('editTargetOrderId');
    const elNum = document.getElementById('editModalOrderNumDisplay');
    if (elId) elId.value = order.id;
    if (elNum) elNum.innerText = `#${order.order_number}`;

    this.renderEditModalItems();

    const backdrop = document.getElementById('editOrderModalBackdrop');
    if (backdrop) {
      backdrop.style.display = 'flex';
      backdrop.classList.add('open');
    }
  }

  renderEditModalItems() {
    const container = document.getElementById('editOrderItemsListContainer');
    if (!container) return;

    if (!this.editingOrderItems || !this.editingOrderItems.length) {
      container.innerHTML = `<p style="font-size: 0.85rem; color: #FF5252; padding: 1rem; text-align: center;">No items in order.</p>`;
      return;
    }

    let subtotal = 0;
    container.innerHTML = this.editingOrderItems.map((item, idx) => {
      const qty = Number(item.quantity || 0);
      const price = Number(item.price || 0);
      const lineTotal = price * qty;
      subtotal += lineTotal;

      return `
        <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.03); padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border-color); margin-bottom: 8px;">
          <div>
            <strong style="font-size: 0.88rem; color: #FFF; display: block;">${item.name}</strong>
            <span style="font-size: 0.78rem; color: var(--accent-gold);">₹${price} each</span>
          </div>

          <div style="display: flex; align-items: center; gap: 10px;">
            <div style="display: inline-flex; align-items: center; background: rgba(0,0,0,0.4); border: 1px solid var(--border-color); border-radius: 6px;">
              <button type="button" onclick="app.changeEditQty(${idx}, -1)" style="background: none; border: none; color: #FFF; width: 28px; height: 28px; font-weight: 800; cursor: pointer;">-</button>
              <span style="font-size: 0.88rem; font-weight: 800; color: var(--accent-gold); width: 24px; text-align: center;">${qty}</span>
              <button type="button" onclick="app.changeEditQty(${idx}, 1)" style="background: none; border: none; color: #FFF; width: 28px; height: 28px; font-weight: 800; cursor: pointer;">+</button>
            </div>
            <span style="font-size: 0.9rem; font-weight: 800; color: #FFF; min-width: 50px; text-align: right;">₹${lineTotal}</span>
          </div>
        </div>
      `;
    }).join('');

    const elSubtotal = document.getElementById('editModalSubtotalDisplay');
    const elTotal = document.getElementById('editModalTotalDisplay');
    if (elSubtotal) elSubtotal.innerText = `₹${subtotal}`;
    if (elTotal) elTotal.innerText = `₹${subtotal}`;
  }

  changeEditQty(idx, delta) {
    if (!this.editingOrderItems || !this.editingOrderItems[idx]) return;
    const currentQty = Number(this.editingOrderItems[idx].quantity || 0);
    const newQty = Math.max(0, currentQty + delta);
    this.editingOrderItems[idx].quantity = newQty;
    this.renderEditModalItems();
  }

  closeEditOrderModal() {
    const backdrop = document.getElementById('editOrderModalBackdrop');
    if (backdrop) {
      backdrop.classList.remove('open');
      backdrop.style.display = '';
    }
    this.editingOrder = null;
    this.editingOrderItems = null;
  }

  async submitOrderModification(e) {
    e.preventDefault();
    if (this.isSubmittingOrderEdit) return;

    const orderId = document.getElementById('editTargetOrderId')?.value;
    if (!orderId || !this.editingOrderItems) return;

    const activeItems = this.editingOrderItems.filter(i => Number(i.quantity) > 0);
    if (!activeItems.length) {
      this.showToast('Order must contain at least one item.', 'error');
      return;
    }

    const btnSubmit = document.getElementById('btnSubmitOrderEdit');
    this.isSubmittingOrderEdit = true;
    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/orders/${orderId}/modify`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: activeItems })
      });
      const json = await res.json();
      if (json.success) {
        if (json.wallet_balance !== undefined && this.currentUser) {
          this.currentUser.wallet_balance = json.wallet_balance;
        }
        this.showToast(json.message || 'Order modified successfully!', 'success');
        this.closeEditOrderModal();
        await this.fetchOrders();
        await this.fetchNotifications();
      } else {
        this.showToast(json.message || 'Failed to modify order.', 'error');
      }
    } catch (err) {
      console.error('Error modifying order:', err);
      this.showToast('Failed to modify order.', 'error');
    } finally {
      this.isSubmittingOrderEdit = false;
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Changes`;
      }
    }
  }

  async openCancelOrderModal(orderId) {
    if (!orderId) return;
    let order = (this.orders || []).find(o => o.id === orderId || o.order_number === orderId || String(o.id) === String(orderId) || String(o.order_number) === String(orderId));

    if (!order) {
      await this.fetchOrders(true);
      order = (this.orders || []).find(o => o.id === orderId || o.order_number === orderId || String(o.id) === String(orderId) || String(o.order_number) === String(orderId));
    }

    if (!order) {
      this.showToast('Order details loading, please try again.', 'info');
      return;
    }

    if (['preparing', 'ready', 'completed', 'cancelled', 'rejected'].includes((order.order_status || '').toLowerCase())) {
      this.showToast(`Order #${order.order_number} cannot be cancelled because its status is "${order.order_status}".`, 'warning');
      return;
    }

    const elId = document.getElementById('cancelTargetOrderId');
    const elNum = document.getElementById('cancelModalOrderNumDisplay');
    if (elId) elId.value = order.id;
    if (elNum) elNum.innerText = `#${order.order_number}`;

    const radios = document.getElementsByName('cancelReasonRadio');
    if (radios.length) radios[0].checked = true;

    const otherWrapper = document.getElementById('cancelOtherReasonWrapper');
    if (otherWrapper) otherWrapper.classList.add('hidden');

    const customInput = document.getElementById('cancelCustomReasonInput');
    if (customInput) customInput.value = '';

    const backdrop = document.getElementById('cancelOrderModalBackdrop');
    if (backdrop) {
      backdrop.style.display = 'flex';
      backdrop.classList.add('open');
    }
  }

  handleCancelReasonRadioChange(val) {
    const otherWrapper = document.getElementById('cancelOtherReasonWrapper');
    if (otherWrapper) {
      otherWrapper.classList.toggle('hidden', val !== 'Other');
    }
  }

  closeCancelOrderModal() {
    const backdrop = document.getElementById('cancelOrderModalBackdrop');
    if (backdrop) {
      backdrop.classList.remove('open');
      backdrop.style.display = '';
    }
  }

  async submitOrderCancellation(e) {
    e.preventDefault();
    if (this.isSubmittingOrderCancel) return;

    const orderId = document.getElementById('cancelTargetOrderId')?.value;
    if (!orderId) return;

    const selectedRadio = document.querySelector('input[name="cancelReasonRadio"]:checked')?.value || 'Ordered by mistake';
    let reason = selectedRadio;
    if (selectedRadio === 'Other') {
      const customText = document.getElementById('cancelCustomReasonInput')?.value?.trim();
      if (!customText) {
        this.showToast('Please enter your cancellation reason.', 'warning');
        return;
      }
      reason = customText;
    }

    const btnSubmit = document.getElementById('btnSubmitOrderCancel');
    this.isSubmittingOrderCancel = true;
    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Cancelling...`;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/orders/${orderId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason })
      });
      const json = await res.json();
      if (json.success) {
        if (json.wallet_balance !== undefined && this.currentUser) {
          this.currentUser.wallet_balance = json.wallet_balance;
        }
        this.showToast(json.message || 'Order cancelled successfully.', 'success');
        this.closeCancelOrderModal();
        await this.fetchOrders();
        await this.fetchNotifications();
        await this.fetchReferralStats();
      } else {
        this.showToast(json.message || 'Failed to cancel order.', 'error');
      }
    } catch (err) {
      console.error('Error cancelling order:', err);
      this.showToast('Failed to cancel order.', 'error');
    } finally {
      this.isSubmittingOrderCancel = false;
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = `<i class="fa-solid fa-ban"></i> Confirm Cancellation`;
      }
    }
  }

  async downloadDatabaseBackup(format = 'json') {
    if (!this.currentUser || this.currentRole !== 'OWNER') {
      this.showToast('Access denied: Owner authorization required.', 'error');
      return;
    }

    try {
      this.showToast(`⏳ Preparing database backup dump (${format.toUpperCase()})...`, 'info');

      const res = await this.fetchWithAuth(`${API_BASE}/admin/export-database?format=${encodeURIComponent(format)}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: Failed to download backup.`);
      }

      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      const timestamp = new Date().toISOString().slice(0, 10);
      a.download = `postgres_backup_${timestamp}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);

      this.showToast(`✅ Database backup (${format.toUpperCase()}) downloaded successfully!`, 'success');
    } catch (err) {
      console.error('Error downloading database backup:', err);
      this.showToast('Failed to download database backup.', 'error');
    }
  }

  // =========================================================================
  // LOYALTY REWARDS SYSTEM FRONTEND ENGINE
  // =========================================================================

  async loadLoyaltyRewardsPage() {
    if (!this.currentUser) return;
    try {
      // 1. Fetch Loyalty Summary
      const res = await this.fetchWithAuth(`${API_BASE}/loyalty/summary`);
      const json = await res.json();
      if (json.success && json.data) {
        const d = json.data;
        const ptsEl = document.getElementById('loyaltyAvailablePoints');
        const valEl = document.getElementById('loyaltyRewardValue');
        if (ptsEl) ptsEl.innerText = `${d.points} ⭐`;
        if (valEl) valEl.innerText = `₹${d.reward_balance}`;

        // Disable redemption buttons if insufficient points
        const b100 = document.getElementById('btnRedeem100');
        const b200 = document.getElementById('btnRedeem200');
        const b500 = document.getElementById('btnRedeem500');
        if (b100) b100.disabled = d.points < 100;
        if (b200) b200.disabled = d.points < 200;
        if (b500) b500.disabled = d.points < 500;

        // Update profile stat badge if present
        const profPts = document.getElementById('profStatLoyaltyPoints');
        if (profPts) profPts.innerText = `${d.points} ⭐`;
      }

      // 2. Fetch Loyalty History
      const hRes = await this.fetchWithAuth(`${API_BASE}/loyalty/history`);
      const hJson = await hRes.json();
      const tbody = document.getElementById('loyaltyHistoryTableBody');
      if (tbody) {
        if (hJson.success && hJson.data && hJson.data.length > 0) {
          tbody.innerHTML = hJson.data.map(t => {
            const isEarned = t.type === 'EARNED';
            const ptsClass = isEarned ? 'color: var(--color-available); font-weight: 800;' : 'color: #E53935; font-weight: 800;';
            const ptsSign = t.points > 0 ? `+${t.points}` : `${t.points}`;
            const dtStr = t.created_at ? new Date(t.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'N/A';
            return `
              <tr>
                <td style="font-size: 0.85rem; color: var(--text-muted);">${dtStr}</td>
                <td style="${ptsClass}">${ptsSign} ⭐</td>
                <td style="font-weight: 600;">${t.description || t.type}</td>
                <td style="color: #FFF; font-weight: 700;">${t.balance_after} ⭐</td>
              </tr>
            `;
          }).join('');
        } else {
          tbody.innerHTML = `
            <tr>
              <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">
                No loyalty transactions yet. Complete orders to earn points!
              </td>
            </tr>
          `;
        }
      }
    } catch (err) {
      console.error('Error loading loyalty rewards page:', err);
    }
  }

  confirmRedeemLoyalty(points, rewardVal) {
    this.pendingLoyaltyRedeem = { points, rewardVal };
    const title = document.getElementById('loyaltyRedeemModalTitle');
    const msg = document.getElementById('loyaltyRedeemModalMessage');
    if (title) title.innerText = `Confirm Redemption`;
    if (msg) msg.innerText = `Redeem ${points} points for ₹${rewardVal} reward value?`;
    this.toggleLoyaltyRedeemModal(true);
  }

  toggleLoyaltyRedeemModal(open) {
    const backdrop = document.getElementById('loyaltyRedeemModalBackdrop');
    if (backdrop) backdrop.classList.toggle('open', Boolean(open));
  }

  async executeLoyaltyRedeem() {
    if (!this.pendingLoyaltyRedeem) return;
    const { points, rewardVal } = this.pendingLoyaltyRedeem;
    const btn = document.getElementById('btnConfirmLoyaltyRedeem');
    if (btn) { btn.disabled = true; btn.innerText = 'Processing...'; }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/loyalty/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points })
      });
      const json = await res.json();
      this.toggleLoyaltyRedeemModal(false);

      if (json.success) {
        this.showToast(json.message, 'success');
        this.playNotificationChime();
        this.loadLoyaltyRewardsPage();
      } else {
        this.showToast(json.message || 'Redemption failed.', 'error');
      }
    } catch (err) {
      console.error('Redeem loyalty points error:', err);
      this.showToast('Network error during redemption.', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerText = 'Confirm'; }
      this.pendingLoyaltyRedeem = null;
    }
  }

  async toggleCheckoutLoyaltyDiscount() {
    const chk = document.getElementById('chkUseLoyalty');
    const breakdown = document.getElementById('loyaltyAppliedBreakdown');
    const discountText = document.getElementById('loyaltyBreakdownDiscount');
    if (!chk) return;

    if (chk.checked) {
      try {
        const res = await this.fetchWithAuth(`${API_BASE}/loyalty/summary`);
        const json = await res.json();
        const bal = json.data?.reward_balance || 0;
        if (bal <= 0) {
          chk.checked = false;
          this.showToast('You do not have any available loyalty reward balance to use.', 'info');
          if (breakdown) breakdown.classList.add('hidden');
          return;
        }
        if (breakdown) breakdown.classList.remove('hidden');
        if (discountText) discountText.innerText = `-₹${bal}`;
      } catch (e) {
        chk.checked = false;
      }
    } else {
      if (breakdown) breakdown.classList.add('hidden');
    }
    this.updateCheckoutTotalsUI();
  }

  // =========================================================================
  // PREMIUM FOOD MEMBER CARD SYSTEM CLIENT CONTROLLER (₹10 / 3-MONTH)
  // =========================================================================

  async loadFoodMemberCardState() {
    const container = document.getElementById('memberCardContent');
    if (!container) return;

    if (!this.currentUser) {
      container.innerHTML = `
        <div class="card" style="padding: 30px; text-align: center; border-radius: 16px; background: var(--card-bg, #FFF);">
          <i class="fa-solid fa-lock" style="font-size: 2.5rem; color: var(--primary, #E53935); margin-bottom: 15px;"></i>
          <h3>Authentication Required</h3>
          <p style="color: #666; margin-bottom: 20px;">Please login or register as a customer to apply for or view your Premium Food Member Card.</p>
          <button class="btn-primary" onclick="app.openAuthModal('CUSTOMER', 'LOGIN')"><i class="fa-solid fa-right-to-bracket"></i> Login / Register</button>
        </div>
      `;
      return;
    }

    container.innerHTML = `<div style="text-align: center; padding: 40px; color: #888;"><i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem;"></i><p style="margin-top: 10px;">Loading membership status...</p></div>`;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/food-member/status`);
      const data = await res.json();

      if (!data.success) {
        throw new Error(data.message || 'Failed to fetch status');
      }

      this.currentMemberState = data;
      this.renderFoodMemberCardUI(data);
    } catch (err) {
      console.error('Error loading food member status:', err);
      container.innerHTML = `
        <div class="card" style="padding: 30px; text-align: center; border-radius: 16px;">
          <p style="color: #E53935;"><i class="fa-solid fa-circle-exclamation"></i> ${err.message || 'Error loading membership.'}</p>
          <button class="btn-secondary-outline" onclick="app.loadFoodMemberCardState()">Retry</button>
        </div>
      `;
    }
  }

  renderPremiumSavingsTrackerHTML(st) {
    if (!st || !st.has_any_card) return '';

    const isExpired = !st.is_current_active;

    let lifetimeHTML = '';
    if (st.lifetime_orders > st.current_card_orders || st.lifetime_saved > st.current_card_saved) {
      lifetimeHTML = `
        <div style="background: rgba(255, 255, 255, 0.04); border-top: 1px dashed rgba(255, 215, 0, 0.25); padding-top: 14px; margin-top: 16px; display: flex; justify-content: space-around; font-size: 0.9rem; color: #E0E0E0; flex-wrap: wrap; gap: 12px; border-radius: 10px;">
          <div>🏆 <strong>Lifetime Premium Orders:</strong> <span style="color: #FFF; font-weight: 800; font-size: 1.05rem;">${st.lifetime_orders}</span></div>
          <div>🏆 <strong>Lifetime Total Saved:</strong> <span style="color: #FFD700; font-weight: 800; font-size: 1.05rem;">₹${st.lifetime_saved}</span></div>
        </div>
      `;
    }

    const formattedValidUntil = st.current_card_valid_until 
      ? new Date(st.current_card_valid_until).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '';

    const titleText = isExpired ? 'PREMIUM MEMBERSHIP EXPIRED' : 'PREMIUM MEMBER';
    const titleIcon = isExpired ? 'fa-solid fa-clock-rotate-left' : 'fa-solid fa-crown';
    const badgeText = isExpired ? 'Membership Expired' : 'Keep enjoying your Premium benefits!';
    const badgeStyle = isExpired 
      ? 'color: #EF5350; background: rgba(239, 83, 80, 0.12); border: 1px solid rgba(239, 83, 80, 0.3);'
      : 'color: #4CAF50; background: rgba(76, 175, 80, 0.12); border: 1px solid rgba(76, 175, 80, 0.3);';

    const cardTitlePrefix = (st.lifetime_orders > st.current_card_orders || st.lifetime_saved > st.current_card_saved) ? 'Current Card ' : '';

    return `
      <div class="premium-savings-tracker-card" style="background: var(--bg-surface-elevated, #1E1E2E); border: 1px solid rgba(255, 215, 0, 0.35); border-radius: 18px; padding: 20px; margin-bottom: 24px; box-shadow: 0 8px 25px rgba(0,0,0,0.25); box-sizing: border-box; overflow: hidden;">
        
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 10px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 12px;">
          <h3 style="margin: 0; font-size: 1.2rem; font-weight: 800; color: #FFD700; display: flex; align-items: center; gap: 8px;">
            <i class="${titleIcon}"></i> 🎟️ ${titleText}
          </h3>
          <span style="font-size: 0.85rem; ${badgeStyle} padding: 4px 12px; border-radius: 14px; font-weight: 600;">
            ${badgeText}
          </span>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 14px; margin-bottom: 10px;">
          
          <!-- 🍽️ Premium Orders -->
          <div style="background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px; padding: 16px 12px; text-align: center;">
            <div style="font-size: 1.6rem; margin-bottom: 4px;">🍽️</div>
            <div style="font-size: 0.75rem; color: #AAA; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px;">${cardTitlePrefix}Premium Orders</div>
            <div style="font-size: 1.5rem; font-weight: 800; color: #FFF; margin-top: 2px;">${st.current_card_orders}</div>
          </div>

          <!-- 💰 Total Saved -->
          <div onclick="app.openPremiumSavingsBreakdownModal()" style="background: rgba(255, 215, 0, 0.06); border: 1px solid rgba(255, 215, 0, 0.4); border-radius: 14px; padding: 16px 12px; text-align: center; cursor: pointer; transition: transform 0.2s;" title="Click to view itemized savings breakdown">
            <div style="font-size: 1.6rem; margin-bottom: 4px;">💰</div>
            <div style="font-size: 0.75rem; color: #FFD700; text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px;">${cardTitlePrefix}Total Saved</div>
            <div style="font-size: 1.5rem; font-weight: 800; color: #FFD700; margin-top: 2px;">₹${st.current_card_saved}</div>
            <div style="font-size: 0.7rem; color: #FFD700; margin-top: 4px; text-decoration: underline; font-weight: 600;">View Breakdown <i class="fa-solid fa-chevron-right" style="font-size: 0.6rem;"></i></div>
          </div>

          <!-- 📅 Days Remaining / Status -->
          <div style="background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px; padding: 16px 12px; text-align: center;">
            <div style="font-size: 1.6rem; margin-bottom: 4px;">📅</div>
            <div style="font-size: 0.75rem; color: #AAA; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px;">${!isExpired ? 'Days Remaining' : 'Status'}</div>
            <div style="font-size: 1.4rem; font-weight: 800; color: ${!isExpired ? '#4CAF50' : '#EF5350'}; margin-top: 2px;">
              ${!isExpired ? `${st.current_card_days_remaining} Days` : 'Expired'}
            </div>
            ${formattedValidUntil ? `<div style="font-size: 0.7rem; color: #AAA; margin-top: 4px;">Valid Until: ${formattedValidUntil}</div>` : ''}
          </div>

        </div>

        ${lifetimeHTML}

      </div>
    `;
  }

  openPremiumSavingsBreakdownModal() {
    const st = this.currentMemberState?.savings_tracker;
    if (!st || !st.savings_breakdown) {
      alert('No savings breakdown available.');
      return;
    }

    const breakdown = st.savings_breakdown;
    let listHTML = '';

    if (breakdown.length === 0) {
      listHTML = `
        <div style="text-align: center; padding: 30px; color: #AAA;">
          <p style="margin: 0;">No completed Premium orders yet.</p>
          <p style="font-size: 0.85rem; color: #777; margin-top: 6px;">Place an order to enjoy your ₹5 discount!</p>
        </div>
      `;
    } else {
      listHTML = breakdown.map(item => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 0.9rem;">
          <div>
            <div style="font-weight: 700; color: #FFF;">Order #${item.order_number}</div>
            <div style="font-size: 0.75rem; color: #AAA; margin-top: 2px;">${new Date(item.order_date).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
          </div>
          <div style="font-weight: 800; color: #4CAF50; font-size: 1rem;">
            +₹${item.discount_amount} saved
          </div>
        </div>
      `).join('');
    }

    const modalHTML = `
      <div id="savingsBreakdownModal" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.75); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; z-index: 99999; padding: 15px; box-sizing: border-box;">
        <div style="background: #1E1E2E; border: 1px solid #FFD700; border-radius: 20px; width: 100%; max-width: 480px; max-height: 85vh; overflow-y: auto; color: #FFF; padding: 24px; box-shadow: 0 15px 40px rgba(0,0,0,0.5); position: relative; box-sizing: border-box;">
          
          <button onclick="document.getElementById('savingsBreakdownModal').remove()" style="position: absolute; top: 16px; right: 16px; background: rgba(255,255,255,0.1); border: none; color: #FFF; width: 32px; height: 32px; border-radius: 50%; cursor: pointer; font-size: 1.1rem; display: flex; align-items: center; justify-content: center;">✕</button>

          <h3 style="margin: 0 0 6px 0; color: #FFD700; font-size: 1.3rem; display: flex; align-items: center; gap: 8px;">
            <i class="fa-solid fa-receipt"></i> 💰 Premium Savings Breakdown
          </h3>
          <p style="margin: 0 0 18px 0; font-size: 0.85rem; color: #AAA;">Itemized savings from your completed Premium Food Member orders:</p>

          <div style="background: rgba(255,215,0,0.08); border: 1px dashed #FFD700; border-radius: 12px; padding: 12px 16px; margin-bottom: 18px; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-size: 0.75rem; color: #AAA; text-transform: uppercase; font-weight: 600;">Total Premium Orders</div>
              <div style="font-size: 1.2rem; font-weight: 800; color: #FFF;">${st.current_card_orders} Orders</div>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 0.75rem; color: #AAA; text-transform: uppercase; font-weight: 600;">Total Saved</div>
              <div style="font-size: 1.3rem; font-weight: 800; color: #FFD700;">₹${st.current_card_saved}</div>
            </div>
          </div>

          <div style="background: rgba(0,0,0,0.2); border-radius: 12px; border: 1px solid rgba(255,255,255,0.06); max-height: 320px; overflow-y: auto;">
            ${listHTML}
          </div>

          <button onclick="document.getElementById('savingsBreakdownModal').remove()" style="width: 100%; margin-top: 20px; padding: 12px; background: linear-gradient(135deg, #333 0%, #222 100%); color: #FFF; border: 1px solid #555; border-radius: 10px; font-weight: 700; cursor: pointer;">Close</button>

        </div>
      </div>
    `;

    const existing = document.getElementById('savingsBreakdownModal');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', modalHTML);
  }

  renderFoodMemberCardUI(data) {
    const container = document.getElementById('memberCardContent');
    if (!container) return;

    const { status, card, application, benefits, savings_tracker } = data;
    const trackerHTML = this.renderPremiumSavingsTrackerHTML(savings_tracker);

    // STATE 1: NO APPLICATION or EXPIRED (Allows purchase / repurchase)
    if (status === 'NO_APPLICATION') {
      container.innerHTML = `
        ${trackerHTML}

        <div class="card" style="padding: 24px; border-radius: 16px; background: var(--bg-surface-elevated, #1E1E2E); color: var(--text-main, #FFF); border: 1px solid var(--border-color, #333); box-shadow: 0 4px 20px rgba(0,0,0,0.15); box-sizing: border-box; overflow-wrap: break-word; word-break: break-word;">
          <div style="text-align: center; margin-bottom: 24px;">
            <span style="background: rgba(255, 215, 0, 0.15); color: var(--accent-gold, #FFD700); padding: 6px 16px; border-radius: 20px; font-weight: 700; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.5px;">
              ⭐ Join Exclusive Food Club
            </span>
            <h3 style="margin: 15px 0 8px 0; font-size: 1.5rem; color: var(--text-main, #FFF);">₹10 Premium Food Member Card</h3>
            <p style="color: var(--text-muted, #AAA); margin: 0; font-size: 0.95rem;">Pay ₹10 once and enjoy exclusive dining privileges for <strong style="color: var(--text-main, #FFF);">3 Calendar Months</strong>!</p>
          </div>

          <div class="member-pricing-box" style="background: rgba(255, 215, 0, 0.06); border: 2px dashed var(--accent-gold, #FFD700); border-radius: 14px; padding: 18px; margin-bottom: 24px; display: flex; justify-content: space-around; text-align: center; flex-wrap: wrap; gap: 14px;">
            <div>
              <div style="font-size: 0.8rem; color: var(--text-muted, #AAA); text-transform: uppercase; font-weight: 600;">Membership Fee</div>
              <div style="font-size: 1.8rem; font-weight: 800; color: var(--accent-gold, #FFD700);">₹10 <span style="font-size: 0.85rem; font-weight: 400; color: var(--text-muted, #AAA);">(One-Time)</span></div>
            </div>
            <div style="border-left: 1px solid var(--border-color, #333);"></div>
            <div>
              <div style="font-size: 0.8rem; color: var(--text-muted, #AAA); text-transform: uppercase; font-weight: 600;">Validity Period</div>
              <div style="font-size: 1.8rem; font-weight: 800; color: var(--text-main, #FFF);">3 Months</div>
            </div>
          </div>

          <div style="margin-bottom: 28px;">
            <h4 style="margin: 0 0 14px 0; font-size: 1rem; color: var(--text-main, #FFF);"><i class="fa-solid fa-circle-check" style="color: #4CAF50;"></i> Exclusive Member Benefits:</h4>
            <ul style="list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));">
              <li style="display: flex; align-items: center; gap: 10px; font-size: 0.95rem; color: var(--text-main, #FFF);"><i class="fa-solid fa-check" style="color: #4CAF50;"></i> <strong>₹5 OFF</strong> on every eligible order</li>
              <li style="display: flex; align-items: center; gap: 10px; font-size: 0.95rem; color: var(--text-main, #FFF);"><i class="fa-solid fa-check" style="color: #4CAF50;"></i> <strong>🚀 Express Delivery</strong> eligibility</li>
              <li style="display: flex; align-items: center; gap: 10px; font-size: 0.95rem; color: var(--text-main, #FFF);"><i class="fa-solid fa-check" style="color: #4CAF50;"></i> Digital Member Card with QR code</li>
              <li style="display: flex; align-items: center; gap: 10px; font-size: 0.95rem; color: var(--text-main, #FFF);"><i class="fa-solid fa-check" style="color: #4CAF50;"></i> Downloadable Food Member Card</li>
              <li style="display: flex; align-items: center; gap: 10px; font-size: 0.95rem; color: var(--text-main, #FFF);"><i class="fa-solid fa-check" style="color: #4CAF50;"></i> Printable Food Member Card</li>
            </ul>
          </div>

          <button class="btn-primary" style="width: 100%; padding: 14px; font-size: 1.05rem; font-weight: 700; background: linear-gradient(135deg, #E53935 0%, #D32F2F 100%); border-radius: 12px; box-shadow: 0 6px 18px rgba(229, 57, 53, 0.3); cursor: pointer;" onclick="app.openApplyMemberCardModal()">
            <i class="fa-solid fa-id-card"></i> Apply for Premium Food Member Card (₹10)
          </button>
        </div>
      `;
      return;
    }

    // STATE 2: PENDING_APPROVAL
    if (status === 'PENDING_APPROVAL') {
      const isPayVerified = application && application.payment_status === 'VERIFIED';

      container.innerHTML = `
        ${trackerHTML}

        <div class="card" style="padding: 28px; border-radius: 16px; text-align: center; background: var(--bg-surface-elevated, #1E1E2E); color: var(--text-main, #FFF); border: 1px solid var(--border-color, #333); box-shadow: 0 4px 20px rgba(0,0,0,0.15); box-sizing: border-box; overflow-wrap: break-word; word-break: break-word;">
          
          <div style="width: 70px; height: 70px; background: ${isPayVerified ? 'rgba(76, 175, 80, 0.15)' : 'rgba(255, 152, 0, 0.15)'}; color: ${isPayVerified ? '#4CAF50' : '#FB8C00'}; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 2.2rem; margin: 0 auto 20px auto;">
            ${isPayVerified ? '🟢' : '⏳'}
          </div>

          <h3 style="margin: 0 0 16px 0; color: var(--text-main, #FFF); font-size: 1.4rem;">PREMIUM FOOD MEMBER APPLICATION</h3>
          
          <!-- Status Badges Grid -->
          <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-bottom: 22px;">
            <span style="background: ${isPayVerified ? 'rgba(46, 125, 50, 0.2)' : 'rgba(255, 193, 7, 0.18)'}; color: ${isPayVerified ? '#81C784' : '#FFC107'}; border: 1px solid ${isPayVerified ? '#4CAF50' : '#FFC107'}; padding: 6px 14px; border-radius: 20px; font-weight: 700; font-size: 0.88rem;">
              ${isPayVerified ? '🟢 PAYMENT VERIFIED' : '🟡 PAYMENT PENDING'}
            </span>
            <span style="background: rgba(255, 193, 7, 0.18); color: #FFC107; border: 1px solid #FFC107; padding: 6px 14px; border-radius: 20px; font-weight: 700; font-size: 0.88rem;">
              🟡 APPROVAL PENDING
            </span>
            <span style="background: rgba(255, 255, 255, 0.08); color: #AAA; border: 1px solid #555; padding: 6px 14px; border-radius: 20px; font-weight: 700; font-size: 0.88rem;">
              ⏳ MEMBERSHIP: NOT ACTIVE
            </span>
          </div>

          <div style="background: rgba(255, 255, 255, 0.04); border: 1px dashed var(--border-color, rgba(255,255,255,0.15)); border-radius: 12px; padding: 16px; margin-bottom: 22px; max-width: 540px; margin-left: auto; margin-right: auto;">
            <div style="font-weight: 700; color: var(--accent-gold, #FFD700); margin-bottom: 6px; font-size: 0.95rem;">
              💵 Payment Method: Cash Payment
            </div>
            <p style="font-size: 0.95rem; color: var(--text-muted, #CCC); margin: 0; line-height: 1.5;">
              ${isPayVerified 
                ? 'Your cash payment has been verified by the Owner. Your Premium Food Member Card is awaiting final approval.' 
                : 'Please visit the Owner and pay the Premium Food Member Card amount in cash. Your payment will remain pending until the Owner verifies your payment.'}
            </p>
          </div>

          <div style="font-size: 0.88rem; color: var(--text-muted, #888);">
            Submitted on: ${application ? new Date(application.created_at).toLocaleString('en-IN') : 'Recently'}
          </div>

          <div style="margin-top: 25px;">
            <button class="btn-secondary-outline" onclick="app.loadFoodMemberCardState()" style="padding: 10px 22px; font-weight: 700; cursor: pointer; border-radius: 10px;"><i class="fa-solid fa-rotate"></i> Check Status</button>
          </div>
        </div>
      `;
      return;
    }

    // STATE 3: ACTIVE CARD
    if (status === 'ACTIVE' && card) {
      const validUntilDate = new Date(card.valid_until);
      const formattedUntil = validUntilDate.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const formattedFrom = new Date(card.valid_from).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
      
      const diffMs = validUntilDate.getTime() - Date.now();
      const remainingDays = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

      const verifyUrl = `${window.location.origin}/api/food-member/verify/${encodeURIComponent(card.qr_verification_code)}`;
      const qrImgSrc = `https://api.qrserver.com/v1/create-qr-code/?size=130x130&data=${encodeURIComponent(verifyUrl)}`;

      container.innerHTML = `
        ${trackerHTML}

        <div style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <div style="background: rgba(76, 175, 80, 0.15); color: #81C784; border: 1px solid #4CAF50; padding: 6px 14px; border-radius: 20px; font-weight: 700; font-size: 0.9rem; display: inline-flex; align-items: center; gap: 6px;">
            <i class="fa-solid fa-circle-check"></i> Premium Member Active
          </div>
          <div style="font-size: 0.9rem; color: var(--text-muted, #AAA);">
            Valid Until: <strong style="color: var(--accent-gold, #FFD700);">${formattedUntil}</strong> (${remainingDays} days remaining)
          </div>
        </div>

        <!-- 🍽️ DIGITAL MEMBER CARD CONTAINER FOR DISPLAY, DOWNLOAD & PRINT -->
        <div id="printableFoodMemberCard" class="food-member-card-wrapper" style="background: linear-gradient(135deg, #1A1A2E 0%, #16213E 50%, #0F3460 100%); color: #FFFFFF; border-radius: 20px; padding: 20px; box-shadow: 0 12px 35px rgba(0,0,0,0.3); border: 2px solid #FFD700; position: relative; overflow: hidden; margin-bottom: 24px; box-sizing: border-box; width: 100%; overflow-wrap: break-word; word-break: break-word;">
          
          <div style="position: absolute; top: -40px; right: -40px; width: 160px; height: 160px; background: rgba(255, 215, 0, 0.08); border-radius: 50%; filter: blur(30px); pointer-events: none;"></div>

          <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255, 215, 0, 0.3); padding-bottom: 12px; margin-bottom: 16px; flex-wrap: wrap; gap: 8px;">
            <div style="font-size: 1.1rem; font-weight: 800; color: #FFD700; letter-spacing: 1px; display: flex; align-items: center; gap: 8px;">
              <i class="fa-solid fa-utensils"></i> FOOD MEMBER
            </div>
            <div style="background: #FFD700; color: #1A1A2E; padding: 3px 12px; border-radius: 12px; font-size: 0.75rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px;">
              ⭐ PREMIUM MEMBER
            </div>
          </div>

          <div class="food-member-grid-layout" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; align-items: center;">
            <div style="min-width: 0;">
              <div style="margin-bottom: 12px;">
                <div style="font-size: 0.72rem; color: #A0A0A0; text-transform: uppercase; letter-spacing: 0.5px;">Member Name</div>
                <div style="font-size: 1.25rem; font-weight: 700; color: #FFF; margin-top: 2px; overflow-wrap: break-word;">${card.customer_name}</div>
              </div>

              <div style="margin-bottom: 12px;">
                <div style="font-size: 0.72rem; color: #A0A0A0; text-transform: uppercase; letter-spacing: 0.5px;">Member ID</div>
                <div style="font-size: 1.2rem; font-weight: 800; color: #FFD700; font-family: monospace; letter-spacing: 1px; margin-top: 2px;">${card.member_id}</div>
              </div>

              <div style="display: flex; gap: 16px; margin-bottom: 14px; flex-wrap: wrap;">
                <div>
                  <div style="font-size: 0.7rem; color: #A0A0A0; text-transform: uppercase;">Valid From</div>
                  <div style="font-size: 0.88rem; font-weight: 600; color: #E0E0E0; margin-top: 1px;">${formattedFrom}</div>
                </div>
                <div>
                  <div style="font-size: 0.7rem; color: #A0A0A0; text-transform: uppercase;">Valid Until</div>
                  <div style="font-size: 0.88rem; font-weight: 600; color: #FFD700; margin-top: 1px;">${formattedUntil}</div>
                </div>
                <div>
                  <div style="font-size: 0.7rem; color: #A0A0A0; text-transform: uppercase;">Status</div>
                  <div style="font-size: 0.88rem; font-weight: 700; color: #4CAF50; margin-top: 1px;">● ACTIVE</div>
                </div>
              </div>

              <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <span style="background: rgba(76, 175, 80, 0.2); color: #81C784; border: 1px solid rgba(76, 175, 80, 0.4); padding: 3px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 700;">
                  ✓ ₹5 OFF ON ORDERS
                </span>
                <span style="background: rgba(33, 150, 243, 0.2); color: #64B5F6; border: 1px solid rgba(33, 150, 243, 0.4); padding: 3px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 700;">
                  🚀 EXPRESS DELIVERY
                </span>
              </div>
            </div>

            <!-- QR Code Section -->
            <div style="text-align: center; background: #FFF; padding: 10px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); max-width: 140px; margin: 0 auto;">
              <img src="${qrImgSrc}" alt="QR Verification Code" style="width: 105px; height: 105px; display: block; margin: 0 auto 4px auto; max-width: 100%;">
              <span style="font-size: 0.65rem; color: #333; font-weight: 800; text-transform: uppercase; display: block;">SCAN TO VERIFY</span>
            </div>
          </div>
        </div>

        <!-- PRINT CARD BUTTON -->
        <div class="card-actions-row" style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
          <button id="btnPrintMemberCard" class="btn-primary" style="padding: 11px 22px; font-size: 0.9rem; font-weight: 700; background: #388E3C; min-width: 140px; border-radius: 10px; cursor: pointer;" onclick="app.printMemberCard(this)">
            <i class="fa-solid fa-print"></i> 🖨 Print Card
          </button>
        </div>
      `;
      return;
    }

    // STATE: SUSPENDED
    if (status === 'SUSPENDED') {
      const phone = this.settings?.contact_phone || '9392874900';
      const cleanPhone = phone.replace(/^\+91/, '').replace(/\s+/g, '');
      container.innerHTML = `
        ${trackerHTML}

        <div class="card" style="padding: 28px; border-radius: 16px; text-align: center; background: var(--bg-surface-elevated, #1E1E2E); color: var(--text-main, #FFF); border: 1px solid #EF5350; box-shadow: 0 4px 20px rgba(0,0,0,0.15); box-sizing: border-box; overflow-wrap: break-word; word-break: break-word;">
          <div style="width: 70px; height: 70px; background: rgba(244, 67, 54, 0.15); color: #E53935; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 2.2rem; margin: 0 auto 20px auto;">
            🔒
          </div>

          <h3 style="margin: 0 0 10px 0; color: #EF5350; font-size: 1.4rem;">🔒 SUSPENDED</h3>
          
          <div style="background: rgba(244, 67, 54, 0.12); border: 1px solid #EF5350; padding: 12px 18px; border-radius: 10px; display: inline-block; margin-bottom: 20px;">
            <span style="color: #EF5350; font-weight: 700;">Status: 🔒 SUSPENDED</span>
            ${card && card.member_id ? `<span style="color: var(--text-muted, #AAA); font-size: 0.88rem; margin-left: 8px;">(ID: ${card.member_id})</span>` : ''}
          </div>

          <p style="font-size: 1rem; color: var(--text-muted, #CCC); max-width: 500px; margin: 0 auto 24px auto; line-height: 1.5;">
            ⚠️ Your Food Member Card has been suspended by the Owner.<br>Please contact the Owner.
          </p>

          <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
            <a href="tel:+91${cleanPhone}" class="btn-primary" style="padding: 12px 24px; font-size: 0.95rem; font-weight: 700; background: linear-gradient(135deg, #0088CC 0%, #006699 100%); border-radius: 12px; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; cursor: pointer;">
              <i class="fa-solid fa-phone"></i> 📞 Contact Owner
            </a>
            <button class="btn-secondary-outline" style="padding: 12px 20px; font-weight: 700; cursor: pointer; border-radius: 12px;" onclick="app.loadFoodMemberCardState()">
              <i class="fa-solid fa-rotate-right"></i> Check Status
            </button>
          </div>
        </div>
      `;
      return;
    }

    // STATE 4: EXPIRED
    if (status === 'EXPIRED') {
      container.innerHTML = `
        ${trackerHTML}

        <div class="card" style="padding: 28px; border-radius: 16px; text-align: center; background: var(--bg-surface-elevated, #1E1E2E); color: var(--text-main, #FFF); border: 1px solid var(--border-color, #333); box-shadow: 0 4px 20px rgba(0,0,0,0.15); box-sizing: border-box; overflow-wrap: break-word; word-break: break-word;">
          <div style="width: 70px; height: 70px; background: rgba(244, 67, 54, 0.15); color: #E53935; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 2.2rem; margin: 0 auto 20px auto;">
            ⚠️
          </div>

          <h3 style="margin: 0 0 10px 0; color: var(--text-main, #FFF); font-size: 1.4rem;">Premium Food Membership Expired</h3>
          <p style="font-size: 1rem; color: var(--text-muted, #CCC); max-width: 500px; margin: 0 auto 24px auto;">
            Your 3-month membership has expired. Renew your membership now to restore your ₹5 discount and Express Delivery benefits!
          </p>

          <button class="btn-primary" style="padding: 14px 28px; font-size: 1rem; font-weight: 700; background: linear-gradient(135deg, #E53935 0%, #D32F2F 100%); border-radius: 12px; cursor: pointer;" onclick="app.openApplyMemberCardModal()">
            <i class="fa-solid fa-arrows-rotate"></i> Buy Again ₹10
          </button>
        </div>
      `;
      return;
    }

    // STATE 5: REJECTED
    if (status === 'REJECTED') {
      const reason = application ? application.rejection_reason : '';
      const phone = this.settings?.contact_phone || '9392874900';
      const cleanPhone = phone.replace(/^\+91/, '').replace(/\s+/g, '');
      container.innerHTML = `
        ${trackerHTML}

        <div class="card" style="padding: 28px; border-radius: 16px; text-align: center; background: var(--bg-surface-elevated, #1E1E2E); color: var(--text-main, #FFF); border: 1px solid var(--border-color, #333); box-shadow: 0 4px 20px rgba(0,0,0,0.15); box-sizing: border-box; overflow-wrap: break-word; word-break: break-word;">
          <div style="width: 70px; height: 70px; background: rgba(244, 67, 54, 0.15); color: #E53935; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 2.2rem; margin: 0 auto 20px auto;">
            ❌
          </div>

          <h3 style="margin: 0 0 10px 0; color: #EF5350; font-size: 1.4rem;">❌ Premium Food Member Card Rejected</h3>
          
          <div style="background: rgba(244, 67, 54, 0.12); border: 1px solid #EF5350; padding: 12px 18px; border-radius: 10px; display: inline-block; margin-bottom: 20px;">
            <span style="color: #EF5350; font-weight: 700;">Status: REJECTED</span>
            ${application && application.payment_reference ? `<span style="color: var(--text-muted, #AAA); font-size: 0.88rem; margin-left: 8px;">(Ref: ${application.payment_reference})</span>` : ''}
          </div>

          <p style="font-size: 1rem; color: var(--text-muted, #CCC); max-width: 500px; margin: 0 auto 24px auto; line-height: 1.5;">
            Your Premium Food Member Card application has been rejected by the Owner.
            ${reason ? `<br><small style="color: #EF5350; margin-top: 6px; display: block;">(Reason: ${reason})</small>` : ''}
          </p>

          <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
            <a href="tel:+91${cleanPhone}" class="btn-primary" style="padding: 12px 24px; font-size: 0.95rem; font-weight: 700; background: linear-gradient(135deg, #0088CC 0%, #006699 100%); border-radius: 12px; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; cursor: pointer;">
              <i class="fa-solid fa-phone"></i> 📞 Contact Owner
            </a>
            <button class="btn-secondary-outline" style="padding: 12px 20px; font-weight: 700; cursor: pointer; border-radius: 12px;" onclick="app.openApplyMemberCardModal()">
              <i class="fa-solid fa-rotate-right"></i> Re-apply with New Payment
            </button>
          </div>
        </div>
      `;
      return;
    }
  }

  // Open Modal for ₹10 Membership Application (Cash Payment Only)
  openApplyMemberCardModal() {
    if (!this.currentUser) {
      this.showToast('Please Login or Register to apply for Premium Food Membership.', 'error');
      this.openAuthModal('CUSTOMER', 'LOGIN');
      return;
    }

    const modalHtml = `
      <div id="modalApplyMemberCard" class="modal-backdrop open visible active" style="position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important; width: 100vw !important; height: 100vh !important; background: rgba(0,0,0,0.85) !important; backdrop-filter: blur(8px) !important; -webkit-backdrop-filter: blur(8px) !important; z-index: 999999 !important; display: flex !important; align-items: center !important; justify-content: center !important; padding: 12px !important; box-sizing: border-box !important; opacity: 1 !important; visibility: visible !important; pointer-events: auto !important; overflow-y: auto !important;" onclick="if(event.target === this) app.closeApplyMemberCardModal()">
        <div class="modal-card" style="max-width: 480px; width: 100%; max-height: 92vh; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 22px 18px; border-radius: 20px; background: var(--bg-surface-elevated, #1E1E2E); color: var(--text-main, #FFF); border: 1px solid var(--border-color, #444); box-shadow: 0 12px 40px rgba(0,0,0,0.6); box-sizing: border-box;" onclick="event.stopPropagation()">
          
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid var(--border-color, #333); padding-bottom: 12px; position: sticky; top: -22px; background: var(--bg-surface-elevated, #1E1E2E); z-index: 5; margin-top: -4px; padding-top: 4px;">
            <h3 style="margin: 0; font-size: 1.25rem; color: var(--text-main, #FFF); display: flex; align-items: center; gap: 8px;">
              <i class="fa-solid fa-id-card" style="color: var(--accent-gold, #FFD700);"></i> Apply for Member Card
            </h3>
            <button type="button" onclick="app.closeApplyMemberCardModal()" style="background: rgba(255,255,255,0.1); border: none; font-size: 1.3rem; cursor: pointer; color: #FFF; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; line-height: 1;" title="Close Modal">&times;</button>
          </div>

          <div style="background: rgba(255, 215, 0, 0.08); border-radius: 14px; padding: 14px; margin-bottom: 18px; font-size: 0.88rem; border: 1px solid rgba(255,215,0,0.25);">
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px; flex-wrap: wrap; gap: 4px;">
              <span style="color: var(--text-muted, #AAA);">Membership Tier:</span> <strong style="color: var(--accent-gold, #FFD700);">Premium Food Member</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px; flex-wrap: wrap; gap: 4px;">
              <span style="color: var(--text-muted, #AAA);">Membership Fee:</span> <strong style="color: #4CAF50; font-size: 1.1rem;">₹10 (One-Time)</strong>
            </div>
            <div style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px;">
              <span style="color: var(--text-muted, #AAA);">Validity Period:</span> <strong style="color: #FFF;">3 Calendar Months</strong>
            </div>
          </div>

          <form onsubmit="event.preventDefault(); app.submitMemberCardApplication();">
            
            <div style="margin-bottom: 20px; background: rgba(76, 175, 80, 0.1); border: 1px solid #4CAF50; border-radius: 14px; padding: 16px;">
              <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; color: #4CAF50; font-size: 1.05rem; margin-bottom: 8px;">
                <i class="fa-solid fa-money-bill-wave"></i> Payment Method: 💵 Cash Payment
              </div>
              <p style="margin: 0; color: var(--text-muted, #DDD); font-size: 0.92rem; line-height: 1.5;">
                Please visit the Owner and pay the Premium Food Member Card amount (₹10) in cash. Your payment will remain pending until the Owner verifies your payment.
              </p>
            </div>

            <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; flex-wrap: wrap;">
              <button type="button" class="btn-secondary-outline" style="flex: 1; min-width: 100px; padding: 12px; font-weight: 600;" onclick="app.closeApplyMemberCardModal()">Cancel</button>
              <button type="submit" id="btnSubmitMemberApp" class="btn-primary" style="flex: 1.5; min-width: 160px; padding: 12px; font-weight: 700; background: linear-gradient(135deg, #4CAF50 0%, #388E3C 100%); cursor: pointer;">
                💵 Submit Application
              </button>
            </div>
          </form>

        </div>
      </div>
    `;

    const existing = document.getElementById('modalApplyMemberCard');
    if (existing) existing.remove();

    document.body.insertAdjacentHTML('beforeend', modalHtml);
  }

  closeApplyMemberCardModal() {
    const modal = document.getElementById('modalApplyMemberCard');
    if (modal) modal.remove();
  }

  async submitMemberCardApplication() {
    const btn = document.getElementById('btnSubmitMemberApp');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ⏳ Submitting...`;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/food-member/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment_method: 'Cash Payment',
          is_cash_paid: true
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Submission failed.');

      if (btn) btn.innerHTML = `<i class="fa-solid fa-circle-check"></i> ✅ Submitted`;
      this.showToast('✅ Application Submitted Successfully', 'success');
      this.closeApplyMemberCardModal();
      await this.loadFoodMemberCardState();
    } catch (err) {
      console.error('Submit cash member application error:', err);
      this.showToast(err.message || '❌ Unable to submit your application right now. Please try again.', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `💵 Submit Application`;
      }
    }
  }

  // Print Member Card (Isolates Card via @media print)
  printMemberCard(btnEl) {
    const cardEl = document.getElementById('printableFoodMemberCard');
    if (!cardEl) {
      this.showToast('No active Member Card available to print.', 'error');
      return;
    }

    const btn = btnEl || document.getElementById('btnPrintMemberCard');
    const origHtml = btn ? btn.innerHTML : '';

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 🖨 Printing...`;
    }

    setTimeout(() => {
      window.print();
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml || `<i class="fa-solid fa-print"></i> 🖨 Print`;
      }
    }, 400);
  }

  // Download Member Card (Downloads HTML container as PDF)
  async downloadMemberCard(btnEl) {
    const cardEl = document.getElementById('printableFoodMemberCard');
    if (!cardEl) {
      this.showToast('No active Member Card available to download.', 'error');
      return;
    }

    const btn = btnEl || document.getElementById('btnDownloadMemberCard');
    const origHtml = btn ? btn.innerHTML : '';

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ⏳ Downloading...`;
    }

    this.showToast('Generating high-resolution Food Member Card download...', 'info');

    const restoreBtn = () => {
      if (btn) {
        btn.innerHTML = `<i class="fa-solid fa-circle-check"></i> ✓ Downloaded`;
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = origHtml || `<i class="fa-solid fa-download"></i> ⬇ Download`;
        }, 2000);
      }
    };

    if (window.html2pdf) {
      const opt = {
        margin:       10,
        filename:     `Food_Member_Card_${this.currentMemberState?.card?.member_id || 'Premium'}.pdf`,
        image:        { type: 'jpeg', quality: 0.98 },
        html2canvas:  { scale: 2, useCORS: true, logging: false },
        jsPDF:        { unit: 'mm', format: 'a5', orientation: 'landscape' }
      };
      window.html2pdf().set(opt).from(cardEl).save().then(() => {
        this.showToast('✅ Member Card downloaded successfully!', 'success');
        restoreBtn();
      }).catch(err => {
        console.error('html2pdf error:', err);
        window.print();
        restoreBtn();
      });
    } else {
      window.print();
      restoreBtn();
    }
  }

  // =========================================================================
  // OWNER SIDE - FOOD MEMBER CARD APPROVALS CONTROLLER
  // =========================================================================

  async loadOwnerMemberApprovals() {
    const listContainer = document.getElementById('ownerMemberAppsList');
    if (!listContainer) return;

    listContainer.innerHTML = `<div style="text-align: center; padding: 40px; color: #888;"><i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem;"></i><p style="margin-top: 10px;">Loading membership applications...</p></div>`;

    try {
      const filter = this.ownerMemberFilter || 'ALL';
      const res = await this.fetchWithAuth(`${API_BASE}/food-member/owner/applications?status=${encodeURIComponent(filter)}`);
      const data = await res.json();

      if (!data.success) {
        throw new Error(data.message || 'Failed to load applications.');
      }

      if (data.counts) {
        const cntAll = document.getElementById('cntMemberAppsAll');
        const cntPending = document.getElementById('cntMemberAppsPending');
        const cntApproved = document.getElementById('cntMemberAppsApproved');
        const cntRejected = document.getElementById('cntMemberAppsRejected');
        if (cntAll) cntAll.textContent = `(${data.counts.all || 0})`;
        if (cntPending) cntPending.textContent = `(${data.counts.pending || 0})`;
        if (cntApproved) cntApproved.textContent = `(${data.counts.approved || 0})`;
        if (cntRejected) cntRejected.textContent = `(${data.counts.rejected || 0})`;
      }

      // Cache full list for client-side search filtering
      this.ownerMemberAppsCache = data.data || [];
      this.renderOwnerMemberAppsUI(this.getFilteredOwnerMemberApps());
    } catch (err) {
      console.error('Error loading owner member applications:', err);
      listContainer.innerHTML = `<p style="color: #E53935; text-align: center; padding: 20px;">Failed to load applications: ${err.message}</p>`;
    }
  }

  filterOwnerMemberApps(status) {
    this.ownerMemberFilter = status;
    const btnMap = {
      'ALL': 'btnFilterMemberAppsAll',
      'PENDING_APPROVAL': 'btnFilterMemberAppsPending',
      'APPROVED': 'btnFilterMemberAppsApproved',
      'REJECTED': 'btnFilterMemberAppsRejected'
    };

    Object.keys(btnMap).forEach(key => {
      const btn = document.getElementById(btnMap[key]);
      if (btn) {
        btn.classList.toggle('active', key === status);
      }
    });

    this.loadOwnerMemberApprovals();
  }

  handleOwnerMemberAppsSearch(val) {
    this.ownerMemberSearchQuery = val || '';
    const clearBtn = document.getElementById('btnClearOwnerMemberAppsSearch');
    if (clearBtn) {
      clearBtn.style.display = (this.ownerMemberSearchQuery.trim().length > 0) ? 'block' : 'none';
    }
    this.renderOwnerMemberAppsUI(this.getFilteredOwnerMemberApps());
  }

  clearOwnerMemberAppsSearch() {
    this.ownerMemberSearchQuery = '';
    const input = document.getElementById('txtOwnerMemberAppsSearch');
    if (input) input.value = '';
    const clearBtn = document.getElementById('btnClearOwnerMemberAppsSearch');
    if (clearBtn) clearBtn.style.display = 'none';
    const countBadge = document.getElementById('lblOwnerMemberAppsSearchResultCount');
    if (countBadge) countBadge.style.display = 'none';
    this.renderOwnerMemberAppsUI(this.getFilteredOwnerMemberApps());
  }

  getFilteredOwnerMemberApps() {
    if (!this.ownerMemberAppsCache) return [];
    let list = [...this.ownerMemberAppsCache];
    const query = (this.ownerMemberSearchQuery || '').trim().toLowerCase();
    if (!query) return list;

    return list.filter(item => {
      const name = (item.customer_name || '').toLowerCase();
      const cardId = (item.member_id || item.card_id || '').toLowerCase();
      const mobile = (item.customer_mobile || '').toLowerCase();
      const appId = (item.id || '').toLowerCase();
      const utr = (item.payment_reference || '').toLowerCase();
      const qrCode = (item.qr_verification_code || '').toLowerCase();
      const status = (item.status || '').toLowerCase();
      const payStatus = (item.payment_status || '').toLowerCase();
      const cardStatus = (item.card_status || '').toLowerCase();
      const reason = (item.rejection_reason || '').toLowerCase();
      const fee = String(item.fee_amount || '').toLowerCase();

      return name.includes(query) || 
             cardId.includes(query) || 
             mobile.includes(query) || 
             appId.includes(query) || 
             utr.includes(query) || 
             qrCode.includes(query) ||
             status.includes(query) ||
             payStatus.includes(query) ||
             cardStatus.includes(query) ||
             reason.includes(query) ||
             fee.includes(query);
    });
  }

  renderOwnerMemberAppsUI(apps) {
    const listContainer = document.getElementById('ownerMemberAppsList');
    if (!listContainer) return;

    this.ownerMemberApplicationsMap = new Map();

    const isSearching = (this.ownerMemberSearchQuery || '').trim().length > 0;
    const countBadge = document.getElementById('lblOwnerMemberAppsSearchResultCount');
    if (countBadge) {
      if (isSearching) {
        countBadge.textContent = `${apps ? apps.length : 0} Found`;
        countBadge.style.display = 'inline-block';
      } else {
        countBadge.style.display = 'none';
      }
    }

    if (!apps || apps.length === 0) {
      listContainer.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: var(--text-muted, #888);">
          <i class="fa-solid ${isSearching ? 'fa-magnifying-glass' : 'fa-id-card'}" style="font-size: 2.5rem; opacity: 0.3; margin-bottom: 10px;"></i>
          <p style="margin: 0; font-size: 0.95rem;">${isSearching ? `No matching food cards found for "${this.ownerMemberSearchQuery}".` : 'No membership applications found in this view.'}</p>
        </div>
      `;
      return;
    }

    listContainer.innerHTML = `
      <div style="display: grid; gap: 16px;">
        ${apps.map(appItem => {
          if (appItem && appItem.id) {
            this.ownerMemberApplicationsMap.set(appItem.id, appItem);
          }
          const isPending = appItem.status === 'PENDING_APPROVAL';
          const isApproved = appItem.status === 'APPROVED';
          const isRejected = appItem.status === 'REJECTED';
          const cardStatus = appItem.card_status || (isApproved ? 'ACTIVE' : appItem.status);
          const isPayVerified = appItem.payment_status === 'VERIFIED';
          const isPayRejected = appItem.payment_status === 'REJECTED';

          const statusBadge = isApproved 
            ? `<span style="background: rgba(46, 125, 50, 0.15); color: #4CAF50; border: 1px solid rgba(76, 175, 80, 0.4); padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 0.8rem;">🟢 APPROVED (${appItem.member_id || 'Active'})</span>`
            : isRejected 
            ? `<span style="background: rgba(198, 40, 40, 0.15); color: #EF5350; border: 1px solid rgba(239, 83, 80, 0.4); padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 0.8rem;">🔴 REJECTED</span>`
            : `<span style="background: rgba(230, 81, 0, 0.15); color: #FF9800; border: 1px solid rgba(255, 152, 0, 0.4); padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 0.8rem;">🟡 APPROVAL PENDING</span>`;

          const payStatusBadge = isPayVerified
            ? `<span style="background: rgba(46, 125, 50, 0.15); color: #4CAF50; border: 1px solid rgba(76, 175, 80, 0.4); padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 0.8rem;">🟢 VERIFIED / PAID</span>`
            : isPayRejected
            ? `<span style="background: rgba(198, 40, 40, 0.15); color: #EF5350; border: 1px solid rgba(239, 83, 80, 0.4); padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 0.8rem;">🔴 REJECTED</span>`
            : `<span style="background: rgba(255, 193, 7, 0.15); color: #FFC107; border: 1px solid rgba(255, 193, 7, 0.4); padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 0.8rem;">🟡 PAYMENT PENDING</span>`;

          const memberStatusBadge = (isApproved && cardStatus === 'ACTIVE')
            ? `<span style="background: rgba(46, 125, 50, 0.15); color: #4CAF50; border: 1px solid rgba(76, 175, 80, 0.4); padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 0.8rem;">🟢 MEMBERSHIP ACTIVE</span>`
            : `<span style="background: rgba(255, 255, 255, 0.08); color: #AAA; border: 1px solid #555; padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 0.8rem;">⏳ NOT ACTIVE</span>`;

          const validFromFormatted = appItem.valid_from ? new Date(appItem.valid_from).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'N/A';
          const validUntilFormatted = appItem.valid_until ? new Date(appItem.valid_until).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'N/A';
          const appDateFormatted = appItem.created_at ? new Date(appItem.created_at).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'N/A';

          return `
            <div class="card-item" style="border: 1px solid var(--border-color, #333); border-radius: 14px; padding: 18px; background: var(--bg-surface-elevated, #1E1E2E); color: var(--text-main, #FFF); display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 15px; box-sizing: border-box; overflow-wrap: break-word; word-break: break-word; min-width: 0;">
              
              <div style="flex: 1; min-width: 240px; max-width: 100%;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap;">
                  <strong style="font-size: 1.15rem; color: var(--text-main, #FFF); font-weight: 700;">${appItem.customer_name}</strong>
                  ${statusBadge}
                  ${payStatusBadge}
                  ${memberStatusBadge}
                  ${appItem.member_id ? `<span style="font-family: monospace; color: var(--accent-gold, #FFD700); font-weight: 800; background: rgba(255,215,0,0.12); padding: 2px 8px; border-radius: 6px; font-size: 0.85rem;">ID: ${appItem.member_id}</span>` : ''}
                </div>

                <div style="font-size: 0.88rem; color: var(--text-muted, #AAA); display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px 16px; margin-bottom: 12px;">
                  <span><i class="fa-solid fa-phone" style="color: var(--accent-gold, #FFD700);"></i> <strong>Mobile:</strong> ${appItem.customer_mobile}</span>
                  <span><i class="fa-solid fa-calendar-plus" style="color: var(--accent-gold, #FFD700);"></i> <strong>Applied:</strong> ${appDateFormatted}</span>
                  ${isApproved ? `
                    <span><i class="fa-solid fa-calendar-check" style="color: #4CAF50;"></i> <strong>Valid From:</strong> ${validFromFormatted}</span>
                    <span><i class="fa-solid fa-hourglass-end" style="color: var(--accent-gold, #FFD700);"></i> <strong>Valid Until:</strong> ${validUntilFormatted}</span>
                  ` : ''}
                  ${appItem.rejection_reason ? `
                    <span style="grid-column: 1 / -1; color: #EF5350;"><i class="fa-solid fa-circle-info"></i> <strong>Rejection Reason:</strong> ${appItem.rejection_reason}</span>
                  ` : ''}
                </div>

                <div style="background: rgba(255, 255, 255, 0.06); padding: 10px 14px; border-radius: 8px; font-size: 0.85rem; display: flex; align-items: center; gap: 12px; border: 1px solid var(--border-color, rgba(255,255,255,0.1)); flex-wrap: wrap; color: var(--text-main, #FFF);">
                  <span>Fee: <strong style="color: #4CAF50;">₹${appItem.fee_amount}</strong></span>
                  <span>Method: <strong style="color: var(--accent-gold, #FFD700);">💵 Cash Payment</strong></span>
                  <span>Payment Status: ${isPayVerified ? '<strong style="color:#4CAF50;">VERIFIED / PAID</strong>' : isPayRejected ? '<strong style="color:#EF5350;">REJECTED</strong>' : '<strong style="color:#FFC107;">PENDING</strong>'}</span>
                </div>
              </div>

              <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 4px;">
                ${!isPayVerified && !isApproved && !isPayRejected ? `
                  <button type="button" class="btn-sm btn-primary btn-action-verify-pay" style="background: linear-gradient(135deg, #FF9800 0%, #F57C00 100%); cursor: pointer;" onclick="app.verifyMemberPayment('${appItem.id}', this)" title="Verify Cash Payment">
                    <i class="fa-solid fa-circle-check"></i> Verify Cash Payment
                  </button>
                  <button type="button" class="btn-sm btn-outline btn-action-reject-pay" style="color: #EF5350; border-color: #EF5350; cursor: pointer;" onclick="app.openRejectPaymentModal('${appItem.id}')" title="Reject Payment Proof">
                    <i class="fa-solid fa-ban"></i> Reject Payment
                  </button>
                ` : ''}
                ${isPending ? `
                  <button type="button" class="btn-sm btn-primary btn-action-approve-card" style="background: linear-gradient(135deg, #4CAF50 0%, #388E3C 100%); cursor: pointer;" onclick="app.approveMemberCard('${appItem.id}', this)" title="Approve Membership Application">
                    <i class="fa-solid fa-check"></i> Approve Card
                  </button>
                  <button type="button" class="btn-sm btn-outline btn-action-reject-card" onclick="app.rejectMemberCard('${appItem.id}')" title="Reject Membership Application">
                    <i class="fa-solid fa-xmark"></i> Reject Card
                  </button>
                ` : ''}
                ${isRejected ? `
                  <button type="button" class="btn-sm btn-primary btn-action-reapprove-card" onclick="app.reapproveMemberCard('${appItem.id}')" title="Re-Approve Rejected Application">
                    <i class="fa-solid fa-rotate-left"></i> 🔄 RE-APPROVE
                  </button>
                ` : ''}
                ${isApproved ? `
                  ${cardStatus === 'ACTIVE' ? `
                    <button type="button" class="btn-sm btn-outline btn-action-suspend-card" onclick="app.suspendMemberCard('${appItem.id}', this)" title="Suspend Active Card">
                      <i class="fa-solid fa-pause"></i> Suspend
                    </button>
                  ` : cardStatus === 'SUSPENDED' ? `
                    <button type="button" class="btn-sm btn-outline btn-action-reactivate-card" onclick="app.reactivateMemberCard('${appItem.id}', this)" title="Reactivate Suspended Card">
                      <i class="fa-solid fa-play"></i> Reactivate
                    </button>
                  ` : ''}
                ` : ''}
                <button type="button" class="btn-sm btn-outline btn-action-delete" onclick="app.confirmDeleteMemberApp('${appItem.id}')" title="Delete Member Record">
                  <i class="fa-solid fa-trash-can"></i> Delete
                </button>
              </div>

            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  copyUtrToClipboard(utr) {
    if (!utr || utr === 'N/A') return;
    navigator.clipboard.writeText(utr).then(() => {
      this.showToast('📋 UTR copied to clipboard!', 'info');
    }).catch(err => {
      console.error('Clipboard copy error:', err);
      this.showToast('Failed to copy UTR.', 'error');
    });
  }

  confirmDeleteMemberApp(appId) {
    this.pendingDeleteMemberAppId = appId;
    const modal = document.getElementById('modalConfirmDeleteMemberApp');
    if (modal) {
      if (modal.parentNode !== document.body) {
        document.body.appendChild(modal);
      }
      modal.classList.remove('hidden');
      modal.classList.add('open', 'visible', 'active');
      modal.style.cssText = 'position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 9999999 !important; display: flex !important; align-items: center !important; justify-content: center !important; background: rgba(0,0,0,0.85) !important; backdrop-filter: blur(8px) !important; opacity: 1 !important; visibility: visible !important; pointer-events: auto !important;';
    }
  }

  closeDeleteMemberAppModal() {
    const modal = document.getElementById('modalConfirmDeleteMemberApp');
    if (modal) {
      modal.classList.remove('open', 'visible', 'active');
      modal.classList.add('hidden');
      modal.style.cssText = 'display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important;';
    }
    this.pendingDeleteMemberAppId = null;
    this.isDeletingMemberApp = false;
  }

  async executeDeleteMemberApp() {
    if (!this.pendingDeleteMemberAppId || this.isDeletingMemberApp) return;
    this.isDeletingMemberApp = true;
    const btn = document.getElementById('btnConfirmDeleteMemberApp');
    let origHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ⏳ Deleting...`;
    }

    try {
      const targetId = this.pendingDeleteMemberAppId;
      const res = await this.fetchWithAuth(`${API_BASE}/food-member/owner/application/${targetId}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Deletion failed.');

      this.showToast('✅ Premium Food Member Card deleted successfully.', 'success');
      this.closeDeleteMemberAppModal();
      await this.loadOwnerMemberApprovals();
    } catch (err) {
      console.error('Delete member application error:', err);
      this.showToast(err.message || 'Failed to delete record.', 'error');
    } finally {
      this.isDeletingMemberApp = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml || `<i class="fa-solid fa-trash-can"></i> Delete`;
      }
    }
  }

  openDeleteAllMemberAppsModal() {
    const modal = document.getElementById('modalConfirmDeleteAllMemberApps');
    if (modal) {
      if (modal.parentNode !== document.body) {
        document.body.appendChild(modal);
      }
      modal.classList.remove('hidden');
      modal.classList.add('open', 'visible', 'active');
      modal.style.cssText = 'position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 9999999 !important; display: flex !important; align-items: center !important; justify-content: center !important; background: rgba(0,0,0,0.85) !important; backdrop-filter: blur(8px) !important; opacity: 1 !important; visibility: visible !important; pointer-events: auto !important;';
    }
  }

  closeDeleteAllMemberAppsModal() {
    const modal = document.getElementById('modalConfirmDeleteAllMemberApps');
    if (modal) {
      modal.classList.remove('open', 'visible', 'active');
      modal.classList.add('hidden');
      modal.style.cssText = 'display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important;';
    }
    this.isDeletingAllMemberApps = false;
  }

  async executeDeleteAllMemberApps() {
    if (this.isDeletingAllMemberApps) return;
    this.isDeletingAllMemberApps = true;
    const btn = document.getElementById('btnConfirmDeleteAllMemberApps');
    let origHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ⏳ Deleting...`;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/food-member/owner/applications/all`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Failed to clear records.');

      this.showToast('✅ Premium Food Card records deleted successfully.', 'info');
      this.closeDeleteAllMemberAppsModal();
      await this.loadOwnerMemberApprovals();
    } catch (err) {
      console.error('Delete all member applications error:', err);
      this.showToast(err.message || 'Failed to clear records.', 'error');
    } finally {
      this.isDeletingAllMemberApps = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml || `<i class="fa-solid fa-trash-can"></i> DELETE ALL`;
      }
    }
  }

  async viewOwnerMemberCardScreenshot(appId, btnEl = null) {
    let origHtml = '';
    if (btnEl) {
      btnEl.disabled = true;
      origHtml = btnEl.innerHTML;
      btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ⏳ Loading Screenshot...`;
    }

    try {
      const appItem = this.ownerMemberApplicationsMap ? this.ownerMemberApplicationsMap.get(appId) : null;
      const rawScreenshot = appItem ? (appItem.screenshot_url || appItem.payment_ledger_screenshot || appItem.payment_proof) : null;

      if (!appItem && !rawScreenshot) {
        this.showToast('⚠️ Membership application record not found.', 'error');
        return;
      }

      if (!rawScreenshot) {
        this.showToast('⚠️ Payment screenshot not available for this record.', 'error');
        return;
      }

      if (typeof rawScreenshot === 'string' && rawScreenshot.startsWith('data:image/')) {
        this.viewPaymentProof(rawScreenshot, appId);
        return;
      }

      const token = this.authToken || localStorage.getItem('token') || '';
      const endpoint = `${API_BASE}/food-member/owner/screenshot/${appId}?token=${encodeURIComponent(token)}&t=${Date.now()}`;

      try {
        const res = await this.fetchWithAuth(endpoint);
        if (res.ok) {
          const blob = await res.blob();
          if (blob && blob.size > 0 && blob.type.startsWith('image/')) {
            const blobUrl = URL.createObjectURL(blob);
            this.viewPaymentProof(blobUrl, appId);
            return;
          }
        }
      } catch (blobErr) {
        console.warn('[DEBUG] Authenticated screenshot blob fetch notice:', blobErr);
      }

      let staticUrl = rawScreenshot.startsWith('/') ? rawScreenshot : `/${rawScreenshot}`;
      if (!staticUrl.includes('?')) {
        staticUrl += `?token=${encodeURIComponent(token)}&t=${Date.now()}`;
      }
      this.viewPaymentProof(staticUrl, appId);
    } catch (err) {
      console.error('Error viewing member card screenshot:', err);
      this.showToast('❌ Unable to load payment screenshot.', 'error');
    } finally {
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerHTML = origHtml || `<i class="fa-solid fa-image"></i> 👁 View Screenshot`;
      }
    }
  }

  viewPaymentProof(imgUrl, appId = null) {
    if (!imgUrl) {
      this.showToast('⚠️ Payment screenshot not available for this record.', 'error');
      return;
    }

    const modal = document.getElementById('modalViewPaymentProof');
    const img = document.getElementById('imgPaymentProofZoom');
    const loadingEl = document.getElementById('imgPaymentProofLoading');
    const errorEl = document.getElementById('imgPaymentProofError');
    const errorMsgEl = document.getElementById('txtPaymentProofErrorMsg');
    const retryBtn = document.getElementById('btnRetryPaymentProof');

    if (modal && img) {
      this.setZoomScale(1.0);

      if (loadingEl) loadingEl.style.display = 'flex';
      if (errorEl) errorEl.style.display = 'none';
      img.style.display = 'none';

      img.onload = () => {
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) errorEl.style.display = 'none';
        img.style.display = 'block';
      };

      img.onerror = (e) => {
        console.error(`[DEBUG] Payment proof image load error:`, e);
        if (loadingEl) loadingEl.style.display = 'none';
        img.style.display = 'none';
        if (errorMsgEl) errorMsgEl.textContent = '❌ Unable to load payment screenshot.';
        if (errorEl) errorEl.style.display = 'flex';
      };

      img.src = imgUrl;

      if (retryBtn && appId) {
        retryBtn.onclick = () => this.viewOwnerMemberCardScreenshot(appId);
      }

      modal.classList.add('visible', 'open', 'active');
      this.setupImageZoomTouchHandlers();
    }
  }

  zoomApplyModalQr() {
    const qrImgEl = document.getElementById('imgApplyModalQr');
    const src = (qrImgEl && qrImgEl.src) ? qrImgEl.src : (this.settings?.upi_qr_code || '/images/tiffin_logo.png');
    this.viewPaymentProof(src);
  }

  closeViewPaymentProofModal() {
    const modal = document.getElementById('modalViewPaymentProof');
    if (modal) modal.classList.remove('visible', 'open', 'active');
  }

  setZoomScale(scale) {
    this.zoomScale = Math.min(3.0, Math.max(0.5, Math.round(scale * 100) / 100));
    const img = document.getElementById('imgPaymentProofZoom');
    const lbl = document.getElementById('lblZoomPercentage');
    if (img) {
      img.style.transform = `scale(${this.zoomScale})`;
    }
    if (lbl) {
      lbl.textContent = `${Math.round(this.zoomScale * 100)}%`;
    }
  }

  zoomPaymentProof(delta) {
    if (delta === 'reset' || delta === 1.0) {
      this.setZoomScale(1.0);
    } else if (typeof delta === 'number') {
      const current = this.zoomScale || 1.0;
      this.setZoomScale(current + delta);
    }
  }

  setupImageZoomTouchHandlers() {
    const img = document.getElementById('imgPaymentProofZoom');
    const container = img ? img.parentElement : null;
    if (!img || !container || img.dataset.touchBound) return;
    img.dataset.touchBound = 'true';

    let initialDist = 0;
    let initialScale = 1.0;
    let isDragging = false;
    let startX = 0, startY = 0;
    let currentX = 0, currentY = 0;

    container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        initialDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        initialScale = this.zoomScale || 1.0;
      } else if (e.touches.length === 1 && (this.zoomScale || 1.0) > 1.0) {
        isDragging = true;
        startX = e.touches[0].clientX - currentX;
        startY = e.touches[0].clientY - currentY;
      }
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && initialDist > 0) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const factor = dist / initialDist;
        const newScale = Math.min(3.0, Math.max(0.5, initialScale * factor));
        this.setZoomScale(newScale);
      } else if (isDragging && e.touches.length === 1) {
        currentX = e.touches[0].clientX - startX;
        currentY = e.touches[0].clientY - startY;
        img.style.transform = `translate(${currentX}px, ${currentY}px) scale(${this.zoomScale || 1.0})`;
      }
    }, { passive: true });

    container.addEventListener('touchend', () => {
      isDragging = false;
      initialDist = 0;
    }, { passive: true });
  }

  async verifyMemberPayment(appId, btnEl = null) {
    if (this.isProcessingMemberAction) return;
    if (!confirm('Verify that the customer has paid ₹10 in cash?')) return;
    this.isProcessingMemberAction = true;
    let origHtml = btnEl ? btnEl.innerHTML : '';
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ⏳ Verifying Payment...`;
    }
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/food-member/owner/verify-payment/${appId}`, { method: 'POST' });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Payment verification failed.');
      this.showToast(`🎉 ${data.message}`, 'success');
      await this.loadOwnerMemberApprovals();
    } catch (err) {
      console.error('Verify payment error:', err);
      this.showToast(err.message || 'Failed to verify payment.', 'error');
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerHTML = origHtml || `<i class="fa-solid fa-circle-check"></i> Verify Cash Payment`;
      }
    } finally {
      this.isProcessingMemberAction = false;
    }
  }

  openRejectPaymentModal(appId) {
    this.pendingRejectAppId = appId;
    const modal = document.getElementById('modalRejectMemberPayment');
    const txt = document.getElementById('txtPaymentRejectionReason');
    if (txt) txt.value = '';
    if (modal) {
      modal.style.display = 'flex';
      modal.style.zIndex = '999999';
      modal.classList.add('open', 'visible', 'active');
    }
  }

  closeRejectPaymentModal() {
    const modal = document.getElementById('modalRejectMemberPayment');
    if (modal) {
      modal.classList.remove('open', 'visible', 'active');
      modal.style.display = 'none';
    }
    this.pendingRejectAppId = null;
  }

  async submitPaymentRejection() {
    if (!this.pendingRejectAppId || this.isProcessingMemberAction) return;
    const reasonEl = document.getElementById('txtPaymentRejectionReason');
    const reason = reasonEl ? reasonEl.value.trim() : '';

    if (!reason) {
      this.showToast('Please enter a rejection reason for the customer.', 'error');
      return;
    }

    this.isProcessingMemberAction = true;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/food-member/owner/reject-payment/${this.pendingRejectAppId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rejection_reason: reason })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Rejection failed.');

      this.showToast('Payment proof rejected.', 'info');
      this.closeRejectPaymentModal();
      await this.loadOwnerMemberApprovals();
    } catch (err) {
      console.error('Reject payment error:', err);
      this.showToast(err.message || 'Failed to reject payment proof.', 'error');
    } finally {
      this.isProcessingMemberAction = false;
    }
  }

  async suspendMemberCard(appId, btnEl = null) {
    if (this.isProcessingMemberAction) return;
    this.isProcessingMemberAction = true;
    let origHtml = btnEl ? btnEl.innerHTML : '';
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ⏳ Suspending...`;
    }
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/food-member/owner/suspend/${appId}`, { method: 'POST' });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Suspension failed.');
      this.showToast('✅ Premium Food Member Card suspended.', 'info');
      await this.loadOwnerMemberApprovals();
    } catch (err) {
      this.showToast(err.message || 'Failed to suspend card.', 'error');
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerHTML = origHtml || `<i class="fa-solid fa-pause"></i> Suspend`;
      }
    } finally {
      this.isProcessingMemberAction = false;
    }
  }

  async reactivateMemberCard(appId, btnEl = null) {
    if (this.isProcessingMemberAction) return;
    this.isProcessingMemberAction = true;
    let origHtml = btnEl ? btnEl.innerHTML : '';
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ⏳ Unsuspending...`;
    }
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/food-member/owner/unsuspend/${appId}`, { method: 'POST' });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Activation failed.');
      this.showToast('✅ Premium Food Member Card activated successfully.', 'success');
      await this.loadOwnerMemberApprovals();
    } catch (err) {
      this.showToast(err.message || 'Failed to activate card.', 'error');
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerHTML = origHtml || `<i class="fa-solid fa-play"></i> Reactivate`;
      }
    } finally {
      this.isProcessingMemberAction = false;
    }
  }

  async approveMemberCard(appId, btnEl = null) {
    if (this.isProcessingMemberAction) return;
    const appItem = this.ownerMemberApplicationsMap ? this.ownerMemberApplicationsMap.get(appId) : null;
    if (appItem && appItem.payment_status !== 'VERIFIED') {
      this.showToast('⚠️ Payment verification required. Please verify the cash payment before approving the Premium Food Member Card.', 'error');
      return;
    }

    if (!confirm('Approve this customer application and issue an active 3-Month Premium Food Member Card?')) return;

    this.isProcessingMemberAction = true;
    let origHtml = btnEl ? btnEl.innerHTML : '';
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ⏳ Approving...`;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/food-member/owner/approve/${appId}`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.message || 'Approval failed.');
      }
      this.showToast(`🎉 ${data.message}`, 'success');
      await this.loadOwnerMemberApprovals();
    } catch (err) {
      console.error('Approve member card error:', err);
      this.showToast(err.message || 'Failed to approve application.', 'error');
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerHTML = origHtml || `<i class="fa-solid fa-check"></i> Approve Card`;
      }
    } finally {
      this.isProcessingMemberAction = false;
    }
  }

  rejectMemberCard(appId) {
    this.pendingRejectMemberAppId = appId;
    
    const existing = document.getElementById('modalConfirmRejectMemberApp');
    if (existing) existing.remove();

    const modalHtml = `
      <div id="modalConfirmRejectMemberApp" class="modal-backdrop open visible active" style="position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important; width: 100vw !important; height: 100vh !important; background: rgba(0,0,0,0.85) !important; backdrop-filter: blur(8px) !important; z-index: 999999 !important; display: flex !important; align-items: center !important; justify-content: center !important; padding: 16px !important; box-sizing: border-box !important;" onclick="if(event.target === this) app.closeRejectMemberCardModal()">
        <div class="modal-card" style="max-width: 440px; width: 100%; padding: 24px; border-radius: 18px; background: var(--bg-surface-elevated, #1E1E2E); color: var(--text-main, #FFF); border: 1px solid #EF5350; box-shadow: 0 12px 40px rgba(0,0,0,0.6); box-sizing: border-box;" onclick="event.stopPropagation()">
          <div style="text-align: center; margin-bottom: 16px;">
            <div style="width: 56px; height: 56px; background: rgba(239, 83, 80, 0.15); color: #EF5350; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.8rem; margin: 0 auto 12px auto;">
              <i class="fa-solid fa-circle-xmark"></i>
            </div>
            <h3 style="margin: 0 0 8px 0; color: #FFF; font-size: 1.25rem;">Reject Member Application?</h3>
            <p style="margin: 0; color: var(--text-muted, #AAA); font-size: 0.92rem; line-height: 1.4;">
              Are you sure you want to reject this Premium Food Member Card application?
            </p>
          </div>

          <div style="margin-bottom: 20px;">
            <label style="font-size: 0.82rem; font-weight: 600; color: var(--text-muted, #CCC); display: block; margin-bottom: 6px;">Rejection Reason (Optional):</label>
            <input type="text" id="txtMemberRejectionReasonInput" value="Details mismatch" placeholder="Enter reason for rejection" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border-color, #444); background: rgba(0,0,0,0.3); color: #FFF; font-size: 0.9rem; box-sizing: border-box;">
          </div>

          <div style="display: flex; gap: 10px; justify-content: flex-end;">
            <button type="button" class="btn-secondary-outline" style="flex: 1; padding: 10px; font-weight: 600;" onclick="app.closeRejectMemberCardModal()">Cancel</button>
            <button type="button" id="btnConfirmRejectMemberCard" class="btn-primary" style="flex: 1.2; padding: 10px; font-weight: 700; background: #D32F2F;" onclick="app.executeRejectMemberCard()">
              <i class="fa-solid fa-xmark"></i> Confirm Reject
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
  }

  closeRejectMemberCardModal() {
    const modal = document.getElementById('modalConfirmRejectMemberApp');
    if (modal) modal.remove();
    this.pendingRejectMemberAppId = null;
    this.isRejectingMemberApp = false;
  }

  async executeRejectMemberCard() {
    if (!this.pendingRejectMemberAppId || this.isRejectingMemberApp) return;
    this.isRejectingMemberApp = true;
    const btn = document.getElementById('btnConfirmRejectMemberCard');
    const reasonInput = document.getElementById('txtMemberRejectionReasonInput');
    const reason = reasonInput ? reasonInput.value.trim() : 'Details mismatch';

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ⏳ Rejecting...`;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/food-member/owner/reject/${this.pendingRejectMemberAppId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rejection_reason: reason })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.message || 'Rejection failed.');
      }
      this.showToast('Application rejected.', 'info');
      this.closeRejectMemberCardModal();
      await this.loadOwnerMemberApprovals();
    } catch (err) {
      console.error('Reject member card error:', err);
      this.showToast(err.message || 'Failed to reject application.', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-xmark"></i> Confirm Reject`;
      }
    } finally {
      this.isRejectingMemberApp = false;
    }
  }

  reapproveMemberCard(appId) {
    this.pendingReapproveMemberAppId = appId;
    
    const existing = document.getElementById('modalConfirmReapproveMemberApp');
    if (existing) existing.remove();

    const modalHtml = `
      <div id="modalConfirmReapproveMemberApp" class="modal-backdrop open visible active" style="position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important; width: 100vw !important; height: 100vh !important; background: rgba(0,0,0,0.85) !important; backdrop-filter: blur(8px) !important; z-index: 999999 !important; display: flex !important; align-items: center !important; justify-content: center !important; padding: 16px !important; box-sizing: border-box !important;" onclick="if(event.target === this) app.closeReapproveMemberCardModal()">
        <div class="modal-card" style="max-width: 440px; width: 100%; padding: 24px; border-radius: 18px; background: var(--bg-surface-elevated, #1E1E2E); color: var(--text-main, #FFF); border: 1px solid #4CAF50; box-shadow: 0 12px 40px rgba(0,0,0,0.6); box-sizing: border-box;" onclick="event.stopPropagation()">
          <div style="text-align: center; margin-bottom: 20px;">
            <div style="width: 56px; height: 56px; background: rgba(76, 175, 80, 0.15); color: #4CAF50; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.8rem; margin: 0 auto 12px auto;">
              <i class="fa-solid fa-rotate-left"></i>
            </div>
            <h3 style="margin: 0 0 8px 0; color: #FFF; font-size: 1.25rem;">Re-Approve Member Card?</h3>
            <p style="margin: 0; color: var(--text-muted, #AAA); font-size: 0.92rem; line-height: 1.4;">
              Re-approve this Premium Food Member Card? The customer's card will become active again with 3-month membership benefits.
            </p>
          </div>

          <div style="display: flex; gap: 10px; justify-content: flex-end;">
            <button type="button" class="btn-secondary-outline" style="flex: 1; padding: 10px; font-weight: 600;" onclick="app.closeReapproveMemberCardModal()">Cancel</button>
            <button type="button" id="btnConfirmReapproveMemberCard" class="btn-primary" style="flex: 1.2; padding: 10px; font-weight: 700; background: #388E3C;" onclick="app.executeReapproveMemberCard()">
              <i class="fa-solid fa-check"></i> Confirm Re-Approve
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
  }

  closeReapproveMemberCardModal() {
    const modal = document.getElementById('modalConfirmReapproveMemberApp');
    if (modal) modal.remove();
    this.pendingReapproveMemberAppId = null;
    this.isReapprovingMemberApp = false;
  }

  async executeReapproveMemberCard() {
    if (!this.pendingReapproveMemberAppId || this.isReapprovingMemberApp) return;
    this.isReapprovingMemberApp = true;
    const btn = document.getElementById('btnConfirmReapproveMemberCard');

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ⏳ Re-Approving...`;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/food-member/owner/reapprove/${this.pendingReapproveMemberAppId}`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.message || 'Re-approval failed.');
      }
      this.showToast(`🎉 ${data.message}`, 'success');
      this.closeReapproveMemberCardModal();
      await this.loadOwnerMemberApprovals();
    } catch (err) {
      console.error('Re-approve member card error:', err);
      this.showToast(err.message || 'Failed to re-approve application.', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-check"></i> Confirm Re-Approve`;
      }
    } finally {
      this.isReapprovingMemberApp = false;
    }
  }

  // =========================================================================
  // CUSTOMER MENU VOTING CLIENT MODULE ("Choose Tomorrow's Special")
  // =========================================================================

  ownerPollFilter = 'ALL';
  selectedPollOptionId = null;

  async loadActivePoll() {
    try {
      const container = document.getElementById('customerVotingContainer');
      if (!container) return;

      const res = await this.fetchWithAuth(`${API_BASE}/menu-voting/active`, { isBackgroundPoll: true });
      const json = await res.json();

      if (!json.success || !json.poll || json.poll.status !== 'ACTIVE') {
        container.innerHTML = '';
        container.style.display = 'none';
        return;
      }

      container.style.display = 'block';
      this.renderCustomerVotingCard(json.poll, json.has_voted, json.voted_option_id);
    } catch (err) {
      console.error('Error loading active poll:', err);
      const container = document.getElementById('customerVotingContainer');
      if (container) {
        container.innerHTML = '';
        container.style.display = 'none';
      }
    }
  }

  renderCustomerVotingCard(poll, hasVoted = false, votedOptionId = null) {
    const container = document.getElementById('customerVotingContainer');
    if (!container) return;

    if (!poll || poll.status !== 'ACTIVE') {
      container.innerHTML = '';
      container.style.display = 'none';
      return;
    }

    // Auto-close timer if poll has end_at time
    if (poll.end_at) {
      const msUntilEnd = new Date(poll.end_at).getTime() - Date.now();
      if (msUntilEnd > 0 && msUntilEnd < 86400000) {
        if (this.votingAutoCloseTimer) clearTimeout(this.votingAutoCloseTimer);
        this.votingAutoCloseTimer = setTimeout(() => {
          this.loadActivePoll();
          this.loadCustomerVoting();
        }, msUntilEnd + 300);
      }
    }

    const isLoggedIn = Boolean(this.currentUser);

    const optionsHtml = poll.options.map((opt) => {
      const isSelected = votedOptionId === opt.id || this.selectedPollOptionId === opt.id;
      const isWinner = poll.winner_food_id === opt.food_id;

      return `
        <div class="poll-option-card ${isSelected ? 'selected' : ''} ${hasVoted ? 'voted-mode' : ''}"
             onclick="${isLoggedIn && !hasVoted && poll.status === 'ACTIVE' ? `app.selectVotingOption('${opt.id}')` : !isLoggedIn ? `app.openAuthModal('CUSTOMER', 'LOGIN')` : ''}"
             style="background: ${isSelected ? 'rgba(234, 162, 33, 0.15)' : 'rgba(255,255,255,0.04)'};
                    border: 2px solid ${isSelected ? 'var(--accent-gold)' : 'var(--border-color)'};
                    border-radius: var(--radius-md); padding: 12px 16px; transition: all 0.2s ease; cursor: ${isLoggedIn && !hasVoted && poll.status === 'ACTIVE' ? 'pointer' : 'pointer'}; margin-bottom: 8px;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
              ${isLoggedIn && !hasVoted && poll.status === 'ACTIVE' ? `
                <input type="radio" name="pollOptionRadio" id="optRadio_${opt.id}" value="${opt.id}" ${isSelected ? 'checked' : ''} style="width: 18px; height: 18px; accent-color: var(--accent-gold);">
              ` : ''}
              ${opt.image ? `<img src="${opt.image}" alt="${opt.food_name}" style="width: 50px; height: 50px; border-radius: 8px; object-fit: cover;">` : ''}
              <div>
                <h4 style="margin: 0 0 2px 0; font-size: 1rem; color: #FFF; font-weight: 700; display: flex; align-items: center; gap: 6px;">
                  ${opt.food_name} ${isWinner ? '🏆' : ''}
                </h4>
                <p style="margin: 0; font-size: 0.8rem; color: var(--text-muted);">${opt.description || 'Delicious South Indian special.'}</p>
                <span style="font-size: 0.82rem; font-weight: 800; color: var(--accent-gold); font-family: var(--font-number);">₹${opt.price}</span>
              </div>
            </div>

            ${hasVoted ? `
              <div style="text-align: right; min-width: 70px;">
                <span style="font-size: 1.1rem; font-weight: 800; color: var(--accent-gold); font-family: var(--font-number);">${opt.percentage}%</span>
                <div style="font-size: 0.72rem; color: var(--text-muted);">${opt.votes} vote${opt.votes === 1 ? '' : 's'}</div>
              </div>
            ` : ''}
          </div>

          ${hasVoted ? `
            <div style="width: 100%; background: rgba(255,255,255,0.1); height: 8px; border-radius: 4px; margin-top: 10px; overflow: hidden;">
              <div style="width: ${opt.percentage}%; background: linear-gradient(90deg, var(--primary), var(--accent-gold)); height: 100%; transition: width 0.4s ease;"></div>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    let actionBtnHtml = '';
    if (!isLoggedIn) {
      actionBtnHtml = `
        <div style="margin-top: 1rem; text-align: center;">
          <p style="margin: 0 0 8px 0; color: var(--text-muted, #AAA); font-size: 0.88rem;">🔐 Login required to vote in tomorrow's special poll.</p>
          <button type="button" class="btn-primary-block" onclick="app.openAuthModal('CUSTOMER', 'LOGIN')" style="width: 100%; padding: 12px; background: linear-gradient(135deg, #0088CC 0%, #006699 100%); font-weight: 700; border-radius: 12px; cursor: pointer;">
            🔐 Login to Vote
          </button>
        </div>
      `;
    } else if (!hasVoted && poll.status === 'ACTIVE') {
      actionBtnHtml = `
        <button type="button" class="btn-primary-block" id="btnSubmitCustomerVote" onclick="app.submitCustomerVote('${poll.id}')" style="width: 100%; margin-top: 1rem; padding: 12px; cursor: pointer;">
          🗳️ Vote Now
        </button>
      `;
    } else if (hasVoted) {
      const votedOpt = poll.options.find(o => o.id === votedOptionId);
      actionBtnHtml = `
        <div style="margin-top: 1rem; padding: 10px 14px; background: rgba(76, 175, 80, 0.15); border: 1px solid #4CAF50; border-radius: 10px; text-align: center; color: #4CAF50; font-size: 0.88rem; font-weight: 700;">
          ✅ Your vote has been recorded.${votedOpt ? ` You voted for <span style="color: #FFF;">${votedOpt.food_name}</span>.` : ''}
        </div>
      `;
    }

    container.innerHTML = `
      <div class="card" style="background: linear-gradient(135deg, rgba(234, 162, 33, 0.12), rgba(217, 83, 30, 0.08)); border: 1px solid var(--accent-gold); border-radius: var(--radius-lg); padding: 1.25rem; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 1rem; flex-wrap: wrap;">
          <div>
            <h3 style="margin: 0 0 4px 0; font-size: 1.15rem; font-weight: 800; color: #FFF; display: flex; align-items: center; gap: 6px;">
              🗳️ ${poll.question} 🍽️
            </h3>
            <p style="margin: 0; font-size: 0.82rem; color: var(--text-muted);">Which dish would you like to see as tomorrow's special?</p>
          </div>
          <span class="status-badge" style="background: rgba(76, 175, 80, 0.15); color: #4CAF50; border: 1px solid #4CAF50; font-size: 0.75rem; padding: 4px 10px;">
            🟢 Voting Active
          </span>
        </div>

        <div style="display: flex; flex-direction: column; gap: 0.75rem;">
          ${optionsHtml}
        </div>

        ${actionBtnHtml}
      </div>
    `;
  }

  selectVotingOption(optionId) {
    if (!this.currentUser) {
      this.openAuthModal('CUSTOMER', 'LOGIN');
      return;
    }
    this.selectedPollOptionId = optionId;
    const radios = document.getElementsByName('pollOptionRadio');
    radios.forEach(r => {
      r.checked = r.value === optionId;
    });

    const cards = document.querySelectorAll('.poll-option-card');
    cards.forEach(c => {
      c.style.borderColor = 'var(--border-color)';
      c.style.background = 'rgba(255,255,255,0.04)';
    });
    const selectedRadio = document.getElementById(`optRadio_${optionId}`);
    if (selectedRadio) {
      selectedRadio.checked = true;
      const card = selectedRadio.closest('.poll-option-card');
      if (card) {
        card.style.borderColor = 'var(--accent-gold)';
        card.style.background = 'rgba(234, 162, 33, 0.15)';
      }
    }
  }

  async submitCustomerVote(pollId) {
    if (!this.currentUser) {
      this.showToast('🔐 Login Required. Please login to your account to vote.', 'warning');
      this.openAuthModal('CUSTOMER', 'LOGIN');
      return;
    }

    if (!this.selectedPollOptionId) {
      const selectedRadio = document.querySelector('input[name="pollOptionRadio"]:checked');
      if (selectedRadio) this.selectedPollOptionId = selectedRadio.value;
    }

    if (!this.selectedPollOptionId) {
      this.showToast('Please select a food option before voting.', 'warning');
      return;
    }

    try {
      const btn = document.getElementById('btnSubmitCustomerVote');
      if (btn) { btn.disabled = true; btn.innerText = 'Submitting Vote...'; }

      const res = await this.fetchWithAuth(`${API_BASE}/menu-voting/polls/${pollId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ option_id: this.selectedPollOptionId })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || '✅ Your vote has been recorded!', 'success');
        this.renderCustomerVotingCard(json.poll, true, json.voted_option_id);
      } else {
        this.showToast(json.message || 'Failed to submit vote.', 'error');
        if (json.message && json.message.includes('Voting Closed')) {
          this.loadActivePoll();
          this.loadCustomerVoting();
        } else if (btn) {
          btn.disabled = false;
          btn.innerText = '🗳️ Vote Now';
        }
      }
    } catch (err) {
      console.error('Submit vote error:', err);
      this.showToast('Network error submitting vote.', 'error');
    }
  }


  // =========================================================================
  // OWNER MENU VOTING MANAGEMENT MODULE
  // =========================================================================

  async loadOwnerPolls() {
    try {
      if (!this.ownerPollFilter) this.ownerPollFilter = 'ALL';
      const search = (document.getElementById('txtOwnerPollSearch')?.value || '').trim();
      let url = `${API_BASE}/menu-voting/polls?status=${this.ownerPollFilter}`;
      if (search) url += `&search=${encodeURIComponent(search)}`;

      const res = await this.fetchWithAuth(url);
      const json = await res.json();

      const container = document.getElementById('ownerPollsContainer');
      if (!container) return;

      if (!json.success || !json.data || json.data.length === 0) {
        container.innerHTML = `
          <div class="card" style="text-align: center; padding: 2.5rem 1rem; color: var(--text-muted);">
            <i class="fa-solid fa-square-poll-vertical" style="font-size: 2.5rem; color: var(--accent-gold); margin-bottom: 12px; display: block;"></i>
            <h4 style="color: #FFF; margin-bottom: 4px;">No Menu Voting Polls Found</h4>
            <p style="font-size: 0.85rem; margin-bottom: 1rem;">Create a poll to let customers choose tomorrow's special dish.</p>
            <button class="btn-primary-block" onclick="app.openCreatePollModal()" style="width: auto; padding: 8px 20px; display: inline-flex; gap: 6px; align-items: center;">
              <i class="fa-solid fa-plus"></i> Create Menu Vote
            </button>
          </div>
        `;
        return;
      }

      container.innerHTML = json.data.map(poll => this.renderOwnerPollCard(poll)).join('');
    } catch (err) {
      console.error('Error loading owner polls:', err);
    }
  }

  filterOwnerPolls(status) {
    this.ownerPollFilter = status;
    const chips = ['chipPollAll', 'chipPollActive', 'chipPollScheduled', 'chipPollCompleted', 'chipPollCancelled'];
    chips.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    });

    const activeMap = {
      'ALL': 'chipPollAll',
      'ACTIVE': 'chipPollActive',
      'SCHEDULED': 'chipPollScheduled',
      'COMPLETED': 'chipPollCompleted',
      'CANCELLED': 'chipPollCancelled'
    };
    if (activeMap[status]) {
      const target = document.getElementById(activeMap[status]);
      if (target) target.classList.add('active');
    }

    this.loadOwnerPolls();
  }

  renderOwnerPollCard(poll) {
    const statusBadges = {
      'ACTIVE': '<span class="status-badge" style="background: rgba(76, 175, 80, 0.15); color: #4CAF50; border: 1px solid #4CAF50;">🟢 Active</span>',
      'SCHEDULED': '<span class="status-badge" style="background: rgba(255, 193, 7, 0.15); color: #FFC107; border: 1px solid #FFC107;">🟡 Scheduled</span>',
      'CLOSED': '<span class="status-badge" style="background: rgba(244, 67, 54, 0.15); color: #F44336; border: 1px solid #F44336;">🔴 Closed</span>',
      'COMPLETED': '<span class="status-badge" style="background: rgba(255, 215, 0, 0.15); color: #FFD700; border: 1px solid #FFD700;">🏆 Completed</span>',
      'CANCELLED': '<span class="status-badge" style="background: rgba(158, 158, 158, 0.15); color: #9E9E9E; border: 1px solid #9E9E9E;">⚪ Cancelled</span>'
    };

    const optionsHtml = (poll.options || []).map(opt => `
      <div style="background: rgba(255,255,255,0.04); border: 1px solid var(--border-color); border-radius: 12px; padding: 10px 14px; margin-bottom: 8px; display: flex; align-items: center; gap: 12px;">
        <img src="${opt.food_image || opt.image || '/images/idly_sambar.png'}" style="width: 42px; height: 42px; border-radius: 8px; object-fit: cover;">
        <div style="flex: 1;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-weight: 700; color: #FFF; font-size: 0.92rem;">${opt.food_name || 'Special Dish'} <strong style="color: var(--accent-gold); font-size: 0.84rem;">(₹${opt.price || opt.food_price || 0})</strong></span>
            <span style="font-size: 0.85rem; font-weight: 800; color: var(--accent-gold); font-family: var(--font-number);">${opt.votes || opt.votes_count || 0} votes (${opt.percentage || opt.vote_percentage || 0}%)</span>
          </div>
          <div style="width: 100%; background: rgba(255,255,255,0.1); height: 6px; border-radius: 3px; overflow: hidden;">
            <div style="width: ${opt.percentage || opt.vote_percentage || 0}%; background: linear-gradient(90deg, #9C27B0, var(--accent-gold)); height: 100%;"></div>
          </div>
        </div>
      </div>
    `).join('');

    let tieBoxHtml = '';
    if (poll.is_tie && poll.leading_options && poll.leading_options.length > 1) {
      tieBoxHtml = `
        <div style="background: rgba(255, 152, 0, 0.15); border: 1px dashed #FF9800; border-radius: 10px; padding: 12px; margin-top: 1rem;">
          <h4 style="margin: 0 0 6px 0; color: #FF9800; font-size: 0.95rem;">🤝 Tie Detected</h4>
          <p style="margin: 0 0 8px 0; font-size: 0.82rem; color: #FFF;">
            Equal highest votes between: <strong>${poll.leading_options.map(o => o.food_name).join(', ')}</strong> (${poll.leading_options[0].votes} votes each).
          </p>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            ${poll.leading_options.map(o => `
              <button type="button" class="btn-sm-status" onclick="app.selectTieWinner('${poll.id}', '${o.food_id}')" style="background: var(--accent-gold); color: #000; font-weight: 800;">
                Select "${o.food_name}" as Winner
              </button>
            `).join('')}
          </div>
        </div>
      `;
    }

    let winnerBoxHtml = '';
    if (poll.winner) {
      winnerBoxHtml = `
        <div style="background: rgba(255, 215, 0, 0.12); border: 1px solid var(--accent-gold); border-radius: 10px; padding: 12px; margin-top: 1rem; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
          <div>
            <span style="font-size: 0.75rem; font-weight: 800; color: var(--accent-gold); text-transform: uppercase;">🏆 Winner Dish</span>
            <h4 style="margin: 2px 0 0 0; color: #FFF; font-size: 1.05rem; font-weight: 800;">${poll.winner.food_name} (${poll.winner.votes} votes - ${poll.winner.percentage}%)</h4>
          </div>
          ${!poll.tomorrow_special_published ? `
            <button type="button" class="btn-primary-block" onclick="app.publishTomorrowSpecial('${poll.id}')" style="width: auto; padding: 6px 16px; font-size: 0.82rem; background: var(--accent-gold); color: #000;">
              ✨ Set as Tomorrow's Special
            </button>
          ` : `
            <span style="color: #4CAF50; font-size: 0.82rem; font-weight: 700;">✓ Published as Tomorrow's Special</span>
          `}
        </div>
      `;
    }

    return `
      <div class="card" style="padding: 1.25rem; border-radius: var(--radius-lg); background: var(--card-bg, #1E1E2E); border: 1px solid var(--border-color); margin-bottom: 1rem;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 1rem; flex-wrap: wrap;">
          <div>
            <h3 style="margin: 0 0 4px 0; font-size: 1.1rem; color: #FFF; font-weight: 800;">🗳️ ${poll.question}</h3>
            <span style="font-size: 0.78rem; color: var(--text-muted);">
              Total Votes: <strong style="color: var(--accent-gold);">${poll.total_votes}</strong> | Window: ${new Date(poll.start_at).toLocaleDateString('en-IN')} - ${new Date(poll.end_at).toLocaleDateString('en-IN')}
            </span>
          </div>
          ${statusBadges[poll.status] || ''}
        </div>

        <div>
          ${optionsHtml}
        </div>

        ${tieBoxHtml}
        ${winnerBoxHtml}

        <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid var(--border-color);">
          ${poll.status === 'ACTIVE' ? `
            <button type="button" class="btn-secondary-outline" onclick="app.closePoll('${poll.id}')" style="font-size: 0.8rem; padding: 6px 14px; color: #FFC107; border-color: #FFC107;">
              Close Voting
            </button>
          ` : ''}
          ${poll.status === 'ACTIVE' || poll.status === 'SCHEDULED' ? `
            <button type="button" class="btn-secondary-outline" onclick="app.cancelPoll('${poll.id}')" style="font-size: 0.8rem; padding: 6px 14px; color: #FF9800; border-color: #FF9800;">
              Cancel Poll
            </button>
          ` : ''}
          <button type="button" class="btn-secondary-outline" onclick="app.deletePoll('${poll.id}')" style="font-size: 0.8rem; padding: 6px 14px; color: #EF5350; border-color: #EF5350;">
            <i class="fa-solid fa-trash-can"></i> Delete
          </button>
        </div>
      </div>
    `;
  }

  async openCreatePollModal() {
    let modal = document.getElementById('modalCreatePoll');
    if (!modal) {
      console.error('modalCreatePoll element not found!');
      this.showToast('Error: Poll modal not found in page.', 'error');
      return;
    }

    // Always move to body root to avoid any parent container stacking context or overflow hidden issues
    if (modal.parentNode !== document.body) {
      document.body.appendChild(modal);
    }

    // Reset selection for new poll
    this.selectedPollFoodIds = [];

    // FIRST: Show the modal immediately at top level
    modal.className = 'modal-backdrop open active visible';
    modal.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;z-index:9999999!important;display:flex!important;align-items:center!important;justify-content:center!important;background:rgba(0,0,0,0.85)!important;backdrop-filter:blur(8px)!important;opacity:1!important;visibility:visible!important;pointer-events:auto!important;';

    // Set dates & question
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const startIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const endIso = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

    const txtStart = document.getElementById('txtPollStartAt');
    const txtEnd = document.getElementById('txtPollEndAt');
    const txtQuestion = document.getElementById('txtPollQuestion');
    if (txtStart) txtStart.value = startIso;
    if (txtEnd) txtEnd.value = endIso;
    if (txtQuestion) txtQuestion.value = "Choose Tomorrow's Special";

    // Show loading in food container
    const container = document.getElementById('pollOptionRowsContainer');
    if (container) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--accent-gold);font-size:0.9rem;"><i class="fa-solid fa-spinner fa-spin" style="font-size:1.5rem;margin-bottom:8px;display:block;"></i>Loading food dishes...</div>';
    }

    // THEN: Fetch menu items
    try {
      const res = await fetch(`${API_BASE}/menu`);
      const json = await res.json();
      if (json.success && Array.isArray(json.data) && json.data.length > 0) {
        this.menu = json.data;
      }
    } catch (err) {
      console.warn('Failed to fetch menu for poll modal:', err);
    }

    // Pre-select first 2 items
    const list = (this.menu && this.menu.length > 0) ? this.menu : (this.menuItems || []);
    if (list.length >= 2) {
      this.selectedPollFoodIds = [list[0].id, list[1].id];
    } else if (list.length === 1) {
      this.selectedPollFoodIds = [list[0].id];
    }

    // Render food selection grid
    await this.renderFoodPillGrid();
  }

  closeCreatePollModal() {
    const modal = document.getElementById('modalCreatePoll');
    if (modal) {
      modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 9999999; display: none !important; align-items: center; justify-content: center; background: rgba(0,0,0,0.85); backdrop-filter: blur(8px); opacity: 0 !important; visibility: hidden !important; pointer-events: none !important;';
      modal.classList.remove('open', 'active', 'visible');
      modal.classList.add('hidden');
    }
  }

  async renderFoodPillGrid() {
    const container = document.getElementById('pollOptionRowsContainer');
    if (!container) return;

    if (!this.menu || this.menu.length === 0) {
      try {
        const res = await fetch(`${API_BASE}/menu`);
        const json = await res.json();
        if (json.success && Array.isArray(json.data) && json.data.length > 0) {
          this.menu = json.data;
        }
      } catch (e) {}
    }

    const fallbackDishes = [
      { id: 'tf_idly', name: 'Idly (4 Pieces)', price: 40, image: '/images/idly_sambar.png' },
      { id: 'tf_vada', name: 'Medu Vada (2 Pieces)', price: 45, image: '/images/vada.png' },
      { id: 'tf_puri', name: 'Puri Sagu (3 Pieces)', price: 60, image: '/images/puri.png' },
      { id: 'tf_dosa', name: 'Masala Dosa', price: 65, image: '/images/dosa.png' },
      { id: 'tf_meals', name: 'South Indian Mini Meals', price: 90, image: '/images/meals.png' }
    ];

    const list = (this.menu && this.menu.length > 0) ? this.menu : ((this.menuItems && this.menuItems.length > 0) ? this.menuItems : fallbackDishes);

    if (list.length === 0) {
      container.innerHTML = `
        <div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">
          Loading menu dishes...
        </div>
      `;
      return;
    }

    let html = `
      <div style="margin-bottom: 1rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 6px;">
          <span style="font-size: 0.85rem; font-weight: 800; color: var(--accent-gold);">
            👇 Method 1: Tap 2 to 5 food dishes below:
          </span>
          <span style="font-size: 0.8rem; font-weight: 800; padding: 4px 12px; border-radius: 12px; background: rgba(234, 162, 33, 0.2); color: var(--accent-gold); border: 1px solid var(--accent-gold);" id="lblSelectedPollCount">
            Selected: ${this.selectedPollFoodIds ? this.selectedPollFoodIds.length : 0} / 5
          </span>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; max-height: 220px; overflow-y: auto; padding: 10px; border: 1.5px solid var(--accent-gold); border-radius: 12px; background: rgba(0,0,0,0.4); margin-bottom: 1rem;">
    `;

    list.forEach(t => {
      const isSelected = (this.selectedPollFoodIds || []).includes(t.id);
      html += `
        <div onclick="app.togglePollFoodPillSelection('${t.id}')" style="cursor: pointer; padding: 10px; border-radius: 10px; border: 2px solid ${isSelected ? 'var(--accent-gold)' : 'rgba(255,255,255,0.12)'}; background: ${isSelected ? 'rgba(234, 162, 33, 0.2)' : 'rgba(255,255,255,0.04)'}; display: flex; align-items: center; gap: 10px; transition: all 0.2s ease; box-shadow: ${isSelected ? '0 4px 12px rgba(234, 162, 33, 0.25)' : 'none'};">
          <img src="${t.image || '/images/idly_sambar.png'}" style="width: 38px; height: 38px; border-radius: 8px; object-fit: cover; border: 1px solid rgba(255,255,255,0.1);">
          <div style="overflow: hidden; flex: 1;">
            <strong style="color: #FFF; font-size: 0.82rem; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 800;">${t.name}</strong>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px;">
              <span style="color: var(--accent-gold); font-size: 0.78rem; font-weight: 800;">₹${t.price}</span>
              <span style="font-size: 0.72rem; font-weight: 900; color: ${isSelected ? '#00E676' : '#AAA'};">${isSelected ? '✅ Selected' : '+ Tap'}</span>
            </div>
          </div>
        </div>
      `;
    });

    html += `
        </div>

        <div style="border-top: 1px dashed var(--border-color); padding-top: 0.75rem;">
          <label style="font-size: 0.82rem; font-weight: 800; color: var(--accent-gold); display: block; margin-bottom: 6px;">
            👇 Method 2: Or select from Dropdowns:
          </label>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; gap: 8px; align-items: center;">
              <span style="font-size: 0.78rem; font-weight: 700; color: #AAA; width: 75px;">Option 1:</span>
              <select class="sel-poll-food-id form-control" onchange="app.syncPollSelectDropdowns()" style="flex: 1; padding: 6px 10px; font-size: 0.82rem;">
                <option value="">-- Choose Dish 1 --</option>
                ${list.map(t => `<option value="${t.id}" ${(this.selectedPollFoodIds?.[0] === t.id) ? 'selected' : ''}>${t.name} (₹${t.price})</option>`).join('')}
              </select>
            </div>
            <div style="display: flex; gap: 8px; align-items: center;">
              <span style="font-size: 0.78rem; font-weight: 700; color: #AAA; width: 75px;">Option 2:</span>
              <select class="sel-poll-food-id form-control" onchange="app.syncPollSelectDropdowns()" style="flex: 1; padding: 6px 10px; font-size: 0.82rem;">
                <option value="">-- Choose Dish 2 --</option>
                ${list.map(t => `<option value="${t.id}" ${(this.selectedPollFoodIds?.[1] === t.id) ? 'selected' : ''}>${t.name} (₹${t.price})</option>`).join('')}
              </select>
            </div>
            <div style="display: flex; gap: 8px; align-items: center;">
              <span style="font-size: 0.78rem; font-weight: 700; color: #AAA; width: 75px;">Option 3:</span>
              <select class="sel-poll-food-id form-control" onchange="app.syncPollSelectDropdowns()" style="flex: 1; padding: 6px 10px; font-size: 0.82rem;">
                <option value="">-- Choose Dish 3 (Optional) --</option>
                ${list.map(t => `<option value="${t.id}" ${(this.selectedPollFoodIds?.[2] === t.id) ? 'selected' : ''}>${t.name} (₹${t.price})</option>`).join('')}
              </select>
            </div>
          </div>
        </div>
      </div>
    `;

    container.innerHTML = html;
  }

  syncPollSelectDropdowns() {
    const selects = document.querySelectorAll('.sel-poll-food-id');
    const selected = [];
    selects.forEach(s => {
      if (s.value && !selected.includes(s.value)) {
        selected.push(s.value);
      }
    });
    if (selected.length > 0) {
      this.selectedPollFoodIds = selected;
    }
    const lbl = document.getElementById('lblSelectedPollCount');
    if (lbl) lbl.innerText = `Selected: ${this.selectedPollFoodIds ? this.selectedPollFoodIds.length : 0} / 5`;
  }

  togglePollFoodPillSelection(foodId) {
    if (!this.selectedPollFoodIds) this.selectedPollFoodIds = [];

    const idx = this.selectedPollFoodIds.indexOf(foodId);
    if (idx > -1) {
      this.selectedPollFoodIds.splice(idx, 1);
    } else {
      if (this.selectedPollFoodIds.length >= 5) {
        this.showToast('Maximum 5 food options allowed per poll.', 'warning');
        return;
      }
      this.selectedPollFoodIds.push(foodId);
    }
    this.renderFoodPillGrid();
  }

  addPollOptionRow() {
    this.renderFoodPillGrid();
  }

  async submitCreatePoll(e) {
    if (e) e.preventDefault();

    const submitBtn = e?.target?.querySelector('button[type="submit"]') || document.querySelector('#modalCreatePoll button[type="submit"]');
    const origText = submitBtn ? submitBtn.innerText : 'Create Menu Vote';

    const questionInput = document.getElementById('txtPollQuestion');
    const startAtInput = document.getElementById('txtPollStartAt');
    const endAtInput = document.getElementById('txtPollEndAt');

    const question = questionInput?.value ? questionInput.value.trim() : "Choose Tomorrow's Special";
    const start_at = startAtInput?.value;
    const end_at = endAtInput?.value;

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const startDateObj = start_at ? new Date(start_at) : now;
    const endDateObj = end_at ? new Date(end_at) : tomorrow;

    // Ensure endDate is strictly after startDate
    if (endDateObj <= startDateObj) {
      endDateObj.setTime(startDateObj.getTime() + 24 * 60 * 60 * 1000);
    }

    const start_iso = startDateObj.toISOString();
    const end_iso = endDateObj.toISOString();

    let food_ids = Array.isArray(this.selectedPollFoodIds) ? [...this.selectedPollFoodIds] : [];

    if (food_ids.length < 2) {
      const selects = document.querySelectorAll('.sel-poll-food-id');
      selects.forEach(s => {
        if (s.value) food_ids.push(s.value);
      });
    }

    if (food_ids.length < 2) {
      this.showToast('Please tap at least 2 food dishes to include in the poll.', 'warning');
      return;
    }

    if (food_ids.length > 5) {
      this.showToast('Maximum 5 food options are allowed.', 'warning');
      return;
    }

    const uniqueIds = new Set(food_ids);
    if (uniqueIds.size !== food_ids.length) {
      this.showToast('Please select different food options.', 'warning');
      return;
    }

    try {
      if (submitBtn) { submitBtn.disabled = true; submitBtn.innerText = 'Creating Poll...'; }

      const res = await this.fetchWithAuth(`${API_BASE}/menu-voting/polls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, start_at: start_iso, end_at: end_iso, food_ids })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || 'Poll created successfully!', 'success');
        this.closeCreatePollModal();
        this.filterOwnerPolls('ALL');
      } else {
        this.showToast(json.message || 'Failed to create poll.', 'error');
      }
    } catch (err) {
      console.error('Submit create poll error:', err);
      this.showToast('Network error creating poll.', 'error');
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = origText; }
    }
  }

  async closePoll(pollId) {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm('Are you sure you want to close voting for this poll?')) return;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/menu-voting/polls/${pollId}/close`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message || 'Poll closed.', 'success');
        await this.loadOwnerPolls();
      } else {
        this.showToast(json.message || 'Failed to close poll.', 'error');
      }
    } catch (e) {
      console.error('Error closing poll:', e);
      this.showToast('Network error closing poll.', 'error');
    }
  }

  async cancelPoll(pollId) {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm('Are you sure you want to cancel this poll?')) return;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/menu-voting/polls/${pollId}/cancel`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message || 'Poll cancelled.', 'success');
        await this.loadOwnerPolls();
      } else {
        this.showToast(json.message || 'Failed to cancel poll.', 'error');
      }
    } catch (e) {
      console.error('Error cancelling poll:', e);
      this.showToast('Network error cancelling poll.', 'error');
    }
  }

  async selectTieWinner(pollId, foodId) {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/menu-voting/polls/${pollId}/select-winner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ food_id: foodId })
      });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message || 'Winner dish set.', 'success');
        await this.loadOwnerPolls();
      } else {
        this.showToast(json.message || 'Failed to select winner.', 'error');
      }
    } catch (e) {
      console.error('Error selecting winner:', e);
      this.showToast('Network error selecting winner.', 'error');
    }
  }

  async publishTomorrowSpecial(pollId) {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm("Publish this dish as Tomorrow's Special and notify all customers?")) return;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/menu-voting/polls/${pollId}/publish-special`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message || "Tomorrow's Special published successfully!", 'success');
        await this.loadOwnerPolls();
      } else {
        this.showToast(json.message || 'Failed to publish special.', 'error');
      }
    } catch (e) {
      console.error('Error publishing special:', e);
      this.showToast('Network error publishing special.', 'error');
    }
  }

  async deletePoll(pollId) {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm('Are you sure you want to delete this menu poll record?')) return;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/menu-voting/polls/${pollId}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message || 'Poll deleted.', 'success');
        await this.loadOwnerPolls();
      } else {
        this.showToast(json.message || 'Failed to delete poll.', 'error');
      }
    } catch (e) {
      console.error('Error deleting poll:', e);
      this.showToast('Network error deleting poll.', 'error');
    }
  }


  // =========================================================================
  // OWNER SECURITY & ANTI-FRAUD CENTER CLIENT MODULE
  // =========================================================================

  securitySubTab = 'EVENTS';
  securityEventsPage = 1;
  auditLogsPage = 1;
  currentActiveSecurityEvent = null;

  switchSecuritySubTab(tab) {
    this.securitySubTab = tab;
    const btnEvt = document.getElementById('btnTabSecurityEvents');
    const btnAud = document.getElementById('btnTabAuditLogs');
    const subEvt = document.getElementById('subviewSecurityEvents');
    const subAud = document.getElementById('subviewAuditLogs');

    if (tab === 'EVENTS') {
      if (btnEvt) btnEvt.classList.add('active');
      if (btnAud) btnAud.classList.remove('active');
      if (subEvt) subEvt.classList.remove('hidden');
      if (subAud) subAud.classList.add('hidden');
      this.loadSecurityEvents();
    } else {
      if (btnEvt) btnEvt.classList.remove('active');
      if (btnAud) btnAud.classList.add('active');
      if (subEvt) subEvt.classList.add('hidden');
      if (subAud) subAud.classList.remove('hidden');
      this.loadAuditLogs();
    }
  }

  async loadSecurityDashboard() {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/security/dashboard-stats`);
      const json = await res.json();

      if (json.success && json.data) {
        const d = json.data;
        const lblBadge = document.getElementById('lblSecurityStatusBadge');
        if (lblBadge) {
          lblBadge.innerText = d.status_label || '🟢 Protected';
          if (d.security_status === 'CRITICAL') {
            lblBadge.style.background = 'rgba(244, 67, 54, 0.15)';
            lblBadge.style.color = '#F44336';
            lblBadge.style.borderColor = '#F44336';
          } else if (d.security_status === 'ATTENTION') {
            lblBadge.style.background = 'rgba(255, 152, 0, 0.15)';
            lblBadge.style.color = '#FF9800';
            lblBadge.style.borderColor = '#FF9800';
          } else {
            lblBadge.style.background = 'rgba(76, 175, 80, 0.15)';
            lblBadge.style.color = '#4CAF50';
            lblBadge.style.borderColor = '#4CAF50';
          }
        }

        const elSusp = document.getElementById('statSecSuspiciousCount');
        const elBlock = document.getElementById('statSecBlockedAttempts');
        const elDup = document.getElementById('statSecDuplicateAttempts');
        const elPay = document.getElementById('statSecPaymentIssues');
        const elRew = document.getElementById('statSecRewardIssues');
        const elToday = document.getElementById('statSecEventsToday');

        if (elSusp) elSusp.innerText = d.suspicious_activities_count || 0;
        if (elBlock) elBlock.innerText = d.blocked_attempts || 0;
        if (elDup) elDup.innerText = d.duplicate_attempts || 0;
        if (elPay) elPay.innerText = d.payment_issues || 0;
        if (elRew) elRew.innerText = d.reward_issues || 0;
        if (elToday) elToday.innerText = d.events_today || 0;
      }

      this.loadSecurityEvents();
    } catch (err) {
      console.error('Error loading security dashboard:', err);
    }
  }

  async loadSecurityEvents(page = 1) {
    this.securityEventsPage = page;
    try {
      const risk = document.getElementById('selSecRiskFilter')?.value || 'ALL';
      const status = document.getElementById('selSecStatusFilter')?.value || 'ALL';
      const type = document.getElementById('selSecEventTypeFilter')?.value || 'ALL';
      const search = (document.getElementById('txtSecEventSearch')?.value || '').trim();

      let url = `${API_BASE}/security/events?page=${page}&limit=15&risk_level=${risk}&status=${status}&event_type=${type}`;
      if (search) url += `&search=${encodeURIComponent(search)}`;

      const res = await this.fetchWithAuth(url);
      const json = await res.json();

      const container = document.getElementById('securityEventsCardsContainer');
      if (!container) return;

      if (!json.success || !json.data || json.data.length === 0) {
        container.innerHTML = `
          <div class="card" style="text-align: center; padding: 2.5rem 1rem; color: var(--text-muted);">
            <i class="fa-solid fa-shield-check" style="font-size: 2.5rem; color: #4CAF50; margin-bottom: 12px; display: block;"></i>
            <h4 style="color: #FFF; margin-bottom: 4px;">No Security Events Found</h4>
            <p style="font-size: 0.85rem;">All systems are operating securely with active server-side duplicate protection.</p>
          </div>
        `;
        return;
      }

      container.innerHTML = json.data.map(evt => this.renderSecurityEventCard(evt)).join('');
      this.renderSecurityEventsPagination(json.pagination);
    } catch (err) {
      console.error('Error loading security events:', err);
    }
  }

  renderSecurityEventCard(evt) {
    const riskBadges = {
      'CRITICAL': '<span class="status-badge" style="background: rgba(244, 67, 54, 0.2); color: #F44336; border: 1px solid #F44336; font-weight: 800;">🔴 CRITICAL</span>',
      'HIGH': '<span class="status-badge" style="background: rgba(255, 152, 0, 0.2); color: #FF9800; border: 1px solid #FF9800; font-weight: 800;">🟠 HIGH</span>',
      'MEDIUM': '<span class="status-badge" style="background: rgba(255, 193, 7, 0.2); color: #FFC107; border: 1px solid #FFC107;">🟡 MEDIUM</span>',
      'LOW': '<span class="status-badge" style="background: rgba(76, 175, 80, 0.15); color: #4CAF50; border: 1px solid #4CAF50;">🟢 LOW</span>'
    };

    const statusPills = {
      'NEW': '<span class="status-badge" style="background: rgba(255, 82, 82, 0.15); color: #FF5252;">New</span>',
      'UNDER_REVIEW': '<span class="status-badge" style="background: rgba(255, 152, 0, 0.15); color: #FF9800;">Under Review</span>',
      'RESOLVED': '<span class="status-badge" style="background: rgba(76, 175, 80, 0.15); color: #4CAF50;">Resolved</span>',
      'DISMISSED': '<span class="status-badge" style="background: rgba(158, 158, 158, 0.15); color: #9E9E9E;">Dismissed</span>'
    };

    return `
      <div class="card" style="padding: 1rem 1.25rem; border-radius: 12px; background: var(--card-bg, #1E1E2E); border: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
        <div style="flex: 1; min-width: 250px;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap;">
            ${riskBadges[evt.risk_level] || ''}
            <strong style="color: #FFF; font-size: 0.95rem;">${evt.event_type.replace(/_/g, ' ')}</strong>
            ${statusPills[evt.status] || ''}
          </div>
          <p style="margin: 4px 0; font-size: 0.85rem; color: var(--text-muted);">${evt.details || 'Suspicious request logged.'}</p>
          <div style="font-size: 0.78rem; color: #AAA; display: flex; gap: 12px; flex-wrap: wrap;">
            ${evt.customer_name ? `<span><i class="fa-solid fa-user"></i> ${evt.customer_name} (${evt.customer_mobile || ''})</span>` : ''}
            ${evt.order_id ? `<span><i class="fa-solid fa-receipt"></i> Order: ${evt.order_id}</span>` : ''}
            <span><i class="fa-solid fa-clock"></i> ${new Date(evt.created_at).toLocaleString('en-IN')}</span>
          </div>
        </div>

        <button type="button" class="btn-secondary-outline" onclick="app.openSecurityEventDetailsModal('${evt.id}')" style="font-size: 0.8rem; padding: 6px 14px;">
          View Details
        </button>
      </div>
    `;
  }

  renderSecurityEventsPagination(p) {
    const container = document.getElementById('securityEventsPagination');
    if (!container || !p || p.totalPages <= 1) {
      if (container) container.innerHTML = '';
      return;
    }

    let btns = '';
    for (let i = 1; i <= p.totalPages; i++) {
      btns += `
        <button type="button" class="member-filter-btn ${i === p.page ? 'active' : ''}" onclick="app.loadSecurityEvents(${i})" style="padding: 4px 10px; font-size: 0.78rem;">
          ${i}
        </button>
      `;
    }
    container.innerHTML = btns;
  }

  async openSecurityEventDetailsModal(eventId) {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/security/events/${eventId}`);
      const json = await res.json();

      if (!json.success || !json.data) {
        this.showToast('Event not found.', 'error');
        return;
      }

      this.currentActiveSecurityEvent = json.data;
      const evt = json.data;

      const body = document.getElementById('securityEventDetailsBody');
      const txtNote = document.getElementById('txtSecEventInternalNote');
      if (txtNote) txtNote.value = evt.internal_note || '';

      if (body) {
        body.innerHTML = `
          <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 12px; padding: 1rem; margin-bottom: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; flex-wrap: wrap; gap: 8px;">
              <span style="font-size: 0.78rem; font-weight: 800; color: var(--accent-gold); font-family: monospace;">EVENT #${evt.id}</span>
              <span style="font-size: 0.8rem; font-weight: 700; color: #FFF;">Status: ${evt.status}</span>
            </div>
            <h4 style="margin: 0 0 6px 0; color: #FFF; font-size: 1.05rem;">${evt.event_type.replace(/_/g, ' ')}</h4>
            <p style="margin: 0; font-size: 0.88rem; color: #DDD;">${evt.details}</p>
          </div>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; font-size: 0.85rem; color: var(--text-muted);">
            <div><strong>Risk Level:</strong> <span style="color: #FFF;">${evt.risk_level}</span></div>
            <div><strong>Customer:</strong> <span style="color: #FFF;">${evt.customer_name || 'N/A'} ${evt.customer_mobile ? `(${evt.customer_mobile})` : ''}</span></div>
            <div><strong>Related Order:</strong> <span style="color: #FFF;">${evt.order_id || 'N/A'}</span></div>
            <div><strong>Related Payment:</strong> <span style="color: #FFF;">${evt.payment_id || 'N/A'}</span></div>
            <div><strong>Logged At:</strong> <span style="color: #FFF;">${new Date(evt.created_at).toLocaleString('en-IN')}</span></div>
          </div>
        `;
      }

      const modal = document.getElementById('modalSecurityEventDetails');
      if (modal) modal.classList.remove('hidden');
    } catch (err) {
      console.error('Error opening event modal:', err);
    }
  }

  closeSecurityEventDetailsModal() {
    const modal = document.getElementById('modalSecurityEventDetails');
    if (modal) modal.classList.add('hidden');
  }

  async updateSecurityEventStatus(status) {
    if (!this.currentActiveSecurityEvent) return;

    const note = document.getElementById('txtSecEventInternalNote')?.value || '';
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/security/events/${this.currentActiveSecurityEvent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, internal_note: note })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || `Security event marked as ${status}`, 'success');
        this.closeSecurityEventDetailsModal();
        this.loadSecurityDashboard();
      } else {
        this.showToast(json.message || 'Failed to update event.', 'error');
      }
    } catch (err) {
      console.error('Update event error:', err);
    }
  }

  async loadAuditLogs(page = 1) {
    this.auditLogsPage = page;
    try {
      const search = (document.getElementById('txtAuditLogSearch')?.value || '').trim();
      let url = `${API_BASE}/security/audit-logs?page=${page}&limit=20`;
      if (search) url += `&search=${encodeURIComponent(search)}`;

      const res = await this.fetchWithAuth(url);
      const json = await res.json();

      const container = document.getElementById('auditLogsTableContainer');
      if (!container) return;

      if (!json.success || !json.data || json.data.length === 0) {
        container.innerHTML = `
          <div class="card" style="text-align: center; padding: 2rem 1rem; color: var(--text-muted);">
            <p>No owner audit logs recorded yet.</p>
          </div>
        `;
        return;
      }

      const rowsHtml = json.data.map(log => `
        <tr style="border-bottom: 1px solid var(--border-color);">
          <td style="padding: 10px; font-size: 0.82rem; color: #FFF; font-weight: 700;">${log.action}</td>
          <td style="padding: 10px; font-size: 0.82rem; color: var(--text-muted);">${log.actor_name || 'Owner'}</td>
          <td style="padding: 10px; font-size: 0.82rem; color: #DDD;">${log.details || ''}</td>
          <td style="padding: 10px; font-size: 0.78rem; color: #AAA;">${new Date(log.created_at).toLocaleString('en-IN')}</td>
        </tr>
      `).join('');

      container.innerHTML = `
        <div class="table-responsive" style="overflow-x: auto;">
          <table class="data-table" style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background: rgba(255,255,255,0.05); text-align: left; font-size: 0.78rem; color: var(--text-muted); text-transform: uppercase;">
                <th style="padding: 10px;">Action</th>
                <th style="padding: 10px;">Actor</th>
                <th style="padding: 10px;">Details</th>
                <th style="padding: 10px;">Timestamp</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      `;
    } catch (err) {
      console.error('Error loading audit logs:', err);
    }
  }

  // =========================================================================
  // REFUND TRACKING SYSTEM CLIENT MODULE (Customer & Owner)
  // =========================================================================

  currentActiveCustomerRefundId = null;
  currentActiveOwnerRefundId = null;
  ownerRefundsPage = 1;

  // --- Customer Refund Functions ---

  async openCustomerRefundModal(refundIdOrOrderNumber) {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/refunds/${refundIdOrOrderNumber}`);
      const json = await res.json();

      if (!json.success || !json.data) {
        this.showToast(json.message || 'Refund record not found.', 'error');
        return;
      }

      const r = json.data;
      this.currentActiveCustomerRefundId = r.id;

      const body = document.getElementById('customerRefundDetailsBody');
      if (!body) return;

      const statusBadges = {
        'REFUND_REQUESTED': '<span class="status-badge" style="background: rgba(255, 193, 7, 0.15); color: #FFC107; border: 1px solid #FFC107;">🟡 Refund Requested</span>',
        'REFUND_UNDER_REVIEW': '<span class="status-badge" style="background: rgba(33, 150, 243, 0.15); color: #2196F3; border: 1px solid #2196F3;">🔵 Under Review</span>',
        'REFUND_APPROVED': '<span class="status-badge" style="background: rgba(255, 152, 0, 0.15); color: #FF9800; border: 1px solid #FF9800;">🟠 Refund Approved</span>',
        'REFUND_INITIATED': '<span class="status-badge" style="background: rgba(33, 150, 243, 0.15); color: #2196F3; border: 1px solid #2196F3;">🔵 Refund Initiated</span>',
        'REFUND_PROCESSING': '<span class="status-badge" style="background: rgba(171, 71, 188, 0.15); color: #AB47BC; border: 1px solid #AB47BC;">🟣 Refund Processing</span>',
        'REFUND_COMPLETED': '<span class="status-badge" style="background: rgba(76, 175, 80, 0.15); color: #4CAF50; border: 1px solid #4CAF50; font-weight: 800;">🟢 Refund Completed</span>',
        'REFUND_FAILED': '<span class="status-badge" style="background: rgba(244, 67, 54, 0.15); color: #F44336; border: 1px solid #F44336;">🔴 Refund Failed</span>',
        'REFUND_REJECTED': '<span class="status-badge" style="background: rgba(158, 158, 158, 0.15); color: #9E9E9E; border: 1px solid #9E9E9E;">⚫ Refund Rejected</span>',
        'REFUND_CANCELLED': '<span class="status-badge" style="background: rgba(158, 158, 158, 0.15); color: #9E9E9E; border: 1px solid #9E9E9E;">⚪ Refund Cancelled</span>'
      };

      const timelineHtml = this.renderRefundTimeline(r.timeline || [], r.status);

      body.innerHTML = `
        <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 12px; padding: 1.25rem; margin-bottom: 1.25rem;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 0.75rem; flex-wrap: wrap;">
            <div>
              <span style="font-size: 0.78rem; font-weight: 800; color: var(--accent-gold); font-family: monospace;">REFUND REF: ${r.refund_reference}</span>
              <h4 style="margin: 2px 0 0 0; color: #FFF; font-size: 1.1rem; font-weight: 800;">Order #${r.order_number}</h4>
            </div>
            ${statusBadges[r.status] || ''}
          </div>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 8px; margin-bottom: 1rem;">
            <div>
              <span style="font-size: 0.72rem; color: var(--text-muted); display: block;">Original Payment</span>
              <strong style="font-size: 1rem; color: #FFF; font-family: var(--font-number);">₹${r.original_amount}</strong>
            </div>
            <div>
              <span style="font-size: 0.72rem; color: var(--accent-gold); display: block;">Refund Amount</span>
              <strong style="font-size: 1.15rem; color: var(--accent-gold); font-family: var(--font-number);">₹${r.refund_amount}</strong>
            </div>
            ${Number(r.non_refundable_amount) > 0 ? `
              <div>
                <span style="font-size: 0.72rem; color: #FF5252; display: block;">Deduction</span>
                <strong style="font-size: 0.95rem; color: #FF5252; font-family: var(--font-number);">₹${r.non_refundable_amount}</strong>
              </div>
            ` : ''}
          </div>

          <div style="font-size: 0.84rem; color: var(--text-muted); display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <div><strong>Refund Type:</strong> <span style="color: #FFF;">${r.refund_type}</span></div>
            <div><strong>Payment Method:</strong> <span style="color: #FFF;">${r.payment_method}</span></div>
            <div><strong>Payment Ref / UTR:</strong> <span style="color: #FFF;">${r.payment_reference || 'N/A'}</span></div>
            <div><strong>Requested On:</strong> <span style="color: #FFF;">${new Date(r.created_at).toLocaleString('en-IN')}</span></div>
          </div>

          <div style="margin-top: 10px; font-size: 0.84rem;">
            <strong style="color: var(--text-muted);">Refund Reason:</strong>
            <p style="margin: 2px 0 0 0; color: #FFF; background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px;">${r.reason}</p>
          </div>
        </div>

        <div style="margin-bottom: 1rem;">
          <h4 style="margin: 0 0 0.5rem 0; color: #FFF; font-size: 0.98rem; display: flex; align-items: center; gap: 6px;">
            <i class="fa-solid fa-list-check" style="color: var(--accent-gold);"></i> Refund Timeline Progress
          </h4>
          ${timelineHtml}
        </div>

        ${r.status === 'REFUND_COMPLETED' ? `
          <div style="text-align: center; margin-top: 1rem;">
            <button type="button" class="btn-primary-block" onclick="app.openRefundReceiptModal('${r.id}')" style="width: auto; padding: 8px 20px; display: inline-flex; gap: 8px; align-items: center;">
              <i class="fa-solid fa-receipt"></i> View Official Refund Receipt
            </button>
          </div>
        ` : ''}
      `;

      const modal = document.getElementById('modalCustomerRefundDetails');
      if (modal) modal.classList.remove('hidden');
    } catch (err) {
      console.error('Error opening refund modal:', err);
    }
  }

  closeCustomerRefundDetailsModal() {
    const modal = document.getElementById('modalCustomerRefundDetails');
    if (modal) modal.classList.add('hidden');
  }

  renderRefundTimeline(events = [], currentStatus = '') {
    const steps = [
      { key: 'REQUESTED', label: 'Refund Requested', status: 'REFUND_REQUESTED' },
      { key: 'APPROVED', label: 'Refund Approved', status: 'REFUND_APPROVED' },
      { key: 'INITIATED', label: 'Refund Initiated', status: 'REFUND_INITIATED' },
      { key: 'PROCESSING', label: 'Payment Provider Processing', status: 'REFUND_PROCESSING' },
      { key: 'COMPLETED', label: 'Refund Completed', status: 'REFUND_COMPLETED' }
    ];

    const eventMap = {};
    events.forEach(e => {
      eventMap[e.new_status] = e;
    });

    const statusOrder = ['REFUND_REQUESTED', 'REFUND_UNDER_REVIEW', 'REFUND_APPROVED', 'REFUND_INITIATED', 'REFUND_PROCESSING', 'REFUND_COMPLETED'];
    const currentIndex = statusOrder.indexOf(currentStatus);

    if (currentStatus === 'REFUND_FAILED' || currentStatus === 'REFUND_REJECTED') {
      return `
        <div style="padding: 12px; background: rgba(244,67,54,0.15); border: 1px solid #F44336; border-radius: 10px; color: #F44336; font-size: 0.88rem;">
          <strong>🔴 ${currentStatus === 'REFUND_FAILED' ? 'Refund Failed' : 'Refund Rejected'}</strong>
          <p style="margin: 4px 0 0 0; color: #FFF; font-size: 0.82rem;">${events[events.length - 1]?.message || 'Please check refund details or contact support.'}</p>
        </div>
      `;
    }

    return `
      <div class="refund-timeline">
        ${steps.map((step, idx) => {
          const stepIndex = statusOrder.indexOf(step.status);
          const isDone = currentIndex >= stepIndex && currentIndex !== -1;
          const isActive = currentStatus === step.status;
          const evt = eventMap[step.status];

          let stateClass = 'pending';
          if (isDone) stateClass = 'completed';
          if (isActive) stateClass = 'active';

          return `
            <div class="refund-step ${stateClass}">
              <div class="refund-step-icon">
                ${isDone ? '✓' : (idx + 1)}
              </div>
              <div class="refund-step-line"></div>
              <div class="refund-step-content">
                <h5 class="refund-step-title">${step.label}</h5>
                <span class="refund-step-time">
                  ${evt ? new Date(evt.created_at).toLocaleString('en-IN') : (isDone ? 'Completed' : 'Pending')}
                </span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  async openRefundReceiptModal(refundId) {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/refunds/${refundId}`);
      const json = await res.json();

      if (!json.success || !json.data) return;
      const r = json.data;

      const body = document.getElementById('refundReceiptModalBody');
      if (body) {
        body.innerHTML = `
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 0.85rem; color: #333; margin-bottom: 1.25rem;">
            <div>
              <span style="color: #777; font-size: 0.75rem; text-transform: uppercase;">Refund ID</span>
              <div style="font-weight: 800; font-family: monospace;">${r.id}</div>
            </div>
            <div>
              <span style="color: #777; font-size: 0.75rem; text-transform: uppercase;">Refund Reference</span>
              <div style="font-weight: 800; font-family: monospace; color: #D9531E;">${r.refund_reference}</div>
            </div>
            <div>
              <span style="color: #777; font-size: 0.75rem; text-transform: uppercase;">Order Number</span>
              <div style="font-weight: 700;">#${r.order_number}</div>
            </div>
            <div>
              <span style="color: #777; font-size: 0.75rem; text-transform: uppercase;">Customer Name</span>
              <div style="font-weight: 700;">${r.customer_name || 'Customer'}</div>
            </div>
          </div>

          <div style="background: #F9F9F9; border: 1px solid #EEE; border-radius: 8px; padding: 12px; margin-bottom: 1.25rem;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 0.85rem;">
              <span>Original Order Payment:</span>
              <strong>₹${r.original_amount}</strong>
            </div>
            ${Number(r.non_refundable_amount) > 0 ? `
              <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 0.85rem; color: #D32F2F;">
                <span>Non-Refundable Deduction:</span>
                <strong>- ₹${r.non_refundable_amount}</strong>
              </div>
            ` : ''}
            <div style="display: flex; justify-content: space-between; border-top: 1px solid #DDD; padding-top: 6px; font-size: 1rem; font-weight: 800; color: #2E7D32;">
              <span>Total Refunded Amount:</span>
              <span>₹${r.refund_amount}</span>
            </div>
          </div>

          <div style="font-size: 0.82rem; color: #555; display: flex; flex-direction: column; gap: 4px;">
            <div><strong>Payment Method:</strong> ${r.payment_method}</div>
            <div><strong>Payment Reference / UTR:</strong> ${r.payment_reference || 'N/A'}</div>
            <div><strong>Refund Status:</strong> <span style="color: #2E7D32; font-weight: 800;">🟢 Completed</span></div>
            <div><strong>Completion Date:</strong> ${r.completed_at ? new Date(r.completed_at).toLocaleString('en-IN') : new Date(r.updated_at).toLocaleString('en-IN')}</div>
          </div>

          <p style="margin: 1.25rem 0 0 0; text-align: center; font-size: 0.78rem; color: #888; font-style: italic;">
            Thank you for choosing Annapurna Tiffin Center.
          </p>
        `;
      }

      const modal = document.getElementById('modalRefundReceipt');
      if (modal) modal.classList.remove('hidden');
    } catch (e) {}
  }

  closeRefundReceiptModal() {
    const modal = document.getElementById('modalRefundReceipt');
    if (modal) modal.classList.add('hidden');
  }


  // --- Owner Refund Management Functions ---

  async loadOwnerRefundsDashboard() {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/refunds/owner/stats`);
      const json = await res.json();

      if (json.success && json.data) {
        const d = json.data;
        const elT = document.getElementById('statOwnerRefundsToday');
        const elP = document.getElementById('statOwnerPendingRefunds');
        const elPr = document.getElementById('statOwnerProcessingRefunds');
        const elC = document.getElementById('statOwnerCompletedRefunds');
        const elF = document.getElementById('statOwnerFailedRefunds');
        const elTot = document.getElementById('statOwnerTotalRefunded');

        if (elT) elT.innerText = d.refunds_today || 0;
        if (elP) elP.innerText = d.pending_refunds || 0;
        if (elPr) elPr.innerText = d.processing_refunds || 0;
        if (elC) elC.innerText = d.completed_refunds || 0;
        if (elF) elF.innerText = d.failed_refunds || 0;
        if (elTot) elTot.innerText = `₹${(d.total_refunded || 0).toLocaleString('en-IN')}`;
      }

      this.loadOwnerRefundsList();
    } catch (err) {
      console.error('Error loading owner refund dashboard:', err);
    }
  }

  async loadOwnerRefundsList(page = 1) {
    this.ownerRefundsPage = page;
    try {
      const status = document.getElementById('selOwnerRefundStatusFilter')?.value || 'ALL';
      const type = document.getElementById('selOwnerRefundTypeFilter')?.value || 'ALL';
      const search = (document.getElementById('txtOwnerRefundSearch')?.value || '').trim();

      let url = `${API_BASE}/refunds/owner/all?page=${page}&limit=15&status=${status}&refund_type=${type}`;
      if (search) url += `&search=${encodeURIComponent(search)}`;

      const res = await this.fetchWithAuth(url);
      const json = await res.json();

      const container = document.getElementById('ownerRefundsListContainer');
      if (!container) return;

      if (!json.success || !json.data || json.data.length === 0) {
        container.innerHTML = `
          <div class="card" style="text-align: center; padding: 2.5rem 1rem; color: var(--text-muted);">
            <i class="fa-solid fa-money-bill-transfer" style="font-size: 2.5rem; color: var(--accent-gold); margin-bottom: 12px; display: block;"></i>
            <h4 style="color: #FFF; margin-bottom: 4px;">No Refund Records Found</h4>
            <p style="font-size: 0.85rem;">All customer refunds are up to date.</p>
          </div>
        `;
        return;
      }

      container.innerHTML = json.data.map(r => this.renderOwnerRefundCard(r)).join('');
      this.renderOwnerRefundsPagination(json.pagination);
    } catch (err) {
      console.error('Error loading owner refunds list:', err);
    }
  }

  renderOwnerRefundCard(r) {
    const statusBadges = {
      'REFUND_REQUESTED': '<span class="status-badge" style="background: rgba(255, 193, 7, 0.15); color: #FFC107; border: 1px solid #FFC107;">🟡 Requested</span>',
      'REFUND_UNDER_REVIEW': '<span class="status-badge" style="background: rgba(33, 150, 243, 0.15); color: #2196F3; border: 1px solid #2196F3;">🔵 Under Review</span>',
      'REFUND_APPROVED': '<span class="status-badge" style="background: rgba(255, 152, 0, 0.15); color: #FF9800; border: 1px solid #FF9800;">🟠 Approved</span>',
      'REFUND_INITIATED': '<span class="status-badge" style="background: rgba(33, 150, 243, 0.15); color: #2196F3; border: 1px solid #2196F3;">🔵 Initiated</span>',
      'REFUND_PROCESSING': '<span class="status-badge" style="background: rgba(171, 71, 188, 0.15); color: #AB47BC; border: 1px solid #AB47BC;">🟣 Processing</span>',
      'REFUND_COMPLETED': '<span class="status-badge" style="background: rgba(76, 175, 80, 0.15); color: #4CAF50; border: 1px solid #4CAF50;">🟢 Completed</span>',
      'REFUND_FAILED': '<span class="status-badge" style="background: rgba(244, 67, 54, 0.15); color: #F44336; border: 1px solid #F44336;">🔴 Failed</span>',
      'REFUND_REJECTED': '<span class="status-badge" style="background: rgba(158, 158, 158, 0.15); color: #9E9E9E; border: 1px solid #9E9E9E;">⚫ Rejected</span>',
      'REFUND_CANCELLED': '<span class="status-badge" style="background: rgba(158, 158, 158, 0.15); color: #9E9E9E; border: 1px solid #9E9E9E;">⚪ Cancelled</span>'
    };

    return `
      <div class="card" style="padding: 1.15rem; border-radius: 12px; background: var(--card-bg, #1E1E2E); border: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
        <div style="flex: 1; min-width: 250px;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap;">
            <strong style="color: var(--accent-gold); font-family: monospace; font-size: 0.85rem;">${r.refund_reference}</strong>
            <span style="color: #FFF; font-weight: 800;">Order #${r.order_number}</span>
            ${statusBadges[r.status] || ''}
          </div>

          <p style="margin: 4px 0; font-size: 0.85rem; color: #DDD;">
            Customer: <strong>${r.customer_name || 'Customer'}</strong> (${r.customer_mobile || ''}) | Amount: <strong style="color: var(--accent-gold); font-family: var(--font-number);">₹${r.refund_amount}</strong> (${r.refund_type})
          </p>

          <div style="font-size: 0.78rem; color: var(--text-muted); display: flex; gap: 12px; flex-wrap: wrap;">
            <span><i class="fa-solid fa-clock"></i> Requested: ${new Date(r.created_at).toLocaleString('en-IN')}</span>
            <span><i class="fa-solid fa-credit-card"></i> Pay Ref: ${r.payment_reference || 'N/A'}</span>
          </div>
        </div>

        <button type="button" class="btn-secondary-outline" onclick="app.openOwnerRefundModal('${r.id}')" style="font-size: 0.8rem; padding: 6px 16px;">
          Manage Refund
        </button>
      </div>
    `;
  }

  renderOwnerRefundsPagination(p) {
    const container = document.getElementById('ownerRefundsPagination');
    if (!container || !p || p.totalPages <= 1) {
      if (container) container.innerHTML = '';
      return;
    }

    let btns = '';
    for (let i = 1; i <= p.totalPages; i++) {
      btns += `
        <button type="button" class="member-filter-btn ${i === p.page ? 'active' : ''}" onclick="app.loadOwnerRefundsList(${i})" style="padding: 4px 10px; font-size: 0.78rem;">
          ${i}
        </button>
      `;
    }
    container.innerHTML = btns;
  }

  async openOwnerRefundModal(refundId) {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/refunds/${refundId}`);
      const json = await res.json();

      if (!json.success || !json.data) {
        this.showToast('Refund record not found.', 'error');
        return;
      }

      this.currentActiveOwnerRefundId = json.data.id;
      const r = json.data;

      const body = document.getElementById('ownerRefundDetailsBody');
      const selStatus = document.getElementById('selOwnerActionRefundStatus');
      const btnRetry = document.getElementById('btnOwnerRetryRefund');

      if (selStatus) selStatus.value = r.status;
      if (btnRetry) btnRetry.classList.toggle('hidden', r.status !== 'REFUND_FAILED');

      if (body) {
        body.innerHTML = `
          <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 12px; padding: 1rem; margin-bottom: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; flex-wrap: wrap; gap: 8px;">
              <span style="font-size: 0.78rem; font-weight: 800; color: var(--accent-gold); font-family: monospace;">REFUND ID: ${r.id}</span>
              <span style="font-size: 0.8rem; font-weight: 700; color: #FFF;">Status: ${r.status}</span>
            </div>
            <h4 style="margin: 0 0 6px 0; color: #FFF; font-size: 1.05rem;">Order #${r.order_number} - ${r.customer_name} (${r.customer_mobile})</h4>
            <p style="margin: 0; font-size: 0.88rem; color: #DDD;">Reason: ${r.reason}</p>
          </div>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">
            <div><strong>Original Paid:</strong> <span style="color: #FFF;">₹${r.original_amount}</span></div>
            <div><strong>Refund Amount:</strong> <span style="color: var(--accent-gold); font-weight: 800;">₹${r.refund_amount}</span></div>
            <div><strong>Refund Type:</strong> <span style="color: #FFF;">${r.refund_type}</span></div>
            <div><strong>Payment Method:</strong> <span style="color: #FFF;">${r.payment_method}</span></div>
            <div><strong>Payment UTR:</strong> <span style="color: #FFF;">${r.payment_reference || 'N/A'}</span></div>
            <div><strong>Requested At:</strong> <span style="color: #FFF;">${new Date(r.created_at).toLocaleString('en-IN')}</span></div>
          </div>
        `;
      }

      const modal = document.getElementById('modalOwnerRefundDetails');
      if (modal) modal.classList.remove('hidden');
    } catch (err) {
      console.error('Error opening owner refund modal:', err);
    }
  }

  closeOwnerRefundDetailsModal() {
    const modal = document.getElementById('modalOwnerRefundDetails');
    if (modal) modal.classList.add('hidden');
  }

  async submitOwnerRefundStatusUpdate() {
    if (!this.currentActiveOwnerRefundId) return;

    const status = document.getElementById('selOwnerActionRefundStatus')?.value;
    const note = document.getElementById('txtOwnerRefundStatusNote')?.value || '';

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/refunds/owner/${this.currentActiveOwnerRefundId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, message: note })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || 'Refund status updated.', 'success');
        this.closeOwnerRefundDetailsModal();
        this.loadOwnerRefundsDashboard();
      } else {
        this.showToast(json.message || 'Failed to update refund status.', 'error');
      }
    } catch (err) {
      console.error('Update refund status error:', err);
    }
  }

  async retryFailedRefund() {
    if (!this.currentActiveOwnerRefundId) return;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/refunds/owner/${this.currentActiveOwnerRefundId}/retry`, {
        method: 'POST'
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || 'Refund retry initiated.', 'success');
        this.closeOwnerRefundDetailsModal();
        this.loadOwnerRefundsDashboard();
      } else {
        this.showToast(json.message || 'Failed to retry refund.', 'error');
      }
    } catch (err) {
      console.error('Retry refund error:', err);
    }
  }

  // =========================================================================
  // 🥘 ADD-ONS / EXTRA ITEMS CLIENT MODULE (Customer & Owner)
  // =========================================================================

  availableAddonsList = [];
  selectedCartAddons = {}; // { addon_id: { id, name, price, quantity } }
  currentEditAddonId = null;

  // --- Customer Add-ons Selection Functions ---

  async fetchAvailableAddons() {
    try {
      const res = await fetch(`${API_BASE}/add-ons`);
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        this.availableAddonsList = json.data;
        this.renderCustomerAddonsWidget();
      }
    } catch (err) {
      console.error('Error fetching available add-ons:', err);
    }
  }

  renderCustomerAddonsWidget() {
    const container = document.getElementById('customerAddonsWidgetContainer');
    if (!container) return;

    if (!this.availableAddonsList || this.availableAddonsList.length === 0) {
      container.innerHTML = '';
      container.classList.add('hidden');
      return;
    }

    container.classList.remove('hidden');
    container.innerHTML = `
      <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 12px; padding: 0.85rem; margin: 1rem 0;">
        <h4 style="margin: 0 0 0.5rem 0; color: #FFF; font-size: 0.9rem; display: flex; align-items: center; gap: 8px;">
          <span>🥘</span> Extra Add-ons (Select with Checkbox)
        </h4>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px;">
          ${this.availableAddonsList.map(ao => {
            const sel = this.selectedCartAddons[ao.id];
            const isChecked = sel && sel.quantity > 0;

            return `
              <div class="smart-cart-card-small" style="margin-bottom: 0;">
                <label class="smart-cart-checkbox-wrap">
                  <input type="checkbox" class="smart-cart-checkbox" ${isChecked ? 'checked' : ''} onchange="app.toggleCartAddonCheckbox('${ao.id}', this.checked)">
                  <div class="smart-cart-content">
                    <div class="smart-cart-top-row">
                      <span class="smart-cart-text">🥘 ${escapeHtml(ao.name)}</span>
                      <span class="smart-cart-save-pill" style="color: #81C784; border-color: #4CAF50; background: rgba(76,175,80,0.15);">+₹${ao.price}</span>
                    </div>
                  </div>
                </label>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  toggleCartAddonCheckbox(addonId, isChecked) {
    const addon = (this.availableAddonsList || []).find(a => a.id === addonId);
    if (!addon) return;

    if (isChecked) {
      this.selectedCartAddons[addonId] = {
        add_on_id: addon.id,
        name: addon.name,
        price: Number(addon.price),
        quantity: 1
      };
      this.showToast(`Added ${addon.name} (+₹${addon.price})`, 'success');
    } else {
      delete this.selectedCartAddons[addonId];
      this.showToast(`Removed ${addon.name}`, 'info');
    }

    try {
      localStorage.setItem('tiffin_selected_addons', JSON.stringify(this.selectedCartAddons));
    } catch (e) {}

    this.renderCustomerAddonsWidget();
    this.updateCartUI();
    if (typeof this.saveCartBackend === 'function') this.saveCartBackend();
  }

  updateCartAddonQty(addonId, delta) {
    const addon = (this.availableAddonsList || []).find(a => a.id === addonId);
    if (!addon && (!this.selectedCartAddons || !this.selectedCartAddons[addonId])) return;

    if (!this.selectedCartAddons[addonId]) {
      if (delta > 0 && addon) {
        this.selectedCartAddons[addonId] = {
          add_on_id: addon.id,
          name: addon.name,
          price: Number(addon.price),
          quantity: 1
        };
      }
    } else {
      let newQty = this.selectedCartAddons[addonId].quantity + delta;
      if (newQty <= 0) {
        delete this.selectedCartAddons[addonId];
      } else {
        this.selectedCartAddons[addonId].quantity = Math.min(10, newQty);
      }
    }

    try {
      localStorage.setItem('tiffin_selected_addons', JSON.stringify(this.selectedCartAddons));
    } catch (e) {}

    this.renderCustomerAddonsWidget();
    this.updateCartUI();
    if (typeof this.saveCartBackend === 'function') this.saveCartBackend();
  }

  removeAddon(addonId) {
    if (this.selectedCartAddons && this.selectedCartAddons[addonId]) {
      const addonName = this.selectedCartAddons[addonId].name;
      delete this.selectedCartAddons[addonId];
      try {
        localStorage.setItem('tiffin_selected_addons', JSON.stringify(this.selectedCartAddons));
      } catch (e) {}
      this.showToast(`Removed ${addonName}`, 'info');
      this.renderCustomerAddonsWidget();
      this.updateCartUI();
      if (typeof this.saveCartBackend === 'function') this.saveCartBackend();
    }
  }

  getSelectedAddonsPayload() {
    return Object.values(this.selectedCartAddons || {}).map(item => ({
      add_on_id: item.add_on_id,
      quantity: item.quantity
    }));
  }

  calculateSelectedAddonsTotal() {
    let total = 0;
    Object.values(this.selectedCartAddons).forEach(item => {
      total += (item.price * item.quantity);
    });
    return total;
  }

  // --- Owner Add-ons Management Functions ---

  async loadOwnerAddonsDashboard() {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/add-ons?include_disabled=true`);
      const json = await res.json();

      if (json.success && Array.isArray(json.data)) {
        this.ownerAddonsList = json.data;

        // Calculate Stats
        const totalCount = json.data.length;
        const availCount = json.data.filter(a => a.enabled && a.available).length;

        const elT = document.getElementById('statTotalAddons');
        const elA = document.getElementById('statAvailableAddons');
        if (elT) elT.innerText = totalCount;
        if (elA) elA.innerText = availCount;
      }

      this.loadAddonAnalytics();
      this.loadOwnerAddonsList();
    } catch (err) {
      console.error('Error loading owner add-ons dashboard:', err);
    }
  }

  async loadAddonAnalytics() {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/add-ons/analytics`);
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        const totalRevenue = json.data.reduce((sum, item) => sum + Number(item.total_revenue || 0), 0);
        const elRev = document.getElementById('statAddonSalesRevenue');
        if (elRev) elRev.innerText = `₹${totalRevenue.toLocaleString('en-IN')}`;
      }
    } catch (err) {
      console.error('Error loading add-on analytics:', err);
    }
  }

  loadOwnerAddonsList() {
    const container = document.getElementById('ownerAddonsListContainer');
    if (!container) return;

    const filterStatus = document.getElementById('selOwnerAddonStatusFilter')?.value || 'ALL';
    const search = (document.getElementById('txtOwnerAddonSearch')?.value || '').toLowerCase().trim();

    let list = this.ownerAddonsList || [];

    if (filterStatus === 'AVAILABLE') list = list.filter(a => a.enabled && a.available);
    if (filterStatus === 'UNAVAILABLE') list = list.filter(a => a.enabled && !a.available);
    if (filterStatus === 'DISABLED') list = list.filter(a => !a.enabled);

    if (search) {
      list = list.filter(a => (a.name || '').toLowerCase().includes(search) || (a.description || '').toLowerCase().includes(search));
    }

    if (list.length === 0) {
      container.innerHTML = `
        <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 2.5rem 1rem; color: var(--text-muted);">
          <i class="fa-solid fa-bowl-food" style="font-size: 2.5rem; color: var(--accent-gold); margin-bottom: 12px; display: block;"></i>
          <h4 style="color: #FFF; margin-bottom: 4px;">No Add-on Items Found</h4>
          <p style="font-size: 0.85rem;">Click "+ Add New Add-on" to add your first extra item.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = list.map(ao => `
      <div class="addon-card">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 6px;">
            <h4 style="margin: 0; color: #FFF; font-size: 1.05rem; font-weight: 800;">${ao.name}</h4>
            <span class="status-badge" style="${
              !ao.enabled
                ? 'background: rgba(158,158,158,0.15); color: #9E9E9E; border: 1px solid #9E9E9E;'
                : (ao.available
                  ? 'background: rgba(76,175,80,0.15); color: #4CAF50; border: 1px solid #4CAF50;'
                  : 'background: rgba(244,67,54,0.15); color: #F44336; border: 1px solid #F44336;')
            }">
              ${!ao.enabled ? '⚫ Disabled' : (ao.available ? '🟢 Available' : '🔴 Unavailable')}
            </span>
          </div>

          <div style="font-size: 1.2rem; font-weight: 800; color: var(--accent-gold); font-family: var(--font-number); margin-bottom: 6px;">
            ₹${ao.price}
          </div>

          ${ao.description ? `<p style="font-size: 0.82rem; color: var(--text-muted); margin: 0 0 1rem 0;">${ao.description}</p>` : ''}
        </div>

        <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 1rem; border-top: 1px solid var(--border-color); padding-top: 0.75rem;">
          <button type="button" class="btn-secondary-outline" onclick="app.openEditAddonModal('${ao.id}')" style="flex: 1; font-size: 0.78rem; padding: 6px 10px;">
            ✏️ Edit
          </button>

          ${ao.enabled ? `
            <button type="button" class="btn-sm-status" onclick="app.toggleAddonAvailability('${ao.id}', ${!ao.available})" style="flex: 1; font-size: 0.78rem; padding: 6px 10px; background: ${ao.available ? 'rgba(255,152,0,0.15); color: #FF9800; border: 1px solid #FF9800;' : 'rgba(76,175,80,0.15); color: #4CAF50; border: 1px solid #4CAF50;'}">
              ${ao.available ? '🔴 Mark Unavailable' : '🟢 Mark Available'}
            </button>
            <button type="button" class="btn-sm-status" onclick="app.disableAddon('${ao.id}')" style="font-size: 0.78rem; padding: 6px 10px; background: rgba(244,67,54,0.15); color: #F44336; border: 1px solid #F44336;">
              Disable
            </button>
          ` : `
            <button type="button" class="btn-sm-status" onclick="app.toggleAddonAvailability('${ao.id}', true)" style="flex: 1; font-size: 0.78rem; padding: 6px 10px; background: rgba(76,175,80,0.15); color: #4CAF50; border: 1px solid #4CAF50;">
              Enable Item
            </button>
          `}

          <button type="button" class="btn-sm-status" onclick="app.deleteAddon('${ao.id}')" style="font-size: 0.78rem; padding: 6px 10px; background: rgba(244,67,54,0.2); color: #FF5252; border: 1px solid #FF5252; cursor: pointer;">
            <i class="fa-solid fa-trash-can"></i> Delete
          </button>
        </div>
      </div>
    `).join('');
  }

  openCreateAddonModal() {
    this.currentEditAddonId = null;
    const title = document.getElementById('lblAddonModalTitle');
    const txtId = document.getElementById('txtAddonId');
    const txtName = document.getElementById('txtAddonName');
    const txtPrice = document.getElementById('txtAddonPrice');
    const selAvail = document.getElementById('selAddonAvailability');
    const txtDesc = document.getElementById('txtAddonDescription');
    const btnDelete = document.getElementById('btnDeleteAddonInModal');

    if (title) title.innerHTML = '<span>🥘</span> Add New Add-on';
    if (txtId) txtId.value = '';
    if (txtName) txtName.value = '';
    if (txtPrice) txtPrice.value = '';
    if (selAvail) selAvail.value = 'true';
    if (txtDesc) txtDesc.value = '';
    if (btnDelete) btnDelete.classList.add('hidden');

    const modal = document.getElementById('modalCreateEditAddon');
    if (modal) {
      if (modal.parentNode !== document.body) {
        document.body.appendChild(modal);
      }
      modal.classList.remove('hidden');
      modal.classList.add('open', 'active', 'visible');
      modal.style.cssText = 'position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 9999999 !important; display: flex !important; align-items: center !important; justify-content: center !important; background: rgba(0,0,0,0.85) !important; backdrop-filter: blur(8px) !important; opacity: 1 !important; visibility: visible !important; pointer-events: auto !important;';
    }
  }

  openEditAddonModal(addonId) {
    const addon = (this.ownerAddonsList || []).find(a => a.id === addonId);
    if (!addon) return;

    this.currentEditAddonId = addonId;
    const title = document.getElementById('lblAddonModalTitle');
    const txtId = document.getElementById('txtAddonId');
    const txtName = document.getElementById('txtAddonName');
    const txtPrice = document.getElementById('txtAddonPrice');
    const selAvail = document.getElementById('selAddonAvailability');
    const txtDesc = document.getElementById('txtAddonDescription');
    const btnDelete = document.getElementById('btnDeleteAddonInModal');

    if (title) title.innerHTML = `<span>🥘</span> Edit Add-on "${addon.name}"`;
    if (txtId) txtId.value = addon.id;
    if (txtName) txtName.value = addon.name;
    if (txtPrice) txtPrice.value = addon.price;
    if (selAvail) selAvail.value = addon.available ? 'true' : 'false';
    if (txtDesc) txtDesc.value = addon.description || '';
    if (btnDelete) btnDelete.classList.remove('hidden');

    const modal = document.getElementById('modalCreateEditAddon');
    if (modal) {
      if (modal.parentNode !== document.body) {
        document.body.appendChild(modal);
      }
      modal.classList.remove('hidden');
      modal.classList.add('open', 'active', 'visible');
      modal.style.cssText = 'position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 9999999 !important; display: flex !important; align-items: center !important; justify-content: center !important; background: rgba(0,0,0,0.85) !important; backdrop-filter: blur(8px) !important; opacity: 1 !important; visibility: visible !important; pointer-events: auto !important;';
    }
  }

  closeCreateEditAddonModal() {
    const modal = document.getElementById('modalCreateEditAddon');
    if (modal) {
      modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 9999999; display: none !important; align-items: center; justify-content: center; background: rgba(0,0,0,0.85); backdrop-filter: blur(8px); opacity: 0 !important; visibility: hidden !important; pointer-events: none !important;';
      modal.classList.remove('open', 'active', 'visible');
      modal.classList.add('hidden');
    }
  }

  deleteAddonFromModal() {
    if (!this.currentEditAddonId) return;
    const addonId = this.currentEditAddonId;
    this.closeCreateEditAddonModal();
    this.deleteAddon(addonId);
  }

  async submitAddonForm(e) {
    if (e) e.preventDefault();
    const submitBtn = e?.target?.querySelector('button[type="submit"]') || document.querySelector('#modalCreateEditAddon button[type="submit"]');
    const origText = submitBtn ? submitBtn.innerText : '✓ Save Add-on';

    const id = document.getElementById('txtAddonId')?.value;
    const name = document.getElementById('txtAddonName')?.value;
    const price = document.getElementById('txtAddonPrice')?.value;
    const available = document.getElementById('selAddonAvailability')?.value === 'true';
    const description = document.getElementById('txtAddonDescription')?.value;

    if (!name || !price) {
      this.showToast('Please provide both name and price for the add-on.', 'warning');
      return;
    }

    try {
      if (submitBtn) { submitBtn.disabled = true; submitBtn.innerText = 'Saving Add-on...'; }

      const url = id ? `${API_BASE}/add-ons/${id}` : `${API_BASE}/add-ons`;
      const method = id ? 'PATCH' : 'POST';

      const res = await this.fetchWithAuth(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, price: Number(price), available, description })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || 'Add-on saved successfully!', 'success');
        this.closeCreateEditAddonModal();
        await this.loadOwnerAddonsDashboard();
      } else {
        this.showToast(json.message || 'Failed to save add-on.', 'error');
      }
    } catch (err) {
      console.error('Submit Add-on Error:', err);
      this.showToast('Network error saving add-on.', 'error');
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = origText; }
    }
  }

  async toggleAddonAvailability(addonId, available) {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/add-ons/${addonId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ available, enabled: true })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || 'Add-on status updated.', 'success');
        await this.loadOwnerAddonsDashboard();
      } else {
        this.showToast(json.message || 'Failed to update status.', 'error');
      }
    } catch (err) {
      console.error('Toggle availability error:', err);
      this.showToast('Network error updating add-on status.', 'error');
    }
  }

  loadOwnerAddons() {
    return this.loadOwnerAddonsDashboard();
  }

  async disableAddon(addonId) {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm('Are you sure you want to disable this add-on? Disabled add-ons will no longer be available for new orders, but existing order records remain intact.')) return;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/add-ons/${addonId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || 'Add-on disabled.', 'success');
        await this.loadOwnerAddonsDashboard();
      } else {
        this.showToast(json.message || 'Failed to disable add-on.', 'error');
      }
    } catch (err) {
      console.error('Disable add-on error:', err);
      this.showToast('Network error disabling add-on.', 'error');
    }
  }

  async deleteAddon(addonId) {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm('Are you sure you want to delete this add-on item permanently?')) return;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/add-ons/${addonId}`, {
        method: 'DELETE'
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || 'Add-on item deleted successfully.', 'success');
        await this.loadOwnerAddonsDashboard();
      } else {
        this.showToast(json.message || 'Failed to delete add-on.', 'error');
      }
    } catch (err) {
      console.error('Delete add-on error:', err);
      this.showToast('Network error deleting add-on.', 'error');
    }
  }

  // =========================================================================
  // ⏱️ LIVE PREPARATION TIME CLIENT MODULE
  // =========================================================================

  livePrepTickerInterval = null;

  getPrepTimerDetails(estimatedReadyAt, orderStatus) {
    if (!['Received', 'Preparing'].includes(orderStatus)) {
      if (orderStatus === 'Ready') return { text: '🟢 Ready!', sub: 'Collect at Counter', expectedStr: 'Now' };
      if (orderStatus === 'Completed' || orderStatus === 'Served') return { text: '✓ Completed', sub: 'Order Served', expectedStr: 'Served' };
      if (orderStatus === 'Cancelled') return { text: 'Cancelled', sub: 'Order Cancelled', expectedStr: 'N/A' };
      if (orderStatus === 'Rejected') return { text: 'Rejected', sub: 'Order Rejected', expectedStr: 'N/A' };
      return { text: orderStatus || 'Active', sub: 'Order Status', expectedStr: 'N/A' };
    }

    if (!estimatedReadyAt) return { text: '15 min', sub: 'Estimated Prep Time', expectedStr: 'Soon' };

    const readyMs = new Date(estimatedReadyAt).getTime();
    const nowMs = Date.now();
    const diffMs = readyMs - nowMs;
    const remainingMins = Math.max(0, Math.ceil(diffMs / 60000));

    const expectedTimeStr = new Date(readyMs).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });

    if (remainingMins <= 0) {
      return { text: 'Ready Soon', sub: 'Wrapping Up in Kitchen', expectedStr: expectedTimeStr };
    }

    return {
      text: `${remainingMins} min`,
      sub: `Live Preparation Countdown`,
      expectedStr: expectedTimeStr
    };
  }

  startLivePrepTicker() {
    if (this.livePrepTickerInterval) clearInterval(this.livePrepTickerInterval);
    this.livePrepTickerInterval = setInterval(() => {
      const timerEls = document.querySelectorAll('.live-prep-timer-val');
      timerEls.forEach(el => {
        const readyAt = el.getAttribute('data-ready-at');
        const status = el.getAttribute('data-status');
        if (readyAt && ['Received', 'Preparing'].includes(status)) {
          const info = this.getPrepTimerDetails(readyAt, status);
          el.innerText = info.text;
          const orderId = el.getAttribute('data-order-id');
          const subEl = document.getElementById(`prepExpectedTime_${orderId}`);
          if (subEl) subEl.innerText = `🕘 Expected by ${info.expectedStr}`;
        }
      });
    }, 10000);
  }

  togglePrepTimeEdit(orderId, showEdit) {
    if (!this.editingPrepTimeOrders) this.editingPrepTimeOrders = {};
    this.editingPrepTimeOrders[orderId] = showEdit;
    this.renderOrders();
  }

  async updateOrderPreparationTime(orderId, minsInput) {
    let prepMins = minsInput;
    if (prepMins === undefined || prepMins === null) {
      const inputEl = document.getElementById(`txtPrepTime_${orderId}`);
      if (inputEl) prepMins = parseInt(inputEl.value, 10);
    }

    if (!prepMins || isNaN(prepMins) || prepMins < 1 || prepMins > 180) {
      this.showToast('Please enter a valid preparation time between 1 and 180 minutes.', 'warning');
      return;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/orders/${orderId}/preparation-time`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preparation_minutes: prepMins })
      });
      const json = await res.json();

      if (json.success) {
        if (!this.editingPrepTimeOrders) this.editingPrepTimeOrders = {};
        this.editingPrepTimeOrders[orderId] = false;
        this.showToast(`⏱️ Preparation time updated to ${prepMins} minutes!`, 'success');
        this.renderOrders();
      } else {
        this.showToast(json.message || 'Failed to update preparation time.', 'error');
      }
    } catch (err) {
      console.error('Update prep time error:', err);
    }
  }

  // =========================================================================
  // 🧠 OWNER BUSINESS COPILOT CLIENT MODULE
  // =========================================================================

  copilotDateRange = 'today';

  async loadBusinessCopilotDashboard() {
    if (this.currentRole !== 'OWNER') return;
    const container = document.getElementById('copilotContentContainer');
    if (!container) return;

    container.innerHTML = `
      <div style="text-align: center; padding: 4rem 1rem; color: var(--text-muted);">
        <i class="fa-solid fa-brain fa-spin" style="font-size: 2.5rem; color: #2196F3; margin-bottom: 1rem;"></i>
        <h3 style="color: #FFF; font-size: 1.15rem; margin-bottom: 0.5rem;">Analyzing Business Data...</h3>
        <p style="font-size: 0.88rem;">Calculating sales, best sellers, peak demand, and recommendations...</p>
      </div>
    `;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/owner/business-copilot/analytics?range=${this.copilotDateRange}`);
      const json = await res.json();

      if (json.success && json.data) {
        this.renderBusinessCopilotUI(json.data);
      } else {
        container.innerHTML = `
          <div style="text-align: center; padding: 3rem 1rem; color: #F44336; background: rgba(244, 67, 54, 0.1); border-radius: 14px; border: 1px solid #F44336;">
            <i class="fa-solid fa-triangle-exclamation" style="font-size: 2rem; margin-bottom: 0.5rem;"></i>
            <p>${json.message || 'Failed to load Business Copilot analytics.'}</p>
          </div>
        `;
      }
    } catch (err) {
      console.error('Error loading Business Copilot dashboard:', err);
      container.innerHTML = `
        <div style="text-align: center; padding: 3rem 1rem; color: #F44336; background: rgba(244, 67, 54, 0.1); border-radius: 14px; border: 1px solid #F44336;">
          <p>Server communication error loading Business Copilot.</p>
        </div>
      `;
    }
  }

  changeCopilotDateRange(range) {
    this.copilotDateRange = range;
    this.loadBusinessCopilotDashboard();
  }

  renderBusinessCopilotUI(data) {
    const container = document.getElementById('copilotContentContainer');
    if (!container) return;

    const lblUpdated = document.getElementById('lblCopilotLastUpdated');
    if (lblUpdated) lblUpdated.innerText = data.last_updated || 'Just now';

    const kpis = data.kpis || {};
    const sales = kpis.sales || { current: 0, growth_pct: 0 };
    const orders = kpis.orders || { current: 0, growth_pct: 0 };
    const newCust = kpis.new_customers || { current: 0, growth_pct: 0 };
    const refunds = kpis.refunds || { current: 0, count: 0, pending: 0, failed: 0 };
    const aov = kpis.aov || { current: 0, growth_pct: 0 };
    const peak = kpis.peak_demand || { window: 'N/A', count: 0 };

    const formatGrowthPill = (pct) => {
      if (pct > 0) return `<span class="copilot-trend-badge copilot-trend-up"><i class="fa-solid fa-arrow-trend-up"></i> +${pct}%</span>`;
      if (pct < 0) return `<span class="copilot-trend-badge copilot-trend-down"><i class="fa-solid fa-arrow-trend-down"></i> ${pct}%</span>`;
      return `<span class="copilot-trend-badge copilot-trend-neutral"><i class="fa-solid fa-minus"></i> 0%</span>`;
    };

    // 1. KPI Cards HTML
    const kpiCardsHtml = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.15rem; margin-bottom: 1.75rem;">
        <!-- Card 1: Today's Sales -->
        <div class="copilot-kpi-card">
          <div>
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
              <span style="font-size: 0.8rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase;">📈 Net Sales</span>
              ${formatGrowthPill(sales.growth_pct)}
            </div>
            <div style="font-size: 2.1rem; font-weight: 900; color: #FFF; font-family: var(--font-number); letter-spacing: 0.5px;">
              ₹${Number(sales.current || 0).toLocaleString('en-IN')}
            </div>
          </div>
          <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 8px;">
            vs prev period (₹${Number(sales.previous || 0).toLocaleString('en-IN')})
          </div>
        </div>

        <!-- Card 2: Orders Count -->
        <div class="copilot-kpi-card">
          <div>
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
              <span style="font-size: 0.8rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase;">📦 Total Orders</span>
              ${formatGrowthPill(orders.growth_pct)}
            </div>
            <div style="font-size: 2.1rem; font-weight: 900; color: var(--accent-gold); font-family: var(--font-number); letter-spacing: 0.5px;">
              ${orders.current || 0}
            </div>
          </div>
          <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 8px;">
            vs prev period (${orders.previous || 0} orders)
          </div>
        </div>

        <!-- Card 3: New Customers -->
        <div class="copilot-kpi-card">
          <div>
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
              <span style="font-size: 0.8rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase;">👥 New Customers</span>
              ${formatGrowthPill(newCust.growth_pct)}
            </div>
            <div style="font-size: 2.1rem; font-weight: 900; color: #40C4FF; font-family: var(--font-number); letter-spacing: 0.5px;">
              ${newCust.current || 0}
            </div>
          </div>
          <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 8px;">
            Registered in selected period
          </div>
        </div>

        <!-- Card 4: Refunds Overview -->
        <div class="copilot-kpi-card">
          <div>
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
              <span style="font-size: 0.8rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase;">💸 Total Refunds</span>
              <span style="font-size: 0.75rem; font-weight: 800; color: ${refunds.current > 0 ? '#FF9800' : '#4CAF50'};">${refunds.count} refunded</span>
            </div>
            <div style="font-size: 2.1rem; font-weight: 900; color: ${refunds.current > 0 ? '#FF9800' : '#FFF'}; font-family: var(--font-number); letter-spacing: 0.5px;">
              ₹${Number(refunds.current || 0).toLocaleString('en-IN')}
            </div>
          </div>
          <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 8px;">
            ${refunds.pending > 0 ? `⚠️ ${refunds.pending} pending approval` : 'No pending refunds'}
          </div>
        </div>

        <!-- Card 5: Average Order Value -->
        <div class="copilot-kpi-card">
          <div>
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
              <span style="font-size: 0.8rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase;">💰 Avg Order Value</span>
              ${formatGrowthPill(aov.growth_pct)}
            </div>
            <div style="font-size: 2.1rem; font-weight: 900; color: #4CAF50; font-family: var(--font-number); letter-spacing: 0.5px;">
              ₹${Number(aov.current || 0).toFixed(2)}
            </div>
          </div>
          <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 8px;">
            Per completed transaction
          </div>
        </div>

        <!-- Card 6: Peak Demand Window -->
        <div class="copilot-kpi-card">
          <div>
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
              <span style="font-size: 0.8rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase;">🕘 Peak Demand</span>
              <span style="font-size: 0.75rem; font-weight: 800; color: var(--accent-gold);">${peak.count} orders</span>
            </div>
            <div style="font-size: 1.35rem; font-weight: 900; color: #FFF; margin-top: 6px;">
              ${peak.window}
            </div>
          </div>
          <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 8px;">
            Highest ordering volume window
          </div>
        </div>
      </div>
    `;

    // 2. Smart Alerts & Business Recommendations Panel
    const alertsList = data.smart_alerts || [];
    const recommendationsList = data.recommendations || [];

    const alertsHtml = alertsList.length > 0 ? `
      <div style="margin-bottom: 1.75rem; display: flex; flex-direction: column; gap: 8px;">
        ${alertsList.map(a => `
          <div style="background: ${a.type === 'SUCCESS' ? 'rgba(76, 175, 80, 0.14)' : a.type === 'DANGER' ? 'rgba(244, 67, 54, 0.14)' : 'rgba(255, 152, 0, 0.14)'}; border: 1.5px solid ${a.type === 'SUCCESS' ? '#4CAF50' : a.type === 'DANGER' ? '#F44336' : '#FF9800'}; border-radius: 12px; padding: 10px 16px; color: #FFF; font-size: 0.88rem; font-weight: 700; display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 1.2rem;">${a.icon || '⚠️'}</span>
            <span>${a.message}</span>
          </div>
        `).join('')}
      </div>
    ` : '';

    const recsHtml = `
      <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 1.5rem; margin-bottom: 1.75rem;">
        <h3 style="font-size: 1.15rem; font-weight: 800; color: #FFF; margin: 0 0 1rem 0; display: flex; align-items: center; gap: 8px;">
          <span>💡</span> AI Business Recommendations & Insights
        </h3>
        
        ${recommendationsList.length > 0 ? `
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem;">
            ${recommendationsList.map(r => {
              const confClass = r.confidence === 'High' ? 'confidence-high' : r.confidence === 'Medium' ? 'confidence-medium' : 'confidence-low';
              return `
                <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 14px; padding: 1.15rem; display: flex; flex-direction: column; justify-content: space-between;">
                  <div>
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                      <h4 style="margin: 0; font-size: 1rem; font-weight: 800; color: var(--accent-gold);">${r.title}</h4>
                      <span class="confidence-badge ${confClass}">Confidence: ${r.confidence}</span>
                    </div>
                    <p style="font-size: 0.88rem; color: #FFF; margin: 0 0 8px 0; font-weight: 700;">
                      💡 ${r.suggested_action}
                    </p>
                  </div>
                  <div style="font-size: 0.78rem; color: var(--text-muted); background: rgba(0,0,0,0.25); padding: 6px 10px; border-radius: 6px; margin-top: 8px; border-left: 3px solid #2196F3;">
                    <strong>Why:</strong> ${r.reason}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        ` : `
          <div style="text-align: center; padding: 2rem; color: var(--text-muted); background: var(--bg-surface); border-radius: 12px; border: 1.5px dashed var(--border-color);">
            📊 Not enough data yet to generate high-confidence recommendations. Continue receiving orders to unlock deeper AI insights.
          </div>
        `}
      </div>
    `;

    // 3. Best Sellers & Add-ons Grid
    const bestSellersList = data.best_sellers || [];
    const popularAddonsList = data.popular_addons || [];

    const bestSellersHtml = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.5rem; margin-bottom: 1.75rem;">
        
        <!-- Top Food Dishes -->
        <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 1.5rem;">
          <h3 style="font-size: 1.1rem; font-weight: 800; color: #FFF; margin: 0 0 1rem 0; display: flex; align-items: center; justify-content: space-between;">
            <span>🔥 Today's Best-Selling Dishes</span>
            <span style="font-size: 0.78rem; color: var(--text-muted); font-weight: 600;">Units Sold</span>
          </h3>

          ${bestSellersList.length > 0 ? `
            <div style="display: flex; flex-direction: column; gap: 10px;">
              ${bestSellersList.slice(0, 5).map((item, idx) => {
                const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;
                return `
                  <div style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 12px; padding: 10px 14px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                      <span style="font-size: 1.2rem; min-width: 28px;">${medal}</span>
                      <div>
                        <strong style="color: #FFF; font-size: 0.95rem;">${item.name}</strong>
                        <div style="font-size: 0.78rem; color: var(--text-muted);">Revenue: ₹${item.revenue.toLocaleString('en-IN')}</div>
                      </div>
                    </div>
                    <span style="font-size: 1.1rem; font-weight: 900; color: var(--accent-gold); font-family: var(--font-number);">
                      ${item.quantity} <span style="font-size: 0.75rem; font-weight: 600; color: var(--text-muted);">orders</span>
                    </span>
                  </div>
                `;
              }).join('')}
            </div>
          ` : `<div style="text-align: center; padding: 2rem; color: var(--text-muted);">No sales data available for this period.</div>`}
        </div>

        <!-- Top Extra Add-ons -->
        <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 1.5rem;">
          <h3 style="font-size: 1.1rem; font-weight: 800; color: #FFF; margin: 0 0 1rem 0; display: flex; align-items: center; justify-content: space-between;">
            <span>🥘 Popular Extra Add-ons</span>
            <span style="font-size: 0.78rem; color: var(--text-muted); font-weight: 600;">Extras Sold</span>
          </h3>

          ${popularAddonsList.length > 0 ? `
            <div style="display: flex; flex-direction: column; gap: 10px;">
              ${popularAddonsList.slice(0, 5).map((ao, idx) => `
                <div style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 12px; padding: 10px 14px;">
                  <div style="display: flex; align-items: center; gap: 12px;">
                    <span style="font-size: 1.1rem; color: var(--accent-gold); min-width: 24px;">🥘</span>
                    <div>
                      <strong style="color: #FFF; font-size: 0.95rem;">${ao.name}</strong>
                      <div style="font-size: 0.78rem; color: var(--text-muted);">Revenue: ₹${ao.revenue.toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                  <span style="font-size: 1.1rem; font-weight: 900; color: #40C4FF; font-family: var(--font-number);">
                    ${ao.quantity} <span style="font-size: 0.75rem; font-weight: 600; color: var(--text-muted);">sold</span>
                  </span>
                </div>
              `).join('')}
            </div>
          ` : `<div style="text-align: center; padding: 2rem; color: var(--text-muted);">No add-on sales data available for this period.</div>`}
        </div>

      </div>
    `;

    // 4. Hourly Demand Visual Chart
    const hourlyData = data.hourly_demand || [];
    const maxVal = Math.max(1, ...hourlyData.map(h => h.count));

    const chartHtml = `
      <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 1.5rem; margin-bottom: 1.75rem;">
        <h3 style="font-size: 1.1rem; font-weight: 800; color: #FFF; margin: 0 0 0.5rem 0; display: flex; align-items: center; gap: 8px;">
          <span>🕘</span> Hourly Order Distribution & Peak Hours
        </h3>
        <p style="font-size: 0.82rem; color: var(--text-muted); margin: 0 0 1rem 0;">
          Order frequency grouped by hour of the day (Peak: <strong style="color: var(--accent-gold);">${peak.window}</strong>).
        </p>

        <div class="bar-chart-container">
          ${hourlyData.map(h => {
            const pct = Math.round((h.count / maxVal) * 100);
            const isPeak = h.count === maxVal && maxVal > 0;
            return `
              <div class="bar-chart-col">
                <span style="font-size: 0.68rem; font-weight: 800; color: ${isPeak ? 'var(--accent-gold)' : 'var(--text-muted)'}; margin-bottom: 4px;">${h.count > 0 ? h.count : ''}</span>
                <div class="bar-chart-bar ${isPeak ? 'peak' : ''}" style="height: ${Math.max(4, pct)}%;"></div>
                <span style="font-size: 0.65rem; color: var(--text-muted); margin-top: 6px;">${h.hour}h</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    // 5. Demand Forecast & Retention Metrics
    const forecastList = data.demand_forecast || [];
    const retention = data.customer_retention || {};

    const forecastHtml = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem; margin-bottom: 1.5rem;">
        
        <!-- Tomorrow's Demand Forecast -->
        <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 1.5rem;">
          <h3 style="font-size: 1.1rem; font-weight: 800; color: #FFF; margin: 0 0 0.4rem 0; display: flex; align-items: center; gap: 8px;">
            <span>🔮</span> Tomorrow's Kitchen Demand Estimate
          </h3>
          <p style="font-size: 0.8rem; color: var(--text-muted); margin: 0 0 1rem 0;">
            Estimated portion requirements based on historical ordering velocity.
          </p>

          ${forecastList.length > 0 ? `
            <div style="display: flex; flex-direction: column; gap: 10px;">
              ${forecastList.map(f => `
                <div style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 10px; padding: 10px 14px;">
                  <div>
                    <strong style="color: #FFF; font-size: 0.92rem;">${f.name}</strong>
                    <div style="font-size: 0.75rem; color: var(--text-muted);">Daily average: ~${f.daily_average} portions</div>
                  </div>
                  <span style="font-size: 0.95rem; font-weight: 800; color: #4CAF50; background: rgba(76, 175, 80, 0.15); border: 1px solid #4CAF50; padding: 4px 10px; border-radius: 8px;">
                    ≈ ${f.estimated_range}
                  </span>
                </div>
              `).join('')}
            </div>
          ` : `<div style="text-align: center; padding: 1.5rem; color: var(--text-muted);">Forecast unavailable. Insufficient historical data.</div>`}
        </div>

        <!-- Customer Retention Insights -->
        <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 1.5rem;">
          <h3 style="font-size: 1.1rem; font-weight: 800; color: #FFF; margin: 0 0 0.4rem 0; display: flex; align-items: center; gap: 8px;">
            <span>🏆</span> Customer Retention & Loyalty
          </h3>
          <p style="font-size: 0.8rem; color: var(--text-muted); margin: 0 0 1rem 0;">
            Breakdown of new vs returning customer ordering behavior.
          </p>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
            <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 12px; padding: 1rem; text-align: center;">
              <div style="font-size: 0.78rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase;">Repeat Order Rate</div>
              <div style="font-size: 1.8rem; font-weight: 900; color: var(--accent-gold); margin: 4px 0;">${retention.repeat_order_rate_pct || 0}%</div>
              <div style="font-size: 0.74rem; color: #FFF;">${retention.repeat_customers || 0} returning customers</div>
            </div>

            <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 12px; padding: 1rem; text-align: center;">
              <div style="font-size: 0.78rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase;">Active Customers</div>
              <div style="font-size: 1.8rem; font-weight: 900; color: #40C4FF; margin: 4px 0;">${retention.active_customers || 0}</div>
              <div style="font-size: 0.74rem; color: #FFF;">Placed orders in period</div>
            </div>
          </div>
        </div>

      </div>
    `;

    container.innerHTML = kpiCardsHtml + alertsHtml + recsHtml + bestSellersHtml + chartHtml + forecastHtml;
  }

  // =========================================================================
  // 🛒 SMART CART OPTIMIZER CLIENT MODULE
  // =========================================================================

  activeSmartOffers = null;

  async fetchActiveSmartOffers() {
    if (this.activeSmartOffers) return this.activeSmartOffers;
    try {
      const res = await fetch(`${API_BASE}/smart-cart-offers`);
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        this.activeSmartOffers = json.data;
        return this.activeSmartOffers;
      }
    } catch (err) {
      console.error('Fetch active smart offers error:', err);
    }
    return [];
  }

  async evaluateSmartCartOptimizer() {
    const container = document.getElementById('smartCartOptimizerContainer');
    if (!container) return;

    if (!this.cart || this.cart.length === 0) {
      container.innerHTML = '';
      return;
    }

    const offers = await this.fetchActiveSmartOffers();
    if (!offers || offers.length === 0) {
      container.innerHTML = '';
      return;
    }

    // Evaluate each active offer against current cart
    const unlockedOffers = [];
    const pendingRecommendations = [];

    offers.forEach(offer => {
      const matchingItems = this.cart.filter(item => 
        item.name.toLowerCase().includes(offer.eligible_item_name.toLowerCase()) ||
        offer.eligible_item_name.toLowerCase().includes(item.name.toLowerCase())
      );

      const currentQty = matchingItems.reduce((sum, i) => sum + i.quantity, 0);
      const minQty = Number(offer.min_quantity || 2);
      const discAmount = Number(offer.discount_amount || 0);

      if (currentQty >= minQty) {
        unlockedOffers.push({ offer, currentQty, discAmount });
      } else {
        const neededQty = minQty - currentQty;
        let unitPrice = 20;
        if (matchingItems.length > 0) {
          unitPrice = matchingItems[0].price;
        } else {
          const menuItem = (this.menuItems || []).find(m => m.name.toLowerCase().includes(offer.eligible_item_name.toLowerCase()));
          if (menuItem) unitPrice = menuItem.price;
        }

        const neededSpend = neededQty * unitPrice;
        pendingRecommendations.push({
          offer,
          neededQty,
          neededSpend,
          discAmount,
          eligibleItemName: offer.eligible_item_name
        });
      }
    });

    let html = '';

    // Render unlocked offer banners as small compact boxes with checked checkboxes
    if (unlockedOffers.length > 0) {
      html += unlockedOffers.map(u => `
        <div class="smart-cart-card-small" style="border-color: #81C784; background: linear-gradient(135deg, rgba(76, 175, 80, 0.2), rgba(0,0,0,0.3));">
          <label class="smart-cart-checkbox-wrap">
            <input type="checkbox" class="smart-cart-checkbox" checked onchange="app.toggleSmartCartOfferCheckbox(this, '${u.offer.id}', ${u.currentQty}, '${escapeHtml(u.offer.eligible_item_name)}')">
            <div class="smart-cart-content">
              <div class="smart-cart-top-row">
                <span class="smart-cart-text" style="color: #81C784;"><i class="fa-solid fa-gift"></i> ${escapeHtml(u.offer.offer_name)} Unlocked!</span>
                <span class="smart-cart-save-pill" style="background: #4CAF50; color: #FFF; border-color: #81C784;">Saved ₹${u.discAmount}</span>
              </div>
            </div>
          </label>
        </div>
      `).join('');
    }

    // Render top 2 pending recommendations as small compact boxes with unchecked checkboxes
    if (pendingRecommendations.length > 0) {
      pendingRecommendations.sort((a, b) => (b.discAmount / Math.max(1, b.neededSpend)) - (a.discAmount / Math.max(1, a.neededSpend)));
      
      const topRecs = pendingRecommendations.slice(0, 2);
      html += topRecs.map(rec => `
        <div class="smart-cart-card-small">
          <label class="smart-cart-checkbox-wrap">
            <input type="checkbox" class="smart-cart-checkbox" onchange="app.toggleSmartCartOfferCheckbox(this, '${rec.offer.id}', ${rec.neededQty}, '${escapeHtml(rec.eligibleItemName)}')">
            <div class="smart-cart-content">
              <div class="smart-cart-top-row">
                <span class="smart-cart-text">💡 Add ${rec.neededQty} more ${escapeHtml(rec.eligibleItemName)}</span>
                <span class="smart-cart-save-pill">Save ₹${rec.discAmount}</span>
              </div>
              <div class="smart-cart-sub-text">Spend ₹${rec.neededSpend} more &rarr; Get ₹${rec.discAmount} off</div>
            </div>
          </label>
        </div>
      `).join('');

      // Track Impression
      topRecs.forEach(rec => {
        fetch(`${API_BASE}/smart-cart-analytics/track`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event_type: 'IMPRESSION', offer_id: rec.offer.id })
        }).catch(() => {});
      });
    }

    container.innerHTML = html;
  }

  async toggleSmartCartOfferCheckbox(checkboxEl, offerId, neededQty, itemName) {
    const isChecked = checkboxEl ? checkboxEl.checked : false;
    const menuItem = (this.menuItems || []).find(m => m.name.toLowerCase().includes(itemName.toLowerCase()));

    if (isChecked) {
      if (menuItem) {
        this.addToCart(menuItem, neededQty);
      } else {
        const cartItem = this.cart.find(c => c.name.toLowerCase().includes(itemName.toLowerCase()));
        if (cartItem) {
          cartItem.quantity += neededQty;
        } else {
          this.cart.push({
            id: 'item_' + Date.now(),
            name: itemName,
            price: 20,
            quantity: neededQty,
            image: '/images/idly_sambar.png'
          });
        }
        this.updateCartUI();
      }
      this.showToast(`🎉 Added ${neededQty} ${itemName}! Discount unlocked!`, 'success');

      try {
        await fetch(`${API_BASE}/smart-cart-analytics/track`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event_type: 'ACCEPTED', offer_id: offerId })
        });
      } catch (err) {}
    } else {
      const cartItem = this.cart.find(c => c.name.toLowerCase().includes(itemName.toLowerCase()));
      if (cartItem) {
        if (cartItem.quantity <= neededQty) {
          this.cart = this.cart.filter(c => c.id !== cartItem.id);
        } else {
          cartItem.quantity -= neededQty;
        }
        this.updateCartUI();
        this.showToast(`Removed ${itemName} offer from cart.`, 'info');
      }
    }
  }

  async acceptSmartCartOffer(offerId, neededQty, itemName) {
    return this.toggleSmartCartOfferCheckbox({ checked: true }, offerId, neededQty, itemName);
  }

  // Owner Smart Offers Methods
  async loadOwnerSmartOffers() {
    if (this.currentRole !== 'OWNER') return;
    const container = document.getElementById('ownerSmartOffersContainer');
    if (!container) return;

    container.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Loading Smart Offers...</div>`;

    try {
      const analyticsRes = await this.fetchWithAuth(`${API_BASE}/owner/smart-cart-offers/analytics`);
      const analyticsJson = await analyticsRes.json();
      if (analyticsJson.success && analyticsJson.data) {
        const d = analyticsJson.data;
        if (document.getElementById('lblSmartImpCount')) document.getElementById('lblSmartImpCount').innerText = d.impressions;
        if (document.getElementById('lblSmartAcceptedCount')) document.getElementById('lblSmartAcceptedCount').innerText = d.accepted;
        if (document.getElementById('lblSmartConversionRate')) document.getElementById('lblSmartConversionRate').innerText = `${d.conversion_rate_pct}%`;
        if (document.getElementById('lblSmartTotalSavings')) document.getElementById('lblSmartTotalSavings').innerText = `₹${d.total_savings}`;
      }

      const res = await this.fetchWithAuth(`${API_BASE}/owner/smart-cart-offers`);
      const json = await res.json();

      if (json.success && Array.isArray(json.data)) {
        if (json.data.length === 0) {
          container.innerHTML = `<div style="text-align: center; padding: 3rem; color: var(--text-muted); grid-column: 1/-1;">No Smart Cart Offers configured. Click "Add New Combo Offer" to create one.</div>`;
        } else {
          container.innerHTML = json.data.map(o => `
            <div style="background: var(--bg-surface-elevated); border: 1.5px solid ${o.status === 'Active' ? '#4CAF50' : 'var(--border-color)'}; border-radius: 14px; padding: 1.15rem; display: flex; flex-direction: column; justify-content: space-between;">
              <div>
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                  <h4 style="margin: 0; font-size: 1.05rem; font-weight: 800; color: #FFF;">${o.offer_name}</h4>
                  <span style="font-size: 0.72rem; font-weight: 800; padding: 2px 8px; border-radius: 10px; ${o.status === 'Active' ? 'background: rgba(76, 175, 80, 0.2); color: #4CAF50; border: 1px solid #4CAF50;' : 'background: rgba(158, 158, 158, 0.2); color: #9E9E9E; border: 1px solid #9E9E9E;'}">
                    ${o.status}
                  </span>
                </div>
                <div style="font-size: 0.88rem; color: var(--accent-gold); font-weight: 700; margin-bottom: 4px;">
                  Buy ${o.min_quantity} ${o.eligible_item_name} → Save ₹${o.discount_amount}
                </div>
                <div style="font-size: 0.78rem; color: var(--text-muted);">
                  Triggered in cart when customer orders ${o.min_quantity}+ ${o.eligible_item_name}
                </div>
              </div>
              <div style="display: flex; gap: 6px; margin-top: 1rem;">
                <button type="button" class="co-row-btn-action toggle" onclick="app.toggleOwnerSmartOffer('${o.id}', '${o.status}')" style="flex: 1; padding: 6px 10px; font-size: 0.78rem;">
                  <i class="fa-solid ${o.status === 'Active' ? 'fa-pause' : 'fa-play'}"></i> ${o.status === 'Active' ? 'Disable' : 'Enable'}
                </button>
                <button type="button" class="co-row-btn-action reject" onclick="app.deleteOwnerSmartOffer('${o.id}')" style="padding: 6px 10px; font-size: 0.78rem;">
                  <i class="fa-solid fa-trash"></i>
                </button>
              </div>
            </div>
          `).join('');
        }
      }
    } catch (err) {
      console.error('Error loading owner smart offers:', err);
    }
  }

  toggleSmartOfferModal(open = true) {
    const modal = document.getElementById('modalSmartOfferBackdrop');
    if (modal) {
      if (open) modal.classList.add('active');
      else modal.classList.remove('active');
    }
  }

  openCreateSmartOfferModal() {
    if (document.getElementById('txtSmartOfferId')) document.getElementById('txtSmartOfferId').value = '';
    if (document.getElementById('txtSmartOfferName')) document.getElementById('txtSmartOfferName').value = '';
    if (document.getElementById('txtSmartOfferItem')) document.getElementById('txtSmartOfferItem').value = '';
    if (document.getElementById('numSmartOfferMinQty')) document.getElementById('numSmartOfferMinQty').value = '2';
    if (document.getElementById('numSmartOfferDiscount')) document.getElementById('numSmartOfferDiscount').value = '10.00';
    if (document.getElementById('selSmartOfferStatus')) document.getElementById('selSmartOfferStatus').value = 'Active';

    this.toggleSmartOfferModal(true);
  }

  async saveOwnerSmartOffer(event) {
    if (event) event.preventDefault();

    const offerName = document.getElementById('txtSmartOfferName').value;
    const itemName = document.getElementById('txtSmartOfferItem').value;
    const minQty = document.getElementById('numSmartOfferMinQty').value;
    const discount = document.getElementById('numSmartOfferDiscount').value;
    const status = document.getElementById('selSmartOfferStatus').value;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/owner/smart-cart-offers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offer_name: offerName,
          eligible_item_name: itemName,
          min_quantity: minQty,
          discount_amount: discount,
          status: status
        })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast('Smart Cart Offer saved successfully!', 'success');
        this.toggleSmartOfferModal(false);
        this.activeSmartOffers = null;
        this.loadOwnerSmartOffers();
      } else {
        this.showToast(json.message || 'Failed to save offer.', 'error');
      }
    } catch (err) {
      console.error('Save offer error:', err);
    }
  }

  async toggleOwnerSmartOffer(id, currentStatus) {
    const newStatus = currentStatus === 'Active' ? 'Inactive' : 'Active';
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/owner/smart-cart-offers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(`Offer set to ${newStatus}`, 'success');
        this.activeSmartOffers = null;
        this.loadOwnerSmartOffers();
      }
    } catch (err) {
      console.error('Toggle offer error:', err);
    }
  }

  async deleteOwnerSmartOffer(id) {
    if (!confirm('Are you sure you want to delete this Smart Cart Offer?')) return;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/owner/smart-cart-offers/${id}`, {
        method: 'DELETE'
      });
      const json = await res.json();

      if (json.success) {
        this.showToast('Offer deleted', 'success');
        this.activeSmartOffers = null;
        this.loadOwnerSmartOffers();
      }
    } catch (err) {
      console.error('Delete offer error:', err);
    }
  }

  // =========================================================================
  // 🤖 AI ORDER ASSISTANT CLIENT MODULE
  // =========================================================================

  currentAiOptions = [];

  openAiAssistantModal() {
    this.toggleAiAssistantModal(true);
  }

  toggleAiAssistantModal(open = true) {
    const modal = document.getElementById('modalAiAssistant');
    if (modal) {
      if (open) modal.classList.add('active');
      else modal.classList.remove('active');
    }
  }

  setAiPrompt(text) {
    const input = document.getElementById('txtAiAssistantPrompt');
    if (input) {
      input.value = text;
      this.sendAiAssistantPrompt();
    }
  }

  async sendAiAssistantPrompt(event) {
    if (event) event.preventDefault();

    const input = document.getElementById('txtAiAssistantPrompt');
    if (!input || !input.value.trim()) return;

    const promptText = input.value.trim();
    const container = document.getElementById('aiAssistantResultsContainer');
    if (!container) return;

    container.innerHTML = `
      <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
        <i class="fa-solid fa-robot fa-spin" style="font-size: 2.5rem; color: #2196F3; margin-bottom: 1rem;"></i>
        <h3 style="color: #FFF; font-size: 1.1rem; margin-bottom: 0.5rem;">Finding the best options...</h3>
        <p style="font-size: 0.85rem;">Analyzing live menu items, prices, and quantities for your budget...</p>
      </div>
    `;

    try {
      const res = await fetch(`${API_BASE}/customer/ai-order-assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: promptText })
      });

      const json = await res.json();

      if (json.success) {
        this.currentAiOptions = json.options || [];

        let html = `
          <div style="margin-bottom: 1rem; font-size: 0.92rem; font-weight: 800; color: #FFF;">
            ${json.message}
          </div>
        `;

        if (this.currentAiOptions.length === 0) {
          html += `
            <div style="text-align: center; padding: 2rem; color: var(--text-muted); background: var(--bg-surface); border-radius: 12px; border: 1.5px dashed var(--border-color);">
              ${json.suggested_budget ? `💡 <strong>Budget Suggestion:</strong> Try increasing your budget to ₹${json.suggested_budget} for ${promptText}.` : 'No combinations match this request. Try adjusting your headcount or budget!'}
            </div>
          `;
        } else {
          html += this.currentAiOptions.map((opt, idx) => `
            <div class="ai-option-card">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                <h4 style="margin: 0; font-size: 1.05rem; font-weight: 800; color: var(--accent-gold);">${opt.title}</h4>
                <span style="font-size: 1.15rem; font-weight: 900; color: #4CAF50; font-family: var(--font-number);">₹${opt.total}</span>
              </div>
              <p style="font-size: 0.84rem; color: var(--text-muted); margin: 0 0 10px 0;">${opt.explanation}</p>
              
              <div style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; background: rgba(0,0,0,0.2); padding: 8px 12px; border-radius: 10px;">
                ${opt.items.map(item => `
                  <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.86rem; color: #FFF;">
                    <span>• ${item.name} × ${item.quantity}</span>
                    <span style="color: var(--text-muted); font-size: 0.78rem;">₹${item.price} each</span>
                  </div>
                `).join('')}
              </div>

              <button type="button" class="btn-primary-block" onclick="app.addAiOptionToCart(${idx})" style="background: linear-gradient(135deg, #2196F3, #1565C0); border: none; color: #FFF; font-weight: 800; padding: 8px 16px; font-size: 0.85rem;">
                <i class="fa-solid fa-cart-plus"></i> Add Option ${idx + 1} to Cart (₹${opt.total})
              </button>
            </div>
          `).join('');
        }

        container.innerHTML = html;
      } else {
        container.innerHTML = `
          <div style="text-align: center; padding: 2rem; color: #F44336; background: rgba(244, 67, 54, 0.1); border-radius: 12px; border: 1px solid #F44336;">
            ${json.message || 'AI Assistant is currently unavailable.'}
          </div>
        `;
      }
    } catch (err) {
      console.error('AI prompt error:', err);
      container.innerHTML = `
        <div style="text-align: center; padding: 2rem; color: #F44336; background: rgba(244, 67, 54, 0.1); border-radius: 12px; border: 1px solid #F44336;">
          Server communication error. Please try again.
        </div>
      `;
    }
  }

  addAiOptionToCart(optionIdx, replaceCart = false) {
    const opt = this.currentAiOptions[optionIdx];
    if (!opt || !Array.isArray(opt.items)) return;

    if (this.cart.length > 0 && !replaceCart && !confirm('Your cart currently contains items. Would you like to add these AI recommended items to your existing cart? (Click Cancel to replace cart)')) {
      replaceCart = true;
    }

    if (replaceCart) {
      this.cart = [];
    }

    opt.items.forEach(i => {
      const menuItem = (this.menuItems || []).find(m => m.id === i.id || m.name.toLowerCase().includes(i.name.toLowerCase()));
      if (menuItem) {
        this.addToCart(menuItem, i.quantity);
      } else {
        const existing = this.cart.find(c => c.name.toLowerCase().includes(i.name.toLowerCase()));
        if (existing) {
          existing.quantity += i.quantity;
        } else {
          this.cart.push({
            id: i.id || ('item_' + Date.now()),
            name: i.name,
            price: i.price,
            quantity: i.quantity,
            image: i.image || '/images/idly_sambar.png'
          });
        }
      }
    });

    this.updateCartUI();
    this.toggleAiAssistantModal(false);
    this.showToast(`🎉 Added ${opt.title} (₹${opt.total}) to your cart!`, 'success');
    this.toggleCartDrawer(true);
  }

  // =========================================================================
  // 🗳️ CUSTOMER MENU VOTING CLIENT MODULE
  // =========================================================================

  async loadCustomerVoting() {
    const container = document.getElementById('customerVotingPollContainer');
    if (!container) return;

    container.innerHTML = `
      <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
        <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: #9C27B0; margin-bottom: 1rem;"></i>
        <p style="font-size: 0.9rem;">Loading menu voting poll...</p>
      </div>
    `;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/menu-voting/active`);
      const json = await res.json();

      if (!json.success || !json.poll || json.poll.status !== 'ACTIVE') {
        container.innerHTML = '';
        const sec = document.getElementById('secCustomerVoting');
        if (sec) sec.classList.add('hidden');
        return;
      }

      const poll = json.poll;
      const hasVoted = json.has_voted;
      const votedOptionId = json.voted_option_id;
      const isLoggedIn = Boolean(this.currentUser);

      let html = `
        <div class="voting-poll-card">
          <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 1rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.85rem;">
            <h3 style="margin: 0; font-size: 1.2rem; font-weight: 800; color: #FFF; display: flex; align-items: center; gap: 8px;">
              <span>🗳️</span> ${poll.question || "Choose Tomorrow's Special"}
            </h3>
            <span style="font-size: 0.78rem; font-weight: 800; padding: 4px 10px; border-radius: 12px; background: ${hasVoted ? 'rgba(76,175,80,0.2); color: #4CAF50;' : 'rgba(156,39,176,0.2); color: #9C27B0;'}">
              ${hasVoted ? '✅ Voted' : '🟢 Voting is Open'}
            </span>
          </div>
      `;

      if (hasVoted) {
        const votedObj = (poll.options || []).find(o => o.id === votedOptionId);

        html += `
          <div style="background: rgba(76,175,80,0.12); border: 1.5px solid #4CAF50; border-radius: 12px; padding: 1rem; margin-bottom: 1.25rem; color: #FFF;">
            <strong style="color: #4CAF50; font-size: 0.95rem; display: flex; align-items: center; gap: 6px;">
              <i class="fa-solid fa-circle-check"></i> Vote Recorded!
            </strong>
            <p style="margin: 4px 0 0 0; font-size: 0.86rem; color: var(--text-muted);">
              You voted for <strong>${votedObj ? votedObj.food_name : 'your selected dish'}</strong>. Thank you for helping us choose tomorrow's special!
            </p>
          </div>

          <h4 style="margin: 0 0 1rem 0; font-size: 0.95rem; color: var(--accent-gold); font-weight: 800;">📊 Live Results Breakdown</h4>
        `;

        (poll.options || []).forEach(opt => {
          const isUserSelection = opt.id === votedOptionId;
          html += `
            <div style="margin-bottom: 1rem; background: ${isUserSelection ? 'rgba(156,39,176,0.15)' : 'rgba(255,255,255,0.03)'}; border: 1px solid ${isUserSelection ? '#9C27B0' : 'var(--border-color)'}; padding: 0.85rem; border-radius: 12px;">
              <div style="display: flex; justify-content: space-between; font-size: 0.88rem; font-weight: 700; color: #FFF; margin-bottom: 4px;">
                <span>${opt.food_name} (₹${opt.food_price}) ${isUserSelection ? '⭐ Your Vote' : ''}</span>
                <span style="color: var(--accent-gold);">${opt.vote_percentage}% (${opt.votes_count} votes)</span>
              </div>
              <div class="vote-progress-bar-bg">
                <div class="vote-progress-bar-fill" style="width: ${opt.vote_percentage}%;"></div>
              </div>
            </div>
          `;
        });

        html += `
          <div style="text-align: right; font-size: 0.82rem; color: var(--text-muted); margin-top: 1rem;">
            Total Votes Cast: <strong>${poll.total_votes || 0}</strong>
          </div>
        `;
      } else if (!isLoggedIn) {
        html += `
          <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 1.25rem;">
        `;

        (poll.options || []).forEach(opt => {
          html += `
            <div class="voting-option-row" onclick="app.openAuthModal('CUSTOMER', 'LOGIN')" style="cursor: pointer;">
              <img src="${opt.food_image || '/images/idly_sambar.png'}" style="width: 44px; height: 44px; border-radius: 8px; object-fit: cover;">
              <div style="flex: 1;">
                <strong style="color: #FFF; font-size: 0.95rem; display: block;">${opt.food_name}</strong>
                <span style="color: var(--text-muted); font-size: 0.8rem;">₹${opt.food_price} • ${opt.category || 'Special Dish'}</span>
              </div>
            </div>
          `;
        });

        html += `
          </div>
          <div style="text-align: center; margin-top: 1rem;">
            <p style="color: var(--text-muted); font-size: 0.88rem; margin-bottom: 0.75rem;">🔐 Please login to vote for tomorrow's special dish.</p>
            <button type="button" class="btn-primary-block" onclick="app.openAuthModal('CUSTOMER', 'LOGIN')" style="background: linear-gradient(135deg, #0088CC, #006699); border: none; color: #FFF; font-weight: 800; padding: 12px 24px; font-size: 0.95rem; border-radius: 12px; cursor: pointer;">
              <i class="fa-solid fa-lock"></i> 🔐 Login to Vote
            </button>
          </div>
        `;
      } else {
        html += `
          <p style="font-size: 0.86rem; color: var(--text-muted); margin: 0 0 1.15rem 0;">
            Select exactly one dish below and click <strong>Vote Now</strong> to cast your vote!
          </p>

          <form onsubmit="app.submitCustomerVote(event, '${poll.id}')">
            <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 1.25rem;">
        `;

        (poll.options || []).forEach(opt => {
          html += `
            <label class="voting-option-row">
              <input type="radio" name="radPollOption" value="${opt.id}" required style="accent-color: #9C27B0; transform: scale(1.2);">
              <img src="${opt.food_image || '/images/idly_sambar.png'}" style="width: 44px; height: 44px; border-radius: 8px; object-fit: cover;">
              <div style="flex: 1;">
                <strong style="color: #FFF; font-size: 0.95rem; display: block;">${opt.food_name}</strong>
                <span style="color: var(--text-muted); font-size: 0.8rem;">₹${opt.food_price} • ${opt.category || 'Special Dish'}</span>
              </div>
            </label>
          `;
        });

        html += `
            </div>
            <button type="submit" class="btn-primary-block" id="btnSubmitCustVote" style="background: linear-gradient(135deg, #9C27B0, #7B1FA2); border: none; color: #FFF; font-weight: 800; padding: 10px 20px; font-size: 0.92rem; cursor: pointer;">
              <i class="fa-solid fa-square-check"></i> 🗳️ Vote Now
            </button>
          </form>
        `;
      }

      html += `</div>`;
      container.innerHTML = html;
    } catch (err) {
      console.error('Load Customer Voting Error:', err);
      container.innerHTML = '';
      const sec = document.getElementById('secCustomerVoting');
      if (sec) sec.classList.add('hidden');
    }
  }

  initQrScannerLifecycleListeners() {
    if (this._qrLifecycleListenersBound) return;
    this._qrLifecycleListenersBound = true;

    // Handle Page Visibility Changes (Tab switch, PWA minimized, phone locked)
    document.addEventListener('visibilitychange', () => {
      const modal = document.getElementById('modalOwnerFoodMemberQrScanner');
      const isModalOpen = modal && !modal.classList.contains('hidden') && modal.classList.contains('open');

      if (document.visibilityState === 'hidden') {
        if (this.qrCameraStream || isModalOpen) {
          console.log('[QR SCANNER] App/Tab backgrounded. Safely stopping camera stream...');
          this.isCameraPausedForBackground = isModalOpen;
          this.stopQrCameraScanner();
        }
      } else if (document.visibilityState === 'visible') {
        if (this.isCameraPausedForBackground && isModalOpen) {
          console.log('[QR SCANNER] App/Tab restored. Restarting camera stream for active modal...');
          this.isCameraPausedForBackground = false;
          this.startQrCameraScanner();
        } else {
          this.isCameraPausedForBackground = false;
        }
      }
    });

    // Handle Window Unload, Page Hide, and Navigation
    window.addEventListener('pagehide', () => this.stopQrCameraScanner());
    window.addEventListener('beforeunload', () => this.stopQrCameraScanner());
    window.addEventListener('popstate', () => this.closeFoodMemberQrScannerModal());
  }

  openFoodMemberQrScannerModal() {
    console.log('[QR SCANNER] Opening food member QR scanner modal...');
    this.initQrScannerLifecycleListeners();
    const modal = document.getElementById('modalOwnerFoodMemberQrScanner');
    if (!modal) {
      console.error('[QR SCANNER] Element #modalOwnerFoodMemberQrScanner not found!');
      return;
    }
    modal.classList.remove('hidden');
    modal.classList.add('open', 'visible', 'active');
    modal.style.setProperty('display', 'flex', 'important');
    modal.style.setProperty('opacity', '1', 'important');
    modal.style.setProperty('visibility', 'visible', 'important');
    modal.style.setProperty('pointer-events', 'auto', 'important');
    modal.style.setProperty('z-index', '9999999', 'important');
    try {
      this.resetFoodMemberQrScanner();
    } catch (err) {
      console.error('[QR SCANNER] Error in resetFoodMemberQrScanner:', err);
    }
  }

  closeFoodMemberQrScannerModal() {
    console.log('[QR SCANNER] Closing food member QR scanner modal...');
    this.isCameraPausedForBackground = false;
    this.stopQrCameraScanner();
    const modal = document.getElementById('modalOwnerFoodMemberQrScanner');
    if (modal) {
      modal.classList.remove('open', 'visible', 'active');
      modal.classList.add('hidden');
      modal.style.setProperty('display', 'none', 'important');
      modal.style.setProperty('opacity', '0', 'important');
      modal.style.setProperty('visibility', 'hidden', 'important');
      modal.style.setProperty('pointer-events', 'none', 'important');
    }
  }

  resetFoodMemberQrScanner() {
    const inputView = document.getElementById('viewOwnerQrScannerInput');
    const resultView = document.getElementById('viewOwnerQrVerificationResult');
    const txtInput = document.getElementById('txtScanQrCodeInput');
    const btnScanAnother = document.getElementById('btnScanAnotherQrCard');
    const errBox = document.getElementById('boxCameraPermissionError');

    if (txtInput) txtInput.value = '';
    if (errBox) errBox.style.display = 'none';
    if (inputView) inputView.style.setProperty('display', 'block', 'important');
    if (resultView) {
      resultView.style.setProperty('display', 'none', 'important');
      resultView.innerHTML = '';
    }
    if (btnScanAnother) btnScanAnother.style.setProperty('display', 'none', 'important');
    this.startQrCameraScanner();
  }

  async startQrCameraScanner() {
    const video = document.getElementById('videoOwnerQrScan');
    const statusLbl = document.getElementById('lblQrCameraStatus');
    const errBox = document.getElementById('boxCameraPermissionError');
    const errTitle = document.getElementById('lblCameraErrorTitle');
    const errMsg = document.getElementById('lblCameraErrorMsg');

    if (!video) return;

    // Reset stream state and flag
    this.stopQrCameraScanner();
    this.isStartingQrCamera = true;

    if (errBox) errBox.style.setProperty('display', 'none', 'important');
    if (statusLbl) statusLbl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Initializing Camera...';

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.isStartingQrCamera = false;
      if (errBox) {
        errBox.style.setProperty('display', 'flex', 'important');
        if (errTitle) errTitle.textContent = 'Camera Not Supported';
        if (errMsg) errMsg.textContent = 'Camera access is not supported by this browser or connection. Please type Member ID or upload photo below.';
      }
      if (statusLbl) statusLbl.innerHTML = 'ℹ️ Camera not supported.';
      return;
    }

    let stream = null;
    let lastError = null;
    const constraintOptions = [
      { video: { facingMode: { ideal: 'environment' } } },
      { video: { facingMode: 'environment' } },
      { video: true }
    ];

    for (const constraints of constraintOptions) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (stream && stream.active && stream.getVideoTracks().length > 0) {
          break;
        }
      } catch (err) {
        lastError = err;
        console.warn('[QR SCANNER] Camera constraint attempt failed:', constraints, err.name || err);
      }
    }

    if (!stream || !stream.active || stream.getVideoTracks().length === 0) {
      this.isStartingQrCamera = false;
      if (errBox) {
        errBox.style.setProperty('display', 'flex', 'important');
        if (errTitle) errTitle.textContent = 'Camera Access Blocked / Required';
        if (errMsg) {
          if (lastError && (lastError.name === 'NotAllowedError' || lastError.name === 'PermissionDeniedError')) {
            errMsg.innerHTML = 'Camera permission is required to scan member cards.<br><br><span style="font-size:0.82rem; color:#FFD700;">💡 If blocked, tap the 🔒 lock icon in your browser URL bar, set <strong>Camera</strong> to <strong>Allow</strong>, and tap <strong>Try Again</strong>.</span>';
          } else {
            errMsg.innerHTML = 'Unable to access live camera stream. Please check your camera connection, or type Member ID below.';
          }
        }
      }
      if (statusLbl) statusLbl.innerHTML = '⚠️ Camera permission required.';
      return;
    }

      try {
        this.qrCameraStream = stream;
        video.muted = true;
        video.defaultMuted = true;
        video.playsInline = true;
        video.autoplay = true;
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        video.setAttribute('autoplay', 'true');
        video.setAttribute('muted', 'true');
        video.srcObject = stream;

        // Give browser DOM a brief tick to process video stream metadata
        await new Promise(r => setTimeout(r, 100));

        try {
          await video.play();
        } catch (playErr) {
          console.warn('[QR SCANNER] Initial video.play() notice, retrying play...', playErr);
          await new Promise(r => setTimeout(r, 250));
          await video.play().catch(e => console.warn('[QR SCANNER] Retry play notice:', e));
        }

        if (statusLbl) statusLbl.innerHTML = '<i class="fa-solid fa-camera"></i> 📷 Live Camera Active';

        if (!this.qrCanvas) {
          this.qrCanvas = document.createElement('canvas');
          this.qrCanvasCtx = this.qrCanvas.getContext('2d');
        }

        this.isScanProcessing = false;

        const scanFrame = () => {
          if (!this.qrCameraStream || video.paused || video.ended || this.isScanProcessing) return;

          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            try {
              this.qrCanvas.width = video.videoWidth;
              this.qrCanvas.height = video.videoHeight;
              this.qrCanvasCtx.drawImage(video, 0, 0, this.qrCanvas.width, this.qrCanvas.height);

              const imageData = this.qrCanvasCtx.getImageData(0, 0, this.qrCanvas.width, this.qrCanvas.height);

              // 1. Decode with jsQR library
              if (window.jsQR) {
                const code = window.jsQR(imageData.data, imageData.width, imageData.height, {
                  inversionAttempts: 'dontInvert'
                });
                if (code && code.data && code.data.trim()) {
                  this.isScanProcessing = true;
                  this.stopQrCameraScanner();
                  this.submitVerifyMemberQr(code.data.trim());
                  return;
                }
              }

              // 2. Native BarcodeDetector fallback
              if ('BarcodeDetector' in window && !this.nativeDetector) {
                try { this.nativeDetector = new BarcodeDetector({ formats: ['qr_code', 'code_128'] }); } catch (e) {}
              }
              if (this.nativeDetector && !this.isScanProcessing) {
                this.nativeDetector.detect(video).then(barcodes => {
                  if (barcodes && barcodes.length > 0 && barcodes[0].rawValue && barcodes[0].rawValue.trim() && !this.isScanProcessing) {
                    this.isScanProcessing = true;
                    this.stopQrCameraScanner();
                    this.submitVerifyMemberQr(barcodes[0].rawValue.trim());
                  }
                }).catch(() => {});
              }
            } catch (err) {}
          }

          this.qrScanAnimFrame = requestAnimationFrame(scanFrame);
        };

        this.qrScanAnimFrame = requestAnimationFrame(scanFrame);

      } catch (err) {
        console.warn('[QR SCANNER] Video setup error:', err);
      } finally {
        this.isStartingQrCamera = false;
      }
  }

  stopQrCameraScanner() {
    this.isStartingQrCamera = false;
    this.isScanProcessing = false;
    if (this.qrScanAnimFrame) {
      cancelAnimationFrame(this.qrScanAnimFrame);
      this.qrScanAnimFrame = null;
    }
    if (this.qrScanInterval) {
      clearInterval(this.qrScanInterval);
      this.qrScanInterval = null;
    }
    if (this.qrCameraStream) {
      try {
        this.qrCameraStream.getTracks().forEach(t => {
          t.stop();
          console.log('[QR SCANNER] Camera track stopped:', t.label);
        });
      } catch (e) {}
      this.qrCameraStream = null;
    }
    const video = document.getElementById('videoOwnerQrScan');
    if (video) {
      try {
        video.pause();
        video.srcObject = null;
      } catch (e) {}
    }
    const statusLbl = document.getElementById('lblQrCameraStatus');
    if (statusLbl) {
      statusLbl.innerHTML = '<i class="fa-solid fa-video-slash"></i> Camera Stopped';
    }
  }

  async handleQrPhotoUpload(event) {
    const fileInput = event.target;
    const file = fileInput ? (fileInput.files ? fileInput.files[0] : null) : null;
    if (!file) return;

    this.stopQrCameraScanner();

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = async () => {
        let extractedCode = null;

        const decodeFromCanvas = (width, height) => {
          try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(img, 0, 0, width, height);
            const imageData = ctx.getImageData(0, 0, width, height);

            if (window.jsQR) {
              let res = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
              if (res && res.data && res.data.trim()) return res.data.trim();

              res = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
              if (res && res.data && res.data.trim()) return res.data.trim();
            }
          } catch (err) {}
          return null;
        };

        // 1. Original Image Resolution
        extractedCode = decodeFromCanvas(img.width, img.height);

        // 2. Downscaled 800px max dimension (ideal sampling for high-res mobile photos/screenshots)
        if (!extractedCode && (img.width > 1000 || img.height > 1000)) {
          const maxDim = 800;
          const scale = Math.min(maxDim / img.width, maxDim / img.height);
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          extractedCode = decodeFromCanvas(w, h);
        }

        // 3. Downscaled 500px max dimension
        if (!extractedCode && (img.width > 600 || img.height > 600)) {
          const maxDim = 500;
          const scale = Math.min(maxDim / img.width, maxDim / img.height);
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          extractedCode = decodeFromCanvas(w, h);
        }

        // 4. Native BarcodeDetector API Fallback
        if (!extractedCode && 'BarcodeDetector' in window) {
          try {
            const detector = new BarcodeDetector({ formats: ['qr_code', 'code_128'] });
            const barcodes = await detector.detect(img);
            if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
              extractedCode = barcodes[0].rawValue.trim();
            }
          } catch (e) {}
        }

        // Reset file input so re-selecting same photo works
        fileInput.value = '';

        if (extractedCode) {
          console.log('[QR UPLOAD] Successfully decoded QR code:', extractedCode);
          const txtInput = document.getElementById('txtScanQrCodeInput');
          if (txtInput) txtInput.value = extractedCode;
          this.submitVerifyMemberQr(extractedCode);
        } else {
          this.showToast('Could not read QR code from photo. Please enter Member ID manually or scan directly.', 'warning');
        }
      };
      img.onerror = () => {
        fileInput.value = '';
        this.showToast('Invalid image file selected.', 'error');
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  async submitVerifyMemberQr(qrCode = null) {
    const txtInput = document.getElementById('txtScanQrCodeInput');
    const code = qrCode || (txtInput ? txtInput.value.trim() : '');

    if (!code) {
      this.showToast('Please enter or scan a Member ID or QR code.', 'warning');
      return;
    }

    this.stopQrCameraScanner();

    const btnSubmit = document.getElementById('btnSubmitVerifyMemberQr');
    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/food-member/owner/verify-qr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qr_code: code, member_id: code })
      });

      const json = await res.json();
      const inputView = document.getElementById('viewOwnerQrScannerInput');
      const resultView = document.getElementById('viewOwnerQrVerificationResult');
      const btnScanAnother = document.getElementById('btnScanAnotherQrCard');

      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> VERIFY MEMBER CARD';
      }

      if (!inputView || !resultView) return;

      inputView.style.setProperty('display', 'none', 'important');
      resultView.style.setProperty('display', 'block', 'important');
      if (btnScanAnother) btnScanAnother.style.setProperty('display', 'inline-block', 'important');

      // Member not found in database
      if (json.status_code === 'NOT_FOUND') {
        resultView.innerHTML = `
          <div style="background: rgba(255, 152, 0, 0.12); border: 2px dashed #FF9800; border-radius: 16px; padding: 22px; text-align: center; color: #FFF; margin-top: 10px;">
            <div style="font-size: 1.3rem; font-weight: 900; color: #FFB74D; margin-bottom: 10px;">
              Member Card Not Found
            </div>
            <p style="color: var(--text-muted, #AAA); font-size: 0.92rem; margin: 0; line-height: 1.5;">
              ${json.message || 'No Premium Food Member Card record found for this identifier.'}
            </p>
          </div>
        `;
        return;
      }

      // Invalid QR code or non-member QR
      if (!json.success || json.status_code === 'INVALID' || !json.member) {
        resultView.innerHTML = `
          <div style="background: rgba(255, 87, 34, 0.12); border: 2px dashed #FF5722; border-radius: 16px; padding: 22px; text-align: center; color: #FFF; margin-top: 10px;">
            <div style="font-size: 1.3rem; font-weight: 900; color: #FF7043; margin-bottom: 10px;">
              Invalid Premium Member Card
            </div>
            <p style="color: var(--text-muted, #AAA); font-size: 0.92rem; margin: 0; line-height: 1.5;">
              ${json.message || 'QR code could not be verified.'}
            </p>
          </div>
        `;
        return;
      }

      const m = json.member;
      const status_code = json.status_code;

      if (status_code === 'ACTIVE') {
        resultView.innerHTML = `
          <div style="background: rgba(76, 175, 80, 0.12); border: 2px solid #4CAF50; border-radius: 16px; padding: 22px; text-align: center; color: #FFF; margin-top: 10px;">
            <div style="font-size: 1.35rem; font-weight: 900; color: #4CAF50; margin-bottom: 6px; letter-spacing: 0.5px; display: flex; align-items: center; justify-content: center; gap: 8px;">
              <span>✓</span> PREMIUM MEMBER
            </div>
            <div style="font-size: 1.1rem; font-weight: 800; color: #81C784; margin-bottom: 16px; text-transform: uppercase;">
              ACTIVE
            </div>
            <div style="font-size: 0.95rem; line-height: 1.9; margin-bottom: 16px; color: #FFF; text-align: left; background: rgba(0,0,0,0.35); padding: 16px; border-radius: 14px; border: 1px solid rgba(76,175,80,0.3);">
              <div><strong>Member Name:</strong> ${m.customer_name}</div>
              <div><strong>Member ID:</strong> <span style="font-family: monospace; color: var(--accent-gold, #FFD700); font-weight: 800;">${m.member_id}</span></div>
              <div style="margin-top: 8px;"><strong>Valid From:</strong> ${m.valid_from}</div>
              <div><strong>Valid Until:</strong> ${m.valid_until}</div>
              <div style="margin-top: 8px; font-weight: 800; color: #FFD700;"><strong>Days Remaining:</strong> ${m.days_remaining} ${m.days_remaining === 1 ? 'day' : 'days'}</div>
            </div>
            <p style="margin: 0; font-size: 0.92rem; font-weight: 700; color: #81C784;">
              "Membership is currently active."
            </p>
          </div>
        `;
      } else if (status_code === 'EXPIRED') {
        resultView.innerHTML = `
          <div style="background: rgba(244, 67, 54, 0.12); border: 2px solid #F44336; border-radius: 16px; padding: 22px; text-align: center; color: #FFF; margin-top: 10px;">
            <div style="font-size: 1.35rem; font-weight: 900; color: #EF5350; margin-bottom: 6px; letter-spacing: 0.5px; display: flex; align-items: center; justify-content: center; gap: 8px;">
              <span>✕</span> PREMIUM MEMBER
            </div>
            <div style="font-size: 1.1rem; font-weight: 800; color: #E57373; margin-bottom: 16px; text-transform: uppercase;">
              EXPIRED
            </div>
            <div style="font-size: 0.95rem; line-height: 1.9; margin-bottom: 16px; color: #FFF; text-align: left; background: rgba(0,0,0,0.35); padding: 16px; border-radius: 14px; border: 1px solid rgba(244,67,54,0.3);">
              <div><strong>Member Name:</strong> ${m.customer_name}</div>
              <div><strong>Member ID:</strong> <span style="font-family: monospace; color: var(--accent-gold, #FFD700); font-weight: 800;">${m.member_id}</span></div>
              <div style="margin-top: 8px;"><strong>Valid From:</strong> ${m.valid_from}</div>
              <div><strong>Valid Until:</strong> ${m.valid_until}</div>
              <div style="margin-top: 8px; color: #EF5350; font-weight: 800;"><strong>Expired On:</strong> ${m.expired_on || m.valid_until}</div>
            </div>
            <p style="margin: 0; font-size: 0.92rem; font-weight: 700; color: #E57373;">
              "Membership has expired."
            </p>
          </div>
        `;
      } else if (status_code === 'NOT_YET_ACTIVE') {
        resultView.innerHTML = `
          <div style="background: rgba(255, 152, 0, 0.12); border: 2px solid #FF9800; border-radius: 16px; padding: 22px; text-align: center; color: #FFF; margin-top: 10px;">
            <div style="font-size: 1.35rem; font-weight: 900; color: #FFB74D; margin-bottom: 6px; letter-spacing: 0.5px; display: flex; align-items: center; justify-content: center; gap: 8px;">
              <span>⚠</span> PREMIUM MEMBER
            </div>
            <div style="font-size: 1.1rem; font-weight: 800; color: #FFB74D; margin-bottom: 16px; text-transform: uppercase;">
              NOT YET ACTIVE
            </div>
            <div style="font-size: 0.95rem; line-height: 1.9; margin-bottom: 16px; color: #FFF; text-align: left; background: rgba(0,0,0,0.35); padding: 16px; border-radius: 14px; border: 1px solid rgba(255,152,0,0.3);">
              <div><strong>Member Name:</strong> ${m.customer_name}</div>
              <div><strong>Member ID:</strong> <span style="font-family: monospace; color: var(--accent-gold, #FFD700); font-weight: 800;">${m.member_id}</span></div>
              <div style="margin-top: 8px;"><strong>Valid From:</strong> ${m.valid_from}</div>
              <div><strong>Valid Until:</strong> ${m.valid_until}</div>
            </div>
            <p style="margin: 0; font-size: 0.92rem; font-weight: 700; color: #FFB74D;">
              "Membership has not started yet."
            </p>
          </div>
        `;
      }
    } catch (err) {
      console.error('Verify QR error:', err);
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = '🔍 Verify';
      }
      this.showToast('Failed to verify QR code. Network error.', 'error');
    }
  }

  async submitCustomerVote(event, pollId) {
    if (event && event.preventDefault) event.preventDefault();

    if (!this.currentUser) {
      this.showToast('🔐 Login Required. Please login to your account to vote.', 'warning');
      this.openAuthModal('CUSTOMER', 'LOGIN');
      return;
    }

    const selectedRad = document.querySelector('input[name="radPollOption"]:checked');
    if (!selectedRad || !selectedRad.value) {
      this.showToast('Please select one food option before voting.', 'warning');
      return;
    }

    const option_id = selectedRad.value;
    const btn = document.getElementById('btnSubmitCustVote');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting vote...';
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/menu-voting/polls/${pollId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ option_id })
      });

      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || '🎉 Vote recorded successfully!', 'success');
        this.loadCustomerVoting();
      } else {
        this.showToast(json.message || 'Failed to submit vote.', 'error');
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-square-check"></i> 🗳️ Vote Now';
        }
      }
    } catch (err) {
      console.error('Submit vote error:', err);
      this.showToast('Network error submitting vote.', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-square-check"></i> 🗳️ Vote Now';
      }
    }
  }

  /* ============================================================
     🧺 SUBSCRIPTION MEAL PLANS + 🎫 DIGITAL MEAL PASS MODULE
     ============================================================ */

  // ------------------------------------------------------------
  // CUSTOMER MEAL PLANS GALLERY & PURCHASE FLOW
  // ------------------------------------------------------------
  async renderCustomerMealPlans() {
    const grid = document.getElementById('customerMealPlansGrid');
    if (!grid) return;

    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 30px;"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p style="margin-top: 10px;">Loading meal plans...</p></div>';

    try {
      const res = await fetch(`${API_BASE}/subscription-plans`);
      const json = await res.json();

      if (!json.success || !json.plans || json.plans.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px; background: var(--bg-surface-elevated); border-radius: 16px;"><i class="fa-solid fa-basket-shopping fa-3x" style="color: var(--border-color); margin-bottom: 12px;"></i><p>No active subscription plans available at the moment.</p></div>';
        return;
      }

      this.cachedCustomerPlans = json.plans;

      grid.innerHTML = json.plans.map(plan => `
        <div style="background: var(--bg-surface-elevated); border: 2px solid rgba(255, 152, 0, 0.3); border-radius: 20px; padding: 20px; box-shadow: 0 8px 24px rgba(0,0,0,0.15); display: flex; flex-direction: column; justify-content: space-between; position: relative; overflow: hidden;">
          <div style="position: absolute; top: 0; right: 0; background: linear-gradient(135deg, #FF9800, #F57C00); color: #FFF; font-size: 0.72rem; font-weight: 800; padding: 4px 14px; border-bottom-left-radius: 12px; text-transform: uppercase; letter-spacing: 0.5px;">
            ${escapeHtml(plan.meal_type || 'Breakfast')}
          </div>

          <div>
            <h3 style="font-size: 1.25rem; font-weight: 800; color: #FFF; margin: 0 0 10px 0;">🥣 ${escapeHtml(plan.name)}</h3>
            
            <div style="display: flex; gap: 12px; margin-bottom: 14px; flex-wrap: wrap;">
              <span style="background: rgba(255,255,255,0.08); color: var(--accent-gold); padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 0.85rem;">
                <i class="fa-solid fa-calendar-days"></i> ${plan.duration_days} Days
              </span>
              <span style="background: rgba(76, 175, 80, 0.15); color: #81C784; padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 0.85rem;">
                <i class="fa-solid fa-utensils"></i> ${plan.included_meals} Meals
              </span>
            </div>

            <p style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.5; margin-bottom: 16px;">
              ${escapeHtml(plan.description || 'Prepaid meal passes for delicious South Indian tiffins.')}
            </p>
          </div>

          <div>
            <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; border-top: 1px solid var(--border-color); padding-top: 12px;">
              <span style="font-size: 0.85rem; color: var(--text-muted);">Package Price:</span>
              <span style="font-size: 1.6rem; font-weight: 900; color: var(--accent-gold);">₹${parseFloat(plan.price).toLocaleString('en-IN')}</span>
            </div>

            <button type="button" class="btn-primary-block" onclick="app.subscribeToPlan('${plan.id}')" style="background: linear-gradient(135deg, #FF9800, #F57C00); color: #FFF; font-weight: 800;">
              <i class="fa-solid fa-bolt"></i> Subscribe Now
            </button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      console.error('Render customer meal plans error:', err);
      grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: #FF5252; padding: 30px;">Failed to load meal plans. Please try again.</div>';
    }
  }

  async subscribeToPlan(planId) {
    if (!this.currentUser) {
      this.showToast('Please login or register to subscribe to a meal plan.', 'info');
      this.openAuthModal('CUSTOMER', 'LOGIN');
      return;
    }

    try {
      let plan = (this.cachedCustomerPlans || []).find(p => String(p.id) === String(planId));
      if (!plan) {
        const res = await fetch(`${API_BASE}/subscription-plans`);
        const json = await res.json();
        plan = (json.plans || []).find(p => String(p.id) === String(planId));
      }

      if (!plan) {
        this.showToast('Selected subscription plan does not exist.', 'error');
        return;
      }

      this.selectedPlanForPurchase = plan;
      this.subScreenshotData = null;
      const modalContent = document.getElementById('subPaymentChoiceContent');
      if (!modalContent) return;

      const upiId = this.settings?.upi_id || '9392974900@ybl';
      const qrSrc = this.getQrDisplayUrl();

      modalContent.innerHTML = `
        <div style="background: rgba(0,0,0,0.2); border-radius: 16px; padding: 16px; margin-bottom: 20px; border: 1px solid var(--border-color);">
          <h4 style="font-size: 1.1rem; font-weight: 800; color: #FFF; margin: 0 0 6px 0;">🥣 ${escapeHtml(plan.name)}</h4>
          <div style="display: flex; gap: 12px; font-size: 0.82rem; color: var(--text-muted); flex-wrap: wrap;">
            <span><i class="fa-solid fa-calendar-days" style="color: var(--accent-gold);"></i> ${plan.duration_days} Days</span>
            <span><i class="fa-solid fa-utensils" style="color: #81C784;"></i> ${plan.included_meals} Meals</span>
            <span style="font-weight: 800; color: #FFF; font-size: 1rem; margin-left: auto;">₹${parseFloat(plan.price).toLocaleString('en-IN')}</span>
          </div>
        </div>

        <label style="font-weight: 700; font-size: 0.88rem; color: #FFF; margin-bottom: 10px; display: block;">Select Payment Method:</label>
        
        <div style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px;">
          <label style="background: var(--bg-surface-elevated); border: 2px solid var(--accent-gold); border-radius: 14px; padding: 14px; display: flex; align-items: center; gap: 12px; cursor: pointer; transition: border-color 0.2s;" id="lblOptPayOnline">
            <input type="radio" name="radSubPaymentMethod" value="ONLINE" checked onchange="app.toggleSubPaymentMethodUI('ONLINE')" style="accent-color: #FF9800; transform: scale(1.2);">
            <div>
              <strong style="color: #FFF; font-size: 0.95rem;">⚡ Online Payment Instant Activation</strong>
              <div style="font-size: 0.78rem; color: var(--text-muted);">Pay via UPI QR / UTR & upload proof screenshot for owner verification</div>
            </div>
          </label>

          <!-- Online Details Subpanel -->
          <div id="subOnlineDetailsBox" style="background: rgba(0,0,0,0.25); border: 1px dashed var(--accent-gold); border-radius: 14px; padding: 14px; margin-top: -4px;">
            <div style="text-align: center; margin-bottom: 14px;">
              ${qrSrc ? `
                <div style="position: relative; display: inline-block; cursor: pointer; margin-bottom: 8px;" onclick="app.viewFullScreenshot('${escapeHtml(qrSrc)}', 'UPI Payment QR Scanner')">
                  <img src="${qrSrc}" alt="UPI QR Code" style="width: 150px; height: 150px; border-radius: 12px; border: 2px solid #FFF; display: block; box-shadow: 0 4px 14px rgba(255,152,0,0.3); transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.04)'" onmouseout="this.style.transform='scale(1)'">
                  <div style="position: absolute; bottom: 6px; right: 6px; background: rgba(0,0,0,0.8); color: var(--accent-gold); border-radius: 20px; padding: 2px 8px; font-size: 0.72rem; font-weight: 800; border: 1px solid var(--accent-gold);">
                    <i class="fa-solid fa-magnifying-glass-plus"></i> Zoom
                  </div>
                </div>
                <div style="margin-bottom: 8px;">
                  <button type="button" class="btn-secondary-outline" onclick="app.viewFullScreenshot('${escapeHtml(qrSrc)}', 'UPI Payment QR Scanner')" style="padding: 4px 12px; font-size: 0.78rem; border-color: var(--accent-gold); color: var(--accent-gold); border-radius: 20px; font-weight: 700;">
                    <i class="fa-solid fa-expand"></i> 🔍 Zoom Scanner / Fullscreen
                  </button>
                </div>
              ` : ''}
              <div style="font-size: 0.85rem; color: #FFF;">UPI ID: <strong style="color: var(--accent-gold); font-family: monospace; user-select: all;">${escapeHtml(upiId)}</strong></div>
            </div>

            <div style="margin-bottom: 12px;">
              <label style="font-size: 0.8rem; color: var(--text-muted); display: block; margin-bottom: 4px;">UTR Number / Transaction ID:</label>
              <input type="text" id="txtSubUtrNumber" placeholder="e.g. 12-digit UTR No." style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); background: rgba(0,0,0,0.4); color: #FFF; font-family: monospace; font-size: 0.9rem;">
            </div>

            <div>
              <label style="font-size: 0.8rem; color: var(--text-muted); display: block; margin-bottom: 4px;">Upload Payment Screenshot (Optional/Recommended):</label>
              <input type="file" id="fileSubPaymentScreenshot" accept="image/*" onchange="app.handleSubScreenshotUpload(event)" style="width: 100%; padding: 8px; border-radius: 8px; border: 1px solid var(--border-color); background: rgba(0,0,0,0.4); color: #FFF; font-size: 0.82rem;">
              <div id="subScreenshotPreviewWrapper" class="hidden" style="margin-top: 8px; text-align: center;">
                <div style="position: relative; display: inline-block; cursor: pointer;" onclick="app.viewFullScreenshot(document.getElementById('subScreenshotPreviewImg').src, 'Payment Proof Screenshot')">
                  <img id="subScreenshotPreviewImg" src="" style="max-height: 120px; border-radius: 8px; border: 1px solid var(--accent-gold);">
                  <div style="position: absolute; bottom: 4px; right: 4px; background: rgba(0,0,0,0.8); color: #FFF; border-radius: 12px; padding: 2px 6px; font-size: 0.68rem;">
                    🔍 Click to Zoom
                  </div>
                </div>
              </div>
            </div>
          </div>

          <label style="background: var(--bg-surface-elevated); border: 2px solid var(--border-color); border-radius: 14px; padding: 14px; display: flex; align-items: center; gap: 12px; cursor: pointer; transition: border-color 0.2s;" id="lblOptPayCash">
            <input type="radio" name="radSubPaymentMethod" value="CASH" onchange="app.toggleSubPaymentMethodUI('CASH')" style="accent-color: #FF9800; transform: scale(1.2);">
            <div>
              <strong style="color: #FFF; font-size: 0.95rem;">💵 Cash Payment</strong>
              <div style="font-size: 0.78rem; color: var(--text-muted);">Subscription will be activated after owner confirms your cash payment</div>
            </div>
          </label>
        </div>

        <button type="button" id="btnSubmitSubPayment" class="btn-primary-block" onclick="app.confirmSubscriptionPurchase('${plan.id}')" style="background: linear-gradient(135deg, #FF9800, #F57C00); color: #FFF; font-weight: 800; font-size: 1rem;">
          <i class="fa-solid fa-lock"></i> Pay ₹${parseFloat(plan.price).toLocaleString('en-IN')} & Subscribe
        </button>
      `;

      this.toggleSubPaymentChoiceModal(true);
    } catch (err) {
      console.error('Subscribe to plan error:', err);
      this.showToast('Error initiating subscription. Please try again.', 'error');
    }
  }

  toggleSubPaymentMethodUI(method) {
    const box = document.getElementById('subOnlineDetailsBox');
    const lblOnline = document.getElementById('lblOptPayOnline');
    const lblCash = document.getElementById('lblOptPayCash');

    if (box) box.style.display = method === 'ONLINE' ? 'block' : 'none';
    if (lblOnline) lblOnline.style.borderColor = method === 'ONLINE' ? 'var(--accent-gold)' : 'var(--border-color)';
    if (lblCash) lblCash.style.borderColor = method === 'CASH' ? 'var(--accent-gold)' : 'var(--border-color)';
  }

  handleSubScreenshotUpload(evt) {
    const file = evt.target.files ? evt.target.files[0] : null;
    const previewWrapper = document.getElementById('subScreenshotPreviewWrapper');
    const previewImg = document.getElementById('subScreenshotPreviewImg');

    if (!file) {
      this.subScreenshotData = null;
      if (previewWrapper) previewWrapper.classList.add('hidden');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      this.subScreenshotData = e.target.result;
      if (previewImg) previewImg.src = e.target.result;
      if (previewWrapper) previewWrapper.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  }

  toggleSubPaymentChoiceModal(show) {
    const backdrop = document.getElementById('modalSubPaymentChoiceBackdrop');
    if (backdrop) {
      backdrop.classList.toggle('open', show);
      backdrop.classList.toggle('hidden', !show);
      backdrop.style.display = show ? 'flex' : 'none';
    }
  }

  async confirmSubscriptionPurchase(planId) {
    const radMethod = document.querySelector('input[name="radSubPaymentMethod"]:checked');
    const paymentMethod = radMethod ? radMethod.value : 'ONLINE';
    const utrNumber = document.getElementById('txtSubUtrNumber')?.value || '';

    const btn = document.getElementById('btnSubmitSubPayment');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/subscriptions/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_id: planId,
          payment_method: paymentMethod,
          payment_screenshot: this.subScreenshotData,
          utr_number: utrNumber
        })
      });
      const json = await res.json();

      this.toggleSubPaymentChoiceModal(false);

      if (!json.success || !json.subscription) {
        this.showToast(json.message || '❌ Subscription payment failed.', 'error');
        return;
      }

      this.subScreenshotData = null;

      if (json.subscription.status === 'ACTIVE') {
        this.showToast('🎉 Subscription activated successfully!', 'success');
      } else if (paymentMethod === 'CASH') {
        this.showToast('Cash payment selected. Your subscription will be activated after owner confirms your payment.', 'info');
      } else {
        this.showToast('🎉 Subscription payment proof submitted! Waiting for owner verification.', 'success');
      }

      this.switchView('secCustomerSubscriptions');
    } catch (err) {
      console.error('Confirm subscription purchase error:', err);
      this.showToast('Error processing subscription. Please try again.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
      }
    }
  }

  // ------------------------------------------------------------
  // CUSTOMER SUBSCRIPTIONS DASHBOARD & PASSES
  // ------------------------------------------------------------
  async renderCustomerSubscriptions() {
    const container = document.getElementById('customerSubscriptionsContainer');
    if (!container) return;

    const searchVal = (document.getElementById('txtSearchMySubscriptions')?.value || '').trim();
    const statusVal = document.getElementById('selFilterMySubStatus')?.value || 'ALL';

    container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 30px;"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p style="margin-top: 10px;">Loading your subscriptions...</p></div>';

    try {
      const queryParams = new URLSearchParams({ q: searchVal, status: statusVal });
      const res = await this.fetchWithAuth(`${API_BASE}/subscriptions/my-subscriptions?${queryParams.toString()}`);
      const json = await res.json();

      if (!json.success || !json.subscriptions || json.subscriptions.length === 0) {
        container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px; background: var(--bg-surface-elevated); border-radius: 16px;"><i class="fa-solid fa-calendar-xmark fa-3x" style="color: var(--border-color); margin-bottom: 12px;"></i><p>No subscriptions found. Browse Meal Plans to purchase a subscription!</p><button type="button" class="btn-primary-block" onclick="app.switchView(\'secCustomerMealPlans\')" style="width: auto; margin: 15px auto 0 auto;"><i class="fa-solid fa-basket-shopping"></i> Browse Meal Plans</button></div>';
        return;
      }

      container.innerHTML = json.subscriptions.map(sub => {
        const isCompleted = sub.status === 'COMPLETED' || (sub.remaining_meals <= 0 && sub.total_meals > 0) || (sub.used_meals >= sub.total_meals && sub.total_meals > 0);
        const isActive = sub.status === 'ACTIVE' && !isCompleted;
        const isPending = sub.status === 'PENDING_PAYMENT';
        const isRejected = sub.status === 'REJECTED' || sub.status === 'FAILED';
        const isExpired = sub.status === 'EXPIRED';

        let statusBadge = '';
        if (isActive) {
          statusBadge = '<span style="background: rgba(76, 175, 80, 0.15); color: #81C784; border: 1px solid #4CAF50; padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 0.8rem;"><i class="fa-solid fa-circle-check"></i> ACTIVE</span>';
        } else if (isCompleted) {
          statusBadge = '<span style="background: rgba(33, 150, 243, 0.15); color: #64B5F6; border: 1px solid #2196F3; padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 0.8rem;"><i class="fa-solid fa-circle-check"></i> COMPLETED</span>';
        } else if (isPending) {
          statusBadge = '<span style="background: rgba(255, 152, 0, 0.15); color: #FF9800; border: 1px solid #FF9800; padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 0.8rem;"><i class="fa-solid fa-hourglass-half"></i> PENDING CASH CONFIRMATION</span>';
        } else if (isRejected) {
          statusBadge = '<span style="background: rgba(255, 82, 82, 0.15); color: #FF5252; border: 1px solid #FF5252; padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 0.8rem;"><i class="fa-solid fa-xmark"></i> REJECTED</span>';
        } else {
          statusBadge = `<span style="background: rgba(255, 82, 82, 0.15); color: #FF5252; border: 1px solid #FF5252; padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 0.8rem;">${escapeHtml(sub.status)}</span>`;
        }

        const expiryFormatted = sub.expiry_date
          ? new Date(sub.expiry_date).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' })
          : 'Pending Activation';

        const startDateFormatted = sub.start_date
          ? new Date(sub.start_date).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' })
          : 'N/A';

        const cardBorder = isActive
          ? 'var(--accent-gold)'
          : (isCompleted ? '#2196F3' : (isPending ? '#FF9800' : 'var(--border-color)'));

        return `
          <div style="background: var(--bg-surface-elevated); border: 1px solid ${cardBorder}; border-radius: 20px; padding: 20px; box-shadow: 0 8px 24px rgba(0,0,0,0.15); position: relative;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
              <div>
                <h3 style="font-size: 1.15rem; font-weight: 800; color: #FFF; margin: 0 0 4px 0;">🥣 ${escapeHtml(sub.plan_name)}</h3>
                <span style="font-size: 0.78rem; color: var(--text-muted); font-family: monospace;">ID: ${escapeHtml(sub.subscription_id)}</span>
              </div>
              ${statusBadge}
            </div>

            ${isPending ? `
              <div style="background: rgba(255, 152, 0, 0.1); border: 1px solid rgba(255, 152, 0, 0.3); border-radius: 12px; padding: 12px; margin-bottom: 14px; font-size: 0.82rem; color: #FFE082;">
                <i class="fa-solid fa-circle-info"></i> Cash payment selected. Your subscription will be activated after the owner confirms your payment.
              </div>
            ` : ''}

            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; background: rgba(0,0,0,0.2); border-radius: 12px; padding: 10px; margin-bottom: 14px; text-align: center;">
              <div>
                <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase;">Total</div>
                <div style="font-size: 1.1rem; font-weight: 800; color: #FFF;">${sub.total_meals}</div>
              </div>
              <div>
                <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase;">Used</div>
                <div style="font-size: 1.1rem; font-weight: 800; color: #FF9800;">${sub.used_meals}</div>
              </div>
              <div>
                <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase;">Remaining</div>
                <div style="font-size: 1.1rem; font-weight: 800; color: ${isCompleted ? '#64B5F6' : '#4CAF50'};">${sub.remaining_meals}</div>
              </div>
            </div>

            <div style="font-size: 0.84rem; color: var(--text-muted); margin-bottom: 16px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
              <span>Valid Until: <strong style="color: #FFF;">${expiryFormatted}</strong></span>
              ${isActive ? `<span style="color: var(--accent-gold); font-weight: 700;"><i class="fa-solid fa-clock"></i> ${sub.days_remaining} Days Left</span>` : ''}
              ${isCompleted ? `<span style="color: #64B5F6; font-weight: 700;"><i class="fa-solid fa-circle-check"></i> All Meals Used</span>` : ''}
            </div>

            ${isActive ? `
              <button type="button" class="btn-primary-block" onclick="app.viewSubscriptionPasses('${sub.id}')" style="background: linear-gradient(135deg, #1A1A2E, #16213E); border: 1px solid var(--accent-gold); color: var(--accent-gold);">
                <i class="fa-solid fa-qrcode"></i> View Meal Passes (${sub.remaining_meals} Available)
              </button>
            ` : (isCompleted ? `
              <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <button type="button" class="btn-secondary-outline" onclick="app.viewSubscriptionPasses('${sub.id}')" style="flex: 1; padding: 8px; font-size: 0.8rem; border-color: #2196F3; color: #64B5F6; font-weight: 700;">
                  <i class="fa-solid fa-qrcode"></i> View Pass History
                </button>
                <button type="button" class="btn-secondary-outline" onclick="app.deleteCustomerSubscription('${sub.id}')" style="flex: 1; color: #FF5252; border: 1.5px solid #FF5252; background: rgba(255, 82, 82, 0.12); padding: 8px; font-size: 0.8rem; font-weight: 800; border-radius: 10px; cursor: pointer;">
                  <i class="fa-solid fa-trash"></i> Delete Subscription
                </button>
              </div>
            ` : `
              <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <button type="button" class="btn-secondary-outline" onclick="app.viewSubscriptionPasses('${sub.id}')" style="flex: 1; padding: 8px; font-size: 0.8rem; border-color: var(--accent-gold); color: var(--accent-gold); font-weight: 700;">
                  <i class="fa-solid fa-qrcode"></i> View Pass History (${escapeHtml(sub.status)})
                </button>
                ${(isExpired || isRejected) ? `
                  <button type="button" class="btn-secondary-outline" onclick="app.deleteCustomerSubscription('${sub.id}')" style="color: #FF5252; border: 1.5px solid #FF5252; background: rgba(255, 82, 82, 0.12); padding: 8px; font-size: 0.8rem; font-weight: 800; border-radius: 10px; cursor: pointer;">
                    <i class="fa-solid fa-trash"></i> Delete
                  </button>
                ` : ''}
              </div>
            `)}
          </div>
        `;
      }).join('');
    } catch (err) {
      console.error('Render customer subscriptions error:', err);
      container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: #FF5252; padding: 30px;">Failed to load your subscriptions.</div>';
    }
  }

  setCustomerPassTab(status) {
    this.customerMealPassTab = status;
    document.querySelectorAll('#secCustomerMealPasses .tab-pill').forEach(btn => btn.classList.remove('active'));
    const targetBtn = document.getElementById(status === 'AVAILABLE' ? 'btnPassTabAvailable' : status === 'USED' ? 'btnPassTabUsed' : 'btnPassTabExpired');
    if (targetBtn) targetBtn.classList.add('active');
    this.renderCustomerMealPasses();
  }

  viewSubscriptionPasses(subId) {
    this.filterSubIdForPasses = subId;
    this.switchView('secCustomerMealPasses');
  }

  async renderCustomerMealPasses() {
    const grid = document.getElementById('customerMealPassesGrid');
    if (!grid) return;

    const statusTab = this.customerMealPassTab || 'AVAILABLE';
    const subIdFilter = this.filterSubIdForPasses || '';

    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 30px;"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p style="margin-top: 10px;">Loading meal passes...</p></div>';

    const headerEl = document.getElementById('customerMealPassesHeader');
    if (headerEl) {
      if (statusTab === 'USED' || statusTab === 'EXPIRED') {
        headerEl.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(255, 82, 82, 0.1); border: 1.5px solid rgba(255, 82, 82, 0.4); border-radius: 14px; padding: 12px 18px; flex-wrap: wrap; gap: 10px;">
            <div>
              <h4 style="margin: 0; color: #FFF; font-size: 0.95rem; font-weight: 800;"><i class="fa-solid fa-trash-can" style="color: #FF5252;"></i> ${statusTab} Meal Passes</h4>
              <p style="margin: 2px 0 0 0; font-size: 0.8rem; color: var(--text-muted);">Manage or bulk delete your ${statusTab.toLowerCase()} meal passes history.</p>
            </div>
            <button type="button" class="btn-primary-block" onclick="app.bulkDeleteMealPasses('${statusTab}')" style="background: #FF5252; color: #FFF; padding: 8px 16px; font-size: 0.82rem; font-weight: 800; border-radius: 10px; width: auto; cursor: pointer;">
              <i class="fa-solid fa-trash-can"></i> Delete All ${statusTab} Passes
            </button>
          </div>
        `;
      } else {
        headerEl.innerHTML = '';
      }
    }

    try {
      const queryParams = new URLSearchParams({ status: statusTab });
      if (subIdFilter) queryParams.append('subscription_id', subIdFilter);

      const res = await this.fetchWithAuth(`${API_BASE}/subscriptions/my-passes?${queryParams.toString()}`);
      const json = await res.json();

      if (!json.success || !json.passes || json.passes.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px; background: var(--bg-surface-elevated); border-radius: 16px;"><i class="fa-solid fa-qrcode fa-3x" style="color: var(--border-color); margin-bottom: 12px;"></i><p>No ${statusTab.toLowerCase()} meal passes found.</p></div>`;
        return;
      }

      grid.innerHTML = json.passes.map(pass => {
        const passStatusUpper = (pass.status || '').toUpperCase();
        const isAvailable = passStatusUpper === 'AVAILABLE';
        const isUsed = passStatusUpper === 'USED';

        const redeemedFormatted = pass.redeemed_at
          ? new Date(pass.redeemed_at).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
          : 'N/A';

        return `
          <div style="background: var(--bg-surface-elevated); border: 1px solid ${isAvailable ? '#4CAF50' : 'var(--border-color)'}; border-radius: 16px; padding: 16px; box-shadow: 0 6px 18px rgba(0,0,0,0.12); text-align: center; position: relative;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <span style="font-size: 0.95rem; font-weight: 800; color: #FFF;">🎫 Pass #${pass.meal_number}</span>
              ${isAvailable
                ? '<span style="background: rgba(76, 175, 80, 0.15); color: #81C784; padding: 2px 10px; border-radius: 10px; font-weight: 700; font-size: 0.75rem;">🟢 AVAILABLE</span>'
                : (isUsed
                  ? '<span style="background: rgba(255, 152, 0, 0.15); color: #FF9800; padding: 2px 10px; border-radius: 10px; font-weight: 700; font-size: 0.75rem;">✓ USED</span>'
                  : '<span style="background: rgba(255, 82, 82, 0.15); color: #FF5252; padding: 2px 10px; border-radius: 10px; font-weight: 700; font-size: 0.75rem;">🔴 EXPIRED</span>')
              }
            </div>

            <div style="font-size: 0.85rem; color: var(--accent-gold); font-weight: 700; margin-bottom: 6px;">
              ${escapeHtml(pass.plan_name)}
            </div>
            <div style="font-size: 0.75rem; color: var(--text-muted); font-family: monospace; margin-bottom: 12px;">
              ${escapeHtml(pass.sub_formatted_id)}
            </div>

            ${isAvailable ? `
              <button type="button" class="btn-primary-block" onclick="app.showMealPassQrModal('${pass.secure_token}', ${pass.meal_number}, '${escapeHtml(pass.plan_name)}')" style="background: linear-gradient(135deg, #00E676, #00B0FF); color: #1A1A2E; font-weight: 800;">
                <i class="fa-solid fa-qrcode"></i> Show QR Code
              </button>
            ` : `
              <div style="font-size: 0.78rem; color: var(--text-muted); background: rgba(0,0,0,0.2); padding: 8px; border-radius: 8px; margin-bottom: 10px;">
                ${isUsed ? `Redeemed: <br><strong style="color: #FFF;">${redeemedFormatted}</strong>` : 'Expired'}
              </div>
              <button type="button" class="btn-secondary-outline" onclick="app.deleteMealPass('${pass.id}')" style="color: #FF5252; border: 1.5px solid #FF5252; background: rgba(255, 82, 82, 0.15); padding: 8px 12px; font-size: 0.8rem; border-radius: 10px; font-weight: 800; width: 100%; cursor: pointer;">
                <i class="fa-solid fa-trash"></i> Delete Pass
              </button>
            `}
          </div>
        `;
      }).join('');
    } catch (err) {
      console.error('Render customer meal passes error:', err);
      grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: #FF5252; padding: 30px;">Failed to load meal passes.</div>';
    }
  }

  showMealPassQrModal(secureToken, mealNumber, planName) {
    const modalContent = document.getElementById('showMealPassQrModalContent');
    if (!modalContent) return;

    const qrUrlPrimary = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(secureToken)}`;
    const qrUrlFallback = `https://chart.googleapis.com/chart?cht=qr&chs=250x250&chl=${encodeURIComponent(secureToken)}`;

    modalContent.innerHTML = `
      <div style="margin-bottom: 15px;">
        <h3 style="font-size: 1.2rem; font-weight: 800; color: #FFF; margin: 0 0 4px 0;">🎫 Meal Pass #${mealNumber}</h3>
        <p style="font-size: 0.85rem; color: var(--accent-gold); margin: 0;">${escapeHtml(planName)}</p>
      </div>

      <div style="background: #FFF; padding: 15px; border-radius: 16px; display: inline-block; box-shadow: 0 8px 24px rgba(0,0,0,0.3); margin-bottom: 12px; position: relative; cursor: pointer;" onclick="app.viewFullScreenshot('${qrUrlPrimary}', 'Meal Pass #${mealNumber} QR Code Scanner')">
        <img src="${qrUrlPrimary}" onerror="this.onerror=null; this.src='${qrUrlFallback}';" alt="Meal Pass QR Code" style="width: 220px; height: 220px; display: block; border-radius: 8px;">
        <div style="position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.8); color: var(--accent-gold); border-radius: 20px; padding: 2px 8px; font-size: 0.72rem; font-weight: 800; border: 1px solid var(--accent-gold);">
          <i class="fa-solid fa-magnifying-glass-plus"></i> Zoom
        </div>
      </div>

      <div style="margin-bottom: 15px;">
        <button type="button" class="btn-secondary-outline" onclick="app.viewFullScreenshot('${qrUrlPrimary}', 'Meal Pass #${mealNumber} QR Code Scanner')" style="padding: 6px 16px; font-size: 0.82rem; border-color: var(--accent-gold); color: var(--accent-gold); border-radius: 20px; font-weight: 700;">
          <i class="fa-solid fa-expand"></i> 🔍 Zoom Scanner / Fullscreen
        </button>
      </div>

      <div style="font-size: 0.75rem; color: var(--text-muted); font-family: monospace; word-break: break-all; margin-bottom: 15px; background: rgba(0,0,0,0.3); padding: 6px 10px; border-radius: 8px;">
        Token: ${escapeHtml(secureToken)}
      </div>

      <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 15px;">
        Show this QR code to the shop owner to collect your fresh tiffin meal. Pass can be redeemed only ONCE.
      </p>

      <button type="button" class="btn-secondary-outline" onclick="app.toggleMealPassQrModal(false)" style="width: 100%;">
        Close
      </button>
    `;

    this.toggleMealPassQrModal(true);
  }

  toggleMealPassQrModal(show = true) {
    const backdrop = document.getElementById('modalShowMealPassQrBackdrop');
    if (backdrop) {
      backdrop.classList.toggle('open', show);
      backdrop.classList.toggle('hidden', !show);
      backdrop.style.display = show ? 'flex' : 'none';
    }
  }

  // ------------------------------------------------------------
  // OWNER SUBSCRIPTION PLAN MANAGEMENT
  // ------------------------------------------------------------
  async renderOwnerSubscriptionPlans() {
    const grid = document.getElementById('ownerSubscriptionPlansGrid');
    if (!grid) return;

    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 30px;"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p style="margin-top: 10px;">Loading subscription plans...</p></div>';

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/owner/subscription-plans`);
      const json = await res.json();

      if (!json.success || !json.plans || json.plans.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px; background: var(--bg-surface-elevated); border-radius: 16px;"><i class="fa-solid fa-basket-shopping fa-3x" style="color: var(--border-color); margin-bottom: 12px;"></i><p>No subscription plans created yet. Click "Add Subscription Plan" above!</p></div>';
        return;
      }

      grid.innerHTML = json.plans.map(plan => `
        <div style="background: var(--bg-surface-elevated); border: 1px solid ${plan.is_active ? '#FF9800' : 'var(--border-color)'}; border-radius: 20px; padding: 20px; box-shadow: 0 8px 24px rgba(0,0,0,0.15); display: flex; flex-direction: column; justify-content: space-between;">
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <h3 style="font-size: 1.15rem; font-weight: 800; color: #FFF; margin: 0;">🥣 ${escapeHtml(plan.name)}</h3>
              <span style="background: ${plan.is_active ? 'rgba(76, 175, 80, 0.15)' : 'rgba(255, 82, 82, 0.15)'}; color: ${plan.is_active ? '#81C784' : '#FF5252'}; border: 1px solid ${plan.is_active ? '#4CAF50' : '#FF5252'}; padding: 2px 10px; border-radius: 10px; font-weight: 700; font-size: 0.75rem;">
                ${plan.is_active ? '🟢 ACTIVE' : '🔴 INACTIVE'}
              </span>
            </div>

            <div style="font-size: 0.85rem; color: var(--accent-gold); margin-bottom: 8px; font-weight: 700;">
              Meal Type: ${escapeHtml(plan.meal_type)}
            </div>

            <div style="display: flex; gap: 10px; margin-bottom: 12px;">
              <span style="font-size: 0.8rem; color: var(--text-muted);"><i class="fa-solid fa-calendar-days"></i> ${plan.duration_days} Days</span>
              <span style="font-size: 0.8rem; color: var(--text-muted);"><i class="fa-solid fa-utensils"></i> ${plan.included_meals} Meals</span>
            </div>

            <p style="font-size: 0.82rem; color: var(--text-muted); margin-bottom: 14px;">
              ${escapeHtml(plan.description || 'No description provided.')}
            </p>
          </div>

          <div>
            <div style="font-size: 1.4rem; font-weight: 900; color: var(--accent-gold); margin-bottom: 14px; text-align: right;">
              ₹${parseFloat(plan.price).toLocaleString('en-IN')}
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
              <button type="button" class="btn-secondary-outline" onclick="app.editOwnerSubscriptionPlan('${plan.id}', '${escapeHtml(plan.name)}', '${escapeHtml(plan.meal_type)}', ${plan.duration_days}, ${plan.included_meals}, ${plan.price}, '${escapeHtml(plan.description || '')}', ${plan.is_active})">
                <i class="fa-solid fa-pen"></i> Edit
              </button>

              <button type="button" class="btn-secondary-outline" onclick="app.toggleOwnerPlanStatus('${plan.id}', ${!plan.is_active})" style="border-color: ${plan.is_active ? '#FF5252' : '#4CAF50'}; color: ${plan.is_active ? '#FF5252' : '#81C784'};">
                <i class="fa-solid ${plan.is_active ? 'fa-ban' : 'fa-check'}"></i> ${plan.is_active ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          </div>
        </div>
      `).join('');
    } catch (err) {
      console.error('Render owner subscription plans error:', err);
      grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: #FF5252; padding: 30px; background: var(--bg-surface-elevated); border-radius: 16px; border: 1px dashed rgba(255, 82, 82, 0.4);"><i class="fa-solid fa-triangle-exclamation fa-2x" style="margin-bottom: 10px;"></i><p style="font-weight: 700; margin: 0;">Unable to load subscription plans. Please try again.</p><button type="button" class="btn-secondary-outline" onclick="app.renderOwnerSubscriptionPlans()" style="margin-top: 12px; padding: 6px 16px; font-size: 0.8rem; border-color: rgba(255,82,82,0.4); color: #FF5252;"><i class="fa-solid fa-rotate"></i> Retry</button></div>';
    }
  }

  openSubscriptionPlanModal() {
    document.getElementById('lblSubPlanModalTitle').innerHTML = '<i class="fa-solid fa-basket-shopping" style="color: #FF9800;"></i> Add Subscription Plan';
    document.getElementById('txtSubPlanId').value = '';
    document.getElementById('txtSubPlanName').value = '';
    document.getElementById('selSubPlanMealType').value = 'Breakfast';
    document.getElementById('numSubPlanDuration').value = '30';
    document.getElementById('numSubPlanMeals').value = '30';
    document.getElementById('numSubPlanPrice').value = '1499';
    document.getElementById('txtSubPlanDesc').value = '';
    document.getElementById('selSubPlanActive').value = 'true';
    this.toggleSubPlanModal(true);
  }

  editOwnerSubscriptionPlan(id, name, mealType, duration, meals, price, desc, isActive) {
    document.getElementById('lblSubPlanModalTitle').innerHTML = '<i class="fa-solid fa-pen" style="color: #FF9800;"></i> Edit Subscription Plan';
    document.getElementById('txtSubPlanId').value = id;
    document.getElementById('txtSubPlanName').value = name;
    document.getElementById('selSubPlanMealType').value = mealType || 'Breakfast';
    document.getElementById('numSubPlanDuration').value = duration;
    document.getElementById('numSubPlanMeals').value = meals;
    document.getElementById('numSubPlanPrice').value = price;
    document.getElementById('txtSubPlanDesc').value = desc || '';
    document.getElementById('selSubPlanActive').value = isActive ? 'true' : 'false';
    this.toggleSubPlanModal(true);
  }

  toggleSubPlanModal(show = true) {
    const backdrop = document.getElementById('modalSubPlanBackdrop');
    if (backdrop) backdrop.classList.toggle('open', show);
  }

  async saveOwnerSubscriptionPlan(e) {
    e.preventDefault();

    const id = document.getElementById('txtSubPlanId').value;
    const name = document.getElementById('txtSubPlanName').value;
    const meal_type = document.getElementById('selSubPlanMealType').value;
    const duration_days = document.getElementById('numSubPlanDuration').value;
    const included_meals = document.getElementById('numSubPlanMeals').value;
    const price = document.getElementById('numSubPlanPrice').value;
    const description = document.getElementById('txtSubPlanDesc').value;
    const is_active = document.getElementById('selSubPlanActive').value === 'true';

    const url = id ? `${API_BASE}/owner/subscription-plans/${id}` : `${API_BASE}/owner/subscription-plans`;
    const method = id ? 'PUT' : 'POST';

    try {
      const res = await this.fetchWithAuth(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, meal_type, duration_days, included_meals, price, description, is_active })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || 'Plan saved successfully!', 'success');
        this.toggleSubPlanModal(false);
        this.renderOwnerSubscriptionPlans();
      } else {
        this.showToast(json.message || 'Failed to save plan.', 'error');
      }
    } catch (err) {
      console.error('Save owner subscription plan error:', err);
      this.showToast('Network error saving plan.', 'error');
    }
  }

  async toggleOwnerPlanStatus(id, isActive) {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/owner/subscription-plans/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: isActive })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message, 'success');
        this.renderOwnerSubscriptionPlans();
      } else {
        this.showToast(json.message || 'Failed to toggle status.', 'error');
      }
    } catch (err) {
      console.error('Toggle plan status error:', err);
      this.showToast('Error updating plan status.', 'error');
    }
  }

  // ------------------------------------------------------------
  // OWNER CAMERA SCANNER & REDEMPTION FLOW
  // ------------------------------------------------------------
  async startMealPassScanner() {
    const video = document.getElementById('videoMealPassScan');
    const badge = document.getElementById('scannerStatusBadge');
    const btnStart = document.getElementById('btnStartPassCamera');
    const btnStop = document.getElementById('btnStopPassCamera');

    if (!video) return;
    this.stopMealPassScanner();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (badge) badge.innerHTML = '<span style="color: #FF5252;"><i class="fa-solid fa-triangle-exclamation"></i> Camera not supported or HTTPS required</span>';
      this.showToast('Camera scanning requires HTTPS or a supported browser.', 'warning');
      return;
    }

    try {
      if (badge) badge.innerHTML = '<span style="color: var(--accent-gold);"><i class="fa-solid fa-spinner fa-spin"></i> Requesting camera access...</span>';

      const constraints = [
        { video: { facingMode: { ideal: 'environment' } } },
        { video: { facingMode: 'environment' } },
        { video: true }
      ];

      let stream = null;
      for (const constraint of constraints) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraint);
          if (stream) break;
        } catch (e) {}
      }

      if (!stream) {
        throw new Error('Camera access permission denied or camera in use.');
      }

      this.mealPassCameraStream = stream;
      video.srcObject = stream;
      await video.play();

      if (badge) badge.innerHTML = '<span style="color: #00E676;"><i class="fa-solid fa-video"></i> Camera Active - Scanning...</span>';
      if (btnStart) btnStart.style.display = 'none';
      if (btnStop) btnStop.style.display = 'inline-block';

      this.isMealPassScanProcessing = false;
      this.scanMealPassLoop();
    } catch (err) {
      console.error('Start camera scanner error:', err);
      if (badge) badge.innerHTML = '<span style="color: #FF5252;"><i class="fa-solid fa-video-slash"></i> Camera permission required to scan meal pass</span>';
      if (btnStart) btnStart.style.display = 'inline-block';
      if (btnStop) btnStop.style.display = 'none';
      this.showToast('Camera permission required to scan meal pass.', 'error');
    }
  }

  stopMealPassScanner() {
    if (this.mealPassCameraStream) {
      this.mealPassCameraStream.getTracks().forEach(track => track.stop());
      this.mealPassCameraStream = null;
    }

    const video = document.getElementById('videoMealPassScan');
    if (video) {
      video.pause();
      video.srcObject = null;
    }

    const badge = document.getElementById('scannerStatusBadge');
    const btnStart = document.getElementById('btnStartPassCamera');
    const btnStop = document.getElementById('btnStopPassCamera');

    if (badge) badge.innerHTML = '<span style="color: #FFF;"><i class="fa-solid fa-video"></i> Scanner Ready</span>';
    if (btnStart) btnStart.style.display = 'inline-block';
    if (btnStop) btnStop.style.display = 'none';
  }

  scanMealPassLoop() {
    const video = document.getElementById('videoMealPassScan');
    const canvas = document.getElementById('canvasMealPassScan');

    if (!video || !this.mealPassCameraStream || video.paused || video.ended) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA && !this.isMealPassScanProcessing) {
      if (!canvas) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      if (window.jsQR) {
        const code = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
        if (code && code.data && code.data.trim()) {
          this.isMealPassScanProcessing = true;
          this.handleScannedMealPassToken(code.data.trim());
          return;
        }
      }
    }

    requestAnimationFrame(() => this.scanMealPassLoop());
  }

  manualVerifyMealPass() {
    const input = document.getElementById('txtManualPassToken');
    const token = (input?.value || '').trim();
    if (!token) {
      this.showToast('Please enter a meal pass token.', 'warning');
      return;
    }
    this.handleScannedMealPassToken(token);
  }

  async handleScannedMealPassToken(token) {
    try {
      this.showToast('Verifying scanned meal pass...', 'info');
      const res = await this.fetchWithAuth(`${API_BASE}/subscriptions/verify-pass`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });

      const json = await res.json();
      this.displayVerifyMealPassModal(json, token);
    } catch (err) {
      console.error('Verify pass error:', err);
      this.displayVerifyMealPassModal({ success: false, code: 'NETWORK_ERROR', message: 'Unable to verify meal pass. Please check your internet connection.' }, token);
    }
  }

  displayVerifyMealPassModal(res, token) {
    const modalContent = document.getElementById('verifyPassModalContent');
    if (!modalContent) return;

    if (res.success && res.verified) {
      modalContent.innerHTML = `
        <div style="background: rgba(76, 175, 80, 0.15); border: 2px solid #4CAF50; border-radius: 16px; padding: 15px; margin-bottom: 16px;">
          <h2 style="font-size: 1.3rem; font-weight: 900; color: #81C784; margin: 0 0 6px 0;">✅ MEAL PASS VERIFIED</h2>
          <span style="font-size: 0.8rem; color: #FFF; font-weight: 700;">Status: 🟢 AVAILABLE</span>
        </div>

        <div style="text-align: left; background: rgba(0,0,0,0.25); border-radius: 14px; padding: 15px; margin-bottom: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 0.88rem;">
          <div>
            <span style="color: var(--text-muted); display: block; font-size: 0.75rem;">Customer:</span>
            <strong style="color: #FFF;">${escapeHtml(res.customer_name)}</strong>
          </div>
          <div>
            <span style="color: var(--text-muted); display: block; font-size: 0.75rem;">Mobile:</span>
            <strong style="color: #FFF;">${escapeHtml(res.customer_mobile)}</strong>
          </div>
          <div>
            <span style="color: var(--text-muted); display: block; font-size: 0.75rem;">Plan:</span>
            <strong style="color: var(--accent-gold);">${escapeHtml(res.plan_name)}</strong>
          </div>
          <div>
            <span style="color: var(--text-muted); display: block; font-size: 0.75rem;">Subscription ID:</span>
            <strong style="color: #FFF; font-family: monospace;">${escapeHtml(res.subscription_id)}</strong>
          </div>
          <div>
            <span style="color: var(--text-muted); display: block; font-size: 0.75rem;">Meal Pass #:</span>
            <strong style="color: #4CAF50;">Pass #${res.meal_number}</strong>
          </div>
          <div>
            <span style="color: var(--text-muted); display: block; font-size: 0.75rem;">Remaining Meals:</span>
            <strong style="color: #40C4FF;">${res.remaining_meals} Meals</strong>
          </div>
        </div>

        <div style="display: flex; gap: 10px;">
          <button type="button" class="btn-primary-block" onclick="app.confirmRedeemMealPass('${escapeHtml(token)}')" style="background: linear-gradient(135deg, #4CAF50, #2E7D32); color: #FFF; font-weight: 800; flex: 1;">
            <i class="fa-solid fa-check-double"></i> REDEEM MEAL
          </button>
          <button type="button" class="btn-secondary-outline" onclick="app.toggleVerifyPassModal(false)" style="flex: 1;">
            Cancel
          </button>
        </div>
      `;
    } else {
      const code = res.code || 'ERROR';
      let title = '❌ INVALID MEAL PASS';
      let message = res.message || 'Invalid meal pass.';

      if (code === 'ALREADY_USED') {
        title = '❌ ALREADY USED';
        message = `This meal pass ${res.pass_number || ''} has already been redeemed on <strong>${res.redeemed_at || 'earlier date'}</strong>.<br>No second meal deduction allowed.`;
      } else if (code === 'EXPIRED') {
        title = '🔴 SUBSCRIPTION EXPIRED';
        message = 'This subscription has expired and passes cannot be redeemed.';
      } else if (code === 'NO_MEALS') {
        title = '❌ NO MEALS REMAINING';
        message = 'Zero meals remaining on this customer subscription.';
      }

      modalContent.innerHTML = `
        <div style="background: rgba(255, 82, 82, 0.15); border: 2px solid #FF5252; border-radius: 16px; padding: 15px; margin-bottom: 16px;">
          <h2 style="font-size: 1.3rem; font-weight: 900; color: #FF5252; margin: 0 0 6px 0;">${title}</h2>
          <p style="font-size: 0.88rem; color: #FFF; margin: 0;">${message}</p>
        </div>

        <button type="button" class="btn-secondary-outline" onclick="app.toggleVerifyPassModal(false)" style="width: 100%;">
          Close & Resume Scanning
        </button>
      `;
    }

    this.toggleVerifyPassModal(true);
  }

  toggleVerifyPassModal(show = true) {
    const backdrop = document.getElementById('modalVerifyMealPassBackdrop');
    if (backdrop) {
      backdrop.classList.toggle('open', show);
      backdrop.classList.toggle('hidden', !show);
      backdrop.style.display = show ? 'flex' : 'none';
    }
    if (!show) {
      this.isMealPassScanProcessing = false;
      if (this.activeView === 'secOwnerMealPassScanner' && this.mealPassCameraStream) {
        requestAnimationFrame(() => this.scanMealPassLoop());
      }
    }
  }

  async confirmRedeemMealPass(token) {
    if (!confirm('Redeem this meal pass now?')) return;

    try {
      this.showToast('Processing meal redemption...', 'info');
      const res = await this.fetchWithAuth(`${API_BASE}/subscriptions/redeem-pass`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });

      const json = await res.json();

      if (json.success && json.redemption) {
        const red = json.redemption;
        this.showToast(`✅ Meal Pass #${red.pass_number} Redeemed Successfully! Remaining: ${red.remaining_meals}`, 'success');

        const modalContent = document.getElementById('verifyPassModalContent');
        if (modalContent) {
          modalContent.innerHTML = `
            <div style="background: rgba(76, 175, 80, 0.2); border: 2px solid #4CAF50; border-radius: 16px; padding: 20px; margin-bottom: 16px;">
              <i class="fa-solid fa-circle-check fa-3x" style="color: #4CAF50; margin-bottom: 10px;"></i>
              <h2 style="font-size: 1.4rem; font-weight: 900; color: #81C784; margin: 0 0 6px 0;">MEAL REDEEMED!</h2>
              <p style="font-size: 0.9rem; color: #FFF; margin: 0;">Pass #${red.pass_number} for ${escapeHtml(red.customer_name)}</p>
              <div style="font-size: 1.1rem; font-weight: 800; color: var(--accent-gold); margin-top: 10px;">
                Remaining Meals: ${red.remaining_meals}
              </div>
            </div>

            <button type="button" class="btn-primary-block" onclick="app.toggleVerifyPassModal(false)" style="background: #4CAF50; color: #FFF;">
              Done & Scan Next
            </button>
          `;
        }
      } else {
        this.showToast(json.message || 'Redemption failed.', 'error');
        this.toggleVerifyPassModal(false);
      }
    } catch (err) {
      console.error('Redeem pass error:', err);
      this.showToast('Error redeeming meal pass.', 'error');
      this.toggleVerifyPassModal(false);
    }
  }

  // ------------------------------------------------------------
  // OWNER SUBSCRIBERS HUB (SEARCH, FILTER, SORT, PAGINATION)
  // ------------------------------------------------------------
  setOwnerSubscribersTab(tab) {
    this.ownerSubscribersTab = tab;
    document.getElementById('btnOwnerSubTabSubscribers')?.classList.toggle('active', tab === 'SUBSCRIBERS');
    document.getElementById('btnOwnerSubTabPasses')?.classList.toggle('active', tab === 'PASSES');
    document.getElementById('btnOwnerSubTabRedemptions')?.classList.toggle('active', tab === 'REDEMPTIONS');
    this.renderOwnerSubscribersHub();
  }

  triggerOwnerSubSearch() {
    this.renderOwnerSubscribersHub(1);
  }

  clearOwnerSubFilters() {
    const searchInput = document.getElementById('txtOwnerSubSearch');
    const statusSelect = document.getElementById('selOwnerSubStatusFilter');
    const expirySelect = document.getElementById('selOwnerSubExpiryFilter');
    const sortSelect = document.getElementById('selOwnerSubSort');

    if (searchInput) searchInput.value = '';
    if (statusSelect) statusSelect.value = 'ALL';
    if (expirySelect) expirySelect.value = 'ALL';
    if (sortSelect) sortSelect.value = 'newest';

    this.renderOwnerSubscribersHub(1);
  }

  async renderOwnerSubscribersHub(page = 1) {
    const container = document.getElementById('ownerSubscribersContentContainer');
    if (!container) return;

    const tab = this.ownerSubscribersTab || 'SUBSCRIBERS';
    const q = (document.getElementById('txtOwnerSubSearch')?.value || '').trim();
    const status = document.getElementById('selOwnerSubStatusFilter')?.value || 'ALL';
    const expiry = document.getElementById('selOwnerSubExpiryFilter')?.value || 'ALL';
    const sort = document.getElementById('selOwnerSubSort')?.value || 'newest';

    container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 30px;"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p style="margin-top: 10px;">Loading data...</p></div>';

    try {
      if (tab === 'SUBSCRIBERS') {
        const queryParams = new URLSearchParams({ q, status, expiry, sort, page: page.toString(), limit: '15' });
        const res = await this.fetchWithAuth(`${API_BASE}/owner/subscribers?${queryParams.toString()}`);
        const json = await res.json();

        if (!json.success || !json.subscribers || json.subscribers.length === 0) {
          container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 40px; background: var(--bg-surface-elevated); border-radius: 16px;"><i class="fa-solid fa-users-slash fa-3x" style="color: var(--border-color); margin-bottom: 12px;"></i><p>No subscribers found matching your search/filters.</p></div>';
          return;
        }

        const pagination = json.pagination || {};

        container.innerHTML = `
          <div style="overflow-x: auto; background: var(--bg-surface-elevated); border: 1px solid var(--border-color); border-radius: 16px; margin-bottom: 15px;">
            <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.85rem;">
              <thead>
                <tr style="background: rgba(0,0,0,0.3); border-bottom: 1px solid var(--border-color); color: var(--accent-gold);">
                  <th style="padding: 12px;">Customer</th>
                  <th style="padding: 12px;">Subscription ID</th>
                  <th style="padding: 12px;">Plan</th>
                  <th style="padding: 12px;">Payment Info</th>
                  <th style="padding: 12px;">Start / Expiry</th>
                  <th style="padding: 12px;">Total/Used/Remaining</th>
                  <th style="padding: 12px;">Price</th>
                  <th style="padding: 12px;">Status & Actions</th>
                </tr>
              </thead>
              <tbody>
                ${json.subscribers.map(sub => {
                  const isCompleted = sub.status === 'COMPLETED' || (sub.remaining_meals <= 0 && sub.total_meals > 0) || (sub.used_meals >= sub.total_meals && sub.total_meals > 0);
                  const isActive = sub.status === 'ACTIVE' && !isCompleted;
                  const isPending = sub.status === 'PENDING_PAYMENT';
                  const isRejected = sub.status === 'FAILED' || sub.status === 'REJECTED';
                  const expiryStr = sub.expiry_date ? new Date(sub.expiry_date).toLocaleDateString('en-IN') : 'N/A';
                  const startStr = sub.start_date ? new Date(sub.start_date).toLocaleDateString('en-IN') : 'N/A';

                  return `
                    <tr class="table-row-subscription" style="border-bottom: 1px solid rgba(255,255,255,0.08);">
                      <td style="padding: 12px;">
                        <strong style="color: #FFF;">${escapeHtml(sub.customer_name)}</strong><br>
                        <span style="font-size: 0.78rem; color: var(--text-muted);">${escapeHtml(sub.customer_mobile)}</span>
                      </td>
                      <td style="padding: 12px; font-family: monospace; color: var(--accent-gold); font-weight: 700;">
                        ${escapeHtml(sub.subscription_id)}
                      </td>
                      <td style="padding: 12px; color: #FFF; font-weight: 700;">
                        ${escapeHtml(sub.plan_name)}
                      </td>
                      <td style="padding: 12px; font-size: 0.8rem;">
                        <span style="color: #FFF; font-weight: 700;">${sub.payment_method === 'ONLINE' ? '💳 ONLINE' : '💵 CASH'}</span>
                        ${sub.utr_number ? `<br><span style="color: var(--accent-gold); font-family: monospace;">UTR: ${escapeHtml(sub.utr_number)}</span>` : ''}
                        ${sub.payment_screenshot ? `
                          <br><button type="button" class="btn-secondary-outline" onclick="app.viewFullScreenshot('${escapeHtml(sub.payment_screenshot)}', 'Payment Proof - ${escapeHtml(sub.subscription_id)}')" style="padding: 2px 8px; font-size: 0.72rem; margin-top: 4px;">
                            <i class="fa-solid fa-image"></i> View Proof
                          </button>
                        ` : ''}
                      </td>
                      <td style="padding: 12px; color: var(--text-muted); font-size: 0.8rem;">
                        ${startStr} &rarr; <strong style="color: #FFF;">${expiryStr}</strong>
                      </td>
                      <td style="padding: 12px;">
                        <span style="color: #FFF;">${sub.total_meals}</span> /
                        <span style="color: #FF9800;">${sub.used_meals}</span> /
                        <strong style="color: #4CAF50;">${sub.remaining_meals} Rem</strong>
                      </td>
                      <td style="padding: 12px; font-weight: 800; color: #FFF;">
                        ₹${parseFloat(sub.purchase_price).toLocaleString('en-IN')}
                      </td>
                      <td style="padding: 12px;">
                        <span style="background: ${isActive ? 'rgba(76, 175, 80, 0.15)' : (isCompleted ? 'rgba(33, 150, 243, 0.15)' : (isPending ? 'rgba(255, 152, 0, 0.15)' : 'rgba(255, 82, 82, 0.15)'))}; color: ${isActive ? '#81C784' : (isCompleted ? '#64B5F6' : (isPending ? '#FF9800' : '#FF5252'))}; border: 1px solid ${isActive ? '#4CAF50' : (isCompleted ? '#2196F3' : (isPending ? '#FF9800' : '#FF5252'))}; padding: 2px 8px; border-radius: 8px; font-weight: 700; font-size: 0.72rem;">
                          ${isCompleted ? 'COMPLETED' : escapeHtml(sub.status)}
                        </span>
                        ${isPending ? `
                          <div style="display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap;">
                            <button type="button" class="btn-primary-block" onclick="app.confirmOwnerSubscriptionPayment('${sub.id}')" style="padding: 4px 8px; font-size: 0.72rem; background: #4CAF50; color: #FFF; width: auto; font-weight: 800;">
                              <i class="fa-solid fa-check"></i> Verify & Activate
                            </button>
                            <button type="button" class="btn-secondary-outline" onclick="app.rejectOwnerSubscriptionPayment('${sub.id}')" style="padding: 4px 8px; font-size: 0.72rem; color: #FF5252; border-color: #FF5252; width: auto; font-weight: 700;">
                              <i class="fa-solid fa-xmark"></i> Reject Payment
                            </button>
                          </div>
                        ` : ((sub.status === 'FAILED' || sub.status === 'REJECTED' || sub.status === 'CANCELLED') ? `
                          <div style="display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap;">
                            <button type="button" class="btn-primary-block" onclick="app.confirmOwnerSubscriptionPayment('${sub.id}')" style="padding: 4px 8px; font-size: 0.72rem; background: #2196F3; color: #FFF; width: auto; font-weight: 800;" title="Re-Verify payment and activate subscription">
                              <i class="fa-solid fa-rotate-right"></i> Re-Verify & Activate
                            </button>
                            <button type="button" class="btn-secondary-outline" onclick="app.deleteOwnerSubscription('${sub.id}')" style="padding: 4px 8px; font-size: 0.72rem; color: #FF5252; border-color: #FF5252; width: auto; font-weight: 700;">
                              <i class="fa-solid fa-trash"></i> Delete
                            </button>
                          </div>
                        ` : `
                          <div style="margin-top: 6px;">
                            <button type="button" class="btn-secondary-outline" onclick="app.deleteOwnerSubscription('${sub.id}')" style="padding: 4px 8px; font-size: 0.72rem; color: #FF5252; border-color: rgba(255,82,82,0.4); width: auto; font-weight: 700;">
                              <i class="fa-solid fa-trash"></i> Delete
                            </button>
                          </div>
                        `)}
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>

          <!-- Pagination -->
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
            <span style="font-size: 0.82rem; color: var(--text-muted);">
              Showing Page ${pagination.page} of ${pagination.total_pages} (${pagination.total} records)
            </span>
            <div style="display: flex; gap: 8px;">
              <button type="button" class="btn-secondary-outline" onclick="app.renderOwnerSubscribersHub(${pagination.page - 1})" ${pagination.page <= 1 ? 'disabled' : ''} style="padding: 4px 12px; font-size: 0.8rem;">
                Previous
              </button>
              <button type="button" class="btn-secondary-outline" onclick="app.renderOwnerSubscribersHub(${pagination.page + 1})" ${pagination.page >= pagination.total_pages ? 'disabled' : ''} style="padding: 4px 12px; font-size: 0.8rem;">
                Next
              </button>
            </div>
          </div>
        `;
      } else if (tab === 'PASSES') {
        const queryParams = new URLSearchParams({ q, status, page: page.toString(), limit: '20' });
        const res = await this.fetchWithAuth(`${API_BASE}/owner/subscription-passes?${queryParams.toString()}`);
        const json = await res.json();

        if (!json.success || !json.passes || json.passes.length === 0) {
          container.innerHTML = `
            <div style="display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 10px;">
              <button type="button" class="btn-secondary-outline" onclick="app.bulkDeleteMealPasses('USED')" style="color: #FF9800; border-color: #FF9800; padding: 4px 10px; font-size: 0.78rem;">
                <i class="fa-solid fa-trash-can"></i> Delete All USED Passes
              </button>
              <button type="button" class="btn-secondary-outline" onclick="app.bulkDeleteMealPasses('EXPIRED')" style="color: #FF5252; border-color: #FF5252; padding: 4px 10px; font-size: 0.78rem;">
                <i class="fa-solid fa-trash-can"></i> Delete All EXPIRED Passes
              </button>
            </div>
            <div style="text-align: center; color: var(--text-muted); padding: 40px; background: var(--bg-surface-elevated); border-radius: 16px;"><p>No meal passes found.</p></div>
          `;
          return;
        }

        const pagination = json.pagination || {};

        container.innerHTML = `
          <div style="display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 10px;">
            <button type="button" class="btn-secondary-outline" onclick="app.bulkDeleteMealPasses('USED')" style="color: #FF9800; border-color: #FF9800; padding: 4px 10px; font-size: 0.78rem;">
              <i class="fa-solid fa-trash-can"></i> Delete All USED Passes
            </button>
            <button type="button" class="btn-secondary-outline" onclick="app.bulkDeleteMealPasses('EXPIRED')" style="color: #FF5252; border-color: #FF5252; padding: 4px 10px; font-size: 0.78rem;">
              <i class="fa-solid fa-trash-can"></i> Delete All EXPIRED Passes
            </button>
          </div>
          <div style="overflow-x: auto; background: var(--bg-surface-elevated); border: 1px solid var(--border-color); border-radius: 16px; margin-bottom: 15px;">
            <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.85rem;">
              <thead>
                <tr style="background: rgba(0,0,0,0.3); border-bottom: 1px solid var(--border-color); color: var(--accent-gold);">
                  <th style="padding: 12px;">Pass ID</th>
                  <th style="padding: 12px;">Customer</th>
                  <th style="padding: 12px;">Subscription ID</th>
                  <th style="padding: 12px;">Meal #</th>
                  <th style="padding: 12px;">Status & Actions</th>
                </tr>
              </thead>
              <tbody>
                ${json.passes.map(p => `
                  <tr class="table-row-subscription" style="border-bottom: 1px solid rgba(255,255,255,0.08);">
                    <td style="padding: 12px; font-family: monospace; color: #FFF; font-weight: 700;">${escapeHtml(p.pass_id)}</td>
                    <td style="padding: 12px;"><strong style="color: #FFF;">${escapeHtml(p.customer_name)}</strong> (${escapeHtml(p.customer_mobile)})</td>
                    <td style="padding: 12px; font-family: monospace; color: var(--accent-gold);">${escapeHtml(p.sub_formatted_id)}</td>
                    <td style="padding: 12px; color: #FFF; font-weight: 700;">Pass #${p.meal_number}</td>
                    <td style="padding: 12px;">
                      <span style="background: ${p.status === 'AVAILABLE' ? 'rgba(76, 175, 80, 0.15)' : 'rgba(255, 152, 0, 0.15)'}; color: ${p.status === 'AVAILABLE' ? '#81C784' : '#FF9800'}; padding: 2px 8px; border-radius: 8px; font-weight: 700; font-size: 0.72rem;">
                        ${escapeHtml(p.status)}
                      </span>
                      ${(p.status === 'USED' || p.status === 'EXPIRED') ? `
                        <button type="button" class="btn-secondary-outline" onclick="app.deleteMealPass('${p.id}')" style="padding: 2px 8px; font-size: 0.72rem; color: #FF5252; border-color: #FF5252; margin-left: 6px;" title="Delete Pass">
                          <i class="fa-solid fa-trash"></i> Delete
                        </button>
                      ` : ''}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
            <span style="font-size: 0.82rem; color: var(--text-muted);">Page ${pagination.page} of ${pagination.total_pages} (${pagination.total} total passes)</span>
            <div style="display: flex; gap: 8px;">
              <button type="button" class="btn-secondary-outline" onclick="app.renderOwnerSubscribersHub(${pagination.page - 1})" ${pagination.page <= 1 ? 'disabled' : ''} style="padding: 4px 12px; font-size: 0.8rem;">Previous</button>
              <button type="button" class="btn-secondary-outline" onclick="app.renderOwnerSubscribersHub(${pagination.page + 1})" ${pagination.page >= pagination.total_pages ? 'disabled' : ''} style="padding: 4px 12px; font-size: 0.8rem;">Next</button>
            </div>
          </div>
        `;
      } else if (tab === 'REDEMPTIONS') {
        const queryParams = new URLSearchParams({ q, page: page.toString(), limit: '20' });
        const res = await this.fetchWithAuth(`${API_BASE}/owner/subscription-redemptions?${queryParams.toString()}`);
        const json = await res.json();

        if (!json.success || !json.redemptions || json.redemptions.length === 0) {
          container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 40px; background: var(--bg-surface-elevated); border-radius: 16px;"><p>No redemption audit history found.</p></div>';
          return;
        }

        const pagination = json.pagination || {};

        container.innerHTML = `
          <div style="overflow-x: auto; background: var(--bg-surface-elevated); border: 1px solid var(--border-color); border-radius: 16px; margin-bottom: 15px;">
            <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.85rem;">
              <thead>
                <tr style="background: rgba(0,0,0,0.3); border-bottom: 1px solid var(--border-color); color: var(--accent-gold);">
                  <th style="padding: 12px;">Redemption Ref</th>
                  <th style="padding: 12px;">Customer</th>
                  <th style="padding: 12px;">Plan</th>
                  <th style="padding: 12px;">Meal #</th>
                  <th style="padding: 12px;">Redeemed At</th>
                  <th style="padding: 12px;">Redeemed By</th>
                </tr>
              </thead>
              <tbody>
                ${json.redemptions.map(r => {
                  const dateStr = r.redeemed_at ? new Date(r.redeemed_at).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : 'N/A';
                  return `
                    <tr class="table-row-subscription" style="border-bottom: 1px solid rgba(255,255,255,0.08);">
                      <td style="padding: 12px; font-family: monospace; color: #4CAF50; font-weight: 700;">${escapeHtml(r.redemption_reference)}</td>
                      <td style="padding: 12px;"><strong style="color: #FFF;">${escapeHtml(r.customer_name)}</strong> (${escapeHtml(r.customer_mobile)})</td>
                      <td style="padding: 12px; color: #FFF; font-weight: 700;">${escapeHtml(r.plan_name)}</td>
                      <td style="padding: 12px; color: var(--accent-gold); font-weight: 700;">Pass #${r.meal_number}</td>
                      <td style="padding: 12px; color: var(--text-muted); font-size: 0.8rem;">${dateStr}</td>
                      <td style="padding: 12px; color: #FFF;">${escapeHtml(r.redeemed_by || 'Owner')}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
            <span style="font-size: 0.82rem; color: var(--text-muted);">Page ${pagination.page} of ${pagination.total_pages} (${pagination.total} total redemptions)</span>
            <div style="display: flex; gap: 8px;">
              <button type="button" class="btn-secondary-outline" onclick="app.renderOwnerSubscribersHub(${pagination.page - 1})" ${pagination.page <= 1 ? 'disabled' : ''} style="padding: 4px 12px; font-size: 0.8rem;">Previous</button>
              <button type="button" class="btn-secondary-outline" onclick="app.renderOwnerSubscribersHub(${pagination.page + 1})" ${pagination.page >= pagination.total_pages ? 'disabled' : ''} style="padding: 4px 12px; font-size: 0.8rem;">Next</button>
            </div>
          </div>
        `;
      }
    } catch (err) {
      console.error('Render owner subscribers hub error:', err);
      container.innerHTML = '<div style="text-align: center; color: #FF5252; padding: 30px;">Failed to load data.</div>';
    }
  }

  async confirmOwnerSubscriptionPayment(subId) {
    if (!confirm('Are you sure you want to verify payment and activate this subscription?')) {
      return;
    }

    try {
      this.showToast('Verifying payment & activating subscription...', 'info');
      const res = await this.fetchWithAuth(`${API_BASE}/owner/subscriptions/${subId}/confirm-payment`, {
        method: 'POST'
      });
      const json = await res.json();

      if (json.success) {
        this.showToast('🎉 Subscription activated successfully!', 'success');
        this.renderOwnerSubscribersHub(this.ownerSubscribersPage || 1);
      } else {
        this.showToast(json.message || 'Failed to activate subscription.', 'error');
      }
    } catch (err) {
      console.error('Confirm owner subscription error:', err);
      this.showToast('Error activating subscription. Please try again.', 'error');
    }
  }

  async rejectOwnerSubscriptionPayment(subId) {
    if (!confirm('Are you sure you want to reject this subscription payment?')) {
      return;
    }

    try {
      this.showToast('Rejecting subscription payment...', 'info');
      const res = await this.fetchWithAuth(`${API_BASE}/owner/subscriptions/${subId}/reject-payment`, {
        method: 'POST'
      });
      const json = await res.json();

      if (json.success) {
        this.showToast('❌ Subscription payment failed.', 'info');
        this.renderOwnerSubscribersHub(this.ownerSubscribersPage || 1);
      } else {
        this.showToast(json.message || 'Failed to reject payment.', 'error');
      }
    } catch (err) {
      console.error('Reject owner subscription error:', err);
      this.showToast('Error rejecting subscription payment. Please try again.', 'error');
    }
  }

  confirmOwnerCashSubscription(subId) {
    return this.confirmOwnerSubscriptionPayment(subId);
  }

  rejectOwnerCashSubscription(subId) {
    return this.rejectOwnerSubscriptionPayment(subId);
  }

  async deleteOwnerSubscription(subId) {
    if (!confirm('Are you sure you want to delete this subscription record? This action cannot be undone.')) return;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/owner/subscriptions/${subId}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message || 'Subscription deleted successfully.', 'success');
        this.renderOwnerSubscribersHub(this.ownerSubscribersPage || 1);
      } else {
        this.showToast(json.message || 'Failed to delete subscription.', 'error');
      }
    } catch (err) {
      console.error('Delete owner subscription error:', err);
      this.showToast('Failed to delete subscription.', 'error');
    }
  }

  async deleteCustomerSubscription(subId) {
    if (!confirm('Are you sure you want to delete this completed subscription? This action cannot be undone.')) return;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/subscriptions/my-subscriptions/${subId}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message || 'Subscription deleted successfully.', 'success');
        this.renderCustomerSubscriptions();
      } else {
        this.showToast(json.message || 'Failed to delete subscription.', 'error');
      }
    } catch (err) {
      console.error('Delete customer subscription error:', err);
      this.showToast('Failed to delete subscription.', 'error');
    }
  }

  async deleteMealPass(passId) {
    if (!confirm('Are you sure you want to delete this meal pass record?')) return;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/subscriptions/passes/${passId}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message || 'Meal pass deleted successfully.', 'success');
        if (this.activeView === 'secCustomerMealPasses') {
          this.renderCustomerMealPasses();
        } else if (this.activeView === 'secOwnerSubscribers') {
          this.renderOwnerSubscribersHub(this.ownerSubscribersPage || 1);
        }
      } else {
        this.showToast(json.message || 'Failed to delete meal pass.', 'error');
      }
    } catch (err) {
      console.error('Delete meal pass error:', err);
      this.showToast('Failed to delete meal pass.', 'error');
    }
  }

  async bulkDeleteMealPasses(statusTab) {
    if (!confirm(`Are you sure you want to delete ALL ${statusTab} meal passes? This action cannot be undone.`)) return;
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/subscriptions/passes/bulk-delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: statusTab })
      });
      const json = await res.json();
      if (json.success) {
        this.showToast(json.message || `All ${statusTab} meal passes deleted successfully.`, 'success');
        if (this.activeView === 'secCustomerMealPasses') {
          this.renderCustomerMealPasses();
        } else if (this.activeView === 'secOwnerSubscribers') {
          this.renderOwnerSubscribersHub(this.ownerSubscribersPage || 1);
        }
      } else {
        this.showToast(json.message || 'Failed to delete meal passes.', 'error');
      }
    } catch (err) {
      console.error('Bulk delete meal passes error:', err);
      this.showToast('Failed to delete meal passes.', 'error');
    }
  }

  /* ============================================================
     📍 CUSTOMER DELIVERY ADDRESS & 🗺️ DELIVERY ZONE MANAGEMENT
     ============================================================ */

  // ------------------------------------------------------------
  // CUSTOMER ADDRESSES ENGINE
  // ------------------------------------------------------------
  async loadCustomerAddresses() {
    const grid = document.getElementById('customerAddressesGrid');
    if (!grid) return;

    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 30px;"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p style="margin-top: 10px;">Loading saved addresses...</p></div>';

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/addresses`);
      const json = await res.json();

      if (!json.success || !json.addresses || json.addresses.length === 0) {
        grid.innerHTML = `
          <div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px; background: var(--bg-surface-elevated); border-radius: 16px; border: 1px dashed var(--border-color);">
            <i class="fa-solid fa-location-dot fa-3x" style="color: #FF5722; margin-bottom: 12px;"></i>
            <h3 style="color: #FFF; font-size: 1.1rem; margin-bottom: 6px;">📍 No Saved Addresses</h3>
            <p style="font-size: 0.88rem; max-width: 400px; margin: 0 auto 16px auto;">Add an address to make delivery ordering faster and seamless.</p>
            <button type="button" class="btn-primary-block" onclick="app.openAddressModal()" style="width: auto; padding: 8px 18px; margin: 0 auto; background: linear-gradient(135deg, #FF5722, #E64A19);">
              <i class="fa-solid fa-plus"></i> Add Address
            </button>
          </div>
        `;
        return;
      }

      this.savedAddresses = json.addresses;

      grid.innerHTML = json.addresses.map(addr => {
        const isDefault = Boolean(addr.is_default);
        const icon = addr.address_type === 'Work' ? '💼' : addr.address_type === 'Other' ? '📍' : '🏠';

        return `
          <div class="address-card ${isDefault ? 'is-default' : ''}">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
              <span class="badge-address-type">
                ${icon} ${escapeHtml(addr.address_type || 'Home')}
              </span>
              ${isDefault ? `
                <span style="background: rgba(255, 87, 34, 0.15); color: #FF7043; border: 1px solid #FF5722; padding: 2px 8px; border-radius: 10px; font-weight: 800; font-size: 0.72rem;">
                  ⭐ Default Address
                </span>
              ` : ''}
            </div>

            <div style="font-weight: 800; color: #FFF; font-size: 1rem; margin-bottom: 4px;">
              ${escapeHtml(addr.full_name)}
            </div>

            <div style="font-size: 0.83rem; color: var(--accent-gold); font-weight: 700; margin-bottom: 8px;">
              <i class="fa-solid fa-phone"></i> ${escapeHtml(addr.mobile_number)}
            </div>

            <div style="font-size: 0.85rem; color: #DDD; line-height: 1.4; margin-bottom: 10px;">
              ${escapeHtml(addr.address_line1)}${addr.address_line2 ? ', ' + escapeHtml(addr.address_line2) : ''}<br>
              ${escapeHtml(addr.area)}, ${escapeHtml(addr.city)}<br>
              ${escapeHtml(addr.state)} - <strong style="color: #FFF;">${escapeHtml(addr.pincode)}</strong>
              ${addr.landmark ? `<div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 4px;"><i class="fa-solid fa-compass"></i> Landmark: "${escapeHtml(addr.landmark)}"</div>` : ''}
              ${addr.delivery_instructions ? `<div style="font-size: 0.78rem; color: #81C784; margin-top: 2px;"><i class="fa-solid fa-clipboard-list"></i> Note: "${escapeHtml(addr.delivery_instructions)}"</div>` : ''}
            </div>

            <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px;">
              <button type="button" class="btn-secondary-outline" onclick="app.openAddressModal('${addr.id}')" style="padding: 4px 12px; font-size: 0.78rem; font-weight: 700;">
                <i class="fa-solid fa-pen"></i> Edit
              </button>

              <button type="button" class="btn-secondary-outline" onclick="app.deleteCustomerAddress('${addr.id}')" style="padding: 4px 12px; font-size: 0.78rem; font-weight: 700; color: #FF5252; border-color: rgba(255, 82, 82, 0.4);">
                <i class="fa-solid fa-trash-can"></i> Delete
              </button>

              ${!isDefault ? `
                <button type="button" class="btn-secondary-outline" onclick="app.setCustomerDefaultAddress('${addr.id}')" style="padding: 4px 12px; font-size: 0.78rem; font-weight: 700; color: var(--accent-gold); border-color: rgba(255, 193, 7, 0.4); margin-left: auto;">
                  ⭐ Make Default
                </button>
              ` : ''}
            </div>
          </div>
        `;
      }).join('');
    } catch (err) {
      console.error('Load customer addresses error:', err);
      grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: #FF5252; padding: 30px;">Failed to load saved addresses.</div>';
    }
  }

  toggleAddressModal(show = true) {
    const backdrop = document.getElementById('modalAddressBackdrop');
    if (backdrop) backdrop.classList.toggle('open', show);
  }

  openAddressModal(addressId = null) {
    document.getElementById('txtAddrId').value = addressId || '';
    document.getElementById('lblAddressModalTitle').innerHTML = addressId ? `<i class="fa-solid fa-pen" style="color: #FF5722;"></i> Edit Address` : `<i class="fa-solid fa-location-dot" style="color: #FF5722;"></i> Add New Address`;

    if (addressId && this.savedAddresses) {
      const addr = this.savedAddresses.find(a => a.id === addressId);
      if (addr) {
        const typeRad = document.querySelector(`input[name="radAddrType"][value="${addr.address_type}"]`);
        if (typeRad) typeRad.checked = true;
        document.getElementById('txtAddrFullName').value = addr.full_name || '';
        document.getElementById('txtAddrMobile').value = addr.mobile_number || '';
        document.getElementById('txtAddrLine1').value = addr.address_line1 || '';
        document.getElementById('txtAddrLine2').value = addr.address_line2 || '';
        document.getElementById('txtAddrArea').value = addr.area || '';
        document.getElementById('txtAddrCity').value = addr.city || '';
        document.getElementById('txtAddrState').value = addr.state || '';
        document.getElementById('txtAddrPincode').value = addr.pincode || '';
        document.getElementById('txtAddrLandmark').value = addr.landmark || '';
        document.getElementById('txtAddrInstructions').value = addr.delivery_instructions || '';
        document.getElementById('chkAddrIsDefault').checked = Boolean(addr.is_default);
      }
    } else {
      const defaultTypeRad = document.querySelector('input[name="radAddrType"][value="Home"]');
      if (defaultTypeRad) defaultTypeRad.checked = true;
      document.getElementById('txtAddrFullName').value = this.currentUser ? this.currentUser.name || '' : '';
      document.getElementById('txtAddrMobile').value = this.currentUser ? this.currentUser.mobile || '' : '';
      document.getElementById('txtAddrLine1').value = '';
      document.getElementById('txtAddrLine2').value = '';
      document.getElementById('txtAddrArea').value = 'Nandigama';
      document.getElementById('txtAddrCity').value = 'Nandigama';
      document.getElementById('txtAddrState').value = 'Andhra Pradesh';
      document.getElementById('txtAddrPincode').value = '521185';
      document.getElementById('txtAddrLandmark').value = '';
      document.getElementById('txtAddrInstructions').value = '';
      document.getElementById('chkAddrIsDefault').checked = false;
    }

    this.toggleAddressModal(true);
  }

  async saveCustomerAddress(e) {
    if (e) e.preventDefault();

    const id = document.getElementById('txtAddrId').value.trim();
    const typeRad = document.querySelector('input[name="radAddrType"]:checked');
    const type = typeRad ? typeRad.value : 'Home';
    const fullName = document.getElementById('txtAddrFullName').value.trim();
    const mobile = document.getElementById('txtAddrMobile').value.trim();
    const line1 = document.getElementById('txtAddrLine1').value.trim();
    const line2 = document.getElementById('txtAddrLine2').value.trim();
    const area = document.getElementById('txtAddrArea').value.trim();
    const city = document.getElementById('txtAddrCity').value.trim();
    const state = document.getElementById('txtAddrState').value.trim();
    const pincode = document.getElementById('txtAddrPincode').value.trim();
    const landmark = document.getElementById('txtAddrLandmark').value.trim();
    const instructions = document.getElementById('txtAddrInstructions').value.trim();
    const isDefault = document.getElementById('chkAddrIsDefault').checked;

    if (!fullName || !mobile || !line1 || !area || !city || !state || !pincode) {
      this.showToast('Please fill all required address fields.', 'error');
      return;
    }

    const pinRegex = /^[1-9][0-9]{5}$/;
    if (!pinRegex.test(pincode)) {
      this.showToast('Please enter a valid 6-digit Indian PIN code.', 'error');
      return;
    }

    const payload = {
      address_type: type,
      full_name: fullName,
      mobile_number: mobile,
      address_line1: line1,
      address_line2: line2,
      area: area,
      city: city,
      state: state,
      pincode: pincode,
      landmark: landmark,
      delivery_instructions: instructions,
      is_default: isDefault
    };

    try {
      const url = id ? `${API_BASE}/addresses/${id}` : `${API_BASE}/addresses`;
      const method = id ? 'PUT' : 'POST';

      const res = await this.fetchWithAuth(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || 'Address saved successfully.', 'success');
        this.toggleAddressModal(false);
        this.loadCustomerAddresses();
        if (document.getElementById('ordType')?.value === 'Delivery') {
          this.loadCheckoutSavedAddresses();
        }
      } else {
        this.showToast(json.message || 'Failed to save address.', 'error');
      }
    } catch (err) {
      console.error('Save address error:', err);
      this.showToast('Network error saving address.', 'error');
    }
  }

  async deleteCustomerAddress(id) {
    if (!confirm('Are you sure you want to delete this delivery address?')) return;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/addresses/${id}`, { method: 'DELETE' });
      const json = await res.json();

      if (json.success) {
        this.showToast('Address deleted successfully.', 'success');
        this.loadCustomerAddresses();
        if (document.getElementById('ordType')?.value === 'Delivery') {
          this.loadCheckoutSavedAddresses();
        }
      } else {
        this.showToast(json.message || 'Failed to delete address.', 'error');
      }
    } catch (err) {
      console.error('Delete address error:', err);
      this.showToast('Network error deleting address.', 'error');
    }
  }

  async setCustomerDefaultAddress(id) {
    try {
      const res = await this.fetchWithAuth(`${API_BASE}/addresses/${id}/set-default`, { method: 'PATCH' });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || '⭐ Default address updated.', 'success');
        this.loadCustomerAddresses();
      } else {
        this.showToast(json.message || 'Failed to update default address.', 'error');
      }
    } catch (err) {
      console.error('Set default address error:', err);
      this.showToast('Network error setting default address.', 'error');
    }
  }

  // ------------------------------------------------------------
  // OWNER DELIVERY ZONES ENGINE
  // ------------------------------------------------------------
  async loadOwnerDeliveryZones() {
    const container = document.getElementById('ownerDeliveryZonesContainer');
    if (!container) return;

    const q = (document.getElementById('txtOwnerZoneSearch')?.value || '').trim();
    const status = document.getElementById('selOwnerZoneStatusFilter')?.value || 'ALL';

    container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 30px;"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p style="margin-top: 10px;">Loading delivery zones...</p></div>';

    try {
      const queryParams = new URLSearchParams({ q, status });
      const res = await this.fetchWithAuth(`${API_BASE}/owner/delivery-zones?${queryParams.toString()}`);
      const json = await res.json();

      if (!json.success || !json.zones || json.zones.length === 0) {
        container.innerHTML = `
          <div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px; background: var(--bg-surface-elevated); border-radius: 16px; border: 1px dashed var(--border-color);">
            <i class="fa-solid fa-map-location-dot fa-3x" style="color: #4CAF50; margin-bottom: 12px;"></i>
            <h3 style="color: #FFF; font-size: 1.1rem; margin-bottom: 6px;">🗺️ No Delivery Zones Found</h3>
            <p style="font-size: 0.88rem; max-width: 400px; margin: 0 auto 16px auto;">Create a delivery zone to enable delivery orders for specific PIN codes.</p>
            <button type="button" class="btn-primary-block" onclick="app.openDeliveryZoneModal()" style="width: auto; padding: 8px 18px; margin: 0 auto; background: linear-gradient(135deg, #4CAF50, #2E7D32);">
              <i class="fa-solid fa-plus"></i> Add Delivery Zone
            </button>
          </div>
        `;
        return;
      }

      this.ownerDeliveryZones = json.zones;

      container.innerHTML = json.zones.map(z => {
        const isActive = z.status === 'ACTIVE';
        let pinList = [];
        try {
          pinList = typeof z.pincodes === 'string' ? JSON.parse(z.pincodes) : (z.pincodes || []);
        } catch (e) {
          pinList = [];
        }

        return `
          <div class="zone-card ${isActive ? 'active-zone' : ''}">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
              <h3 style="font-size: 1.1rem; font-weight: 800; color: #FFF; margin: 0;">🗺️ ${escapeHtml(z.zone_name)}</h3>
              <span style="background: ${isActive ? 'rgba(76, 175, 80, 0.15)' : 'rgba(255, 82, 82, 0.15)'}; color: ${isActive ? '#81C784' : '#FF5252'}; border: 1px solid ${isActive ? '#4CAF50' : '#FF5252'}; padding: 2px 8px; border-radius: 10px; font-weight: 700; font-size: 0.72rem;">
                ${isActive ? '🟢 Active' : '🔴 Inactive'}
              </span>
            </div>

            ${z.description ? `<p style="font-size: 0.82rem; color: var(--text-muted); margin: 0 0 10px 0;">${escapeHtml(z.description)}</p>` : ''}

            <div style="display: flex; gap: 14px; margin-bottom: 12px; flex-wrap: wrap;">
              <div style="background: rgba(255,255,255,0.06); padding: 8px 12px; border-radius: 12px;">
                <span style="font-size: 0.74rem; color: var(--text-muted); display: block;">Delivery Fee</span>
                <strong style="font-size: 1.05rem; color: var(--accent-gold);">₹${parseFloat(z.delivery_fee).toFixed(0)}</strong>
              </div>

              <div style="background: rgba(255,255,255,0.06); padding: 8px 12px; border-radius: 12px;">
                <span style="font-size: 0.74rem; color: var(--text-muted); display: block;">Min Order</span>
                <strong style="font-size: 1.05rem; color: #FFF;">₹${parseFloat(z.min_order_amount || 0).toFixed(0)}</strong>
              </div>
            </div>

            <div style="margin-bottom: 14px;">
              <span style="font-size: 0.78rem; color: var(--text-muted); display: block; margin-bottom: 4px; font-weight: 700;">Assigned PIN Codes:</span>
              <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                ${pinList.map(p => `<span class="pincode-tag"><i class="fa-solid fa-location-pin"></i> ${escapeHtml(p)}</span>`).join('')}
              </div>
            </div>

            <div style="display: flex; gap: 8px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px; flex-wrap: wrap;">
              <button type="button" class="btn-secondary-outline" onclick="app.openDeliveryZoneModal('${z.id}')" style="padding: 5px 12px; font-size: 0.78rem; font-weight: 700;">
                <i class="fa-solid fa-pen"></i> Edit
              </button>

              <button type="button" class="btn-secondary-outline" onclick="app.toggleOwnerZoneStatus('${z.id}', '${z.status}')" style="padding: 5px 12px; font-size: 0.78rem; font-weight: 700; color: ${isActive ? '#FFB74D' : '#81C784'}; border-color: ${isActive ? 'rgba(255, 183, 77, 0.4)' : 'rgba(129, 199, 132, 0.4)'};">
                ${isActive ? '🔴 Deactivate' : '🟢 Activate'}
              </button>

              <button type="button" class="btn-secondary-outline" onclick="app.deleteOwnerDeliveryZone('${z.id}')" style="padding: 5px 12px; font-size: 0.78rem; font-weight: 700; color: #FF5252; border-color: rgba(255, 82, 82, 0.4); margin-left: auto;">
                <i class="fa-solid fa-trash-can"></i> Delete
              </button>
            </div>
          </div>
        `;
      }).join('');
    } catch (err) {
      console.error('Load owner delivery zones error:', err);
      container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: #FF5252; padding: 30px; background: var(--bg-surface-elevated); border-radius: 16px; border: 1px dashed rgba(255, 82, 82, 0.4);"><i class="fa-solid fa-triangle-exclamation fa-2x" style="margin-bottom: 10px;"></i><p style="font-weight: 700; margin: 0;">Unable to load delivery zones. Please try again.</p><button type="button" class="btn-secondary-outline" onclick="app.loadOwnerDeliveryZones()" style="margin-top: 12px; padding: 6px 16px; font-size: 0.8rem; border-color: rgba(255,82,82,0.4); color: #FF5252;"><i class="fa-solid fa-rotate"></i> Retry</button></div>';
    }
  }

  toggleDeliveryZoneModal(show = true) {
    const backdrop = document.getElementById('modalDeliveryZoneBackdrop');
    if (backdrop) backdrop.classList.toggle('open', show);
  }

  openDeliveryZoneModal(zoneId = null) {
    document.getElementById('txtZoneId').value = zoneId || '';
    document.getElementById('lblZoneModalTitle').innerHTML = zoneId ? `<i class="fa-solid fa-pen" style="color: #4CAF50;"></i> Edit Delivery Zone` : `<i class="fa-solid fa-map-location-dot" style="color: #4CAF50;"></i> Add Delivery Zone`;

    if (zoneId && this.ownerDeliveryZones) {
      const z = this.ownerDeliveryZones.find(x => x.id === zoneId);
      if (z) {
        let pinList = [];
        try {
          pinList = typeof z.pincodes === 'string' ? JSON.parse(z.pincodes) : (z.pincodes || []);
        } catch (e) {
          pinList = [];
        }
        document.getElementById('txtZoneName').value = z.zone_name || '';
        document.getElementById('txtZonePincodes').value = pinList.join(', ');
        document.getElementById('numZoneFee').value = z.delivery_fee || 0;
        document.getElementById('numZoneMinOrder').value = z.min_order_amount || 0;
        document.getElementById('txtZoneDesc').value = z.description || '';
        document.getElementById('selZoneStatus').value = z.status || 'ACTIVE';
      }
    } else {
      document.getElementById('txtZoneName').value = '';
      document.getElementById('txtZonePincodes').value = '521185, 521186';
      document.getElementById('numZoneFee').value = 20;
      document.getElementById('numZoneMinOrder').value = 100;
      document.getElementById('txtZoneDesc').value = '';
      document.getElementById('selZoneStatus').value = 'ACTIVE';
    }

    this.toggleDeliveryZoneModal(true);
  }

  async saveOwnerDeliveryZone(e) {
    if (e) e.preventDefault();

    const id = document.getElementById('txtZoneId').value.trim();
    const zoneName = document.getElementById('txtZoneName').value.trim();
    const pincodesStr = document.getElementById('txtZonePincodes').value.trim();
    const fee = parseFloat(document.getElementById('numZoneFee').value || '0') || 0;
    const minOrder = parseFloat(document.getElementById('numZoneMinOrder').value || '0') || 0;
    const desc = document.getElementById('txtZoneDesc').value.trim();
    const status = document.getElementById('selZoneStatus').value;

    if (!zoneName || !pincodesStr) {
      this.showToast('Zone Name and PIN codes are required.', 'error');
      return;
    }

    const rawPins = pincodesStr.split(',').map(s => s.trim());
    const validPins = rawPins.filter(p => /^[1-9][0-9]{5}$/.test(p));

    if (validPins.length === 0) {
      this.showToast('Please enter at least one valid 6-digit Indian PIN code.', 'error');
      return;
    }

    const payload = {
      zone_name: zoneName,
      pincodes: validPins,
      delivery_fee: fee,
      min_order_amount: minOrder,
      description: desc,
      status: status
    };

    try {
      const url = id ? `${API_BASE}/owner/delivery-zones/${id}` : `${API_BASE}/owner/delivery-zones`;
      const method = id ? 'PUT' : 'POST';

      const res = await this.fetchWithAuth(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || 'Delivery zone saved successfully.', 'success');
        this.toggleDeliveryZoneModal(false);
        this.loadOwnerDeliveryZones();
      } else {
        this.showToast(json.message || 'Failed to save delivery zone.', 'error');
      }
    } catch (err) {
      console.error('Save delivery zone error:', err);
      this.showToast('Network error saving delivery zone.', 'error');
    }
  }

  async toggleOwnerZoneStatus(id, currentStatus) {
    const newStatus = currentStatus === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/owner/delivery-zones/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      const json = await res.json();

      if (json.success) {
        this.showToast(json.message || 'Status updated.', 'success');
        this.loadOwnerDeliveryZones();
      } else {
        this.showToast(json.message || 'Failed to update zone status.', 'error');
      }
    } catch (err) {
      console.error('Toggle zone status error:', err);
      this.showToast('Network error updating zone status.', 'error');
    }
  }

  async deleteOwnerDeliveryZone(id) {
    if (!confirm('Are you sure you want to delete this delivery zone?')) return;

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/owner/delivery-zones/${id}`, { method: 'DELETE' });
      const json = await res.json();

      if (json.success) {
        this.showToast('Delivery zone deleted.', 'success');
        this.loadOwnerDeliveryZones();
      } else {
        this.showToast(json.message || 'Failed to delete delivery zone.', 'error');
      }
    } catch (err) {
      console.error('Delete delivery zone error:', err);
      this.showToast('Network error deleting delivery zone.', 'error');
    }
  }

  // ------------------------------------------------------------
  // CHECKOUT SAVED ADDRESS SELECTOR INTEGRATION
  // ------------------------------------------------------------
  async loadCheckoutSavedAddresses() {
    const container = document.getElementById('savedAddressesCheckoutContainer');
    if (!container) return;

    if (!this.currentUser) {
      container.innerHTML = '';
      return;
    }

    try {
      const res = await this.fetchWithAuth(`${API_BASE}/addresses`);
      const json = await res.json();
      const savedAddresses = (json.success && Array.isArray(json.addresses)) ? json.addresses : [];

      this.checkoutSavedAddresses = [...savedAddresses];

      // Check for default saved address (Priority 2)
      const defaultAddr = savedAddresses.find(a => a.is_default);

      // Check for Profile Delivery Address (Priority 3 fallback)
      const profileAddrStr = (this.currentUser && this.currentUser.address) ? this.currentUser.address.trim() : '';

      let profileVirtualAddr = null;
      if (profileAddrStr) {
        const pinMatch = profileAddrStr.match(/\b\d{6}\b/);
        profileVirtualAddr = {
          id: 'profile_address',
          address_type: 'Profile Address',
          full_name: this.currentUser.name || 'Customer',
          mobile_number: this.currentUser.mobile || '',
          address_line1: profileAddrStr,
          area: '',
          city: '',
          state: '',
          pincode: pinMatch ? pinMatch[0] : '',
          is_profile_fallback: true
        };
        // Add virtual profile address object into list for lookup
        this.checkoutSavedAddresses.push(profileVirtualAddr);
      }

      // Determine initial selection according to strict priority rules:
      // 1. Explicitly selected address ID (if already chosen)
      // 2. Default saved address (is_default: true)
      // 3. Profile Delivery Address (if no default address exists)
      // 4. Saved non-default address (if no profile address)
      // 5. No address exists anywhere
      let initialSelectedId = null;

      if (this.selectedDeliveryAddressId && this.checkoutSavedAddresses.some(a => a.id === this.selectedDeliveryAddressId)) {
        initialSelectedId = this.selectedDeliveryAddressId;
      } else if (defaultAddr) {
        initialSelectedId = defaultAddr.id;
      } else if (profileVirtualAddr) {
        initialSelectedId = 'profile_address';
      } else if (savedAddresses.length > 0) {
        initialSelectedId = savedAddresses[0].id;
      }

      if (!initialSelectedId) {
        // Priority 4: No address exists anywhere!
        this.selectedDeliveryAddressId = null;
        container.innerHTML = `
          <div style="background: rgba(255,87,34,0.08); border: 1.5px dashed var(--accent-orange, #FF5722); border-radius: 12px; padding: 12px 14px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <span style="font-size: 0.85rem; color: #FFD54F; font-weight: 700;">
                <i class="fa-solid fa-triangle-exclamation" style="color: #FF7043;"></i> Please add a delivery address before placing your order.
              </span>
              <button type="button" class="btn-secondary-outline" onclick="app.openAddressModal()" style="padding: 4px 12px; font-size: 0.78rem; border-color: #FF7043; color: #FFF;">
                <i class="fa-solid fa-plus"></i> Add Address
              </button>
            </div>
          </div>
        `;
        const inputAddr = document.getElementById('ordDeliveryAddress');
        if (inputAddr) inputAddr.value = '';
        return;
      }

      this.selectedDeliveryAddressId = initialSelectedId;

      // Render options list including saved addresses and profile fallback (if present)
      let displayOptions = [...savedAddresses];
      if (profileVirtualAddr) {
        displayOptions.push(profileVirtualAddr);
      }

      container.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${displayOptions.map(a => {
            const isChecked = a.id === initialSelectedId;
            const isProfile = a.id === 'profile_address';
            const icon = isProfile ? '📍' : (a.address_type === 'Work' ? '💼' : a.address_type === 'Other' ? '📍' : '🏠');
            const labelTitle = isProfile
              ? `Profile Delivery Address (Fallback)`
              : `${escapeHtml(a.address_type || 'Home')} - ${escapeHtml(a.full_name)}`;
            const labelSub = isProfile
              ? escapeHtml(a.address_line1)
              : `${escapeHtml(a.address_line1)}, ${escapeHtml(a.area || '')}, ${escapeHtml(a.city || '')} - <strong>${escapeHtml(a.pincode || '')}</strong>`;
            
            return `
              <label style="display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; background: ${isChecked ? 'rgba(255, 87, 34, 0.12)' : 'rgba(255,255,255,0.04)'}; border: 1.5px solid ${isChecked ? '#FF5722' : 'var(--border-color)'}; border-radius: 12px; cursor: pointer; transition: all 0.15s ease;">
                <input type="radio" name="radCheckoutAddress" value="${a.id}" ${isChecked ? 'checked' : ''} onchange="app.selectCheckoutAddress('${a.id}')" style="margin-top: 3px;">
                <div style="flex: 1; font-size: 0.82rem;">
                  <div style="font-weight: 800; color: #FFF; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                    <span>${icon} ${labelTitle}</span>
                    ${a.is_default ? `<span style="font-size: 0.7rem; color: #FF7043; background: rgba(255, 112, 67, 0.15); padding: 1px 6px; border-radius: 6px;">⭐ Default</span>` : ''}
                    ${isProfile ? `<span style="font-size: 0.7rem; color: #FFD54F; background: rgba(255, 213, 79, 0.15); padding: 1px 6px; border-radius: 6px;">Source: Profile Delivery Address</span>` : ''}
                  </div>
                  <div style="color: #DDD; margin-top: 2px;">
                    ${labelSub}
                  </div>
                </div>
              </label>
            `;
          }).join('')}
          <div style="display: flex; justify-content: flex-end; margin-top: 4px;">
            <button type="button" class="btn-secondary-outline" onclick="app.openAddressModal()" style="padding: 4px 12px; font-size: 0.78rem; color: #FF7043; border-color: rgba(255, 87, 34, 0.4);">
              <i class="fa-solid fa-plus"></i> Add New Address
            </button>
          </div>
        </div>
      `;

      this.selectCheckoutAddress(initialSelectedId);
    } catch (err) {
      console.error('Load checkout saved addresses error:', err);
    }
  }

  async selectCheckoutAddress(addressId) {
    this.selectedDeliveryAddressId = addressId;
    if (!this.checkoutSavedAddresses) return;

    const addr = this.checkoutSavedAddresses.find(a => a.id === addressId);
    if (!addr) return;

    const inputAddr = document.getElementById('ordDeliveryAddress');
    if (inputAddr) {
      if (addr.id === 'profile_address') {
        inputAddr.value = `${addr.full_name} (${addr.mobile_number}), ${addr.address_line1}`;
      } else {
        inputAddr.value = `${addr.full_name} (${addr.mobile_number}), ${addr.address_line1}${addr.address_line2 ? ', ' + addr.address_line2 : ''}, ${addr.area || ''}, ${addr.city || ''}, ${addr.state || ''} - ${addr.pincode || ''}${addr.landmark ? ' (Landmark: ' + addr.landmark + ')' : ''}`;
      }
    }

    try {
      const res = await fetch(`${API_BASE}/delivery-zones/check-pincode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address_id: addressId, pincode: addr.pincode || '' })
      });
      const json = await res.json();

      const btnSubmit = document.getElementById('btnCheckoutSubmit');

      if (json.success && json.available && json.zone) {
        this.selectedDeliveryZone = json.zone;
        this.currentDeliveryFee = Number(json.delivery_fee || 0);
        this.showToast(`🗺️ Delivery Zone: ${json.zone.zone_name} (Fee: ₹${json.delivery_fee})`, 'info');
        if (btnSubmit) btnSubmit.disabled = false;
      } else {
        this.selectedDeliveryZone = null;
        this.currentDeliveryFee = 0;
        this.showToast(json.message || '🚫 Delivery unavailable at this location.', 'error');
      }

      if (typeof this.updateCheckoutTotalDisplay === 'function') {
        this.updateCheckoutTotalDisplay();
      }
    } catch (err) {
      console.error('Pincode check error:', err);
    }
  }
}

// Instantiate global app engine
const app = new TiffinApp();
window.app = app;

document.addEventListener('DOMContentLoaded', () => {
  app.init();
});
