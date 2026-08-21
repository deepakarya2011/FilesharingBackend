// File model (MongoDB) — metadata about files being transferred.
// Actual file bytes live on Cloudinary — DB mein sirf metadata + cloudinary refs.
const mongoose = require("mongoose");

const fileSchema = new mongoose.Schema({
    // Original name of the file (e.g. "photo.png").
    fileName: { type: String, required: true },

    // File size in bytes (e.g. 2048000 for ~2MB).
    fileSize: { type: Number, required: true },

    // MIME type of the file (e.g. "image/png", "video/mp4").
    mimeType: { type: String, required: true },

    // Cloudinary ka public ID — file delete karne ke liye chahiye.
    cloudinaryPublicId: { type: String, default: null },

    // Cloudinary resource_type (image|video|raw) — delete ke waqt same type chahiye,
    // warna "auto" upload ki files destroy se miss ho jaati hain aur storage mein reh jaati hain.
    resourceType: { type: String, default: "image" },

    // Cloudinary secure URL — receiver download karne ke liye.
    cloudinaryUrl: { type: String, default: null },

    // When this file metadata record was created.
    createdAt: { type: Date, default: Date.now },

    // Which share session this file belongs to.
    shareId: { type: mongoose.Schema.Types.ObjectId, ref: "Share", required: true }
});

// Helper query helpers nahi chahiye — plain find() use hoga.
module.exports = mongoose.model("File", fileSchema, "files");