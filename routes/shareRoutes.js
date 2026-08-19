// Express import karo taaki router bana sakein.
const express = require("express");

// Prisma client — Neon PostgreSQL se baat karne ke liye.
const prisma = require("../lib/prisma");

// Router ek mini Express app hai — related routes ka group.
// server.js mein yeh /api/shares pe mount hoga, isliye yahan ke saare routes
// automatically /api/shares se prefix ho jaate hain.
const router = express.Router();


// ================================
// HELPER: Generate 6-digit code
// ================================

// crypto Node.js ka built-in module hai — install karne ki zaroorat nahi.
// Math.random() ki jagah crypto.randomInt() use karte hain kyunki yeh
// cryptographically secure hai — predict karna mushkil hota hai.
const crypto = require("crypto");

const generateCode = () => {
    // randomInt(min, max) — 100000 se 999999 ke beech ek number deta hai.
    // Yeh guarantee karta hai ki code hamesha exactly 6 digits ka hoga.
    return crypto.randomInt(100000, 999999).toString();
};


// ================================
// HELPER: Check expiry
// ================================

const isExpired = (share) => {
    // Current time ko share ki expiresAt se compare karo.
    // Agar current time > expiresAt hai to share expire ho chuka hai.
    return new Date() > new Date(share.expiresAt);
};


// ================================
// POST /api/shares
// ================================
// Sender yeh route call karta hai jab "SEND FILES" button dabata hai.
// Ek naya share session create hota hai DB mein.
// Response mein shareId (Socket.IO room ke liye) aur code (receiver ko dikhane ke liye) milta hai.

router.post("/", async (req, res) => {

    try {

        // Cryptographically secure 6-digit code generate karo.
        const code = generateCode();

        // Share 10 minute mein expire hoga.
        // Date.now() milliseconds mein hai, isliye 10 * 60 * 1000 = 10 minutes.
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        // Neon PostgreSQL mein share record create karo Prisma ke zariye.
        // status automatically "waiting" set hoga (schema mein default defined hai).
        const share = await prisma.share.create({
            data: {
                code,
                expiresAt
            }
        });

        // 201 Created response bhejo share ki details ke saath.
        res.status(201).json({
            success: true,
            share: {
                id: share.id,       // Socket.IO room join karne ke liye
                code: share.code,   // Receiver ko dikhane ke liye
                expiresAt: share.expiresAt
            }
        });

    } catch (error) {

        console.error("Create share error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to create share."
        });
    }
});


// ================================
// GET /api/shares/:code
// ================================
// Receiver yeh route call karta hai jab 6-digit code enter karke "VERIFY" dabata hai.
// Code valid hai ya nahi, expire hua ya nahi — yeh check hota hai.
// Valid hone par shareId milta hai jo Socket.IO room join karne ke liye chahiye.

router.get("/:code", async (req, res) => {

    try {

        // URL se code nikalo.
        // e.g. GET /api/shares/482731 → req.params.code = "482731"
        const { code } = req.params;

        // Basic validation — code exactly 6 digits ka hona chahiye.
        // Regex /^\d{6}$/ — sirf digits, exactly 6.
        if (!/^\d{6}$/.test(code)) {
            return res.status(400).json({
                success: false,
                message: "Code must be exactly 6 digits."
            });
        }

        // DB mein is code ka share dhundo.
        // findUnique — unique field (code) se ek record dhundta hai.
        const share = await prisma.share.findUnique({
            where: { code }
        });

        // Agar koi share nahi mila to 404 Not Found.
        if (!share) {
            return res.status(404).json({
                success: false,
                message: "Invalid share code."
            });
        }

        // Agar share ki expiry time nikal gayi to 410 Gone.
        if (isExpired(share)) {
            return res.status(410).json({
                success: false,
                message: "This share has expired."
            });
        }

        // Agar share already use ho chuka hai to reject karo.
        if (share.status === "completed") {
            return res.status(410).json({
                success: false,
                message: "This share has already been used."
            });
        }

        // Share valid hai — receiver ko zaruri details bhejo.
        res.json({
            success: true,
            share: {
                id: share.id,           // Socket.IO room join karne ke liye
                code: share.code,
                status: share.status,
                expiresAt: share.expiresAt
            }
        });

    } catch (error) {

        console.error("Verify share error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to verify share."
        });
    }
});


// ================================
// POST /api/shares/:shareId/files
// ================================
// Sender share create karne ke baad yeh route call karta hai.
// Actual file bytes yahan nahi aate — sirf metadata (naam, size, type) save hota hai.
// Yeh isliye kiya jaata hai taaki DB mein record rahe ki is share mein kaun si files thi.
// Actual file data WebRTC DataChannel se directly browser-to-browser jaata hai.

router.post("/:shareId/files", async (req, res) => {

    try {

        // URL se shareId lo aur integer mein convert karo.
        const shareId = parseInt(req.params.shareId);

        // Request body se files array lo.
        // Expected format: [{ fileName, fileSize, mimeType }]
        const { files } = req.body;

        // Validate karo ki files array empty nahi hai.
        if (!Array.isArray(files) || files.length === 0) {
            return res.status(400).json({
                success: false,
                message: "No file metadata provided."
            });
        }

        // Pehle confirm karo ki yeh shareId DB mein exist karta hai.
        const share = await prisma.share.findUnique({
            where: { id: shareId }
        });

        if (!share) {
            return res.status(404).json({
                success: false,
                message: "Share not found."
            });
        }

        // createMany — ek hi query mein saari files ka metadata insert karo.
        // Yeh individual create() calls se zyada efficient hai.
        await prisma.file.createMany({
            data: files.map((f) => ({
                fileName: f.fileName,
                fileSize: f.fileSize,
                mimeType: f.mimeType,
                shareId           // Foreign key — is share se link karo
            }))
        });

        // 201 Created — metadata successfully save ho gaya.
        res.status(201).json({ success: true });

    } catch (error) {

        console.error("Save file metadata error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to save file metadata."
        });
    }
});


// Router export karo taaki server.js ise mount kar sake.
module.exports = router;
