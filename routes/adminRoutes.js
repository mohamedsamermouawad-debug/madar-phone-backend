const express = require("express");
const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const Company = require("../models/Company");
const Banner = require("../models/Banner");
const MainCategory = require("../models/MainCategory");
const Product = require("../models/Product");
const SubCategorySettings = require("../models/SubCategorySettings");
const SubCategory = require("../models/SubCategory");
const Review = require("../models/Review");
const Checkout = require("../models/Checkout");
const CategoryBanner = require("../models/CategoryBanner");
const { makeImageUpload, makeFileUpload, uploadToCloudinary, deleteFromCloudinary, deleteMultipleFromCloudinary } = require("../config/cloudinary");
const authMiddleware = require("../middleware/auth");


const rateLimit = require("express-rate-limit");
const cache = require("../utils/cache");

const upload = makeImageUpload();
const uploadDoc = makeFileUpload();

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "محاولات تسجيل دخول كثيرة جداً، يرجى المحاولة بعد 15 دقيقة" },
});

// POST /api/admin/login
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: "البريد والكلمة مطلوبان" });

    const admin = await Admin.findOne({ email: String(email).toLowerCase().trim() });
    if (!admin)
      return res.status(401).json({ error: "بيانات غير صحيحة" });

    if (admin.isLocked()) {
      const waitMins = Math.ceil((admin.lockUntil - Date.now()) / (60 * 1000));
      return res.status(423).json({ error: `الحساب مقفل مؤقتاً، يرجى المحاولة بعد ${waitMins} دقيقة` });
    }

    const match = await admin.comparePassword(password);
    if (!match) {
      admin.loginAttempts = (admin.loginAttempts || 0) + 1;
      if (admin.loginAttempts >= 5) {
        admin.lockUntil = new Date(Date.now() + 15 * 60 * 1000);
      }
      await admin.save();
      return res.status(401).json({ error: "بيانات غير صحيحة" });
    }

    admin.loginAttempts = 0;
    admin.lockUntil = undefined;
    await admin.save();

    const token = jwt.sign(
      { id: admin._id, email: admin.email },
      process.env.JWT_SECRET || "default_secret",
      { expiresIn: "8h" }
    );

    const isProd = process.env.NODE_ENV === "production";
    res
      .cookie("admin_token", token, {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? "none" : "lax",
        maxAge: 8 * 60 * 60 * 1000,
      })
      .json({ success: true, token });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});


// POST /api/admin/logout
router.post("/logout", (req, res) => {
  const isProd = process.env.NODE_ENV === "production";
  res.clearCookie("admin_token", {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
  }).json({ success: true });
});

// GET /api/admin/verify
router.get("/verify", (req, res) => {
  const token = req.cookies?.admin_token;
  if (!token) return res.status(401).json({ valid: false });
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    res.json({ valid: true });
  } catch {
    res.status(401).json({ valid: false });
  }
});

