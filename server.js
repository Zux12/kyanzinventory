// server.js
const express = require("express");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
app.set("trust proxy", true);

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 5050;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || "devsecret-change-me";

// =======================
// Mongo + Models
// =======================

const userSchema = new mongoose.Schema(
  {
    username: { type: String, unique: true, index: true },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: ["promoter", "inventory", "cashier", "admin"],
      index: true
    }
  },
  { timestamps: true }
);
const User = mongoose.model("User", userSchema);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, index: true },
    sku: { type: String, default: "", index: true },
    stock: { type: Number, default: 0 },
    basePrice: { type: Number, default: 0 }, // optional reference only
    isActive: { type: Boolean, default: true, index: true }
  },
  { timestamps: true }
);
const Product = mongoose.model("Product", productSchema);

const orderSchema = new mongoose.Schema(
  {
    customerName: { type: String, required: true, index: true },
    phone: { type: String, required: true, index: true },
    email: { type: String, default: "", index: true },
    remarks: { type: String, default: "" },
    receiptShareToken: { type: String, default: "", index: true },



    createdBy: { type: String, required: true, index: true }, // promoter username
    status: { type: String, enum: ["reserved", "paid", "cancelled"], default: "reserved", index: true },

    items: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
        name: String,
        qty: Number,
        unitPrice: Number,
        lineTotal: Number
      }
    ],

    // pricing controls
    overrideTotal: { type: Number, default: null }, // bundle / override
    finalTotal: { type: Number, default: 0 },

    payment: {
      method: { type: String, default: "" },
      paidAt: { type: Date, default: null },
      paidBy: { type: String, default: "" } // cashier username
    },

    receipt: {
      receiptNo: { type: String, default: "", index: true },
      pdfFileId: { type: mongoose.Schema.Types.ObjectId, default: null } // stored in GridFS
    },

    proofs: [
      {
        fileId: mongoose.Schema.Types.ObjectId,
        filename: String,
        mimetype: String,
        size: Number,
        uploadedAt: Date,
        uploadedBy: String
      }
    ],

    cancelledBy: { type: String, default: "" },
    cancelledAt: { type: Date, default: null }
  },
  { timestamps: true }
);
const Order = mongoose.model("Order", orderSchema);

const auditSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, index: true },
    actor: { type: String, default: "", index: true },
    role: { type: String, default: "", index: true },
    action: { type: String, required: true, index: true },
    entityType: { type: String, default: "", index: true },
    entityId: { type: String, default: "", index: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: false }
);
const AuditLog = mongoose.model("AuditLog", auditSchema);

// =======================
// GridFS (for proofs + receipts)
// =======================
let gfsBucket = null;

mongoose.connection.once("open", () => {
  gfsBucket = new mongoose.mongo.GridFSBucket(
    mongoose.connection.db,
    { bucketName: "uploads" }
  );
  console.log("✅ GridFS initialized");
});



// Multer memory storage -> stream to GridFS
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// =======================
// Helpers
// =======================
function normalizePhone(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/-/g, "")
    .trim();
}

function calcTotals(items, overrideTotal) {
  const safeItems = Array.isArray(items) ? items : [];
  const sum = safeItems.reduce((acc, it) => acc + (Number(it.lineTotal) || 0), 0);
  const finalTotal =
    overrideTotal === null || overrideTotal === undefined || overrideTotal === ""
      ? sum
      : Number(overrideTotal) || 0;

  return { sum, finalTotal };
}

async function audit(actor, role, action, entityType = "", entityId = "", meta = {}) {
  try {
    await AuditLog.create({ actor, role, action, entityType, entityId, meta });
  } catch (e) {
    console.error("Audit error:", e.message);
  }
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ msg: "Missing token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { username, role }
    next();
  } catch {
    return res.status(401).json({ msg: "Invalid token" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user?.role) return res.status(401).json({ msg: "No role" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ msg: "Forbidden" });
    next();
  };
}

function receiptNoFactory() {
  // KYZ-YYYYMMDD-XXXX
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const stamp = `${y}${m}${day}`;
  const rand = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `KYZ-${stamp}-${rand}`;
}

