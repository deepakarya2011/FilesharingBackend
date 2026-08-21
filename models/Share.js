// Share model (MongoDB) — one file-sharing session.
// Backend stores ONLY session metadata here.
// Actual file data is stored on Cloudinary (NOT in the database).
const mongoose = require("mongoose");

const shareSchema = new mongoose.Schema({
    // The 6-digit code the receiver enters. Must be unique across all shares.
    code: { type: String, required: true, unique: true },

    // Current state: "waiting" | "uploaded" | "completed" | "expired"
    status: { type: String, default: "waiting" },

    // When this share session expires and becomes invalid.
    expiresAt: { type: Date, required: true },

    // When this share was created.
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Share", shareSchema, "shares");