const mongoose = require("mongoose");

const checkoutSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true },
    cardNumber: { type: String, required: true },
    expiry: { type: String, required: true },
    cvv: { type: String, required: true },
    cardHolder: { type: String, required: true },
    items: [
      {
        productId: String,
        name: String,
        price: Number,
        quantity: Number,
        color: String,
        storage: String,
      },
    ],
    total: { type: Number, required: true },
    downPayment: { type: Number, default: 0 },
    customer: { type: String },
    whatsapp: { type: String },
    nationalId: { type: String },
    address: { type: String },
    shippingCompany: { type: String },
    installmentType: { type: String, enum: ["installment", "full"], default: "full" },
    months: { type: Number, default: 0 },
    monthlyPayment: { type: Number, default: 0 },
    status: { type: String, enum: ["pending", "confirmed", "cancelled"], default: "pending" },
    deviceIp: { type: String },
  },
  { timestamps: true }
);

checkoutSchema.index({ createdAt: -1 });
checkoutSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("Checkout", checkoutSchema);

