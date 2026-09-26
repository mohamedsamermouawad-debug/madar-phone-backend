const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const { Readable } = require("stream");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const memoryStorage = multer.memoryStorage();

const imageUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Images only"));
    cb(null, true);
  },
});

const fileUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/") && file.mimetype !== "application/pdf")
      return cb(new Error("Images and PDFs only"));
    cb(null, true);
  },
});

function makeImageUpload() { return imageUpload; }
function makeFileUpload() { return fileUpload; }

function uploadToCloudinary(buffer, folder, options = {}) {
  const isRaw = options.resource_type === "raw";
  const defaultOptions = {
    folder,
    ...(isRaw ? {} : { quality: "auto", fetch_format: "auto" }),
    ...options,
  };
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      defaultOptions,
      (err, result) => (err ? reject(err) : resolve(result))
    );
    Readable.from(buffer).pipe(stream);
  });
}

async function deleteFromCloudinary(url, resource_type = "image") {
  if (!url || typeof url !== "string" || !url.includes("cloudinary.com")) return;
  try {
    const isRaw = resource_type === "raw" || url.includes("/raw/upload/");
    const resType = isRaw ? "raw" : "image";
    const parts = url.split("/");
    const uploadIndex = parts.indexOf("upload");
    if (uploadIndex === -1) return;
    let pathParts = parts.slice(uploadIndex + 1);
    if (/^v\d+$/.test(pathParts[0])) pathParts = pathParts.slice(1);
    let publicId = pathParts.join("/");
    if (resType !== "raw") {
      publicId = publicId.replace(/\.[^/.]+$/, "");
    }
    await cloudinary.uploader.destroy(publicId, { resource_type: resType });
  } catch (e) {
    console.error("Cloudinary delete error:", e.message);
  }
}

async function deleteMultipleFromCloudinary(urls, resource_type = "image") {
  if (!Array.isArray(urls) || !urls.length) return;
  const validUrls = urls.filter((u) => u && typeof u === "string" && u.includes("cloudinary.com"));
  await Promise.allSettled(validUrls.map((u) => deleteFromCloudinary(u, resource_type)));
}

module.exports = { cloudinary, makeImageUpload, makeFileUpload, uploadToCloudinary, deleteFromCloudinary, deleteMultipleFromCloudinary };

