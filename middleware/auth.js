const jwt = require("jsonwebtoken");

function authMiddleware(req, res, next) {
  let token = req.cookies?.admin_token;
  if (!token && req.headers.authorization?.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return res.status(401).json({ error: "غير مصرح" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "default_jwt_secret");
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "جلسة منتهية أو غير صالحة" });
  }
}

module.exports = authMiddleware;