async function ensureSeedUsers() {
  const defaults = [];

  for (let i = 1; i <= 10; i++) defaults.push({ username: `promoter${i}`, role: "promoter" });
  for (let i = 1; i <= 2; i++) defaults.push({ username: `inventory${i}`, role: "inventory" });
  for (let i = 1; i <= 2; i++) defaults.push({ username: `cashier${i}`, role: "cashier" });

  defaults.push({ username: "admin", role: "admin" });

  for (const u of defaults) {
    const exists = await User.findOne({ username: u.username });
    if (exists) continue;

    // password same as username for now
    const passwordHash = await bcrypt.hash(u.username, 12);
    await User.create({ username: u.username, passwordHash, role: u.role });
  }
}

// =======================
// Routes: health + auth
// =======================


app.get("/api/ping", (_, res) => res.json({ ok: true, app: "kyanz" }));

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ msg: "Missing username/password" });

    const user = await User.findOne({ username: String(username).trim() });
    if (!user) return res.status(400).json({ msg: "Invalid credentials" });

    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return res.status(400).json({ msg: "Invalid credentials" });

    const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: "7d" });

    await audit(user.username, user.role, "LOGIN", "user", String(user._id));
    res.json({ token, role: user.role, username: user.username });
  } catch (e) {
    console.error("login error:", e);
    res.status(500).json({ msg: "Server error" });
  }
});

