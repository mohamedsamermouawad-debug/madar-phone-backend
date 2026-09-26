require("dotenv").config();
const connectDB = require("./config/db");
const Product = require("./models/Product");

(async () => {
  await connectDB();

  const categories = ["ابل ايفون 18 برو ", "ابل ايفون 18 دو"];

  for (const category of categories) {
    const products = await Product.find({ category }).lean();

    console.log(`\n📦 ${category} — ${products.length} منتج`);
    console.log("─".repeat(50));

    if (!products.length) {
      console.log("❌ لا توجد منتجات في هذه الفئة");
      continue;
    }

    products.forEach((p, i) => {
      console.log(`${i + 1}. ${p.name}`);
      console.log(`   ID: ${p._id}`);
      console.log(`   السعر: ${p.salePrice || p.originalPrice} ريال`);
      console.log(`   المخزون: ${p.inStock ? "متوفر" : "غير متوفر"}`);
      if (p.variants?.length) {
        console.log(`   الألوان: ${p.variants.map((v) => v.color).join(" | ")}`);
      }
      console.log("");
    });
  }

  process.exit(0);
})().catch((err) => {
  console.error("❌ خطأ:", err.message);
  process.exit(1);
});
