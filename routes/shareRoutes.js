// Share routes — Cloudinary-based file transfer.
// WebRTC/P2P removed: files backend se Cloudinary pe upload hote hain,
// receiver download karta hai, aur download hone ke BAAD file turant delete hoti hai.
// DB: MongoDB (Mongoose) — Prisma/PG/Neon removed.

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const archiver = require("archiver");
const multer = require("multer");
const Share = require("../models/Share");
const File = require("../models/File");
const cloudinary = require("../lib/cloudinary");
const { deleteShareFiles } = require("../lib/cleanup");

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

// Remote (Cloudinary) URL se binary stream kholta hai — redirects follow karta hai.
// Ye readable Node stream return karta hai taaki `pipe`/`archiver` use kar saken.
const streamRemoteFile = (url, maxRedirects = 3) =>
    new Promise((resolve, reject) => {
        const mod = url.startsWith("https:") ? https : http;
        const req = mod.get(url, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && maxRedirects > 0 && res.headers.location) {
                res.resume(); // old stream discard
                return streamRemoteFile(new URL(res.headers.location, url).toString(), maxRedirects - 1)
                    .then(resolve).catch(reject);
            }
            if (res.statusCode >= 400) {
                res.resume();
                return reject(new Error(`Remote fetch failed (HTTP ${res.statusCode})`));
            }
            resolve(res);
        });
        req.on("error", reject);
    });

