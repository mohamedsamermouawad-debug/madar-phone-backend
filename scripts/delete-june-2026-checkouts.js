require("dotenv").config();
const mongoose = require("mongoose");
const Checkout = require("./models/Checkout");

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const mayStart = new Date("2026-05-01T00:00:00.000Z");
  const julyStart = new Date("2026-07-01T00:00:00.000Z");

  const result = await Checkout.deleteMany({
    createdAt: { $gte: mayStart, $lt: julyStart },
  });

  console.log(`Deleted ${result.deletedCount} checkout(s) from May & June 2026`);
  await mongoose.disconnect();
};

run().catch(console.error);
