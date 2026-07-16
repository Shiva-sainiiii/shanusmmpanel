// =====================================================================
// script.js — Panel Frontend Engine
// =====================================================================

// ---------------------------------------------------------------------
// 1. Service Catalog (client-side source of truth for UI metadata)
//    NOTE: service IDs here must also exist in api/api.js's
//    ALLOWED_SERVICE_IDS allow-list, or orders will be rejected
//    server-side (by design — defense in depth).
// ---------------------------------------------------------------------
const SERVICE_CATALOG = {
    "10216": {
        label: "Instagram Followers [Guaranteed]",
        rate: 0.36,       // price per 1000
        min: 100,
        max: 50000,
        speed: "~6-12 hours start, ~1-3 days completion",
    },
    "8646": {
        label: "Instagram Likes [Low Cost]",
        rate: 0.12,
        min: 50,
        max: 20000,
        speed: "~0-1 hour start, few hours completion",
    },
    "10442": {
        label: "Instagram Followers [Premium / HQ]",
        rate: 1.10,
        min: 100,
        max: 100000,
        speed: "~1-2 hours start, 1-2 days completion",
    },
    "7973": {
        label: "Instagram Reel Views",
        rate: 0.02,
        min: 100,
        max: 1000000,
        speed: "Instant start, ~1 hour completion",
    },
    "9424": {
        label: "Instagram Video Views",
        rate: 0.015,
        min: 100,
        max: 1000000,
        speed: "Instant start, ~1 hour completion",
    },
    "10018": {
        label: "TikTok Followers",
        rate: 0.85,
        min: 100,
        max: 30000,
        speed: "~1-3 hours start, 1-2 days completion",
    },
};

// ---------------------------------------------------------------------
// 2. LocalStorage Order Log
// ---------------------------------------------------------------------
const ORDERS_KEY = "smm_orders_v1";
const MAX_STORED_ORDERS = 100;

