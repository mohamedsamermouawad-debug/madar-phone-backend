const mongoose = require("mongoose");

let isConnecting = false;

const connectDB = async (retries = 5) => {
  if (mongoose.connection.readyState >= 1) {
    return;
  }
  if (isConnecting) return;
  isConnecting = true;

  try {
    await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 10,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log("✅ MongoDB connected successfully");
  } catch (err) {
    console.error(`❌ MongoDB connection failed: ${err.message}`);
    if (retries > 0) {
      console.log(`Retrying MongoDB connection... (${retries} attempts left)`);
      setTimeout(() => {
        isConnecting = false;
        connectDB(retries - 1);
      }, 5000);
    } else {
      process.exit(1);
    }
  } finally {
    isConnecting = false;
  }
};

mongoose.connection.on("disconnected", () => {
  console.warn("⚠️ MongoDB disconnected. Attempting reconnect...");
});

mongoose.connection.on("error", (err) => {
  console.error("⚠️ MongoDB connection error:", err.message);
});

module.exports = connectDB;
