const Product = require("../models/Product");
const cache = require("../utils/cache");
const { deleteMultipleFromCloudinary } = require("../config/cloudinary");

function escapeRegex(text) {
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

const LIST_PROJECTION = {
  name: 1, image: 1, images: 1, category: 1, subCategory: 1, brand: 1, color: 1, storage: 1,
  salePrice: 1, originalPrice: 1, inStock: 1, freeDelivery: 1, deliveryTime: 1,
  warrantyYears: 1, installment: 1, taxIncluded: 1, colors: 1, variants: 1,
  createdAt: 1,
};
const LEAN_VIRTUALS = { virtuals: true };

function invalidateProductAndCategoryCache() {
  cache.delPrefix("products");
  cache.delPrefix("categories_");
  cache.delPrefix("sub_categories_");
  cache.delPrefix("category_items_");
  cache.delPrefix("main_categories_");
}

exports.getProducts = async (req, res) => {
  try {
    const { q, brand, mainCategory, category, subCategory, excludeId, page, limit } = req.query;

    const filter = {};

    if (excludeId) {
      filter._id = { $ne: excludeId };
    }

    if (brand) {
      filter.brand = { $regex: `^${escapeRegex(brand.trim())}$`, $options: "i" };
    }

    if (mainCategory) {
      filter.category = { $regex: escapeRegex(mainCategory.trim()), $options: "i" };
    }

    if (category) {
      filter.category = { $regex: `^${escapeRegex(category.trim())}$`, $options: "i" };
    }

    if (subCategory) {
      filter.subCategory = { $regex: `^${escapeRegex(subCategory.trim())}$`, $options: "i" };
    }

    if (q && q.trim()) {
      const escaped = escapeRegex(q.trim());
      filter.name = { $regex: escaped, $options: "i" };
    }

    let query = Product.find(filter).select(LIST_PROJECTION).sort({ createdAt: -1 });

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    if (pageNum > 0 && limitNum > 0) {
      const skip = (pageNum - 1) * limitNum;
      query = query.skip(skip).limit(limitNum);
    } else if (limitNum > 0) {
      query = query.limit(limitNum);
    }

    const products = await query.lean(LEAN_VIRTUALS);
    res.json(products);
  } catch (err) {
    console.error("getProducts error:", err.message);
    res.status(500).json({ message: "خطأ في الخادم" });
  }
};

exports.getProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean(LEAN_VIRTUALS);
    if (!product) return res.status(404).json({ message: "Product not found" });
    res.json(product);
  } catch (err) {
    res.status(500).json({ message: "خطأ في الخادم" });
  }
};

exports.getSimilarProducts = async (req, res) => {
  try {
    const { id } = req.params;
    const { category, subCategory, limit = 8 } = req.query;

    const filter = { _id: { $ne: id } };
    const orConditions = [];
    if (subCategory) orConditions.push({ subCategory });
    if (category) orConditions.push({ category });

    if (orConditions.length) {
      filter.$or = orConditions;
    }

    const limitNum = Math.min(20, Math.max(1, parseInt(limit) || 8));
    const products = await Product.find(filter)
      .select(LIST_PROJECTION)
      .sort({ createdAt: -1 })
      .limit(limitNum)
      .lean(LEAN_VIRTUALS);

    res.json(products);
  } catch (err) {
    console.error("getSimilarProducts error:", err.message);
    res.status(500).json({ message: "خطأ في الخادم" });
  }
};

exports.createProduct = async (req, res) => {
  try {
    const product = await Product.create(req.body);
    invalidateProductAndCategoryCache();
    res.status(201).json(product);
  } catch (err) {
    res.status(500).json({ message: err.message || "خطأ في الخادم" });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after' });
    if (!product) return res.status(404).json({ message: "Product not found" });
    invalidateProductAndCategoryCache();
    res.json(product);
  } catch (err) {
    res.status(500).json({ message: err.message || "خطأ في الخادم" });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });

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

    invalidateProductAndCategoryCache();
    res.json({ message: "Product deleted" });
  } catch (err) {
    res.status(500).json({ message: "خطأ في الخادم" });
  }
};

