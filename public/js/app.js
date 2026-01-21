// public/js/app.js
const $ = (id) => document.getElementById(id);

const views = {
  login: $("viewLogin"),
  newOrder: $("viewNewOrder"),
  orders: $("viewOrders"),
  inventory: $("viewInventory"),
  checkout: $("viewCheckout"),
  audit: $("viewAudit"),
  endOfDay: $("viewEndOfDay")
};

let ME = null;
let PRODUCTS = [];
let SELECTED = {}; // productId -> {qty, unitPrice}
let OPEN_CHECKOUT_ORDER = null;

function showView(name) {
  Object.values(views).forEach(v => v.classList.add("hidden"));
  views[name].classList.remove("hidden");
}

function setMsg(el, text, ok = true) {
  el.textContent = text || "";
  el.style.color = ok ? "var(--muted)" : "var(--danger)";
}

function renderTabs(role) {
  const tabs = [];

  // Everyone
  tabs.push({ key: "orders", label: "Orders" });
  tabs.push({ key: "audit", label: "Audit Log" });

  if (role === "promoter" || role === "admin") {
    tabs.unshift({ key: "newOrder", label: "New Order" });
  }
  if (role === "inventory" || role === "admin") {
    tabs.unshift({ key: "inventory", label: "Inventory" });
  }
  if (role === "cashier" || role === "admin") {
    tabs.unshift({ key: "checkout", label: "Checkout" });
    tabs.push({ key: "endOfDay", label: "End of Day" });
  }

  const wrap = $("tabs");
  wrap.innerHTML = "";
  tabs.forEach((t, idx) => {
    const div = document.createElement("div");
    div.className = "tab" + (idx === 0 ? " active" : "");
    div.dataset.view = t.key;
    div.textContent = t.label;
    div.onclick = () => {
      [...wrap.querySelectorAll(".tab")].forEach(x => x.classList.remove("active"));
      div.classList.add("active");
      onTab(t.key);
    };
    wrap.appendChild(div);
  });

  // default first tab
  onTab(tabs[0].key);
}

async function onTab(key) {
  if (key === "newOrder") {
    await loadProducts();
    renderProductPicker();
    showView("newOrder");
    return;
  }

  if (key === "orders") {
    await loadOrders();
    showView("orders");
    return;
  }

  if (key === "inventory") {
    await loadProducts();
    renderProductsTable();
    showView("inventory");
    return;
  }

  if (key === "checkout") {
    await loadOrders(); // for quick open via search
    showView("checkout");
    return;
  }

  if (key === "audit") {
    await loadAudit();
    showView("audit");
    return;
  }

  if (key === "endOfDay") {
    showView("endOfDay");
    return;
  }
}

async function boot() {
  $("btnLogout").onclick = () => {
    clearToken();
    location.reload();
  };

  $("btnLogin").onclick = login;
  $("btnSaveOrder").onclick = saveOrder;
  $("btnRefreshProducts").onclick = async () => {
    await loadProducts();
    renderProductsTable();
  };
  $("btnAddProduct").onclick = addProduct;
  $("btnRefreshAudit").onclick = loadAudit;
  $("btnEndOfDay").onclick = endOfDayCancel;

  $("orderStatusFilter").onchange = loadOrders;
  $("globalSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      loadOrders();
    }
  });

  // If token exists, fetch /me
  try {
    const me = await apiFetch("/api/me");
    ME = me;
    $("whoami").textContent = `${me.username} • ${me.role}`;
    renderTabs(me.role);
    views.login.classList.add("hidden");
  } catch {
    // Not logged in
    $("whoami").textContent = `Please login`;
    showView("login");
  }
}

async function login() {
  const msg = $("loginMsg");
  setMsg(msg, "");
  try {
    const username = $("loginUser").value.trim();
    const password = $("loginPass").value;
    const data = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    setToken(data.token);
    location.reload();
  } catch (e) {
    setMsg(msg, e.message, false);
  }
}

async function loadProducts() {
  PRODUCTS = await apiFetch("/api/products");
}