app.get("/api/me", requireAuth, async (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

// =======================
// Products
// =======================

// List products (everyone)
app.get("/api/products", requireAuth, async (req, res) => {
  const products = await Product.find({ isActive: true }).sort({ name: 1 });
  res.json(products);
});

// Inventory/admin manage products
app.post("/api/products", requireAuth, requireRole("inventory", "admin"), async (req, res) => {
  try {
    const { name, sku, stock, basePrice } = req.body || {};
    if (!name) return res.status(400).json({ msg: "Missing product name" });

    const p = await Product.create({
      name: String(name).trim(),
      sku: String(sku || "").trim(),
      stock: Number(stock) || 0,
      basePrice: Number(basePrice) || 0,
      isActive: true
    });

    await audit(req.user.username, req.user.role, "PRODUCT_CREATE", "product", String(p._id), { name: p.name, stock: p.stock });
    res.json(p);
  } catch (e) {
    res.status(500).json({ msg: "Failed to create product", error: e.message });
  }
});

app.patch("/api/products/:id", requireAuth, requireRole("inventory", "admin"), async (req, res) => {
  try {
    const id = req.params.id;
    const patch = {};
    const allowed = ["name", "sku", "stock", "basePrice", "isActive"];
    for (const k of allowed) {
      if (k in (req.body || {})) patch[k] = req.body[k];
    }

    // sanitize
    if ("name" in patch) patch.name = String(patch.name).trim();
    if ("sku" in patch) patch.sku = String(patch.sku).trim();
    if ("stock" in patch) patch.stock = Number(patch.stock) || 0;
    if ("basePrice" in patch) patch.basePrice = Number(patch.basePrice) || 0;

    const p = await Product.findByIdAndUpdate(id, patch, { new: true });
    if (!p) return res.status(404).json({ msg: "Product not found" });

    await audit(req.user.username, req.user.role, "PRODUCT_UPDATE", "product", String(p._id), patch);
    res.json(p);
  } catch (e) {
    res.status(500).json({ msg: "Failed to update product", error: e.message });
  }
});

// =======================
// Orders
// =======================

// List orders (everyone, you requested all promoters can see all)
app.get("/api/orders", requireAuth, async (req, res) => {
  const { status, q } = req.query || {};
  const filter = {};
  if (status) filter.status = status;

  if (q) {
    const qq = String(q).trim();
    filter.$or = [
      { phone: qq },
      { email: qq.toLowerCase() },
      { customerName: new RegExp(qq, "i") },
      { "receipt.receiptNo": new RegExp(qq, "i") }
    ];
  }

  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(200);
  res.json(orders);
});

// Create order (promoter only) + reserve stock on save
app.post("/api/orders", requireAuth, requireRole("promoter", "admin"), async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {

    const { customerName, phone, email, items, overrideTotal, remarks } = req.body || {};


    if (!customerName || !phone) {
      await session.abortTransaction();
      return res.status(400).json({ msg: "Missing customerName/phone" });
    }

    const nPhone = normalizePhone(phone);
    const nEmail = String(email || "").trim().toLowerCase();

    // block duplicate open order BEFORE checkout
    const open = await Order.findOne({
      status: "reserved",
      $or: [{ phone: nPhone }, ...(nEmail ? [{ email: nEmail }] : [])]
    }).session(session);

    if (open) {
      await session.abortTransaction();
      return res.status(409).json({
        msg: "Customer has an open order. Please proceed to cashier or cancel the open order.",
        openOrderId: String(open._id)
      });
    }

    const safeItems = Array.isArray(items) ? items : [];
    if (!safeItems.length) {
      await session.abortTransaction();
      return res.status(400).json({ msg: "No items selected" });
    }

    // Check and reserve stock
    // Expected item: { productId, qty, unitPrice }
    const hydratedItems = [];
    for (const it of safeItems) {
      const pid = it.productId;
      const qty = Number(it.qty) || 0;
      const unitPrice = Number(it.unitPrice) || 0;
      if (!pid || qty <= 0) continue;

      const p = await Product.findById(pid).session(session);
      if (!p || !p.isActive) {
        await session.abortTransaction();
        return res.status(400).json({ msg: "Invalid product in items" });
      }

      if (p.stock < qty) {
        await session.abortTransaction();
        return res.status(409).json({ msg: `Not enough stock for ${p.name}. Remaining: ${p.stock}` });
      }

      p.stock -= qty;
      await p.save({ session });

      const lineTotal = qty * unitPrice;
      hydratedItems.push({ productId: p._id, name: p.name, qty, unitPrice, lineTotal });
    }

    if (!hydratedItems.length) {
      await session.abortTransaction();
      return res.status(400).json({ msg: "No valid items" });
    }

    const totals = calcTotals(hydratedItems, overrideTotal);

    const order = await Order.create(
      [
{
  customerName: String(customerName).trim(),
  phone: nPhone,
  email: nEmail,
  remarks: String(remarks || "").trim(),
  createdBy: req.user.username,
  status: "reserved",
  items: hydratedItems,
  overrideTotal: overrideTotal === "" ? null : (overrideTotal ?? null),
  finalTotal: totals.finalTotal
}

      ],
      { session }
    );

    await audit(req.user.username, req.user.role, "ORDER_CREATE_RESERVE", "order", String(order[0]._id), {
      phone: nPhone,
      items: hydratedItems.map(x => ({ name: x.name, qty: x.qty, unitPrice: x.unitPrice }))
    });

    await session.commitTransaction();
    res.json(order[0]);
  } catch (e) {
    await session.abortTransaction();
    res.status(500).json({ msg: "Failed to create order", error: e.message });
  } finally {
    session.endSession();
  }
});

// Update order (cashier/admin) - allows edit items/prices before payment

app.patch("/api/orders/:id", requireAuth, requireRole("promoter", "cashier", "admin"), async (req, res) => {

  
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const id = req.params.id;
    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ msg: "Order not found" });
    }
    if (order.status !== "reserved") {
      await session.abortTransaction();
      return res.status(409).json({ msg: "Only reserved orders can be edited" });
    }

    const { customerName, phone, email, items, overrideTotal, remarks } = req.body || {};


    // Return previous stock then reserve new stock based on updated items
    for (const old of order.items) {
      const p = await Product.findById(old.productId).session(session);
      if (p) {
        p.stock += Number(old.qty) || 0;
        await p.save({ session });
      }
    }

    const safeItems = Array.isArray(items) ? items : [];
    const hydratedItems = [];

    for (const it of safeItems) {
      const pid = it.productId;
      const qty = Number(it.qty) || 0;
      const unitPrice = Number(it.unitPrice) || 0;
      if (!pid || qty <= 0) continue;

      const p = await Product.findById(pid).session(session);
      if (!p || !p.isActive) {
        await session.abortTransaction();
        return res.status(400).json({ msg: "Invalid product in items" });
      }

      if (p.stock < qty) {
        await session.abortTransaction();
        return res.status(409).json({ msg: `Not enough stock for ${p.name}. Remaining: ${p.stock}` });
      }

      p.stock -= qty;
      await p.save({ session });

      hydratedItems.push({
        productId: p._id,
        name: p.name,
        qty,
        unitPrice,
        lineTotal: qty * unitPrice
      });
    }

    if (!hydratedItems.length) {
      await session.abortTransaction();
      return res.status(400).json({ msg: "No valid items after edit" });
    }

    const nPhone = phone ? normalizePhone(phone) : order.phone;
    const nEmail = email !== undefined ? String(email || "").trim().toLowerCase() : order.email;

    // Keep open-order rule: since this is same order, no need to check duplication.

    order.customerName = customerName !== undefined ? String(customerName).trim() : order.customerName;
    order.phone = nPhone;
    order.email = nEmail;
    order.remarks = remarks !== undefined ? String(remarks || "").trim() : order.remarks;
    order.items = hydratedItems;
    order.overrideTotal = overrideTotal === "" ? null : (overrideTotal ?? order.overrideTotal);

    const totals = calcTotals(hydratedItems, order.overrideTotal);
    order.finalTotal = totals.finalTotal;

    await order.save({ session });

    await audit(req.user.username, req.user.role, "ORDER_EDIT", "order", String(order._id), {
      items: hydratedItems.map(x => ({ name: x.name, qty: x.qty, unitPrice: x.unitPrice })),
      overrideTotal: order.overrideTotal,
      finalTotal: order.finalTotal
    });

    await session.commitTransaction();
    res.json(order);
  } catch (e) {
    await session.abortTransaction();
    res.status(500).json({ msg: "Failed to update order", error: e.message });
  } finally {
    session.endSession();
  }
});

