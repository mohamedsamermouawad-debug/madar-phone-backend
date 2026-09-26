const jwt = require("jsonwebtoken");

function authMiddleware(req, res, next) {
  let token = req.cookies?.admin_token;
  if (!token && req.headers.authorization?.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return res.status(401).json({ error: "غير مصرح" });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error("CRITICAL: JWT_SECRET environment variable is missing!");
    if (process.env.NODE_ENV === "production") {
      return res.status(500).json({ error: "خطأ في تهيئة الخادم" });
    }
  }

  try {
    const decoded = jwt.verify(token, secret || "default_jwt_secret_dev_only");
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "جلسة منتهية أو غير صالحة" });
  }
}

module.exports = authMiddleware;
