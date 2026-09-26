require("dotenv").config();
const mongoose = require("mongoose");
const Checkout = require("./models/Checkout");

async function deletePreOrders() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected to DB");

  // ابحث عن أي طلب فيه item اسمه يحتوي على كلمات تدل على pre-order أو حجز
  const preOrderKeywords = [
    /حجز/i,
    /pre.?order/i,
    /preorder/i,
    /مسبق/i,
  ];

  const allOrders = await Checkout.find({}).lean();

  const toDelete = allOrders.filter((order) =>
    order.items?.some((item) =>
      preOrderKeywords.some((rx) => rx.test(item.name || ""))
    )
  );

  if (toDelete.length === 0) {
    console.log("🔍 ما فيش pre-orders في الـ DB");
    await mongoose.disconnect();
    return;
  }

  console.log(`🗑️  هيتم حذف ${toDelete.length} طلب pre-order:`);
  toDelete.forEach((o) =>
    console.log(`  - ${o.orderId} | ${o.customer || "بدون اسم"} | ${o.items.map((i) => i.name).join(", ")}`)
  );

  const ids = toDelete.map((o) => o._id);
  const result = await Checkout.deleteMany({ _id: { $in: ids } });
  console.log(`✅ تم حذف ${result.deletedCount} طلب`);

  await mongoose.disconnect();
}

deletePreOrders().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