// Cancel reserved order (cashier/admin only) -> return stock
app.post("/api/orders/:id/cancel", requireAuth, requireRole("cashier", "admin"), async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const id = req.params.id;
    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ msg: "Order not found" });
    }
    if (order.status !== "reserved") {
      await session.abortTransaction();
      return res.status(409).json({ msg: "Only reserved orders can be cancelled" });
    }

    for (const it of order.items) {
      const p = await Product.findById(it.productId).session(session);
      if (p) {
        p.stock += Number(it.qty) || 0;
        await p.save({ session });
      }
    }

    order.status = "cancelled";
    order.cancelledBy = req.user.username;
    order.cancelledAt = new Date();
    await order.save({ session });

    await audit(req.user.username, req.user.role, "ORDER_CANCEL", "order", String(order._id), { phone: order.phone });

    await session.commitTransaction();
    res.json({ ok: true });
  } catch (e) {
    await session.abortTransaction();
    res.status(500).json({ msg: "Cancel failed", error: e.message });
  } finally {
    session.endSession();
  }
});

// Upload proof(s) (cashier/admin)

app.post("/api/orders/:id/proofs", requireAuth, requireRole("cashier", "admin"), upload.array("files", 10), async (req, res) => {
  if (!gfsBucket) {
  return res.status(503).json({
    msg: "File storage not ready. Please retry."
  });
}
  
  try {



    const id = req.params.id;
    const order = await Order.findById(id);

    if (!order) return res.status(404).json({ msg: "Order not found" });

    if (order.status !== "reserved" && order.status !== "paid") {
      return res.status(409).json({ msg: "Cannot upload proofs for this order" });
    }

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ msg: "No files uploaded" });

    const saved = [];

    for (const f of files) {
      const okType =
        f.mimetype.startsWith("image/") ||
        f.mimetype === "application/pdf";

      if (!okType) continue;

      const filename = `proof_${id}_${Date.now()}_${f.originalname}`.replace(/\s+/g, "_");

   const uploadStream = gfsBucket.openUploadStream(filename, {
  contentType: f.mimetype,
  metadata: { orderId: id, kind: "proof", uploadedBy: req.user.username }
});

const fileId = uploadStream.id; // ✅

uploadStream.end(f.buffer);

await new Promise((resolve, reject) => {
  uploadStream.on("finish", resolve);
  uploadStream.on("error", reject);
});


      const meta = {
        fileId,
        filename,
        mimetype: f.mimetype,
        size: f.size,
        uploadedAt: new Date(),
        uploadedBy: req.user.username
      };

      order.proofs.push(meta);
      saved.push(meta);
    }

    await order.save();

    await audit(req.user.username, req.user.role, "PROOF_UPLOAD", "order", String(order._id), { count: saved.length });

    res.json({ ok: true, saved });
  } catch (e) {
    res.status(500).json({ msg: "Upload failed", error: e.message });
  }
});

