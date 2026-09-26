const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    brief: { type: String },
    description: { type: String },
    originalPrice: { type: Number, required: true },
    salePrice: { type: Number },
    image: { type: String },
    images: [{ type: String }],
    gallery: [
      {
        url: { type: String },
        caption: { type: String },
      },
    ],
    specifications: [
      {
        groupName: { type: String },
        items: [
          {
            label: { type: String },
            value: { type: String },
          },
        ],
      },
    ],
    color: { type: String },
    storage: { type: String },
    network: { type: String },
    screenSize: { type: String },
    specs: {
      screen: String,
      processor: String,
      ram: String,
      storage: String,
      rearCamera: String,
      frontCamera: String,
      battery: String,
      batteryLife: String,
      charging: String,
      os: String,
      extras: String,
    },
    freeDelivery: { type: Boolean, default: true },
    deliveryTime: { type: String, default: "24 ساعة" },
    warrantyYears: { type: Number, default: 2 },
    installment: {
      available: { type: Boolean, default: false },
      downPayment: Number,
      note: String,
      months: Number,
      conditions: [String],
      policy: String,
    },
    taxIncluded: { type: Boolean, default: true },
    category: { type: String },
    subCategory: { type: String },
    brand: { type: String },
    inStock: { type: Boolean, default: true },
    rating: {
      average: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
    },
    reviews: [
      {
        name: { type: String },
        rate: { type: Number },
        comment: { type: String },
        date: { type: String },
      },
    ],
    colors: { type: mongoose.Schema.Types.Mixed },
    overview: { type: String },
    features: { type: mongoose.Schema.Types.Mixed },
    detailedSpecs: { type: mongoose.Schema.Types.Mixed },
    variants: [
      {
        name: String,
        color: String,
        colorCode: String,
        defaultStorage: String,
        images: [String],
        storageOptions: [
          {
            storage: String,
            originalPrice: Number,
            salePrice: Number,
          },
        ],
      },
    ],
    specGroups: [
      {
        group: String,
        items: [
          {
            key: String,
            value: String,
          },
        ],
      },
    ],
    sections: { type: mongoose.Schema.Types.Mixed },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

productSchema.virtual("discountPercent").get(function () {
  if (this.salePrice && this.originalPrice > this.salePrice) {
    return Math.round(((this.originalPrice - this.salePrice) / this.originalPrice) * 100);
  }
  return 0;
});

productSchema.virtual("price").get(function () {
  return this.salePrice || this.originalPrice;
});

productSchema.index({ name: 1 });
productSchema.index({ category: 1, brand: 1 });
productSchema.index({ subCategory: 1 });
productSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Product", productSchema);