function renderProductPicker() {
  SELECTED = {};
  const wrap = $("productPicker");
  wrap.innerHTML = "";

  PRODUCTS.forEach((p) => {
    const card = document.createElement("div");
    card.className = "prodCard";

    const top = document.createElement("div");
    top.className = "prodTop";

    const name = document.createElement("div");
    name.className = "prodName";
    name.textContent = p.name;

    const stock = document.createElement("div");
    stock.className = "prodStock";
    stock.textContent = `Stock: ${p.stock}`;

    top.appendChild(name);
    top.appendChild(stock);

    const qtyRow = document.createElement("div");
    qtyRow.className = "qtyRow";

    const minus = document.createElement("button");
    minus.className = "qtyBtn";
    minus.textContent = "−";

    const qty = document.createElement("input");
    qty.className = "input qtyInput";
    qty.type = "number";
    qty.min = "0";
    qty.value = "0";

    const plus = document.createElement("button");
    plus.className = "qtyBtn";
    plus.textContent = "+";

    const price = document.createElement("input");
    price.className = "input priceInput";
    price.type = "number";
    price.step = "0.01";
    price.placeholder = "Unit price";

    // default from basePrice if provided
    if (p.basePrice) price.value = String(p.basePrice);

    function syncSelected() {
      const q = Number(qty.value) || 0;
      const pr = Number(price.value) || 0;

      if (q > 0) {
        SELECTED[p._id] = { qty: q, unitPrice: pr };
      } else {
        delete SELECTED[p._id];
      }
    }

    minus.onclick = () => {
      qty.value = String(Math.max(0, (Number(qty.value) || 0) - 1));
      syncSelected();
    };
    plus.onclick = () => {
      qty.value = String((Number(qty.value) || 0) + 1);
      syncSelected();
    };
    qty.oninput = syncSelected;
    price.oninput = syncSelected;

    qtyRow.appendChild(minus);
    qtyRow.appendChild(qty);
    qtyRow.appendChild(plus);
    qtyRow.appendChild(price);

    card.appendChild(top);
    card.appendChild(qtyRow);
    wrap.appendChild(card);
  });
}

function renderProductPickerPrefilled() {
  const wrap = $("productPicker");
  wrap.innerHTML = "";

  PRODUCTS.forEach((p) => {
    const card = document.createElement("div");
    card.className = "prodCard";

    const top = document.createElement("div");
    top.className = "prodTop";

    const name = document.createElement("div");
    name.className = "prodName";
    name.textContent = p.name;

    const stock = document.createElement("div");
    stock.className = "prodStock";
    stock.textContent = `Stock: ${p.stock}`;

    top.appendChild(name);
    top.appendChild(stock);

    const qtyRow = document.createElement("div");
    qtyRow.className = "qtyRow";

    const minus = document.createElement("button");
    minus.className = "qtyBtn";
    minus.textContent = "−";

    const qty = document.createElement("input");
    qty.className = "input qtyInput";
    qty.type = "number";
    qty.min = "0";

    const plus = document.createElement("button");
    plus.className = "qtyBtn";
    plus.textContent = "+";

    const price = document.createElement("input");
    price.className = "input priceInput";
    price.type = "number";
    price.step = "0.01";
    price.placeholder = "Unit price";

    // Prefill from existing selection (if any)
    const sel = SELECTED[p._id];
    qty.value = sel ? String(sel.qty) : "0";
    price.value = sel ? String(sel.unitPrice) : (p.basePrice ? String(p.basePrice) : "");

    function syncSelected() {
      const q = Number(qty.value) || 0;
      const pr = Number(price.value) || 0;

      if (q > 0) {
        SELECTED[p._id] = { qty: q, unitPrice: pr };
      } else {
        delete SELECTED[p._id];
      }
    }

    minus.onclick = () => {
      qty.value = String(Math.max(0, (Number(qty.value) || 0) - 1));
      syncSelected();
    };
    plus.onclick = () => {
      qty.value = String((Number(qty.value) || 0) + 1);
      syncSelected();
    };
    qty.oninput = syncSelected;
    price.oninput = syncSelected;

    qtyRow.appendChild(minus);
    qtyRow.appendChild(qty);
    qtyRow.appendChild(plus);
    qtyRow.appendChild(price);

    card.appendChild(top);
    card.appendChild(qtyRow);
    wrap.appendChild(card);
  });
}