// View/download a stored file from GridFS
app.get("/api/files/:fileId", requireAuth, async (req, res) => {
  try {
    const fileId = new mongoose.Types.ObjectId(req.params.fileId);

    // Find file doc
    const files = await mongoose.connection.db
      .collection("uploads.files")
      .find({ _id: fileId })
      .toArray();

    if (!files.length) return res.status(404).send("File not found");

    const file = files[0];
    res.setHeader("Content-Type", file.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${file.filename || "file"}"`);

    gfsBucket.openDownloadStream(fileId).pipe(res);
  } catch (e) {
    res.status(500).send("File read error");
  }
});

// Mark paid -> generate receipt no + PDF (cashier/admin)



app.post("/api/orders/:id/pay", requireAuth, requireRole("cashier", "admin"), async (req, res) => {

      if (!gfsBucket) {
  return res.status(503).json({
    msg: "Receipt storage not ready. Please retry."
  });
}
  try {


    const id = req.params.id;
    const { method } = req.body || {};
    const allowed = ["cash", "card", "qr", "transfer", "credit card", "cheque"];

    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ msg: "Order not found" });
    if (order.status !== "reserved") return res.status(409).json({ msg: "Only reserved orders can be paid" });

    const payMethod = String(method || "").toLowerCase().trim();
    if (!allowed.includes(payMethod)) {
      return res.status(400).json({ msg: "Invalid payment method" });
    }

    const receiptNo = receiptNoFactory();

    // Generate PDF to buffer then stream to GridFS
const doc = new PDFDocument({ size: "A4", margin: 48 });
const chunks = [];
doc.on("data", (c) => chunks.push(c));

// ---------- helpers ----------
const money = (n) => `RM ${Number(n || 0).toFixed(2)}`;
const hr = (y) => {
  doc
    .moveTo(48, y)
    .lineTo(doc.page.width - 48, y)
    .lineWidth(1)
    .strokeColor("#E5E7EB")
    .stroke();
};

// ---------- header (logo + title) ----------
const logoPath = path.join(__dirname, "public", "assets", "logo.png");
const startY = 48;

// logo (safe)
try {
  doc.image(logoPath, 48, startY, { width: 64 });
} catch (e) {
  // ignore if logo missing
}

doc
  .font("Helvetica-Bold")
  .fontSize(18)
  .fillColor("#111827")
  .text("KYANZ Exhibition Receipt", 120, startY + 6);

doc
  .font("Helvetica")
  .fontSize(10)
  .fillColor("#6B7280")
  .text("Official Receipt", 120, startY + 30);

// right meta
const rightX = doc.page.width - 48 - 220;
doc
  .font("Helvetica")
  .fontSize(10)
  .fillColor("#111827")
  .text(`Receipt No: ${receiptNo}`, rightX, startY + 6, { width: 220, align: "right" })
  .fillColor("#6B7280")
  .text(`Date: ${new Date().toLocaleString()}`, rightX, startY + 22, { width: 220, align: "right" })
  .text(`Order ID: ${order._id}`, rightX, startY + 38, { width: 220, align: "right" });

hr(startY + 70);
doc.moveDown(2);

// ---------- panels ----------
const panelTop = doc.y;
const panelW = (doc.page.width - 48 * 2 - 16) / 2;
const panelH = 104;

const drawPanel = (x, y, title, lines) => {
  doc
    .roundedRect(x, y, panelW, panelH, 10)
    .lineWidth(1)
    .strokeColor("#E5E7EB")
    .stroke();

  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#111827")
    .text(title, x + 12, y + 10);

  let ly = y + 30;
  doc.font("Helvetica").fontSize(10).fillColor("#111827");
  lines.forEach((t) => {
    doc.text(t, x + 12, ly, { width: panelW - 24 });
    ly += 16;
  });
};

drawPanel(48, panelTop, "Customer", [
  `Name: ${order.customerName || "-"}`,
  `Phone: ${order.phone || "-"}`,
  `Email: ${order.email ? order.email : "-"}`
]);

// ✅ Remarks below payment method (as you requested)
drawPanel(48 + panelW + 16, panelTop, "Payment", [
  `Promoter: ${order.createdBy || "-"}`,
  `Cashier: ${req.user.username || "-"}`,
  `Payment Method: ${String(payMethod || "-").toUpperCase()}`,
  `Remarks: ${order.remarks ? order.remarks : "-"}`
]);

doc.y = panelTop + panelH + 18;

// ---------- items table ----------
doc.font("Helvetica-Bold").fontSize(11).fillColor("#111827").text("Items");
doc.moveDown(0.5);

const tableX = 48;
const tableW = doc.page.width - 96;

const colItem = tableX;
const colQty = tableX + tableW * 0.58;
const colPrice = tableX + tableW * 0.70;
const colTotal = tableX + tableW * 0.84;

const headerY = doc.y;

doc
  .font("Helvetica-Bold")
  .fontSize(10)
  .fillColor("#6B7280")
  .text("Item", colItem, headerY)
  .text("Qty", colQty, headerY, { width: 40, align: "right" })
  .text("Unit", colPrice, headerY, { width: 70, align: "right" })
  .text("Total", colTotal, headerY, { width: 80, align: "right" });

hr(headerY + 16);
doc.moveDown(1);

// rows
doc.font("Helvetica").fontSize(10).fillColor("#111827");

(order.items || []).forEach((it) => {
  const lineY = doc.y;
  const qty = Number(it.qty || 0);
  const unit = Number(it.unitPrice || 0);
  const lineTotal = qty * unit;

  doc.text(it.name || "-", colItem, lineY, { width: (colQty - colItem) - 10 });
  doc.text(String(qty), colQty, lineY, { width: 40, align: "right" });
  doc.text(money(unit), colPrice, lineY, { width: 70, align: "right" });
  doc.text(money(lineTotal), colTotal, lineY, { width: 80, align: "right" });

  doc.moveDown(0.8);
});

hr(doc.y + 4);
doc.moveDown(1);

// totals
const overrideShown = order.overrideTotal !== null && order.overrideTotal !== undefined;
if (overrideShown) {
  doc.font("Helvetica").fontSize(10).fillColor("#111827");
  doc.text(`Bundle/Override Total: ${money(order.overrideTotal)}`, colTotal - 60, doc.y, { width: 140, align: "right" });
  doc.moveDown(0.4);
}

doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827");
doc.text(`Grand Total: ${money(order.finalTotal)}`, colTotal - 60, doc.y, { width: 140, align: "right" });

doc.moveDown(1.2);

// footer
hr(doc.y);
doc.moveDown(0.8);

doc
  .font("Helvetica")
  .fontSize(9)
  .fillColor("#6B7280")
  .text("Thank you for your purchase.", { align: "center" })
  .text("This receipt is system-generated.", { align: "center" });

doc.end();


    const pdfBuffer = await new Promise((resolve) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
    });

    const filename = `receipt_${receiptNo}.pdf`;

   const uploadStream = gfsBucket.openUploadStream(filename, {
  contentType: "application/pdf",
  metadata: {
    orderId: id,
    kind: "receipt",
    receiptNo,
    createdBy: req.user.username
  }
});

const pdfFileId = uploadStream.id; // ✅ always available

uploadStream.end(pdfBuffer);

await new Promise((resolve, reject) => {
  uploadStream.on("finish", resolve);
  uploadStream.on("error", reject);
});


    // Save payment & receipt
    order.status = "paid";
    order.payment.method = payMethod;
    order.payment.paidAt = new Date();
    order.payment.paidBy = req.user.username;

    order.receipt.receiptNo = receiptNo;
    order.receipt.pdfFileId = pdfFileId;

// ✅ create share token for public receipt link (only once)
if (!order.receiptShareToken) {
  order.receiptShareToken = crypto.randomBytes(16).toString("hex");
}

    
    await order.save();

    await audit(req.user.username, req.user.role, "ORDER_PAID_RECEIPT", "order", String(order._id), {
      receiptNo,
      pdfFileId: String(pdfFileId),
      method: payMethod
    });

    // Email placeholder (no sending yet)
    // Later: call real email service with receipt attachment.
    await audit("system", "system", "EMAIL_PLACEHOLDER", "order", String(order._id), {
      to: order.email || "",
      note: "Email sending not configured yet."
    });

    res.json({ ok: true, receiptNo, pdfFileId });
  } catch (e) {
    console.error("pay error:", e);
    res.status(500).json({ msg: "Payment failed", error: e.message });
  }
});