// Safe filename — header ke liye special chars hatao.
const sanitizeName = (name) => String(name || "file").replace(/[^\w.\- ]+/g, "_").slice(0, 120);

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
    const query = { _id: fileId };
    if (shareId != null) query.shareId = shareId;
    const file = await File.findOne(query);
    if (!file) return false;
    if (file.cloudinaryPublicId) {
        try { await cloudinary.uploader.destroy(file.cloudinaryPublicId, { resource_type: "auto" }); }
        catch (e) { console.warn("Cloudinary delete warning:", e.message); }
    }
    await File.findByIdAndDelete(file._id);
    const remaining = await File.countDocuments({ shareId: file.shareId });
    if (remaining === 0) {
        await Share.updateOne({ _id: file.shareId }, { status: "completed" }).catch(() => {});
    }
    return true;
};
// ================================
// POST /api/shares — create share
// ================================
router.post("/", async (req, res) => {
    try {
        const share = await Share.create({ code: generateCode(), expiresAt: new Date(Date.now() + 60 * 60 * 1000) }); // 1 hour
        res.status(201).json({ success: true, share: { id: String(share._id), code: share.code, expiresAt: share.expiresAt } });
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
        const share = await Share.findById(req.params.shareId);
        if (!share) return res.status(404).json({ success: false, message: "Share not found." });
        if (isExpired(share)) return res.status(410).json({ success: false, message: "Share expired." });
        if (!req.files || req.files.length === 0) return res.status(400).json({ success: false, message: "No files." });

        // Cloudinary credentials must be set in the Render dashboard (Environment tab).
        // Agar env vars missing ho to yahi se turant batao — taaki sender confuse na ho.
        if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
            return res.status(502).json({
                success: false,
                message: "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in the Render dashboard (Environment) and redeploy."
            });
        }

        const created = [];
        const uploadErrors = [];
        for (const file of req.files) {
            try {
                const { publicId, secureUrl } = await uploadToCloudinary(file.path, file.originalname);
                const rec = await File.create({
                    fileName: file.originalname, fileSize: file.size, mimeType: file.mimetype,
                    cloudinaryPublicId: publicId, cloudinaryUrl: secureUrl, shareId: share._id
                });
                created.push({ id: String(rec._id), fileName: rec.fileName, fileSize: rec.fileSize, url: rec.cloudinaryUrl });
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

        await Share.updateOne({ _id: share._id }, { status: "uploaded" });
        res.json({ success: true, files: created, errors: uploadErrors });
    } catch (err) {
        console.error("Upload route error:", err);
        res.status(500).json({ success: false, message: err && err.message ? `Upload failed: ${err.message}` : "Upload failed." });
    }
});
// ================================
// GET /api/shares/verify/:code — receiver code verify
// ================================
router.get("/verify/:code", async (req, res) => {
    try {
        const share = await Share.findOne({ code: req.params.code });
        if (!share) return res.status(404).json({ success: false, message: "Invalid code." });
        if (isExpired(share)) {
            await deleteShareFiles(share._id);
            await Share.findByIdAndDelete(share._id).catch(() => {});
            return res.status(410).json({ success: false, message: "Share expired." });
        }
        const files = await File.find({ shareId: share._id });
        res.json({
            success: true,
            share: {
                id: String(share._id), code: share.code, expiresAt: share.expiresAt, status: share.status,
                files: files.map((f) => ({ id: String(f._id), fileName: f.fileName, fileSize: f.fileSize, url: f.cloudinaryUrl }))
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
        const share = await Share.findById(req.params.shareId);
        if (!share) return res.status(404).json({ success: false, message: "Not found." });
        const remainingFiles = await File.countDocuments({ shareId: share._id });
        res.json({ success: true, share: { id: String(share._id), status: share.status, remainingFiles } });
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
        const share = await Share.findById(req.params.shareId);
        if (!share) return res.status(404).json({ success: false, message: "Share not found." });
        await deleteShareFiles(share._id);
        await Share.findByIdAndDelete(share._id).catch(() => {});
        res.json({ success: true });
    } catch (err) {
        console.error("Share delete error:", err);
        res.status(500).json({ success: false, message: "Delete failed." });
    }
});

// ================================
// GET /api/shares/:shareId/download — one-click download
//   • 1 file    → original format me direct download (original mime + filename)
//   • multiple  → sab files ek hi ZIP me stream hoti hain
//   • success pe files + share server se delete (delete-on-download)
// ================================
router.get("/:shareId/download", async (req, res) => {
    let finishedOk = false;

    try {
        const share = await Share.findById(req.params.shareId);
        if (!share) return res.status(404).json({ success: false, message: "Share not found." });
        if (isExpired(share)) return res.status(410).json({ success: false, message: "Share expired." });

        const files = await File.find({ shareId: share._id });
        if (!files.length) return res.status(404).json({ success: false, message: "No files to download." });

        // Response finish hone ke baad files/DB cleanup karo (sirf success pe).
        const cleanupAfterSend = () => {
            if (finishedOk) {
                share.status = "completed";
                Promise.all(files.map((f) => {
                    if (f.cloudinaryPublicId) {
                        return cloudinary.uploader.destroy(f.cloudinaryPublicId, { resource_type: "auto" })
                            .catch((e) => console.warn("Cloudinary delete warning:", e.message));
                    }
                })).then(() => File.deleteMany({ shareId: share._id }))
                    .then(() => share.save().catch(() => {}))
                    .catch((e) => console.warn("Post-download cleanup warning:", e.message));
            }
        };

        // -------- Single file: original format me direct download --------
        if (files.length === 1) {
            const f = files[0];
            const stream = await streamRemoteFile(f.cloudinaryUrl);
            const filename = sanitizeName(f.fileName);
            res.status(200);
            res.setHeader("Content-Type", f.mimeType || "application/octet-stream");
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            res.setHeader("Content-Length", String(f.fileSize || ""));

            res.on("finish", () => { finishedOk = true; cleanupAfterSend(); });
            stream.on("error", (e) => {
                console.error("Download stream error:", e.message);
                if (!res.headersSent) res.status(502).json({ success: false, message: "Download failed." });
                res.destroy();
            });
            stream.pipe(res);
            return;
        }

        // -------- Multiple files: sab ek hi ZIP me --------
        const zip = archiver("zip", { zlib: { level: 6 } });
        zip.on("error", (e) => {
            console.error("Zip error:", e.message);
            if (!res.headersSent) res.status(502).json({ success: false, message: "Zip failed." });
            res.destroy();
        });

        const zipName = sanitizeName(`${share.code || "files"}.zip`);
        res.status(200);
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

        res.on("finish", () => { finishedOk = true; cleanupAfterSend(); });

        // Har file ka remote stream kabhi memory me load nahi hota — seedha zaroor zip me daalte hain.
        try {
            for (const f of files) {
                const stream = await streamRemoteFile(f.cloudinaryUrl);
                zip.append(stream, { name: sanitizeName(f.fileName) });
            }
        } catch (e) {
            console.error("Zip prep error:", e.message);
            return res.status(502).json({ success: false, message: "Download preparation failed." });
        }

        zip.pipe(res);
        await zip.finalize();
    } catch (err) {
        console.error("Download route error:", err);
        if (!res.headersSent) res.status(500).json({ success: false, message: "Download failed." });
    }
});


module.exports = router;
module.exports = router;