async function saveOrderEdits(orderId) {
  const msg = $("orderMsg");
  setMsg(msg, "");

  try {
    const customerName = $("custName").value.trim();
    const phone = $("custPhone").value.trim();
    const email = $("custEmail").value.trim();
    const overrideTotalRaw = $("overrideTotal").value;

    const items = Object.entries(SELECTED).map(([productId, v]) => ({
      productId,
      qty: v.qty,
      unitPrice: v.unitPrice
    }));

    const payload = {
      customerName,
      phone,
      email,
      items,
      overrideTotal: overrideTotalRaw === "" ? "" : Number(overrideTotalRaw)
    };

    const updated = await apiFetch(`/api/orders/${orderId}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });

    setMsg(msg, `✅ Updated reserved order. (Order ID: ${updated._id})`, true);

    // reset the button back to create mode
    $("btnSaveOrder").textContent = "Save Order & Block Stock";
    $("btnSaveOrder").onclick = saveOrder;

    // clear form
    $("custName").value = "";
    $("custPhone").value = "";
    $("custEmail").value = "";
    $("overrideTotal").value = "";
    SELECTED = {};
    await loadProducts();
    renderProductPicker();

    // refresh orders list
    await loadOrders();
  } catch (e) {
    setMsg(msg, `⛔ ${e.message}`, false);
  }
}


async function saveOrder() {
  const msg = $("orderMsg");
  setMsg(msg, "");

  try {
    const customerName = $("custName").value.trim();
    const phone = $("custPhone").value.trim();
    const email = $("custEmail").value.trim();
    const overrideTotalRaw = $("overrideTotal").value;

    const items = Object.entries(SELECTED).map(([productId, v]) => ({
      productId,
      qty: v.qty,
      unitPrice: v.unitPrice
    }));

    const payload = {
      customerName,
      phone,
      email,
      items,
      overrideTotal: overrideTotalRaw === "" ? "" : Number(overrideTotalRaw)
    };

    const order = await apiFetch("/api/orders", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    setMsg(msg, `✅ Order saved. Reserved. (Order ID: ${order._id})`, true);

    // reset
    $("custName").value = "";
    $("custPhone").value = "";
    $("custEmail").value = "";
    $("overrideTotal").value = "";
    await loadProducts();
    renderProductPicker();
  } catch (e) {
    setMsg(msg, `⛔ ${e.message}`, false);
  }
}

async function loadOrders() {
  const wrap = $("ordersTable");
  wrap.innerHTML = "Loading...";

  const status = $("orderStatusFilter").value;
  const q = $("globalSearch").value.trim();

  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (q) params.set("q", q);

  const orders = await apiFetch(`/api/orders?${params.toString()}`);

  wrap.innerHTML = renderOrdersTable(orders);
  bindOrdersActions(orders);
}

function statusBadge(s) {
  const cls = s === "paid" ? "paid" : s === "cancelled" ? "cancelled" : "reserved";
  return `<span class="badge ${cls}">${s.toUpperCase()}</span>`;
}

function renderOrdersTable(orders) {
  const rows = orders.map((o) => {
    const items = o.items.map(it => `${it.name} x${it.qty}`).join(", ");
    const receipt = o.receipt?.receiptNo ? o.receipt.receiptNo : "-";
    const total = Number(o.finalTotal || 0).toFixed(2);

    return `
      <tr>
        <td>${statusBadge(o.status)}</td>
        <td><b>${o.customerName}</b><br><span class="muted">${o.phone}${o.email ? " • " + o.email : ""}</span></td>
        <td>${items}</td>
        <td>RM ${total}<br><span class="muted">Receipt: ${receipt}</span></td>
        <td><span class="muted">${o.createdBy}</span></td>
<td>
  <button class="btn" data-open="${o._id}">Open</button>
  ${o.status === "reserved" ? `<button class="btn gold" data-edit="${o._id}">Edit</button>` : ""}
</td>

      </tr>
    `;
  }).join("");

  return `
    <table class="table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Customer</th>
          <th>Items</th>
          <th>Total</th>
          <th>Promoter</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>${rows || ""}</tbody>
    </table>
  `;
}

function bindOrdersActions(orders) {
  document.querySelectorAll("[data-open]").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.getAttribute("data-open");
      const o = orders.find(x => x._id === id);
      OPEN_CHECKOUT_ORDER = o;
      renderCheckout(o);
      // switch to checkout tab if exists
      if (ME.role === "cashier" || ME.role === "admin") {
        // activate tab
        const tabs = $("tabs");
        const t = [...tabs.querySelectorAll(".tab")].find(x => x.dataset.view === "checkout");
        if (t) t.click();
      } else {
        // otherwise just show orders and expand info in place
        alert(`Order opened: ${o.customerName} (${o.phone})`);
      }
    };
  });

  document.querySelectorAll("[data-edit]").forEach((btn) => {
  btn.onclick = async () => {
    const id = btn.getAttribute("data-edit");
    const o = orders.find(x => x._id === id);
    if (!o) return;

    // load products for picker
    await loadProducts();

    // prefill customer fields
    $("custName").value = o.customerName || "";
    $("custPhone").value = o.phone || "";
    $("custEmail").value = o.email || "";
    $("overrideTotal").value = (o.overrideTotal ?? "");

    // prefill SELECTED items
    SELECTED = {};
    (o.items || []).forEach(it => {
      SELECTED[it.productId] = { qty: Number(it.qty) || 0, unitPrice: Number(it.unitPrice) || 0 };
    });

    // render picker with prefilled values
    renderProductPickerPrefilled();

    // switch button behavior to "Save Changes"
    $("btnSaveOrder").textContent = "Save Changes (Update Reservation)";
    $("btnSaveOrder").onclick = () => saveOrderEdits(o._id);

    setMsg($("orderMsg"), `Editing reserved order: ${o.customerName} (${o.phone})`);
    showView("newOrder");
  };
});

}



function renderProductsTable() {
  const wrap = $("productsTable");
  const rows = PRODUCTS.map((p) => {
    return `
      <tr>
        <td><b>${p.name}</b><br><span class="muted">${p.sku || ""}</span></td>
        <td><input class="input small" data-stock="${p._id}" type="number" value="${p.stock}" /></td>
        <td><input class="input small" data-baseprice="${p._id}" type="number" step="0.01" value="${p.basePrice || 0}" /></td>
        <td><button class="btn gold" data-saveprod="${p._id}">Save</button></td>
      </tr>
    `;
  }).join("");

  wrap.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>Product</th>
          <th>Stock</th>
          <th>Base Price</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  document.querySelectorAll("[data-saveprod]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-saveprod");
      const stockEl = document.querySelector(`[data-stock="${id}"]`);
      const priceEl = document.querySelector(`[data-baseprice="${id}"]`);
      const stock = Number(stockEl.value) || 0;
      const basePrice = Number(priceEl.value) || 0;

      try {
        await apiFetch(`/api/products/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ stock, basePrice })
        });
        setMsg($("invMsg"), "✅ Updated");
        await loadProducts();
        renderProductsTable();
      } catch (e) {
        setMsg($("invMsg"), `⛔ ${e.message}`, false);
      }
    };
  });
}