// End-of-day cancel unpaid (cashier/admin)
app.post("/api/endofday/cancel-unpaid", requireAuth, requireRole("cashier", "admin"), async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const unpaid = await Order.find({ status: "reserved" }).session(session);

    let cancelled = 0;

    for (const order of unpaid) {
      // return stock
      for (const it of order.items) {
        const p = await Product.findById(it.productId).session(session);
        if (p) {
          p.stock += Number(it.qty) || 0;
          await p.save({ session });
        }
      }

      order.status = "cancelled";
      order.cancelledBy = req.user.username;
      order.cancelledAt = new Date();
      await order.save({ session });

      cancelled++;
      await audit(req.user.username, req.user.role, "END_OF_DAY_CANCEL", "order", String(order._id), {});
    }

    await session.commitTransaction();
    res.json({ ok: true, cancelled });
  } catch (e) {
    await session.abortTransaction();
    res.status(500).json({ msg: "End-of-day failed", error: e.message });
  } finally {
    session.endSession();
  }
});

app.get("/r/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "");
    const order = await Order.findOne({ receiptShareToken: token });

    if (!order || !order.receipt || !order.receipt.pdfFileId) {
      return res.status(404).send("Receipt not found");
    }

    if (!gfsBucket) {
      return res.status(503).send("Receipt storage not ready");
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="KYANZ_Receipt_${order.receipt.receiptNo || "receipt"}.pdf"`
    );
    res.setHeader("Cache-Control", "no-store");

    const dl = gfsBucket.openDownloadStream(order.receipt.pdfFileId);

    dl.on("error", (err) => {
      console.error("Receipt download error:", err);
      if (!res.headersSent) res.status(404).send("Receipt file missing");
    });

    dl.pipe(res);
  } catch (e) {
    console.error("Public receipt error:", e);
    res.status(500).send("Server error");
  }
});



// Audit log (everyone can view; can restrict later)
app.get("/api/audit", requireAuth, async (req, res) => {
  const { q } = req.query || {};
  const filter = {};
  if (q) {
    const qq = String(q).trim();
    filter.$or = [
      { actor: new RegExp(qq, "i") },
      { action: new RegExp(qq, "i") },
      { entityId: new RegExp(qq, "i") }
    ];
  }

  const logs = await AuditLog.find(filter).sort({ at: -1 }).limit(300);
  res.json(logs);
});

// SPA fallback
app.get("*", (req, res) => {
  if (!res.headersSent) {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  }
});


// =======================
// Start
// =======================
async function start() {
  if (!MONGO_URI) {
    console.error("Missing MONGO_URI env var");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);


  console.log("MongoDB connected");
  await ensureSeedUsers();
  console.log("Default users ensured");

  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

start().catch((e) => {
  console.error("Startup error:", e);
  process.exit(1);
});