function loadOrders() {
    try {
        const raw = localStorage.getItem(ORDERS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveOrders(orders) {
    try {
        localStorage.setItem(ORDERS_KEY, JSON.stringify(orders.slice(0, MAX_STORED_ORDERS)));
    } catch (err) {
        console.error("LocalStorage write failed:", err);
    }
}

function addOrderToLog({ orderId, link, quantity, serviceId }) {
    const orders = loadOrders();
    orders.unshift({
        order_id: orderId,
        service_id: serviceId,
        service_label: SERVICE_CATALOG[serviceId]?.label || "Unknown",
        link,
        quantity,
        timestamp: new Date().toISOString(),
        status: "Submitted",
        remains: null,
    });
    saveOrders(orders);
    return orders;
}

function updateOrderStatus(orderId, statusPatch) {
    const orders = loadOrders();
    const idx = orders.findIndex((o) => String(o.order_id) === String(orderId));
    if (idx !== -1) {
        orders[idx] = { ...orders[idx], ...statusPatch };
        saveOrders(orders);
    }
    return orders;
}

// ---------------------------------------------------------------------
// 3. DOM wiring
// ---------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
    const orderForm = document.getElementById("order-form");
    const submitBtn = document.getElementById("submit-btn");
    const serviceSelect = document.getElementById("service-id");
    const quantityInput = document.getElementById("quantity");
    const linkInput = document.getElementById("target-link");
    const passwordInput = document.getElementById("admin-password");

    const metaBox = document.getElementById("service-meta");
    const metaSpeed = document.getElementById("meta-speed");
    const metaMin = document.getElementById("meta-min");
    const metaPrice = document.getElementById("meta-price");

    const balanceValueEl = document.getElementById("balance-value");
    const balanceStatusEl = document.getElementById("balance-status");
    const refreshBalanceBtn = document.getElementById("refresh-balance-btn");

    const ordersTableBody = document.getElementById("orders-table-body");
    const ordersEmptyState = document.getElementById("orders-empty-state");

    // -------------------------------------------------------------
    // Populate the service dropdown from SERVICE_CATALOG
    // -------------------------------------------------------------
    function renderServiceOptions() {
        serviceSelect.innerHTML = "";
        Object.entries(SERVICE_CATALOG).forEach(([id, meta], index) => {
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = `ID: ${id} | ${meta.label} (~$${meta.rate.toFixed(2)}/1000)`;
            if (index === 0) opt.selected = true;
            serviceSelect.appendChild(opt);
        });
    }

    // -------------------------------------------------------------
    // Dynamic metadata box: speed, min limit, live estimated price
    // -------------------------------------------------------------
    function renderServiceMeta() {
        const serviceId = serviceSelect.value;
        const meta = SERVICE_CATALOG[serviceId];
        if (!meta) {
            metaBox.classList.add("hidden");
            return;
        }

        metaBox.classList.remove("hidden");
        metaSpeed.textContent = meta.speed;
        metaMin.textContent = `${meta.min.toLocaleString()} - ${meta.max.toLocaleString()}`;

        const qty = parseInt(quantityInput.value, 10);
        if (!Number.isNaN(qty) && qty > 0) {
            const estimated = (qty / 1000) * meta.rate;
            metaPrice.textContent = `$${estimated.toFixed(4)}`;
        } else {
            metaPrice.textContent = "—";
        }

        // Reflect the service's min as a live placeholder/hint
        quantityInput.min = String(meta.min);
        quantityInput.placeholder = `Min: ${meta.min}`;
    }

    serviceSelect.addEventListener("change", renderServiceMeta);
    quantityInput.addEventListener("input", renderServiceMeta);

    // -------------------------------------------------------------
    // Balance tracker
    // -------------------------------------------------------------
    async function fetchBalance() {
        const password = passwordInput.value.trim();
        if (!password) {
            balanceStatusEl.textContent = "Enter password to load balance";
            balanceValueEl.textContent = "—";
            return;
        }

        balanceStatusEl.textContent = "Fetching...";
        try {
            const response = await fetch("/api", {
                method: "GET",
                headers: { "X-Panel-Password": password },
            });
            const data = await response.json();

            if (response.ok && data.success) {
                const numeric = parseFloat(data.balance);
                balanceValueEl.textContent = Number.isNaN(numeric)
                    ? data.balance
                    : `${numeric.toFixed(2)} ${data.currency || "USD"}`;
                balanceStatusEl.textContent = "Live";
                balanceStatusEl.classList.remove("text-rose-400");
                balanceStatusEl.classList.add("text-emerald-400");
            } else {
                balanceValueEl.textContent = "—";
                balanceStatusEl.textContent = data.error || "Failed to load";
                balanceStatusEl.classList.remove("text-emerald-400");
                balanceStatusEl.classList.add("text-rose-400");
            }
        } catch (err) {
            console.error("Balance fetch failed:", err);
            balanceValueEl.textContent = "—";
            balanceStatusEl.textContent = "Network error";
            balanceStatusEl.classList.remove("text-emerald-400");
            balanceStatusEl.classList.add("text-rose-400");
        }
    }

    refreshBalanceBtn?.addEventListener("click", fetchBalance);
    // Auto-fetch on page load IF a password is already present (e.g. browser autofill).
    // Otherwise waits for the user to type it and hit refresh.
    if (passwordInput.value.trim()) fetchBalance();
    passwordInput.addEventListener("blur", () => {
        if (passwordInput.value.trim()) fetchBalance();
    });

    // -------------------------------------------------------------
    // Orders table rendering
    // -------------------------------------------------------------
    function statusBadgeClasses(status) {
        const s = (status || "").toLowerCase();
        if (s.includes("complete")) return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
        if (s.includes("progress")) return "bg-indigo-500/10 text-indigo-400 border-indigo-500/30";
        if (s.includes("pending")) return "bg-amber-500/10 text-amber-400 border-amber-500/30";
        if (s.includes("cancel") || s.includes("error") || s.includes("fail")) return "bg-rose-500/10 text-rose-400 border-rose-500/30";
        return "bg-slate-500/10 text-slate-400 border-slate-500/30";
    }

    function renderOrdersTable() {
        const orders = loadOrders();
        ordersTableBody.innerHTML = "";

        if (orders.length === 0) {
            ordersEmptyState.classList.remove("hidden");
            return;
        }
        ordersEmptyState.classList.add("hidden");

        orders.forEach((order) => {
            const tr = document.createElement("tr");
            tr.className = "border-b border-slate-800/60 hover:bg-slate-800/30 transition";
            tr.dataset.orderId = order.order_id;

            const shortLink = order.link.length > 28 ? order.link.slice(0, 28) + "…" : order.link;
            const time = new Date(order.timestamp).toLocaleString();

            tr.innerHTML = `
                <td class="py-2 px-3 text-xs text-slate-300 font-mono">${order.order_id}</td>
                <td class="py-2 px-3 text-xs text-slate-400">${order.service_label}</td>
                <td class="py-2 px-3 text-xs text-slate-400 truncate max-w-[140px]" title="${escapeHtml(order.link)}">${escapeHtml(shortLink)}</td>
                <td class="py-2 px-3 text-xs text-slate-400">${order.quantity}</td>
                <td class="py-2 px-3 text-xs text-slate-500">${time}</td>
                <td class="py-2 px-3 text-xs">
                    <span class="status-pill inline-block px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-wide ${statusBadgeClasses(order.status)}">
                        ${escapeHtml(order.status || "Unknown")}${order.remains !== null && order.remains !== undefined ? ` · ${order.remains} left` : ""}
                    </span>
                </td>
                <td class="py-2 px-3 text-xs space-x-2 whitespace-nowrap">
                    <button class="check-status-btn text-indigo-400 hover:text-indigo-300 underline underline-offset-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            data-order-id="${order.order_id}">
                        Status
                    </button>
                    <button class="refill-btn text-emerald-400 hover:text-emerald-300 underline underline-offset-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            data-order-id="${order.order_id}">
                        Refill
                    </button>
                    <button class="cancel-btn text-rose-400 hover:text-rose-300 underline underline-offset-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            data-order-id="${order.order_id}">
                        Cancel
                    </button>
                </td>
            `;
            ordersTableBody.appendChild(tr);
        });
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    // Event delegation for "Check Status" buttons (rows are re-rendered dynamically)
    ordersTableBody.addEventListener("click", async (event) => {
        const btn = event.target.closest(".check-status-btn");
        if (!btn) return;

        const orderId = btn.dataset.orderId;
        const password = passwordInput.value.trim();
        if (!password) {
            alert("Enter your gatekeeper password first to poll status.");
            return;
        }

        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Checking...";

        try {
            const response = await fetch("/api", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password, action: "status", order_id: orderId }),
            });
            const data = await response.json();

            if (response.ok && data.success) {
                updateOrderStatus(orderId, {
                    status: data.status,
                    remains: data.remains ?? null,
                });
                renderOrdersTable();
            } else {
                alert(`❌ Status check failed [${data.error_code || "UNKNOWN"}]: ${data.error}`);
            }
        } catch (err) {
            console.error("Status poll failed:", err);
            alert("❌ Network error while polling order status.");
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    });

    // Event delegation for "Refill" buttons
    ordersTableBody.addEventListener("click", async (event) => {
        const btn = event.target.closest(".refill-btn");
        if (!btn) return;

        const orderId = btn.dataset.orderId;
        const password = passwordInput.value.trim();
        if (!password) {
            alert("Enter your gatekeeper password first to request a refill.");
            return;
        }
        if (!confirm(`Request a refill for order ${orderId}? Only works if the service supports refills.`)) {
            return;
        }

        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "...";

        try {
            const response = await fetch("/api", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password, action: "refill", order_id: orderId }),
            });
            const data = await response.json();

            if (response.ok && data.success) {
                updateOrderStatus(orderId, { refill_id: data.refill_id });
                renderOrdersTable();
                alert(`✅ Refill requested. Refill ID: ${data.refill_id}`);
            } else {
                alert(`❌ Refill failed [${data.error_code || "UNKNOWN"}]: ${data.error}`);
            }
        } catch (err) {
            console.error("Refill request failed:", err);
            alert("❌ Network error while requesting refill.");
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    });

    // Event delegation for "Cancel" buttons
    ordersTableBody.addEventListener("click", async (event) => {
        const btn = event.target.closest(".cancel-btn");
        if (!btn) return;

        const orderId = btn.dataset.orderId;
        const password = passwordInput.value.trim();
        if (!password) {
            alert("Enter your gatekeeper password first to cancel an order.");
            return;
        }
        if (!confirm(`Cancel order ${orderId}? Only works if the service supports cancellation.`)) {
            return;
        }

        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "...";

        try {
            const response = await fetch("/api", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password, action: "cancel", order_ids: String(orderId) }),
            });
            const data = await response.json();

            // JAP's cancel action returns an array like [{ order, cancel: {...} }]
            if (response.ok && data.success) {
                const result = Array.isArray(data.results) ? data.results[0] : null;
                const cancelResult = result?.cancel;
                if (cancelResult && cancelResult.error) {
                    alert(`❌ Cancel rejected by JAP: ${cancelResult.error}`);
                } else {
                    updateOrderStatus(orderId, { status: "Canceled" });
                    renderOrdersTable();
                    alert(`✅ Cancel request submitted for order ${orderId}.`);
                }
            } else {
                alert(`❌ Cancel failed [${data.error_code || "UNKNOWN"}]: ${data.error}`);
            }
        } catch (err) {
            console.error("Cancel request failed:", err);
            alert("❌ Network error while canceling order.");
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    });

    // -------------------------------------------------------------
    // Order submission
    // -------------------------------------------------------------
    orderForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        const password = passwordInput.value.trim();
        const service_id = serviceSelect.value;
        const link = linkInput.value.trim();
        const quantity = parseInt(quantityInput.value, 10);

        const meta = SERVICE_CATALOG[service_id];
        if (meta && (quantity < meta.min || quantity > meta.max)) {
            alert(`⚠️ Quantity must be between ${meta.min} and ${meta.max} for this service.`);
            return;
        }

        const originalBtnText = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = `
            <svg class="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span>Routing to JAP Servers...</span>
        `;

        try {
            const response = await fetch("/api", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password, service_id, link, quantity }),
            });

            const data = await response.json();

            if (response.ok && data.success) {
                addOrderToLog({ orderId: data.order_id, link, quantity, serviceId: service_id });
                renderOrdersTable();
                linkInput.value = "";
                quantityInput.value = "";
                renderServiceMeta();
                fetchBalance(); // balance just changed — refresh it
            } else {
                alert(`❌ Engine Failure [${data.error_code || "UNKNOWN"}]: ${data.error || "Unknown error"}`);
            }
        } catch (error) {
            console.error("Critical Execution Aborted:", error);
            alert("❌ Critical Connection Timeout: Failed to reach serverless runtime backend.");
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
    });

    // -------------------------------------------------------------
    // Init
    // -------------------------------------------------------------
    renderServiceOptions();
    renderServiceMeta();
    renderOrdersTable();
});