async function addProduct() {
  const msg = $("invMsg");
  setMsg(msg, "");

  try {
    const name = $("newProdName").value.trim();
    const stock = Number($("newProdStock").value) || 0;
    const basePrice = Number($("newProdPrice").value) || 0;

    const p = await apiFetch("/api/products", {
      method: "POST",
      body: JSON.stringify({ name, stock, basePrice })
    });

    setMsg(msg, `✅ Added: ${p.name}`);
    $("newProdName").value = "";
    $("newProdStock").value = "";
    $("newProdPrice").value = "";
    await loadProducts();
    renderProductsTable();
  } catch (e) {
    setMsg(msg, `⛔ ${e.message}`, false);
  }
}

function renderCheckout(order) {
  const wrap = $("checkoutPanel");
  if (!order) {
    wrap.innerHTML = `<div class="muted">Select an order to checkout.</div>`;
    return;
  }

  const itemsRows = order.items.map((it) => {
    return `
      <tr>
        <td>${it.name}</td>
        <td><input class="input small" data-qty="${it.productId}" type="number" value="${it.qty}" /></td>
        <td><input class="input small" data-up="${it.productId}" type="number" step="0.01" value="${it.unitPrice}" /></td>
      </tr>
    `;
  }).join("");

const proofs = (order.proofs || []).map((p, idx) => {
  return `<li>
    <button class="btn" data-proof="${p.fileId}">
      View ${p.filename}
    </button>
    <span class="muted">(${Math.round((p.size || 0) / 1024)} KB)</span>
  </li>`;
}).join("");


const receiptLink = order.receipt?.pdfFileId
  ? `<button class="btn" id="btnViewReceipt">View Receipt PDF</button>`
  : "";


  const canEdit = order.status === "reserved";
  const canPay = order.status === "reserved";
  const canCancel = order.status === "reserved";

  wrap.innerHTML = `
    <div class="rowBetween">
      <div>
        <div><b>${order.customerName}</b> <span class="muted">(${order.phone}${order.email ? " • " + order.email : ""})</span></div>
        <div class="muted">Promoter: ${order.createdBy} • Status: ${order.status.toUpperCase()}</div>
      </div>
      <div>${receiptLink}</div>
    </div>

    <div style="margin-top:12px">
      <table class="table">
        <thead><tr><th>Item</th><th>Qty</th><th>Unit Price</th></tr></thead>
        <tbody>${itemsRows}</tbody>
      </table>
    </div>

    <div class="grid2" style="margin-top:12px">
      <div class="formRow">
        <label>Bundle/Override Total (Optional)</label>
        <input id="chkOverride" class="input" type="number" step="0.01" value="${order.overrideTotal ?? ""}" ${canEdit ? "" : "disabled"} />
      </div>

      <div class="formRow">
        <label>Payment Method</label>
        <select id="payMethod" class="input" ${canPay ? "" : "disabled"}>
          <option value="">Select</option>
          <option value="cash">cash</option>
          <option value="card">card</option>
          <option value="qr">qr</option>
          <option value="transfer">transfer</option>
          <option value="credit card">credit card</option>
          <option value="cheque">cheque</option>
        </select>
      </div>
    </div>

    <div class="actions">
      <button class="btn gold" id="btnSaveEdits" ${canEdit ? "" : "disabled"}>Save Edits</button>
      <button class="btn gold" id="btnMarkPaid" ${canPay ? "" : "disabled"}>Mark Paid & Generate Receipt</button>
      <button class="btn danger" id="btnCancelOrder" ${canCancel ? "" : "disabled"}>Cancel Order</button>
      <div id="chkMsg" class="msg"></div>
    </div>

    <div style="margin-top:12px">
      <h3>Proof Upload (Optional)</h3>
      <input id="proofFiles" class="input" type="file" multiple accept="image/*,application/pdf" />
      <button class="btn" id="btnUploadProofs">Upload</button>
      <div class="msg muted">Uploaded proofs:</div>
      <ul>${proofs || "<li class='muted'>None</li>"}</ul>
    </div>
  `;
const btnViewReceipt = document.getElementById("btnViewReceipt");
if (btnViewReceipt) {
  btnViewReceipt.onclick = () => viewProtectedPdf(order.receipt.pdfFileId);

  
}

  document.querySelectorAll("[data-proof]").forEach(btn => {
  btn.onclick = () => {
    const fileId = btn.getAttribute("data-proof");
    viewProtectedPdf(fileId);
  };
});

  
  $("btnSaveEdits").onclick = () => saveCheckoutEdits(order._id);
  $("btnMarkPaid").onclick = () => markPaid(order._id);
  $("btnCancelOrder").onclick = () => cancelOrder(order._id);
  $("btnUploadProofs").onclick = () => uploadProofs(order._id);
}

