// Share routes — Cloudinary-based file transfer.
// WebRTC/P2P removed: files backend se Cloudinary pe upload hote hain,
// receiver download karta hai, aur download hone ke BAAD file turant delete hoti hai.

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const multer = require("multer");
const prisma = require("../lib/prisma");
const cloudinary = require("../lib/cloudinary");

const router = express.Router();

// Multer — temp disk storage (memory se bacha, large files ke liye safe).
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) =>
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`)
});
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// Cryptographically-secure 6-digit code.
const generateCode = () => crypto.randomInt(100000, 999999).toString();

// Share expired check.
const isExpired = (share) => new Date() > new Date(share.expiresAt);

// Upload one temp file to Cloudinary (folder: fileshare). resource_type "auto" = images/video/raw sab handle karta hai.
const uploadToCloudinary = (filePath, originalName) =>
    new Promise((resolve, reject) => {
        cloudinary.uploader.upload(
            filePath,
            { folder: "fileshare", resource_type: "auto", use_filename: true, unique_filename: false, filename_override: originalName },
            (error, result) => (error ? reject(error) : resolve({ publicId: result.public_id, secureUrl: result.secure_url }))
        );
    });

// Delete ek file ko Cloudinary + DB dono se. Agar last file ho to share "completed".
const deleteShareFile = async (fileId, shareId = null) => {
    const where = { id: Number(fileId) };
    if (shareId != null) where.shareId = shareId;
    const file = await prisma.file.findFirst({ where });
    if (!file) return false;
    if (file.cloudinaryPublicId) {
        try { await cloudinary.uploader.destroy(file.cloudinaryPublicId, { resource_type: "auto" }); }
        catch (e) { console.warn("Cloudinary delete warning:", e.message); }
    }
    await prisma.file.delete({ where: { id: file.id } });
    const remaining = await prisma.file.count({ where: { shareId: file.shareId } });
    if (remaining === 0) {
        await prisma.share.update({ where: { id: file.shareId }, data: { status: "completed" } }).catch(() => {});
    }
    return true;
};

// ================================
// POST /api/shares — create share
// ================================
router.post("/", async (req, res) => {
    try {
        const share = await prisma.share.create({
            data: { code: generateCode(), expiresAt: new Date(Date.now() + 60 * 60 * 1000) } // 1 hour
        });
        res.status(201).json({ success: true, share: { id: share.id, code: share.code, expiresAt: share.expiresAt } });
    } catch (error) {
        console.error("Create share error:", error);
                res.status(500).json({ success: false, message: "Failed to create share." });
    }
});

// ================================
// POST /api/shares/:shareId/upload — upload files to Cloudinary
// ================================
router.post("/:shareId/upload", upload.array("files"), async (req, res) => {
    try {
        const share = await prisma.share.findUnique({ where: { id: Number(req.params.shareId) } });
        if (!share) return res.status(404).json({ success: false, message: "Share not found." });
        if (isExpired(share)) return res.status(410).json({ success: false, message: "Share expired." });
        if (!req.files || req.files.length === 0) return res.status(400).json({ success: false, message: "No files." });

                const created = [];
        const uploadErrors = [];
        for (const file of req.files) {
            try {
                const { publicId, secureUrl } = await uploadToCloudinary(file.path, file.originalname);
                const rec = await prisma.file.create({
                    data: { fileName: file.originalname, fileSize: file.size, mimeType: file.mimetype, cloudinaryPublicId: publicId, cloudinaryUrl: secureUrl, shareId: share.id }
                });
                created.push({ id: rec.id, fileName: rec.fileName, fileSize: rec.fileSize, url: rec.cloudinaryUrl });
            } catch (e) {
                console.error("Upload failed for", file.originalname, e.message);
                uploadErrors.push(`${file.originalname}: ${e.message}`);
            } finally {
                // TEMP file hamesha delete karo — disk fill se bachao.
                fs.unlink(file.path, () => {});
            }
        }

        // Agar koi bhi file Cloudinary pe nahi gayi → fail karo (silent failure se bachne ke liye).
        // (Most common cause: CLOUDINARY_* env vars missing/wrong on Render.)
        if (created.length === 0) {
            return res.status(502).json({
                success: false,
                message: uploadErrors.length
                    ? `Cloudinary upload failed: ${uploadErrors[0]}`
                    : "Upload failed: no files were stored.",
                errors: uploadErrors
            });
        }

        await prisma.share.update({ where: { id: share.id }, data: { status: "uploaded" } });
        res.json({ success: true, files: created, errors: uploadErrors });
    } catch (err) {
        console.error("Upload route error:", err);
        res.status(500).json({ success: false, message: "Upload failed." });
    }
});

// ================================
// GET /api/shares/verify/:code — receiver code verify
// ================================
router.get("/verify/:code", async (req, res) => {
    try {
        const share = await prisma.share.findUnique({ where: { code: req.params.code }, include: { files: true } });
        if (!share) return res.status(404).json({ success: false, message: "Invalid code." });
        if (isExpired(share)) {
            await deleteShareFiles(share.id);
            await prisma.share.delete({ where: { id: share.id } }).catch(() => {});
            return res.status(410).json({ success: false, message: "Share expired." });
        }
        res.json({
            success: true,
            share: {
                id: share.id, code: share.code, expiresAt: share.expiresAt, status: share.status,
                files: share.files.map((f) => ({ id: f.id, fileName: f.fileName, fileSize: f.fileSize, url: f.cloudinaryUrl }))
            }
        });
    } catch (err) {
        console.error("Verify error:", err);
        res.status(500).json({ success: false, message: "Verify failed." });
    }
});

// ================================
// GET /api/shares/:shareId/status
// ================================
router.get("/:shareId/status", async (req, res) => {
    try {
        const share = await prisma.share.findUnique({ where: { id: Number(req.params.shareId) }, include: { _count: { select: { files: true } } } });
        if (!share) return res.status(404).json({ success: false, message: "Not found." });
        res.json({ success: true, share: { id: share.id, status: share.status, remainingFiles: share._count.files } });
    } catch (err) {
        console.error("Status error:", err);
        res.status(500).json({ success: false, message: "Status failed." });
    }
});

// ================================
// DELETE /api/files/:fileId — delete-on-download (receiver consumes)
// ================================
router.delete("/files/:fileId", async (req, res) => {
    try {
        const ok = await deleteShareFile(req.params.fileId);
        if (!ok) return res.status(404).json({ success: false, message: "File not found." });
        res.json({ success: true });
    } catch (err) {
        console.error("File delete error:", err);
        res.status(500).json({ success: false, message: "Delete failed." });
    }
});

// ================================
// DELETE /api/shares/:shareId — full share cleanup
// ================================
router.delete("/:shareId", async (req, res) => {
    try {
        const share = await prisma.share.findUnique({ where: { id: Number(req.params.shareId) }, include: { files: true } });
        if (!share) return res.status(404).json({ success: false, message: "Share not found." });
        await deleteShareFiles(share.id);
        await prisma.share.delete({ where: { id: share.id } }).catch(() => {});
        res.json({ success: true });
    } catch (err) {
        console.error("Share delete error:", err);
        res.status(500).json({ success: false, message: "Delete failed." });
    }
});

// deleteShareFiles — cleanup.js wala (expired shares / full cleanup ke liye reuse).
const { deleteShareFiles } = require("../lib/cleanup");

module.exports = router;
