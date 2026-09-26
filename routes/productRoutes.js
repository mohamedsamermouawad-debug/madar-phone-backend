const express = require("express");
const router = express.Router();
const {
  getProducts,
  getProduct,
  getSimilarProducts,
  createProduct,
  updateProduct,
  deleteProduct,
} = require("../controllers/productController");
const authMiddleware = require("../middleware/auth");

router.route("/")
  .get(getProducts)
  .post(authMiddleware, createProduct);

router.get("/:id/similar", getSimilarProducts);

router.route("/:id")
  .get(getProduct)
  .put(authMiddleware, updateProduct)
  .delete(authMiddleware, deleteProduct);

module.exports = router;