async function saveCheckoutEdits(orderId) {
  const msg = $("chkMsg");
  setMsg(msg, "");

  try {
    // Build items from current inputs (allow 0 to remove? We will ignore <=0)
    const items = [];
    for (const it of OPEN_CHECKOUT_ORDER.items) {
      const pid = it.productId;
      const qtyEl = document.querySelector(`[data-qty="${pid}"]`);
      const upEl = document.querySelector(`[data-up="${pid}"]`);
      const qty = Number(qtyEl.value) || 0;
      const unitPrice = Number(upEl.value) || 0;
      if (qty > 0) items.push({ productId: pid, qty, unitPrice });
    }

    const overrideRaw = $("chkOverride").value;

    const updated = await apiFetch(`/api/orders/${orderId}`, {
      method: "PATCH",
      body: JSON.stringify({
        customerName: OPEN_CHECKOUT_ORDER.customerName,
        phone: OPEN_CHECKOUT_ORDER.phone,
        email: OPEN_CHECKOUT_ORDER.email,
        items,
        overrideTotal: overrideRaw === "" ? "" : Number(overrideRaw)
      })
    });

    setMsg(msg, "✅ Saved edits", true);
    OPEN_CHECKOUT_ORDER = updated;
    await loadOrders();
    renderCheckout(updated);
  } catch (e) {
    setMsg(msg, `⛔ ${e.message}`, false);
  }
}

