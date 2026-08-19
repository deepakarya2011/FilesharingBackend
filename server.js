// server.js — Express API backend (Cloudinary-based file transfer).
const express = require("express");
const http = require("http");
const cors = require("cors");
const dotenv = require("dotenv");
const prisma = require("./lib/prisma");
const { cleanupExpiredShares } = require("./lib/cleanup");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// CORS — allow frontend origin(s) (FRONTEND_URL comma-separated).
const allowedOrigins = (process.env.FRONTEND_URL || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);                    // non-browser (curl/Postman)
        if (allowedOrigins.includes(origin)) return callback(null, true);
        if (/^https:\/\/[a-z0-9.-]+\.vercel\.app$/.test(origin)) return callback(null, true); // Vercel preview URLs
        return callback(null, true);                                 // permissive fallback
    },
    credentials: true
}));
app.use(express.json());

// API routes
app.use("/api/shares", require("./routes/shareRoutes"));

// Health check (DB connectivity included)
app.get("/api/health", async (_req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.json({ status: "ok", database: "connected" });
    } catch (e) {
        res.status(500).json({ status: "error", database: e.message });
    }
});

// 404 fallback for unknown API routes
app.use("/api", (_req, res) => res.status(404).json({ success: false, message: "Not found." }));

// Expired shares cleanup — startup + every 15 minutes
(async () => {
    try { const n = await cleanupExpiredShares(); if (n) console.log(`Initial cleanup: removed ${n} expired share(s)`); }
    catch (e) { console.warn("Initial cleanup warning:", e.message); }
})();
setInterval(() => {
    cleanupExpiredShares()
        .then((n) => { if (n) console.log(`Cleanup: removed ${n} expired share(s)`); })
        .catch((e) => console.warn("Cleanup error:", e.message));
}, 15 * 60 * 1000);

const server = http.createServer(app);
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

module.exports = app;