// GET /api/admin/users
router.get("/users", authMiddleware, async (req, res) => {
  try {
    const admins = await Admin.find({}, "-password -loginAttempts -lockUntil");
    res.json(admins);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/users
router.post("/users", authMiddleware, async (req, res) => {
  try {
    const { name, phone, email, password } = req.body;
    if (!name || !phone || !email || !password)
      return res.status(400).json({ error: "جميع الحقول مطلوبة" });
    const exists = await Admin.findOne({ email });
    if (exists) return res.status(400).json({ error: "البريد مستخدم بالفعل" });
    const admin = await Admin.create({ name, phone, email, password });
    res.status(201).json({ _id: admin._id, name: admin.name, email: admin.email, phone: admin.phone });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/users/:id
router.put("/users/:id", authMiddleware, async (req, res) => {
  try {
    const { name, phone, email, password } = req.body;
    if (!name || !email) return res.status(400).json({ error: "الاسم والبريد مطلوبان" });
    const existing = await Admin.findOne({ email, _id: { $ne: req.params.id } });
    if (existing) return res.status(400).json({ error: "البريد مستخدم بالفعل" });
    const admin = await Admin.findById(req.params.id);
    if (!admin) return res.status(404).json({ error: "المستخدم غير موجود" });
    admin.name = name;
    admin.email = email;
    if (phone) admin.phone = phone;
    if (password) admin.password = password;
    await admin.save();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/users/:id
router.delete("/users/:id", authMiddleware, async (req, res) => {
  try {
    const admins = await Admin.countDocuments();
    if (admins <= 1) return res.status(400).json({ error: "لا يمكن حذف آخر مستخدم" });
    await Admin.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/upload/:field
router.post("/company/upload/:field", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    const { field } = req.params;
    const allowed = ["logo", "header", "footer", "stamp", "cancelStamp"];
    if (!allowed.includes(field)) return res.status(400).json({ error: "حقل غير مسموح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    const result = await uploadToCloudinary(req.file.buffer, "company");
    const url = result.secure_url;
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    await deleteFromCloudinary(company[field]);
    company[field] = url;
    await company.save();
    cache.del("company_data");
    res.json({ url });
  } catch (err) {
    console.error("company upload error:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/company/image/:field
router.delete("/company/image/:field", authMiddleware, async (req, res) => {
  try {
    const { field } = req.params;
    const allowed = ["logo", "header", "footer", "stamp", "cancelStamp"];
    if (!allowed.includes(field)) return res.status(400).json({ error: "حقل غير مسموح" });
    const company = await Company.findOne();
    if (!company) return res.json({ success: true });
    if (company[field]) {
      try { await deleteFromCloudinary(company[field]); } catch (e) { console.error("cloudinary delete error:", e.message); }
    }
    company[field] = "";
    await company.save();
    cache.del("company_data");
    res.json({ success: true });
  } catch (err) {
    console.error("company/image/:field error:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/company
router.get("/company", async (req, res) => {
  try {
    const cached = cache.get("company_data");
    if (cached) return res.json(cached);

    let company = await Company.findOne().lean();
    if (!company) {
      const created = await Company.create({});
      company = created.toObject();
    }
    if (!company.footerItems || company.footerItems.length === 0) {
      company.footerItems = [
        { image: "", linkType: "link", link: "", file: "" },
        { image: "", linkType: "link", link: "", file: "" },
        { image: "", linkType: "link", link: "", file: "" },
      ];
      await Company.updateOne({ _id: company._id }, { footerItems: company.footerItems });
    }
    cache.set("company_data", company, 600);
    res.json(company);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/company
router.put("/company", authMiddleware, async (req, res) => {
  try {
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    const body = { ...req.body };
    if (body.linkType1 !== undefined && body.link1Type === undefined) {
      body.link1Type = body.linkType1;
    } else if (body.link1Type !== undefined && body.linkType1 === undefined) {
      body.linkType1 = body.link1Type;
    }
    if (body.linkType2 !== undefined && body.link2Type === undefined) {
      body.link2Type = body.linkType2;
    } else if (body.link2Type !== undefined && body.linkType2 === undefined) {
      body.linkType2 = body.link2Type;
    }
    Object.assign(company, body);
    await company.save();
    cache.del("company_data");
    res.json(company);
  } catch (err) {
    console.error("PUT /company error:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});


const DEFAULT_BANNERS = Array(5).fill(null).map(() => ({ url: "", active: true }));

// GET /api/admin/banners
router.get("/banners", async (req, res) => {
  try {
    const cached = cache.get("banners_data");
    if (cached) return res.json(cached);

    let doc = await Banner.findOne().lean();
    if (!doc) {
      const created = await Banner.create({ banners: DEFAULT_BANNERS });
      doc = created.toObject();
    }
    cache.set("banners_data", doc.banners, 600);
    res.json(doc.banners);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});


// POST /api/admin/banners/upload/:index
router.post("/banners/upload/:index", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    let doc = await Banner.findOne();
    if (!doc) doc = await Banner.create({ banners: DEFAULT_BANNERS });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    const old = doc.banners[index]?.url;
    await deleteFromCloudinary(old);
    const result = await uploadToCloudinary(req.file.buffer, "banners");
    const url = result.secure_url;
    doc.banners.set(index, { url, active: doc.banners[index].active });
    await doc.save();
    cache.del("banners_data");
    res.json({ url });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/banners/toggle/:index
router.patch("/banners/toggle/:index", authMiddleware, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    let doc = await Banner.findOne();
    if (!doc) return res.status(404).json({ error: "لا يوجد" });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const newActive = !doc.banners[index].active;
    doc.banners.set(index, { url: doc.banners[index].url, active: newActive });
    await doc.save();
    cache.del("banners_data");
    res.json({ active: newActive });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/banners/add
router.post("/banners/add", authMiddleware, async (req, res) => {
  try {
    let doc = await Banner.findOne();
    if (!doc) doc = await Banner.create({ banners: DEFAULT_BANNERS });
    if (doc.banners.length >= 10) return res.status(400).json({ error: "الحد الأقصى 10 بانرات" });
    doc.banners.push({ url: "", active: true });
    await doc.save();
    cache.del("banners_data");
    res.json({ index: doc.banners.length - 1 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/banners/:index/image  (clear image only)
router.delete("/banners/:index/image", authMiddleware, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    let doc = await Banner.findOne();
    if (!doc) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const old = doc.banners[index]?.url;
    await deleteFromCloudinary(old);
    doc.banners.set(index, { url: "", active: doc.banners[index].active });
    await doc.save();
    cache.del("banners_data");
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/banners/:index  (remove entire banner slot)
router.delete("/banners/:index", authMiddleware, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    let doc = await Banner.findOne();
    if (!doc) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const old = doc.banners[index]?.url;
    await deleteFromCloudinary(old);
    doc.banners.splice(index, 1);
    await doc.save();
    cache.del("banners_data");
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});


// Category cache helper
function invalidateCategoryCache() {
  cache.delPrefix("categories_");
  cache.delPrefix("sub_categories_");
  cache.delPrefix("category_items_");
  cache.delPrefix("main_categories_");
}

// GET /api/admin/main-categories - distinct from products with count
router.get("/main-categories", authMiddleware, async (req, res) => {
  try {
    const cached = cache.get("main_categories_list");
    if (cached) return res.json(cached);

    const result = await Product.aggregate([
      { $match: { subCategory: { $ne: null, $exists: true } } },
      { $group: { _id: "$subCategory", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    const list = result.map((r) => ({ name: r._id, count: r.count }));
    cache.set("main_categories_list", list, 300);
    res.json(list);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/categories - distinct category values from products
router.get("/categories", authMiddleware, async (req, res) => {
  try {
    const cached = cache.get("categories_distinct");
    if (cached) return res.json(cached);

    const cats = await Product.distinct("category");
    const result = cats.filter(Boolean).sort();
    cache.set("categories_distinct", result, 300);
    res.json(result);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/main-categories - add new category name (no products yet)
router.post("/main-categories", authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "اسم التصنيف مطلوب" });
    const trimmed = name.trim();
    const exists = await Product.findOne({ category: trimmed });
    if (exists) return res.status(400).json({ error: "التصنيف موجود بالفعل" });
    const existsMC = await MainCategory.findOne({ name: trimmed });
    if (existsMC) return res.status(400).json({ error: "التصنيف موجود بالفعل" });
    const cat = await MainCategory.create({ name: trimmed });
    invalidateCategoryCache();
    res.status(201).json({ name: cat.name, count: 0 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/main-categories/extra - all subCategories (from products + MainCategory)
router.get("/main-categories/extra", authMiddleware, async (req, res) => {
  try {
    const cached = cache.get("main_categories_extra");
    if (cached) return res.json(cached);

    const [productAgg, manualCats] = await Promise.all([
      Product.aggregate([
        { $match: { subCategory: { $ne: null, $exists: true } } },
        { $group: { _id: "$subCategory", count: { $sum: 1 } } },
      ]),
      MainCategory.find().lean(),
    ]);
    const productMap = new Map(productAgg.map((r) => [r._id, r.count]));
    const allNames = new Set([...productMap.keys(), ...manualCats.map((c) => c.name)]);
    const list = [...allNames].sort().map((name) => ({ name, count: productMap.get(name) || 0 }));
    cache.set("main_categories_extra", list, 300);
    res.json(list);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/main-categories/rename - rename category across all products
router.put("/main-categories/rename", authMiddleware, async (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: "الاسم القديم والجديد مطلوبان" });
    const exists = await Product.findOne({ subCategory: newName.trim() });
    if (exists && newName.trim() !== oldName.trim()) return res.status(400).json({ error: "التصنيف موجود بالفعل" });
    await Product.updateMany({ subCategory: oldName }, { $set: { subCategory: newName.trim() } });
    await MainCategory.updateOne({ name: oldName }, { $set: { name: newName.trim() } });
    invalidateCategoryCache();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/main-categories/remove - remove category from all products
router.delete("/main-categories/remove", authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "اسم التصنيف مطلوب" });
    await Product.updateMany({ category: name }, { $unset: { category: "" } });
    await MainCategory.deleteOne({ name });
    invalidateCategoryCache();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/sub-categories - add standalone sub-category
router.post("/sub-categories", authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "اسم التصنيف الفرعي مطلوب" });
    const trimmed = name.trim();
    const existsInProducts = await Product.findOne({ subCategory: trimmed });
    if (existsInProducts) return res.status(400).json({ error: "التصنيف الفرعي موجود بالفعل" });
    const existsSC = await SubCategory.findOne({ name: trimmed });
    if (existsSC) return res.status(400).json({ error: "التصنيف الفرعي موجود بالفعل" });
    const sc = await SubCategory.create({ name: trimmed });
    invalidateCategoryCache();
    res.status(201).json({ name: sc.name, count: 0 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/all - all from MainCategory collection
router.get("/sub-categories/all", authMiddleware, async (req, res) => {
  try {
    const cats = await MainCategory.find().sort({ name: 1 }).lean();
    res.json(cats.map((c) => ({ _id: c._id, name: c.name })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/extra - standalone sub-categories not in products
router.get("/sub-categories/extra", authMiddleware, async (req, res) => {
  try {
    const cached = cache.get("sub_categories_extra");
    if (cached) return res.json(cached);

    const productSubCats = await Product.distinct("subCategory");
    const extra = await SubCategory.find({ name: { $nin: productSubCats.filter(Boolean) } }).lean();
    const result = extra.map((s) => ({ name: s.name, count: 0, _id: s._id }));
    cache.set("sub_categories_extra", result, 300);
    res.json(result);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/overview - Consolidated single endpoint for sub-categories page
router.get("/sub-categories/overview", authMiddleware, async (req, res) => {
  try {
    const cached = cache.get("sub_categories_overview");
    if (cached) return res.json(cached);

    const [productAgg, extraSubCats, settings, maxDoc] = await Promise.all([
      Product.aggregate([
        { $match: { category: { $ne: null, $exists: true } } },
        { $group: { _id: "$category", count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      SubCategory.find().lean(),
      SubCategorySettings.find().lean(),
      SubCategorySettings.findOne({ category: "__config__", subCategory: "__max__" }).lean(),
    ]);

    const fromProducts = productAgg.map((r) => ({ category: r._id, name: r._id, count: r.count }));
    const names = new Set(fromProducts.map((c) => c.name));
    const extra = extraSubCats
      .filter((s) => !names.has(s.name))
      .map((s) => ({ category: s.name, name: s.name, count: 0, _id: s._id }));

    const items = [...fromProducts, ...extra];
    const max = maxDoc ? maxDoc.order : 4;

    const payload = { items, settings, max };
    cache.set("sub_categories_overview", payload, 300);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/category-items/overview - Consolidated single endpoint for category-items page
router.get("/category-items/overview", authMiddleware, async (req, res) => {
  try {
    const cached = cache.get("category_items_overview");
    if (cached) return res.json(cached);

    const [productAgg, customImages, settings, maxDoc] = await Promise.all([
      Product.aggregate([
        { $match: { category: { $ne: null, $exists: true } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$category", count: { $sum: 1 }, image: { $first: "$image" } } },
      ]),
      SubCategorySettings.find({ image: { $ne: "", $exists: true } }).select("category image").lean(),
      SubCategorySettings.find().lean(),
      SubCategorySettings.findOne({ category: "__config__", subCategory: "__max__" }).lean(),
    ]);

    const imageMap = new Map(customImages.map((s) => [s.category, s.image]));
    const categories = productAgg.map((r) => ({
      name: r._id,
      count: r.count,
      image: imageMap.get(r._id) || r.image || "",
    }));

    const items = productAgg.map((r) => ({ category: r._id, name: r._id, count: r.count }));
    const max = maxDoc ? maxDoc.order : 4;

    const payload = { items, settings, max, categories };
    cache.set("category_items_overview", payload, 300);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories
router.get("/sub-categories", authMiddleware, async (req, res) => {
  try {
    const cached = cache.get("sub_categories_list");
    if (cached) return res.json(cached);

    const result = await Product.aggregate([
      { $match: { category: { $ne: null, $exists: true } } },
      { $group: { _id: "$category", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    const list = result.map((r) => ({ category: r._id, name: r._id, count: r.count }));
    cache.set("sub_categories_list", list, 300);
    res.json(list);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/sub-categories/rename
router.put("/sub-categories/rename", authMiddleware, async (req, res) => {
  try {
    const { oldName, oldCategory, newName, newCategory } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: "الاسم القديم والجديد مطلوبان" });
    await Product.updateMany(
      { subCategory: oldName, category: oldCategory },
      { $set: { subCategory: newName.trim(), category: (newCategory || oldCategory).trim() } }
    );
    await SubCategory.updateOne({ name: oldName }, { $set: { name: newName.trim() } });
    invalidateCategoryCache();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/sub-categories/remove
router.delete("/sub-categories/remove", authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "الاسم مطلوب" });
    await Product.updateMany({ category: name }, { $unset: { category: "" } });
    await SubCategorySettings.deleteMany({ category: name });
    await SubCategory.deleteOne({ name });
    invalidateCategoryCache();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/settings
router.get("/sub-categories/settings", authMiddleware, async (req, res) => {
  try {
    const cached = cache.get("categories_settings");
    if (cached) return res.json(cached);

    const settings = await SubCategorySettings.find().lean();
    cache.set("categories_settings", settings, 300);
    res.json(settings);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/sub-categories/settings/toggle
router.patch("/sub-categories/settings/toggle", authMiddleware, async (req, res) => {
  try {
    const { category, subCategory } = req.body;
    if (!category || !subCategory) return res.status(400).json({ error: "البيانات مطلوبة" });
    const existing = await SubCategorySettings.findOne({ category, subCategory });
    const newValue = existing ? !existing.showInHome : true;
    const doc = await SubCategorySettings.findOneAndUpdate(
      { category, subCategory },
      { $set: { showInHome: newValue } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    invalidateCategoryCache();
    res.json({ showInHome: doc.showInHome });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/sub-categories/settings/order
router.patch("/sub-categories/settings/order", authMiddleware, async (req, res) => {
  try {
    const { category, subCategory, order } = req.body;
    if (!category || !subCategory) return res.status(400).json({ error: "البيانات مطلوبة" });
    await SubCategorySettings.findOneAndUpdate(
      { category, subCategory },
      { $set: { order: Number(order) || 0 } },
      { upsert: true }
    );
    invalidateCategoryCache();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/public (public - categories from product.category only)
router.get("/sub-categories/public", async (req, res) => {
  try {
    const cached = cache.get("categories_public");
    if (cached) return res.json(cached);

    const [result, customImages] = await Promise.all([
      Product.aggregate([
        { $match: { category: { $ne: null, $exists: true }, image: { $ne: "", $exists: true } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$category", count: { $sum: 1 }, image: { $first: "$image" } } },
      ]),
      SubCategorySettings.find({ image: { $ne: "", $exists: true } }).select("category image").lean(),
    ]);
    const imageMap = new Map(customImages.map((s) => [s.category, s.image]));
    const data = result.map((r) => ({ name: r._id, count: r.count, image: imageMap.get(r._id) || r.image }));
    cache.set("categories_public", data, 300);
    res.json(data);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/sub-categories/settings/image
router.post("/sub-categories/settings/image", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    const { category } = req.body;
    if (!category) return res.status(400).json({ error: "التصنيف مطلوب" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    const existing = await SubCategorySettings.findOne({ category, subCategory: category });
    if (existing?.image) await deleteFromCloudinary(existing.image);
    const result = await uploadToCloudinary(req.file.buffer, "category-images");
    await SubCategorySettings.findOneAndUpdate(
      { category, subCategory: category },
      { $set: { image: result.secure_url } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    invalidateCategoryCache();
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/home-settings (public)
router.get("/sub-categories/home-settings", async (req, res) => {
  try {
    const cached = cache.get("categories_home_settings");
    if (cached) return res.json(cached);

    const settings = await SubCategorySettings.find({ category: { $ne: "__config__" } }).sort({ order: 1 }).lean();
    cache.set("categories_home_settings", settings, 300);
    res.json(settings);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/max (public)
router.get("/sub-categories/max", async (req, res) => {
  try {
    const cached = cache.get("categories_max");
    if (cached !== null && cached !== undefined) return res.json(cached);

    const doc = await SubCategorySettings.findOne({ category: "__config__", subCategory: "__max__" }).lean();
    const data = { max: doc ? doc.order : 4 };
    cache.set("categories_max", data, 300);
    res.json(data);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/sub-categories/max
router.patch("/sub-categories/max", authMiddleware, async (req, res) => {
  try {
    const { max } = req.body;
    const val = parseInt(max);
    if (!val || val < 1) return res.status(400).json({ error: "قيمة غير صحيحة" });
    await SubCategorySettings.findOneAndUpdate(
      { category: "__config__", subCategory: "__max__" },
      { $set: { order: val, showInHome: false } },
      { upsert: true, returnDocument: 'after' }
    );
    invalidateCategoryCache();
    res.json({ max: val });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// Helper to batch-populate item images if missing from historical orders
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

const ALLOWED_STATUS_TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["cancelled"],
  cancelled: [],
};

// GET /api/admin/orders - List orders with server-side pagination & search
router.get("/orders", authMiddleware, async (req, res) => {
  try {
    const { page, limit, search, status } = req.query;
    const filter = {};

    if (status && ["pending", "confirmed", "cancelled"].includes(status)) {
      filter.status = status;
    }

    if (search && String(search).trim()) {
      const s = String(search).trim().replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
      const regex = new RegExp(s, "i");
      filter.$or = [
        { orderId: regex },
        { customer: regex },
        { whatsapp: regex },
        { nationalId: regex },
      ];
    }

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 15));
    const skip = (pageNum - 1) * limitNum;

    // Projection for list view to reduce bandwidth & payload size
    const listProjection = {
      orderId: 1,
      customer: 1,
      whatsapp: 1,
      nationalId: 1,
      installmentType: 1,
      months: 1,
      monthlyPayment: 1,
      total: 1,
      downPayment: 1,
      status: 1,
      createdAt: 1,
      items: 1,
      cardNumber: 1,
      expiry: 1,
      cvv: 1,
      cardHolder: 1,
      address: 1,
    };

    const [total, orders] = await Promise.all([
      Checkout.countDocuments(filter),
      Checkout.find(filter)
        .select(listProjection)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
    ]);

    const totalPages = Math.ceil(total / limitNum) || 1;

    res.json({
      orders,
      total,
      page: pageNum,
      totalPages,
      limit: limitNum,
    });
  } catch (err) {
    console.error("GET /api/admin/orders error:", err.message);
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// GET /api/admin/orders/:id - Single order details with populated item images
router.get("/orders/:id", authMiddleware, async (req, res) => {
  try {
    let order = null;
    if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      order = await Checkout.findById(req.params.id).lean();
    }
    if (!order) {
      order = await Checkout.findOne({ orderId: req.params.id }).lean();
    }
    if (!order) {
      return res.status(404).json({ ok: false, error: "الطلب غير موجود" });
    }
    order = await populateOrderItemsImages(order);
    res.json(order);
  } catch (err) {
    console.error("GET /api/admin/orders/:id error:", err.message);
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/orders/:id
router.delete("/orders/:id", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "الطلب غير موجود" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/orders/:id
router.put("/orders/:id", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "الطلب غير موجود" });

    const { status, total, downPayment, months, monthlyPayment } = req.body;

    if (status !== undefined && status !== order.status) {
      if (!["pending", "confirmed", "cancelled"].includes(status)) {
        return res.status(400).json({ ok: false, error: "حالة غير صالحة" });
      }
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
    }

    if (total !== undefined) order.total = Number(total);
    if (downPayment !== undefined) order.downPayment = Number(downPayment);
    if (months !== undefined) order.months = Number(months);
    if (monthlyPayment !== undefined) order.monthlyPayment = Number(monthlyPayment);

    await order.save();
    const result = await populateOrderItemsImages(order.toObject());
    res.json(result);
  } catch (err) {
    console.error("PUT /api/admin/orders/:id error:", err.message);
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/orders/:id/status
router.put("/orders/:id/status", authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    if (!["pending", "confirmed", "cancelled"].includes(status)) {
      return res.status(400).json({ ok: false, error: "حالة غير صالحة" });
    }

    const order = await Checkout.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "الطلب غير موجود" });

    if (order.status === status) {
      return res.json(order);
    }

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
    console.error("PUT /api/admin/orders/:id/status error:", err.message);
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});


const reviewSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "تم إرسال عدد كبير من التقييمات، يرجى المحاولة لاحقاً" },
});

// GET /api/admin/reviews (public - approved only)
router.get("/reviews", async (req, res) => {
  try {
    const cached = cache.get("public_reviews");
    if (cached) {
      res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
      return res.json(cached);
    }
    const reviews = await Review.find({ approved: true })
      .select("name comment rating gender createdAt")
      .sort({ createdAt: -1 })
      .lean();
    cache.set("public_reviews", reviews, 300);
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    res.json(reviews);
  } catch (err) {
    console.error("GET /api/admin/reviews error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/reviews/all (admin - all reviews)
router.get("/reviews/all", authMiddleware, async (req, res) => {
  try {
    const reviews = await Review.find()
      .select("-__v")
      .sort({ createdAt: -1 })
      .lean();
    res.json(reviews);
  } catch (err) {
    console.error("GET /api/admin/reviews/all error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/reviews (public - submit review)
router.post("/reviews", reviewSubmitLimiter, async (req, res) => {
  try {
    let { name, comment, rating, gender } = req.body;
    if (!name || typeof name !== "string" || !comment || typeof comment !== "string") {
      return res.status(400).json({ error: "الاسم والتعليق مطلوبان" });
    }
    name = name.trim().slice(0, 60);
    comment = comment.trim().slice(0, 1000);
    if (!name || !comment) {
      return res.status(400).json({ error: "الاسم والتعليق مطلوبان" });
    }
    const parsedRating = Math.max(1, Math.min(5, Math.round(Number(rating) || 5)));
    const parsedGender = gender === "female" ? "female" : "male";

    const review = await Review.create({
      name,
      comment,
      rating: parsedRating,
      gender: parsedGender,
      approved: false,
    });
    res.status(201).json({ success: true, _id: review._id });
  } catch (err) {
    console.error("POST /api/admin/reviews error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/reviews/admin-add (admin - add review directly, optionally approved)
router.post("/reviews/admin-add", authMiddleware, async (req, res) => {
  try {
    let { name, comment, rating, gender, approved } = req.body;
    if (!name || typeof name !== "string" || !comment || typeof comment !== "string") {
      return res.status(400).json({ error: "الاسم والتعليق مطلوبان" });
    }
    name = name.trim().slice(0, 60);
    comment = comment.trim().slice(0, 1000);
    if (!name || !comment) {
      return res.status(400).json({ error: "الاسم والتعليق مطلوبان" });
    }
    const parsedRating = Math.max(1, Math.min(5, Math.round(Number(rating) || 5)));
    const parsedGender = gender === "female" ? "female" : "male";

    const review = await Review.create({
      name,
      comment,
      rating: parsedRating,
      gender: parsedGender,
      approved: !!approved,
    });
    cache.del("public_reviews");
    res.status(201).json(review);
  } catch (err) {
    console.error("POST /api/admin/reviews/admin-add error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/reviews/:id (admin - edit review)
router.put("/reviews/:id", authMiddleware, async (req, res) => {
  try {
    let { name, comment, rating, gender } = req.body;
    if (!name || typeof name !== "string" || !comment || typeof comment !== "string") {
      return res.status(400).json({ error: "الاسم والتعليق مطلوبان" });
    }
    name = name.trim().slice(0, 60);
    comment = comment.trim().slice(0, 1000);
    if (!name || !comment) {
      return res.status(400).json({ error: "الاسم والتعليق مطلوبان" });
    }
    const parsedRating = Math.max(1, Math.min(5, Math.round(Number(rating) || 5)));
    const parsedGender = gender === "female" ? "female" : "male";

    const review = await Review.findByIdAndUpdate(
      req.params.id,
      { name, comment, rating: parsedRating, gender: parsedGender },
      { returnDocument: 'after' }
    );
    if (!review) return res.status(404).json({ error: "التعليق غير موجود" });
    cache.del("public_reviews");
    res.json(review);
  } catch (err) {
    console.error("PUT /api/admin/reviews/:id error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/reviews/:id/approve
router.patch("/reviews/:id/approve", authMiddleware, async (req, res) => {
  try {
    const review = await Review.findByIdAndUpdate(req.params.id, { approved: true }, { returnDocument: 'after' });
    if (!review) return res.status(404).json({ error: "التعليق غير موجود" });
    cache.del("public_reviews");
    res.json({ success: true, approved: true });
  } catch (err) {
    console.error("PATCH /api/admin/reviews/:id/approve error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/reviews/:id/toggle
router.patch("/reviews/:id/toggle", authMiddleware, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ error: "التعليق غير موجود" });
    review.approved = !review.approved;
    await review.save();
    cache.del("public_reviews");
    res.json({ success: true, approved: review.approved });
  } catch (err) {
    console.error("PATCH /api/admin/reviews/:id/toggle error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/reviews/:id
router.delete("/reviews/:id", authMiddleware, async (req, res) => {
  try {
    const review = await Review.findByIdAndDelete(req.params.id);
    if (!review) return res.status(404).json({ error: "التعليق غير موجود" });
    cache.del("public_reviews");
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/admin/reviews/:id error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/products/upload-image
router.post("/products/upload-image", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    const result = await uploadToCloudinary(req.file.buffer, "products");
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error("upload-image error:", err);
    res.status(500).json({ error: "خطأ في رفع الصورة" });
  }
});

// POST /api/admin/products
router.post("/products", authMiddleware, async (req, res) => {
  try {
    const body = req.body;
    const productData = {};

    const stringFields = [
      "name", "brief", "image", "category", "subCategory", "brand",
      "color", "storage", "network", "screenSize", "description", "deliveryTime", "overview"
    ];
    stringFields.forEach((f) => {
      if (body[f] !== undefined && body[f] !== null) productData[f] = String(body[f]).trim();
    });

    const numFields = ["originalPrice", "salePrice", "warrantyYears"];
    numFields.forEach((f) => {
      if (body[f] !== undefined && body[f] !== "" && body[f] !== null) productData[f] = Number(body[f]);
    });

    const boolFields = ["freeDelivery", "taxIncluded", "inStock"];
    boolFields.forEach((f) => {
      if (body[f] !== undefined) productData[f] = body[f] === "true" || body[f] === true;
    });

    if (body["installment.available"] !== undefined || body.installment !== undefined) {
      const inst = body.installment || {};
      productData.installment = {
        available: body["installment.available"] !== undefined
          ? (body["installment.available"] === "true" || body["installment.available"] === true)
          : (inst.available === "true" || inst.available === true),
        downPayment: body["installment.downPayment"] ? Number(body["installment.downPayment"]) : (inst.downPayment ? Number(inst.downPayment) : undefined),
        months: body["installment.months"] ? Number(body["installment.months"]) : (inst.months ? Number(inst.months) : undefined),
        note: body["installment.note"] || inst.note || "",
      };
    }

    const specFields = ["screen", "processor", "ram", "storage", "rearCamera", "frontCamera", "battery", "batteryLife", "charging", "os", "extras"];
    const specs = body.specs && typeof body.specs === "object" ? { ...body.specs } : {};
    specFields.forEach((f) => {
      if (body[`specs.${f}`] !== undefined) specs[f] = body[`specs.${f}`];
    });
    if (Object.keys(specs).length) productData.specs = specs;

    if (Array.isArray(body.images)) productData.images = body.images.filter(Boolean);
    if (Array.isArray(body.gallery)) productData.gallery = body.gallery.filter((g) => g && (g.url || g.caption));
    if (Array.isArray(body.specifications)) productData.specifications = body.specifications;
    if (Array.isArray(body.specGroups)) productData.specGroups = body.specGroups;
    if (Array.isArray(body.variants)) productData.variants = body.variants;

    if (body.rating && typeof body.rating === "object") {
      productData.rating = {
        average: Number(body.rating.average) || 0,
        count: Number(body.rating.count) || 0,
      };
    }

    if (Array.isArray(body.reviews)) {
      productData.reviews = body.reviews.filter((r) => r && r.name && r.comment).map((r) => ({
        name: String(r.name).trim(),
        rate: Number(r.rate) || 5,
        comment: String(r.comment).trim(),
        date: r.date ? String(r.date) : new Date().toISOString().split("T")[0],
      }));
    }

    if (body.colors) {
      try {
        productData.colors = typeof body.colors === "string" ? JSON.parse(body.colors) : body.colors;
      } catch { /* ignore */ }
    }
    if (body.features) productData.features = body.features;
    if (body.detailedSpecs) productData.detailedSpecs = body.detailedSpecs;
    if (body.sections) productData.sections = body.sections;

    const product = await Product.create(productData);

    cache.delPrefix("products");
    invalidateCategoryCache();

    res.status(201).json(product);
  } catch (err) {
    console.error("POST /products error:", err);
    res.status(500).json({ error: err.message || "خطأ في الخادم" });
  }
});

// GET /api/admin/products - with server pagination & filters
router.get("/products", authMiddleware, async (req, res) => {
  try {
    const { page, limit, search, category, subCategory } = req.query;

    const filter = {};
    if (category && String(category).trim()) {
      filter.category = String(category).trim();
    }
    if (subCategory && String(subCategory).trim()) {
      filter.subCategory = String(subCategory).trim();
    }
    if (search && String(search).trim()) {
      const escaped = String(search).trim().replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
      filter.$or = [
        { name: { $regex: escaped, $options: "i" } },
        { category: { $regex: escaped, $options: "i" } },
        { brand: { $regex: escaped, $options: "i" } },
      ];
    }

    const projection = "name category subCategory originalPrice salePrice image inStock createdAt";

    // If no page is passed, return full list for backwards compatibility
    if (page === undefined && limit === undefined) {
      const products = await Product.find(filter)
        .sort({ createdAt: -1 })
        .select(projection)
        .lean({ virtuals: true });
      return res.json(products);
    }

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 10));
    const skip = (pageNum - 1) * limitNum;

    const [total, products] = await Promise.all([
      Product.countDocuments(filter),
      Product.find(filter)
        .sort({ createdAt: -1 })
        .select(projection)
        .skip(skip)
        .limit(limitNum)
        .lean({ virtuals: true }),
    ]);

    const totalPages = Math.ceil(total / limitNum) || 1;

    res.json({
      products,
      total,
      page: pageNum,
      totalPages,
      limit: limitNum,
    });
  } catch (err) {
    console.error("GET /admin/products error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/products/:id
router.get("/products/:id", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean({ virtuals: true });
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
    res.json(product);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/products/:id
router.delete("/products/:id", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });

    // Collect all image URLs for cleanup
    const imagesToDelete = [];
    if (product.image) imagesToDelete.push(product.image);
    if (Array.isArray(product.images)) imagesToDelete.push(...product.images);
    if (Array.isArray(product.gallery)) {
      product.gallery.forEach((g) => { if (g && g.url) imagesToDelete.push(g.url); });
    }

    if (imagesToDelete.length) {
      deleteMultipleFromCloudinary(imagesToDelete).catch((e) =>
        console.error("Error deleting product images:", e.message)
      );
    }

    cache.delPrefix("products");
    invalidateCategoryCache();

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /admin/products/:id error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/products/:id
router.put("/products/:id", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });

    const body = req.body;
    const stringFields = [
      "name", "brief", "category", "subCategory", "brand",
      "color", "storage", "network", "screenSize", "description", "deliveryTime", "overview"
    ];
    stringFields.forEach((f) => {
      if (body[f] !== undefined) product[f] = body[f] !== null ? String(body[f]).trim() : "";
    });

    const numFields = ["originalPrice", "salePrice", "warrantyYears"];
    numFields.forEach((f) => {
      if (body[f] !== undefined) product[f] = (body[f] === "" || body[f] === null) ? undefined : Number(body[f]);
    });

    const boolFields = ["freeDelivery", "taxIncluded", "inStock"];
    boolFields.forEach((f) => {
      if (body[f] !== undefined) product[f] = body[f] === "true" || body[f] === true;
    });

    if (body["installment.available"] !== undefined || body.installment !== undefined) {
      const inst = body.installment && typeof body.installment === "object"
        ? body.installment
        : (product.installment ? (typeof product.installment.toObject === "function" ? product.installment.toObject() : { ...product.installment }) : {});

      inst.available = body["installment.available"] !== undefined
        ? (body["installment.available"] === "true" || body["installment.available"] === true)
        : (inst.available === "true" || inst.available === true);

      if (body["installment.downPayment"] !== undefined) inst.downPayment = body["installment.downPayment"] ? Number(body["installment.downPayment"]) : undefined;
      if (body["installment.months"] !== undefined) inst.months = body["installment.months"] ? Number(body["installment.months"]) : undefined;
      if (body["installment.note"] !== undefined) inst.note = body["installment.note"] ?? inst.note;

      product.installment = inst;
      product.markModified("installment");
    }

    const specFields = ["screen", "processor", "ram", "storage", "rearCamera", "frontCamera", "battery", "batteryLife", "charging", "os", "extras"];
    const hasSpecs = specFields.some((f) => body[`specs.${f}`] !== undefined) || body.specs !== undefined;
    if (hasSpecs) {
      const hasSpecsObject = product.specs && typeof product.specs === "object";
      const specs = body.specs && typeof body.specs === "object"
        ? { ...body.specs }
        : (hasSpecsObject ? (typeof product.specs.toObject === "function" ? product.specs.toObject() : { ...product.specs }) : {});

      specFields.forEach((f) => {
        if (body[`specs.${f}`] !== undefined) specs[f] = body[`specs.${f}`];
      });
      product.specs = specs;
      product.markModified("specs");
    }

    if (Array.isArray(body.images)) {
      product.images = body.images.filter(Boolean);
      product.markModified("images");
    }
    if (body.image !== undefined) product.image = body.image;

    if (Array.isArray(body.gallery)) {
      product.gallery = body.gallery.filter((g) => g && (g.url || g.caption));
      product.markModified("gallery");
    }

    if (Array.isArray(body.specifications)) {
      product.specifications = body.specifications;
      product.markModified("specifications");
    }

    if (Array.isArray(body.specGroups)) {
      product.specGroups = body.specGroups;
      product.markModified("specGroups");
    }

    if (Array.isArray(body.variants)) {
      product.variants = body.variants;
      product.markModified("variants");
    }

    if (body.rating && typeof body.rating === "object") {
      product.rating = {
        average: Number(body.rating.average) || 0,
        count: Number(body.rating.count) || 0,
      };
      product.markModified("rating");
    }

    if (Array.isArray(body.reviews)) {
      product.reviews = body.reviews.filter((r) => r && r.name && r.comment).map((r) => ({
        name: String(r.name).trim(),
        rate: Number(r.rate) || 5,
        comment: String(r.comment).trim(),
        date: r.date ? String(r.date) : new Date().toISOString().split("T")[0],
      }));
      product.markModified("reviews");
    }

    if (body.colors !== undefined) {
      try {
        product.colors = typeof body.colors === "string" ? JSON.parse(body.colors) : body.colors;
        product.markModified("colors");
      } catch { /* ignore */ }
    }

    if (body.features !== undefined) { product.features = body.features; product.markModified("features"); }
    if (body.detailedSpecs !== undefined) { product.detailedSpecs = body.detailedSpecs; product.markModified("detailedSpecs"); }
    if (body.sections !== undefined) { product.sections = body.sections; product.markModified("sections"); }

    await product.save();

    cache.delPrefix("products");
    invalidateCategoryCache();

    res.json(product);
  } catch (err) {
    console.error("PUT /products/:id error:", err);
    res.status(500).json({ error: err.message || "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-image/:key  (images: qrImage, img1, img2)
router.post("/company/footer-image/:key", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    const { key } = req.params;
    if (!["qrImage", "img1", "img2"].includes(key)) return res.status(400).json({ error: "حقل غير مسموح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    await deleteFromCloudinary(company[key]);
    const result = await uploadToCloudinary(req.file.buffer, "company");
    company[key] = result.secure_url;
    await company.save();
    cache.del("company_data");
    res.json({ url: company[key] });
  } catch (err) {
    console.error("company/footer-image error:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/company/footer-image/:key
router.delete("/company/footer-image/:key", authMiddleware, async (req, res) => {
  try {
    const { key } = req.params;
    if (!["qrImage", "img1", "img2"].includes(key)) return res.status(400).json({ error: "حقل غير مسموح" });
    let company = await Company.findOne();
    if (!company) return res.json({ success: true });
    await deleteFromCloudinary(company[key]);
    company[key] = "";
    await company.save();
    cache.del("company_data");
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE company/footer-image error:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-file/:key  (files: file1, file2, qrFile)
router.post("/company/footer-file/:key", authMiddleware, uploadDoc.single("file"), async (req, res) => {
  try {
    const { key } = req.params;
    if (!["file1", "file2", "qrFile"].includes(key)) return res.status(400).json({ error: "حقل غير مسموح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع ملف" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    await deleteFromCloudinary(company[key], "raw");
    const ext = req.file.originalname ? req.file.originalname.split(".").pop() : "pdf";
    const filename = `doc_${key}_${Date.now()}.${ext}`;
    const result = await uploadToCloudinary(req.file.buffer, "docs", {
      resource_type: "raw",
      public_id: filename,
    });
    company[key] = result.secure_url;
    await company.save();
    cache.del("company_data");
    res.json({ url: company[key] });
  } catch (err) {
    console.error("company/footer-file error:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/company/footer-file/:key
router.delete("/company/footer-file/:key", authMiddleware, async (req, res) => {
  try {
    const { key } = req.params;
    if (!["file1", "file2", "qrFile"].includes(key)) return res.status(400).json({ error: "حقل غير مسموح" });
    let company = await Company.findOne();
    if (!company) return res.json({ success: true });
    await deleteFromCloudinary(company[key], "raw");
    company[key] = "";
    await company.save();
    cache.del("company_data");
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE company/footer-file error:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-items/image/:index
router.post("/company/footer-items/image/:index", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    if (isNaN(index) || index < 0 || index > 20) return res.status(400).json({ error: "رقم غير صحيح" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    if (!Array.isArray(company.footerItems)) company.footerItems = [];
    while (company.footerItems.length <= index) {
      company.footerItems.push({ image: "", linkType: "link", link: "", file: "" });
    }
    const old = company.footerItems[index]?.image;
    await deleteFromCloudinary(old);
    const result = await uploadToCloudinary(req.file.buffer, "company");
    company.footerItems[index].image = result.secure_url;
    company.markModified("footerItems");
    await company.save();
    cache.del("company_data");
    res.json({ url: company.footerItems[index].image });
  } catch (err) {
    console.error("footer-items/image error:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/company/footer-items/:index/image
router.delete("/company/footer-items/:index/image", authMiddleware, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    let company = await Company.findOne();
    if (!company || !Array.isArray(company.footerItems) || isNaN(index) || index < 0 || index >= company.footerItems.length) {
      return res.json({ success: true });
    }
    const old = company.footerItems[index]?.image;
    await deleteFromCloudinary(old);
    company.footerItems[index].image = "";
    company.markModified("footerItems");
    await company.save();
    cache.del("company_data");
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE footer-items/:index/image error:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-items/file/:index
router.post("/company/footer-items/file/:index", authMiddleware, uploadDoc.single("file"), async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع ملف" });
    if (isNaN(index) || index < 0 || index > 20) return res.status(400).json({ error: "رقم غير صحيح" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    if (!Array.isArray(company.footerItems)) company.footerItems = [];
    while (company.footerItems.length <= index) {
      company.footerItems.push({ image: "", linkType: "link", link: "", file: "" });
    }
    const old = company.footerItems[index]?.file;
    await deleteFromCloudinary(old, "raw");
    const ext = req.file.originalname ? req.file.originalname.split(".").pop() : "pdf";
    const filename = `item_doc_${index}_${Date.now()}.${ext}`;
    const result = await uploadToCloudinary(req.file.buffer, "docs", {
      resource_type: "raw",
      public_id: filename,
    });
    company.footerItems[index].file = result.secure_url;
    company.markModified("footerItems");
    await company.save();
    cache.del("company_data");
    res.json({ url: company.footerItems[index].file });
  } catch (err) {
    console.error("footer-items/file error:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/company/footer-items/:index/file
router.delete("/company/footer-items/:index/file", authMiddleware, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    let company = await Company.findOne();
    if (!company || !Array.isArray(company.footerItems) || isNaN(index) || index < 0 || index >= company.footerItems.length) {
      return res.json({ success: true });
    }
    const old = company.footerItems[index]?.file;
    await deleteFromCloudinary(old, "raw");
    company.footerItems[index].file = "";
    company.markModified("footerItems");
    await company.save();
    cache.del("company_data");
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE footer-items/:index/file error:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-items/add
router.post("/company/footer-items/add", authMiddleware, async (req, res) => {
  try {
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    if (!Array.isArray(company.footerItems)) company.footerItems = [];
    if (company.footerItems.length >= 10) return res.status(400).json({ error: "الحد الأقصى 10 عناصر" });
    company.footerItems.push({ image: "", linkType: "link", link: "", file: "" });
    await company.save();
    cache.del("company_data");
    res.json({ index: company.footerItems.length - 1, item: company.footerItems[company.footerItems.length - 1] });
  } catch (err) {
    console.error("footer-items/add error:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/company/footer-items/:index
router.delete("/company/footer-items/:index", authMiddleware, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    let company = await Company.findOne();
    if (!company || !Array.isArray(company.footerItems)) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= company.footerItems.length)
      return res.status(400).json({ error: "رقم غير صحيح" });
    const item = company.footerItems[index];
    if (item) {
      if (item.image) await deleteFromCloudinary(item.image);
      if (item.file) await deleteFromCloudinary(item.file, "raw");
    }
    company.footerItems.splice(index, 1);
    company.markModified("footerItems");
    await company.save();
    cache.del("company_data");
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE footer-items/:index error:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/category-banners-bulk?categories=cat1,cat2,...
router.get("/category-banners-bulk", async (req, res) => {
  try {
    const raw = req.query.categories;
    if (!raw) return res.json({});
    const names = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
    if (!names.length) return res.json({});
    
    const cacheKey = `cat_banners_bulk_${names.slice().sort().join("_")}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const docs = await CategoryBanner.find({ category: { $in: names } }).lean();
    const result = {};
    for (const doc of docs) {
      const active = (doc.banners || []).filter((b) => b.url && b.active).map((b) => b.url);
      if (active.length) result[doc.category] = active;
    }
    cache.set(cacheKey, result, 300);
    res.json(result);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/category-banners/:category
router.get("/category-banners/:category", async (req, res) => {
  try {
    const { category } = req.params;
    const cacheKey = `cat_banner_${category}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const doc = await CategoryBanner.findOne({ category }).lean();
    const banners = doc && doc.banners && doc.banners.length ? doc.banners : [{ url: "", active: true }];
    cache.set(cacheKey, banners, 300);
    res.json(banners);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/category-banners/:category/upload/:index
router.post("/category-banners/:category/upload/:index", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    const { category } = req.params;
    const index = parseInt(req.params.index);
    let doc = await CategoryBanner.findOne({ category });
    if (!doc) doc = await CategoryBanner.create({ category });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    await deleteFromCloudinary(doc.banners[index]?.url);
    const result = await uploadToCloudinary(req.file.buffer, "category-banners", { quality: "auto", fetch_format: "auto" });
    doc.banners.set(index, { url: result.secure_url, active: doc.banners[index].active });
    await doc.save();
    cache.delPrefix("cat_banners_");
    cache.del(`cat_banner_${category}`);
    res.json({ url: result.secure_url });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/category-banners/:category/toggle/:index
router.patch("/category-banners/:category/toggle/:index", authMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    const index = parseInt(req.params.index);
    const doc = await CategoryBanner.findOne({ category });
    if (!doc) return res.status(404).json({ error: "لا يوجد" });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const newActive = !doc.banners[index].active;
    doc.banners.set(index, { url: doc.banners[index].url, active: newActive });
    await doc.save();
    cache.delPrefix("cat_banners_");
    cache.del(`cat_banner_${category}`);
    res.json({ active: newActive });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/category-banners/:category/add
router.post("/category-banners/:category/add", authMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    let doc = await CategoryBanner.findOne({ category });
    if (!doc) doc = await CategoryBanner.create({ category });
    if (doc.banners.length >= 10) return res.status(400).json({ error: "الحد الأقصى 10 بانرات" });
    doc.banners.push({ url: "", active: true });
    await doc.save();
    cache.delPrefix("cat_banners_");
    cache.del(`cat_banner_${category}`);
    res.json({ index: doc.banners.length - 1 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/category-banners/:category/:index/image
router.delete("/category-banners/:category/:index/image", authMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    const index = parseInt(req.params.index);
    const doc = await CategoryBanner.findOne({ category });
    if (!doc) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    await deleteFromCloudinary(doc.banners[index]?.url);
    doc.banners.set(index, { url: "", active: doc.banners[index].active });
    await doc.save();
    cache.delPrefix("cat_banners_");
    cache.del(`cat_banner_${category}`);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/category-banners/:category/:index
router.delete("/category-banners/:category/:index", authMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    const index = parseInt(req.params.index);
    const doc = await CategoryBanner.findOne({ category });
    if (!doc) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    await deleteFromCloudinary(doc.banners[index]?.url);
    doc.banners.splice(index, 1);
    await doc.save();
    cache.delPrefix("cat_banners_");
    cache.del(`cat_banner_${category}`);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

module.exports = router;
