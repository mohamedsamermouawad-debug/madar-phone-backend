require("dotenv").config();
const connectDB = require("./config/db");
const Product = require("./models/Product");

(async () => {
  await connectDB();
  const cats = await Product.distinct("category");
  console.log("=== Distinct categories ===");
  cats.sort().forEach((c) => console.log(JSON.stringify(c)));
  const brands = await Product.distinct("brand");
  console.log("\n=== Distinct brands ===");
  brands.sort().forEach((b) => console.log(JSON.stringify(b)));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