async function markPaid(orderId) {
  const msg = $("chkMsg");
  setMsg(msg, "");

  try {
    const method = $("payMethod").value;
    if (!method) return setMsg(msg, "⛔ Select payment method first", false);

    const r = await apiFetch(`/api/orders/${orderId}/pay`, {
      method: "POST",
      body: JSON.stringify({ method })
    });

    setMsg(msg, `✅ Paid. Receipt: ${r.receiptNo}`, true);
    await loadOrders();

    // reload open order from list if possible
    const list = await apiFetch(`/api/orders?q=${encodeURIComponent(orderId)}`);
    // not perfect, so just re-search by receipt:
    $("globalSearch").value = r.receiptNo;
    await loadOrders();
  } catch (e) {
    setMsg(msg, `⛔ ${e.message}`, false);
  }
}

async function cancelOrder(orderId) {
  const msg = $("chkMsg");
  setMsg(msg, "");
  try {
    await apiFetch(`/api/orders/${orderId}/cancel`, { method: "POST" });
    setMsg(msg, "✅ Cancelled (stock returned)", true);
    OPEN_CHECKOUT_ORDER = null;
    await loadOrders();
    renderCheckout(null);
  } catch (e) {
    setMsg(msg, `⛔ ${e.message}`, false);
  }
}

async function uploadProofs(orderId) {
  const msg = $("chkMsg");
  setMsg(msg, "");

  try {
    const input = $("proofFiles");
    const files = input.files;
    if (!files || !files.length) return setMsg(msg, "⛔ Select files first", false);

    const fd = new FormData();
    for (const f of files) fd.append("files", f);

    await apiFetch(`/api/orders/${orderId}/proofs`, {
      method: "POST",
      body: fd
    });

    setMsg(msg, "✅ Proofs uploaded", true);
    input.value = "";
    await loadOrders();
  } catch (e) {
    setMsg(msg, `⛔ ${e.message}`, false);
  }
}

async function loadAudit() {
  const wrap = $("auditTable");
  wrap.innerHTML = "Loading...";
  const q = $("globalSearch").value.trim();
  const logs = await apiFetch(`/api/audit${q ? `?q=${encodeURIComponent(q)}` : ""}`);

  const rows = logs.map((l) => {
    return `
      <tr>
        <td>${new Date(l.at).toLocaleString()}</td>
        <td><b>${l.action}</b><br><span class="muted">${l.entityType} • ${l.entityId}</span></td>
        <td>${l.actor || "-"}</td>
        <td><span class="muted">${JSON.stringify(l.meta || {}).slice(0, 140)}</span></td>
      </tr>
    `;
  }).join("");

  wrap.innerHTML = `
    <table class="table">
      <thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Meta</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function endOfDayCancel() {
  const msg = $("eodMsg");
  setMsg(msg, "");

  try {
    const r = await apiFetch("/api/endofday/cancel-unpaid", { method: "POST" });
    setMsg(msg, `✅ Cancelled unpaid orders: ${r.cancelled}`, true);
    await loadOrders();
  } catch (e) {
    setMsg(msg, `⛔ ${e.message}`, false);
  }
}

async function viewProtectedPdf(fileId) {
  try {
    const token = getToken();
    if (!token) {
      alert("Missing token. Please login again.");
      return;
    }

    const res = await fetch(apiUrl(`/api/files/${fileId}`), {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || "Failed to load PDF");
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    // optional: revoke later
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    alert(`Cannot open PDF: ${e.message}`);
  }
}


boot();
